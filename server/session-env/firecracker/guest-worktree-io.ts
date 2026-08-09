/**
 * {@link SessionWorktreeIo} over the vm-agent, for microVM sessions where the
 * guest holds the only current copy of the worktree.
 *
 * `git` runs *inside* the guest. That is the point rather than an
 * implementation detail: the guest is where the files are, so a `git status`
 * answered from the host would describe the boot-time seed.
 */
import { Buffer } from 'buffer';
import path from 'path';
import type {
  SessionWorktreeIo,
  WorktreeDirEntry,
  WorktreeExecOpts,
  WorktreeExecResult,
  WorktreeGitOpts,
  WorktreeGitResult,
  WorktreeStat,
} from '../worktree-io.js';
import { WorktreeGitError, toPosixRelative } from '../worktree-io.js';

const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/** Shell-quote for the single-quoted context the guest's `sh -c` receives. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface GuestExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * The subset of the microVM env this needs. Narrow on purpose: it keeps the
 * class unit-testable without a VM, and makes explicit that worktree IO is
 * built from exec plus the two file ops, nothing privileged.
 */
export interface GuestWorktreeChannel {
  /**
   * Run `command` via `sh -c` in the guest and collect its output. `cwd` is
   * worktree-relative, matching {@link SessionEnv.spawn}.
   */
  exec(command: string, opts: { cwd: string; timeoutMs: number }): Promise<GuestExecResult>;
  readFile(guestPath: string): Promise<Buffer>;
  writeFile(guestPath: string, contents: Buffer): Promise<void>;
  /** Stream a guest file to a host path without buffering it whole. */
  downloadFile(guestPath: string, destHostPath: string): Promise<void>;
}

export class GuestWorktreeIo implements SessionWorktreeIo {
  readonly sharing = 'env-owned' as const;
  /**
   * Always `null`: the host directory that seeded the disk still exists, but
   * it stopped describing the session the moment the guest wrote anything.
   */
  readonly hostPath = null;

  constructor(
    private readonly channel: GuestWorktreeChannel,
    /** Absolute worktree path *inside the guest*. */
    private readonly guestRoot: string,
  ) {}

  #guestPath(relPath: string): string {
    const rel = toPosixRelative(relPath);
    return rel === '' ? this.guestRoot : path.posix.join(this.guestRoot, rel);
  }

  async git(args: string[], opts: WorktreeGitOpts = {}): Promise<WorktreeGitResult> {
    const cwd = toPosixRelative(opts.cwd ?? '.');
    const assignments = Object.entries(opts.env ?? {})
      .map(([key, value]) => `${key}=${shellQuote(value)} `)
      .join('');
    const command = `${assignments}git ${args.map(shellQuote).join(' ')}`;
    const { stdout, stderr, exitCode } = await this.channel.exec(command, {
      cwd,
      timeoutMs: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    });
    const result: WorktreeGitResult = { stdout, stderr, exitCode };
    if (opts.throwOnNonZero && exitCode !== 0) throw new WorktreeGitError(args, result);
    return result;
  }

  async exec(command: string, opts: WorktreeExecOpts = {}): Promise<WorktreeExecResult> {
    const cwd = toPosixRelative(opts.cwd ?? '.');
    const assignments = Object.entries(opts.env ?? {})
      .map(([key, value]) => `${key}=${shellQuote(value)} `)
      .join('');
    return this.channel.exec(`${assignments}${command}`, {
      cwd,
      timeoutMs: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    });
  }

  async readFile(relPath: string): Promise<Buffer> {
    return this.channel.readFile(this.#guestPath(relPath));
  }

  async downloadFile(relPath: string, destHostPath: string): Promise<void> {
    await this.channel.downloadFile(this.#guestPath(relPath), destHostPath);
  }

  async writeFile(relPath: string, contents: Buffer | string): Promise<void> {
    const buf = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
    await this.channel.writeFile(this.#guestPath(relPath), buf);
  }

  async listDir(relPath = '.'): Promise<WorktreeDirEntry[]> {
    const target = toPosixRelative(relPath) || '.';
    // `find -maxdepth 1` emitting a NUL-delimited "type\0name\0" stream: the
    // only shape that survives newlines in filenames, which parsing `ls` does
    // not. Run from the worktree root so the guest never sees an absolute
    // path it would have to re-derive.
    const command = `find ${shellQuote(target)} -maxdepth 1 -mindepth 1 -printf '%y\\0%f\\0'`;
    const { stdout, stderr, exitCode } = await this.channel.exec(command, {
      cwd: '.',
      timeoutMs: 30_000,
    });
    if (exitCode !== 0) {
      throw new Error(`listDir(${relPath}) failed in guest: ${stderr.trim() || 'unknown error'}`);
    }
    return parseFindEntries(stdout);
  }

  async stat(relPath: string): Promise<WorktreeStat | null> {
    const target = toPosixRelative(relPath) || '.';
    // `--printf`, not `-c`: only the former interprets backslash escapes, so
    // `-c` emitted a literal backslash-zero and the NUL-delimited parse below
    // found a single field. Every stat then came back unparseable, which
    // `exists` reports as "not there" — a Finalize-gated project read as
    // having no ci.yaml, and the Changes pane read a live guest as empty.
    const command = `stat --printf '%F\\0%s\\0%.9Y' ${shellQuote(target)}`;
    const { stdout, exitCode } = await this.channel.exec(command, {
      cwd: '.',
      timeoutMs: 30_000,
    });
    if (exitCode !== 0) return null;
    return parseStatOutput(stdout);
  }

  async exists(relPath: string): Promise<boolean> {
    return (await this.stat(relPath)) !== null;
  }
}

/** `%y` type letters from `find -printf`. */
function findTypeToKind(letter: string): WorktreeDirEntry['kind'] {
  switch (letter) {
    case 'f':
      return 'file';
    case 'd':
      return 'directory';
    case 'l':
      return 'symlink';
    default:
      return 'other';
  }
}

export function parseFindEntries(stdout: string): WorktreeDirEntry[] {
  const fields = stdout.split('\0');
  const entries: WorktreeDirEntry[] = [];
  // Trailing NUL leaves an empty final field; pairs are (type, name).
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const name = fields[i + 1];
    if (name === undefined || name === '') continue;
    entries.push({ name, kind: findTypeToKind(fields[i] ?? '') });
  }
  return entries;
}

export function parseStatOutput(stdout: string): WorktreeStat | null {
  const [description, size, mtime] = stdout.trim().split('\0');
  if (description === undefined || size === undefined || mtime === undefined) return null;
  const kind: WorktreeStat['kind'] = description.includes('directory')
    ? 'directory'
    : description.includes('symbolic link')
      ? 'symlink'
      : description.includes('file')
        ? 'file'
        : 'other';
  const mtimeSeconds = Number(mtime);
  const parsedSize = Number(size);
  if (!Number.isFinite(mtimeSeconds) || !Number.isFinite(parsedSize)) return null;
  return { kind, size: parsedSize, mtimeMs: Math.round(mtimeSeconds * 1000) };
}
