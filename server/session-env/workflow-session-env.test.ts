import { describe, expect, it } from 'vitest';
import type { Project } from '../types.js';
import {
  resolveSessionEnvAdapterForProject,
  resolveSessionWorktreePath,
  sessionTurnUsesEnvOwnedWorktree,
} from './workflow-session-env.js';

function project(mode: Project['mode']): Project {
  return {
    id: 'p',
    name: 'P',
    cwd: '/home/node/.agent-hub/projects/p/workspace',
    mode,
  } as Project;
}

describe('sessionTurnUsesEnvOwnedWorktree', () => {
  it('is false for workflow projects even when Firecracker is selected', () => {
    expect(sessionTurnUsesEnvOwnedWorktree(project('workflow'), 'firecracker')).toBe(false);
  });

  it('is true for dev projects on Firecracker', () => {
    expect(sessionTurnUsesEnvOwnedWorktree(project('dev'), 'firecracker')).toBe(true);
    expect(sessionTurnUsesEnvOwnedWorktree(project(undefined), 'firecracker')).toBe(true);
  });

  it('is false for host-shared adapters', () => {
    expect(sessionTurnUsesEnvOwnedWorktree(project('dev'), 'host')).toBe(false);
    expect(sessionTurnUsesEnvOwnedWorktree(project('dev'), 'container')).toBe(false);
  });
});

describe('resolveSessionEnvAdapterForProject', () => {
  it('forces host for workflow projects', () => {
    expect(resolveSessionEnvAdapterForProject(project('workflow'), 'firecracker')).toBe('host');
    expect(resolveSessionEnvAdapterForProject(project('workflow'), 'container')).toBe('host');
  });

  it('keeps the selected adapter for dev projects', () => {
    expect(resolveSessionEnvAdapterForProject(project('dev'), 'firecracker')).toBe('firecracker');
  });
});

describe('resolveSessionWorktreePath', () => {
  const cwd = '/home/node/.agent-hub/projects/3d-models/workspace';

  it('returns project cwd for workflow sessions without a worktree_path', () => {
    expect(
      resolveSessionWorktreePath({
        worktreePath: null,
        useWorktree: 1,
        projectCwd: cwd,
        projectMode: 'workflow',
      }),
    ).toBe(cwd);
  });

  it('waits (null) for unfinished worktree provisioning on dev sessions', () => {
    expect(
      resolveSessionWorktreePath({
        worktreePath: null,
        useWorktree: 1,
        projectCwd: cwd,
        projectMode: 'dev',
      }),
    ).toBeNull();
  });

  it('prefers an existing worktree_path', () => {
    expect(
      resolveSessionWorktreePath({
        worktreePath: '/tmp/wt',
        useWorktree: 1,
        projectCwd: cwd,
        projectMode: 'workflow',
      }),
    ).toBe('/tmp/wt');
  });

  it('returns null for deleted sessions', () => {
    expect(
      resolveSessionWorktreePath({
        worktreePath: null,
        useWorktree: 1,
        deletedAt: '2026-01-01',
        projectCwd: cwd,
        projectMode: 'workflow',
      }),
    ).toBeNull();
  });
});
