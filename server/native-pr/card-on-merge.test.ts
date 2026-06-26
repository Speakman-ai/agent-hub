/**
 * Regression: "Done means merged, not pushed."
 *
 * With `cardDoneOnPush=false` (the default), a Finalize push parks the linked
 * card in a non-Done column and the *merge* is what advances it to Done. This
 * test exercises that merge transition directly: a card linked to a native PR
 * must land in the board's Done column only after `handleCardOnMerge` runs, and
 * the move must broadcast a `card_moved` event plus a merge comment.
 */
import '../test/setup.js';
import { describe, it, expect, beforeAll } from 'vitest';
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { handleCardOnMerge } from './card-on-merge.js';
import { getOrCreateBoard } from '../routes/board.js';
import { buildNativePrUrl } from './url.js';
import type { BroadcastFn, KanbanColumnRow, PullRequestRow, Stmts } from '../types.js';

let stmts: Stmts;
let db: Database.Database;

beforeAll(async () => {
  const helpers = await import('../test/helpers.js');
  await helpers.getRequest(); // boots the app + initDb
  const dbModule = await import('../db.js');
  stmts = dbModule.stmts!;
  db = dbModule.getDb();
});

function makePr(projectId: string, number: number, overrides: Partial<PullRequestRow> = {}) {
  return {
    number,
    title: 'Add feature',
    head_branch: `agent-hub/a1/session-${uuidv4().slice(0, 8)}`,
    base_branch: 'main',
    merge_method: 'squash',
    ...overrides,
  } as unknown as PullRequestRow;
}

describe('handleCardOnMerge — Done means merged, not pushed', () => {
  it('moves a PR-linked card to Done only on merge, broadcasting card_moved + comment', () => {
    const projectId = `np-merge-${uuidv4().slice(0, 8)}`;
    const board = getOrCreateBoard(stmts, projectId);
    const cols = board.columns as KanbanColumnRow[];
    const done = cols.find((c) => c.name.toLowerCase() === 'done')!;
    const start = cols.find((c) => c.id !== done.id)!; // any non-Done column

    const cardId = uuidv4();
    const prNumber = 42;
    const prUrl = buildNativePrUrl(projectId, prNumber);
    stmts.createKanbanCard.run(
      cardId,
      start.id,
      board.board.id,
      'Card under PR',
      null,
      'medium',
      null,
      null,
      null,
      null,
      null,
      null,
      0,
    );
    // Link the card to the native PR so merge discovery resolves it.
    stmts.setCardPrUrl.run(prUrl, cardId);

    // Pre-condition: card is NOT in Done before the merge.
    const before = stmts.getKanbanCard.get(cardId) as { column_id: string };
    expect(before.column_id).toBe(start.id);
    expect(before.column_id).not.toBe(done.id);

    const events: Array<Record<string, unknown>> = [];
    const broadcast: BroadcastFn = (e) => {
      events.push(e as Record<string, unknown>);
    };

    handleCardOnMerge({ stmts, broadcast }, projectId, makePr(projectId, prNumber), 'tester');

    // Post-condition: merge moved the card to Done.
    const after = stmts.getKanbanCard.get(cardId) as { column_id: string };
    expect(after.column_id).toBe(done.id);

    const moved = events.find((e) => e.type === 'card_moved');
    expect(moved).toBeTruthy();
    expect(moved!.cardId).toBe(cardId);
    expect(moved!.columnName).toBe(done.name);

    const merged = events.find((e) => e.type === 'webhook_pr_merged');
    expect(merged).toBeTruthy();
    expect(merged!.cardId).toBe(cardId);
  });

  it('is idempotent: a card already in Done stays put with no card_moved event', () => {
    const projectId = `np-merge-${uuidv4().slice(0, 8)}`;
    const board = getOrCreateBoard(stmts, projectId);
    const cols = board.columns as KanbanColumnRow[];
    const done = cols.find((c) => c.name.toLowerCase() === 'done')!;

    const cardId = uuidv4();
    const prNumber = 7;
    const prUrl = buildNativePrUrl(projectId, prNumber);
    stmts.createKanbanCard.run(
      cardId,
      done.id, // already Done
      board.board.id,
      'Already done',
      null,
      'medium',
      null,
      null,
      null,
      null,
      null,
      null,
      0,
    );
    stmts.setCardPrUrl.run(prUrl, cardId);

    const events: Array<Record<string, unknown>> = [];
    const broadcast: BroadcastFn = (e) => {
      events.push(e as Record<string, unknown>);
    };

    handleCardOnMerge({ stmts, broadcast }, projectId, makePr(projectId, prNumber), 'tester');

    const after = stmts.getKanbanCard.get(cardId) as { column_id: string };
    expect(after.column_id).toBe(done.id);
    expect(events.find((e) => e.type === 'card_moved')).toBeFalsy();
  });

  it('moves to a renamed Done column on merge', () => {
    const projectId = `np-merge-${uuidv4().slice(0, 8)}`;
    const board = getOrCreateBoard(stmts, projectId);
    const cols = board.columns as KanbanColumnRow[];
    const done = cols.find((c) => c.name.toLowerCase() === 'done')!;
    db.prepare('UPDATE kanban_columns SET name = ? WHERE id = ?').run('Deployed / Done', done.id);
    const refreshed = getOrCreateBoard(stmts, projectId);
    const renamedDone = refreshed.columns.find((c) => c.id === done.id)!;
    const start = refreshed.columns.find((c) => c.id !== done.id)!;

    const cardId = uuidv4();
    const prNumber = 11;
    const prUrl = buildNativePrUrl(projectId, prNumber);
    stmts.createKanbanCard.run(
      cardId,
      start.id,
      refreshed.board.id,
      'Renamed done card',
      null,
      'medium',
      null,
      null,
      null,
      null,
      null,
      null,
      0,
    );
    stmts.setCardPrUrl.run(prUrl, cardId);

    const events: Array<Record<string, unknown>> = [];
    handleCardOnMerge(
      {
        stmts,
        broadcast: (e) => {
          events.push(e as Record<string, unknown>);
        },
      },
      projectId,
      makePr(projectId, prNumber),
      'tester',
    );

    const after = stmts.getKanbanCard.get(cardId) as { column_id: string };
    expect(after.column_id).toBe(done.id);
    expect(events.find((e) => e.type === 'card_moved')).toMatchObject({
      cardId,
      columnName: renamedDone.name,
    });
  });
});
