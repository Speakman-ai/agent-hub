/**
 * Pure helpers for the Settings → Finalize panel on mobile. The
 * component lives in `mobile/src/components/FinalizeSection.js`; this
 * file exists so the picker / state logic can be unit-tested without
 * rendering React Native (mobile tests run under plain Node — no RN
 * renderer is wired up). Mirrors the web pattern of
 * `client/src/components/FinalizeSettingsSection.jsx`.
 */
/**
 * Pick the project id the picker should land on, given the current list
 * of projects and the previously selected id. Mirrors the web component's
 * useEffect that keeps the picker in sync when the projects array
 * mutates underneath it (creation/deletion elsewhere). Rules:
 *   - empty list → `''`
 *   - previously selected id still present → keep it
 *   - otherwise → first project's id
 */
export function pickInitialProjectId(projects: any, currentId: any) {
  if (!Array.isArray(projects) || projects.length === 0) return '';
  if (currentId && projects.find((p: any) => p && p.id === currentId)) return currentId;
  return projects[0]?.id || '';
}
/**
 * Build the user-facing target description rendered after a wizard
 * spawn. The web component splits this across multiple <code> spans;
 * mobile uses plain text inside `<Text>` so we return a single string.
 *
 *   - `{ branch, sessionId }` → `"Branch <b> in session <s>"`
 *   - null / missing fields → null (caller renders nothing)
 */
export function describeResolvedTarget(target: any) {
  if (!target || typeof target !== 'object') return null;
  const branch = typeof target.branch === 'string' ? target.branch.trim() : '';
  const sessionId = typeof target.sessionId === 'string' ? target.sessionId.trim() : '';
  if (!branch || !sessionId) return null;
  return `Branch ${branch} in session ${sessionId}`;
}
/**
 * Decide which transient message to show after a wizard start completes.
 * Returns one of:
 *   - `{ kind: 'target', text }`   — wizard returned a resolved worktree
 *   - `{ kind: 'no_worktree' }`    — server returned target=null
 *   - `null`                       — no wizard has been spawned yet
 *
 * Mirrors the web component's three branches: last-session badge,
 * resolved target paragraph, "no worktree-bearing session" warning.
 */
export function pickFinalizeStatus({ lastSessionId, target }: any) {
  if (!lastSessionId) return null;
  const text = describeResolvedTarget(target);
  if (text) return { kind: 'target', text };
  return { kind: 'no_worktree' };
}
/**
 * Should the AppContext refresh the project list in response to a
 * `finalize_wizard_complete` WS broadcast? Mirrors the web component's
 * filter — only refetch when the event is for the project the picker is
 * currently focused on. Defensive against malformed payloads.
 */
export function shouldRefreshOnWizardComplete(event: any, currentProjectId: any) {
  if (!event || typeof event !== 'object') return false;
  if (event.type !== 'finalize_wizard_complete') return false;
  if (!currentProjectId) return false;
  return event.projectId === currentProjectId;
}
