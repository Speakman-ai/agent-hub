/**
 * Turn-end error classification + transient-retry planning.
 *
 * Motivation: an upstream API/stream error (e.g. "API Error: The socket
 * connection was closed unexpectedly") can kill an agent turn mid-task.
 * When the turn had already streamed some assistant text, `chat.ts`
 * historically treated the close as a successful turn end — so autonomous
 * sessions (finalize_automation review/push/merge) kicked off Finalize on a
 * half-finished worktree and could merge incomplete code.
 *
 * This module is the pure-logic seam for the fix:
 *   1. `resolveTurnEndError`   — did this turn actually end in an error?
 *   2. `isTransientTurnError`  — is it worth auto-retrying?
 *   3. `planTransientErrorRetry` — bounded retry schedule with backoff.
 *
 * The wiring lives in `chat.ts` (record `sessions.last_turn_error`, schedule
 * the retry/continuation) and `finalize/automation-runner.ts` (refuse to
 * auto-start/auto-push Finalize while `last_turn_error` is set).
 */

export interface TurnEndErrorInput {
  /** CLI process exit code (`null` when killed by signal). */
  exitCode: number | null;
  /** Signal that terminated the process, if any. */
  signal: NodeJS.Signals | null;
  /**
   * Upstream error text captured from the stdout JSONL stream — a `result`
   * event with `isError: true` (claude/codex) or a `codex error:` line.
   */
  streamErrorMessage: string;
  /** Engine label, used only to build a readable fallback message. */
  engine: string;
}

export interface TurnEndError {
  /** Human-readable error text (stream error preferred over exit code). */
  errorText: string;
}

/**
 * Decide whether a non-terminated turn close actually ended in an error.
 * Returns `null` for a clean close (exit 0, no upstream stream error).
 *
 * Note: callers must handle user-initiated termination (stop button /
 * interrupt) BEFORE calling this — a resolved termination is not an error.
 */
export function resolveTurnEndError(input: TurnEndErrorInput): TurnEndError | null {
  const stream = input.streamErrorMessage.trim();
  if (stream) return { errorText: stream };
  if (input.exitCode !== null && input.exitCode !== 0) {
    return { errorText: `${input.engine} exited with code ${input.exitCode}` };
  }
  if (input.exitCode === null && input.signal) {
    return { errorText: `${input.engine} terminated by signal ${input.signal}` };
  }
  return null;
}

/**
 * Errors that must never auto-retry: retrying cannot succeed (auth/billing/
 * context overflow) or would fight an intentional engine limit (max turns).
 * Checked BEFORE the transient patterns so e.g. "401 authentication_error"
 * is not laundered into a retry by the status-code matcher.
 */
const NON_TRANSIENT_PATTERNS: RegExp[] = [
  /max.?turns/i,
  /credit balance/i,
  /billing/i,
  /invalid (x-)?api.?key/i,
  /authentication|unauthorized|forbidden|permission.?denied/i,
  /\b(400|401|403|404|413|422)\b/,
  /prompt is too long|context (length|window)|input is too long/i,
  /content.?(policy|filter)/i,
];

/**
 * Transient upstream failures worth a bounded auto-retry. Modeled on what
 * the Anthropic/OpenAI gateways actually emit through the CLI stream:
 * socket drops, 5xx/overloaded, rate limits, DNS/timeout blips.
 */
const TRANSIENT_PATTERNS: RegExp[] = [
  /socket connection (was )?closed/i,
  /socket hang ?up/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENETUNREACH|EAI_AGAIN|ENOTFOUND/,
  /fetch failed/i,
  /network (error|issue)/i,
  /connection (error|reset|closed|aborted|terminated|refused)/i,
  /stream (was )?(closed|disconnected|interrupted|ended unexpectedly)/i,
  /\b(429|500|502|503|504|529)\b/,
  /overloaded/i,
  /rate.?limit/i,
  /internal server error/i,
  /request timed?.?out|timeout/i,
  /server (is )?(busy|unavailable)/i,
];

export function isTransientTurnError(errorText: string): boolean {
  const text = errorText.trim();
  if (!text) return false;
  if (NON_TRANSIENT_PATTERNS.some((p) => p.test(text))) return false;
  return TRANSIENT_PATTERNS.some((p) => p.test(text));
}

/** Max auto-retries per turn chain (attempt counter travels on the message). */
export const TRANSIENT_TURN_ERROR_MAX_RETRIES = 2;

/** Backoff per attempt index (0-based). */
const RETRY_DELAYS_MS = [2_000, 10_000];

export interface TransientRetryPlan {
  retry: boolean;
  delayMs: number;
}

/**
 * Decide whether attempt N (0-based count of retries already performed)
 * should be retried, and after what delay.
 */
export function planTransientErrorRetry(
  retriesSoFar: number,
  errorText: string,
): TransientRetryPlan {
  if (retriesSoFar >= TRANSIENT_TURN_ERROR_MAX_RETRIES) return { retry: false, delayMs: 0 };
  if (!isTransientTurnError(errorText)) return { retry: false, delayMs: 0 };
  const delayMs = RETRY_DELAYS_MS[Math.min(retriesSoFar, RETRY_DELAYS_MS.length - 1)];
  return { retry: true, delayMs };
}

/**
 * Continuation prompt sent when a turn died AFTER streaming partial output.
 * The engine session is resumed (`--resume`), so the model sees its own
 * partial turn; this prompt tells it why a new turn started and to verify
 * in-flight work instead of assuming it completed.
 */
export function buildTurnErrorContinuationPrompt(errorText: string): string {
  return (
    `[Agent Hub auto-recovery] Your previous turn was interrupted by a transient engine/API error before it could finish:\n\n` +
    `> ${errorText}\n\n` +
    `Resume the task from where you left off. Treat any in-flight work as unverified: re-check the last file edits, re-run the last command if its outcome is unknown, and finish the remaining steps. Do not start over if the work is already done — verify, complete, then summarize.`
  );
}

/** System-message body shown in the transcript when a retry is scheduled. */
export function buildTransientRetryNotice(
  errorText: string,
  attempt: number,
  delayMs: number,
): string {
  return (
    `**Transient engine error — auto-retrying** (attempt ${attempt}/${TRANSIENT_TURN_ERROR_MAX_RETRIES}, in ${Math.round(delayMs / 1000)}s)\n\n` +
    `> ${errorText}\n\n` +
    `Finalize automation is paused for this session until a turn completes cleanly.`
  );
}

/** System-message body when retries are exhausted or the error is permanent. */
export function buildTurnErrorHaltNotice(errorText: string, retriesAttempted: number): string {
  const why =
    retriesAttempted > 0
      ? `Auto-retry gave up after ${retriesAttempted} attempt${retriesAttempted === 1 ? '' : 's'}.`
      : `This error is not auto-retryable.`;
  return (
    `**Turn ended in an error.** ${why}\n\n` +
    `> ${errorText}\n\n` +
    `Finalize automation (auto-review/push/merge) is blocked for this session until a turn completes cleanly or you run Finalize manually. Send a message to continue the work.`
  );
}
