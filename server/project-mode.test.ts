import { describe, it, expect } from 'vitest';
import {
  getProjectMode,
  defaultSessionUseWorktreeFlag,
  sessionUsesWorktree,
  getWorkflowWorkspaceDir,
  isPlaceholderWorkflowCwd,
} from './project-mode.js';
import type { Project } from './types.js';

describe('project-mode', () => {
  it('getProjectMode defaults to dev', () => {
    expect(getProjectMode(undefined)).toBe('dev');
    expect(getProjectMode(null)).toBe('dev');
    expect(getProjectMode({} as Project)).toBe('dev');
    expect(getProjectMode({ mode: 'dev' } as Project)).toBe('dev');
  });

  it('getProjectMode recognizes workflow', () => {
    expect(getProjectMode({ mode: 'workflow' } as Project)).toBe('workflow');
  });

  it('sessionUsesWorktree is true only for explicit 1', () => {
    expect(sessionUsesWorktree({ use_worktree: 1 })).toBe(true);
    expect(sessionUsesWorktree({ use_worktree: 0 })).toBe(false);
  });

  it('getWorkflowWorkspaceDir nests a workspace dir under the data dir', () => {
    expect(getWorkflowWorkspaceDir('/data/projects/foo')).toBe('/data/projects/foo/workspace');
  });

  it('isPlaceholderWorkflowCwd flags /tmp, empty, and the default cwd only', () => {
    const defaultCwd = '/home/agent';
    expect(isPlaceholderWorkflowCwd('/tmp', defaultCwd)).toBe(true);
    expect(isPlaceholderWorkflowCwd('/tmp/', defaultCwd)).toBe(true);
    expect(isPlaceholderWorkflowCwd('', defaultCwd)).toBe(true);
    expect(isPlaceholderWorkflowCwd(null, defaultCwd)).toBe(true);
    expect(isPlaceholderWorkflowCwd(undefined, defaultCwd)).toBe(true);
    expect(isPlaceholderWorkflowCwd('/home/agent', defaultCwd)).toBe(true);
    expect(isPlaceholderWorkflowCwd('/home/agent/', defaultCwd)).toBe(true);
    // A deliberately-set path is left untouched.
    expect(isPlaceholderWorkflowCwd('/var/data/mine', defaultCwd)).toBe(false);
    expect(isPlaceholderWorkflowCwd('/data/projects/foo/workspace', defaultCwd)).toBe(false);
  });

  it('defaultSessionUseWorktreeFlag is 1 for every project (worktree-only)', () => {
    // Agent Hub is now worktree-only for user-facing session flows. The
    // project-mode coupling was removed; internal callers that need a
    // shared-checkout session (preview-wizard) bypass this helper and
    // write directly to `stmts.createSession`.
    expect(defaultSessionUseWorktreeFlag({ mode: 'workflow' } as Project)).toBe(1);
    expect(defaultSessionUseWorktreeFlag({ mode: 'dev' } as Project)).toBe(1);
    expect(defaultSessionUseWorktreeFlag({} as Project)).toBe(1);
    expect(defaultSessionUseWorktreeFlag(undefined)).toBe(1);
    expect(defaultSessionUseWorktreeFlag(null)).toBe(1);
  });
});
