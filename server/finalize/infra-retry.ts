/**
 * infra-retry.ts — Finalize Code Changes, §10 failure classifier + one
 * auto-retry orchestration.
 *
 * Single source of truth for the §10 distinction between **CI-class** and
 * **infra-class** failures. The orchestrator drives every infra-class
 * terminal through this module so the retry policy lives in exactly one
 * place: infra-class failures get **one** automatic retry; CI-class
 * failures never auto-retry (the fix-dispatch loop handles them).
 *
 * Whitelists are EXPLICIT — an unknown `failure_reason` is never treated
 * as infra. If a new infra-class code lands, add it to
 * {@link INFRA_FAILURE_REASONS}; otherwise auto-retry will silently miss
 * it. The classifier deliberately does not fall back to "assume infra"
 * because that would hide novel CI failures behind a spurious retry.
 *
 * Retry semantics (§10 + §13):
 *
 *   - First infra failure: a new `finalize_runs` row is opened with
 *     `retry_of_run_id` set to the original. The retry inherits the
 *     family budget via {@link getRunFamilyActiveSeconds} from
 *     `./budget.ts` — it does NOT get a fresh 60-minute window.
 *   - Second infra failure: the retry row is terminal `infra_error`, and
 *     {@link postInfraTerminalMessage} drops a system message into the
 *     originating session with the machine code, the error string, and
 *     an escalation hint. No GitHub check-run, no PR comment — this is a
 *     pre-PR pipeline.
 *
 * The retry row uses a distinct {@link computeRetryIdempotencyKey} so the
 * original's `idempotency_key` UNIQUE constraint is preserved. A
 * re-trigger of Finalize against the same (project, branch, head_sha)
 * while either row is in-flight still de-duplicates via the orchestrator's
 * `getFinalizeRunByIdempotencyKey` short-circuit on the original row.
 */
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type { BroadcastFn, FinalizeRunRow, Stmts } from '../types.js';

// ─── Classifier ───────────────────────────────────────────────────────

/**
 * Failure-reason codes that classify as **CI**. These are the codes
 * the orchestrator and phase modules emit for outcomes that reflect the
 * change set itself (a step failed, the reviewer asked for changes, the
 * config was invalid, the budget tripped). The fix-dispatch loop handles
 * the first two; the rest are terminal-class on their own and never
 * auto-retry.
 *
 * The list is the union of every code currently produced by phase
 * modules + the orchestrator's own terminal codes. If a new code lands
 * that is NOT infra, add it here so {@link classifyFailureReason}
 * recognises it explicitly rather than returning `'unknown'`.
 */
export const CI_FAILURE_REASONS = [
  // §10 canonical CI-class codes
  'step_failed',
  'reviewer_changes_requested',
  'rebase_aborted',
  'ci_config_invalid',
  'timeout',
  'stalled_no_response',
  // Phase-module CI-class codes
  'review_failed',
  'unsafe_base_branch',
  'no_worktree',
  'no_diff_inputs',
  // Orchestrator-only terminal codes
  'max_fix_iterations',
  'fix_no_progress',
  'combined_gate_invariant_violated',
  'cancelled',
] as const;

/**
 * Failure-reason codes that classify as **infra**. These are the only
 * codes that trigger the one-auto-retry path. The list is intentionally
 * narrow:
 *
 *   - `worktree_create_failed` — the orchestrator could not spawn a
 *     session / could not stand up a worktree the run could push from.
 *   - `container_unavailable` — a sandbox / container / child-process
 *     environment that the orchestrator depends on was unreachable.
 *     Includes phase modules that threw (rebase, reviewer, step runner,
 *     fix-dispatch) when the throw was an infrastructural rather than a
 *     CI failure.
 *   - `github_push_5xx` — the final push step hit a transient GitHub
 *     5xx, an empty `pr_url`, or persisting the pr_url to the row
 *     failed.
 *
 * Do NOT broaden this list without updating §10 of the architecture
 * doc. Auto-retrying CI-class codes would hide real test failures
 * behind a duplicate run.
 *
 * **Dep idempotency contract.** The retry path inherits whatever the
 * parent attempt resolved (session_id + worktree_path are read from
 * the parent's row and passed to the retry's `driveAttempt`). The
 * orchestrator itself does NOT mutate session state between attempts.
 * This means the correctness of `worktree_create_failed` retry depends
 * on the injected `spawnSession` dep being idempotent across calls:
 *
 *   - If `spawnSession` is purely transient-failure (network blip,
 *     temp disk pressure), retry succeeds and the run continues.
 *   - If `spawnSession` is deterministic-failure (bad git config on
 *     the card), retry fails the same way → terminal infra_error +
 *     session message. No harm.
 *   - If `spawnSession`'s implementation has a side effect that makes
 *     a subsequent call fail differently (e.g. it disables a feature
 *     flag on first failure), THAT dep's wiring is wrong; the retry
 *     can no longer assume "second call sees the same world as
 *     first." Production callers wiring `spawnSession` MUST keep the
 *     dep idempotent or remove `worktree_create_failed` from this
 *     list. See PR #1174 review for the prior art (webhook-worker's
 *     `handleWorktreeFailure` cleared `use_worktree=0` between
 *     attempts — exactly the side effect that would defeat a retry).
 */
export const INFRA_FAILURE_REASONS = [
  'worktree_create_failed',
  'container_unavailable',
  'github_push_5xx',
  // A known-transient Spot reclaim: the runner instance was interrupted by
  // EC2 (2-minute notice → instance killed → lease expired → reaper marks
  // the job lost). Distinct from `container_unavailable` (which may be a
  // deterministic environment failure) so reclaims can earn a more generous
  // retry-generation allowance — see {@link resolveRetryGenerationCap}.
  'spot_reclaimed',
] as const;

/**
 * The subset of infra-class reasons that are KNOWN-transient reclaims (EC2
 * Spot interruption). These are the safest to retry aggressively because the
 * cause is external capacity reclamation, not anything about the change set or
 * a deterministic environment fault. They get the higher generation cap.
 */
export const RECLAIM_FAILURE_REASONS = ['spot_reclaimed'] as const;

export type CiFailureReason = (typeof CI_FAILURE_REASONS)[number];
export type InfraFailureReason = (typeof INFRA_FAILURE_REASONS)[number];
export type ReclaimFailureReason = (typeof RECLAIM_FAILURE_REASONS)[number];

/**
 * Is this failure_reason a known-transient Spot reclaim? Used by the
 * orchestrator's retry-generation policy and by budget.ts to decide that a
 * reclaim-aborted attempt's active time is non-billable.
 */
export function isReclaimFailureReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return (RECLAIM_FAILURE_REASONS as readonly string[]).includes(reason);
}

/**
 * Max retry generations (chained infra retries) by failure class. A
 * "generation" is the depth of the `retry_of_run_id` chain: the original run
 * is generation 0, its first retry generation 1, and so on. The cap is the
 * highest generation we will OPEN.
 *
 *   - Generic infra-class (`container_unavailable`, `worktree_create_failed`,
 *     `github_push_5xx`) → {@link MAX_INFRA_RETRY_GENERATIONS}. Raised from the
 *     historical hard cap of 1 to **2** so a run that loses its driving agent
 *     to back-to-back Spot reclaims (each surfacing as `container_unavailable`)
 *     still recovers instead of terminating green-code as `infra_error`.
 *   - Reclaim-class (`spot_reclaimed`) → {@link MAX_RECLAIM_RETRY_GENERATIONS}.
 *     Known-transient, so a more generous **3**.
 *
 * Both are env-overridable for ops tuning. The env is read at CALL time (not
 * module load) so a deploy — or a test — can tune the cap without re-importing.
 * Values below 1 are coerced to 1 (always allow at least the historical single
 * retry); a non-finite/empty env falls back to the default.
 */
export const DEFAULT_MAX_INFRA_RETRY_GENERATIONS = 2;
export const DEFAULT_MAX_RECLAIM_RETRY_GENERATIONS = 3;

/** Back-compat aliases for the default caps (dashboards / tests reference these). */
export const MAX_INFRA_RETRY_GENERATIONS = DEFAULT_MAX_INFRA_RETRY_GENERATIONS;
export const MAX_RECLAIM_RETRY_GENERATIONS = DEFAULT_MAX_RECLAIM_RETRY_GENERATIONS;

function readGenerationCap(envName: string, dflt: number): number {
  const raw = process.env[envName]?.trim();
  if (!raw) return dflt;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(1, n);
}

/**
 * The generation cap that applies to a given parent failure reason. Reclaims
 * get the generous cap; every other infra-class reason gets the conservative
 * one. (CI-class reasons never reach this — the orchestrator only calls the
 * retry path for infra-class terminals.) Reads the env live so ops/tests can
 * override without a re-import.
 */
export function resolveRetryGenerationCap(parentFailureReason: string | null | undefined): number {
  return isReclaimFailureReason(parentFailureReason)
    ? readGenerationCap(
        'FINALIZE_MAX_RECLAIM_RETRY_GENERATIONS',
        DEFAULT_MAX_RECLAIM_RETRY_GENERATIONS,
      )
    : readGenerationCap(
        'FINALIZE_MAX_INFRA_RETRY_GENERATIONS',
        DEFAULT_MAX_INFRA_RETRY_GENERATIONS,
      );
}

/**
 * Classification result. `'unknown'` is reserved for codes that escaped
 * both whitelists — the orchestrator treats `'unknown'` the same as
 * `'ci'` (no auto-retry), because a novel code is more likely a missed
 * CI failure than a missed infra one and silently retrying it could
 * hide a regression.
 */
export type FailureClass = 'ci' | 'infra' | 'unknown';

/**
 * Classify a `failure_reason` machine code against the explicit §10
 * whitelists.
 *
 * Returns:
 *   - `'infra'`  — code is in {@link INFRA_FAILURE_REASONS}.
 *   - `'ci'`     — code is in {@link CI_FAILURE_REASONS}.
 *   - `'unknown'` — code is in neither list. Callers MUST treat unknown
 *     as non-retryable.
 *
 * Pure / synchronous / no I/O. Safe to call from any thread of the
 * orchestrator state machine.
 */
export function classifyFailureReason(reason: string | null | undefined): FailureClass {
  if (!reason) return 'unknown';
  if ((INFRA_FAILURE_REASONS as readonly string[]).includes(reason)) return 'infra';
  if ((CI_FAILURE_REASONS as readonly string[]).includes(reason)) return 'ci';
  return 'unknown';
}

/**
 * Convenience: should the orchestrator open an auto-retry row for this
 * failure_reason? Equivalent to `classifyFailureReason(reason) === 'infra'`.
 *
 * The retry decision is gated on the failure class alone — whether the
 * run has *already* been retried is checked by the orchestrator against
 * `opts.retryOfRunId` BEFORE calling this helper. See
 * {@link openInfraRetryRun} for the policy.
 */
export function isInfraFailureReason(reason: string | null | undefined): boolean {
  return classifyFailureReason(reason) === 'infra';
}

// ─── Retry-row helpers ────────────────────────────────────────────────

/**
 * Compute the idempotency key for an infra-retry row. Distinct from the
 * original run's key (which is `sha256(project|branch|head_sha)`) so the
 * UNIQUE constraint on `finalize_runs.idempotency_key` lets us keep
 * BOTH rows alive: the original (with its terminal `infra_error`) and
 * the retry (in-flight or terminal).
 *
 * The parent run id is included so:
 *   - Each retry of a distinct parent gets a distinct key.
 *   - A second retry of the same parent (forbidden at v0, but defended
 *     against here) would still collide on the same key — the
 *     orchestrator's `getFinalizeRunByIdempotencyKey` short-circuit
 *     would then surface as `'reused'` instead of opening a third row.
 */
export function computeRetryIdempotencyKey(args: {
  projectId: string;
  branch: string;
  headSha: string;
  parentRunId: string;
}): string {
  return createHash('sha256')
    .update(`${args.projectId}|${args.branch}|${args.headSha}|retry:${args.parentRunId}`)
    .digest('hex');
}

/**
 * Hard ceiling on the `retry_of_run_id` chain walk. The generation caps are
 * small (2–3) so a healthy chain is short; this only bounds the walk against a
 * cyclic / corrupt `retry_of_run_id` column so the lookup can never spin.
 */
const MAX_RETRY_CHAIN_WALK = 32;

/**
 * Depth of a run in its `retry_of_run_id` chain: the original run is generation
 * 0, its first retry 1, and so on. Walks parents until it reaches a run with no
 * `retry_of_run_id` (or the safety bound). Defensive against a missing row
 * (treats it as chain end) so a half-written retry row never throws here.
 */
export function getRetryGenerationDepth(
  stmts: Pick<InfraRetryStmts, 'getFinalizeRun'>,
  runId: string,
): number {
  let depth = 0;
  let cursor: string | null = runId;
  const seen = new Set<string>();
  for (let i = 0; i < MAX_RETRY_CHAIN_WALK && cursor; i++) {
    if (seen.has(cursor)) break; // cycle guard
    seen.add(cursor);
    const row = stmts.getFinalizeRun.get(cursor) as FinalizeRunRow | undefined;
    const parentId = row?.retry_of_run_id ?? null;
    if (!parentId) break;
    depth++;
    cursor = parentId;
  }
  return depth;
}

/**
 * Statements the infra-retry module needs. A subset of {@link Stmts} so
 * callers can pass narrow dep bundles in tests.
 */
export type InfraRetryStmts = Pick<
  Stmts,
  | 'getFinalizeRun'
  | 'getFinalizeRunByIdempotencyKey'
  | 'insertFinalizeRun'
  | 'addMessage'
  | 'touchSession'
  | 'getMessageById'
>;

/**
 * Open the one infra-retry row for a failed parent run. Returns the new
 * runId on success, or `null` if the insert raced / collided / failed
 * (in which case the orchestrator surfaces the original failure as
 * terminal `infra_error` rather than crashing on the retry attempt).
 *
 * The retry row mirrors the parent's identifying tuple
 * `(card_id, project_id, branch, head_sha)` so subscribers can group it
 * with the parent in the UI. `session_id` and `worktree_path` are
 * copied from the parent — the session owns the worktree per §6, and
 * spawnSession does NOT re-fire on the retry (the session and worktree
 * already exist).
 *
 * Non-throwing: any DB or broadcast failure is logged via the optional
 * `log` sink and surfaced as `null`. The orchestrator's caller MUST
 * fall back to a terminal `infra_error` when this returns null.
 */
export function openInfraRetryRun(
  deps: {
    stmts: InfraRetryStmts;
    broadcast: BroadcastFn;
    newId?: () => string;
    now?: () => number;
    log?: (msg: string) => void;
  },
  args: {
    parentRunId: string;
    /**
     * Trigger source carried forward from the parent. Mirrored onto the
     * retry row so the UI keeps showing the original trigger surface
     * (ui_button vs agent_block) rather than inventing a synthetic
     * "retry" trigger.
     */
    triggerSource: 'ui_button' | 'agent_block';
    /**
     * The infra-class failure_reason of the parent attempt. Selects the
     * generation cap: reclaim-class (`spot_reclaimed`) earns the generous cap,
     * every other infra-class reason the conservative one. Optional for back-
     * compat; when omitted the conservative cap applies.
     */
    parentFailureReason?: string | null;
  },
): { runId: string } | null {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const newId = deps.newId ?? uuidv4;
  const now = deps.now ?? Date.now;
  let parent: FinalizeRunRow | undefined;
  try {
    parent = deps.stmts.getFinalizeRun.get(args.parentRunId) as FinalizeRunRow | undefined;
  } catch (err) {
    log(
      `[finalize-infra-retry] getFinalizeRun(parent=${args.parentRunId}) threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
  if (!parent) {
    log(`[finalize-infra-retry] parent run ${args.parentRunId} not found — refusing retry`);
    return null;
  }
  // Generation cap. The parent sits at generation `g` in the retry chain;
  // the retry we would open is generation `g + 1`. Refuse once that would
  // exceed the cap for the parent's failure class — reclaim-class earns a
  // more generous cap than generic infra. (At the default caps this means
  // generic infra survives one extra reclaim — two retries instead of the
  // historical one — and a known Spot reclaim survives two.)
  const parentGeneration = getRetryGenerationDepth(deps.stmts, args.parentRunId);
  const cap = resolveRetryGenerationCap(args.parentFailureReason);
  if (parentGeneration + 1 > cap) {
    log(
      `[finalize-infra-retry] parent run ${args.parentRunId} at generation ${parentGeneration} ` +
        `is at the retry cap (${cap}) for reason=${args.parentFailureReason ?? 'unknown'} — refusing further escalation`,
    );
    return null;
  }
  const retryIdempotencyKey = computeRetryIdempotencyKey({
    projectId: parent.project_id,
    branch: parent.branch,
    headSha: parent.head_sha,
    parentRunId: parent.id,
  });
  // Defensive: if a retry row for this parent already exists (e.g. an
  // earlier orchestrator pass already opened it), reuse its id rather
  // than racing on the UNIQUE constraint.
  try {
    const existing = deps.stmts.getFinalizeRunByIdempotencyKey.get(retryIdempotencyKey) as
      | FinalizeRunRow
      | undefined;
    if (existing) {
      log(
        `[finalize-infra-retry] retry row for parent=${args.parentRunId} already exists as ${existing.id}; reusing`,
      );
      return { runId: existing.id };
    }
  } catch {
    /* fall through to insert */
  }
  const runId = newId();
  const startedAt = now();
  try {
    deps.stmts.insertFinalizeRun.run(
      runId,
      parent.card_id,
      parent.session_id,
      parent.project_id,
      parent.branch,
      parent.head_sha,
      retryIdempotencyKey,
      'queued',
      null,
      args.triggerSource,
      parent.worktree_path,
      parent.triggered_by_user_id,
      parent.author_name,
      parent.author_email,
      parent.id,
      startedAt,
    );
  } catch (err) {
    log(
      `[finalize-infra-retry] insertFinalizeRun (retry of ${args.parentRunId}) threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
  try {
    deps.broadcast({
      type: 'finalize_run_created',
      run_id: runId,
      card_id: parent.card_id,
      session_id: parent.session_id ?? null,
      trigger_source: args.triggerSource,
    });
  } catch (err) {
    log(
      `[finalize-infra-retry] broadcast finalize_run_created (retry=${runId}) threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return { runId };
}

// ─── Terminal session message ─────────────────────────────────────────

/**
 * Header on the system message posted into the originating session when
 * a run trips the second consecutive infra failure. Locked to a
 * constant so tests, UI grep, and dashboards can identify the message.
 */
export const INFRA_TERMINAL_HEADER = 'Finalize Code Changes: infra failure on retry — run parked.';

/**
 * Compose the body of the terminal infra-error session message. Pure —
 * exposed for tests and for any future surface that wants to render the
 * same body inline.
 *
 * Carries the machine code, the human-readable detail, and the
 * escalation hint (no GitHub check-run, no PR comment — Finalize is a
 * pre-PR pipeline, so the recovery action is a human re-trigger).
 */
export function composeInfraTerminalMessageBody(args: {
  failureReason: string;
  detail?: string;
  parentRunId: string;
  retryRunId: string;
}): string {
  const lines: string[] = [];
  lines.push(INFRA_TERMINAL_HEADER);
  lines.push('');
  lines.push(`Failure code: \`${args.failureReason}\` (infra-class).`);
  if (args.detail) {
    lines.push('');
    lines.push(`Detail:`);
    lines.push(args.detail);
  }
  lines.push('');
  lines.push(
    `Original run \`${args.parentRunId}\` failed with the same code; the one automatic retry (run \`${args.retryRunId}\`) hit the same class of failure.`,
  );
  lines.push('');
  lines.push(
    'Re-trigger Finalize Code Changes when the underlying infrastructure recovers ' +
      '(worktree / sandbox / GitHub push availability). No PR or check-run will be ' +
      'opened on GitHub — Finalize runs entirely pre-PR.',
  );
  return lines.join('\n');
}

/**
 * Post the §10 terminal infra-error message into the originating
 * session. Best-effort — a DB or broadcast failure is logged and
 * swallowed so the orchestrator's terminal path can still complete
 * cleanly. The session keeps its worktree (the session owns the
 * worktree; the orchestrator never touches it on shutdown).
 *
 * The metadata blob includes `kind: 'finalize_infra_terminal'` so the
 * UI can render it as a system event distinct from the §13 timeout
 * message (`kind: 'finalize_timeout_dispatch'`).
 *
 * No-op when `sessionId` is null/empty — the §6 session-resolution path
 * may have produced no session if the very first phase (spawnSession)
 * was the infra failure; in that case there is no surface to post into,
 * and the orchestrator's caller surfaces the failure to the trigger
 * route directly.
 */
export function postInfraTerminalMessage(
  deps: {
    stmts: Pick<InfraRetryStmts, 'addMessage' | 'touchSession' | 'getMessageById'>;
    broadcast: BroadcastFn;
    log?: (msg: string) => void;
    newId?: () => string;
  },
  args: {
    parentRunId: string;
    retryRunId: string;
    sessionId: string | null;
    cardId: string;
    projectId: string;
    failureReason: string;
    detail?: string;
  },
): { messageId: string } | null {
  if (!args.sessionId) return null;
  const log = deps.log ?? ((m: string) => console.warn(m));
  const newId = deps.newId ?? uuidv4;
  const body = composeInfraTerminalMessageBody({
    failureReason: args.failureReason,
    detail: args.detail,
    parentRunId: args.parentRunId,
    retryRunId: args.retryRunId,
  });
  const messageId = newId();
  const metadata = JSON.stringify({
    kind: 'finalize_infra_terminal',
    parentRunId: args.parentRunId,
    retryRunId: args.retryRunId,
    cardId: args.cardId,
    projectId: args.projectId,
    failureReason: args.failureReason,
  });
  try {
    deps.stmts.addMessage.run(
      messageId,
      args.sessionId,
      'system',
      body,
      null,
      null,
      null,
      metadata,
      null,
      null,
      null,
    );
  } catch (err) {
    log(
      `[finalize-infra-retry] terminal message insert failed for retry=${args.retryRunId} session=${args.sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
  try {
    deps.stmts.touchSession.run(args.sessionId);
  } catch {
    /* best-effort */
  }
  try {
    const inserted = deps.stmts.getMessageById.get(messageId) as
      | { id: string; session_id: string }
      | undefined;
    if (inserted) {
      deps.broadcast({ type: 'message', sessionId: args.sessionId, message: inserted });
    }
  } catch (err) {
    log(
      `[finalize-infra-retry] terminal message broadcast failed for retry=${args.retryRunId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return { messageId };
}

/**
 * Marker re-exported for tests and dashboards: the only known infra
 * codes today. Add to {@link INFRA_FAILURE_REASONS} (not here) to
 * extend.
 */
export type KnownInfraFailureReason = InfraFailureReason;

/**
 * Identical convenience: re-export of CI-class codes so trigger routes
 * and the autonomous dispatcher can filter on them without importing
 * the union from every phase module.
 */
export type KnownCiFailureReason = CiFailureReason;

export const __test = {
  CI_FAILURE_REASONS,
  INFRA_FAILURE_REASONS,
  RECLAIM_FAILURE_REASONS,
  INFRA_TERMINAL_HEADER,
  MAX_INFRA_RETRY_GENERATIONS,
  MAX_RECLAIM_RETRY_GENERATIONS,
};
