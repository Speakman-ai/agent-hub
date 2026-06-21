/**
 * Per-user, project-scoped settings.
 *
 * Currently the only setting is the user's preferred default Finalize
 * automation level for a project. When a user creates an ad-hoc session in a
 * project, the new session inherits this default (board-assigned and
 * autonomous-dispatch sessions keep their own escalation rules — see
 * `assignedFinalizeAutomationLevel`).
 *
 * Storage is the `user_project_settings` table, keyed on (user_id, project_id).
 * In single-tenant local mode (`isLocalBundledServer()`), requests carry no
 * `authUserId`; we bucket those under {@link LOCAL_USER_KEY} so the one local
 * operator still gets a persisted preference.
 */
import type { Stmts, UserProjectSettingsRow } from './types.js';
import {
  FINALIZE_AUTOMATION_LEVELS,
  parseFinalizeAutomation,
  type FinalizeAutomationLevel,
} from './finalize/automation.js';

/** Bucket key for requests with no resolved user id (single-tenant local mode). */
export const LOCAL_USER_KEY = '__local__';

/** Resolve the storage key for a (possibly null) authenticated user id. */
export function resolveUserSettingsKey(userId: string | null | undefined): string {
  return userId && userId.length > 0 ? userId : LOCAL_USER_KEY;
}

/**
 * Read the user's stored default Finalize automation level for a project, or
 * `null` when the user has not set one (the caller should then fall back to
 * the global default, i.e. `manual`).
 */
export function getUserProjectDefaultFinalizeAutomation(
  stmts: Stmts,
  userId: string | null | undefined,
  projectId: string,
): FinalizeAutomationLevel | null {
  try {
    const row = stmts.getUserProjectSettings.get(resolveUserSettingsKey(userId), projectId) as
      | UserProjectSettingsRow
      | undefined;
    const raw = row?.default_finalize_automation;
    if (!raw) return null;
    // Defensive: only honour known levels; ignore stale/garbage rows.
    return (FINALIZE_AUTOMATION_LEVELS as readonly string[]).includes(raw)
      ? parseFinalizeAutomation(raw)
      : null;
  } catch (err) {
    console.warn(
      `[user-project-settings] getUserProjectDefaultFinalizeAutomation failed (${projectId}):`,
      (err as Error).message,
    );
    return null;
  }
}

/**
 * Persist (upsert) the user's default Finalize automation level for a project.
 * Passing `null` clears the preference so the project falls back to the global
 * default.
 */
export function setUserProjectDefaultFinalizeAutomation(
  stmts: Stmts,
  userId: string | null | undefined,
  projectId: string,
  level: FinalizeAutomationLevel | null,
): void {
  stmts.upsertUserProjectDefaultFinalizeAutomation.run(
    resolveUserSettingsKey(userId),
    projectId,
    level,
  );
}
