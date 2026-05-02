import { describe, it, expect, vi } from 'vitest';
import {
  parseCloseCardBlock,
  pickDoneColumn,
  buildAutoCloseCommentBody,
  handleCardAutoClose,
} from './card-auto-close.js';
import type { Stmts, KanbanCardRow, KanbanColumnRow } from './types.js';

describe('parseCloseCardBlock', () => {
  it('extracts a valid duplicate block with reason and note', () => {
    const text = `Yep, this is a repeat.

<agenthub:close-card>
{"reason": "duplicate", "note": "Covered by card 5c8f — see PR #313.", "duplicateOfCardId": "5c8f"}
</agenthub:close-card>`;
    const result = parseCloseCardBlock(text);
    expect(result).toEqual({
      reason: 'duplicate',
      note: 'Covered by card 5c8f — see PR #313.',
      duplicateOfCardId: '5c8f',
    });
  });

  it('extracts an already-done block without duplicateOfCardId', () => {
    const text = `<agenthub:close-card>
{"reason": "already-done", "note": "Shipped in commit a1b2c3d."}
</agenthub:close-card>`;
    const result = parseCloseCardBlock(text);
    expect(result).toEqual({
      reason: 'already-done',
      note: 'Shipped in commit a1b2c3d.',
    });
    expect(result?.duplicateOfCardId).toBeUndefined();
  });

  it('normalizes reason aliases (already_done, alreadyDone, done) to already-done', () => {
    for (const reason of ['already_done', 'alreadyDone', 'DONE', 'Already-Done']) {
      const text = `<agenthub:close-card>{"reason": "${reason}", "note": "ok"}</agenthub:close-card>`;
      const result = parseCloseCardBlock(text);
      expect(result).not.toBeNull();
      expect(result!.reason).toBe('already-done');
    }
  });

  it('returns null when no block is present', () => {
    expect(parseCloseCardBlock('no block here')).toBeNull();
  });

  it('returns null when JSON is malformed', () => {
    const text = `<agenthub:close-card>reason=duplicate</agenthub:close-card>`;
    expect(parseCloseCardBlock(text)).toBeNull();
  });

  it('returns null when reason is missing', () => {
    const text = `<agenthub:close-card>{"note": "x"}</agenthub:close-card>`;
    expect(parseCloseCardBlock(text)).toBeNull();
  });

  it('returns null when reason is unknown', () => {
    const text = `<agenthub:close-card>{"reason": "nope", "note": "x"}</agenthub:close-card>`;
    expect(parseCloseCardBlock(text)).toBeNull();
  });

  it('returns null when note is missing or empty', () => {
    for (const body of ['{"reason":"duplicate"}', '{"reason":"duplicate","note":"  "}']) {
      expect(parseCloseCardBlock(`<agenthub:close-card>${body}</agenthub:close-card>`)).toBeNull();
    }
  });

  it('returns null when the payload is an array', () => {
    const text = `<agenthub:close-card>[{"reason":"duplicate","note":"x"}]</agenthub:close-card>`;
    expect(parseCloseCardBlock(text)).toBeNull();
  });

  it('accepts snake_case duplicate_of_card_id alias', () => {
    const text = `<agenthub:close-card>{"reason":"duplicate","note":"x","duplicate_of_card_id":"abc"}</agenthub:close-card>`;
    expect(parseCloseCardBlock(text)).toEqual({
      reason: 'duplicate',
      note: 'x',
      duplicateOfCardId: 'abc',
    });
  });

  it('takes only the first block when multiple are present', () => {
    const text = `<agenthub:close-card>{"reason":"duplicate","note":"first"}</agenthub:close-card>
<agenthub:close-card>{"reason":"already-done","note":"second"}</agenthub:close-card>`;
    expect(parseCloseCardBlock(text)?.note).toBe('first');
  });

  // ─── Robustness: action-block parser shape variants ────────────────────
  // Regression coverage for the "action blocks sometimes only print, don't
  // execute" bug — parsers used to choke when the agent wrapped the JSON in
  // a markdown fence, lead-in prose, or emitted multi-line strings with raw
  // newlines. The shared `extractJsonFromTagBody` helper now tolerates these.

  it('tolerates a ```json ... ``` fence wrapping the JSON inside the tag', () => {
    const text =
      '<agenthub:close-card>\n```json\n{"reason":"duplicate","note":"covered by 5c8f"}\n```\n</agenthub:close-card>';
    expect(parseCloseCardBlock(text)).toEqual({
      reason: 'duplicate',
      note: 'covered by 5c8f',
    });
  });

  it('tolerates a bare ``` ... ``` fence (no language hint) inside the tag', () => {
    const text =
      '<agenthub:close-card>\n```\n{"reason":"already-done","note":"shipped"}\n```\n</agenthub:close-card>';
    expect(parseCloseCardBlock(text)?.reason).toBe('already-done');
  });

  it('tolerates lead-in prose before the JSON object inside the tag', () => {
    const text =
      '<agenthub:close-card>\nHere is the payload:\n{"reason":"duplicate","note":"x"}\n</agenthub:close-card>';
    expect(parseCloseCardBlock(text)).toEqual({ reason: 'duplicate', note: 'x' });
  });

  it('tolerates raw newlines inside string values (the empirical handoff bug)', () => {
    const text =
      '<agenthub:close-card>{"reason":"duplicate","note":"line one\nline two\nline three"}</agenthub:close-card>';
    const result = parseCloseCardBlock(text);
    expect(result).not.toBeNull();
    expect(result!.note).toBe('line one\nline two\nline three');
  });
});

describe('pickDoneColumn', () => {
  const makeCol = (name: string, position: number): KanbanColumnRow => ({
    id: `col-${name.toLowerCase().replace(/\s+/g, '-')}`,
    board_id: 'b1',
    name,
    position,
    color: null,
    created_at: '2026-01-01T00:00:00Z',
  });

  it('prefers an exact case-insensitive match on "done"', () => {
    const cols = [makeCol('Backlog', 0), makeCol('Done', 1), makeCol('Archive', 2)];
    expect(pickDoneColumn(cols)?.name).toBe('Done');
  });

  it('falls back to a contains-"done" match', () => {
    const cols = [makeCol('Backlog', 0), makeCol('All Done', 1)];
    expect(pickDoneColumn(cols)?.name).toBe('All Done');
  });

  it('falls back to the rightmost column when no name match exists', () => {
    const cols = [makeCol('Backlog', 0), makeCol('To Do', 1), makeCol('Shipped', 2)];
    expect(pickDoneColumn(cols)?.name).toBe('Shipped');
  });

  it('returns null on empty input', () => {
    expect(pickDoneColumn([])).toBeNull();
  });
});

describe('buildAutoCloseCommentBody', () => {
  it('renders a duplicate comment with the duplicate card title', () => {
    const body = buildAutoCloseCommentBody({
      task: { reason: 'duplicate', note: 'Same thing.', duplicateOfCardId: 'abc' },
      sessionId: 'sess-1',
      duplicateCardTitle: 'Original ticket',
    });
    expect(body).toContain('duplicate');
    expect(body).toContain('Same thing.');
    expect(body).toContain('Original ticket');
    expect(body).toContain('abc');
    expect(body).toContain('sess-1');
  });

  it('omits the duplicate section when no id is present', () => {
    const body = buildAutoCloseCommentBody({
      task: { reason: 'already-done', note: 'Shipped.' },
      sessionId: 'sess-1',
    });
    expect(body).toContain('already done');
    expect(body).toContain('Shipped.');
    expect(body).not.toContain('Duplicate of');
  });
});

describe('handleCardAutoClose', () => {
  function makeStmts(overrides: Partial<Stmts> = {}): Stmts {
    const defaults = {
      getKanbanCardBySession: { get: vi.fn().mockReturnValue(undefined) },
      getKanbanColumns: { all: vi.fn().mockReturnValue([]) },
      moveKanbanCard: { run: vi.fn() },
      createKanbanCardComment: { run: vi.fn() },
      getKanbanCard: { get: vi.fn().mockReturnValue(undefined) },
    };
    return { ...defaults, ...overrides } as unknown as Stmts;
  }

  const card: KanbanCardRow = {
    id: 'card-1',
    column_id: 'col-inprogress',
    board_id: 'board-1',
    title: 'Do the thing',
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

  it('moves the linked card to Done and inserts a comment', () => {
    const moveRun = vi.fn();
    const commentRun = vi.fn();
    const stmts = makeStmts({
      getKanbanCardBySession: { get: vi.fn().mockReturnValue(card) },
      getKanbanColumns: { all: vi.fn().mockReturnValue([doneCol]) },
      moveKanbanCard: { run: moveRun },
      createKanbanCardComment: { run: commentRun },
    } as unknown as Partial<Stmts>);
    const broadcast = vi.fn();

    const result = handleCardAutoClose(
      'sess-1',
      { reason: 'already-done', note: 'Shipped in PR #201.' },
      { stmts, broadcast, projectId: 'proj-1', author: 'hub-backend' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected CardAutoCloseOutcome.ok');
    expect(result.result.cardId).toBe('card-1');
    expect(result.result.doneColumnId).toBe('col-done');
    expect(moveRun).toHaveBeenCalledWith('col-done', 0, 'card-1');
    expect(commentRun).toHaveBeenCalledTimes(1);
    const [, cardIdArg, authorArg, bodyArg] = commentRun.mock.calls[0];
    expect(cardIdArg).toBe('card-1');
    expect(authorArg).toBe('hub-backend');
    expect(bodyArg).toContain('already done');
    expect(bodyArg).toContain('Shipped in PR #201.');
    expect(bodyArg).toContain('sess-1');
    expect(broadcast).toHaveBeenCalledWith({ type: 'kanban_update', projectId: 'proj-1' });
  });

  it('includes the duplicate card title in the comment when available', () => {
    const commentRun = vi.fn();
    const dupCard = { ...card, id: 'card-orig', title: 'Original work' };
    const stmts = makeStmts({
      getKanbanCardBySession: { get: vi.fn().mockReturnValue(card) },
      getKanbanColumns: { all: vi.fn().mockReturnValue([doneCol]) },
      moveKanbanCard: { run: vi.fn() },
      createKanbanCardComment: { run: commentRun },
      getKanbanCard: { get: vi.fn().mockReturnValue(dupCard) },
    } as unknown as Partial<Stmts>);

    handleCardAutoClose(
      'sess-1',
      { reason: 'duplicate', note: 'Repeat.', duplicateOfCardId: 'card-orig' },
      { stmts, broadcast: vi.fn(), projectId: 'proj-1' },
    );

    const body = commentRun.mock.calls[0][3];
    expect(body).toContain('Original work');
    expect(body).toContain('card-orig');
  });

  it('returns null when the session has no linked card', () => {
    const moveRun = vi.fn();
    const commentRun = vi.fn();
    const stmts = makeStmts({
      getKanbanCardBySession: { get: vi.fn().mockReturnValue(undefined) },
      moveKanbanCard: { run: moveRun },
      createKanbanCardComment: { run: commentRun },
    } as unknown as Partial<Stmts>);
    const broadcast = vi.fn();

    const result = handleCardAutoClose(
      'sess-nolink',
      { reason: 'duplicate', note: 'n/a' },
      { stmts, broadcast, projectId: 'proj-1' },
    );

    expect(result).toEqual({ ok: false, reason: 'no_linked_card' });
    expect(moveRun).not.toHaveBeenCalled();
    expect(commentRun).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('skips the move when the card is already in Done but still leaves an audit comment', () => {
    const moveRun = vi.fn();
    const commentRun = vi.fn();
    const cardInDone = { ...card, column_id: 'col-done' };
    const stmts = makeStmts({
      getKanbanCardBySession: { get: vi.fn().mockReturnValue(cardInDone) },
      getKanbanColumns: { all: vi.fn().mockReturnValue([doneCol]) },
      moveKanbanCard: { run: moveRun },
      createKanbanCardComment: { run: commentRun },
    } as unknown as Partial<Stmts>);

    const result = handleCardAutoClose(
      'sess-1',
      { reason: 'already-done', note: 'Already landed.' },
      { stmts, broadcast: vi.fn(), projectId: 'proj-1' },
    );

    expect(result.ok).toBe(true);
    expect(moveRun).not.toHaveBeenCalled();
    expect(commentRun).toHaveBeenCalledTimes(1);
  });

  it('returns move_failed when the Done column move throws', () => {
    const stmts = makeStmts({
      getKanbanCardBySession: { get: vi.fn().mockReturnValue(card) },
      getKanbanColumns: { all: vi.fn().mockReturnValue([doneCol]) },
      moveKanbanCard: {
        run: vi.fn().mockImplementation(() => {
          throw new Error('constraint');
        }),
      },
      createKanbanCardComment: { run: vi.fn() },
    } as unknown as Partial<Stmts>);

    const result = handleCardAutoClose(
      'sess-1',
      { reason: 'already-done', note: 'n/a' },
      { stmts, broadcast: vi.fn(), projectId: 'proj-1' },
    );

    expect(result).toEqual({ ok: false, reason: 'move_failed' });
  });

  it('does not throw when the comment insert fails — the move is still reported', () => {
    const moveRun = vi.fn();
    const commentRun = vi.fn().mockImplementation(() => {
      throw new Error('DB down');
    });
    const stmts = makeStmts({
      getKanbanCardBySession: { get: vi.fn().mockReturnValue(card) },
      getKanbanColumns: { all: vi.fn().mockReturnValue([doneCol]) },
      moveKanbanCard: { run: moveRun },
      createKanbanCardComment: { run: commentRun },
    } as unknown as Partial<Stmts>);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = handleCardAutoClose(
      'sess-1',
      { reason: 'duplicate', note: 'dup' },
      { stmts, broadcast: vi.fn(), projectId: 'proj-1' },
    );

    expect(result.ok).toBe(true);
    expect(moveRun).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});
