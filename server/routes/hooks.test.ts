import { describe, it, expect } from 'vitest';
import { effectiveCwdForSession } from './hooks.js';
import type { SessionRow } from '../types.js';

function baseSession(overrides: Partial<SessionRow>): SessionRow {
  return {
    id: 's1',
    agent_id: 'a1',
    name: 'Test',
    engine: 'claude-code',
    model: 'opus',
    engine_session_id: null,
    use_worktree: 1,
    worktree_path: '/wt',
    worktree_branch: null,
    git_worktree_detected: null,
    changes_ready: null,
    stale_pr_notified_at: null,
    ask_mode: 0,
    cron_id: null,
    created_at: '',
    updated_at: '',
    deleted_at: null,
    ...overrides,
  };
}

describe('effectiveCwdForSession', () => {
  it('uses project cwd when worktree is disabled even if worktree_path is set', () => {
    const cwd = effectiveCwdForSession(
      '/proj',
      baseSession({ use_worktree: 0, worktree_path: '/stale-wt' }),
    );
    expect(cwd).toBe('/proj');
  });

  it('uses worktree_path when worktree is enabled', () => {
    const cwd = effectiveCwdForSession(
      '/proj',
      baseSession({ use_worktree: 1, worktree_path: '/wt' }),
    );
    expect(cwd).toBe('/wt');
  });

  it('uses project cwd when worktree is enabled but path missing', () => {
    const cwd = effectiveCwdForSession(
      '/proj',
      baseSession({ use_worktree: 1, worktree_path: null }),
    );
    expect(cwd).toBe('/proj');
  });
});
