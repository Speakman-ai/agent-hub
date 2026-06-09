/**
 * Per-session Finalize automation levels. The wire/DB keys are stable; the
 * UI labels (see `client/src/utils/finalizeAutomation.js`) are:
 *
 *   manual → "Build"          — everything runs manually; back-and-forth with the agent
 *   review → "Build and Review" — auto-run reviewer + checks after every turn; stop at ready_to_push
 *   push   → "Build and Push"   — auto build/review/test, then auto-push when gates pass (no GH auto-merge)
 *   merge  → "Auto Merge"          — auto build/review/test/push, enable GitHub native auto-merge if available
 */
export const FINALIZE_AUTOMATION_LEVELS = ['manual', 'review', 'push', 'merge'] as const;

export type FinalizeAutomationLevel = (typeof FINALIZE_AUTOMATION_LEVELS)[number];

/**
 * Default for board-assign and autonomous-dispatch sessions. Assigned cards
 * always at least build/review/test/push; whether they also auto-merge ("Send
 * It") depends on the auto-merge decision resolved at assign time — see
 * {@link assignedFinalizeAutomationLevel}.
 */
export const FINALIZE_AUTOMATION_ASSIGNED_DEFAULT: FinalizeAutomationLevel = 'merge';

/**
 * The automation level an assigned / autonomous card should run under:
 *   - auto-merge ON  → `merge` ("Auto Merge"): build, review, test, push, auto-merge
 *   - auto-merge OFF → `push`  ("Build and Push"): build, review, test, push
 */
export function assignedFinalizeAutomationLevel(
  autoMergeEnabled: boolean,
): FinalizeAutomationLevel {
  return autoMergeEnabled ? 'merge' : 'push';
}

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
      return 'Build';
    case 'review':
      return 'Build and Review';
    case 'push':
      return 'Build and Push';
    case 'merge':
      return 'Auto Merge';
    default:
      return 'Build';
  }
}
