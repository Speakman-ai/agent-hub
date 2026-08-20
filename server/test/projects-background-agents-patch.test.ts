import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// PATCH /api/projects/:projectId — backgroundAgents.wiki
//
// The wiki background agent is a project-scoped scheduled job that
// dispatches the wiki documentation backfill on a cadence. This exercises
// the PATCH validation/persistence: enable toggle, schedule (cron-validated),
// model override, per-run limit, and owner-user resolution.
// ═══════════════════════════════════════════════════════════════════

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

type WikiCfg = {
  enabled?: boolean;
  schedule?: string;
  model?: string | null;
  limit?: number;
  ownerUserId?: string | null;
};
type Body = { backgroundAgents?: { wiki?: WikiCfg } };

describe('PATCH /api/projects/:projectId — backgroundAgents.wiki', () => {
  it('persists enabling the wiki agent with a schedule, model and limit', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        backgroundAgents: {
          wiki: { enabled: true, schedule: '0 6 * * *', model: 'claude-sonnet-5', limit: 5 },
        },
      })
      .expect(200);
    expect((res.body as Body).backgroundAgents?.wiki).toEqual({
      enabled: true,
      schedule: '0 6 * * *',
      model: 'claude-sonnet-5',
      limit: 5,
    });
  });

  it('rejects a model that is not in the engine allowlist with 400', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ backgroundAgents: { wiki: { model: 'not-a-real-model' } } })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/must be a valid .* model/);
  });

  it('merges a partial update onto the existing wiki config', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ backgroundAgents: { wiki: { enabled: true, schedule: '0 6 * * *' } } })
      .expect(200);
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ backgroundAgents: { wiki: { enabled: false } } })
      .expect(200);
    expect((res.body as Body).backgroundAgents?.wiki).toEqual({
      enabled: false,
      schedule: '0 6 * * *',
    });
  });

  it('clears the wiki agent when null is sent', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ backgroundAgents: { wiki: { enabled: true } } })
      .expect(200);
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ backgroundAgents: { wiki: null } })
      .expect(200);
    expect((res.body as Body).backgroundAgents?.wiki).toBeUndefined();
  });

  it('rejects an invalid cron schedule with 400', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ backgroundAgents: { wiki: { schedule: 'not a cron' } } })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/valid cron expression/);
  });

  it('rejects a non-boolean enabled with 400', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ backgroundAgents: { wiki: { enabled: 'yes' } } })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/enabled must be a boolean/);
  });

  it('rejects a limit outside 1..50 with 400', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ backgroundAgents: { wiki: { limit: 999 } } })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(
      /limit must be a number between 1 and 50/,
    );
  });

  it('rejects an unknown ownerUserId with 400 but accepts null', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ backgroundAgents: { wiki: { ownerUserId: 'nobody-here' } } })
      .expect(400);
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ backgroundAgents: { wiki: { enabled: true, ownerUserId: null } } })
      .expect(200);
    expect((res.body as Body).backgroundAgents?.wiki).toEqual({ enabled: true, ownerUserId: null });
  });
});
