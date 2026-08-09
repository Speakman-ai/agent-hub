/**
 * Test doubles for {@link SessionWorktreeIo}.
 *
 * Both sharing modes are represented on purpose. A surface that reads the
 * worktree has to behave identically whether the tree is on the host or inside
 * a microVM, and the only way to catch a regression back to `session.
 * worktree_path` is to exercise a double whose `hostPath` is null.
 */
import { Buffer } from 'buffer';
import type {
  SessionWorktreeIo,
  WorktreeDirEntry,
  WorktreeGitOpts,
  WorktreeGitResult,
  WorktreeStat,
} from '../session-env/worktree-io.js';

export interface FakeWorktreeGitCall {
  args: string[];
  opts: WorktreeGitOpts;
}

export interface FakeWorktreeIoOptions {
  /** Answer git commands. Defaults to a clean exit with no output. */
  git?: (args: string[]) => Partial<WorktreeGitResult>;
  /** Worktree-relative path → contents. */
  files?: Record<string, string>;
}

export class FakeWorktreeIo implements SessionWorktreeIo {
  /** Every git invocation, in order — assert on these to prove routing. */
  readonly gitCalls: FakeWorktreeGitCall[] = [];

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

  async readFile(relPath: string): Promise<Buffer> {
    const contents = this.options.files?.[relPath];
    if (contents === undefined) {
      throw Object.assign(new Error(`ENOENT: ${relPath}`), { code: 'ENOENT' });
    }
    return Buffer.from(contents, 'utf8');
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
