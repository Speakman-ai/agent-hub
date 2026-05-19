/**
 * routes/pr-resolve.ts — Manual on-demand autofix trigger for a PR.
 *
 * POST /api/projects/:projectId/pulls/:number/resolve  body: { agentId }
 *
 * Inspects the PR's current state (via the shared `fetchPrDetail` helper) and,
 * if any of {conflict, ci, review} autofix kinds apply, spawns a background
 * agent session with a prompt that combines the relevant autofix templates.
 *
 * Complements the event-driven `autoKeepPrGreen` path: the webhook flow reacts
 * to GitHub events as they arrive, this endpoint lets a user click a button
 * and say "go check this PR now" — e.g. if an event was missed, or the PR is
 * stale, or they just want to prod an idle PR.
 *
 * Returns:
 *   200 { sessionId, triggered: AutofixKind[] }      — session spawned
 *   200 { sessionId: null, triggered: [], reason: 'no-action-needed' } — clean PR
 *   400 if agentId is missing
 *   404 if the project / PR cannot be found
 *   502 if the GitHub fetch fails
 */
import { v4 as uuidv4 } from 'uuid';
import { Router, Request, Response } from 'express';
import type { RouteDeps, SessionRow } from '../types.js';
import { resolveEffectiveModel } from '../effective-model.js';
import { fetchPrDetail } from '../pr-detail-fetch.js';
import { parseRepoFullName, resolveUserToken } from './pr-list.js';
import { AUTOFIX_KINDS, loadAutofixTemplate, type AutofixKind } from '../prompts/autofix/index.js';
import { defaultSessionUseWorktreeFlag } from '../project-mode.js';
import { setSessionOwner, resolveOwnerUserId } from '../session-ownership.js';
import type { AuthenticatedRequest } from '../auth.js';
import { CI_FAIL_CONCLUSIONS } from '../ci-conclusions.js';

/** CLI (`CONFLICTING`) and App (`dirty`, `conflicting`) values both get caught here. */
const CONFLICT_STATES = new Set(['dirty', 'conflicting']);

type PrRecord = Record<string, unknown>;
type ReviewRecord = Record<string, unknown>;
type CheckRecord = Record<string, unknown>;
type CommentRecord = Record<string, unknown>;

/**
 * Pick the latest review per user and return those whose state is
 * `CHANGES_REQUESTED`. Reviews we see in the wild use uppercase state names
 * (both App and CLI paths — see the normalizers in pr-list.ts) but we
 * upper-case defensively in case the shape evolves.
 */
export function latestChangesRequestedReviews(reviews: ReviewRecord[]): ReviewRecord[] {
  const latestByUser = new Map<string, ReviewRecord>();
  for (const r of reviews) {
    const user = (r.user as string | null | undefined) ?? '(unknown)';
    const existing = latestByUser.get(user);
    if (!existing) {
      latestByUser.set(user, r);
      continue;
    }
    const a = (r.submitted_at as string | null) ?? '';
    const b = (existing.submitted_at as string | null) ?? '';
    if (a >= b) latestByUser.set(user, r);
  }
  return Array.from(latestByUser.values()).filter(
    (r) => typeof r.state === 'string' && (r.state as string).toUpperCase() === 'CHANGES_REQUESTED',
  );
}

/** Determine which autofix kinds apply given a PR snapshot. Pure — no I/O. */
export function detectKinds(
  pr: PrRecord,
  reviews: ReviewRecord[],
  checks: CheckRecord[],
): AutofixKind[] {
  const kinds: AutofixKind[] = [];

  const conflictByMergeable = pr.mergeable === false;
  const mergeableState =
    typeof pr.mergeable_state === 'string' ? (pr.mergeable_state as string).toLowerCase() : null;
  const conflictByState = mergeableState !== null && CONFLICT_STATES.has(mergeableState);
  if (conflictByMergeable || conflictByState) kinds.push('conflict');

  const ciFail = checks.some((c) => {
    const conc = typeof c.conclusion === 'string' ? (c.conclusion as string).toLowerCase() : null;
    return conc !== null && CI_FAIL_CONCLUSIONS.has(conc);
  });
  if (ciFail) kinds.push('ci');

  if (latestChangesRequestedReviews(reviews).length > 0) kinds.push('review');

  // Preserve a stable ordering matching AUTOFIX_KINDS so tests don't depend
  // on the order of push above.
  return AUTOFIX_KINDS.filter((k) => kinds.includes(k));
}

/**
 * Build a short context header that precedes the autofix template bodies.
 * Keep this terse: the templates themselves carry the "how to fix" wording;
 * the header just gives the agent the minimum facts to orient on the PR.
 */
export function buildPrContextHeader(
  pr: PrRecord,
  reviews: ReviewRecord[],
  checks: CheckRecord[],
  comments: CommentRecord[],
  repoFullName: string,
): string {
  const lines: string[] = [];
  lines.push(`## PR Context`);
  lines.push('');
  lines.push(`- Repo: ${repoFullName}`);
  lines.push(`- PR: #${pr.number ?? '?'} — ${pr.title ?? '(no title)'}`);
  if (pr.html_url) lines.push(`- URL: ${pr.html_url}`);
  if (pr.head || pr.base) lines.push(`- Branch: ${pr.head ?? '?'} → ${pr.base ?? '?'}`);
  if (pr.mergeable_state !== undefined && pr.mergeable_state !== null) {
    lines.push(`- mergeable: ${pr.mergeable ?? 'unknown'} (state: ${pr.mergeable_state})`);
  }

  // Required first step. Resolve sessions spawn into a fresh worktree branch
  // (`agent-hub/<agent-id>/session-<id>`), NOT the PR's head branch. If the
  // agent commits on the worktree branch and the session ends, `autoCommitAndPR`
  // runs `gh pr view <branch>` against the worktree branch, finds no PR, and
  // falls through to a `changes_ready` broadcast — the commits stay local and
  // the PR is never updated. Checking out the PR head branch first guarantees
  // that:
  //   1. Subsequent commits land on the same branch GitHub's PR is tracking.
  //   2. The session-end auto-commit pipeline finds the open PR via the
  //      pre-check in `commitPushAndCreatePR` and pushes the fix.
  // See server/auto-git.ts → autoCommitAndPR (`!isAutonomousCard` branch) and
  // the resolve-comment regression test in server/auto-git.test.ts.
  const prNumber = pr.number;
  if (typeof prNumber === 'number' && Number.isFinite(prNumber) && prNumber > 0) {
    lines.push('');
    lines.push(`## Setup — required first step`);
    lines.push('');
    lines.push(
      `Run \`gh pr checkout ${prNumber}\` in this worktree before making any code changes.`,
    );
    lines.push(
      "This positions your local checkout on the PR's head branch so commits append to the existing PR. Without this step, your commits land on a fresh session branch and will not be pushed to the PR when the session ends.",
    );
  }

  const failingChecks = checks.filter((c) => {
    const conc = typeof c.conclusion === 'string' ? (c.conclusion as string).toLowerCase() : null;
    return conc !== null && CI_FAIL_CONCLUSIONS.has(conc);
  });
  if (failingChecks.length) {
    lines.push('');
    lines.push(`### Failing checks (${failingChecks.length})`);
    for (const c of failingChecks) {
      const name = c.name ?? '(unnamed check)';
      const conc = c.conclusion ?? 'unknown';
      const url = c.html_url ? ` — ${c.html_url}` : '';
      lines.push(`- ${name}: ${conc}${url}`);
    }
  }

  const cr = latestChangesRequestedReviews(reviews);
  if (cr.length) {
    lines.push('');
    lines.push(`### Review feedback (${cr.length} reviewer${cr.length === 1 ? '' : 's'})`);
    for (const r of cr) {
      const user = r.user ?? '(unknown)';
      const body = ((r.body as string | null | undefined) ?? '').trim();
      lines.push(`- **${user}**: ${body || '(no body)'}`);
    }
  }

  if (comments.length) {
    lines.push('');
    lines.push(`### Recent comments (${comments.length})`);
    // Last 5, to keep the prompt tight.
    for (const c of comments.slice(-5)) {
      const user = c.user ?? '(unknown)';
      const body = ((c.body as string | null | undefined) ?? '').trim();
      const snippet = body.length > 200 ? body.slice(0, 200) + '…' : body;
      lines.push(`- **${user}**: ${snippet || '(no body)'}`);
    }
  }

  return lines.join('\n');
}

/** Compose the full prompt: context header + template bodies joined by `---`. */
export function buildResolvePrompt(
  pr: PrRecord,
  reviews: ReviewRecord[],
  checks: CheckRecord[],
  comments: CommentRecord[],
  repoFullName: string,
  kinds: AutofixKind[],
): string {
  const header = buildPrContextHeader(pr, reviews, checks, comments, repoFullName);
  const sections = [header, ...kinds.map((k) => loadAutofixTemplate(k))];
  return sections.join('\n\n---\n\n');
}

export default function createPrResolveRoutes(deps: RouteDeps): Router {
  const { config, findProject, findAgent, stmts, handleChat } = deps;
  const router = Router();

  router.post(
    '/api/projects/:projectId/pulls/:number/resolve',
    async (req: Request, res: Response): Promise<Response | void> => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const repo = parseRepoFullName(project.githubRepo as string | undefined);
      if (!repo) {
        return res.status(400).json({
          error: 'Project has no githubRepo configured',
          hint: 'Set project.githubRepo to "owner/repo" to enable the Resolve PR action.',
        });
      }

      const num = Number.parseInt(String(req.params.number), 10);
      if (!Number.isFinite(num) || num <= 0) {
        return res.status(400).json({ error: 'Invalid PR number' });
      }

      const { agentId } = (req.body || {}) as { agentId?: string };
      if (!agentId || typeof agentId !== 'string') {
        return res.status(400).json({ error: 'agentId is required' });
      }

      const found = findAgent(agentId);
      if (!found) return res.status(404).json({ error: `Unknown agent: ${agentId}` });

      // Fetch PR snapshot — bubbles up as 502 on failure so the UI can retry.
      let detail;
      try {
        const userToken = await resolveUserToken(req, config);
        detail = await fetchPrDetail(config, repo, num, { userAccessToken: userToken });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // If the fetch failed with a 404-ish message, surface that as 404
        // rather than 502 so the UI can distinguish "PR doesn't exist" from
        // "GitHub is unreachable".
        if (/not found|404/i.test(msg)) {
          return res.status(404).json({ error: `PR #${num} not found` });
        }
        return res.status(502).json({ error: `Failed to fetch PR: ${msg.split('\n')[0]}` });
      }

      const { pr, reviews, checks, comments } = detail;
      const kinds = detectKinds(pr, reviews, checks);

      if (kinds.length === 0) {
        return res.json({
          sessionId: null,
          triggered: [],
          reason: 'no-action-needed',
        });
      }

      const repoFullName = `${repo.owner}/${repo.repo}`;
      const prompt = buildResolvePrompt(pr, reviews, checks, comments, repoFullName, kinds);

      const taskId = uuidv4();
      const sessionId = uuidv4();

      const engine = found.agent.engine || 'claude-code';
      const resolverUid = resolveOwnerUserId(req as AuthenticatedRequest);
      const model = resolveEffectiveModel(config, engine, {
        agentModel: found.agent.model,
        ownerUserId: resolverUid,
      });
      const title = typeof pr.title === 'string' ? pr.title : '';
      const sessionName = `[Resolve PR #${num}] ${title}`.slice(0, 100);

      const wt = defaultSessionUseWorktreeFlag(project);
      stmts.createSession.run(sessionId, agentId, sessionName, engine, model, wt, 0, 1);
      setSessionOwner(sessionId, resolveOwnerUserId(req as AuthenticatedRequest));
      stmts.insertBackgroundTask.run(taskId, sessionId, agentId, prompt);

      handleChat(null, {
        type: 'chat',
        agentId,
        sessionId,
        content: prompt,
      });

      const session = stmts.getSession.get(sessionId) as SessionRow;
      return res.status(201).json({ sessionId, triggered: kinds, session });
    },
  );

  return router;
}
