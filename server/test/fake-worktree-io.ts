/**
 * Test doubles for {@link SessionWorktreeIo}.
 *
 * Both sharing modes are represented on purpose. A surface that reads the
 * worktree has to behave identically whether the tree is on the host or inside
 * a microVM, and the only way to catch a regression back to `session.
 * worktree_path` is to exercise a double whose `hostPath` is null.
 */
import { Buffer } from 'buffer';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import type {
  SessionWorktreeIo,
  WorktreeDirEntry,
  WorktreeExecOpts,
  WorktreeExecResult,
  WorktreeGitOpts,
  WorktreeGitResult,
  WorktreeStat,
} from '../session-env/worktree-io.js';
import { HostWorktreeIo } from '../session-env/worktree-io.js';

export interface FakeWorktreeGitCall {
  args: string[];
  opts: WorktreeGitOpts;
}

export interface FakeWorktreeExecCall {
  command: string;
  opts: WorktreeExecOpts;
}

export interface FakeWorktreeIoOptions {
  /** Answer git commands. Defaults to a clean exit with no output. */
  git?: (args: string[]) => Partial<WorktreeGitResult>;
  /** Answer shell commands. Defaults to a clean exit with no output. */
  exec?: (command: string) => Partial<WorktreeExecResult>;
  /** Worktree-relative path → contents. */
  files?: Record<string, string>;
}

export class FakeWorktreeIo implements SessionWorktreeIo {
  /** Every git invocation, in order — assert on these to prove routing. */
  readonly gitCalls: FakeWorktreeGitCall[] = [];
  readonly execCalls: FakeWorktreeExecCall[] = [];
  /** Worktree-relative path → host destination, for every downloadFile. */
  readonly downloads: { relPath: string; destHostPath: string }[] = [];

  constructor(
    readonly sharing: 'host-shared' | 'env-owned',
    readonly hostPath: string | null,
    private readonly options: FakeWorktreeIoOptions = {},
  ) {}

  async git(args: string[], opts: WorktreeGitOpts = {}): Promise<WorktreeGitResult> {
    this.gitCalls.push({ args, opts });
    const answer = this.options.git?.(args) ?? {};
    return { stdout: '', stderr: '', exitCode: 0, ...answer };
  }

  async exec(command: string, opts: WorktreeExecOpts = {}): Promise<WorktreeExecResult> {
    this.execCalls.push({ command, opts });
    const answer = this.options.exec?.(command) ?? {};
    return { stdout: '', stderr: '', exitCode: 0, ...answer };
  }

  async readFile(relPath: string): Promise<Buffer> {
    const contents = this.options.files?.[relPath];
    if (contents === undefined) {
      throw Object.assign(new Error(`ENOENT: ${relPath}`), { code: 'ENOENT' });
    }
    return Buffer.from(contents, 'utf8');
  }

  async downloadFile(relPath: string, destHostPath: string): Promise<void> {
    const contents = await this.readFile(relPath);
    this.downloads.push({ relPath, destHostPath });
    await mkdir(path.dirname(destHostPath), { recursive: true });
    await writeFile(destHostPath, contents);
  }

  async writeFile(relPath: string, contents: Buffer | string): Promise<void> {
    this.options.files ??= {};
    this.options.files[relPath] = contents.toString();
  }

  async listDir(): Promise<WorktreeDirEntry[]> {
    return Object.keys(this.options.files ?? {}).map((name) => ({ name, kind: 'file' as const }));
  }

  async stat(relPath: string): Promise<WorktreeStat | null> {
    const contents = this.options.files?.[relPath];
    if (contents === undefined) return null;
    return { kind: 'file', size: Buffer.byteLength(contents), mtimeMs: 0 };
  }

  async exists(relPath: string): Promise<boolean> {
    return (await this.stat(relPath)) !== null;
  }
}

/** A worktree the Hub shares with the env, as every pre-microVM backend does. */
export function fakeHostSharedIo(options: FakeWorktreeIoOptions = {}): FakeWorktreeIo {
  return new FakeWorktreeIo('host-shared', '/wt', options);
}

/** A worktree only the session's microVM can see — `hostPath` is null. */
export function fakeEnvOwnedIo(options: FakeWorktreeIoOptions = {}): FakeWorktreeIo {
  return new FakeWorktreeIo('env-owned', null, options);
}

/**
 * An `env-owned` worktree whose operations really run, against `dir`.
 *
 * For the code that has to move a repo out of a session: a scripted double
 * cannot tell you whether the git plumbing works, and a real microVM is not
 * something a unit test can boot. This runs the actual commands on a real
 * repository while presenting the sharing mode and the null `hostPath` that
 * force the caller down the guest path.
 */
export function envOwnedOverHostDir(dir: string): SessionWorktreeIo {
  const host = new HostWorktreeIo(dir);
  return {
    sharing: 'env-owned',
    hostPath: null,
    git: (args, opts) => host.git(args, opts),
    exec: (command, opts) => host.exec(command, opts),
    readFile: (relPath) => host.readFile(relPath),
    writeFile: (relPath, contents) => host.writeFile(relPath, contents),
    downloadFile: (relPath, destHostPath) => host.downloadFile(relPath, destHostPath),
    listDir: (relPath) => host.listDir(relPath),
    stat: (relPath) => host.stat(relPath),
    exists: (relPath) => host.exists(relPath),
  };
}
