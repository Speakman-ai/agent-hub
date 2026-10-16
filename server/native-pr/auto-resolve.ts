/**
 * Auto-resolve for native PRs (`Project.autoResolvePr.enabled`).
 *
 * When an open PR on an Agent Hub-hosted repo goes bad in any of three ways
 * (merge conflict with its base, a failing PR CI job, or a changes-requested
 * review), dispatch the same `[Resolve PR #N]` session the Resolve PR button
 * starts. That session fixes everything it finds and its Finalize run pushes
 * back to the PR head.
 *
 * The first bad signal wins: a resolve session handles all three problems at
 * once, so there is no point waiting for the rest of CI or for a review once
 * one signal is red. Each trigger is just a nudge to re-evaluate the PR:
 *
 *   - `ci`: the first failed PR CI job for the head (see push-ci's
 *     `setPrChecksFailedHook`), not the end of the run.
 *   - `review`: a `changes_requested` verdict landing on the PR.
 *   - `conflict`: the PR head changed, or its base branch moved, and a
 *     merge-tree probe says the two no longer merge cleanly.
 *
 * Dedup is one dispatch per (PR, head sha). A changes-requested review that
 * lands while that session exists is forwarded into it rather than dropped.
 * A per-PR cap stops a resolve session that keeps pushing red heads from
 * looping forever.
 */
import type { Agent, BroadcastFn, Project, PullRequestRow, RouteDeps, Stmts } from '../types.js';
import type { NativePrService } from './service.js';
import { getPullRequest, listPullRequests } from './store.js';
import { isKnownHubUserId } from './author-user.js';
import { spawnPrResolveSession, type PrResolveDetail } from '../routes/pr-resolve.js';
import { CI_FAIL_CONCLUSIONS } from '../ci-conclusions.js';

/** Auto dispatches allowed per PR per server lifetime before we stop and leave it to a human. */
export const MAX_AUTO_RESOLVE_DISPATCHES_PER_PR = 5;
/** Open PRs probed for conflicts when a base branch moves. */
const BASE_MOVED_SCAN_LIMIT = 200;

export type AutoResolveTrigger =
  | { kind: 'ci'; headSha: string; reason: string }
  | { kind: 'review'; reviewer: string; body: string }
  | { kind: 'conflict'; reason: string };

export interface AutoResolveDeps {
  stmts: Stmts;
  config: RouteDeps['config'];
  broadcast: BroadcastFn;
  handleChat: RouteDeps['handleChat'];
  nativePr: Pick<NativePrService, 'getDetail'>;
}

export type AutoResolveOutcome =
  | 'dispatched'
  | 'forwarded'
  | 'disabled'
  | 'not_open'
  | 'no_agent'
  | 'no_signal'
  | 'stale_head'
  | 'deduped'
  | 'capped'
  | 'error';

export interface AutoResolveResult {
  outcome: AutoResolveOutcome;
  sessionId?: string;
}

/**
 * `${project}#${pr}@${headSha}` → the resolve session dispatched for that head
 * and the agent it runs as. The agent is kept so forwarded reviews go to the
 * session's own agent even if the configured auto-resolve agent changed since.
 */
const dispatchedByHead = new Map<string, { sessionId: string; agentId: string }>();
/** `${project}#${pr}` → auto dispatches so far. */
const dispatchCountByPr = new Map<string, number>();
/** Per-PR serial lane so concurrent triggers (two jobs failing at once) dedupe cleanly. */
const lanes = new Map<string, Promise<unknown>>();

/** Test seam. */
export function __resetAutoResolveState(): void {
  dispatchedByHead.clear();
  dispatchCountByPr.clear();
  lanes.clear();
}

export function autoResolveEnabled(project: Project): boolean {
  return project.gitHost === 'agenthub' && project.autoResolvePr?.enabled === true;
}

/**
 * The agent that works auto-resolve sessions: the configured one when it still
 * exists on the project, else the first `dev` agent, else the first agent that
 * is not the Reviewer (a reviewer reviewing its own fixes defeats the point).
 */
export function pickAutoResolveAgent(project: Project): Agent | null {
  const agents = (project.agents ?? []) as Agent[];
  const configured = project.autoResolvePr?.agentId;
  if (configured) {
    const match = agents.find((a) => a.id === configured);
    if (match) return match;
  }
  return agents.find((a) => a.role === 'dev') ?? agents.find((a) => a.role !== 'reviewer') ?? null;
}

function prKey(projectId: string, number: number): string {
  return `${projectId}#${number}`;
}

function hasFailingCheck(checks: Array<Record<string, unknown>>): boolean {
  return checks.some((c) => {
    const conc = typeof c.conclusion === 'string' ? c.conclusion.toLowerCase() : null;
    return conc !== null && CI_FAIL_CONCLUSIONS.has(conc);
  });
}

function triggerLabel(trigger: AutoResolveTrigger): string {
  switch (trigger.kind) {
    case 'ci':
      return `PR CI went red (${trigger.reason})`;
    case 'review':
      return `${trigger.reviewer} requested changes`;
    case 'conflict':
      return `the PR no longer merges cleanly (${trigger.reason})`;
  }
}

function preambleFor(trigger: AutoResolveTrigger): string {
  return [
    '## Auto-resolve',
    '',
    `This session was started automatically because ${triggerLabel(trigger)}.`,
    'Other checks may still be running. Do not stop at the problem that triggered this session:',
    'resolve merge conflicts with the base branch, fix failing tests/CI, and address requested',
    'review changes, then commit. Finalize pushes the result back to this PR.',
  ].join('\n');
}

/**
 * Re-evaluate one PR after a trigger and dispatch (or forward into) a resolve
 * session when warranted. Never throws; fire-and-forget safe.
 */
export function maybeAutoResolvePr(
  project: Project,
  number: number,
  trigger: AutoResolveTrigger,
  deps: AutoResolveDeps,
): Promise<AutoResolveResult> {
  if (!autoResolveEnabled(project)) return Promise.resolve({ outcome: 'disabled' });
  const key = prKey(project.id, number);
  const prior = lanes.get(key) ?? Promise.resolve();
  const next = prior.then(() => admit(project, number, trigger, deps));
  const settled = next.catch(() => {});
  lanes.set(key, settled);
  void settled.then(() => {
    if (lanes.get(key) === settled) lanes.delete(key);
  });
  return next;
}

async function admit(
  project: Project,
  number: number,
  trigger: AutoResolveTrigger,
  deps: AutoResolveDeps,
): Promise<AutoResolveResult> {
  try {
    const row = getPullRequest(deps.stmts, project.id, number);
    if (!row || row.status !== 'open') return { outcome: 'not_open' };

    const agent = pickAutoResolveAgent(project);
    if (!agent) {
      console.warn(`[auto-resolve] ${project.id}#${number}: no dev agent on the project, skipping`);
      return { outcome: 'no_agent' };
    }

    const detail = await deps.nativePr.getDetail({ project, number });
    const headSha = detail.headSha;
    if (!headSha) return { outcome: 'not_open' };

    if (trigger.kind === 'ci') {
      // A newer push already superseded the red head; its own CI decides.
      if (trigger.headSha !== headSha) return { outcome: 'stale_head' };
      if (!hasFailingCheck(detail.checks)) return { outcome: 'no_signal' };
    } else if (trigger.kind === 'conflict') {
      if (detail.pr.mergeable !== false) return { outcome: 'no_signal' };
    }

    const headKey = `${prKey(project.id, number)}@${headSha}`;
    const existing = dispatchedByHead.get(headKey);
    if (existing?.sessionId) {
      if (trigger.kind === 'review') {
        // The resolve session for this head predates the review, so its
        // prompt is missing the feedback. Queue it into that session.
        deps.handleChat(null, {
          type: 'chat',
          agentId: existing.agentId,
          sessionId: existing.sessionId,
          content: [
            `New review on PR #${number}: **${trigger.reviewer}** requested changes.`,
            '',
            trigger.body.trim() || '(no body)',
            '',
            'Address this feedback as part of resolving the PR.',
          ].join('\n'),
        });
        return { outcome: 'forwarded', sessionId: existing.sessionId };
      }
      return { outcome: 'deduped', sessionId: existing.sessionId };
    }

    const count = dispatchCountByPr.get(prKey(project.id, number)) ?? 0;
    if (count >= MAX_AUTO_RESOLVE_DISPATCHES_PER_PR) {
      console.warn(
        `[auto-resolve] ${project.id}#${number}: ${count} auto-resolve sessions already dispatched, leaving it for a human`,
      );
      return { outcome: 'capped' };
    }

    // Dismissed reviews no longer count; keep them out of the prompt.
    const reviews = detail.reviews.filter((r) => r.dismissed !== true);
    const resolveDetail: PrResolveDetail = {
      pr: detail.pr,
      reviews,
      checks: detail.checks,
      comments: detail.comments,
    };

    // Reserve the head before spawning so a concurrent lane entry can't double-dispatch.
    dispatchedByHead.set(headKey, { sessionId: '', agentId: agent.id });
    dispatchCountByPr.set(prKey(project.id, number), count + 1);
    try {
      const { sessionId } = spawnPrResolveSession(deps, {
        project,
        prNumber: number,
        agentId: agent.id,
        agent,
        ownerUserId: isKnownHubUserId(row.author) ? row.author : null,
        native: true,
        repoFullName: `${project.id} (Agent Hub-hosted)`,
        detail: resolveDetail,
        preamble: preambleFor(trigger),
      });
      dispatchedByHead.set(headKey, { sessionId, agentId: agent.id });
      console.log(
        `[auto-resolve] ${project.id}#${number}@${headSha.slice(0, 8)}: dispatched session ${sessionId} (${trigger.kind})`,
      );
      return { outcome: 'dispatched', sessionId };
    } catch (err) {
      dispatchedByHead.delete(headKey);
      dispatchCountByPr.set(prKey(project.id, number), count);
      throw err;
    }
  } catch (err: unknown) {
    console.warn(
      `[auto-resolve] ${project.id}#${number} (${trigger.kind}) failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { outcome: 'error' };
  }
}

/** PR head changed (created or new push): probe for conflicts with its base. */
export function autoResolveOnHeadChanged(
  project: Project,
  row: Pick<PullRequestRow, 'number'>,
  deps: AutoResolveDeps,
): Promise<AutoResolveResult> {
  return maybeAutoResolvePr(
    project,
    row.number,
    { kind: 'conflict', reason: 'head updated' },
    deps,
  );
}

/**
 * A base branch moved (merge, revert, or direct push): every open PR targeting
 * it may now conflict. Probes run serially to keep merge-tree load bounded.
 */
export async function autoResolveOnBaseMoved(
  project: Project,
  baseBranch: string,
  deps: AutoResolveDeps,
): Promise<void> {
  if (!autoResolveEnabled(project)) return;
  const open = listPullRequests(deps.stmts, project.id, 'open', BASE_MOVED_SCAN_LIMIT).filter(
    (pr) => pr.base_branch === baseBranch,
  );
  for (const pr of open) {
    await maybeAutoResolvePr(
      project,
      pr.number,
      { kind: 'conflict', reason: `${baseBranch} moved` },
      deps,
    );
  }
}

/** PR CI for `branch` went red at `headSha`: find the open PR it backs and resolve it. */
export function autoResolveOnChecksFailed(
  project: Project,
  args: { branch: string; headSha: string; reason: string },
  deps: AutoResolveDeps,
): Promise<AutoResolveResult> {
  if (!autoResolveEnabled(project)) return Promise.resolve({ outcome: 'disabled' });
  const open = deps.stmts.getOpenPullRequestByHeadBranch.get(project.id, args.branch) as
    | PullRequestRow
    | undefined;
  if (!open) return Promise.resolve({ outcome: 'not_open' });
  return maybeAutoResolvePr(
    project,
    open.number,
    { kind: 'ci', headSha: args.headSha, reason: args.reason },
    deps,
  );
}
