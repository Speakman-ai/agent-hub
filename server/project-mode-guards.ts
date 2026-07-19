/**
 * Dev vs workflow project guards — single place to prevent feature leakage
 * between code-shipping dev projects and Hub-centric workflow projects.
 */
import type { Project } from './types.js';
import { getProjectMode } from './project-mode.js';
import {
  isConsultBehaviorActive,
  sessionHasUsableWorktree,
  type SessionMode,
} from './session-mode.js';

// Design is allowed on workflow projects: worktree-less design sessions write
// artifacts to a Hub-managed data-dir store (see design-artifact-store.ts)
// instead of a worktree, so the "no worktree" promise of workflow mode holds.
const WORKFLOW_SESSION_MODES = new Set<SessionMode>([
  'consult',
  'scoping',
  'skill-builder',
  'design',
]);

export function isWorkflowProject(project: Project | null | undefined): boolean {
  return getProjectMode(project) === 'workflow';
}

/**
 * Whether a session may enter/run Design mode, considering BOTH storage backends:
 *   - a dev-project session with an isolated worktree (`<worktree>/design/`), or
 *   - a workflow-project session (worktree-less; artifacts in the data-dir store).
 *
 * The single source of truth shared by the mode routes (accept-side), the
 * `can_design_mode` capability the client picker reads, and the chat spawn path
 * — so the option is offered exactly when a design turn can actually produce
 * artifacts. A dev-project session with no worktree still cannot design.
 */
export function sessionCanUseDesignMode(
  session: { worktree_path?: string | null } | null | undefined,
  project: Project | null | undefined,
): boolean {
  return sessionHasUsableWorktree(session) || isWorkflowProject(project);
}

export function isDevProject(project: Project | null | undefined): boolean {
  return !isWorkflowProject(project);
}

/** Finalize / ship automation is a dev-project-only surface. */
export function finalizeAllowedForProject(project: Project | null | undefined): boolean {
  return isDevProject(project);
}

export type ProjectGuardError = {
  error: string;
  message: string;
};

export function validateSessionModeForProject(
  project: Project | null | undefined,
  mode: string,
): ProjectGuardError | null {
  if (isWorkflowProject(project) && !WORKFLOW_SESSION_MODES.has(mode as SessionMode)) {
    return {
      error: 'session_mode_not_allowed_on_workflow_project',
      message:
        'Workflow projects only support Consult, Scoping, and Skill Builder session modes. Use a dev project for build/chat-style sessions.',
    };
  }
  return null;
}

export function validateFinalizeAutomationForProject(
  project: Project | null | undefined,
  level: string,
): ProjectGuardError | null {
  if (!isWorkflowProject(project)) return null;
  if (level === 'manual') return null;
  return {
    error: 'finalize_not_allowed_on_workflow_project',
    message:
      'Workflow projects do not use Finalize or ship automation. Use Consult, Scoping, or other workflow session modes.',
  };
}

export function workflowFinalizeBlockedResponse(): ProjectGuardError {
  return {
    error: 'finalize_not_allowed_on_workflow_project',
    message:
      'Finalize Code Changes is not available on workflow projects. Use workflow runs or Hub consult sessions instead.',
  };
}

/** True when auto-finalize / manual finalize must not run for this session row. */
export function sessionBlocksFinalize(
  project: Project | null | undefined,
  session: { session_mode?: string | null; ask_mode?: number | null } | null | undefined,
): boolean {
  if (isWorkflowProject(project)) return true;
  if (isConsultBehaviorActive(session)) return true;
  return false;
}
