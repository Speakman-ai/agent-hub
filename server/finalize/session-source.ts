/**
 * The tree Finalize validates and ships.
 *
 * Every phase after the gate — rebase, the CI step runner, push — drives `git`
 * and `docker` against a real host directory. Under a `host-shared` backend
 * that directory is the session worktree itself and nothing here does any
 * work. Under `env-owned` (a microVM) there is no such directory: the guest
 * holds the only current copy, and the host path the session row records is
 * the seed the VM booted from.
 *
 * Rather than teach ~25 modules to speak {@link SessionWorktreeIo}, this
 * materialises the session's committed history into a staging checkout the
 * existing pipeline can use unchanged. That is a fair trade because Finalize
 * only ever ships commits — it explicitly refuses to commit the working tree —
 * so a checkout of the branch is a complete and faithful input. It also keeps
 * one CI code path instead of two: the runner still bind-mounts a host
 * directory, exactly as it does for every other backend.
 *
 * The staging checkout lives under the data dir keyed by run id, so it
 * survives a Hub restart during the parked `ready_to_push` window, and its
 * path is recorded on the run row for the push step to pick up.
 */
import { execFile } from 'child_process';
import type { Dirent } from 'fs';
import { mkdir, readdir, rm, stat } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { WORKSPACES_ROOT } from '../worktree.js';
import { sessionWorktreeIoFor } from '../session-worktree-io.js';
import type { SessionWorktreeIo } from '../session-env/worktree-io.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 120_000;

/**
 * Where the bundle is written inside the session worktree. Under `.git` so it
 * cannot show up in `git status` and cannot collide with a tracked path.
 */
const GUEST_BUNDLE_RELATIVE_PATH = '.git/agent-hub-finalize-source.bundle';

/** Local git config key recording the session HEAD a staging clone came from. */
const SOURCE_HEAD_CONFIG_KEY = 'agentHub.sourceHead';

export interface FinalizeSyncBackResult {
  /** Whether the session worktree now points at the shipped commits. */
  synced: boolean;
  /** Present when `synced` is false: why the session tree was left alone. */
  reason?: string;
}

export interface FinalizeSource {
  /** Host directory the pipeline runs against. */
  readonly path: string;
  /** True when {@link path} is a staging copy rather than the session's tree. */
  readonly staged: boolean;
  /**
   * Re-materialise from the session worktree. Called between fix rounds: the
   * agent's fix lands in the session's tree, not in this copy.
   */
  refresh(): Promise<void>;
  /**
   * The session's HEAD at the moment this source was materialised, or null
   * when there is no staging copy.
   *
   * The push gate refuses when HEAD moved between validation and push. That
   * comparison is against the *session's* head: a staged copy is frozen, and a
   * rebase during the run means the two never match by SHA anyway, so
   * comparing the validated head to the session's would refuse every rebased
   * run. This is the value the check actually wants.
   */
  sessionHeadAtMaterialize(): Promise<string | null>;
  /**
   * Move the session worktree onto the commits that were just pushed, so the
   * session sees the rebase rather than silently diverging from its own branch.
   */
  syncBack(branch: string): Promise<FinalizeSyncBackResult>;
  /** Drop the staging checkout. Safe to call more than once. */
  release(): Promise<void>;
}

async function hostGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * The session's own worktree, used directly. Every backend that shares the
 * tree with the Hub lands here, and behaves exactly as it did before staging
 * existed.
 */
class SharedSource implements FinalizeSource {
  readonly staged = false;
  constructor(readonly path: string) {}
  async refresh(): Promise<void> {}
  async sessionHeadAtMaterialize(): Promise<string | null> {
    return null;
  }
  async syncBack(): Promise<FinalizeSyncBackResult> {
    // The pipeline ran against the session's own tree, so there is nothing to
    // carry back — it is already there.
    return { synced: true };
  }
  async release(): Promise<void> {}
}

class StagedSource implements FinalizeSource {
  readonly staged = true;

  constructor(
    readonly path: string,
    private readonly io: SessionWorktreeIo,
    private readonly branch: string,
  ) {}

  async refresh(): Promise<void> {
    const originUrl = await this.#resolveOriginUrl();
    const bundlePath = path.join(path.dirname(this.path), `${path.basename(this.path)}.bundle`);
    await mkdir(path.dirname(bundlePath), { recursive: true });
    try {
      // Bundle the branch ref rather than a bare SHA: a bundle with no ref is
      // one git refuses to create, and the ref is also what lets the clone
      // below check the branch out by name.
      const bundle = await this.io.git([
        'bundle',
        'create',
        GUEST_BUNDLE_RELATIVE_PATH,
        this.branch,
      ]);
      if (bundle.exitCode !== 0) {
        throw new Error(
          `could not bundle ${this.branch} from the session worktree: ` +
            (bundle.stderr.trim() || bundle.stdout.trim() || 'unknown error'),
        );
      }
      await this.io.downloadFile(GUEST_BUNDLE_RELATIVE_PATH, bundlePath);

      await rm(this.path, { recursive: true, force: true });
      await mkdir(path.dirname(this.path), { recursive: true });
      await execFileAsync(
        'git',
        ['clone', '--quiet', '--branch', this.branch, bundlePath, this.path],
        {
          timeout: GIT_TIMEOUT_MS,
        },
      );
      // The clone's origin is the bundle file. Point it at the real remote so
      // the rebase can fetch the base branch and the push has somewhere to go.
      if (originUrl) await hostGit(this.path, ['remote', 'set-url', 'origin', originUrl]);
      else await hostGit(this.path, ['remote', 'remove', 'origin']);

      // A bundle carries one branch and no remote HEAD, so default-branch
      // detection in the clone would find nothing and fall back to `main` —
      // wrong for any repo that calls it something else. Carry the session's
      // answer across instead of re-querying the remote.
      const originHead = await this.io.git(['symbolic-ref', 'refs/remotes/origin/HEAD']);
      if (originHead.exitCode === 0 && originHead.stdout.trim()) {
        await hostGit(this.path, [
          'symbolic-ref',
          'refs/remotes/origin/HEAD',
          originHead.stdout.trim(),
        ]).catch(() => {});
      }

      // Recorded in the clone rather than on the run row so it cannot drift
      // from the checkout it describes, and so a Hub restart during the
      // parked ready-to-push window does not lose it.
      const sessionHead = await this.io.git(['rev-parse', 'HEAD']);
      if (sessionHead.exitCode === 0 && sessionHead.stdout.trim()) {
        await hostGit(this.path, [
          'config',
          '--local',
          SOURCE_HEAD_CONFIG_KEY,
          sessionHead.stdout.trim(),
        ]);
      }
    } finally {
      await rm(bundlePath, { force: true });
      await this.io.exec(`rm -f ${GUEST_BUNDLE_RELATIVE_PATH}`).catch(() => {});
    }
  }

  async sessionHeadAtMaterialize(): Promise<string | null> {
    try {
      return (await hostGit(this.path, ['config', '--local', SOURCE_HEAD_CONFIG_KEY])) || null;
    } catch {
      // `git config` exits non-zero for an unset key.
      return null;
    }
  }

  /** Is there already a usable checkout here from an earlier call? */
  async isMaterialized(): Promise<boolean> {
    try {
      return (await hostGit(this.path, ['rev-parse', '--is-inside-work-tree'])) === 'true';
    } catch {
      return false;
    }
  }

  async #resolveOriginUrl(): Promise<string | null> {
    const res = await this.io.git(['remote', 'get-url', 'origin']);
    const url = res.exitCode === 0 ? res.stdout.trim() : '';
    return url || null;
  }

  /**
   * Fast-forward the session's branch onto what was pushed.
   *
   * The session fetches from the remote rather than receiving a bundle: it has
   * network access and the commits are on origin by the time this runs, so
   * git's own transport is both simpler and cheaper than shipping a pack back
   * through the guest agent.
   *
   * A rebase rewrites SHAs, so `merge --ff-only` will not do — but a hard reset
   * is only safe if the session has nothing of its own that the push left
   * behind. `git cherry` answers exactly that by patch id, and the worktree
   * must also be clean. When either check fails the session tree is left
   * untouched and the caller reports why; a diverged session is recoverable,
   * a discarded one is not.
   */
  async syncBack(branch: string): Promise<FinalizeSyncBackResult> {
    const fetch = await this.io.git(['fetch', 'origin', branch]);
    if (fetch.exitCode !== 0) {
      return {
        synced: false,
        reason: `could not fetch ${branch} in the session: ${fetch.stderr.trim()}`,
      };
    }
    const dirty = await this.io.git(['status', '--porcelain']);
    if (dirty.exitCode !== 0) {
      return {
        synced: false,
        reason: `could not read session worktree status: ${dirty.stderr.trim()}`,
      };
    }
    if (dirty.stdout.trim()) {
      return {
        synced: false,
        reason: 'the session worktree has uncommitted changes, so it was left as it is',
      };
    }
    const cherry = await this.io.git(['cherry', 'FETCH_HEAD', 'HEAD']);
    if (cherry.exitCode !== 0) {
      return {
        synced: false,
        reason: `could not compare session commits: ${cherry.stderr.trim()}`,
      };
    }
    const unpublished = cherry.stdout.split('\n').filter((line) => line.startsWith('+')).length;
    if (unpublished > 0) {
      return {
        synced: false,
        reason: `the session has ${unpublished} commit(s) that were not part of this push, so it was left as it is`,
      };
    }
    const reset = await this.io.git(['reset', '--hard', 'FETCH_HEAD']);
    if (reset.exitCode !== 0) {
      return {
        synced: false,
        reason: `could not move the session onto ${branch}: ${reset.stderr.trim()}`,
      };
    }
    return { synced: true };
  }

  async release(): Promise<void> {
    await rm(this.path, { recursive: true, force: true });
  }
}

/**
 * Root under which staging checkouts live, one directory per run.
 *
 * Under the workspaces root rather than the data dir, and not by accident: a
 * Hub in a container hands bind-mount sources to a daemon on the host, so a CI
 * runner can only see a path `translateContainerPathToHost` knows how to
 * rewrite. The workspaces root is bind-mounted for exactly that reason. The
 * data dir is not, and a checkout there would mount as an empty directory and
 * run the whole suite against nothing.
 *
 * The leading dot keeps it out of the per-project layout the stale-workspace
 * sweep walks.
 */
export function finalizeSourceRoot(workspacesRoot: string = WORKSPACES_ROOT): string {
  return path.join(workspacesRoot, '.finalize-source');
}

export interface ReapFinalizeSourcesArgs {
  /**
   * Runs whose checkout must survive. This is NOT the same set the container
   * reaper protects: a run parked at `ready_to_push` has `ended_at` set but
   * still owns the only copy of its rebased commits until the push happens.
   */
  retainRunIds: () => Set<string>;
  root?: string;
  /** Skip checkouts younger than this, so a just-created one is never raced. */
  graceMs?: number;
  now?: () => number;
  logger?: { warn: (m: string) => void };
}

const DEFAULT_SOURCE_GRACE_MS = 5 * 60_000;

/**
 * Delete staging checkouts whose run no longer needs them.
 *
 * A crashed Hub leaves these behind, and a repo checkout is not small, so the
 * safety net matters more here than the explicit release path does.
 */
export async function reapFinalizeSourceCheckouts(
  args: ReapFinalizeSourcesArgs,
): Promise<string[]> {
  const root = args.root ?? finalizeSourceRoot();
  const graceMs = args.graceMs ?? DEFAULT_SOURCE_GRACE_MS;
  const now = args.now ?? (() => Date.now());
  const logger = args.logger ?? { warn: (m: string) => console.warn(m) };

  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    // No root yet: nothing has ever been staged on this host.
    return [];
  }
  const retain = args.retainRunIds();
  const reaped: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || retain.has(entry.name)) continue;
    const dir = path.join(root, entry.name);
    try {
      const info = await stat(dir);
      if (now() - info.mtimeMs < graceMs) continue;
      await rm(dir, { recursive: true, force: true });
      reaped.push(entry.name);
    } catch (err) {
      logger.warn(
        `[finalize-source] could not reap ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return reaped;
}

export interface AcquireFinalizeSourceArgs {
  runId: string;
  sessionId: string;
  /** The session's recorded worktree path — authoritative only when shared. */
  worktreePath: string;
  branch: string;
  /** Injectable for tests; production resolves through the session registry. */
  io?: SessionWorktreeIo;
  /** Injectable for tests. */
  root?: string;
}

/**
 * Resolve the directory this run should drive, materialising one first when
 * the session's worktree is not on the host.
 */
export async function acquireFinalizeSource(
  args: AcquireFinalizeSourceArgs,
): Promise<FinalizeSource> {
  const io = args.io ?? (await sessionWorktreeIoFor(args.sessionId, args.worktreePath));
  if (io.sharing === 'host-shared') {
    return new SharedSource(io.hostPath ?? args.worktreePath);
  }
  const root = args.root ?? finalizeSourceRoot();
  const source = new StagedSource(path.join(root, args.runId), io, args.branch);
  // Reuse an existing checkout rather than rebuilding it. This is not an
  // optimisation: by push time the checkout holds the rebased commits the run
  // validated, and they exist nowhere else yet. Re-materialising from the
  // session here would silently replace them with the pre-rebase history.
  if (!(await source.isMaterialized())) await source.refresh();
  return source;
}
