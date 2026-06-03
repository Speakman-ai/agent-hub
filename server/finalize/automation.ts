/**
 * Per-session Finalize automation levels.
 *
 *   manual — operator clicks Finalize / Push (default for ad-hoc sessions)
 *   review — auto-start Finalize (rebase + review + checks); stop at ready_to_push
 *   push   — auto-start Finalize, then auto-push when gates pass (no GH auto-merge)
 *   merge  — auto-start, auto-push, enable GitHub native auto-merge on the PR
 */
export const FINALIZE_AUTOMATION_LEVELS = ['manual', 'review', 'push', 'merge'] as const;

export type FinalizeAutomationLevel = (typeof FINALIZE_AUTOMATION_LEVELS)[number];

/** Default for board-assign and autonomous-dispatch sessions. */
export const FINALIZE_AUTOMATION_ASSIGNED_DEFAULT: FinalizeAutomationLevel = 'merge';

export function parseFinalizeAutomation(raw: string | null | undefined): FinalizeAutomationLevel {
  if (raw && (FINALIZE_AUTOMATION_LEVELS as readonly string[]).includes(raw)) {
    return raw as FinalizeAutomationLevel;
  }
  return 'manual';
}

export function resolveSessionFinalizeAutomation(
  session: { finalize_automation?: string | null } | null | undefined,
): FinalizeAutomationLevel {
  return parseFinalizeAutomation(session?.finalize_automation);
}

export function shouldAutoStartFinalize(level: FinalizeAutomationLevel): boolean {
  return level === 'review' || level === 'push' || level === 'merge';
}

export function shouldAutoPushAfterReady(level: FinalizeAutomationLevel): boolean {
  return level === 'push' || level === 'merge';
}

export function shouldEnableAutoMergeForAutomation(level: FinalizeAutomationLevel): boolean {
  return level === 'merge';
}

export function finalizeAutomationLabel(level: FinalizeAutomationLevel): string {
  switch (level) {
    case 'manual':
      return 'Manual';
    case 'review':
      return 'Review Automatically';
    case 'push':
      return 'Push Automatically';
    case 'merge':
      return 'Merge Automatically';
    default:
      return 'Manual';
  }
}
