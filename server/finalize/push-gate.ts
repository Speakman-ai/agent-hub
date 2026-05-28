/**
 * push-gate.ts — Finalize Code Changes §9 push gate.
 *
 * Pure, synchronous evaluation of the three conditions that must hold
 * before the orchestrator pushes a branch + opens a PR (per design doc
 * `finalize-code-changes-architecture-v0`, §9):
 *
 *   1. Every declared step exited 0 on the **current** `head_sha`.
 *   2. Reviewer verdict on the **current** `head_sha` is `approved`.
 *   3. No new commits landed since the green-and-approved point —
 *      i.e. `latest_green_sha == latest_approved_sha == head_sha`.
 *
 * Loop invariant (§3): every fix dispatch re-enters from rebase, so the
 * reviewer + step signals captured in this gate are always taken from
 * the iteration the gate runs in. The orchestrator does not need to
 * thread "this was the green sha" / "this was the approved sha"
 * separately — they are necessarily the same sha within a single loop
 * iteration. The third condition collapses to a single comparison:
 * `headBeforePhases == headAtPushGate`.
 *
 * Why pure: extracting the gate from the orchestrator lets us cover the
 * 2³ truth-table of `(stepsGreen, reviewerApproved, headStable)` in
 * isolation, without spinning up the full state machine. The orchestrator
 * still owns the side-effects (broadcasts, fail/terminate writes); this
 * module owns *only* the decision and the explanatory failure code.
 *
 * Non-throwing: the gate never throws. The only failure modes are the
 * three condition refusals; head-resolution failures (e.g. `git rev-parse`
 * crashing) are surfaced by the orchestrator's I/O layer, not here.
 */

import type { ReviewerVerdict } from './reviewer-dispatch.js';

// ─── Public types ─────────────────────────────────────────────────────

/**
 * The signals the gate decides on. The orchestrator captures these
 * inside a single loop iteration and hands them to {@link evaluatePushGate};
 * the loop invariant guarantees they belong to the same head.
 */
export interface PushGateInputs {
  /** Status the step runner reported for this iteration. */
  stepStatus: 'success' | 'failure' | 'timeout' | 'infra_error';
  /**
   * Verdict the reviewer agent returned for this iteration. `null`
   * means the reviewer phase did not produce a verdict (treated as a
   * gate refusal — we never push without an explicit approval).
   */
  reviewerVerdict: ReviewerVerdict | null;
  /**
   * Worktree HEAD captured **immediately after** the rebase phase
   * succeeded, i.e. the sha the reviewer + steps were run against. The
   * orchestrator MUST capture this AFTER rebase: rebase may rewrite
   * every local sha, and comparing against the pre-rebase / trigger-time
   * sha would refuse forever on the first pass after any upstream move.
   */
  headBeforePhases: string;
  /**
   * Worktree HEAD read again immediately before the push step. If the
   * session committed an extra fix or a human pushed during the review/
   * step phases, this will differ from {@link headBeforePhases} and the
   * gate refuses.
   */
  headAtPushGate: string;
}

/**
 * Outcome of one gate evaluation. `kind: 'pass'` carries the validated
 * sha so the orchestrator can forward it to the push step (the sha the
 * reviewer approved + steps ran green against, NOT the trigger-time sha).
 *
 * Each `'refuse'` carries a stable {@link refusalCode} that downstream
 * logging / dashboards can group on. The codes are *not* `failure_reason`
 * values from §10 — `head_sha_moved` is the only refusal that the
 * orchestrator currently turns into a *re-loop* rather than a terminal
 * failure, and the others (`steps_not_green`, `reviewer_not_approved`)
 * mean "go to fix dispatch", not "fail the run".
 */
export type PushGateOutcome =
  | {
      kind: 'pass';
      validatedHeadSha: string;
    }
  | {
      kind: 'refuse';
      refusalCode: PushGateRefusalCode;
      /** Human-readable reason, suitable for a log line. */
      detail: string;
    };

/**
 * Refusal codes are exhaustive over the three §9 conditions. The
 * orchestrator dispatches on these:
 *
 *   - `steps_not_green` / `reviewer_not_approved` → run the §6 fix
 *     dispatch path (talk to the session, await turn-end, re-enter
 *     rebase). The gate refusal is not a failure; the §10 codes
 *     `step_failed` / `reviewer_changes_requested` cover the *terminal*
 *     case where the fix loop eventually gives up.
 *   - `head_sha_moved` → re-enter the loop directly (no dispatch — the
 *     session already produced a new commit; we just need to re-validate
 *     against it).
 *   - `reviewer_verdict_missing` → defensive; the orchestrator should
 *     never reach the gate without a verdict from the reviewer phase.
 *     Surfaces as a refusal so the bug is loud instead of silent.
 */
export type PushGateRefusalCode =
  | 'steps_not_green'
  | 'reviewer_not_approved'
  | 'reviewer_verdict_missing'
  | 'head_sha_moved';

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Evaluate the §9 push gate against this iteration's signals.
 *
 * The check order is deliberate:
 *
 *   1. Step status — cheapest, no string compare.
 *   2. Reviewer verdict — same, plus we want a clear refusal when the
 *      reviewer crashed and left the verdict null.
 *   3. Head stability — last because the *content* of the head sha
 *      strings only matters once we know steps + reviewer agreed.
 *
 * Returning the validated sha on success makes the orchestrator's
 * downstream push call unambiguous — `pushAndCreatePr` receives the
 * exact sha that satisfied all three conditions, which is also the
 * value the production `git push --force-with-lease=<branch>:<sha>`
 * uses as the expected remote ref.
 *
 * @example
 *   const outcome = evaluatePushGate({
 *     stepStatus: 'success',
 *     reviewerVerdict: 'approved',
 *     headBeforePhases: 'abc',
 *     headAtPushGate: 'abc',
 *   });
 *   // → { kind: 'pass', validatedHeadSha: 'abc' }
 */
export function evaluatePushGate(inputs: PushGateInputs): PushGateOutcome {
  // ── §9 condition 1: every declared step exited 0 ───────────────────
  if (inputs.stepStatus !== 'success') {
    return {
      kind: 'refuse',
      refusalCode: 'steps_not_green',
      detail: `step status is "${inputs.stepStatus}"; only "success" passes the gate`,
    };
  }

  // ── §9 condition 2: reviewer approved ──────────────────────────────
  if (inputs.reviewerVerdict === null) {
    // Reviewer phase failed to produce a verdict. The orchestrator
    // shouldn't have called the gate in that case, but this branch
    // makes the invariant load-bearing instead of relying on caller
    // discipline.
    return {
      kind: 'refuse',
      refusalCode: 'reviewer_verdict_missing',
      detail: 'reviewer phase produced no verdict; gate cannot evaluate condition 2',
    };
  }
  if (inputs.reviewerVerdict !== 'approved') {
    return {
      kind: 'refuse',
      refusalCode: 'reviewer_not_approved',
      detail: `reviewer verdict is "${inputs.reviewerVerdict}"; only "approved" passes the gate`,
    };
  }

  // ── §9 condition 3: head_sha unchanged through review + steps ──────
  // Inside one loop iteration, headBeforePhases is the sha the reviewer
  // + steps actually validated. If headAtPushGate differs, a commit
  // landed *during* this iteration — the green + approved signals are
  // now stale and we refuse.
  if (inputs.headBeforePhases !== inputs.headAtPushGate) {
    return {
      kind: 'refuse',
      refusalCode: 'head_sha_moved',
      detail:
        `HEAD moved during validation pass: ${inputs.headBeforePhases} → ` +
        `${inputs.headAtPushGate}; reviewer + step signals are stale`,
    };
  }

  return { kind: 'pass', validatedHeadSha: inputs.headAtPushGate };
}

/**
 * Convenience: is the outcome a pass? Lets call-sites avoid `as` casts
 * when they only care about the boolean.
 */
export function isPushGatePass(
  outcome: PushGateOutcome,
): outcome is { kind: 'pass'; validatedHeadSha: string } {
  return outcome.kind === 'pass';
}
