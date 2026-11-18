/**
 * Opening an Orchestrate worker (or its parent) from the rail. Workers are not
 * in the agent's session list, so the rail's summary row is the only cached
 * copy. The summary lacks engine, model, session mode, finalize automation and
 * worktree state, so the full row is loaded before the session is activated.
 */
export interface SpawnedSessionSummary {
  id: string;
  agent_id: string;
}

export async function loadSpawnedSessionRow<T extends SpawnedSessionSummary>(
  summary: T,
  cached: Record<string, unknown> | null | undefined,
  fetchFull: (sessionId: string) => Promise<Record<string, unknown> | null | undefined>,
): Promise<Record<string, unknown> & T> {
  let full: Record<string, unknown> | null | undefined = null;
  try {
    full = await fetchFull(summary.id);
  } catch {
    full = null;
  }
  // The server row wins; the summary keeps live fields (state, name) when the
  // fetch fails. A summary's mode is never trusted over a cached full row: the
  // mode picks the build controls and which rail shows, so a stale or guessed
  // value there does real harm. A missing mode stays missing.
  const merged: Record<string, unknown> = { ...(cached ?? {}), ...summary };
  if (cached && 'session_mode' in cached) merged.session_mode = cached.session_mode;
  return { ...merged, ...(full ?? {}) } as Record<string, unknown> & T;
}

/**
 * Latest-wins navigation token. Each `begin()` supersedes every earlier one,
 * so a slow fetch for an older click cannot pull the user back.
 */
export function createNavigationIntent(): { begin(): () => boolean } {
  let latest = 0;
  return {
    begin() {
      const token = ++latest;
      return () => token === latest;
    },
  };
}

/**
 * Load the full row, then activate it only if this open is still the user's
 * latest navigation. Returns whether it activated.
 */
export async function openSpawnedSessionWhenCurrent<T extends SpawnedSessionSummary>(args: {
  summary: T;
  cached: Record<string, unknown> | null | undefined;
  fetchFull: (sessionId: string) => Promise<Record<string, unknown> | null | undefined>;
  isCurrent: () => boolean;
  activate: (row: Record<string, unknown> & T) => void;
}): Promise<boolean> {
  const row = await loadSpawnedSessionRow(args.summary, args.cached, args.fetchFull);
  if (!args.isCurrent()) return false;
  args.activate(row);
  return true;
}
