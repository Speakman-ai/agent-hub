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

export const SKILL_BUILDER_AUTOMATION_OPTION = {
  value: 'skill-builder',
  label: 'Skill Builder',
  description: 'Author or refine project skills conversationally — nothing ships',
} as Record<string, any>;

export const CONSULT_AUTOMATION_OPTION = {
  value: 'consult',
  label: 'Consult',
  description:
    'Answer questions and update Agent Hub project data — board, wiki, workflows — without code ship or Finalize',
} as Record<string, any>;

export const VM_AUTOMATION_OPTION = {
  value: 'isolated',
  label: 'VM',
  description:
    'Run this session in an intentional Firecracker microVM — Build/Push/Merge still work like chat',
} as Record<string, any>;

/**
 * Session-control values offered on workflow projects (no build/push/finalize).
 * Design is included: worktree-less workflow design sessions store artifacts in
 * a Hub-managed data-dir store (server: design-artifact-store.ts), so the mode
 * runs without a worktree and still ships nothing.
 */
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

export const SKILL_BUILDER_INELIGIBLE_ROLES = ['skill-builder', 'reviewer', 'docs'];

export function isSkillBuilderEligibleAgent(agent: any): boolean {
  if (!agent) return false;
  return !SKILL_BUILDER_INELIGIBLE_ROLES.includes(agent.role ?? '');
}

export function sessionControlOptionsForAgent(agent: any): typeof SESSION_CONTROL_OPTIONS {
  if (isSkillBuilderEligibleAgent(agent)) return SESSION_CONTROL_OPTIONS;
  return SESSION_CONTROL_OPTIONS.filter((o: any) => o.value !== 'skill-builder');
}

/** Workflow projects hide Build→Auto Merge; dev projects show the full list. */
export function sessionControlOptionsForProject(
  project: { mode?: string } | null | undefined,
  agent: any,
  capabilities: { canUseVm?: boolean } = {},
): typeof SESSION_CONTROL_OPTIONS {
  const base = sessionControlOptionsForAgent(agent).filter(
    (o: any) => o.value !== 'isolated' || capabilities.canUseVm === true,
  );
  if (project?.mode === 'workflow') {
    return base.filter((o: any) => WORKFLOW_SESSION_CONTROL_VALUES.has(o.value));
  }
  return base;
}

/** Legacy ask_mode rows and stale ship levels map to Consult for display. */
export function sessionControlValueForProject(
  project: { mode?: string } | null | undefined,
  input: { sessionMode?: string; askMode?: unknown; automation?: string } = {},
) {
  const value = sessionControlValue(input);
  if (project?.mode === 'workflow' && SHIP_AUTOMATION_VALUES.has(value)) return 'consult';
  return value;
}

export function sessionControlValue({ sessionMode, askMode, automation }: any = {}) {
  if (sessionMode === 'design') return 'design';
  if (sessionMode === 'scoping') return 'scoping';
  if (sessionMode === 'skill-builder') return 'skill-builder';
  if (sessionMode === 'consult') return 'consult';
  if (sessionMode === 'isolated') return 'isolated';
  if (askMode) return 'consult';
  return parseFinalizeAutomation(automation);
}

export function sessionControlLabel(value: any) {
  return SESSION_CONTROL_OPTIONS.find((o: any) => o.value === value)?.label ?? 'Build';
}

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
            : current?.sessionMode === 'isolated'
              ? 'isolated'
              : 'chat';
  const askMode = !!current?.askMode;
  const automation = parseFinalizeAutomation(current?.automation);
  const currentValue = sessionControlValue({ sessionMode, askMode, automation });
  if (target === currentValue) return [];

  const steps: any[] = [];
  const clearLegacyAsk = () => {
    if (askMode) steps.push({ type: 'ask', value: false });
  };
  const clearShipIntent = () => {
    if (workflowProject) return;
    if (automation !== 'manual') steps.push({ type: 'automation', value: 'manual' });
  };

  if (target === 'design') {
    clearLegacyAsk();
    clearShipIntent();
    steps.push({ type: 'mode', value: 'design' });
    return steps;
  }

  if (target === 'scoping') {
    clearLegacyAsk();
    clearShipIntent();
    steps.push({ type: 'mode', value: 'scoping' });
    return steps;
  }

  if (target === 'skill-builder') {
    clearLegacyAsk();
    clearShipIntent();
    steps.push({ type: 'mode', value: 'skill-builder' });
    return steps;
  }

  if (target === 'consult') {
    clearLegacyAsk();
    clearShipIntent();
    steps.push({ type: 'mode', value: 'consult' });
    return steps;
  }

  if (target === 'isolated') {
    clearLegacyAsk();
    clearShipIntent();
    steps.push({ type: 'mode', value: 'isolated' });
    return steps;
  }

  // Ship levels: leaving design/consult/… returns to chat; leaving isolated
  // keeps session_mode isolated (same ship surface as chat).
  if (
    sessionMode === 'design' ||
    sessionMode === 'scoping' ||
    sessionMode === 'skill-builder' ||
    sessionMode === 'consult'
  ) {
    steps.push({ type: 'mode', value: 'chat' });
  }
  clearLegacyAsk();
  if (target !== automation) steps.push({ type: 'automation', value: target });
  return steps;
}

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
