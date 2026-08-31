import type supertest from 'supertest';
import { afterEach, beforeAll, describe, it, expect } from 'vitest';
import { getRequest, createProject, createCard } from '../test/helpers.js';
import { DEFAULT_CARD_PAGE_SIZE } from '../kanban-pagination.js';
import {
  setReadFacadeForTesting,
  syncReadFacade,
  type AsyncReadFacade,
  type ReadableStatement,
} from '../db-async/read-facade.js';

let request: supertest.Agent;
let projectId: string;
let columnId: string;

interface EnrichedCard {
  id: string;
  title: string;
  position: number;
  column_id: string;
  epic_id: string | null;
  blockers: unknown[];
  blocks: unknown[];
  finalize_run: unknown;
}

interface BoardResponse {
  cards: EnrichedCard[];
  counts: Record<string, number>;
  cursors?: Record<string, string | null>;
  columns: Array<{ id: string; name?: string }>;
  epics: Array<{ id: string }>;
}

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;

  const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
  columnId = (boardRes.body as BoardResponse).columns[0].id;

  for (let i = 0; i < 8; i++) {
    await createCard(projectId, {
      columnId,
      title: `Facade card ${String(i).padStart(2, '0')}`,
    });
  }
});

// Every test restores the suite-wide sync facade so a spy/failure/yield install
// never leaks into another test file.
afterEach(() => {
  setReadFacadeForTesting(syncReadFacade);
});

/** Wrap the sync facade, recording the SQL text of every read it forwards. */
function recordingFacade(sink: string[]): AsyncReadFacade {
  return {
    all: <Row = unknown>(stmt: ReadableStatement, params: unknown[] = []) => {
      sink.push(stmt.source);
      return syncReadFacade.all<Row>(stmt, params);
    },
    get: <Row = unknown>(stmt: ReadableStatement, params: unknown[] = []) => {
      sink.push(stmt.source);
      return syncReadFacade.get<Row>(stmt, params);
    },
  };
}

const isBoardCardSelect = (sql: string): boolean =>
  /FROM\s+kanban_cards\s+WHERE\s+board_id/i.test(sql);

describe('GET /board — async read facade offload', () => {
  it('routes the full-board (?limit=all) card SELECT through the async read facade', async () => {
    const seen: string[] = [];
    setReadFacadeForTesting(recordingFacade(seen));

    const res = await request.get(`/api/projects/${projectId}/board?limit=all`).expect(200);
    const body = res.body as BoardResponse;

    // The heavy board-wide card SELECT went through the facade, not the sync path.
    expect(seen.some(isBoardCardSelect)).toBe(true);
    // Full-board opt-out: every card materialized, no per-column cursor trim.
    expect(body.cards).toHaveLength(8);
    expect(body.cursors).toBeUndefined();
    // counts is derived from the returned cards, so it agrees exactly.
    expect(body.counts[columnId]).toBe(8);
    expect(Object.values(body.counts).reduce((a, b) => a + b, 0)).toBe(body.cards.length);
    // Enrichment survives the offload — shape is unchanged.
    for (const card of body.cards) {
      expect(Array.isArray(card.blockers)).toBe(true);
      expect(Array.isArray(card.blocks)).toBe(true);
      expect(card).toHaveProperty('finalize_run');
    }
  });

  it('trims the default payload (no ?limit) and does not run the board-wide SELECT', async () => {
    const seen: string[] = [];
    setReadFacadeForTesting(recordingFacade(seen));

    const res = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const body = res.body as BoardResponse;

    // Default is bounded to a per-column page (payload trim) with resume cursors.
    expect(body.cursors).toBeDefined();
    expect(body.counts[columnId]).toBe(8);
    expect(body.cards.length).toBeLessThanOrEqual(8);
    // The bounded per-column reads stay synchronous — the heavy full-board SELECT
    // is never issued on this path (async-boundary: only measured-slow reads
    // route to the pool).
    expect(seen.some(isBoardCardSelect)).toBe(false);
  });

  it('bounds the default payload to the page size when ?limit is small', async () => {
    const res = await request.get(`/api/projects/${projectId}/board?limit=3`).expect(200);
    const body = res.body as BoardResponse;
    expect(body.cards.length).toBeLessThanOrEqual(3);
    expect(body.counts[columnId]).toBe(8);
    expect(body.cursors?.[columnId]).toBeTruthy();
  });

  it('bounds the default response to the page size on a column larger than one page', async () => {
    // A column with MORE than the default page size is the only fixture that
    // distinguishes the bounded default from the old full-board behavior: the
    // old implementation returns every card here, the bounded one returns exactly
    // one page. Seed just past DEFAULT_CARD_PAGE_SIZE.
    const project = await createProject();
    const pid = project.id as string;
    const boardRes = await request.get(`/api/projects/${pid}/board`).expect(200);
    const col = (boardRes.body as BoardResponse).columns[0].id;

    const TOTAL = DEFAULT_CARD_PAGE_SIZE + 5;
    for (let i = 0; i < TOTAL; i++) {
      await createCard(pid, { columnId: col, title: `bulk ${String(i).padStart(3, '0')}` });
    }

    const res = await request.get(`/api/projects/${pid}/board`).expect(200);
    const body = res.body as BoardResponse;

    // Default is trimmed to exactly one page for the column — NOT the whole
    // column. A regression to full-board serialization returns all TOTAL cards
    // and fails here.
    const inCol = body.cards.filter((c) => c.column_id === col);
    expect(inCol).toHaveLength(DEFAULT_CARD_PAGE_SIZE);
    expect(body.cards).toHaveLength(DEFAULT_CARD_PAGE_SIZE);
    // The true total is still reported so the client knows to keep paging...
    expect(body.counts[col]).toBe(TOTAL);
    // ...and a non-null resume cursor is provided because more remain.
    expect(body.cursors?.[col]).toBeTruthy();

    // The full-board opt-out still returns every card (the two paths diverge),
    // and its serialized body is strictly larger than the bounded default — so a
    // regression that drops the trim and serializes the whole board is caught by
    // payload size too, not just card count.
    const full = await request.get(`/api/projects/${pid}/board?limit=all`).expect(200);
    const fullBody = full.body as BoardResponse;
    expect(fullBody.cards.filter((c) => c.column_id === col)).toHaveLength(TOTAL);
    expect(fullBody.cursors).toBeUndefined();
    expect(JSON.stringify(body).length).toBeLessThan(JSON.stringify(fullBody).length);
  });

  it('surfaces a facade read failure as 500 board_read_failed', async () => {
    setReadFacadeForTesting({
      all: () => Promise.reject(new Error('reader pool exploded')),
      get: (stmt, params) => syncReadFacade.get(stmt, params),
    });

    const res = await request.get(`/api/projects/${projectId}/board?limit=all`).expect(500);
    expect((res.body as { error: string }).error).toBe('board_read_failed');
  });

  it('keeps the full board self-consistent when a column and epic are created during the offloaded read', async () => {
    // Deterministically reproduce the reviewer's race: a concurrent request
    // creates a NEW column and epic and inserts a card into them WHILE the
    // offloaded card read is in flight. The facade performs that mutation before
    // returning the card rows, so the returned cards include a card referencing a
    // column/epic that the pre-await structure read did NOT have. The handler must
    // reconcile (re-read structure after the await) so the response never surfaces
    // a card whose column or epic is absent from that same response.
    const project = await createProject();
    const pid = project.id as string;
    const boardRes = await request.get(`/api/projects/${pid}/board`).expect(200);
    const baseCol = (boardRes.body as BoardResponse).columns[0].id;
    await createCard(pid, { columnId: baseCol, title: 'pre-existing' });

    let injected = false;
    setReadFacadeForTesting({
      all: async <Row = unknown>(
        stmt: ReadableStatement,
        params: unknown[] = [],
      ): Promise<Row[]> => {
        if (isBoardCardSelect(stmt.source) && !injected) {
          injected = true;
          // Column + epic + a card referencing both, committed mid-read.
          const rc = await request
            .post(`/api/projects/${pid}/board/columns`)
            .send({ name: 'mid-read-col' })
            .expect(200);
          const newCol = (rc.body as Array<{ id: string; name: string }>).find(
            (c) => c.name === 'mid-read-col',
          )!.id;
          const re = await request
            .post(`/api/projects/${pid}/board/epics`)
            .send({ name: 'mid-read-epic' })
            .expect(200);
          const newEpic = (re.body as { id: string }).id;
          await createCard(pid, { columnId: newCol, title: 'mid-read card', epicId: newEpic });
        }
        // Runs AFTER the injected mutation, so these rows include the mid-read
        // card in its brand-new column/epic.
        return syncReadFacade.all<Row>(stmt, params);
      },
      get: (stmt, params) => syncReadFacade.get(stmt, params),
    });

    const res = await request.get(`/api/projects/${pid}/board?limit=all`).expect(200);
    const body = res.body as BoardResponse;
    const colIds = new Set(body.columns.map((c) => c.id));
    const epicIds = new Set(body.epics.map((e) => e.id));

    // The mid-read card is present and its column + epic are in the SAME response.
    const midCard = body.cards.find((c) => c.title === 'mid-read card');
    expect(midCard).toBeDefined();
    expect(colIds.has(midCard!.column_id)).toBe(true);
    expect(midCard!.epic_id != null && epicIds.has(midCard!.epic_id)).toBe(true);
    // Every card is self-consistent, and counts agrees with the returned cards.
    for (const c of body.cards) {
      expect(colIds.has(c.column_id)).toBe(true);
      if (c.epic_id != null) expect(epicIds.has(c.epic_id)).toBe(true);
    }
    const perColumn = new Map<string, number>();
    for (const c of body.cards) perColumn.set(c.column_id, (perColumn.get(c.column_id) ?? 0) + 1);
    for (const [colId, total] of Object.entries(body.counts)) {
      expect(total).toBe(perColumn.get(colId) ?? 0);
    }
    expect(Object.values(body.counts).reduce((a, b) => a + b, 0)).toBe(body.cards.length);
  });

  it('resyncs cards to the live snapshot when the offloaded read drifts from the structure', async () => {
    // Deterministically reproduce the delete-inverse race: the offloaded card
    // read returns a card referencing a column that no longer exists when the
    // structure is re-read (as if its column was dropped mid-flight). The handler
    // must detect the drift and resync cards to the structure's snapshot, so the
    // phantom never reaches the response.
    const project = await createProject();
    const pid = project.id as string;
    const boardRes = await request.get(`/api/projects/${pid}/board`).expect(200);
    const col = (boardRes.body as BoardResponse).columns[0].id;
    await createCard(pid, { columnId: col, title: 'real card' });

    setReadFacadeForTesting({
      all: async <Row = unknown>(
        stmt: ReadableStatement,
        params: unknown[] = [],
      ): Promise<Row[]> => {
        const rows = (await syncReadFacade.all<Row>(stmt, params)) as unknown[];
        if (isBoardCardSelect(stmt.source) && rows.length > 0) {
          const phantom = {
            ...(rows[0] as Record<string, unknown>),
            id: 'phantom-card',
            column_id: 'dropped-column',
            epic_id: null,
          };
          return [...rows, phantom] as Row[];
        }
        return rows as Row[];
      },
      get: (stmt, params) => syncReadFacade.get(stmt, params),
    });

    const res = await request.get(`/api/projects/${pid}/board?limit=all`).expect(200);
    const body = res.body as BoardResponse;
    const colIds = new Set(body.columns.map((c) => c.id));

    // Drift detected → cards resynced to the live snapshot → the phantom is gone
    // and every returned card sits in a real column.
    expect(body.cards.some((c) => c.id === 'phantom-card')).toBe(false);
    for (const c of body.cards) expect(colIds.has(c.column_id)).toBe(true);
    expect(Object.values(body.counts).reduce((a, b) => a + b, 0)).toBe(body.cards.length);
  });
});
