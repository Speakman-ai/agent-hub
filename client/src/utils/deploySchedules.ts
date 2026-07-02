// Pure helpers for the per-environment deploy-schedules surface. Framework-free
// so they can be unit-tested and mirrored by the mobile screen. Backend contract
// lives in server/deploy/deployment-schedule-store.ts (cron/timezone validation
// + limits) and the CRUD API in server/routes/deployments.ts.

export interface DeploySchedule {
  id: string;
  projectId: string;
  environmentName: string;
  ref: string;
  cron: string;
  timezone: string | null;
  ownerUserId: string | null;
  enabled: boolean;
  meta: unknown;
  createdAt: string;
  updatedAt: string;
}

// Mirror the store limits so the client can reject an over-long value before the
// round-trip (server/deploy/deployment-schedule-store.ts).
export const DEPLOY_SCHEDULE_REF_MAX_LENGTH = 255;
export const DEPLOY_SCHEDULE_CRON_MAX_LENGTH = 200;

/**
 * Stable display order: by ref, then by cron expression. Keeps the list from
 * reshuffling when a schedule is toggled or edited.
 */
export function sortSchedules<T extends { ref: string; cron: string }>(schedules: T[]): T[] {
  return [...schedules].sort((a, b) => {
    if (a.ref !== b.ref) return a.ref.localeCompare(b.ref);
    return a.cron.localeCompare(b.cron);
  });
}

/** Human sentence for a schedule row, e.g. "Deploy main on 0 9 * * *". */
export function describeSchedule(schedule: { ref: string; cron: string }): string {
  return `Deploy ${schedule.ref} on ${schedule.cron}`;
}

/**
 * Validate a create/edit draft. Returns an error string for display, or null
 * when the draft is acceptable. Mirrors the store's normalizeRef / normalizeCron
 * length guards so the UI fails fast without a server round-trip. Full cron
 * expression validity is checked server-side via node-cron.
 */
export function validateScheduleDraft(draft: { ref: string; cron: string }): string | null {
  const ref = draft.ref.trim();
  if (!ref) return 'Ref is required.';
  if (ref.length > DEPLOY_SCHEDULE_REF_MAX_LENGTH) {
    return `Ref must be ${DEPLOY_SCHEDULE_REF_MAX_LENGTH} characters or fewer.`;
  }
  const cron = draft.cron.trim();
  if (!cron) return 'Cron expression is required.';
  if (cron.length > DEPLOY_SCHEDULE_CRON_MAX_LENGTH) {
    return `Cron must be ${DEPLOY_SCHEDULE_CRON_MAX_LENGTH} characters or fewer.`;
  }
  return null;
}
