import { describe, it, expect, vi } from 'vitest';
import type { KanbanCardRow, KanbanColumnRow, Stmts } from './types.js';
import {
  buildPostVerifyCardCloseSystemMessage,
  runVerifiedCloseCardFlow,
} from './verify-before-done-close-card.js';

describe('buildPostVerifyCardCloseSystemMessage', () => {
  it('returns moved copy when close succeeds', () => {
    const msg = buildPostVerifyCardCloseSystemMessage({
      ok: true,
      result: {
        cardId: 'c1',
        previousColumnId: 'col-a',
        doneColumnId: 'col-done',
        commentId: 'cm1',
      },
    });
    expect(msg.content).toContain('moved to Done');
    expect(msg.meta.cardClose).toBe('moved');
    expect(msg.meta.cardId).toBe('c1');
  });

  it('returns honest copy for move_failed', () => {
    const msg = buildPostVerifyCardCloseSystemMessage({ ok: false, reason: 'move_failed' });
    expect(msg.content).toContain('moving the linked card');
    expect(msg.meta.outcome).toBe('verify_passed_card_close_failed');
    expect(msg.meta.cardClose).toBe('move_failed');
  });

  it('returns honest copy for no_linked_card', () => {
    const msg = buildPostVerifyCardCloseSystemMessage({ ok: false, reason: 'no_linked_card' });
    expect(msg.content).toContain('no kanban card is linked');
  });

  it('returns already_in_done when the card was already in the Done column', () => {
    const msg = buildPostVerifyCardCloseSystemMessage({
      ok: true,
      result: {
        cardId: 'c1',
        previousColumnId: 'col-done',
        doneColumnId: 'col-done',
        commentId: 'cm1',
      },
    });
    expect(msg.content).toContain('**already in Done**');
    expect(msg.content).not.toMatch(/was moved to Done/i);
    expect(msg.content).toContain('**attempts**');
    expect(msg.meta.cardClose).toBe('already_in_done');
  });

  it('appends verify transcript when options.verifyTranscript is set', () => {
    const msg = buildPostVerifyCardCloseSystemMessage(
      {
        ok: true,
        result: {
          cardId: 'c1',
          previousColumnId: 'col-a',
          doneColumnId: 'col-done',
          commentId: 'cm1',
        },
      },
      { verifyTranscript: 'npm test\nok\n' },
    );
    expect(msg.content).toContain('moved to Done');
    expect(msg.content).toContain('**Verify command output:**');
    expect(msg.content).toContain('    npm test');
    expect(msg.content).toContain('    ok');
  });
});

describe('runVerifiedCloseCardFlow', () => {
  const card: KanbanCardRow = {
    id: 'card-1',
    column_id: 'col-ip',
    board_id: 'board-1',
    title: 'T',
    description: null,
    priority: 'medium',
    assignee: null,
    labels: null,
    session_id: 'sess-1',
    github_issue_url: null,
    pr_url: null,
    review_status: null,
    created_by: null,
    position: 0,
    epic_id: null,
    documented: 0,
    autonomous_iterations: 0,
    dispatched_by_autonomous: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };

  const doneCol: KanbanColumnRow = {
    id: 'col-done',
    board_id: 'board-1',
    name: 'Done',
    position: 4,
    color: null,
    created_at: '2026-01-01T00:00:00Z',
  };

  function stmtsForHappyPath(): Stmts {
    return {
      getKanbanCardBySession: { get: vi.fn().mockReturnValue(card) },
      getKanbanColumns: { all: vi.fn().mockReturnValue([doneCol]) },
      moveKanbanCard: { run: vi.fn() },
      createKanbanCardComment: { run: vi.fn() },
      getKanbanCard: { get: vi.fn().mockReturnValue(undefined) },
    } as unknown as Stmts;
  }

  it('broadcasts log lines, runs verify, and persists passed on green path', async () => {
    const broadcasts: Array<Record<string, unknown>> = [];
    const persists: Array<{ content: string; meta: Record<string, unknown> }> = [];

    await runVerifiedCloseCardFlow({
      sessionId: 'sess-1',
      closeTask: { reason: 'already-done', note: 'ok' },
      project: { id: 'proj-x', verifyBeforeDoneCommands: ['true'] } as never,
      effectiveCwd: '/tmp',
      projectId: 'proj-x',
      author: 'agent',
      stmts: stmtsForHappyPath(),
      broadcast: (m) => broadcasts.push(m as Record<string, unknown>),
      persistSystemMessage: (_sid, content, meta) => persists.push({ content, meta }),
      runVerifyFn: async (_p, _cwd, onChunk) => {
        onChunk?.('lint ok\n');
      },
    });

    expect(broadcasts.some((b) => b.type === 'done_verify_log')).toBe(true);
    expect(
      broadcasts.filter((b) => b.type === 'done_verify_log_done').length,
    ).toBeGreaterThanOrEqual(1);
    expect(persists).toHaveLength(1);
    expect(persists[0].meta.outcome).toBe('passed');
    expect(persists[0].content).toContain('moved to Done');
    expect(persists[0].content).toContain('**Verify command output:**');
    expect(persists[0].content).toContain('lint ok');
  });

  it('persists failed body without fenced code when verify throws', async () => {
    const persists: Array<{ content: string }> = [];

    await runVerifiedCloseCardFlow({
      sessionId: 'sess-1',
      closeTask: { reason: 'already-done', note: 'ok' },
      project: { id: 'proj-x', verifyBeforeDoneCommands: ['false'] } as never,
      effectiveCwd: '/tmp',
      projectId: 'proj-x',
      author: 'agent',
      stmts: stmtsForHappyPath(),
      broadcast: vi.fn(),
      persistSystemMessage: (_sid, content) => persists.push({ content }),
      runVerifyFn: async (_p, _cwd, onChunk) => {
        onChunk?.('before boom\n');
        throw new Error('exit 1');
      },
    });

    expect(persists).toHaveLength(1);
    expect(persists[0].content).not.toContain('```');
    expect(persists[0].content).toContain('before boom');
    expect(persists[0].content).toContain('exit 1');
  });

  it('persists verify_passed_card_close_failed when commands pass but move fails', async () => {
    const persists: Array<{ content: string; meta: Record<string, unknown> }> = [];
    const stmts = {
      getKanbanCardBySession: { get: vi.fn().mockReturnValue(card) },
      getKanbanColumns: { all: vi.fn().mockReturnValue([doneCol]) },
      moveKanbanCard: {
        run: vi.fn().mockImplementation(() => {
          throw new Error('db');
        }),
      },
      createKanbanCardComment: { run: vi.fn() },
      getKanbanCard: { get: vi.fn().mockReturnValue(undefined) },
    } as unknown as Stmts;

    await runVerifiedCloseCardFlow({
      sessionId: 'sess-1',
      closeTask: { reason: 'already-done', note: 'ok' },
      project: { id: 'proj-x', verifyBeforeDoneCommands: ['true'] } as never,
      effectiveCwd: '/tmp',
      projectId: 'proj-x',
      author: 'agent',
      stmts,
      broadcast: vi.fn(),
      persistSystemMessage: (_sid, content, meta) => persists.push({ content, meta }),
      runVerifyFn: async () => {},
    });

    expect(persists[0].meta.outcome).toBe('verify_passed_card_close_failed');
    expect(persists[0].content).toContain('moving the linked card');
    expect(persists[0].content).toContain('**Verify command output:**');
  });
});
