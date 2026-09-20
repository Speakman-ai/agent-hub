/** Zero means the command has no automatic deadline. */
export const BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS = 0;

/** Watched commands are assessed by the agent at this interval. */
export const BACKGROUND_SHELL_CHECKIN_INTERVAL_MS = 10 * 60 * 1000;

export function normalizeBackgroundShellTimeoutMs(requested: unknown): number {
  return typeof requested === 'number' && Number.isSafeInteger(requested) && requested > 0
    ? requested
    : BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS;
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
