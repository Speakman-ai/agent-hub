import '../test/setup.js';
import type supertest from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { afterEach, beforeAll, describe, it, expect } from 'vitest';
import { getRequest, createAgent } from '../test/helpers.js';
import { getStmts } from '../db.js';
import {
  setReadFacadeForTesting,
  syncReadFacade,
  type AsyncReadFacade,
  type ReadableStatement,
} from '../db-async/read-facade.js';

let request: supertest.Agent;
let agentId: string;
let sessionId: string;

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

const isSessionListSelect = (sql: string): boolean =>
  /FROM\s+sessions\s+WHERE\s+agent_id/i.test(sql);
const isSessionEventsSelect = (sql: string): boolean =>
  /FROM\s+session_events\s+e\s+INNER\s+JOIN\s+messages/i.test(sql);

beforeAll(async () => {
  request = await getRequest();
  const agent = await createAgent();
  agentId = agent.id as string;

  const stmts = getStmts();
  // Seed two live sessions directly (bypasses worktree creation) so the
  // list read has rows to marshal through the facade.
  for (let i = 0; i < 2; i++) {
    const id = uuidv4();
    stmts.createSession.run(id, agentId, `Facade session ${i}`, 'claude-code', 'sonnet', 0, 0, 1);
    if (i === 0) sessionId = id;
  }
});

// Every test restores the suite-wide sync facade so a spy/failure install never
// leaks into another test file.
afterEach(() => {
  setReadFacadeForTesting(syncReadFacade);
});

describe('GET /api/agents/:agentId/sessions — async read facade offload', () => {
  it('routes the unbounded session-list SELECT through the async read facade', async () => {
    const seen: string[] = [];
    setReadFacadeForTesting(recordingFacade(seen));

    const res = await request.get(`/api/agents/${agentId}/sessions`).expect(200);
    const body = res.body as Array<{ id: string }>;

    // The heavy per-agent session-list SELECT went through the facade.
    expect(seen.some(isSessionListSelect)).toBe(true);
    // Success JSON is unchanged: both seeded sessions come back, enriched.
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    for (const s of body) expect(typeof s.id).toBe('string');
  });

  it('surfaces a facade read failure as 500 sessions_read_failed', async () => {
    setReadFacadeForTesting({
      all: () => Promise.reject(new Error('reader pool exploded')),
      get: (stmt, params) => syncReadFacade.get(stmt, params),
    });

    const res = await request.get(`/api/agents/${agentId}/sessions`).expect(500);
    expect((res.body as { error: string }).error).toBe('sessions_read_failed');
  });
});

describe('GET /api/sessions/:sessionId/summary — async read facade offload', () => {
  it('routes the session-events replay SELECT through the async read facade', async () => {
    const seen: string[] = [];
    setReadFacadeForTesting(recordingFacade(seen));

    const res = await request.get(`/api/sessions/${sessionId}/summary`).expect(200);
    const body = res.body as { session: { id: string }; runSnapshot: unknown };

    // The heavy event-replay JOIN went through the facade (under the aggregate cap).
    expect(seen.some(isSessionEventsSelect)).toBe(true);
    // Success JSON is unchanged: the summary still carries the session + snapshot.
    expect(body.session.id).toBe(sessionId);
    expect(body.runSnapshot).toBeDefined();
  });

  it('surfaces a facade read failure as 500 session_summary_read_failed', async () => {
    setReadFacadeForTesting({
      all: (stmt, params) =>
        isSessionEventsSelect(stmt.source)
          ? Promise.reject(new Error('reader pool exploded'))
          : syncReadFacade.all(stmt, params),
      get: (stmt, params) => syncReadFacade.get(stmt, params),
    });

    const res = await request.get(`/api/sessions/${sessionId}/summary`).expect(500);
    expect((res.body as { error: string }).error).toBe('session_summary_read_failed');
  });
});
