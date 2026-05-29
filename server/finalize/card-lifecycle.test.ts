/**
 * Tests for the Finalize → kanban card surface mirror.
 *
 * We pin every method against:
 *   - the exact comment string written to `kanban_card_comments`
 *   - the move semantics (target column resolution + idempotency)
 *   - the broadcast events emitted alongside the writes
 *
 * The lifecycle module is the human-facing audit trail for a finalize
 * run; if a wording change slips through here the user thread on the
 * card becomes ambiguous, so the regex / equality matchers are
 * deliberately strict.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  createCardLifecycle,
  NOOP_CARD_LIFECYCLE,
  type CardLifecycleDeps,
} from './card-lifecycle.js';
import type { KanbanCardRow, KanbanColumnRow } from '../types.js';

// ─── Fixtures ────────────────────────────────────────────────────────

function fakeCard(overrides: Partial<KanbanCardRow> = {}): KanbanCardRow {
  return {
    id: 'card-1',
    column_id: 'col-todo',
    board_id: 'board-1',
    title: 'Finalize me',
    description: '',
    priority: 'medium',
    assignee: 'agent-1',
    labels: '',
    session_id: 'sess-1',
    github_issue_url: null,
    pr_url: null,
    position: 0,
    created_by: 'user-1',
    assign_model: null,
    assign_engine: null,
    epic_id: null,
    pr_base_branch: null,
    documented: 0,
    dispatched_by_autonomous: 0,
    review_status: null,
    ...overrides,
  } as unknown as KanbanCardRow;
}

const COLUMNS: KanbanColumnRow[] = [
  { id: 'col-todo', board_id: 'board-1', name: 'To Do', position: 0, color: null, created_at: '' },
  {
    id: 'col-progress',
    board_id: 'board-1',
    name: 'In Progress',
    position: 1,
    color: null,
    created_at: '',
  },
  {
    id: 'col-review',
    board_id: 'board-1',
    name: 'Review',
    position: 2,
    color: null,
    created_at: '',
  },
  { id: 'col-done', board_id: 'board-1', name: 'Done', position: 3, color: null, created_at: '' },
];

interface RecordedComment {
  id: string;
  cardId: string;
  author: string;
  content: string;
}

interface RecordedMove {
  columnId: string;
  position: number;
  cardId: string;
}

function makeDeps(cardOverride: Partial<KanbanCardRow> = {}): {
  deps: CardLifecycleDeps;
  card: KanbanCardRow;
  comments: RecordedComment[];
  moves: RecordedMove[];
  broadcast: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
} {
  const card = fakeCard(cardOverride);
  const comments: RecordedComment[] = [];
  const moves: RecordedMove[] = [];
  const broadcast = vi.fn();
  const log = vi.fn();
  let idCounter = 0;
  const deps: CardLifecycleDeps = {
    stmts: {
      getKanbanCard: {
        get: vi.fn((id: string) => (id === card.id ? card : undefined)),
      } as unknown as CardLifecycleDeps['stmts']['getKanbanCard'],
      getKanbanColumns: {
        all: vi.fn((boardId: string) =>
          boardId === card.board_id ? COLUMNS : ([] as KanbanColumnRow[]),
        ),
      } as unknown as CardLifecycleDeps['stmts']['getKanbanColumns'],
      moveKanbanCard: {
        run: vi.fn((columnId: string, position: number, cardId: string) => {
          moves.push({ columnId, position, cardId });
          if (cardId === card.id) card.column_id = columnId;
        }),
      } as unknown as CardLifecycleDeps['stmts']['moveKanbanCard'],
      createKanbanCardComment: {
        run: vi.fn((id: string, cardId: string, author: string, content: string) => {
          comments.push({ id, cardId, author, content });
        }),
      } as unknown as CardLifecycleDeps['stmts']['createKanbanCardComment'],
    },
    broadcast,
    newId: () => `comment-${++idCounter}`,
    log,
  };
  return { deps, card, comments, moves, broadcast, log };
}

// ─── NOOP ────────────────────────────────────────────────────────────

describe('NOOP_CARD_LIFECYCLE', () => {
  it('exposes every method and returns without side effects', () => {
    expect(typeof NOOP_CARD_LIFECYCLE.onStarted).toBe('function');
    expect(
      NOOP_CARD_LIFECYCLE.onStarted({ runId: 'r1', triggerSource: 'ui_button' }),
    ).toBeUndefined();
    expect(NOOP_CARD_LIFECYCLE.onRebaseClean({ runId: 'r1' })).toBeUndefined();
    expect(NOOP_CARD_LIFECYCLE.onRebaseConflictDispatched({ runId: 'r1' })).toBeUndefined();
    expect(NOOP_CARD_LIFECYCLE.onRebaseAborted({ runId: 'r1', detail: 'x' })).toBeUndefined();
    expect(
      NOOP_CARD_LIFECYCLE.onReviewerVerdict({ runId: 'r1', verdict: 'approved' }),
    ).toBeUndefined();
    expect(
      NOOP_CARD_LIFECYCLE.onStepFailed({ runId: 'r1', stepName: 'a', exitCode: 1 }),
    ).toBeUndefined();
    expect(NOOP_CARD_LIFECYCLE.onPushed({ runId: 'r1', prUrl: 'https://x' })).toBeUndefined();
    expect(NOOP_CARD_LIFECYCLE.onStalled({ runId: 'r1' })).toBeUndefined();
  });
});

// ─── onStarted ───────────────────────────────────────────────────────

describe('createCardLifecycle.onStarted', () => {
  it('moves the card to In Progress and posts the start comment', () => {
    const { deps, comments, moves, broadcast } = makeDeps({ column_id: 'col-todo' });
    const lc = createCardLifecycle(deps, { cardId: 'card-1', projectId: 'proj-1' });

    lc.onStarted({ runId: 'run-abc', triggerSource: 'ui_button' });

    expect(moves).toEqual([{ columnId: 'col-progress', position: 0, cardId: 'card-1' }]);
    expect(comments).toEqual([
      {
        id: 'comment-1',
        cardId: 'card-1',
        author: 'finalize',
        content: 'Finalize started (run run-abc) · trigger=ui_button',
      },
    ]);
    // Both `kanban_update` events fire (one per write) AND the
    // `card_moved` event fires (mirrors the manual move endpoint shape).
    const types = broadcast.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain('kanban_update');
    expect(types).toContain('card_moved');
    const moveBroadcast = broadcast.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((e) => e.type === 'card_moved');
    expect(moveBroadcast).toMatchObject({
      projectId: 'proj-1',
      cardId: 'card-1',
      columnName: 'In Progress',
    });
  });

  it('skips the move when the card is already in In Progress (idempotent)', () => {
    const { deps, moves, comments } = makeDeps({ column_id: 'col-progress' });
    const lc = createCardLifecycle(deps, { cardId: 'card-1', projectId: 'proj-1' });

    lc.onStarted({ runId: 'run-abc', triggerSource: 'agent_block' });

    expect(moves).toHaveLength(0);
    // Comment still fires.
    expect(comments).toHaveLength(1);
    expect(comments[0].content).toContain('trigger=agent_block');
  });

  it('uses the configured author when set', () => {
    const { deps, comments } = makeDeps();
    const lc = createCardLifecycle(deps, {
      cardId: 'card-1',
      projectId: 'proj-1',
      author: 'finalize-bot',
    });
    lc.onStarted({ runId: 'r', triggerSource: 'ui_button' });
    expect(comments[0].author).toBe('finalize-bot');
  });

  it('honors custom in-progress column name', () => {
    const customCols: KanbanColumnRow[] = [
      ...COLUMNS,
      {
        id: 'col-doing',
        board_id: 'board-1',
        name: 'Doing',
        position: 5,
        color: null,
        created_at: '',
      },
    ];
    const { deps, moves } = makeDeps();
    (deps.stmts.getKanbanColumns as unknown as { all: ReturnType<typeof vi.fn> }).all = vi.fn(
      () => customCols,
    );
    const lc = createCardLifecycle(deps, {
      cardId: 'card-1',
      projectId: 'proj-1',
      inProgressColumnName: 'Doing',
    });
    lc.onStarted({ runId: 'r', triggerSource: 'ui_button' });
    expect(moves[0].columnId).toBe('col-doing');
  });

  it('logs and skips the move when the target column is missing', () => {
    const { deps, moves, log, comments } = makeDeps();
    (deps.stmts.getKanbanColumns as unknown as { all: ReturnType<typeof vi.fn> }).all = vi.fn(
      () => [COLUMNS[0]], // only "To Do" present
    );
    const lc = createCardLifecycle(deps, { cardId: 'card-1', projectId: 'proj-1' });
    lc.onStarted({ runId: 'r', triggerSource: 'ui_button' });
    expect(moves).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('column "In Progress" not found'));
    // Comment still goes through.
    expect(comments).toHaveLength(1);
  });

  it('logs and skips when the card row vanished mid-run', () => {
    const { deps, log, moves } = makeDeps();
    (deps.stmts.getKanbanCard as unknown as { get: ReturnType<typeof vi.fn> }).get = vi.fn(
      () => undefined,
    );
    const lc = createCardLifecycle(deps, { cardId: 'card-1', projectId: 'proj-1' });
    lc.onStarted({ runId: 'r', triggerSource: 'ui_button' });
    expect(moves).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });
});

// ─── Rebase comments ─────────────────────────────────────────────────

describe('createCardLifecycle — rebase transitions', () => {
  it('onRebaseClean posts the clean comment, no move', () => {
    const { deps, comments, moves } = makeDeps();
    const lc = createCardLifecycle(deps, { cardId: 'card-1', projectId: 'proj-1' });
    lc.onRebaseClean({ runId: 'r1' });
    expect(comments[0].content).toBe('Rebase: clean (run r1)');
    expect(moves).toHaveLength(0);
  });

  it('onRebaseConflictDispatched posts the dispatched-to-session comment', () => {
    const { deps, comments } = makeDeps();
    const lc = createCardLifecycle(deps, { cardId: 'card-1', projectId: 'proj-1' });
    lc.onRebaseConflictDispatched({ runId: 'r1' });
    expect(comments[0].content).toBe('Rebase: conflict dispatched to session (run r1)');
  });

  it('onRebaseAborted posts the abort comment with the detail', () => {
    const { deps, comments } = makeDeps();
    const lc = createCardLifecycle(deps, { cardId: 'card-1', projectId: 'proj-1' });
    lc.onRebaseAborted({ runId: 'r1', detail: 'session never resolved' });
    expect(comments[0].content).toBe('Rebase: aborted — session never resolved (run r1)');
  });
});

// ─── Reviewer verdict + step failed ──────────────────────────────────

describe('createCardLifecycle — reviewer + step', () => {
  it('onReviewerVerdict approved', () => {
    const { deps, comments } = makeDeps();
    const lc = createCardLifecycle(deps, { cardId: 'card-1', projectId: 'proj-1' });
    lc.onReviewerVerdict({ runId: 'r1', verdict: 'approved' });
    expect(comments[0].content).toBe('Reviewer verdict: approved (run r1)');
  });

  it('onReviewerVerdict changes_requested', () => {
    const { deps, comments } = makeDeps();
    const lc = createCardLifecycle(deps, { cardId: 'card-1', projectId: 'proj-1' });
    lc.onReviewerVerdict({ runId: 'r1', verdict: 'changes_requested' });
    expect(comments[0].content).toBe('Reviewer verdict: changes_requested (run r1)');
  });

  it('onStepFailed includes step name and exit code', () => {
    const { deps, comments } = makeDeps();
    const lc = createCardLifecycle(deps, { cardId: 'card-1', projectId: 'proj-1' });
    lc.onStepFailed({ runId: 'r1', stepName: 'Test', exitCode: 1 });
    expect(comments[0].content).toBe(
      'Step Test failed (exit 1) — fix dispatched to session (run r1)',
    );
  });
});

// ─── onPushed: comment + move to Review ──────────────────────────────

describe('createCardLifecycle.onPushed', () => {
  it('posts PR URL comment then moves card to Review (order matters)', () => {
    const { deps, comments, moves, broadcast } = makeDeps({ column_id: 'col-progress' });
    const lc = createCardLifecycle(deps, { cardId: 'card-1', projectId: 'proj-1' });
    lc.onPushed({ runId: 'r1', prUrl: 'https://github.com/o/r/pull/42' });
    expect(comments[0].content).toBe('Pushed to GitHub: https://github.com/o/r/pull/42 (run r1)');
    expect(moves).toEqual([{ columnId: 'col-review', position: 0, cardId: 'card-1' }]);
    // The order of broadcasts: comment broadcast (kanban_update) before
    // the move broadcasts (kanban_update + card_moved).
    const types = broadcast.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toEqual(['kanban_update', 'kanban_update', 'card_moved']);
  });

  it('is idempotent: card already in Review → no second move', () => {
    const { deps, moves, comments } = makeDeps({ column_id: 'col-review' });
    const lc = createCardLifecycle(deps, { cardId: 'card-1', projectId: 'proj-1' });
    lc.onPushed({ runId: 'r1', prUrl: 'https://x' });
    // Comment still posted; move skipped.
    expect(comments).toHaveLength(1);
    expect(moves).toHaveLength(0);
  });
});

// ─── onStalled ───────────────────────────────────────────────────────

describe('createCardLifecycle.onStalled', () => {
  it('posts the 24hr-no-response comment with the recovery actions', () => {
    const { deps, comments } = makeDeps();
    const lc = createCardLifecycle(deps, { cardId: 'card-1', projectId: 'proj-1' });
    lc.onStalled({ runId: 'r1' });
    expect(comments[0].content).toBe(
      'Stalled — no session response in 24hr; cancel or retrigger (run r1)',
    );
  });
});

// ─── Non-throwing contract ───────────────────────────────────────────

describe('createCardLifecycle — non-throwing', () => {
  beforeEach(() => {
    // Each test resets to a fresh deps in its own factory call.
  });

  it('swallows DB errors on postComment', () => {
    const { deps, log } = makeDeps();
    (deps.stmts.createKanbanCardComment as unknown as { run: ReturnType<typeof vi.fn> }).run =
      vi.fn(() => {
        throw new Error('disk full');
      });
    const lc = createCardLifecycle(deps, { cardId: 'card-1', projectId: 'proj-1' });
    expect(() => lc.onRebaseClean({ runId: 'r' })).not.toThrow();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('postComment failed'));
  });

  it('swallows DB errors on moveKanbanCard', () => {
    const { deps, log } = makeDeps({ column_id: 'col-todo' });
    (deps.stmts.moveKanbanCard as unknown as { run: ReturnType<typeof vi.fn> }).run = vi.fn(() => {
      throw new Error('FK constraint');
    });
    const lc = createCardLifecycle(deps, { cardId: 'card-1', projectId: 'proj-1' });
    expect(() => lc.onStarted({ runId: 'r', triggerSource: 'ui_button' })).not.toThrow();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('moveToColumnByName'));
  });
});
