/** True when the session does not ship code (Consult, Orchestrate, or QA). */
export function isSessionConsultModeEnabled(session: any) {
  if (
    session?.session_mode === 'consult' ||
    session?.session_mode === 'orchestrate' ||
    session?.session_mode === 'qa'
  )
    return true;
  return Number(session?.ask_mode ?? 0) !== 0;
}
