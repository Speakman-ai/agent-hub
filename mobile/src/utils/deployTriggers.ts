// Pure helpers for the per-environment deploy-triggers surface. Framework-free
// so they can be unit-tested and mirrored by the mobile screen. Backend contract
// lives in server/deploy/deployment-trigger-store.ts (glob semantics + limits).

export type DeployTriggerEvent = 'push' | 'merge';

export interface DeployTrigger {
  id: string;
  projectId: string;
  environmentName: string;
  event: DeployTriggerEvent;
  branchPattern: string;
  enabled: boolean;
  meta: unknown;
  createdAt: string;
  updatedAt: string;
}

export const DEPLOY_TRIGGER_EVENTS: readonly DeployTriggerEvent[] = ['push', 'merge'];

// Mirrors DEPLOY_TRIGGER_BRANCH_PATTERN_MAX_LENGTH in the store so the client can
// reject an over-long pattern before the round-trip.
export const DEPLOY_TRIGGER_BRANCH_PATTERN_MAX_LENGTH = 200;

export function triggerEventLabel(event: string): string {
  if (event === 'merge') return 'Merge';
  if (event === 'push') return 'Push';
  return event;
}

/** Human sentence for a trigger row, e.g. "On push to release/*". */
export function describeTrigger(trigger: { event: string; branchPattern: string }): string {
  const verb = trigger.event === 'merge' ? 'merge to' : 'push to';
  return `On ${verb} ${trigger.branchPattern}`;
}

/**
 * Stable display order: push before merge, then by branch pattern. Keeps the
 * list from reshuffling when a trigger is toggled or edited.
 */
export function sortTriggers<T extends { event: string; branchPattern: string }>(
  triggers: T[],
): T[] {
  return [...triggers].sort((a, b) => {
    if (a.event !== b.event) return a.event === 'push' ? -1 : 1;
    return a.branchPattern.localeCompare(b.branchPattern);
  });
}

/**
 * Validate a create/edit draft. Returns an error string for display, or null
 * when the draft is acceptable. Mirrors the store's normalizeBranchPattern /
 * normalizeEvent guards so the UI fails fast without a server round-trip.
 */
export function validateTriggerDraft(draft: { event: string; branchPattern: string }): string | null {
  if (draft.event !== 'push' && draft.event !== 'merge') {
    return 'Event must be push or merge.';
  }
  const pattern = draft.branchPattern.trim();
  if (!pattern) return 'Branch pattern is required.';
  if (pattern.length > DEPLOY_TRIGGER_BRANCH_PATTERN_MAX_LENGTH) {
    return `Branch pattern must be ${DEPLOY_TRIGGER_BRANCH_PATTERN_MAX_LENGTH} characters or fewer.`;
  }
  return null;
}
