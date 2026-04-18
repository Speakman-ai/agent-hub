/**
 * Pure helpers for the git-worktree isolation toggle + CLI-detection badge.
 *
 * Ported from `client/src/App.jsx` (session-load + session-switch branches and
 * the `session-worktree-detected` WebSocket handler). Keeping this logic in a
 * standalone module means we can unit-test the normalisation rules without
 * mounting the React Native context.
 *
 * Server row conventions (SQLite columns):
 *   - `use_worktree`            — 0 or 1; defaults to 1 (isolated) when unset
 *   - `git_worktree_detected`   — 0 | 1 | null; null = CLI hasn't reported yet
 *
 * UI representation:
 *   - `enabled`  — boolean (the user-facing toggle state)
 *   - `detected` — true | false | null  (null = unknown, keeps the badge hidden)
 */

/**
 * Normalise a session row's worktree fields into the booleans/tri-state the
 * mobile UI renders. Treats `use_worktree` === 0 as OFF and everything else
 * (including missing / undefined) as ON, matching the web client's
 * `session.use_worktree !== 0` check.
 */
export function resolveSessionWorktree(session) {
  if (!session) return { enabled: true, detected: null };
  const enabled = session.use_worktree !== 0;
  let detected = null;
  if (session.git_worktree_detected != null) {
    detected = session.git_worktree_detected === 1 || session.git_worktree_detected === true;
  }
  return { enabled, detected };
}

/**
 * Produce a new sessions array with the `git_worktree_detected` flag updated
 * for the given sessionId. Used when the server broadcasts the
 * `session-worktree-detected` WebSocket event so the sidebar and subsequent
 * session switches pick up the CLI's status-line confirmation.
 *
 * The flag is stored in the SQLite convention (0/1) so hydration works the
 * same way after a page refresh.
 */
export function applyDetectedFlag(sessions, sessionId, gitWorktree) {
  if (!Array.isArray(sessions)) return [];
  if (!sessionId) return sessions;
  return sessions.map((s) =>
    s && s.id === sessionId ? { ...s, git_worktree_detected: gitWorktree ? 1 : 0 } : s,
  );
}

/**
 * Badge descriptor for the detection pill. Returns null when the flag is
 * unknown (null) so the caller can hide the badge entirely. `tone` is a
 * semantic label the caller maps to colours; the mobile TopBar uses it to
 * pick emerald / amber / neutral styling.
 */
export function describeDetectionBadge({ enabled, detected }) {
  if (detected == null) return null;
  if (detected) {
    return {
      tone: 'ok',
      symbol: '✓',
      label: 'WT',
      hint: 'CLI confirmed: running inside a git worktree',
    };
  }
  if (enabled) {
    return {
      tone: 'warn',
      symbol: '!',
      label: '!',
      hint: 'Warning: worktree mode is ON but CLI is not in a git worktree',
    };
  }
  return {
    tone: 'off',
    symbol: '—',
    label: '—',
    hint: 'CLI confirmed: not in a git worktree',
  };
}
