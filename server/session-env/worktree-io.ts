/**
 * Worktree access for the Hub process itself.
 *
 * Every backend before Firecracker shared the worktree with the Hub through a
 * bind mount, so the Hub read it with plain `fs` and ran `git` against the
 * host path. A microVM cannot: Firecracker supports neither virtio-fs nor 9p,
 * so the worktree is seeded onto a block device and from then on the guest
 * holds the only current copy. Host reads see the seed.
 *
 * This is the seam that hides that difference. `host-shared` envs get an
 * implementation that is a thin wrapper over the same `fs` and `execFile`
 * calls as before; `env-owned` envs get one that forwards to the guest agent.
 * Callers work in worktree-relative paths and never learn which they hold.
 */
import { exec, execFile } from 'child_process';
import { readFile, writeFile, readdir, stat, mkdir, copyFile } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

/** Default cap on captured git output. Diffs of generated files get large. */
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_GIT_TIMEOUT_MS = 120_000;

export interface WorktreeGitResult {
  stdout: string;
  stderr: string;
  /** Process exit code; `null` if the process was killed by a signal. */
  exitCode: number | null;
}

export interface WorktreeGitOpts {
  /** Directory to run in, relative to the worktree root. Default the root. */
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  /** Extra environment for the git process. */
  env?: Record<string, string>;
  /**
   * When false (the default) a non-zero exit resolves rather than throws, so
   * callers can read `exitCode` — the shape probe-style git calls want
   * (`diff --quiet` uses exit 1 as its answer, not as a failure).
   */
  throwOnNonZero?: boolean;
}

/**
 * Options for {@link SessionWorktreeIo.exec}. Same shape as the git options
 * minus `throwOnNonZero`: a general command's exit code is the caller's to
 * interpret, so there is no default worth throwing on.
 */
export interface WorktreeExecOpts {
  /** Directory to run in, relative to the worktree root. Default the root. */
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  env?: Record<string, string>;
}

export type WorktreeExecResult = WorktreeGitResult;

export interface WorktreeDirEntry {
  name: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
}

export interface WorktreeStat {
  kind: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mtimeMs: number;
}

export class WorktreeGitError extends Error {
  constructor(
    readonly args: string[],
    readonly result: WorktreeGitResult,
  ) {
    super(
      `git ${args.join(' ')} exited ${String(result.exitCode)}: ${
        result.stderr.trim() || result.stdout.trim() || '(no output)'
      }`,
    );
    this.name = 'WorktreeGitError';
  }
}

/**
 * Read/write access to one session's worktree, wherever it physically lives.
 *
 * All paths are relative to the worktree root and must stay inside it;
 * implementations reject traversal rather than clamping it.
 */
export interface SessionWorktreeIo {
  readonly sharing: 'host-shared' | 'env-owned';
  /**
   * A host path holding current worktree contents, or `null` under
   * `env-owned`. Escape hatch for the few callers that genuinely need a real
   * path (handing a directory to a host subprocess); they must handle `null`.
   */
  readonly hostPath: string | null;

  git(args: string[], opts?: WorktreeGitOpts): Promise<WorktreeGitResult>;
  /**
   * Run a shell command where the worktree lives.
   *
   * The general form of {@link git}, for the handful of pipeline steps that
   * shell out to something else against the tree (regenerating a lockfile,
   * removing a scratch file). Output is captured, so this is for commands that
   * finish; anything whose output has to stream belongs on `SessionEnv.spawn`.
   */
  exec(command: string, opts?: WorktreeExecOpts): Promise<WorktreeExecResult>;
  readFile(relPath: string): Promise<Buffer>;
  writeFile(relPath: string, contents: Buffer | string): Promise<void>;
  /**
   * Copy a worktree file out to a host path without buffering it whole.
   *
   * {@link readFile} materialises the entire file in Hub memory, which is fine
   * for a config file and not for a repo bundle. Callers moving bulk bytes to
   * the host (the CI source hand-off) use this instead.
   */
  downloadFile(relPath: string, destHostPath: string): Promise<void>;
  /**
   * Copy a host file into the worktree without buffering it whole.
   *
   * Inverse of {@link downloadFile}. Chat attachments (zips, videos) live on
   * the Hub host under `uploads/` and have to reach an env-owned guest; loading
   * them with {@link writeFile} would put the entire body on the Hub heap and,
   * on Firecracker, in a single vsock JSON frame.
   */
  uploadFile(relPath: string, srcHostPath: string): Promise<void>;
  listDir(relPath?: string): Promise<WorktreeDirEntry[]>;
  /** `null` when the path does not exist, rather than throwing ENOENT. */
  stat(relPath: string): Promise<WorktreeStat | null>;
  exists(relPath: string): Promise<boolean>;
}

/**
 * Reject anything that would land outside the worktree root.
 *
 * Absolute inputs are rejected outright rather than silently reinterpreted:
 * a caller passing one has confused host paths with worktree-relative ones,
 * and under `env-owned` those namespaces are not the same tree at all.
 */
export function resolveWorktreeRelative(root: string, relPath: string): string {
  if (path.isAbsolute(relPath)) {
    throw new Error(`Worktree path must be relative, got absolute: ${relPath}`);
  }
  const resolved = path.resolve(root, relPath);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Worktree path escapes the worktree root: ${relPath}`);
  }
  return resolved;
}

/** Normalise a relative path for the guest, which is always POSIX. */
export function toPosixRelative(relPath: string): string {
  if (path.isAbsolute(relPath)) {
    throw new Error(`Worktree path must be relative, got absolute: ${relPath}`);
  }
  const normalised = path.posix.normalize(relPath.split(path.sep).join('/'));
  if (normalised === '..' || normalised.startsWith('../')) {
    throw new Error(`Worktree path escapes the worktree root: ${relPath}`);
  }
  return normalised === '.' ? '' : normalised;
}

function statKind(s: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): WorktreeStat['kind'] {
  if (s.isSymbolicLink()) return 'symlink';
  if (s.isDirectory()) return 'directory';
  if (s.isFile()) return 'file';
  return 'other';
}

/**
 * Worktree access for envs that share the tree with the Hub (host, sysbox,
 * container). Behaviour matches what callers did inline before this seam.
 */
export class HostWorktreeIo implements SessionWorktreeIo {
  readonly sharing = 'host-shared' as const;

  constructor(readonly hostPath: string) {}

  async git(args: string[], opts: WorktreeGitOpts = {}): Promise<WorktreeGitResult> {
    const cwd = opts.cwd ? resolveWorktreeRelative(this.hostPath, opts.cwd) : this.hostPath;
    let result: WorktreeGitResult;
    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd,
        timeout: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
      });
      result = { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      // execFile rejects both on a non-zero exit (numeric `code`) and on
      // failure to run at all (string `code`, e.g. ENOENT). Only the former
      // is a result the caller can inspect.
      if (typeof e.code !== 'number') throw err;
      result = { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code };
    }
    if (opts.throwOnNonZero && result.exitCode !== 0) {
      throw new WorktreeGitError(args, result);
    }
    return result;
  }

  async exec(command: string, opts: WorktreeExecOpts = {}): Promise<WorktreeExecResult> {
    const cwd = opts.cwd ? resolveWorktreeRelative(this.hostPath, opts.cwd) : this.hostPath;
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      if (typeof e.code !== 'number') throw err;
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code };
    }
  }

  async readFile(relPath: string): Promise<Buffer> {
    return readFile(resolveWorktreeRelative(this.hostPath, relPath));
  }

  async downloadFile(relPath: string, destHostPath: string): Promise<void> {
    await mkdir(path.dirname(destHostPath), { recursive: true });
    await copyFile(resolveWorktreeRelative(this.hostPath, relPath), destHostPath);
  }

  async uploadFile(relPath: string, srcHostPath: string): Promise<void> {
    const target = resolveWorktreeRelative(this.hostPath, relPath);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(srcHostPath, target);
  }

  async writeFile(relPath: string, contents: Buffer | string): Promise<void> {
    const target = resolveWorktreeRelative(this.hostPath, relPath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  async listDir(relPath = '.'): Promise<WorktreeDirEntry[]> {
    const entries = await readdir(resolveWorktreeRelative(this.hostPath, relPath), {
      withFileTypes: true,
    });
    return entries.map((entry) => ({ name: entry.name, kind: statKind(entry) }));
  }

  async stat(relPath: string): Promise<WorktreeStat | null> {
    try {
      const s = await stat(resolveWorktreeRelative(this.hostPath, relPath));
      return { kind: statKind(s), size: s.size, mtimeMs: s.mtimeMs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async exists(relPath: string): Promise<boolean> {
    return (await this.stat(relPath)) !== null;
  }
}
