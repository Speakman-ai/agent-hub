import type { FailoverTrigger } from '../engine-failover.js';

/**
 * Human-readable phrase for each failover trigger, used in the user-facing
 * stall notice so the message names the actual infra cause.
 */
export function reviewerStallCauseLabel(trigger: FailoverTrigger): string {
  switch (trigger) {
    case 'usage-exhausted':
      return 'the reviewer engine (and every fallback) is out of usage/quota';
    case 'engine-auth':
      return 'the reviewer engine (and every fallback) failed to authenticate';
    case 'transient-exhausted':
      return 'the reviewer turn kept timing out and no fallback engine was available';
    default:
      return 'the reviewer turn could not complete on any available engine';
  }
}

/**
 * Thrown by the in-session reviewer driver when a reviewer turn could NOT
 * complete for an INFRASTRUCTURE reason — a per-turn timeout, an engine API
 * error, or provider quota/auth exhaustion — AND the failover chain is spent
 * (no other authenticated engine to retry on).
 *
 * This is deliberately distinct from a reviewer that RAN and produced an
 * unparseable / malformed / empty verdict (a genuine review failure). A stall
 * is not a code problem, so the orchestrator parks the run as `review_stalled`
 * (status `infra_error`) with a user-facing notice instead of the
 * code-implying `review_failed` — which used to make an infra outage look like
 * the agent failing to converge.
 */
export class ReviewerInfraStallError extends Error {
  readonly trigger: FailoverTrigger;
  /** The underlying engine error this stall wraps. */
  readonly originalError: unknown;

  constructor(originalError: unknown, trigger: FailoverTrigger) {
    const detail = originalError instanceof Error ? originalError.message : String(originalError);
    super(`reviewer turn stalled on infrastructure (${trigger}): ${detail}`);
    this.name = 'ReviewerInfraStallError';
    this.trigger = trigger;
    this.originalError = originalError;
  }
}

/** Narrowing guard for {@link ReviewerInfraStallError}. */
export function isReviewerInfraStallError(err: unknown): err is ReviewerInfraStallError {
  return err instanceof ReviewerInfraStallError;
}
