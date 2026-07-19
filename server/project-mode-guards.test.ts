import { describe, it, expect } from 'vitest';
import type { Project } from './types.js';
import {
  finalizeAllowedForProject,
  isDevProject,
  isWorkflowProject,
  sessionBlocksFinalize,
  sessionCanUseDesignMode,
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

  it('allows non-shipping session modes (incl. design) on both dev and workflow projects', () => {
    expect(validateSessionModeForProject(workflowProject, 'consult')).toBeNull();
    expect(validateSessionModeForProject(workflowProject, 'scoping')).toBeNull();
    expect(validateSessionModeForProject(workflowProject, 'skill-builder')).toBeNull();
    // Design is now allowed on workflow projects (data-dir artifact store).
    expect(validateSessionModeForProject(workflowProject, 'design')).toBeNull();
    expect(validateSessionModeForProject(devProject, 'consult')).toBeNull();
    expect(validateSessionModeForProject(devProject, 'scoping')).toBeNull();
    expect(validateSessionModeForProject(devProject, 'skill-builder')).toBeNull();
    expect(validateSessionModeForProject(devProject, 'design')).toBeNull();
  });

  it('blocks build/chat-style (shipping) session modes on workflow projects', () => {
    expect(validateSessionModeForProject(workflowProject, 'chat')?.error).toBe(
      'session_mode_not_allowed_on_workflow_project',
    );
  });

  it('sessionCanUseDesignMode: worktree (dev) OR workflow project', () => {
    const withWorktree = { worktree_path: '/ws/s1' };
    const noWorktree = { worktree_path: null };
    // Dev project: needs a worktree.
    expect(sessionCanUseDesignMode(withWorktree, devProject)).toBe(true);
    expect(sessionCanUseDesignMode(noWorktree, devProject)).toBe(false);
    // Workflow project: allowed even without a worktree (data-dir store).
    expect(sessionCanUseDesignMode(noWorktree, workflowProject)).toBe(true);
    expect(sessionCanUseDesignMode(withWorktree, workflowProject)).toBe(true);
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
