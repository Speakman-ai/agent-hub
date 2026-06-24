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
    description: 'Build, review, test, and push to GitHub — no auto-merge',
  },
  {
    value: 'merge',
    label: 'Auto Merge',
    description: 'Build, review, test, push, and enable GitHub auto-merge if available',
  },
];

export function parseFinalizeAutomation(value: any) {
  if (value && FINALIZE_AUTOMATION_LEVELS.includes(value)) return value;
  return 'manual';
}

export function finalizeAutomationFromSession(session: any) {
  return parseFinalizeAutomation(session?.finalize_automation);
}

export function finalizeAutomationLabel(value: any) {
  return FINALIZE_AUTOMATION_OPTIONS.find((o: any) => o.value === value)?.label ?? 'Build';
}

/**
 * Design is folded into the same "what is this session doing" dropdown as Ask
 * and the finalize automation levels. It is the no-ship end of the gradient:
 * iterate on a live canvas with the app as context, nothing finalizes/pushes.
 * It maps to `session_mode = 'design'` (a separate axis from ask_mode /
 * finalize_automation) but is mutually exclusive with the others in the UI.
 */
export const DESIGN_AUTOMATION_OPTION = {
  value: 'design',
  label: 'Design',
  description: 'Iterate on a live canvas with the app as context — nothing ships',
} as Record<string, any>;

export const SCOPING_AUTOMATION_OPTION = {
  value: 'scoping',
  label: 'Scoping',
  description: 'Plan work as Epic → Phase → Ticket with a live flowchart panel',
} as Record<string, any>;

export const ASK_AUTOMATION_OPTION = {
  value: 'ask',
  label: 'Ask',
  description: 'Read-only planning mode, using the selected CLI engine ask mode',
} as Record<string, any>;

/**
 * The full ordered option list for the session control dropdown:
 * Design → Ask → Build → Build and Review → Build and Push → Auto Merge.
 */
export const SESSION_CONTROL_OPTIONS = [
  DESIGN_AUTOMATION_OPTION,
  SCOPING_AUTOMATION_OPTION,
  ASK_AUTOMATION_OPTION,
  ...FINALIZE_AUTOMATION_OPTIONS,
];

/**
 * Resolve which single dropdown value is active given the three underlying
 * axes. Design takes precedence over Ask, which takes precedence over the
 * finalize automation level — matching their mutual exclusivity in the UI.
 *
 * @param {{ sessionMode?: string, askMode?: unknown, automation?: string }} input
 * @returns {string} one of 'design' | 'ask' | 'manual' | 'review' | 'push' | 'merge'
 */
export function sessionControlValue({ sessionMode, askMode, automation }: any = {}) {
  if (sessionMode === 'design') return 'design';
  if (sessionMode === 'scoping') return 'scoping';
  if (askMode) return 'ask';
  return parseFinalizeAutomation(automation);
}

export function sessionControlLabel(value: any) {
  return SESSION_CONTROL_OPTIONS.find((o: any) => o.value === value)?.label ?? 'Build';
}

/**
 * Plan the ordered mutations needed to move the session control from its current
 * state to `target`. Centralizes the mutual-exclusivity contract so web + mobile
 * apply it identically and it stays unit-testable.
 *
 * Returns an array of steps; the caller applies them in order, mapping each to
 * the right API/handler call:
 *   - { type: 'mode', value: 'design' | 'chat' }   → setSessionMode
 *   - { type: 'ask', value: boolean }              → setSessionAskMode
 *   - { type: 'automation', value: <level> }       → updateSession({ finalize_automation })
 *
 * Key invariant (the bugs this guards): selecting Design is mutually exclusive
 * with all ship intent, so it must CLEAR both other axes —
 *   - ask mode (otherwise Design wins display precedence while the session runs
 *     read-only underneath, so design prompts never write artifacts), and
 *   - the finalize_automation level (otherwise a session entering Design from
 *     push/merge keeps that ship intent stored underneath and unexpectedly
 *     reveals/reuses it when later leaving Design) — reset to 'manual'.
 * Symmetrically, leaving Design for any ship/ask intent resets session_mode to
 * 'chat' first so the ship intent actually applies. Returns [] for a no-op.
 *
 * @param {{ sessionMode?: string, askMode?: unknown, automation?: string }} current
 * @param {string} target one of the SESSION_CONTROL_OPTIONS values
 * @returns {Array<{ type: 'mode'|'ask'|'automation', value: any }>}
 */
export function planSessionControlChange(current: any, target: any) {
  const sessionMode =
    current?.sessionMode === 'design'
      ? 'design'
      : current?.sessionMode === 'scoping'
        ? 'scoping'
        : 'chat';
  const askMode = !!current?.askMode;
  const automation = parseFinalizeAutomation(current?.automation);
  const currentValue = sessionControlValue({ sessionMode, askMode, automation });
  if (target === currentValue) return [];

  const steps: any[] = [];
  if (target === 'design') {
    if (askMode) steps.push({ type: 'ask', value: false });
    if (automation !== 'manual') steps.push({ type: 'automation', value: 'manual' });
    steps.push({ type: 'mode', value: 'design' });
    return steps;
  }

  if (target === 'scoping') {
    if (askMode) steps.push({ type: 'ask', value: false });
    if (automation !== 'manual') steps.push({ type: 'automation', value: 'manual' });
    steps.push({ type: 'mode', value: 'scoping' });
    return steps;
  }

  // Any non-design/scoping target: drop out of special modes first.
  if (sessionMode === 'design' || sessionMode === 'scoping') {
    steps.push({ type: 'mode', value: 'chat' });
  }
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
 * to roll back on the client. Returns `null` for a no-op.
 *
 * Keys map to the PATCH /api/sessions/:id contract:
 *   - mode       → session_mode
 *   - ask        → ask_mode
 *   - automation → finalize_automation
 *
 * @param {{ sessionMode?: string, askMode?: unknown, automation?: string }} current
 * @param {string} target
 * @returns {{ session_mode?: string, ask_mode?: boolean, finalize_automation?: string } | null}
 */
export function sessionControlPatch(current: any, target: any) {
  const steps = planSessionControlChange(current, target);
  if (steps.length === 0) return null;
  const patch: Record<string, any> = {};
  for (const step of steps) {
    if (step.type === 'mode') patch.session_mode = step.value;
    else if (step.type === 'ask') patch.ask_mode = step.value;
    else if (step.type === 'automation') patch.finalize_automation = step.value;
  }
  return patch;
}
