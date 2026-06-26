import './test/setup.js';
import { describe, it, expect, beforeAll } from 'vitest';
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { handleGithubCardOnMerge } from './github-card-on-merge.js';
import { getOrCreateBoard } from './routes/board.js';
import type { KanbanCardRow, KanbanColumnRow, Stmts } from './types.js';

let stmts: Stmts;
let db: Database.Database;

beforeAll(async () => {
  const helpers = await import('./test/helpers.js');
  await helpers.getRequest();
  const dbModule = await import('./db.js');
  stmts = dbModule.stmts!;
  db = dbModule.getDb();
});

describe('handleGithubCardOnMerge', () => {
  it('links an unlinked session card and moves it to a renamed Done column', () => {
    const projectId = `gh-merge-${uuidv4().slice(0, 8)}`;
    const board = getOrCreateBoard(stmts, projectId);
    const done = (board.columns as KanbanColumnRow[]).find((c) => c.name.toLowerCase() === 'done')!;
    db.prepare('UPDATE kanban_columns SET name = ? WHERE id = ?').run('Merged / Done', done.id);
    const refreshed = getOrCreateBoard(stmts, projectId);
    const renamedDone = refreshed.columns.find((c) => c.id === done.id)!;
    const start = refreshed.columns.find((c) => c.id !== done.id)!;

    const cardId = uuidv4();
    const sessionId = 'abcdef12-1111-4222-8333-444444444444';
    const prUrl = 'https://github.com/acme/repo/pull/123';
    stmts.createKanbanCard.run(
      cardId,
      start.id,
      refreshed.board.id,
      'GitHub merge card',
      '',
      'medium',
      null,
      null,
      sessionId,
      null,
      'test',
      null,
      0,
    );

    const events: Array<Record<string, unknown>> = [];
    handleGithubCardOnMerge(
      {
        stmts,
        broadcast: (e) => {
          events.push(e as Record<string, unknown>);
        },
      },
      {
        projectId,
        prUrl,
        prNumber: 123,
        prTitle: 'Different PR title',
        headRef: 'agent-hub/dev/session-abcdef12',
        mergedBy: 'tester',
        mergeMethod: 'squash',
      },
    );

    const card = stmts.getKanbanCard.get(cardId) as KanbanCardRow;
    expect(card.pr_url).toBe(prUrl);
    expect(card.column_id).toBe(done.id);
    expect(events.find((e) => e.type === 'card_moved')).toMatchObject({
      cardId,
      columnName: renamedDone.name,
      prUrl,
      sessionId,
    });
    expect(events.find((e) => e.type === 'webhook_pr_merged')).toMatchObject({
      prNumber: 123,
      cardId,
      prUrl,
    });
  });
});
