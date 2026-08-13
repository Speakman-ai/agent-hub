/**
 * Workflow (no-code) projects never get a per-session worktree and must not
 * boot Firecracker / container session envs. They run on the shared project
 * workspace (`project.cwd`) via the host adapter.
 */
import type { Project, ProjectMode } from '../types.js';
import { getProjectMode } from '../project-mode.js';
import { worktreeSharingForKind, type SessionEnvKind } from './session-env.js';

/** True when this turn should use an env-owned (guest) worktree for CLI spawn. */
export function sessionTurnUsesEnvOwnedWorktree(
  project: Project | null | undefined,
  adapter: SessionEnvKind,
): boolean {
  if (getProjectMode(project) === 'workflow') return false;
  return worktreeSharingForKind(adapter) === 'env-owned';
}

/**
 * Resolve the host path the SessionEnvManager should root an env on.
 * Workflow sessions always use the project workspace; worktree sessions
 * wait for provisioning (`null`) until `worktree_path` is set.
 */
export function resolveSessionWorktreePath(args: {
  worktreePath: string | null | undefined;
  useWorktree: number;
  deletedAt?: string | null;
  projectCwd: string | null | undefined;
  projectMode: ProjectMode;
}): string | null {
  if (args.deletedAt) return null;
  // Workflow sessions always share project.cwd — never a leftover worktree_path
  // from a prior mode (that would split chat vs terminal/preview).
  if (args.projectMode === 'workflow') return args.projectCwd ?? null;
  if (args.worktreePath) return args.worktreePath;
  if (Number(args.useWorktree) === 1) return null;
  return args.projectCwd ?? null;
}

/** Adapter for a session: workflow projects force host (no VM). */
export function resolveSessionEnvAdapterForProject(
  project: Project | null | undefined,
  selected: SessionEnvKind,
): SessionEnvKind {
  if (getProjectMode(project) === 'workflow') return 'host';
  return selected;
}
