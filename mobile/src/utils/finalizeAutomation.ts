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
 * Design folds into the same dropdown as Ask + the finalize levels. It is the
 * no-ship end of the gradient (maps to session_mode = 'design'); mutually
 * exclusive with the others in the UI. Mirror of the web copy.
 */
export const DESIGN_AUTOMATION_OPTION: Record<string, any> = {
  value: 'design',
  label: 'Design',
  description: 'Iterate on a live canvas with the app as context — nothing ships',
};
export const SCOPING_AUTOMATION_OPTION: Record<string, any> = {
  value: 'scoping',
  label: 'Scoping',
  description: 'Plan work as Epic → Phase → Ticket with a live flowchart panel',
};
export const SKILL_BUILDER_AUTOMATION_OPTION: Record<string, any> = {
  value: 'skill-builder',
  label: 'Skill Builder',
  description: 'Author or refine project skills conversationally — nothing ships',
};
export const CONSULT_AUTOMATION_OPTION: Record<string, any> = {
  value: 'consult',
  label: 'Consult',
  description:
    'Answer questions and update Agent Hub project data — board, wiki, workflows — without code ship or Finalize',
};
export const VM_AUTOMATION_OPTION: Record<string, any> = {
  value: 'isolated',
  label: 'VM',
  description:
    'Run this session in an intentional Firecracker microVM — Build/Push/Merge still work like chat',
};
// Design is offered on workflow projects too: worktree-less workflow design
// sessions store artifacts in a Hub-managed data-dir store (server:
// design-artifact-store.ts), so the mode runs without a worktree and ships nothing.
export const WORKFLOW_SESSION_CONTROL_VALUES = new Set([
  'consult',
  'scoping',
  'skill-builder',
  'design',
]);
const SHIP_AUTOMATION_VALUES = new Set(['manual', 'review', 'push', 'merge']);
export const SESSION_CONTROL_OPTIONS = [
  CONSULT_AUTOMATION_OPTION,
  DESIGN_AUTOMATION_OPTION,
  SCOPING_AUTOMATION_OPTION,
  SKILL_BUILDER_AUTOMATION_OPTION,
  VM_AUTOMATION_OPTION,
  ...FINALIZE_AUTOMATION_OPTIONS,
];
/**
 * Agent roles that may NOT run Skill Builder mode. Mirror of
 * server/session-mode.ts — Skill Builder prepends a dev coach prompt and
 * force-loads skill-authoring skills, so it only makes sense on a dev agent.
 */
export const SKILL_BUILDER_INELIGIBLE_ROLES = ['skill-builder', 'reviewer', 'docs', 'hub-assistant'];
/** Whether an agent (by role) is eligible to run Skill Builder mode. */
export function isSkillBuilderEligibleAgent(agent: any): boolean {
  if (!agent) return false;
  return !SKILL_BUILDER_INELIGIBLE_ROLES.includes(agent.role ?? '');
}
/**
 * Session-control options for a given agent: the full list minus Skill Builder
 * when the agent is a helper (docs / reviewer / skill-builder). The server
 * rejects the mode for those roles too, so hiding it keeps the picker honest.
 */
export function sessionControlOptionsForAgent(agent: any) {
  if (isSkillBuilderEligibleAgent(agent)) return SESSION_CONTROL_OPTIONS;
  return SESSION_CONTROL_OPTIONS.filter((o: any) => o.value !== 'skill-builder');
}
export function sessionControlOptionsForProject(
  project: any,
  agent: any,
  capabilities: { canUseVm?: boolean } = {},
) {
  const base = sessionControlOptionsForAgent(agent).filter(
    (o: any) => o.value !== 'isolated' || capabilities.canUseVm === true,
  );
  if (project?.mode === 'workflow') {
    return base.filter((o: any) => WORKFLOW_SESSION_CONTROL_VALUES.has(o.value));
  }
  return base;
}
export function sessionControlValueForProject(project: any, input: any = {}) {
  const value = sessionControlValue(input);
  if (project?.mode !== 'workflow') return value;
  if (SHIP_AUTOMATION_VALUES.has(value)) return 'consult';
  return value;
}
/**
 * Resolve the active dropdown value from the three underlying axes. Design >
 * Ask > finalize automation level, matching their mutual exclusivity.
 *
 * @param {{ sessionMode?: string, askMode?: unknown, automation?: string }} input
 * @returns {string}
 */
export function sessionControlValue({ sessionMode, askMode, automation }: any = {}) {
  if (sessionMode === 'design') return 'design';
  if (sessionMode === 'scoping') return 'scoping';
  if (sessionMode === 'skill-builder') return 'skill-builder';
  if (sessionMode === 'consult') return 'consult';
  if (sessionMode === 'hub') return 'consult';
  if (sessionMode === 'isolated') return 'isolated';
  if (askMode) return 'consult';
  return parseFinalizeAutomation(automation);
}
export function sessionControlLabel(value: any) {
  return SESSION_CONTROL_OPTIONS.find((o: any) => o.value === value)?.label ?? 'Build';
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
 * Design). Leaving Design resets session_mode to 'chat' first. Leaving VM
 * (isolated) for ship levels keeps session_mode isolated. Returns [] for a
 * no-op.
 *
 * @param {{ sessionMode?: string, askMode?: unknown, automation?: string }} current
 * @param {string} target
 * @returns {Array<{ type: 'mode'|'ask'|'automation', value: any }>}
 */
export function planSessionControlChange(current: any, target: any, options: any = {}) {
  const workflowProject =
    options?.project?.mode === 'workflow' || current?.projectMode === 'workflow';
  const sessionMode =
    current?.sessionMode === 'design'
      ? 'design'
      : current?.sessionMode === 'scoping'
        ? 'scoping'
        : current?.sessionMode === 'skill-builder'
          ? 'skill-builder'
          : current?.sessionMode === 'consult'
            ? 'consult'
            : current?.sessionMode === 'hub'
              ? 'hub'
              : current?.sessionMode === 'isolated'
              ? 'isolated'
              : 'chat';
  const askMode = !!current?.askMode;
  const automation = parseFinalizeAutomation(current?.automation);
  const currentValue = sessionControlValue({ sessionMode, askMode, automation });
  if (target === currentValue) return [];
  const steps = [];
  const clearShipIntent = () => {
    if (workflowProject) return;
    if (automation !== 'manual') steps.push({ type: 'automation', value: 'manual' });
  };
  if (target === 'design') {
    if (askMode) steps.push({ type: 'ask', value: false });
    clearShipIntent();
    steps.push({ type: 'mode', value: 'design' });
    return steps;
  }
  if (target === 'scoping') {
    if (askMode) steps.push({ type: 'ask', value: false });
    clearShipIntent();
    steps.push({ type: 'mode', value: 'scoping' });
    return steps;
  }
  if (target === 'skill-builder') {
    if (askMode) steps.push({ type: 'ask', value: false });
    clearShipIntent();
    steps.push({ type: 'mode', value: 'skill-builder' });
    return steps;
  }
  if (target === 'consult') {
    if (askMode) steps.push({ type: 'ask', value: false });
    clearShipIntent();
    steps.push({ type: 'mode', value: 'consult' });
    return steps;
  }
  if (target === 'isolated') {
    if (askMode) steps.push({ type: 'ask', value: false });
    clearShipIntent();
    steps.push({ type: 'mode', value: 'isolated' });
    return steps;
  }
  if (
    sessionMode === 'design' ||
    sessionMode === 'scoping' ||
    sessionMode === 'skill-builder' ||
    sessionMode === 'consult'
  )
    steps.push({ type: 'mode', value: 'chat' });
  if (askMode) steps.push({ type: 'ask', value: false });
  if (target !== automation) steps.push({ type: 'automation', value: target });
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
export function sessionControlPatch(current: any, target: any, options: any = {}) {
  const steps = planSessionControlChange(current, target, options);
  if (steps.length === 0) return null;
  const patch: Record<string, any> = {};
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
export function deriveSessionFinalizeMode(session: any) {
  return {
    automation: finalizeAutomationFromSession(session),
    askMode: !!session?.ask_mode,
  };
}
