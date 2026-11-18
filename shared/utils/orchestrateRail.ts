/**
 * Which Orchestrate chat's workers the rail (web) or sheet (mobile) shows for
 * the open session. An Orchestrate chat shows its own workers, even when it
 * is itself a worker that was switched to Orchestrate; any other worker shows
 * its parent's list. Null when there is no rail.
 */
export function orchestrateRailParentId(
  session:
    | { id?: string | null; session_mode?: string | null; spawned_from_session_id?: string | null }
    | null
    | undefined,
): string | null {
  if (!session?.id) return null;
  if (session.session_mode === 'orchestrate') return session.id;
  return session.spawned_from_session_id || null;
}
