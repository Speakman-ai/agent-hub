import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { KanbanCardRow } from './types.js';
import {
  linearGqlRequest,
  fetchLinearIssuesPage,
  runLinearKanbanSync,
  readCheckpoint,
  nextKanbanCardPositionInColumn,
  type LinearIssueSnapshot,
} from './linear-kanban-sync.js';
import { SURVEYTRACKER_LINEAR_SYNC } from './linear-kanban-sync-config.js';
import { getOrCreateBoard } from './routes/board.js';
import { db, stmts } from './db.js';

const testStmts = stmts!;
const testDb = db!;

function mockFetchLinear(pages: Array<{ nodes: LinearIssueSnapshot[]; endCursor: string | null }>) {
  let call = 0;
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    if (body.query.includes('workflowStates')) {
      return new Response(
        JSON.stringify({
          data: {
            workflowStates: {
              nodes: [
                { id: 'state-done', name: 'Done' },
                { id: 'state-todo', name: 'New Issues' },
              ],
            },
          },
        }),
        { status: 200 },
      );
    }
    if (body.query.includes('issueUpdate')) {
      return new Response(
        JSON.stringify({
          data: {
            issueUpdate: {
              success: true,
              issue: { id: 'x', identifier: 'MCS-1', state: { name: 'Done' } },
            },
          },
        }),
        { status: 200 },
      );
    }
    const page = pages[call] ?? { nodes: [], endCursor: null };
    call++;
    return new Response(
      JSON.stringify({
        data: {
          issues: {
            nodes: page.nodes,
            pageInfo: {
              hasNextPage: page.endCursor != null,
              endCursor: page.endCursor,
            },
          },
        },
      }),
      { status: 200 },
    );
  });
}

describe('linearGqlRequest', () => {
  it('aborts when the request exceeds the per-call timeout', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error('expected AbortSignal on request'));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    });
    await expect(
      linearGqlRequest('lin_test', 'query { viewer { id } }', {}, { fetchImpl, timeoutMs: 50 }),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('fetchLinearIssuesPage', () => {
  it('returns nodes and cursor from the team issues query', async () => {
    const issue: LinearIssueSnapshot = {
      id: 'iss-1',
      identifier: 'MCS-100',
      title: 'Test issue',
      description: 'body',
      priority: 3,
      updatedAt: '2026-05-27T00:00:00Z',
      state: { id: 's1', name: 'In Progress' },
      project: null,
    };
    const fetchImpl = mockFetchLinear([{ nodes: [issue], endCursor: null }]);
    const page = await fetchLinearIssuesPage(
      { apiKey: 'lin_test', config: SURVEYTRACKER_LINEAR_SYNC, fetchImpl },
      null,
    );
    expect(page.nodes).toHaveLength(1);
    expect(page.nodes[0]?.identifier).toBe('MCS-100');
  });
});

describe('nextKanbanCardPositionInColumn', () => {
  it('returns max position + 1 scoped to the target column', () => {
    const board = getOrCreateBoard(testStmts, `pos-test-${Date.now()}`);
    const [colA, colB] = board.columns;
    const idA = crypto.randomUUID();
    const idB = crypto.randomUUID();
    testStmts.createKanbanCard.run(
      idA,
      colA.id,
      board.board.id,
      'MCS-1: A',
      null,
      'medium',
      null,
      null,
      null,
      null,
      null,
      null,
      7,
    );
    testStmts.createKanbanCard.run(
      idB,
      colB.id,
      board.board.id,
      'MCS-2: B',
      null,
      'medium',
      null,
      null,
      null,
      null,
      null,
      null,
      2,
    );
    expect(nextKanbanCardPositionInColumn(testStmts, colB.id)).toBe(3);
    expect(nextKanbanCardPositionInColumn(testStmts, colA.id)).toBe(8);
  });
});

describe('runLinearKanbanSync', () => {
  let dataDir: string;
  let projectId: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'linear-sync-test-'));
    projectId = `sync-test-${Date.now()}`;
  });

  afterEach(() => {
    try {
      const board = testStmts.getKanbanBoard.get(projectId) as { id: string } | undefined;
      if (board) {
        testDb.prepare('DELETE FROM kanban_cards WHERE board_id = ?').run(board.id);
        testDb.prepare('DELETE FROM kanban_epics WHERE board_id = ?').run(board.id);
        testDb.prepare('DELETE FROM kanban_columns WHERE board_id = ?').run(board.id);
        testDb.prepare('DELETE FROM kanban_boards WHERE id = ?').run(board.id);
      }
    } catch {
      /* ignore */
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates a kanban card for a new Linear issue and logs progress', async () => {
    const issue: LinearIssueSnapshot = {
      id: 'iss-new',
      identifier: 'MCS-200',
      title: 'Brand new ticket',
      description: 'x'.repeat(60),
      priority: 2,
      updatedAt: '2026-05-27T00:00:00Z',
      state: { id: 's-ip', name: 'In Progress' },
      project: { id: 'proj-1', name: 'Epic Alpha' },
    };
    const fetchImpl = mockFetchLinear([{ nodes: [issue], endCursor: null }]);
    const logs: string[] = [];
    const result = await runLinearKanbanSync({
      stmts: testStmts,
      dataDir,
      apiKey: 'lin_test',
      config: { ...SURVEYTRACKER_LINEAR_SYNC, projectId },
      log: (line) => logs.push(line),
      deadlineMs: Date.now() + 60_000,
      fetchImpl,
    });

    expect(result.complete).toBe(true);
    expect(result.stats.cardsCreated).toBe(1);
    expect(logs.some((l) => l.includes('Fetching Linear page'))).toBe(true);
    expect(logs.some((l) => l.includes('Synced batch'))).toBe(true);

    const board = getOrCreateBoard(testStmts, projectId);
    const card = board.cards.find((c) => c.title.startsWith('MCS-200:'));
    expect(card).toBeDefined();
    expect(card?.description?.length).toBeGreaterThanOrEqual(50);
    expect(!existsSync(path.join(dataDir, `linear-kanban-sync-${projectId}.json`))).toBe(true);
  });

  it('resumes from checkpoint after fetch phase was interrupted', async () => {
    const issue: LinearIssueSnapshot = {
      id: 'iss-cp',
      identifier: 'MCS-201',
      title: 'Checkpoint issue',
      description: null,
      priority: 4,
      updatedAt: '2026-05-27T00:00:00Z',
      state: { id: 's-todo', name: 'New Issues' },
      project: null,
    };

    const cpPath = path.join(dataDir, `linear-kanban-sync-${projectId}.json`);
    const { writeCheckpoint } = await import('./linear-kanban-sync.js');
    writeCheckpoint(dataDir, {
      version: 1,
      projectId,
      phase: 'sync',
      fetchCursor: null,
      fetchComplete: true,
      issues: [issue],
      syncIndex: 0,
      updatedAt: new Date().toISOString(),
    });
    expect(existsSync(cpPath)).toBe(true);

    const fetchImpl = mockFetchLinear([]);
    const result = await runLinearKanbanSync({
      stmts: testStmts,
      dataDir,
      apiKey: 'lin_test',
      config: { ...SURVEYTRACKER_LINEAR_SYNC, projectId },
      log: () => {},
      deadlineMs: Date.now() + 60_000,
      fetchImpl,
    });

    expect(result.stats.resumedFromCheckpoint).toBe(true);
    expect(result.stats.cardsCreated).toBe(1);
    expect(result.complete).toBe(true);
  });

  it('appends moved cards at the bottom of the target column', async () => {
    const board = getOrCreateBoard(testStmts, projectId);
    const todoCol = board.columns.find((c) => c.name === 'To Do')!;
    const inProgressCol = board.columns.find((c) => c.name === 'In Progress')!;
    const existingId = uuidv4();
    testStmts.createKanbanCard.run(
      existingId,
      todoCol.id,
      board.board.id,
      'MCS-999: Move me',
      'short',
      'medium',
      null,
      null,
      null,
      null,
      null,
      null,
      0,
    );
    testStmts.createKanbanCard.run(
      uuidv4(),
      inProgressCol.id,
      board.board.id,
      'MCS-998: Blocker at bottom',
      null,
      'low',
      null,
      null,
      null,
      null,
      null,
      null,
      5,
    );

    const issue: LinearIssueSnapshot = {
      id: 'iss-move',
      identifier: 'MCS-999',
      title: 'Move me',
      description: null,
      priority: 3,
      updatedAt: '2026-05-27T00:00:00Z',
      state: { id: 's-ip', name: 'In Progress' },
      project: null,
    };
    const fetchImpl = mockFetchLinear([{ nodes: [issue], endCursor: null }]);
    await runLinearKanbanSync({
      stmts: testStmts,
      dataDir,
      apiKey: 'lin_test',
      config: { ...SURVEYTRACKER_LINEAR_SYNC, projectId },
      log: () => {},
      deadlineMs: Date.now() + 60_000,
      fetchImpl,
    });

    const moved = testStmts.getKanbanCard.get(existingId) as KanbanCardRow;
    expect(moved.column_id).toBe(inProgressCol.id);
    expect(moved.position).toBe(6);
    expect(nextKanbanCardPositionInColumn(testStmts, inProgressCol.id)).toBe(7);
  });

  it('writes checkpoint and pauses when the deadline is near', async () => {
    const issues: LinearIssueSnapshot[] = Array.from({ length: 5 }, (_, i) => ({
      id: `iss-${i}`,
      identifier: `MCS-${300 + i}`,
      title: `Issue ${i}`,
      description: null,
      priority: 3,
      updatedAt: '2026-05-27T00:00:00Z',
      state: { id: 's1', name: 'In Progress' },
      project: null,
    }));
    const fetchImpl = mockFetchLinear([{ nodes: issues, endCursor: null }]);
    const result = await runLinearKanbanSync({
      stmts: testStmts,
      dataDir,
      apiKey: 'lin_test',
      config: { ...SURVEYTRACKER_LINEAR_SYNC, projectId },
      log: () => {},
      deadlineMs: Date.now() + 1,
      fetchImpl,
    });

    expect(result.complete).toBe(false);
    expect(result.stats.pausedForResume).toBe(true);
    const cp = readCheckpoint(dataDir, projectId);
    expect(cp).not.toBeNull();
  });
});
