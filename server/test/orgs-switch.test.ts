import type supertest from 'supertest';
import { getRequest } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

// ═══════════════════════════════════════════════════════════════════
// Org switch — regression guard for RouteDeps wiring
//
// Bug class: a dep declared on RouteDeps but never wired into the
// production routeDeps object in server/index.ts. Both `scheduleAll`
// (historical) and `ensureSkillBuilderAgents` (the per-project Skill
// Builder backfill, now run inside performOrgSwitch) are consumed by the
// org-switch handler, so an unwired dep throws "<dep> is not a function",
// returns 500, and breaks the UI on client connect (the UI issues a
// switch to the active org on load).
//
// These tests exercise the real app via supertest, so if the factory
// destructures an undefined dep the endpoint would return 500. The
// explicit routeDeps shape assertions below pin the wiring at runtime so
// a removal from server/index.ts can't regress silently past TypeScript
// (e.g. via a cast).
// ═══════════════════════════════════════════════════════════════════

describe('routeDeps wiring (org switch dependencies)', () => {
  it('wires every dep the switch handler consumes as a function', async () => {
    // Lazy import — getRequest() in beforeAll already booted index.js, so this
    // returns the cached module without adding module-evaluation-time startup
    // side effects (a top-level static import would re-order boot in a shard
    // and pollute sibling org tests).
    const { routeDeps } = await import('../index.js');
    expect(typeof routeDeps.scheduleAll).toBe('function');
    expect(typeof routeDeps.reloadProjects).toBe('function');
    // performOrgSwitch backfills the per-project Skill Builder coach.
    expect(typeof routeDeps.ensureSkillBuilderAgents).toBe('function');
  });
});

describe('POST /api/orgs/:id/switch', () => {
  it('switches to the default org without error', async () => {
    const res = await request.post('/api/orgs/default/switch').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.orgId).toBe('default');
    expect(typeof res.body.projects).toBe('number');
    expect(typeof res.body.agents).toBe('number');
  });

  it('is a no-op when the org is already active (avoids scheduler storm)', async () => {
    await request.post('/api/orgs/default/switch').expect(200);
    const res = await request.post('/api/orgs/default/switch').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.orgId).toBe('default');
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
