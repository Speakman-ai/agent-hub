import { describe, it, expect } from 'vitest';
import type { Project } from './types.js';
import {
  finalizeAllowedForProject,
  isDevProject,
  isWorkflowProject,
  sessionBlocksFinalize,
  validateFinalizeAutomationForProject,
  validateSessionModeForProject,
} from './project-mode-guards.js';

const devProject = { id: 'dev', mode: 'dev' } as Project;
const workflowProject = { id: 'wf', mode: 'workflow' } as Project;

describe('project-mode-guards', () => {
  it('classifies dev vs workflow projects', () => {
    expect(isWorkflowProject(workflowProject)).toBe(true);
    expect(isWorkflowProject(devProject)).toBe(false);
    expect(isDevProject(devProject)).toBe(true);
    expect(finalizeAllowedForProject(devProject)).toBe(true);
    expect(finalizeAllowedForProject(workflowProject)).toBe(false);
  });

  it('allows non-shipping session modes on both dev and workflow projects', () => {
    expect(validateSessionModeForProject(workflowProject, 'consult')).toBeNull();
    expect(validateSessionModeForProject(workflowProject, 'scoping')).toBeNull();
    expect(validateSessionModeForProject(workflowProject, 'skill-builder')).toBeNull();
    expect(validateSessionModeForProject(devProject, 'consult')).toBeNull();
    expect(validateSessionModeForProject(devProject, 'scoping')).toBeNull();
    expect(validateSessionModeForProject(devProject, 'skill-builder')).toBeNull();
  });

  it('blocks build/chat-style session modes on workflow projects', () => {
    expect(validateSessionModeForProject(workflowProject, 'chat')?.error).toBe(
      'session_mode_not_allowed_on_workflow_project',
    );
    expect(validateSessionModeForProject(workflowProject, 'design')?.error).toBe(
      'session_mode_not_allowed_on_workflow_project',
    );
  });

  it('blocks ship automation on workflow projects only', () => {
    expect(validateFinalizeAutomationForProject(workflowProject, 'manual')).toBeNull();
    expect(validateFinalizeAutomationForProject(workflowProject, 'push')?.error).toBe(
      'finalize_not_allowed_on_workflow_project',
    );
    expect(validateFinalizeAutomationForProject(devProject, 'merge')).toBeNull();
  });

  it('blocks finalize for workflow projects and consult sessions', () => {
    expect(sessionBlocksFinalize(workflowProject, { session_mode: 'chat' })).toBe(true);
    expect(sessionBlocksFinalize(devProject, { session_mode: 'consult' })).toBe(true);
    expect(sessionBlocksFinalize(devProject, { session_mode: 'chat', ask_mode: 1 })).toBe(true);
    expect(sessionBlocksFinalize(devProject, { session_mode: 'chat' })).toBe(false);
  });
});
