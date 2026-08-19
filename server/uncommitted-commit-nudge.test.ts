import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent, SessionRow } from './types.js';
import {
  triggerUncommittedCommitNudge,
  resetCommitNudgeInFlightForTests,
  buildCommitNudgeMetadata,
} from './uncommitted-commit-nudge.js';
import { COMMIT_NUDGE_KIND, COMMIT_NUDGE_SYSTEM_MESSAGE } from './local-commit-reminder.js';

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-1',
    agent_id: 'agent-1',
    name: 'Work',
    engine: 'grok-cli',
    model: 'grok-4.6',
    engine_session_id: null,
    use_worktree: 1,
    worktree_path: '/tmp/wt',
    worktree_branch: 'agent-hub/dev/session-1',
    git_worktree_detected: 1,
    changes_ready: null,
    stale_pr_notified_at: null,
    ask_mode: 0,
    cron_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  } as SessionRow;
}

describe('triggerUncommittedCommitNudge', () => {
  beforeEach(() => {
    resetCommitNudgeInFlightForTests();
  });

  it('persists a system callout and starts a commit turn', async () => {
    const handleChat = vi.fn().mockResolvedValue(undefined);
    const broadcast = vi.fn();
    const addMessage = vi.fn();
    const touchSession = vi.fn();
    const getMessageById = { get: vi.fn(() => undefined) };
    const stmts = {
      addMessage: { run: addMessage },
      touchSession: { run: touchSession },
      getMessageById,
    };
    const agent = { id: 'agent-1', name: 'Dev', role: 'dev' } as Agent;

    const result = triggerUncommittedCommitNudge({
      sessionId: 'sess-1',
      session: makeSession(),
      agent,
      stmts: stmts as never,
      broadcast,
      activeProcesses: new Map(),
      branch: 'agent-hub/dev/session-1',
      porcelain: 'M server/foo.ts',
      handleChat,
    });

    expect(result).toEqual({ ok: true });
    expect(addMessage).toHaveBeenCalled();
    const addArgs = addMessage.mock.calls[0] as unknown[];
    expect(addArgs[2]).toBe('system');
    expect(addArgs[3]).toBe(COMMIT_NUDGE_SYSTEM_MESSAGE);
    expect(addArgs[7]).toBe(buildCommitNudgeMetadata());
    expect(JSON.parse(String(addArgs[7]))).toEqual({ kind: COMMIT_NUDGE_KIND });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({ role: 'system' }),
      }),
    );

    await Promise.resolve();
    expect(handleChat).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        type: 'chat',
        sessionId: 'sess-1',
        agentId: 'agent-1',
        _skipUserMessagePersist: true,
        content: expect.stringContaining('M server/foo.ts'),
      }),
    );
  });

  it('refuses ask-mode and missing worktree sessions', () => {
    const handleChat = vi.fn();
    const base = {
      agent: { id: 'agent-1', name: 'Dev' } as Agent,
      stmts: {
        addMessage: { run: vi.fn() },
        touchSession: { run: vi.fn() },
        getMessageById: { get: vi.fn() },
      } as never,
      broadcast: vi.fn(),
      activeProcesses: new Map(),
      branch: 'x',
      handleChat,
    };

    expect(
      triggerUncommittedCommitNudge({
        ...base,
        sessionId: 'sess-ask',
        session: makeSession({ ask_mode: 1 }),
      }),
    ).toMatchObject({ ok: false, code: 'ask_mode' });

    expect(
      triggerUncommittedCommitNudge({
        ...base,
        sessionId: 'sess-nowt',
        session: makeSession({ worktree_path: null }),
      }),
    ).toMatchObject({ ok: false, code: 'no_worktree' });

    expect(handleChat).not.toHaveBeenCalled();
  });
});
