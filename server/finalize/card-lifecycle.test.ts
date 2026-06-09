/**
 * Tests for the Finalize → kanban card surface mirror.
 *
 * We pin every method against:
 *   - the exact comment string written to `kanban_card_comments`
 *   - the broadcast events emitted alongside the writes
 *
 * The lifecycle module is the human-facing audit trail for a finalize
 * run; if a wording change slips through here the user thread on the
 * card becomes ambiguous, so the regex / equality matchers are
 * deliberately strict.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  createCardLifecycle,
  NOOP_CARD_LIFECYCLE,
  type CardLifecycleDeps,
} from './card-lifecycle.js';
import type { KanbanCardRow } from '../types.js';

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

interface RecordedComment {
  id: string;
  cardId: string;
  author: string;
  content: string;
}

function makeDeps(cardOverride: Partial<KanbanCardRow> = {}): {
  deps: CardLifecycleDeps;
  card: KanbanCardRow;
  comments: RecordedComment[];
  broadcast: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
} {
  const card = fakeCard(cardOverride);
  const comments: RecordedComment[] = [];
  const broadcast = vi.fn();
  const log = vi.fn();
  let idCounter = 0;
  const deps: CardLifecycleDeps = {
    stmts: {
      getKanbanCard: {
        get: vi.fn((id: string) => (id === card.id ? card : undefined)),
      } as unknown as CardLifecycleDeps['stmts']['getKanbanCard'],
      getKanbanColumns: {
        all: vi.fn(() => []),
      } as unknown as CardLifecycleDeps['stmts']['getKanbanColumns'],
      moveKanbanCard: {
        run: vi.fn(),
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
  return { deps, card, comments, broadcast, log };
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
    expect(
      NOOP_CARD_LIFECYCLE.onPushed({
        runId: 'r1',
        prUrl: 'https://x',
        triggerSource: 'ui_button',
      }),
    ).toBeUndefined();
    expect(NOOP_CARD_LIFECYCLE.onStalled({ runId: 'r1' })).toBeUndefined();
  });
});

// ─── onStarted ───────────────────────────────────────────────────────

describe('createCardLifecycle.onStarted', () => {
  it('posts the start comment without moving the card', () => {
    const { deps, comments, broadcast } = makeDeps({ column_id: 'col-todo' });
    const lc = createCardLifecycle(deps, { cardId: 'card-1', projectId: 'proj-1' });

    lc.onStarted({ runId: 'run-abc', triggerSource: 'ui_button' });

    expect(deps.stmts.moveKanbanCard.run).not.toHaveBeenCalled();
    expect(comments).toEqual([
      {
        id: 'comment-1',
        cardId: 'card-1',
        author: 'finalize',
        content: 'Finalize started (run run-abc) · trigger=ui_button',
      },
    ]);
    expect(broadcast.mock.calls).toEqual([[{ type: 'kanban_update', projectId: 'proj-1' }]]);
  });

  it('still posts the comment when the card is already in In Progress', () => {
    const { deps, comments } = makeDeps({ column_id: 'col-progress' });
    const lc = createCardLifecycle(deps, { cardId: 'card-1', projectId: 'proj-1' });

    lc.onStarted({ runId: 'run-abc', triggerSource: 'agent_block' });

    expect(deps.stmts.moveKanbanCard.run).not.toHaveBeenCalled();
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
});

// ─── Rebase comments ─────────────────────────────────────────────────

describe('createCardLifecycle — rebase transitions', () => {
  it('onRebaseClean posts the clean comment, no move', () => {
    const { deps, comments } = makeDeps();
    const lc = createCardLifecycle(deps, { cardId: 'card-1', projectId: 'proj-1' });
    lc.onRebaseClean({ runId: 'r1' });
    expect(comments[0].content).toBe('Rebase: clean (run r1)');
    expect(deps.stmts.moveKanbanCard.run).not.toHaveBeenCalled();
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

// ─── onPushed: comment only (no column move) ─────────────────────────

describe('createCardLifecycle.onPushed', () => {
  it('delegates to post-push detach: posts handoff comment without moving the card', () => {
    const { deps, comments, broadcast } = makeDeps({ column_id: 'col-progress' });
    const lc = createCardLifecycle(deps, { cardId: 'card-1', projectId: 'proj-1' });
    lc.onPushed({
      runId: 'r1',
      prUrl: 'https://github.com/o/r/pull/42',
      triggerSource: 'ui_button',
    });
    expect(comments[0].content).toBe(
      'Finalized. PR is on GitHub, owned by the developer from here.\n' +
        'https://github.com/o/r/pull/42\n' +
        '(run r1)',
    );
    expect(deps.stmts.moveKanbanCard.run).not.toHaveBeenCalled();
    expect(broadcast.mock.calls).toEqual([[{ type: 'kanban_update', projectId: 'proj-1' }]]);
  });

  it('autonomous trigger surfaces the suffix line in the comment', () => {
    const { deps, comments } = makeDeps({ column_id: 'col-progress' });
    const lc = createCardLifecycle(deps, { cardId: 'card-1', projectId: 'proj-1' });
    lc.onPushed({
      runId: 'r1',
      prUrl: 'https://github.com/o/r/pull/42',
      triggerSource: 'agent_block',
    });
    expect(comments[0].content).toContain('(triggered by autonomous agent)');
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

// ─── onTerminalFailed ────────────────────────────────────────────────

describe('createCardLifecycle.onTerminalFailed', () => {
  it('posts the failure_reason on the card timeline', () => {
    const { deps, comments } = makeDeps();
    const lc = createCardLifecycle(deps, { cardId: 'card-1', projectId: 'proj-1' });
    lc.onTerminalFailed({
      runId: 'r1',
      status: 'failed',
      failureReason: 'review_failed',
      detail: 'stub threw',
    });
    expect(comments[0].content).toBe(
      'Finalize failed: review_failed (failed, run r1) — stub threw',
    );
  });
});

// ─── Non-throwing contract ───────────────────────────────────────────

describe('createCardLifecycle — non-throwing', () => {
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
});
