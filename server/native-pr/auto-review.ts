/**
 * auto-review.ts — the review safety net for EXTERNAL commits.
 *
 * Agent Hub-originated work is reviewed inside its session (Finalize's
 * in-hub reviewer runs pre-push with the fix loop attached), and a
 * fully-validated head satisfies review policy via the passthrough.
 * Code that arrives on a PR head any other way — a laptop push over
 * smart-HTTP, a "push anyway", commits stacked after validation — lands
 * unreviewed. This dispatches the project Reviewer agent against every
 * unvalidated native PR head, whether or not branch protection requires
 * approval before merge.
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
import { failoverChainFor } from '../engine-failover.js';
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

/**
 * Outcome of a review-dispatch attempt. `dispatched` is true ONLY when a
 * reviewer session was actually created and handed to the engine — callers use
 * it to decide whether a pending state is real. Every no-op path (no reviewer,
 * unavailable engine, dedup, guard, error) returns `dispatched: false` with a
 * `reason`, so a caller never latches a "review requested" state that will
 * never produce a durable flag or verdict.
 */
export interface AutoReviewResult {
  dispatched: boolean;
  sessionId?: string;
  reason?: string;
}

/**
 * How long a durable agent-review claim stays authoritative before it is
 * treated as stale and reclaimable. This is the crash-recovery backstop: the
 * in-flight flag is normally released when the reviewer turn ends, but if the
 * server dies mid-review that in-memory release never runs, so the flag would
 * otherwise wedge the PR as "under review" forever. A claim older than this is
 * assumed dead and the next request may reclaim it. Defaults to 60 minutes —
 * longer than any real review turn (so a live review is never pre-empted), and
 * aligned with the Finalize dispatch's 60-minute budget backstop. Operators can
 * override with AGENT_REVIEW_CLAIM_TTL_MS.
 */
export function agentReviewClaimTtlMs(): number {
  const raw = Number(process.env.AGENT_REVIEW_CLAIM_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60 * 60 * 1000;
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
   * bypasses the Finalize-validated passthrough and the per-head-sha dedup — the
   * user explicitly asked for a fresh review even when the head was already
   * validated.
   */
  trigger?: 'pr_create' | 'head_update' | 'manual_request';
}

/** Hub user whose credentials and model preferences the review uses. */
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
): Promise<AutoReviewResult> {
  // Set to the owning session id once the atomic claim below succeeds, so the
  // catch can roll the claim back if anything throws synchronously after it.
  let claimedSessionId: string | null = null;
  try {
    if (process.env.AGENT_HUB_DISABLE_AUTO_REVIEW === '1' && !opts.force)
      return { dispatched: false, reason: 'disabled' };
    if (project.gitHost !== 'agenthub') return { dispatched: false, reason: 'not_hosted' };
    const manual = opts.trigger === 'manual_request';
    if (pr.status && pr.status !== 'open') return { dispatched: false, reason: 'not_open' };
    if (!hostedRepoExists(project.id)) return { dispatched: false, reason: 'repo_missing' };

    const reviewer = (project.agents || []).find((a) => a.role === 'reviewer');
    if (!reviewer) {
      console.warn(`[auto-review] ${project.id}: no reviewer agent exists — skipping`);
      return { dispatched: false, reason: 'no_reviewer' };
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
      return { dispatched: false, reason: 'finalize_locked' };
    }

    const repoPath = bareRepoPath(project.id);
    const headSha = await revParse(repoPath, `refs/heads/${pr.head_branch}`);
    if (!headSha) return { dispatched: false, reason: 'branch_gone' }; // branch gone

    // Session-validation passthrough: Finalize already reviewed this sha.
    // A manual request overrides this — the human asked for a fresh review.
    if (!manual && deps.stmts.getValidatedFinalizeRunForSha.get(project.id, headSha)) {
      return { dispatched: false, reason: 'already_validated' };
    }

    // Per-head-sha dedup keeps external-push triggers from re-dispatching. A
    // manual request is explicit intent and bypasses it (the human may want a
    // re-review of the same head), so it neither consults nor records the key.
    const key = `${project.id}#${pr.number}@${headSha}`;
    if (!manual) {
      if (dispatched.has(key)) return { dispatched: false, reason: 'deduped' };
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
      return { dispatched: false, reason: 'no_pusher' };
    }
    const preferredEngine = reviewer.engine || 'claude-code';

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
        `[auto-review] ${project.id} pr#${pr.number}: reviewer engine "${preferredEngine}" spawn env unavailable (${
          err instanceof Error ? err.message : String(err)
        }) — skipping`,
      );
      dispatched.delete(key);
      return { dispatched: false, reason: 'engine_env_unavailable' };
    }

    // Preflight the same ordered fallback chain used by regular sessions and
    // the Finalize reviewer. A native PR review used to probe only the shared
    // Reviewer assignment and skip the review entirely when that engine was
    // unavailable, even when the acting user had another authenticated CLI.
    // Probe with the same per-user env the eventual session spawn receives so
    // every candidate is evaluated against the correct HOME/credentials.
    let engine: SupportedEngine | null = null;
    let preferredUnavailableReason: string | null = null;
    if (isSupportedEngine(preferredEngine)) {
      for (const candidate of failoverChainFor(preferredEngine)) {
        const probe = await probeEngineAvailability(candidate, deps.config, {
          userId: actingUserId,
          env: reviewerSpawnEnv,
        });
        if (candidate === preferredEngine && !probe.available) {
          preferredUnavailableReason = probe.reason ?? 'unknown';
        }
        if (probe.available) {
          engine = candidate;
          break;
        }
      }
    }
    if (!engine) {
      console.warn(
        `[auto-review] ${project.id} pr#${pr.number}: reviewer engine "${preferredEngine}" and all fallback engines unavailable — skipping`,
      );
      dispatched.delete(key);
      return { dispatched: false, reason: 'engine_unavailable' };
    }
    if (engine !== preferredEngine) {
      console.warn(
        `[auto-review] ${project.id} pr#${pr.number}: reviewer engine "${preferredEngine}" unavailable (${preferredUnavailableReason ?? 'unknown'}); using fallback "${engine}"`,
      );
    }
    const model = resolveEffectiveModel(deps.config, engine, {
      // The shared Reviewer model belongs to the configured engine. Carrying
      // it onto a fallback can ask the replacement CLI for a model it does not
      // support, so fallback engines resolve their own per-user/default model.
      agentModel: engine === preferredEngine ? (reviewer.model ?? null) : null,
      ownerUserId: actingUserId,
      agentId: reviewer.id,
    });
    // Atomic dispatch guard: claim the in-flight slot BEFORE creating the
    // reviewer session. A manual request intentionally bypasses the in-memory
    // per-sha dedup above, so without this two clients (or repeated REST calls)
    // could both reach here and spawn concurrent Reviewer sessions for the same
    // PR. The conditional UPDATE (…WHERE agent_review_requested_at IS NULL) is
    // atomic on the single better-sqlite3 connection: exactly one caller sees
    // changes===1 and proceeds; the rest bail out as already-in-flight. The
    // claim records the owning sessionId so only this dispatch can later release
    // it (rollback on failure) without clobbering a newer claim.
    const claimNow = Date.now();
    const staleCutoff = claimNow - agentReviewClaimTtlMs();
    const claim = deps.stmts.claimPullRequestAgentReview.run(
      claimNow,
      sessionId,
      claimNow,
      project.id,
      pr.number,
      staleCutoff,
    );
    if (claim.changes === 1) {
      // We won the claim — this dispatch owns the in-flight flag and may release it.
      claimedSessionId = sessionId;
    } else {
      // changes===0 means either a review is genuinely in flight, or there is no
      // persisted PR row yet to claim. Distinguish so we only block on the former.
      const existing = deps.stmts.getPullRequestByNumber.get(project.id, pr.number) as
        | { agent_review_requested_at: number | null }
        | undefined;
      if (existing && existing.agent_review_requested_at != null) {
        // Another review is already in flight. Release the per-sha dedup key we
        // may have added so a later attempt can run once this one resolves.
        if (!manual) dispatched.delete(key);
        console.log(
          `[auto-review] ${project.id} pr#${pr.number}: a review is already in flight — skipping`,
        );
        return { dispatched: false, reason: 'already_in_flight' };
      }
      // No persisted PR row to guard — proceed without the durable claim,
      // preserving legacy dispatch behavior (the flag is a no-op without a row).
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
        `New commits reached this Hub-hosted PR from outside a validated session. Agent Hub reviews ` +
        `every unvalidated PR head, even when approval is not required to merge. You are the project ` +
        `Reviewer — review the change and post your verdict.\n\n`;
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
      `\`X-API-Key: $AGENT_HUB_API_KEY\`, the header \`X-Agent-Hub-Session-Id: ${sessionId}\` ` +
      `(this is your review session — it must be sent verbatim so your verdict resolves the ` +
      `pending review), and JSON body:\n` +
      `\`{"state": "approved" | "changes_requested", "body": "<your findings>", "reviewer": ${JSON.stringify(reviewer.name)}}\`\n\n` +
      `Use your severity rubric: any finding scoring > 3 is a BLOCKER → changes_requested with ` +
      `file:line specifics — and an acceptance criterion the change does not fully deliver scores > 3, ` +
      `even when the card is titled \`[Partial]\` or names a follow-up. Otherwise approved (non-blocking ` +
      `notes welcome in the body). You are READ-ONLY: never edit code, never push, never merge.`;

    deps.stmts.insertBackgroundTask.run(taskId, sessionId, reviewer.id, prompt);
    // The durable in-flight flag was already set by the atomic claim above.
    // Hand off to the reviewer turn. handleChat is fire-and-forget, but we attach
    // a terminal resolver: whether the turn rejects (spawn/handoff failure) or
    // simply ends without a verdict, releasePullRequestAgentReviewBySession
    // rolls the claim back so the PR does not stay marked "under review" with no
    // review running. It is session-scoped, so a normal verdict (which already
    // cleared+nulled the session) or a newer claim is left untouched. Wrapping in
    // Promise.resolve keeps a synchronous throw from handleChat propagating to the
    // outer catch (which also releases), while a returned promise settles here.
    const releaseClaim = (): void => {
      const released = deps.stmts.releasePullRequestAgentReviewBySession.run(
        Date.now(),
        project.id,
        pr.number,
        sessionId,
      );
      if (released.changes > 0) {
        deps.broadcast({
          type: 'native_pr_update',
          projectId: project.id,
          prNumber: pr.number,
          action: 'agent_review_request_cleared',
        });
      }
    };
    void Promise.resolve(
      deps.handleChat(null, {
        type: 'chat',
        agentId: reviewer.id,
        sessionId,
        content: prompt,
      }),
    )
      .catch((err: unknown) => {
        console.warn(
          `[auto-review] ${project.id} pr#${pr.number}: reviewer turn failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      })
      .finally(releaseClaim);
    deps.broadcast({
      type: 'pr_auto_review_started',
      projectId: project.id,
      prNumber: pr.number,
      sessionId,
      headSha,
    });
    // Nudge connected clients to refresh the PR so the durable pending flag
    // surfaces immediately (the list/detail payloads derive agent_review_requested).
    deps.broadcast({
      type: 'native_pr_update',
      projectId: project.id,
      prNumber: pr.number,
      action: 'agent_review_requested',
    });
    console.log(
      `[auto-review] ${project.id} pr#${pr.number} @ ${headSha.slice(0, 8)}: reviewer session ${sessionId} dispatched`,
    );
    return { dispatched: true, sessionId };
  } catch (err: unknown) {
    console.warn(
      `[auto-review] ${project.id} pr#${pr.number}: dispatch failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // A synchronous failure after we won the claim (e.g. handleChat throwing
    // before returning a promise) must roll the in-flight flag back, or the PR
    // stays marked under review forever. Session-scoped, so it only clears our
    // own claim.
    if (claimedSessionId) {
      try {
        deps.stmts.releasePullRequestAgentReviewBySession.run(
          Date.now(),
          project.id,
          pr.number,
          claimedSessionId,
        );
        deps.broadcast({
          type: 'native_pr_update',
          projectId: project.id,
          prNumber: pr.number,
          action: 'agent_review_request_cleared',
        });
      } catch {
        /* best-effort rollback */
      }
    }
    return { dispatched: false, reason: 'error' };
  }
}
