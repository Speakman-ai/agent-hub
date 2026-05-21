import type { Project, ProjectMode } from './types.js';

export type { ProjectMode };

/** Effective mode — missing or unknown values default to dev. */
export function getProjectMode(project: Project | null | undefined): ProjectMode {
  if (project?.mode === 'workflow') return 'workflow';
  return 'dev';
}

/**
 * `sessions.use_worktree` default for new rows. Agent Hub is now
 * worktree-only for all user-facing session flows, so this always
 * returns 1 regardless of project mode. The flag is kept on the
 * row so internal callers (e.g., preview-wizard) can still spawn
 * shared-checkout sessions when they need to.
 */
export function defaultSessionUseWorktreeFlag(_project: Project | null | undefined): 0 | 1 {
  return 1;
}

/** True only when the session row explicitly opted into worktree isolation. */
export function sessionUsesWorktree(session: { use_worktree: number }): boolean {
  return Number(session.use_worktree) === 1;
}
