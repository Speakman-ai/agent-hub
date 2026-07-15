/**
 * mirror.ts — one-way Hub → GitHub mirror sync for hosted repos.
 *
 * Triggered by the post-receive notify endpoint after a push lands in a
 * hosted bare repo. By construction the Hub push has ALREADY succeeded
 * when this runs, so a mirror failure can never block or fail a push —
 * it is recorded in `<bare>/agent-hub-mirror-state.json`, broadcast as a
 * `git_host_mirror` event, and retried once after {@link RETRY_DELAY_MS}.
 *
 * Policy (`Project.gitMirror`): `refs: 'default-branch'` (default) only
 * syncs when the default branch moved and pushes just that branch + tags
 * — enough to keep GitHub Actions/deploys working off main. `'all'`
 * mirrors every branch. Pushes are NON-FORCE: if GitHub diverged (someone
 * pushed directly to GitHub after opting in), we record the divergence
 * rather than eat their commits; a manual "force mirror" affordance is a
 * follow-up.
 *
 * Concurrency: per-project promise chain + debounce so a push storm
 * coalesces into one mirror push.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import config from '../config.js';
import type { Project } from '../types.js';
import { classifyCloneUrl, redactAuthHeader, redactToken } from '../clone-url-auth.js';
import { gitAuthArgsForGithubPat, resolveUserGithubToken } from '../skill-credentials-github.js';
import { resolveOAuthAppCredentials } from '../spawn-github-credentials.js';
import { resolveOwnerWithRepoAccess } from '../repo-aware-token.js';
import { getInstallationTokenForOwner } from '../github-app.js';
import type { GitHubAppConfig } from '../types.js';
import { gitHostRepoPath, hostedRepoDefaultBranch, hostedRepoExists } from './repo-store.js';

const execFileP = promisify(execFile);

const PUSH_TIMEOUT_MS = 5 * 60 * 1000;
const DEBOUNCE_MS = 2_000;
const RETRY_DELAY_MS = 30_000;

/**
 * Relationship between the Hub's default branch and GitHub's, as of the
 * last poll/sync. `ahead` = Hub has commits GitHub lacks (normal — the
 * outbound mirror pushes them). `behind` = GitHub has commits the Hub
 * lacks (e.g. a release bot committed straight to GitHub). `diverged` =
 * both sides have unique commits AND an automatic merge could not be made
 * — the only state that needs a human.
 */
export type MirrorSyncStatus = 'synced' | 'ahead' | 'behind' | 'diverged' | 'unknown';

export interface MirrorState {
  lastSyncAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  /** Last computed relationship between Hub and GitHub default branches. */
  status?: MirrorSyncStatus;
  /** True when the branches diverged and could not be auto-reconciled. */
  diverged?: boolean;
  /** Default-branch tips at the last poll. */
  hubSha?: string;
  githubSha?: string;
  /** Commits on the Hub not yet on GitHub. */
  aheadBy?: number;
  /** Commits on GitHub not yet on the Hub. */
  behindBy?: number;
  /** Last time the reconcile poller examined this project. */
  lastPollAt?: string;
  /** Last time a reconcile action ran, and what it did. */
  lastReconcileAt?: string;
  lastReconcileAction?: string;
}

const MIRROR_STATE_FILE = 'agent-hub-mirror-state.json';

export function readMirrorState(projectId: string, dataDir: string = config.dataDir): MirrorState {
  try {
    return JSON.parse(
      readFileSync(path.join(gitHostRepoPath(projectId, dataDir), MIRROR_STATE_FILE), 'utf8'),
    ) as MirrorState;
  } catch {
    return {};
  }
}

export function writeMirrorState(
  projectId: string,
  state: MirrorState,
  dataDir: string = config.dataDir,
): void {
  try {
    writeFileSync(
      path.join(gitHostRepoPath(projectId, dataDir), MIRROR_STATE_FILE),
      JSON.stringify(state, null, 2) + '\n',
    );
  } catch (err: unknown) {
    console.warn(
      `[git-host] mirror state write failed for ${projectId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export interface MirrorSyncDeps {
  broadcast: (data: Record<string, unknown>) => void;
  dataDir?: string;
  /**
   * GitHub token resolver — defaults to the repo-aware Owner chain
   * (`resolveOwnerWithRepoAccess` → `resolveUserGithubToken`). Test seam.
   */
  resolveToken?: (project: Project) => Promise<string | null>;
  /** Override the mirror push target (tests use a local bare repo). */
  pushUrlOverride?: string;
  /** Timer overrides (tests). */
  debounceMs?: number;
  retryDelayMs?: number;
}

interface QueueEntry {
  chain: Promise<void>;
  debounceTimer: NodeJS.Timeout | null;
  /** Refs updated since the last sync ran (accumulated across debounces). */
  pendingRefs: Set<string>;
}

const queues = new Map<string, QueueEntry>();

/**
 * Test/override seam for {@link resolveMirrorToken}. Both fields default to
 * the production wiring; tests inject fakes without vi.mock'ing the whole
 * github-app module.
 */
export interface MirrorTokenOverrides {
  /** GitHub App config to consult (defaults to `config.githubApp`). */
  appConfig?: GitHubAppConfig | null;
  /** Installation-token minter (defaults to the real graceful minter). */
  mintAppToken?: typeof getInstallationTokenForOwner;
}

/**
 * Resolve the GitHub token used to push the mirror (and fetch GitHub's
 * default branch during reconcile). Exported so the reconcile poller shares
 * exactly the mirror's auth path.
 *
 * Token precedence:
 *   1. **GitHub App installation token** — when a server-global `githubApp`
 *      is configured AND an installation resolves for the repo owner. This
 *      is the identity an operator adds to the repo's ruleset bypass list,
 *      so the mirror push succeeds against a branch-protected default
 *      branch. `getInstallationTokenForOwner` degrades to `null` (never
 *      throws) on any misconfiguration, so a broken App can't strand the
 *      mirror — it just falls through to (2).
 *   2. **Per-user OAuth/PAT token** — the repo-aware Owner chain, unchanged.
 */
export async function resolveMirrorToken(
  project: Project,
  overrides: MirrorTokenOverrides = {},
): Promise<string | null> {
  // Prefer the explicit `owner/repo` field; fall back to deriving it
  // from the mirror URL so older projects (repoUrl only) still resolve.
  let ownerRepo = project.githubRepo ?? null;
  if (!ownerRepo && project.repoUrl) {
    const parsed = classifyCloneUrl(project.repoUrl);
    if (parsed.kind === 'github-https' && parsed.owner && parsed.repo) {
      ownerRepo = `${parsed.owner}/${parsed.repo}`;
    }
  }

  // (1) GitHub App installation token — the bypass identity.
  const appConfig =
    overrides.appConfig !== undefined ? overrides.appConfig : (config.githubApp ?? null);
  if (appConfig) {
    const owner = ownerRepo ? ownerRepo.split('/')[0] : null;
    const mint = overrides.mintAppToken ?? getInstallationTokenForOwner;
    const appToken = await mint(appConfig, owner);
    if (appToken) return appToken;
  }

  // (2) Fall back to the per-user OAuth/PAT token chain.
  const ownerId = await resolveOwnerWithRepoAccess(ownerRepo);
  if (!ownerId) return null;
  return resolveUserGithubToken(ownerId, {
    oauthCredentials: resolveOAuthAppCredentials(config),
  });
}

export function mirrorPolicy(project: Project): {
  enabled: boolean;
  refs: 'default-branch' | 'all';
} {
  return {
    enabled:
      project.gitHost === 'agenthub' &&
      project.gitMirror?.enabled !== false &&
      Boolean(project.repoUrl),
    refs: project.gitMirror?.refs === 'all' ? 'all' : 'default-branch',
  };
}

/**
 * Notify the mirror layer that refs moved in a hosted repo. Safe to call
 * for every push — policy filtering, debouncing, and serialization all
 * happen inside. Returns the promise chain tail (tests await it).
 */
export function notifyMirrorPush(
  project: Project,
  updatedRefs: string[],
  deps: MirrorSyncDeps,
): Promise<void> {
  const policy = mirrorPolicy(project);
  if (!policy.enabled) return Promise.resolve();

  let entry = queues.get(project.id);
  if (!entry) {
    entry = { chain: Promise.resolve(), debounceTimer: null, pendingRefs: new Set() };
    queues.set(project.id, entry);
  }
  for (const ref of updatedRefs) entry.pendingRefs.add(ref);

  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);

  const result = new Promise<void>((resolve) => {
    entry!.debounceTimer = setTimeout(() => {
      entry!.debounceTimer = null;
      const refs = [...entry!.pendingRefs];
      entry!.pendingRefs.clear();
      entry!.chain = entry!.chain
        .then(() => runMirrorSync(project, refs, deps))
        .catch(() => {
          /* runMirrorSync handles its own errors; never poison the chain */
        })
        .finally(resolve);
    }, deps.debounceMs ?? DEBOUNCE_MS);
    if (typeof entry!.debounceTimer.unref === 'function') entry!.debounceTimer.unref();
  });
  return result;
}

/**
 * Push the hosted repo's default branch (+ tags, or all branches) to
 * GitHub once, non-force. Writes mirror state and broadcasts. Returns
 * `true` on success, `false` on a rejected/failed push (state records the
 * error). No debounce, no retry — callers that need those wrap this. The
 * reconcile poller calls this directly so the push is serialized inside
 * its own queue slot rather than re-entering {@link notifyMirrorPush}.
 */
/** Resolve a ref to its commit SHA, or null if it can't be read. */
async function revParseQuiet(repoPath: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', repoPath, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      { timeout: 15_000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function pushMirrorNow(project: Project, deps: MirrorSyncDeps): Promise<boolean> {
  const dataDir = deps.dataDir ?? config.dataDir;
  if (!hostedRepoExists(project.id, dataDir)) return false;
  const policy = mirrorPolicy(project);
  if (!policy.enabled) return false;

  const defaultBranch = (await hostedRepoDefaultBranch(project.id, dataDir)) ?? 'main';
  const refspecs =
    policy.refs === 'all'
      ? ['refs/heads/*:refs/heads/*', 'refs/tags/*:refs/tags/*']
      : [`refs/heads/${defaultBranch}:refs/heads/${defaultBranch}`, 'refs/tags/*:refs/tags/*'];

  const pushUrl = deps.pushUrlOverride ?? project.repoUrl;
  if (!pushUrl) return false;

  let token: string | null = null;
  if (!deps.pushUrlOverride) {
    token = await (deps.resolveToken ?? resolveMirrorToken)(project);
  }
  const authArgs = token ? gitAuthArgsForGithubPat(token) : [];
  const repoPath = gitHostRepoPath(project.id, dataDir);

  try {
    // Non-force by design — see module header. `--follow-tags` is not
    // used: tags ride along via the explicit refspec, and a tag that
    // already exists on GitHub is skipped rather than failing the push
    // (hence not using plain `refs/tags/*` with --atomic).
    await execFileP('git', ['-C', repoPath, ...authArgs, 'push', pushUrl, ...refspecs], {
      timeout: PUSH_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    // Success → GitHub's default branch now matches the Hub's tip, so both
    // sides are at `syncedSha` with no divergence. Refresh the recorded
    // refs/counts (not just status) so the state can't read `synced` with
    // stale ahead/behind values or old SHAs left by an earlier poll.
    const syncedSha = await revParseQuiet(repoPath, `refs/heads/${defaultBranch}`);
    const prior = readMirrorState(project.id, dataDir);
    writeMirrorState(
      project.id,
      {
        ...prior,
        lastSyncAt: new Date().toISOString(),
        lastError: undefined,
        lastErrorAt: undefined,
        status: 'synced',
        diverged: false,
        ...(syncedSha ? { hubSha: syncedSha, githubSha: syncedSha } : {}),
        aheadBy: 0,
        behindBy: 0,
      },
      dataDir,
    );
    deps.broadcast({ type: 'git_host_mirror', projectId: project.id, status: 'synced' });
    return true;
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : String(err);
    const safe = redactAuthHeader(redactToken(raw, token));
    const prior = readMirrorState(project.id, dataDir);
    writeMirrorState(
      project.id,
      { ...prior, lastError: safe.slice(0, 2000), lastErrorAt: new Date().toISOString() },
      dataDir,
    );
    console.warn(`[git-host] mirror push failed for ${project.id}: ${safe}`);
    deps.broadcast({
      type: 'git_host_mirror',
      projectId: project.id,
      status: 'error',
      error: safe.slice(0, 500),
    });
    return false;
  }
}

async function runMirrorSync(
  project: Project,
  updatedRefs: string[],
  deps: MirrorSyncDeps,
  isRetry = false,
): Promise<void> {
  const dataDir = deps.dataDir ?? config.dataDir;
  if (!hostedRepoExists(project.id, dataDir)) return;
  const policy = mirrorPolicy(project);
  if (!policy.enabled) return;

  // `default-branch` policy only mirrors when the default branch moved.
  if (policy.refs === 'default-branch') {
    const defaultBranch = (await hostedRepoDefaultBranch(project.id, dataDir)) ?? 'main';
    const defaultMoved =
      updatedRefs.length === 0 || updatedRefs.includes(`refs/heads/${defaultBranch}`);
    if (!defaultMoved) return;
  }

  const ok = await pushMirrorNow(project, deps);
  if (!ok && !isRetry) {
    const timer = setTimeout(() => {
      void runMirrorSync(project, updatedRefs, deps, true);
    }, deps.retryDelayMs ?? RETRY_DELAY_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }
}

/**
 * Serialize an arbitrary async op onto a project's mirror queue, so the
 * reconcile poller and the debounced outbound push never run concurrently
 * against the same bare repo. Runs after any in-flight work (success or
 * failure) and never poisons the chain for the next caller.
 */
export function runOnMirrorQueue<T>(projectId: string, op: () => Promise<T>): Promise<T> {
  let entry = queues.get(projectId);
  if (!entry) {
    entry = { chain: Promise.resolve(), debounceTimer: null, pendingRefs: new Set() };
    queues.set(projectId, entry);
  }
  const result = entry.chain.then(op, op);
  entry.chain = result.then(
    () => {},
    () => {},
  );
  return result;
}

/** Test seam: drop all queued mirror work. */
export function __clearMirrorQueues(): void {
  for (const entry of queues.values()) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  }
  queues.clear();
}
