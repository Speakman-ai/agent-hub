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
