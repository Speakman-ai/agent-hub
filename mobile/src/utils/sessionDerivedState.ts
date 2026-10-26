/** True when the session is in Consult or QA (Hub-only, no code ship / Finalize). */
export function isSessionConsultModeEnabled(session: any) {
  if (session?.session_mode === 'consult' || session?.session_mode === 'qa') return true;
  return Number(session?.ask_mode ?? 0) !== 0;
}
