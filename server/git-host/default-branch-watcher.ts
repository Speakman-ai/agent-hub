/**
 * Default-branch watcher: the push CI trigger for projects whose repo lives
 * on GitHub instead of the Hub. Hub-hosted repos learn about a moved default
 * branch from the push or merge itself; a GitHub origin tells us nothing, so
 * this polls `git ls-remote` on an interval and hands every new head to
 * push CI ({@link runMirroredDefaultBranchCi}), which shares the hosted
 * path's per-sha dedupe, concurrency group and failure handling.
 *
 * Merges the Hub performs on GitHub call {@link requestDefaultBranchPoll}
 * so the run starts right away instead of on the next tick.
 *
 * Polls are serialized per project, and a request that arrives while one is
 * running coalesces into a single follow-up poll.
 */
import config from '../config.js';
import type { BroadcastFn, Project, Stmts } from '../types.js';
import {
  lsRemoteDefaultHead,
  resolveProjectOriginUrl,
  syncOriginMirror,
  type RemoteHead,
} from './origin-mirror.js';
import { ciOnPushEnabled, runMirroredDefaultBranchCi, type PushCiDeps } from './push-ci.js';
import { setDefaultBranchPollRequester } from './default-branch-poll-request.js';

const DEFAULT_INTERVAL_MS = 60_000;

export interface DefaultBranchWatcherDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  getProjects: () => Project[];
  dataDir?: string;
  /** Git env carrying the project's GitHub credentials. */
  gitEnv?: (project: Project) => Promise<NodeJS.ProcessEnv>;
  /** Test seam — defaults to {@link resolveProjectOriginUrl}. */
  resolveUrl?: (project: Project) => Promise<string | null>;
  /** Test seam — defaults to {@link lsRemoteDefaultHead}. */
  lsRemote?: (url: string, env: NodeJS.ProcessEnv) => Promise<RemoteHead | null>;
  /** Test seam — defaults to {@link syncOriginMirror}. */
  syncMirror?: typeof syncOriginMirror;
  /** Passed through to push CI (test seams for the job phase etc.). */
  pushCi?: Omit<PushCiDeps, 'stmts' | 'broadcast' | 'dataDir'>;
}

export type PollResult =
  | { status: 'skipped'; reason: 'disabled' | 'no_origin' | 'no_head' | 'unchanged' | 'busy' }
  | { status: 'checked'; head: RemoteHead; admission: 'admitted' | 'nothing' | 'error' }
  | { status: 'error'; error: string };

/** Projects this watcher polls: CI on push enabled, repo not hosted on the Hub. */
export function watchesDefaultBranch(project: Project): boolean {
  return project.gitHost !== 'agenthub' && ciOnPushEnabled(project);
}

async function defaultGitEnv(project: Project): Promise<NodeJS.ProcessEnv> {
  const { autoGitChildEnv, resolveOrgOwnerGithubToken } = await import('../auto-git.js');
  const token = await resolveOrgOwnerGithubToken(config, project.githubRepo ?? null);
  return autoGitChildEnv(token);
}

export interface DefaultBranchWatcher {
  /** Poll one project now (coalesced with an in-flight poll). */
  poll: (projectId: string) => Promise<PollResult>;
  /** Poll every watched project once. */
  tick: () => Promise<void>;
  stop: () => void;
}

/**
 * Build a watcher without starting its timer. `lastSeen` is per instance:
 * a fresh process re-checks each head once, and push CI's per-sha dedupe
 * turns an already-run head into a no-op.
 */
export function createDefaultBranchWatcher(deps: DefaultBranchWatcherDeps): DefaultBranchWatcher {
  const dataDir = deps.dataDir ?? config.dataDir;
  const lastSeen = new Map<string, string>();
  const running = new Map<string, Promise<PollResult>>();
  const queued = new Map<string, Promise<PollResult>>();

  const findProject = (projectId: string): Project | undefined =>
    deps.getProjects().find((p) => p.id === projectId);

  async function pollOnce(projectId: string): Promise<PollResult> {
    const project = findProject(projectId);
    if (!project || !watchesDefaultBranch(project)) {
      return { status: 'skipped', reason: 'disabled' };
    }
    try {
      const url = await (deps.resolveUrl ?? resolveProjectOriginUrl)(project);
      if (!url) return { status: 'skipped', reason: 'no_origin' };
      const env = await (deps.gitEnv ?? defaultGitEnv)(project);
      const lsRemote = deps.lsRemote ?? lsRemoteDefaultHead;
      const head = await lsRemote(url, env);
      if (!head) return { status: 'skipped', reason: 'no_head' };
      if (lastSeen.get(projectId) === `${head.branch}|${head.sha}`) {
        return { status: 'skipped', reason: 'unchanged' };
      }
      // The head admission actually checked. It can differ from `head` when
      // the branch moved between the two reads, and only it may be cached.
      let checkedSha: string | null = null;

      const { admission } = runMirroredDefaultBranchCi(
        project,
        {
          branch: head.branch,
          // Re-read inside the admission lane: a later admission must never
          // build an older head than an earlier one.
          readHead: async () => {
            const live = await lsRemote(url, env);
            checkedSha = live && live.branch === head.branch ? live.sha : null;
            return checkedSha;
          },
          materialize: (headSha) =>
            (deps.syncMirror ?? syncOriginMirror)({
              projectId,
              dataDir,
              url,
              branch: head.branch,
              headSha,
              env,
            }),
        },
        { ...deps.pushCi, stmts: deps.stmts, broadcast: deps.broadcast, dataDir },
      );
      const outcome = await admission;
      // A failed fetch leaves the head unseen so the next tick retries it.
      if (outcome !== 'error' && checkedSha)
        lastSeen.set(projectId, `${head.branch}|${checkedSha}`);
      return { status: 'checked', head, admission: outcome };
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      console.warn(`[default-branch-watcher] poll failed for ${projectId}: ${error}`);
      return { status: 'error', error };
    }
  }

  function poll(projectId: string): Promise<PollResult> {
    const pending = queued.get(projectId);
    if (pending) return pending;
    const current = running.get(projectId);
    if (!current) {
      const p = pollOnce(projectId).finally(() => {
        if (running.get(projectId) === p) running.delete(projectId);
      });
      running.set(projectId, p);
      return p;
    }
    const next = current.then(() => {
      queued.delete(projectId);
      return poll(projectId);
    });
    queued.set(projectId, next);
    return next;
  }

  async function tick(): Promise<void> {
    const watched = deps.getProjects().filter(watchesDefaultBranch);
    // A tick never stacks behind a slow poll; the next tick picks it up.
    await Promise.all(watched.filter((p) => !running.has(p.id)).map((p) => poll(p.id)));
  }

  return { poll, tick, stop: () => {} };
}

let active: { watcher: DefaultBranchWatcher; timer: NodeJS.Timeout } | null = null;

function resolveIntervalMs(): number {
  const raw = Number(process.env.AGENT_HUB_DEFAULT_BRANCH_POLL_MS);
  return Number.isFinite(raw) && raw >= 5_000 ? raw : DEFAULT_INTERVAL_MS;
}

/** Start the process-wide watcher (idempotent) and register the merge seam. */
export function startDefaultBranchWatcher(
  deps: DefaultBranchWatcherDeps,
  opts: { intervalMs?: number } = {},
): DefaultBranchWatcher {
  if (active) return active.watcher;
  const watcher = createDefaultBranchWatcher(deps);
  const timer = setInterval(() => {
    void watcher.tick();
  }, opts.intervalMs ?? resolveIntervalMs());
  timer.unref?.();
  const stop = (): void => {
    clearInterval(timer);
    setDefaultBranchPollRequester(null);
    if (active?.watcher === wrapped) active = null;
  };
  const wrapped: DefaultBranchWatcher = { ...watcher, stop };
  active = { watcher: wrapped, timer };
  setDefaultBranchPollRequester((projectId) => {
    void watcher.poll(projectId);
  });
  void watcher.tick();
  return wrapped;
}
