/**
 * Dev vs workflow project guards — single place to prevent feature leakage
 * between code-shipping dev projects and Hub-centric workflow projects.
 */
import type { Project } from './types.js';
import { getProjectMode } from './project-mode.js';
import { isConsultBehaviorActive } from './session-mode.js';

export function isWorkflowProject(project: Project | null | undefined): boolean {
  return getProjectMode(project) === 'workflow';
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
  _project: Project | null | undefined,
  _mode: string,
): ProjectGuardError | null {
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
