import type supertest from 'supertest';
import { getRequest } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

// ═══════════════════════════════════════════════════════════════════
// Org switch — regression guard for `scheduleAll` wiring
//
// Bug: `scheduleAll` was declared as an optional field on RouteDeps but
// never wired into the routeDeps object in server/index.ts. Every call
// to POST /api/org/switch or POST /api/orgs/:id/switch threw
// "scheduleAll is not a function", returning 500 and breaking the UI
// on client connect (the UI issues a switch to the active org on load).
//
// These tests exercise the real app via supertest, so if the factory
// destructures an undefined dep the endpoint would return 500.
// ═══════════════════════════════════════════════════════════════════

describe('POST /api/orgs/:id/switch', () => {
  it('switches to the default org without error', async () => {
    const res = await request.post('/api/orgs/default/switch').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.orgId).toBe('default');
    expect(typeof res.body.projects).toBe('number');
    expect(typeof res.body.agents).toBe('number');
  });

  it('returns 404 for an unknown org', async () => {
    await request.post('/api/orgs/does-not-exist/switch').expect(404);
  });
});

describe('POST /api/org/switch', () => {
  it('switches via the legacy body-param endpoint', async () => {
    const res = await request.post('/api/org/switch').send({ orgId: 'default' }).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.orgId).toBe('default');
  });

  it('rejects missing orgId with 400', async () => {
    await request.post('/api/org/switch').send({}).expect(400);
  });
});
