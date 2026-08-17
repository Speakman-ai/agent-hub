/**
 * Hard wall-clock cap for Hub-owned background shells.
 *
 * These shells exist so work can outlive a chat turn. They must not outlive
 * a session indefinitely — a multi-hour rclone / crawl / migrate parked in
 * `bg.sh` is how sessions end up "running in the background forever." The
 * Hub stops the process group at this cap and wakes the session with
 * `timed_out` so the agent can inspect durable progress and start the next
 * slice. Shorter caps are allowed; longer ones are clamped.
 */

/** Default and maximum runtime. 30 minutes. */
export const BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** Agents cannot request a cap above the default. */
export const BACKGROUND_SHELL_MAX_TIMEOUT_MS = BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS;

/**
 * Clamp a requested timeout to `(0, MAX]`. The contract requires an INTEGER
 * millisecond count, so non-integer / non-numeric / non-positive values fall
 * back to the default rather than disabling the cap. A fractional value such as
 * `1.5` is a malformed request, not "1.5 ms of intent" — flooring it to a
 * near-instant 1 ms cap would kill the shell immediately, so we default it.
 */
export function clampBackgroundShellTimeoutMs(requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isInteger(requested)) {
    return BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS;
  }
  if (requested < 1) return BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS;
  return Math.min(requested, BACKGROUND_SHELL_MAX_TIMEOUT_MS);
}

/** Human label for wake/prompt copy ("30-minute", "5-second"). */
export function formatBackgroundShellTimeoutCap(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    return minutes === 1 ? '1-minute' : `${minutes}-minute`;
  }
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds === 1 ? '1-second' : `${seconds}-second`;
}
