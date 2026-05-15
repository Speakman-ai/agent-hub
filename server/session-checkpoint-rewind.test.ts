import { describe, it, expect } from 'vitest';
import {
  engineSupportsCheckpointRewind,
  enrichSessionForClient,
} from './session-checkpoint-rewind.js';
import type { SessionRow } from './types.js';

function minimalSession(overrides: Partial<SessionRow>): SessionRow {
  return {
    id: 's1',
    agent_id: 'a1',
    name: 'Test',
    engine: 'claude-code',
    model: 'claude-opus-4-7',
    engine_session_id: null,
    use_worktree: 1,
    worktree_path: null,
    worktree_branch: null,
    git_worktree_detected: null,
    changes_ready: null,
    stale_pr_notified_at: null,
    ask_mode: 0,
    cron_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
    ...overrides,
  };
}

describe('engineSupportsCheckpointRewind', () => {
  it('is true only for claude-code', () => {
    expect(engineSupportsCheckpointRewind('claude-code')).toBe(true);
    expect(engineSupportsCheckpointRewind('cursor-agent')).toBe(false);
    expect(engineSupportsCheckpointRewind('gemini-cli')).toBe(false);
    expect(engineSupportsCheckpointRewind('codex-cli')).toBe(false);
    expect(engineSupportsCheckpointRewind(null)).toBe(false);
    expect(engineSupportsCheckpointRewind(undefined)).toBe(false);
  });
});

describe('enrichSessionForClient', () => {
  it('sets checkpoint_rewind_supported from engine', () => {
    const claude = enrichSessionForClient(minimalSession({ engine: 'claude-code' }));
    expect(claude.checkpoint_rewind_supported).toBe(true);

    const cursor = enrichSessionForClient(minimalSession({ engine: 'cursor-agent' }));
    expect(cursor.checkpoint_rewind_supported).toBe(false);
  });
});
