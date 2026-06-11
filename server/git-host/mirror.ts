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
import { gitHostRepoPath, hostedRepoDefaultBranch, hostedRepoExists } from './repo-store.js';

const execFileP = promisify(execFile);

const PUSH_TIMEOUT_MS = 5 * 60 * 1000;
const DEBOUNCE_MS = 2_000;
const RETRY_DELAY_MS = 30_000;

export interface MirrorState {
  lastSyncAt?: string;
  lastError?: string;
  lastErrorAt?: string;
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

function writeMirrorState(
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

async function defaultResolveToken(project: Project): Promise<string | null> {
  // Prefer the explicit `owner/repo` field; fall back to deriving it
  // from the mirror URL so older projects (repoUrl only) still resolve.
  let ownerRepo = project.githubRepo ?? null;
  if (!ownerRepo && project.repoUrl) {
    const parsed = classifyCloneUrl(project.repoUrl);
    if (parsed.kind === 'github-https' && parsed.owner && parsed.repo) {
      ownerRepo = `${parsed.owner}/${parsed.repo}`;
    }
  }
  const ownerId = await resolveOwnerWithRepoAccess(ownerRepo);
  if (!ownerId) return null;
  return resolveUserGithubToken(ownerId, {
    oauthCredentials: resolveOAuthAppCredentials(config),
  });
}

function mirrorPolicy(project: Project): { enabled: boolean; refs: 'default-branch' | 'all' } {
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

  const defaultBranch = (await hostedRepoDefaultBranch(project.id, dataDir)) ?? 'main';
  if (policy.refs === 'default-branch') {
    const defaultMoved =
      updatedRefs.length === 0 || updatedRefs.includes(`refs/heads/${defaultBranch}`);
    if (!defaultMoved) return;
  }

  const refspecs =
    policy.refs === 'all'
      ? ['refs/heads/*:refs/heads/*', 'refs/tags/*:refs/tags/*']
      : [`refs/heads/${defaultBranch}:refs/heads/${defaultBranch}`, 'refs/tags/*:refs/tags/*'];

  const pushUrl = deps.pushUrlOverride ?? project.repoUrl;
  if (!pushUrl) return;

  let token: string | null = null;
  if (!deps.pushUrlOverride) {
    token = await (deps.resolveToken ?? defaultResolveToken)(project);
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
    writeMirrorState(project.id, { lastSyncAt: new Date().toISOString() }, dataDir);
    deps.broadcast({ type: 'git_host_mirror', projectId: project.id, status: 'synced' });
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
    if (!isRetry) {
      const timer = setTimeout(() => {
        void runMirrorSync(project, updatedRefs, deps, true);
      }, deps.retryDelayMs ?? RETRY_DELAY_MS);
      if (typeof timer.unref === 'function') timer.unref();
    }
  }
}

/** Test seam: drop all queued mirror work. */
export function __clearMirrorQueues(): void {
  for (const entry of queues.values()) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  }
  queues.clear();
}
