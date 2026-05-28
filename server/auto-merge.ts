export interface GithubWorkflowLike {
  autoMerge?: boolean;
}

/**
 * Resolve whether a PR should have GitHub native auto-merge enabled.
 *
 * Precedence:
 *   1. Per-PR override (from the user's toggle in ChangesReadyBox) wins.
 *   2. Otherwise, the project's Settings-page `githubWorkflow.autoMerge`.
 *   3. Default: false (do nothing).
 *
 * This is the single source of truth for the default — retained for tests
 * and any future server-side PR paths; the ship skill flow does not use it.
 */
export function resolveShouldAutoMerge(
  override: boolean | undefined,
  projectWorkflow: GithubWorkflowLike | undefined | null,
): boolean {
  if (override !== undefined) return override;
  return !!projectWorkflow?.autoMerge;
}
