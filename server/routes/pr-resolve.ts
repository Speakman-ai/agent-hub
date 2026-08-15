/**
 * routes/pr-resolve.ts — Manual on-demand autofix trigger for a PR.
 *
 * POST /api/projects/:projectId/pulls/:number/resolve  body: { agentId }
 *
 * Brings the PR's full context (via the shared `fetchPrDetail` helper) into a
 * fresh background agent session and ALWAYS spawns — the button's whole job is
 * to hand the agent the PR. The agent resolves whatever it finds (merge
 * conflicts, failing tests/CI, review and comment feedback); the session-end
 * pipeline then runs the review/test phase and auto-pushes to the PR branch.
 *
 * `triggered` reports which autofix kinds were detected from the snapshot
 * ({conflict, ci, review}); when none are detected the prompt still includes
 * the full set of autofix guardrails so the agent has guidance for whatever it
 * discovers locally.
 *
 * Complements the event-driven `autoKeepPrGreen` path: the webhook flow reacts
 * to GitHub events as they arrive, this endpoint lets a user click a button
 * and say "go work this PR now".
 *
 * Returns:
 *   201 { sessionId, triggered: AutofixKind[], session } — session spawned
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
import { broadcastSessionCreated } from '../session-checkpoint-rewind.js';

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
  opts: { native?: boolean; headBranch?: string | null } = {},
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

  // Belt-and-braces first step. The route pins the PR head branch onto the
  // session (`resolve_pr_head_branch`), and `ensureSessionWorkspace` provisions
  // the worktree directly on it — so for same-repo PRs the agent already starts
  // on the PR's head branch and these commands are a no-op. They still matter as
  // a fallback: fork PRs (head branch not on origin) and deleted-branch cases
  // fall back to the default `agent-hub/<agent-id>/session-<id>` branch, where
  // checking out the PR head branch is what keeps commits on the branch GitHub's
  // PR tracks. Without landing on that branch, the session-end push finds no PR
  // for the worktree branch and opens a duplicate instead of updating the PR.
  // See server/worktree.ts → ensureSessionWorkspace (resolvePrHeadBranch) and
  // push-and-create-pr.ts (`gh pr list --head` existing-PR reuse).
  const prNumber = pr.number;
  if (typeof prNumber === 'number' && Number.isFinite(prNumber) && prNumber > 0) {
    lines.push('');
    lines.push(`## Setup — required first step`);
    lines.push('');
    if (opts.native && opts.headBranch) {
      // Agent Hub-hosted repo: origin IS the Hub — no `gh` involved. Plain
      // git is sufficient to land on the PR's head branch.
      lines.push(
        'This repository is hosted on Agent Hub (origin is the Hub repo, not GitHub — do not use `gh`). Deepen history, then check out the PR head branch so your commits append to the existing PR:',
      );
      lines.push('');
      lines.push('```bash');
      lines.push('git fetch --unshallow origin 2>/dev/null || git fetch --depth=1000 origin');
      lines.push(`git checkout -B "${opts.headBranch}" "origin/${opts.headBranch}"`);
      lines.push('```');
    } else {
      lines.push(
        'This session runs in a **shallow** clone (`--depth 1`). A shallow clone is what makes `gh pr checkout` flaky — the PR head and the base branch share no history locally, so the checkout, tracking setup, and any rebase against the base fail or behave erratically. Deepen history first, then check out the PR branch:',
      );
      lines.push('');
      lines.push('```bash');
      lines.push('# 1. Unshallow so the PR head and base branch share history.');
      lines.push('git fetch --unshallow origin 2>/dev/null || git fetch --depth=1000 origin');
      lines.push('# 2. Check out the PR head branch (retry once after the fetch if it fails).');
      lines.push(`gh pr checkout ${prNumber} --force`);
      lines.push('```');
    }
    lines.push('');
    lines.push(
      "This positions your local checkout on the PR's head branch with enough history that commits append to the existing PR and conflict resolution / rebase against the base branch succeeds. Without this step, your commits land on a fresh session branch and will not be pushed to the PR when the session ends.",
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
  opts: { native?: boolean; headBranch?: string | null } = {},
): string {
  const header = buildPrContextHeader(pr, reviews, checks, comments, repoFullName, opts);
  const sections = [header, ...kinds.map((k) => loadAutofixTemplate(k))];
  return sections.join('\n\n---\n\n');
}

export default function createPrResolveRoutes(deps: RouteDeps): Router {
  const { config, findProject, findAgent, stmts, handleChat, broadcast } = deps;
  const router = Router();

  router.post(
    '/api/projects/:projectId/pulls/:number/resolve',
    async (req: Request, res: Response): Promise<Response | void> => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const native = project.gitHost === 'agenthub' && Boolean(deps.nativePr);
      const repo = parseRepoFullName(project.githubRepo as string | undefined);
      if (!native && !repo) {
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

      // Fetch PR snapshot — Hub-hosted projects read the native PR
      // in-process; GitHub projects fetch via the user's token (502 on
      // failure so the UI can retry).
      let detail;
      try {
        if (native) {
          detail = await deps.nativePr!.getDetail({ project, number: num });
        } else {
          const userToken = await resolveUserToken(req, config);
          detail = await fetchPrDetail(config, repo!, num, { userAccessToken: userToken });
        }
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
      const detected = detectKinds(pr, reviews, checks);

      // The Resolve PR button always brings the PR's full context into a fresh
      // session — it never bails out as "nothing to do". The agent reads the
      // context, resolves whatever it finds (merge conflicts, failing
      // tests/CI, and any review or comment feedback), then the session-end
      // pipeline runs the review/test phase and auto-pushes to the PR branch.
      //
      // When the snapshot shows no specific failing signal we still spawn, but
      // include the full set of autofix guardrails so the agent has guidance
      // for whatever it discovers locally.
      const promptKinds = detected.length > 0 ? detected : [...AUTOFIX_KINDS];

      const repoFullName = native
        ? `${project.id} (Agent Hub-hosted)`
        : `${repo!.owner}/${repo!.repo}`;
      const prompt = buildResolvePrompt(pr, reviews, checks, comments, repoFullName, promptKinds, {
        native,
        headBranch: typeof pr.head === 'string' ? pr.head : null,
      });

      const taskId = uuidv4();
      const sessionId = uuidv4();

      const engine = found.agent.engine || 'claude-code';
      const resolverUid = resolveOwnerUserId(req as AuthenticatedRequest);
      const model = resolveEffectiveModel(config, engine, {
        agentModel: found.agent.model,
        ownerUserId: resolverUid,
        agentId,
      });
      const title = typeof pr.title === 'string' ? pr.title : '';
      const sessionName = `[Resolve PR #${num}] ${title}`.slice(0, 100);

      const wt = defaultSessionUseWorktreeFlag(project);
      stmts.createSession.run(sessionId, agentId, sessionName, engine, model, wt, 0, 1);
      setSessionOwner(sessionId, resolveOwnerUserId(req as AuthenticatedRequest));
      // Pin the PR's head branch onto the session so `ensureSessionWorkspace`
      // provisions the worktree directly on it: the agent's commits append to
      // the existing PR and the session-end push updates that PR instead of
      // opening a new one — instead of relying on the prompt's `gh pr checkout`.
      // Only meaningful for worktree-backed sessions; harmless otherwise.
      const headBranch = typeof pr.head === 'string' ? pr.head.trim() : '';
      if (wt === 1 && headBranch) {
        stmts.setSessionResolvePrHeadBranch.run(headBranch, sessionId);
      }
      // Resolve PR sessions exist to drive a PR to merge-ready: the agent fixes
      // conflicts/CI/review, then the work should run through review + tests and
      // be pushed back to the PR automatically. Start at the "Build and Push"
      // finalize level so the session-end pipeline reviews, tests, and pushes
      // without a human re-toggling it each time.
      stmts.updateSessionFinalizeAutomation.run('push', sessionId);
      stmts.insertBackgroundTask.run(taskId, sessionId, agentId, prompt);

      handleChat(null, {
        type: 'chat',
        agentId,
        sessionId,
        content: prompt,
      });

      const session = stmts.getSession.get(sessionId) as SessionRow;
      broadcastSessionCreated(broadcast, agentId, session, stmts);
      return res.status(201).json({ sessionId, triggered: detected, session });
    },
  );

  return router;
}
