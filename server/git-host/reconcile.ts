/**
 * reconcile.ts — keep a hosted repo's default branch in sync with GitHub,
 * in BOTH directions, and surface the case where it can't.
 *
 * The outbound mirror (`mirror.ts`) is one-way and non-force: it pushes
 * the Hub's default branch to GitHub but refuses to overwrite GitHub-only
 * commits. So when something lands directly on GitHub — most commonly a
 * release bot's `chore(release): vX.Y.Z` version bump — the branches fork
 * and the outbound mirror gets stuck (`! [rejected] (fetch first)`), with
 * no surfacing.
 *
 * This module closes the loop:
 *   - `behind`  (GitHub ahead only): fast-forward the Hub to GitHub —
 *     "pull the release chore into Agent Hub's git".
 *   - `ahead`   (Hub ahead only): push to GitHub (the normal mirror).
 *   - `diverged` (both sides have unique commits): attempt a clean
 *     auto-merge of GitHub into the Hub. If it merges without conflicts,
 *     apply it and push. If it CANNOT merge automatically, record
 *     `diverged` so the UI can show "branches have diverged and can't be
 *     reconciled automatically".
 *
 * Every Hub-side mutation is a fast-forward or a merge commit — never a
 * force, never a history rewrite — and runs serialized on the project's
 * mirror queue so it can't race the outbound push.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import config from '../config.js';
import type { Project } from '../types.js';
import { redactAuthHeader, redactToken } from '../clone-url-auth.js';
import { gitAuthArgsForGithubPat } from '../skill-credentials-github.js';
import { gitHostRepoPath, hostedRepoDefaultBranch, hostedRepoExists } from './repo-store.js';
import {
  type MirrorState,
  type MirrorSyncStatus,
  mirrorPolicy,
  pushMirrorNow,
  readMirrorState,
  resolveMirrorToken,
  runOnMirrorQueue,
  writeMirrorState,
  type MirrorSyncDeps,
} from './mirror.js';

const execFileP = promisify(execFile);

const GIT_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 5 * 60_000;
const PUSH_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_MS = 5 * 60_000;

/** Hidden ref namespace where we stash GitHub's fetched tips. */
const TRACKING_PREFIX = 'refs/git-host-mirror/github/';

export interface ReconcileDeps extends MirrorSyncDeps {
  /** Override GitHub fetch/push target (tests use a local bare repo). */
  fetchUrlOverride?: string;
}

export type ReconcileAction =
  | 'none'
  | 'pulled'
  | 'pushed'
  | 'merged'
  | 'diverged'
  | 'skipped'
  | 'error';

export interface ReconcileResult {
  status: MirrorSyncStatus;
  action: ReconcileAction;
  hubSha?: string;
  githubSha?: string;
  aheadBy?: number;
  behindBy?: number;
  error?: string;
}

async function git(args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

async function revParse(repoPath: string, ref: string): Promise<string | null> {
  try {
    return await git(['-C', repoPath, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    return null;
  }
}

async function countRange(repoPath: string, range: string): Promise<number> {
  try {
    return Number.parseInt(await git(['-C', repoPath, 'rev-list', '--count', range]), 10) || 0;
  } catch {
    return 0;
  }
}

function persist(projectId: string, patch: Partial<MirrorState>, dataDir: string): void {
  writeMirrorState(projectId, { ...readMirrorState(projectId, dataDir), ...patch }, dataDir);
}

/**
 * True when the remote definitively does not have `refs/heads/<branch>`.
 * Distinguishes "GitHub doesn't have this branch yet" (benign — we create
 * it by pushing) from a real fetch failure. On any ls-remote error we
 * return false so the caller surfaces the original fetch error rather than
 * silently pushing into an unreachable/forbidden remote.
 */
async function remoteBranchAbsent(
  repoPath: string,
  authArgs: string[],
  url: string,
  branch: string,
): Promise<boolean> {
  try {
    const out = await git([
      '-C',
      repoPath,
      ...authArgs,
      'ls-remote',
      '--heads',
      url,
      `refs/heads/${branch}`,
    ]);
    return out.trim().length === 0;
  } catch {
    return false;
  }
}

/**
 * A terminal "in sync" result: both sides are at `sha`, zero divergence.
 * Used after a push/merge/FF succeeds so the persisted state and the API
 * response reflect the final tips rather than the pre-operation inputs.
 */
function syncedResult(action: ReconcileAction, sha: string): ReconcileResult {
  return { status: 'synced', action, hubSha: sha, githubSha: sha, aheadBy: 0, behindBy: 0 };
}

interface DivergeBase {
  hubSha: string;
  githubSha: string;
  aheadBy: number;
  behindBy: number;
}

/**
 * Record a diverged state that could not be reconciled safely, WITHOUT
 * mutating the hosted repo. Used both when the merge itself conflicts and
 * when the post-merge push fails — in either case the served Hub ref is
 * left exactly where it was. An optional error is redacted and recorded.
 */
function recordDiverged(
  projectId: string,
  deps: ReconcileDeps,
  dataDir: string,
  base: DivergeBase,
  nowIso: string,
  err: unknown,
  token: string | null,
): ReconcileResult {
  const safe = err
    ? redactAuthHeader(redactToken(err instanceof Error ? err.message : String(err), token))
    : null;
  persist(
    projectId,
    {
      status: 'diverged',
      diverged: true,
      ...base,
      lastReconcileAt: nowIso,
      lastReconcileAction: 'diverged',
      ...(safe ? { lastError: safe.slice(0, 2000), lastErrorAt: nowIso } : {}),
    },
    dataDir,
  );
  deps.broadcast({ type: 'git_host_mirror', projectId, status: 'diverged', ...base });
  return {
    status: 'diverged',
    action: 'diverged',
    ...base,
    ...(safe ? { error: safe.slice(0, 500) } : {}),
  };
}

/**
 * Examine one hosted project and reconcile its default branch with GitHub.
 * Safe to call for any project — non-hosted / mirror-disabled projects
 * return `{ action: 'skipped' }`. Serialized on the mirror queue.
 */
export function reconcileMirror(project: Project, deps: ReconcileDeps): Promise<ReconcileResult> {
  return runOnMirrorQueue(project.id, () => doReconcile(project, deps));
}

async function doReconcile(project: Project, deps: ReconcileDeps): Promise<ReconcileResult> {
  const dataDir = deps.dataDir ?? config.dataDir;
  const policy = mirrorPolicy(project);
  if (!policy.enabled || !hostedRepoExists(project.id, dataDir)) {
    return { status: 'unknown', action: 'skipped' };
  }

  const repoPath = gitHostRepoPath(project.id, dataDir);
  const branch = (await hostedRepoDefaultBranch(project.id, dataDir)) ?? 'main';
  const fetchUrl = deps.fetchUrlOverride ?? project.repoUrl;
  if (!fetchUrl) return { status: 'unknown', action: 'skipped' };

  const nowIso = new Date().toISOString();
  persist(project.id, { lastPollAt: nowIso }, dataDir);

  // Fetch GitHub's tip of the default branch into our tracking ref.
  let token: string | null = null;
  if (!deps.fetchUrlOverride) token = await (deps.resolveToken ?? resolveMirrorToken)(project);
  const authArgs = token ? gitAuthArgsForGithubPat(token) : [];
  const trackingRef = `${TRACKING_PREFIX}${branch}`;
  let remoteMissingBranch = false;
  try {
    await git(
      [
        '-C',
        repoPath,
        ...authArgs,
        'fetch',
        '--no-tags',
        fetchUrl,
        `+refs/heads/${branch}:${trackingRef}`,
      ],
      FETCH_TIMEOUT_MS,
    );
  } catch (err: unknown) {
    // A fetch for a ref GitHub doesn't have yet exits non-zero ("couldn't
    // find remote ref"). That is NOT a failure — it means the mirror
    // target is empty/uninitialized, and we create the branch by pushing.
    // Probe with ls-remote to tell a genuinely-absent branch apart from a
    // real connectivity/auth error (which we still surface).
    if (await remoteBranchAbsent(repoPath, authArgs, fetchUrl, branch)) {
      remoteMissingBranch = true;
    } else {
      const safe = redactAuthHeader(
        redactToken(err instanceof Error ? err.message : String(err), token),
      );
      persist(
        project.id,
        { lastError: safe.slice(0, 2000), lastErrorAt: nowIso, status: 'unknown' },
        dataDir,
      );
      deps.broadcast({
        type: 'git_host_mirror',
        projectId: project.id,
        status: 'error',
        error: safe.slice(0, 500),
      });
      return { status: 'unknown', action: 'error', error: safe.slice(0, 500) };
    }
  }

  const hubSha = await revParse(repoPath, `refs/heads/${branch}`);
  const githubSha = remoteMissingBranch ? null : await revParse(repoPath, trackingRef);

  // GitHub doesn't have this branch yet → nothing to pull; let the
  // outbound mirror create it.
  if (!githubSha) {
    if (hubSha) {
      const ok = await pushMirrorNow(project, deps);
      return finalize(
        project,
        deps,
        dataDir,
        ok
          ? syncedResult('pushed', hubSha)
          : { status: 'ahead', action: 'error', hubSha, aheadBy: 0, behindBy: 0 },
      );
    }
    return finalize(project, deps, dataDir, { status: 'unknown', action: 'none' });
  }
  if (!hubSha)
    return finalize(project, deps, dataDir, { status: 'unknown', action: 'none', githubSha });

  if (hubSha === githubSha) {
    return finalize(project, deps, dataDir, {
      status: 'synced',
      action: 'none',
      hubSha,
      githubSha,
      aheadBy: 0,
      behindBy: 0,
    });
  }

  const mergeBase = await (async () => {
    try {
      return await git(['-C', repoPath, 'merge-base', hubSha, githubSha]);
    } catch {
      return null; // unrelated histories
    }
  })();
  const aheadBy = await countRange(repoPath, `${githubSha}..${hubSha}`);
  const behindBy = await countRange(repoPath, `${hubSha}..${githubSha}`);
  const base = { hubSha, githubSha, aheadBy, behindBy };

  // GitHub strictly ahead → fast-forward the Hub (pull GitHub-only commits in).
  if (mergeBase === hubSha) {
    try {
      await git(['-C', repoPath, 'update-ref', `refs/heads/${branch}`, githubSha, hubSha]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return finalize(project, deps, dataDir, {
        status: 'behind',
        action: 'error',
        error: msg,
        ...base,
      });
    }
    deps.broadcast({ type: 'git_host_mirror', projectId: project.id, status: 'pulled', branch });
    // Hub fast-forwarded to GitHub's tip → both sides are now at githubSha.
    return finalize(project, deps, dataDir, syncedResult('pulled', githubSha));
  }

  // Hub strictly ahead → push to GitHub (the normal outbound mirror).
  if (mergeBase === githubSha) {
    const ok = await pushMirrorNow(project, deps);
    // On success GitHub now matches the Hub tip; on failure the Hub is
    // still ahead by the same commits it started with.
    return finalize(
      project,
      deps,
      dataDir,
      ok ? syncedResult('pushed', hubSha) : { status: 'ahead', action: 'error', ...base },
    );
  }

  // Diverged: both sides have unique commits. Try a clean auto-merge of
  // GitHub into the Hub. merge-tree exits non-zero on conflicts (or on a
  // git too old to support `--write-tree`), which we treat as "can't
  // reconcile automatically".
  let mergedTree: string | null = null;
  try {
    mergedTree = await git(['-C', repoPath, 'merge-tree', '--write-tree', hubSha, githubSha]);
  } catch {
    mergedTree = null;
  }
  if (!mergedTree) {
    return recordDiverged(project.id, deps, dataDir, base, nowIso, null, token);
  }

  // Clean merge. Build the merge commit OBJECT first — `commit-tree` moves
  // no ref — then push it to GitHub, and only fast-forward the served Hub
  // ref AFTER that push has landed. This preserves the module contract:
  // if the push fails (transient auth/network), the hosted repo is left
  // untouched and the project stays `diverged`, instead of silently going
  // Hub-ahead with a merge commit GitHub never received.
  let mergeCommit: string;
  try {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Agent Hub Mirror',
      GIT_AUTHOR_EMAIL: 'mirror@agent-hub.local',
      GIT_COMMITTER_NAME: 'Agent Hub Mirror',
      GIT_COMMITTER_EMAIL: 'mirror@agent-hub.local',
    };
    const { stdout } = await execFileP(
      'git',
      [
        '-C',
        repoPath,
        'commit-tree',
        mergedTree.split('\n')[0],
        '-p',
        hubSha,
        '-p',
        githubSha,
        '-m',
        `Merge github/${branch} into ${branch} (auto-reconcile)`,
      ],
      { timeout: GIT_TIMEOUT_MS, env },
    );
    mergeCommit = stdout.trim();
  } catch (err: unknown) {
    // Couldn't even build the merge object → nothing mutated, stay diverged.
    return recordDiverged(project.id, deps, dataDir, base, nowIso, err, token);
  }

  // Push the merge commit to GitHub BY SHA, without moving the Hub ref.
  // GitHub is an ancestor of the merge commit, so this is a fast-forward
  // (non-force). The Hub ref is still `hubSha` at this point.
  const pushUrl = deps.pushUrlOverride ?? project.repoUrl;
  try {
    if (!pushUrl) throw new Error('no mirror push URL configured');
    await git(
      ['-C', repoPath, ...authArgs, 'push', pushUrl, `${mergeCommit}:refs/heads/${branch}`],
      PUSH_TIMEOUT_MS,
    );
  } catch (err: unknown) {
    // Push failed → Hub ref untouched, project still diverged. Surface it.
    return recordDiverged(project.id, deps, dataDir, base, nowIso, err, token);
  }

  // Push landed on GitHub → now fast-forward the served Hub ref onto it.
  try {
    await git(['-C', repoPath, 'update-ref', `refs/heads/${branch}`, mergeCommit, hubSha]);
  } catch {
    // Extremely rare: a concurrent session push moved the Hub ref between
    // our read and here, so the compare-and-swap failed. GitHub already
    // has the merge commit; the Hub is now behind and the next poll
    // fast-forward-pulls it. Report `behind` (the safe, self-healing state).
    persist(
      project.id,
      {
        status: 'behind',
        diverged: false,
        githubSha: mergeCommit,
        lastReconcileAt: nowIso,
        lastReconcileAction: 'merged',
      },
      dataDir,
    );
    return { status: 'behind', action: 'pushed', hubSha, githubSha: mergeCommit };
  }
  deps.broadcast({ type: 'git_host_mirror', projectId: project.id, status: 'synced', branch });
  // Both sides are now at the merge commit.
  return finalize(project, deps, dataDir, syncedResult('merged', mergeCommit));
}

/** Write the terminal reconcile state and return the result. */
function finalize(
  project: Project,
  deps: ReconcileDeps,
  dataDir: string,
  result: ReconcileResult,
): ReconcileResult {
  const nowIso = new Date().toISOString();
  const patch: Partial<MirrorState> = {
    status: result.status,
    diverged: result.status === 'diverged',
    lastReconcileAt: nowIso,
    lastReconcileAction: result.action,
  };
  if (result.hubSha !== undefined) patch.hubSha = result.hubSha;
  if (result.githubSha !== undefined) patch.githubSha = result.githubSha;
  if (result.aheadBy !== undefined) patch.aheadBy = result.aheadBy;
  if (result.behindBy !== undefined) patch.behindBy = result.behindBy;
  // A confirmed-synced terminal state stamps the sync time and clears any
  // stale rejection.
  if (result.status === 'synced') {
    patch.lastSyncAt = nowIso;
    patch.lastError = undefined;
    patch.lastErrorAt = undefined;
  } else if (result.action !== 'error' && result.status !== 'diverged') {
    patch.lastError = undefined;
    patch.lastErrorAt = undefined;
  }
  persist(project.id, patch, dataDir);
  return result;
}

/**
 * Start the background reconcile poller. Iterates hosted, mirror-enabled
 * projects every `intervalMs` (env `GIT_HOST_MIRROR_POLL_MS`, default 5m)
 * and reconciles each. Returns a stop function. A non-positive interval
 * disables polling.
 */
export function startMirrorReconcilePoller(deps: {
  getProjects: () => Project[];
  broadcast: (data: Record<string, unknown>) => void;
  intervalMs?: number;
}): () => void {
  const envMs = Number.parseInt(process.env.GIT_HOST_MIRROR_POLL_MS ?? '', 10);
  const intervalMs = deps.intervalMs ?? (Number.isFinite(envMs) ? envMs : DEFAULT_POLL_MS);
  if (intervalMs <= 0) return () => {};

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return; // never overlap ticks
    running = true;
    try {
      for (const project of deps.getProjects()) {
        if (!mirrorPolicy(project).enabled) continue;
        try {
          await reconcileMirror(project, { broadcast: deps.broadcast });
        } catch (err: unknown) {
          console.warn(
            `[git-host] reconcile poll failed for ${project.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  // Kick once shortly after boot so a wedged mirror surfaces quickly.
  const kick = setTimeout(() => void tick(), 5_000);
  if (typeof kick.unref === 'function') kick.unref();

  return () => {
    clearInterval(timer);
    clearTimeout(kick);
  };
}
