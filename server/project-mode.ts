import path from 'path';
import type { Project, ProjectMode } from './types.js';

export type { ProjectMode };

/** Effective mode — missing or unknown values default to dev. */
export function getProjectMode(project: Project | null | undefined): ProjectMode {
  if (project?.mode === 'workflow') return 'workflow';
  return 'dev';
}

/**
 * A workflow (no-code) project's durable resource directory. Workflow
 * sessions never get a per-session worktree — they run directly in
 * `project.cwd` — so this is the single shared home where all of a no-code
 * project's agent-produced files live. It sits under the project's managed
 * data dir (`<projectsDir>/<id>/workspace`), which is durable (never wiped
 * except on explicit project deletion), unlike the historical `/tmp`
 * placeholder that collided across projects and vanished on reboot.
 */
export function getWorkflowWorkspaceDir(projectDataDir: string): string {
  return path.join(projectDataDir, 'workspace');
}

/**
 * Placeholder cwds that older workflow-create paths stamped when the mode
 * had no real working directory: the client's `/tmp` default and the
 * server's `config.defaultCwd` fallback (or an empty string). These carry
 * no user intent, so backfill may safely repoint them at the managed
 * workspace dir. A cwd the user set to anything else is left untouched.
 */
export function isPlaceholderWorkflowCwd(
  cwd: string | null | undefined,
  defaultCwd: string,
): boolean {
  if (!cwd) return true;
  const trimmed = cwd.replace(/\/+$/, '');
  return trimmed === '/tmp' || trimmed === defaultCwd.replace(/\/+$/, '');
}

/**
 * `sessions.use_worktree` default for new rows. Agent Hub is now
 * worktree-only for all user-facing session flows, so this always
 * returns 1 regardless of project mode. The flag is kept on the
 * row so internal callers (e.g., dev-server wizard) can still spawn
 * shared-checkout sessions when they need to.
 */
export function defaultSessionUseWorktreeFlag(_project: Project | null | undefined): 0 | 1 {
  return 1;
}

/** True only when the session row explicitly opted into worktree isolation. */
export function sessionUsesWorktree(session: { use_worktree: number }): boolean {
  return Number(session.use_worktree) === 1;
}
