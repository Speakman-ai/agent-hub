/**
 * Helpers for the "Changes ready → Create PR" flow.
 *
 * Ported behaviour from the web client (`ChangesReadyBox.jsx` + `App.jsx`).
 * These are pure functions so they can be unit-tested without rendering any
 * React Native components.
 */

/**
 * Resolve the default auto-merge toggle value from the project settings.
 * Layer 1 = project setting; the user can flip the toggle (Layer 2) before
 * submitting the PR.
 */
export function resolveAutoMergeDefault(project) {
  return !!(project && project.githubWorkflow && project.githubWorkflow.autoMerge);
}

/**
 * Parse a session row's persisted `changes_ready` column (may be a JSON
 * string, an object, or null/undefined) into a normalised object or null.
 */
export function parseChangesReady(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') return raw;
  return null;
}

/**
 * Build a map of sessionId → changes_ready metadata from a list of session
 * rows as returned by `GET /agents/:id/sessions`. Sessions with no pending
 * changes are omitted so callers can spread this directly into state.
 */
export function hydrateChangesReady(sessions) {
  const out = {};
  if (!Array.isArray(sessions)) return out;
  for (const s of sessions) {
    const parsed = parseChangesReady(s?.changes_ready);
    if (parsed) out[s.id] = parsed;
  }
  return out;
}

export function hasCommittableChangesFromReady(changes) {
  if (!changes || typeof changes !== 'object') return false;
  return Boolean(changes.hasUncommitted || changes.hasUnpushed);
}
