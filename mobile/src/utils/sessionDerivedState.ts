/** True when the session is in Consult (Hub-only, no code ship / Finalize). */
export function isSessionConsultModeEnabled(session: any) {
  if (session?.session_mode === 'consult') return true;
  return Number(session?.ask_mode ?? 0) !== 0;
}
