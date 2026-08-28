/**
 * Host-emitted progress_step label for Firecracker (env-owned) session boot.
 * The chat tail and ProgressPanel both key off this string.
 */
export const SESSION_ENV_LAUNCH_STEP = 'Launching session VM';

/** Host-emitted progress_step while the session git worktree is cloning. */
export const SESSION_WORKSPACE_STEP = 'Preparing session workspace';

/**
 * Sub-line shown under {@link SESSION_WORKSPACE_STEP} while a fresh session
 * clone is provisioning. The step only surfaces when there is genuine clone
 * work to do (see `sessionWorkspaceNeedsProvisionProgress`), so a long-running
 * spinner here is a first-time clone + dependency install — not a hang. The
 * detail explains that so the wait reads as expected work.
 */
export const SESSION_WORKSPACE_PREP_DETAIL =
  'First-time setup: cloning the repository and installing dependencies. This can take a minute.';

export type SessionEnvLaunchStatus = 'started' | 'completed' | 'failed';

export type SessionEnvLaunchInfo = {
  status: SessionEnvLaunchStatus;
  startedAt: number | null;
};

/**
 * Latest `progress_step` for {@link SESSION_ENV_LAUNCH_STEP} in a session-event
 * list. `null` when the turn never launched a VM.
 */
export function latestSessionEnvLaunch(
  events:
    | ReadonlyArray<{
        event?: {
          type?: string;
          step?: string;
          status?: string;
          startedAt?: number;
          finishedAt?: number;
        } | null;
      } | null>
    | null
    | undefined,
): SessionEnvLaunchInfo | null {
  if (!events) return null;
  let latest: SessionEnvLaunchInfo | null = null;
  for (const row of events) {
    const event = row?.event;
    if (
      event?.type === 'progress_step' &&
      event.step === SESSION_ENV_LAUNCH_STEP &&
      (event.status === 'started' || event.status === 'completed' || event.status === 'failed')
    ) {
      latest = {
        status: event.status,
        startedAt: typeof event.startedAt === 'number' ? event.startedAt : null,
      };
    }
  }
  return latest;
}

export function latestSessionEnvLaunchStatus(
  events: Parameters<typeof latestSessionEnvLaunch>[0],
): SessionEnvLaunchStatus | null {
  return latestSessionEnvLaunch(events)?.status ?? null;
}
