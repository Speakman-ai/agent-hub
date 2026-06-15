/**
 * Mobile mirror of `client/src/utils/finalizeAutomation.js`.
 *
 * The "build dropdown" on the Changes screen lets the user pick how far the
 * Runner takes a session: Build → Build and Review → Build and Push → Auto
 * Merge (plus a read-only Ask planning mode handled via the session ask-mode
 * flag). Keep the option set in lock-step with the web copy.
 */

export const FINALIZE_AUTOMATION_LEVELS = ['manual', 'review', 'push', 'merge'];

export const FINALIZE_AUTOMATION_OPTIONS = [
  {
    value: 'manual',
    label: 'Build',
    description:
      'Everything runs manually — keep a back-and-forth with the agent to build what you want',
  },
  {
    value: 'review',
    label: 'Build and Review',
    description: 'Tests and a review run after every turn; you push manually',
  },
  {
    value: 'push',
    label: 'Build and Push',
    description: 'Build, review, test, and push — no auto-merge',
  },
  {
    value: 'merge',
    label: 'Auto Merge',
    description: 'Build, review, test, push, and enable auto-merge if available',
  },
];

export function parseFinalizeAutomation(value) {
  if (value && FINALIZE_AUTOMATION_LEVELS.includes(value)) return value;
  return 'manual';
}

export function finalizeAutomationFromSession(session) {
  return parseFinalizeAutomation(session?.finalize_automation);
}

export function finalizeAutomationLabel(value) {
  return FINALIZE_AUTOMATION_OPTIONS.find((o) => o.value === value)?.label ?? 'Build';
}

/**
 * Derive the FinalizeBar dropdown state (automation level + ask-mode flag) from
 * a session row.
 *
 * Used for BOTH the bar's initial state and its re-sync effect (when the
 * session id or these fields change), so the two always agree. Centralizing it
 * is what prevents a reused / late-arriving / stale `session` from leaving the
 * bar showing — or mutating — a previous session's mode. In particular,
 * `askMode` must track `session.ask_mode`: a stale `false` would skip disabling
 * Ask mode on the server when the user picks a non-ask automation, stranding
 * the session in Ask mode while still updating `finalize_automation`.
 *
 * @param {{ finalize_automation?: string, ask_mode?: unknown }|null|undefined} session
 * @returns {{ automation: string, askMode: boolean }}
 */
export function deriveSessionFinalizeMode(session) {
  return {
    automation: finalizeAutomationFromSession(session),
    askMode: !!session?.ask_mode,
  };
}
