import type TestAgent from 'supertest/lib/agent.js';
import { getRequest } from '../test/helpers.js';
import { recordStatementTiming, resetDbInstrumentationStats } from '../db-instrumentation.js';

let request: TestAgent;

beforeAll(async () => {
  request = await getRequest();
});

describe('GET /api/config/db-stats', () => {
  beforeEach(() => resetDbInstrumentationStats());

  it('returns the instrumentation snapshot shape', async () => {
    const res = await request.get('/api/config/db-stats').expect(200);
    expect(res.body).toHaveProperty('enabled');
    expect(res.body).toHaveProperty('slowThresholdMs');
    expect(res.body).toHaveProperty('totalCalls');
    expect(res.body).toHaveProperty('totalSlowCalls');
    expect(Array.isArray(res.body.statements)).toBe(true);
  });

  it('surfaces recorded timings sorted by total wall time', async () => {
    recordStatementTiming('slowStmt', 120);
    recordStatementTiming('fastStmt', 2);
    const res = await request.get('/api/config/db-stats').expect(200);
    const tags = (res.body.statements as Array<{ tag: string }>).map((s) => s.tag);
    expect(tags.indexOf('slowStmt')).toBeLessThan(tags.indexOf('fastStmt'));
    expect(res.body.totalCalls).toBeGreaterThanOrEqual(2);
  });
});

describe('POST /api/config/db-stats/reset', () => {
  it('clears accumulated aggregates', async () => {
    recordStatementTiming('q', 5);
    await request.post('/api/config/db-stats/reset').expect(200);
    const res = await request.get('/api/config/db-stats').expect(200);
    expect(res.body.totalCalls).toBe(0);
    expect(res.body.statements).toHaveLength(0);
  });
});
