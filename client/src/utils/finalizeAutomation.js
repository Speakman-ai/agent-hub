export const FINALIZE_AUTOMATION_LEVELS = ['manual', 'review', 'push', 'merge'];

export const FINALIZE_AUTOMATION_OPTIONS = [
  {
    value: 'manual',
    label: 'Manual',
    description: 'Nothing automatic — press Finalize and Push yourself',
  },
  {
    value: 'review',
    label: 'Review Automatically',
    description: 'Run review and checks when the session ends; you push manually',
  },
  {
    value: 'push',
    label: 'Push Automatically',
    description: 'Review, checks, and push to GitHub — no auto-merge',
  },
  {
    value: 'merge',
    label: 'Merge Automatically',
    description: 'Review, push, and enable GitHub auto-merge on the PR',
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
  return FINALIZE_AUTOMATION_OPTIONS.find((o) => o.value === value)?.label ?? 'Manual';
}
