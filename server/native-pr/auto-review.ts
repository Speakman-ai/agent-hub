/**
 * auto-review.ts — the review safety net for EXTERNAL commits.
 *
 * Agent Hub-originated work is reviewed inside its session (Finalize's
 * in-hub reviewer runs pre-push with the fix loop attached), and a
 * fully-validated head satisfies branch protection via the passthrough.
 * Code that arrives on a PR head any other way — a laptop push over
 * smart-HTTP, a "push anyway", commits stacked after validation — lands
 * unreviewed. When the project's branch protection requires review,
 * this dispatches the project Reviewer agent against the native PR so
 * the gate can clear without a human writing the first review by hand.
 *
 * Mirrors the PR-level CI fallback (git-host/push-ci.ts maybeRunPrCi):
 * same trigger points, same Finalize-validated skip, deduped per
 * (PR, head sha). The agent posts its verdict through the native review
 * endpoint with its own reviewer name, so verdict precedence and the
 * "Autofix from review" button work exactly as for human reviews.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Project, PullRequestRow, RouteDeps } from '../types.js';
import { bareRepoPath, hostedRepoExists } from './host.js';
import { buildNativePrUrl } from './url.js';
import { revParse } from './git-read.js';
import { resolveOneShotEngine, NoEnginesAvailableError } from '../engine-resolver.js';
import { resolveEffectiveEngineAndModel } from '../effective-model.js';
import { setSessionOwner } from '../session-ownership.js';
import { defaultSessionUseWorktreeFlag } from '../project-mode.js';

export interface AutoReviewDeps {
  stmts: RouteDeps['stmts'];
  config: RouteDeps['config'];
  broadcast: RouteDeps['broadcast'];
  handleChat: RouteDeps['handleChat'];
}

export interface AutoReviewOpts {
  /** Test seam: bypass the vitest env guard (handleChat mocked). */
  force?: boolean;
  /**
   * The authenticated Hub user who pushed the commits that triggered this
   * review (from the smart-HTTP receive-pack auth, correlated via
   * `recent-pusher.ts`). When set, the review runs as that user: their
   * per-user reviewer engine/model overrides resolve the spawn, and the
   * session is owned by them so the reviewer CLI uses their per-account
   * credentials — mirroring the Finalize in-session reviewer. When null
   * (anonymous / break-glass push), the userless one-shot resolver picks a
   * host-runnable engine instead.
   */
  pushedByUserId?: string | null;
}

/** One dispatch per (project, pr, head sha) per process lifetime. */
const dispatched = new Set<string>();

/** Test seam. */
export function __clearAutoReviewDispatches(): void {
  dispatched.clear();
}

/** See module header. Fire-and-forget safe; never throws. */
export async function maybeRunPrAutoReview(
  project: Project,
  pr: Pick<PullRequestRow, 'number' | 'head_branch' | 'status'>,
  deps: AutoReviewDeps,
  opts: AutoReviewOpts = {},
): Promise<void> {
  try {
    if (process.env.AGENT_HUB_DISABLE_AUTO_REVIEW === '1' && !opts.force) return;
    if (project.gitHost !== 'agenthub') return;
    // Option-1 gating: auto-review exists to keep the required-review
    // gate flowing for external pushes; without the gate it's not needed.
    if (project.branchProtection?.requiredReview !== true) return;
    if (pr.status && pr.status !== 'open') return;
    if (!hostedRepoExists(project.id)) return;

    const reviewer = (project.agents || []).find((a) => a.role === 'reviewer');
    if (!reviewer) {
      console.warn(
        `[auto-review] ${project.id}: requiredReview is on but no reviewer agent exists — skipping`,
      );
      return;
    }

    const repoPath = bareRepoPath(project.id);
    const headSha = await revParse(repoPath, `refs/heads/${pr.head_branch}`);
    if (!headSha) return; // branch gone

    // Session-validation passthrough: Finalize already reviewed this sha.
    if (deps.stmts.getValidatedFinalizeRunForSha.get(project.id, pr.head_branch, headSha)) {
      return;
    }

    const key = `${project.id}#${pr.number}@${headSha}`;
    if (dispatched.has(key)) return;
    dispatched.add(key);

    const prUrl = buildNativePrUrl(project.id, pr.number);
    const sessionId = uuidv4();
    const taskId = uuidv4();

    // Resolve the engine/model the review runs on.
    //
    // When we know the pushing Hub user (authenticated receive-pack), run
    // the review AS that user — exactly like the Finalize in-session
    // reviewer keys off the session owner. `resolveEffectiveEngineAndModel`
    // honors their per-user reviewer engine/model overrides, and the
    // session is owned by them below so the CLI uses their per-account
    // credentials. This stops a reviewer assigned a host-global engine
    // (e.g. Gemini) from being silently selected for someone else's push.
    //
    // When there's no pushing user (anonymous / break-glass push), there
    // are no per-account credentials to run under, so fall back to the
    // userless one-shot resolver, which only picks host-runnable engines.
    const pushedByUserId = opts.pushedByUserId ?? null;
    let engine: string;
    let model: string;
    if (pushedByUserId) {
      const resolved = resolveEffectiveEngineAndModel(deps.config, {
        agentId: reviewer.id,
        agentEngine: reviewer.engine || 'claude-code',
        agentModel: reviewer.model ?? null,
        ownerUserId: pushedByUserId,
      });
      engine = resolved.engine;
      model = resolved.model;
    } else {
      try {
        const resolved = await resolveOneShotEngine(deps.config, {
          preferred: reviewer.engine || 'claude-code',
          preferredModel: reviewer.model ?? null,
          userId: null,
        });
        engine = resolved.engine;
        model = resolved.model;
        if (resolved.fallbackUsed) {
          console.warn(
            `[auto-review] ${project.id} pr#${pr.number}: reviewer engine "${reviewer.engine || 'claude-code'}" unavailable (${resolved.fallbackFromReason}); using "${engine}".`,
          );
        }
      } catch (err: unknown) {
        if (err instanceof NoEnginesAvailableError) {
          console.warn(
            `[auto-review] ${project.id} pr#${pr.number}: no AI engine available for background review — ${err.message}`,
          );
          return;
        }
        throw err;
      }
    }
    const wt = defaultSessionUseWorktreeFlag(project);
    deps.stmts.createSession.run(
      sessionId,
      reviewer.id,
      `[Review PR #${pr.number}] external push @ ${headSha.slice(0, 8)}`.slice(0, 100),
      engine,
      model,
      wt,
      0,
      1,
    );
    // Attribute the session to the pushing user so the reviewer CLI spawns
    // under their per-account credentials (no-op when null).
    setSessionOwner(sessionId, pushedByUserId);

    const prompt =
      `## Review pull request #${pr.number} (external push)\n\n` +
      `New commits reached this Hub-hosted PR from outside a validated session, and this project's ` +
      `branch protection requires an approving review before merge. You are the project Reviewer — ` +
      `review the change and post your verdict.\n\n` +
      `### How to load the PR\n` +
      `- PR URL: ${prUrl} (head: \`${pr.head_branch}\` @ ${headSha})\n` +
      `- Diff: \`curl -s "$AGENT_HUB_URL/api/pr/diff?prUrl=${encodeURIComponent(prUrl)}" -H "X-API-Key: $AGENT_HUB_API_KEY"\`\n` +
      `- Detail (description, comments, checks): \`.../api/pr/data?prUrl=...\` the same way.\n` +
      `- Your worktree has the repo checked out — read surrounding code for context. ` +
      `\`git fetch origin ${pr.head_branch}\` if you need the head commits locally.\n\n` +
      `### How to post your verdict (REQUIRED last step)\n` +
      `POST \`$AGENT_HUB_URL/api/projects/${project.id}/pulls/${pr.number}/reviews\` with ` +
      `\`X-API-Key: $AGENT_HUB_API_KEY\` and JSON body:\n` +
      `\`{"state": "approved" | "changes_requested", "body": "<your findings>", "reviewer": ${JSON.stringify(reviewer.name)}}\`\n\n` +
      `Use your severity rubric: blocking findings (7+) → changes_requested with file:line specifics; ` +
      `otherwise approved (non-blocking notes welcome in the body). You are READ-ONLY: never edit ` +
      `code, never push, never merge.`;

    deps.stmts.insertBackgroundTask.run(taskId, sessionId, reviewer.id, prompt);
    deps.handleChat(null, {
      type: 'chat',
      agentId: reviewer.id,
      sessionId,
      content: prompt,
    });
    deps.broadcast({
      type: 'pr_auto_review_started',
      projectId: project.id,
      prNumber: pr.number,
      sessionId,
      headSha,
    });
    console.log(
      `[auto-review] ${project.id} pr#${pr.number} @ ${headSha.slice(0, 8)}: reviewer session ${sessionId} dispatched`,
    );
  } catch (err: unknown) {
    console.warn(
      `[auto-review] ${project.id} pr#${pr.number}: dispatch failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
