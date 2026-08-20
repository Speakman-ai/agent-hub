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

type CustomCfg = {
  id: string;
  name: string;
  prompt: string;
  enabled?: boolean;
  schedule?: string;
  ownerUserId?: string | null;
  model?: string | null;
  engine?: string | null;
};
type CustomBody = { backgroundAgents?: { custom?: CustomCfg[] } };

describe('PATCH /api/projects/:projectId — backgroundAgents.custom', () => {
  it('persists an added custom agent with its editable prompt', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        backgroundAgents: {
          custom: [
            {
              id: 'agent-1',
              name: 'Nightly digest',
              enabled: true,
              schedule: '0 2 * * *',
              prompt: 'Summarize open PRs',
            },
          ],
        },
      })
      .expect(200);
    const list = (res.body as CustomBody).backgroundAgents?.custom;
    expect(list).toHaveLength(1);
    expect(list?.[0]).toMatchObject({
      id: 'agent-1',
      name: 'Nightly digest',
      enabled: true,
      schedule: '0 2 * * *',
      prompt: 'Summarize open PRs',
    });
  });

  it('supports multiple custom agents in one project', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        backgroundAgents: {
          custom: [
            { id: 'a1', name: 'One', prompt: 'p1' },
            { id: 'a2', name: 'Two', prompt: 'p2' },
          ],
        },
      })
      .expect(200);
    expect((res.body as CustomBody).backgroundAgents?.custom).toHaveLength(2);
  });

  it('rejects a custom agent with a blank prompt', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ backgroundAgents: { custom: [{ id: 'a1', name: 'X', prompt: '   ' }] } })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/prompt is required/);
  });

  it('rejects a custom agent with a missing name', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ backgroundAgents: { custom: [{ id: 'a1', prompt: 'do it' }] } })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/name is required/);
  });

  it('rejects a duplicate custom agent id', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        backgroundAgents: {
          custom: [
            { id: 'dup', name: 'A', prompt: 'x' },
            { id: 'dup', name: 'B', prompt: 'y' },
          ],
        },
      })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/id is duplicated/);
  });

  it('rejects an invalid custom cron schedule', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        backgroundAgents: {
          custom: [{ id: 'a1', name: 'A', prompt: 'x', schedule: 'not a cron' }],
        },
      })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/valid cron expression/);
  });

  it('clears custom agents when an empty array is sent', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ backgroundAgents: { custom: [{ id: 'a1', name: 'A', prompt: 'x' }] } })
      .expect(200);
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ backgroundAgents: { custom: [] } })
      .expect(200);
    expect((res.body as CustomBody).backgroundAgents?.custom).toEqual([]);
  });
});
