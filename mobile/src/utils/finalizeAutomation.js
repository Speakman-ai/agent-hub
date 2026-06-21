/**
 * Mobile mirror of `client/src/utils/finalizeAutomation.js`.
 *
 * The "build dropdown" on the chat TopBar lets the user pick how far the
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
 * Design folds into the same dropdown as Ask + the finalize levels. It is the
 * no-ship end of the gradient (maps to session_mode = 'design'); mutually
 * exclusive with the others in the UI. Mirror of the web copy.
 */
export const DESIGN_AUTOMATION_OPTION = {
  value: 'design',
  label: 'Design',
  description: 'Iterate on a live canvas with the app as context — nothing ships',
};

export const ASK_AUTOMATION_OPTION = {
  value: 'ask',
  label: 'Ask',
  description: 'Read-only planning mode',
};

export const SESSION_CONTROL_OPTIONS = [
  DESIGN_AUTOMATION_OPTION,
  ASK_AUTOMATION_OPTION,
  ...FINALIZE_AUTOMATION_OPTIONS,
];

/**
 * Resolve the active dropdown value from the three underlying axes. Design >
 * Ask > finalize automation level, matching their mutual exclusivity.
 *
 * @param {{ sessionMode?: string, askMode?: unknown, automation?: string }} input
 * @returns {string}
 */
export function sessionControlValue({ sessionMode, askMode, automation } = {}) {
  if (sessionMode === 'design') return 'design';
  if (askMode) return 'ask';
  return parseFinalizeAutomation(automation);
}

export function sessionControlLabel(value) {
  return SESSION_CONTROL_OPTIONS.find((o) => o.value === value)?.label ?? 'Build';
}

/**
 * Plan the ordered mutations to move the session control to `target`. Mirror of
 * the web copy — centralizes the mutual-exclusivity contract so both surfaces
 * apply it identically and it stays unit-testable.
 *
 * Steps: { type: 'mode'|'ask'|'automation', value }. Applied in order:
 *   - 'mode' → setSessionMode, 'ask' → setSessionAskMode,
 *   - 'automation' → updateSession({ finalize_automation }).
 *
 * Key invariant: Design is mutually exclusive with all ship intent, so selecting
 * it CLEARS ask mode (no read-only underneath) AND resets finalize_automation to
 * 'manual' (no push/merge intent left lurking that resurfaces when leaving
 * Design). Leaving Design resets session_mode to 'chat' first. Returns [] for a
 * no-op.
 *
 * @param {{ sessionMode?: string, askMode?: unknown, automation?: string }} current
 * @param {string} target
 * @returns {Array<{ type: 'mode'|'ask'|'automation', value: any }>}
 */
export function planSessionControlChange(current, target) {
  const sessionMode = current?.sessionMode === 'design' ? 'design' : 'chat';
  const askMode = !!current?.askMode;
  const automation = parseFinalizeAutomation(current?.automation);
  const currentValue = sessionControlValue({ sessionMode, askMode, automation });
  if (target === currentValue) return [];

  const steps = [];
  if (target === 'design') {
    if (askMode) steps.push({ type: 'ask', value: false });
    if (automation !== 'manual') steps.push({ type: 'automation', value: 'manual' });
    steps.push({ type: 'mode', value: 'design' });
    return steps;
  }

  if (sessionMode === 'design') steps.push({ type: 'mode', value: 'chat' });
  if (target === 'ask') {
    steps.push({ type: 'ask', value: true });
  } else {
    if (askMode) steps.push({ type: 'ask', value: false });
    if (target !== automation) steps.push({ type: 'automation', value: target });
  }
  return steps;
}

/**
 * Collapse the planned steps into a single PATCH body so the change is applied
 * atomically in one server call (transactional) — no partial commits, nothing
 * to roll back on the client. Returns `null` for a no-op. Mirror of the web
 * copy.
 *
 * @param {{ sessionMode?: string, askMode?: unknown, automation?: string }} current
 * @param {string} target
 * @returns {{ session_mode?: string, ask_mode?: boolean, finalize_automation?: string } | null}
 */
export function sessionControlPatch(current, target) {
  const steps = planSessionControlChange(current, target);
  if (steps.length === 0) return null;
  const patch = {};
  for (const step of steps) {
    if (step.type === 'mode') patch.session_mode = step.value;
    else if (step.type === 'ask') patch.ask_mode = step.value;
    else if (step.type === 'automation') patch.finalize_automation = step.value;
  }
  return patch;
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
