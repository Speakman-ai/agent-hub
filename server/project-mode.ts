import type { Project, ProjectMode } from './types.js';

export type { ProjectMode };

/** Effective mode — missing or unknown values default to dev. */
export function getProjectMode(project: Project | null | undefined): ProjectMode {
  if (project?.mode === 'workflow') return 'workflow';
  return 'dev';
}

/**
 * `sessions.use_worktree` default for new rows: workflow projects skip
 * per-session worktrees; dev mode defaults to isolated sessions.
 */
export function defaultSessionUseWorktreeFlag(project: Project | null | undefined): 0 | 1 {
  return getProjectMode(project) === 'workflow' ? 0 : 1;
}
