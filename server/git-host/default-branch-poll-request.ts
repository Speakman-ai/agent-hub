/**
 * Seam between code that merges a PR on another host (GitHub) and the
 * default-branch watcher. Kept dependency-free so merge paths can call it
 * without importing the CI engine.
 */
type PollRequester = (projectId: string) => void;

let requester: PollRequester | null = null;

/** Registered by the watcher on start; `null` clears it. */
export function setDefaultBranchPollRequester(fn: PollRequester | null): void {
  requester = fn;
}

/**
 * The Hub just moved this project's default branch on its origin: poll now
 * instead of waiting for the next tick. A no-op when no watcher runs.
 */
export function requestDefaultBranchPoll(projectId: string): void {
  try {
    requester?.(projectId);
  } catch (err: unknown) {
    console.warn(
      `[default-branch-watcher] poll request failed for ${projectId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
