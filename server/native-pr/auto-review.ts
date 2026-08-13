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
import {
  probeEngineAvailability,
  ALL_SUPPORTED_ENGINES,
  type SupportedEngine,
} from '../engine-availability.js';
import { resolveEffectiveModel } from '../effective-model.js';
import { resolveSessionCliSpawnEnv } from '../per-user-cli-spawn.js';
import { setSessionOwner } from '../session-ownership.js';
import { isKnownHubUserId } from './author-user.js';
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
   * credentials — mirroring the Finalize in-session reviewer. On head updates,
   * this must be present; falling back to the PR author would run reviewer
   * code for pusher-controlled content under another user's credentials.
   */
  pushedByUserId?: string | null;
  /**
   * Why this auto-review is being considered. PR creation and an explicit
   * manual "Request review" press are the flows allowed to fall back to
   * `pr.author` when receive-pack attribution is unavailable — the content is
   * being reviewed on the author's behalf, not for a pusher-attributed head
   * update. Head updates require `pushedByUserId`.
   *
   * `manual_request` is the human pressing "Request review" in the PR UI. It
   * bypasses the branch-protection `requiredReview` gate, the Finalize-validated
   * passthrough, and the per-head-sha dedup — the user explicitly asked for a
   * review even when the gate is off or the head was already validated.
   */
  trigger?: 'pr_create' | 'head_update' | 'manual_request';
}

/** Hub user to run the review as — never falls back to a different engine. */
function resolveAutoReviewActingUser(
  opts: AutoReviewOpts,
  pr: Pick<PullRequestRow, 'author'>,
): string | null {
  const pushed = opts.pushedByUserId?.trim();
  if (pushed) return pushed;
  if (opts.trigger !== 'pr_create' && opts.trigger !== 'manual_request') return null;
  const author = pr.author?.trim();
  if (author && isKnownHubUserId(author)) return author;
  return null;
}

function isSupportedEngine(value: string): value is SupportedEngine {
  return (ALL_SUPPORTED_ENGINES as readonly string[]).includes(value);
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
  pr: Pick<PullRequestRow, 'number' | 'head_branch' | 'status' | 'author'>,
  deps: AutoReviewDeps,
  opts: AutoReviewOpts = {},
): Promise<void> {
  try {
    if (process.env.AGENT_HUB_DISABLE_AUTO_REVIEW === '1' && !opts.force) return;
    if (project.gitHost !== 'agenthub') return;
    const manual = opts.trigger === 'manual_request';
    // Option-1 gating: auto-review exists to keep the required-review
    // gate flowing for external pushes; without the gate it's not needed.
    // A manual "Request review" press is explicit human intent, so it runs
    // regardless of whether branch protection requires a review.
    if (!manual && project.branchProtection?.requiredReview !== true) return;
    if (pr.status && pr.status !== 'open') return;
    if (!hostedRepoExists(project.id)) return;

    const reviewer = (project.agents || []).find((a) => a.role === 'reviewer');
    if (!reviewer) {
      console.warn(
        `[auto-review] ${project.id}: requiredReview is on but no reviewer agent exists — skipping`,
      );
      return;
    }

    // Post-Finalize-push lock: if this PR already shipped through Finalize, the
    // pushing session is terminal (lockSessionAfterFinalizePush set ask_mode=1
    // and finalize_automation='manual') and its pre-push in-hub reviewer verdict
    // is authoritative. Dispatching another review here would re-open an
    // already-shipped, locked session. Keyed on the PR (not the head sha) so it
    // stays correct across a Finalize rebase-before-push, which mints a new sha
    // the sha-exact passthrough below would miss. A manual "Request review" is
    // explicit human intent and overrides this.
    if (
      !manual &&
      deps.stmts.getPushedFinalizeRunForProjectPrUrl.get(
        project.id,
        buildNativePrUrl(project.id, pr.number),
      )
    ) {
      return;
    }

    const repoPath = bareRepoPath(project.id);
    const headSha = await revParse(repoPath, `refs/heads/${pr.head_branch}`);
    if (!headSha) return; // branch gone

    // Session-validation passthrough: Finalize already reviewed this sha.
    // A manual request overrides this — the human asked for a fresh review.
    if (!manual && deps.stmts.getValidatedFinalizeRunForSha.get(project.id, headSha)) {
      return;
    }

    // Per-head-sha dedup keeps external-push triggers from re-dispatching. A
    // manual request is explicit intent and bypasses it (the human may want a
    // re-review of the same head), so it neither consults nor records the key.
    const key = `${project.id}#${pr.number}@${headSha}`;
    if (!manual) {
      if (dispatched.has(key)) return;
      dispatched.add(key);
    }

    const prUrl = buildNativePrUrl(project.id, pr.number);
    const sessionId = uuidv4();
    const taskId = uuidv4();

    // Resolve the engine/model the review runs on — always the Reviewer agent's
    // shared engine assignment plus the acting user's model pick. Reviewer
    // agents are hidden from personal Agents settings, so an old per-user
    // engine override can be stale and must not shadow the visible Reviewer
    // setting. Matches Finalize's in-session reviewer: never substitute a
    // host-global or legacy personal engine when Codex is configured here.
    const trigger = opts.trigger ?? 'head_update';
    const actingUserId = resolveAutoReviewActingUser(opts, pr);
    if (trigger === 'head_update' && !actingUserId) {
      console.warn(
        `[auto-review] ${project.id} pr#${pr.number}: head update has no attributed Hub pusher — skipping`,
      );
      dispatched.delete(key);
      return;
    }
    const engine = reviewer.engine || 'claude-code';
    const model = resolveEffectiveModel(deps.config, engine, {
      agentModel: reviewer.model ?? null,
      ownerUserId: actingUserId,
      agentId: reviewer.id,
    });

    // Resolve the SAME per-user spawn env handleChat will build for the owned
    // reviewer session — HOME pinned to the acting user's per-user tree and
    // their stored keys injected — and probe against it. Probing with a bare
    // `process.env` reads the host HOME and host config, not the per-user spawn
    // environment, so a reviewer authenticated only through their own login
    // could be pre-skipped as `no-credentials` even though the subsequent spawn
    // would have authenticated. Most visibly this bites `gemini-cli`, whose
    // probe checks `env.GEMINI_API_KEY` — a key that lives in the user's spawn
    // override, not `process.env`. (For the strictly per-account engines —
    // Claude/Cursor/Codex/Grok — the probe already resolves the per-user HOME
    // OAuth cache from `userId` + `dataDir` via `userHasEngineCreds`; passing
    // the env keeps HOME parity explicit and future-proof.)
    //
    // `engine: undefined` resolves the env without the per-account hard-fail
    // (the documented "engine not known yet" path): the probe below remains the
    // single availability gate. `sessionId: null` keeps this a pure read — no
    // spawn-creds are minted for a session we may not end up creating.
    let reviewerSpawnEnv: NodeJS.ProcessEnv;
    try {
      reviewerSpawnEnv = resolveSessionCliSpawnEnv({
        cfg: deps.config,
        ownerId: actingUserId,
        credsOwnerId: actingUserId,
        sessionId: null,
        engine: undefined,
      });
    } catch (err: unknown) {
      console.warn(
        `[auto-review] ${project.id} pr#${pr.number}: reviewer engine "${engine}" spawn env unavailable (${
          err instanceof Error ? err.message : String(err)
        }) — skipping`,
      );
      dispatched.delete(key);
      return;
    }

    if (isSupportedEngine(engine)) {
      const probe = await probeEngineAvailability(engine, deps.config, {
        userId: actingUserId,
        env: reviewerSpawnEnv,
      });
      if (!probe.available) {
        console.warn(
          `[auto-review] ${project.id} pr#${pr.number}: reviewer engine "${engine}" unavailable (${probe.reason ?? 'unknown'}) — skipping`,
        );
        dispatched.delete(key);
        return;
      }
    }
    const sessionName = manual
      ? `[Review PR #${pr.number}] requested @ ${headSha.slice(0, 8)}`.slice(0, 100)
      : `[Review PR #${pr.number}] external push @ ${headSha.slice(0, 8)}`.slice(0, 100);
    const wt = defaultSessionUseWorktreeFlag(project);
    deps.stmts.createSession.run(sessionId, reviewer.id, sessionName, engine, model, wt, 0, 1);
    // Attribute the session to the acting user so the reviewer CLI spawns
    // under their per-account credentials (no-op when null).
    setSessionOwner(sessionId, actingUserId);

    const promptHeader = manual
      ? `## Review pull request #${pr.number} (review requested)\n\n` +
        `A human pressed "Request review" on this Hub-hosted PR. You are the project Reviewer — ` +
        `review the change and post your verdict.\n\n`
      : `## Review pull request #${pr.number} (external push)\n\n` +
        `New commits reached this Hub-hosted PR from outside a validated session, and this project's ` +
        `branch protection requires an approving review before merge. You are the project Reviewer — ` +
        `review the change and post your verdict.\n\n`;
    const prompt =
      promptHeader +
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
      `Use your severity rubric: any finding scoring > 3 is a BLOCKER → changes_requested with ` +
      `file:line specifics; otherwise approved (non-blocking notes welcome in the body). You are ` +
      `READ-ONLY: never edit code, never push, never merge.`;

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
