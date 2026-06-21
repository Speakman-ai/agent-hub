import { describe, it, expect, beforeAll } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createProject, createAgent } from './helpers.js';
import { resolveUserSettingsKey, LOCAL_USER_KEY } from '../user-project-settings.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
}, 60_000);

describe('user-project-settings helper', () => {
  it('resolveUserSettingsKey returns the user id when present', () => {
    expect(resolveUserSettingsKey('user-123')).toBe('user-123');
  });

  it('resolveUserSettingsKey buckets null/empty under the local sentinel', () => {
    expect(resolveUserSettingsKey(null)).toBe(LOCAL_USER_KEY);
    expect(resolveUserSettingsKey(undefined)).toBe(LOCAL_USER_KEY);
    expect(resolveUserSettingsKey('')).toBe(LOCAL_USER_KEY);
  });
});

describe('GET/PUT /api/projects/:projectId/user-settings', () => {
  it('returns null default before any preference is set', async () => {
    const project = await createProject();
    const res = await request.get(`/api/projects/${project.id}/user-settings`).expect(200);
    expect(res.body.projectId).toBe(project.id);
    expect(res.body.defaultFinalizeAutomation).toBeNull();
  });

  it('persists a chosen level and reads it back', async () => {
    const project = await createProject();
    const put = await request
      .put(`/api/projects/${project.id}/user-settings`)
      .send({ defaultFinalizeAutomation: 'push' })
      .expect(200);
    expect(put.body.defaultFinalizeAutomation).toBe('push');

    const get = await request.get(`/api/projects/${project.id}/user-settings`).expect(200);
    expect(get.body.defaultFinalizeAutomation).toBe('push');
  });

  it('upserts (changes) an existing preference', async () => {
    const project = await createProject();
    await request
      .put(`/api/projects/${project.id}/user-settings`)
      .send({ defaultFinalizeAutomation: 'review' })
      .expect(200);
    const put2 = await request
      .put(`/api/projects/${project.id}/user-settings`)
      .send({ defaultFinalizeAutomation: 'merge' })
      .expect(200);
    expect(put2.body.defaultFinalizeAutomation).toBe('merge');
  });

  it('clears the preference with null', async () => {
    const project = await createProject();
    await request
      .put(`/api/projects/${project.id}/user-settings`)
      .send({ defaultFinalizeAutomation: 'merge' })
      .expect(200);
    const cleared = await request
      .put(`/api/projects/${project.id}/user-settings`)
      .send({ defaultFinalizeAutomation: null })
      .expect(200);
    expect(cleared.body.defaultFinalizeAutomation).toBeNull();
  });

  it('leaves an existing preference unchanged on PUT with no key', async () => {
    const project = await createProject();
    await request
      .put(`/api/projects/${project.id}/user-settings`)
      .send({ defaultFinalizeAutomation: 'push' })
      .expect(200);
    // A partial update with the key omitted must NOT clear the stored value.
    const noChange = await request
      .put(`/api/projects/${project.id}/user-settings`)
      .send({})
      .expect(200);
    expect(noChange.body.defaultFinalizeAutomation).toBe('push');

    const get = await request.get(`/api/projects/${project.id}/user-settings`).expect(200);
    expect(get.body.defaultFinalizeAutomation).toBe('push');
  });

  it('rejects a non-object body with 400 (not 500)', async () => {
    const project = await createProject();
    // A bare JSON primitive — the `in` check would throw a TypeError → 500
    // without an explicit object guard.
    await request
      .put(`/api/projects/${project.id}/user-settings`)
      .set('Content-Type', 'application/json')
      .send('"x"')
      .expect(400);
    // A JSON array is also not a settings object.
    await request
      .put(`/api/projects/${project.id}/user-settings`)
      .set('Content-Type', 'application/json')
      .send('["push"]')
      .expect(400);
  });

  it('rejects an unknown level with 400', async () => {
    const project = await createProject();
    await request
      .put(`/api/projects/${project.id}/user-settings`)
      .send({ defaultFinalizeAutomation: 'ship-it' })
      .expect(400);
  });

  it('404s for an unknown project', async () => {
    await request.get('/api/projects/does-not-exist/user-settings').expect(404);
    await request
      .put('/api/projects/does-not-exist/user-settings')
      .send({ defaultFinalizeAutomation: 'push' })
      .expect(404);
  });
});

describe('new sessions inherit the per-user project default', () => {
  it('applies the stored default to a manually-created session', async () => {
    const project = await createProject();
    const agent = await createAgent({ projectId: project.id as string });
    await request
      .put(`/api/projects/${project.id}/user-settings`)
      .send({ defaultFinalizeAutomation: 'push' })
      .expect(200);

    const res = await request
      .post(`/api/agents/${agent.id}/sessions`)
      .send({ name: 'Inherits default' })
      .expect(200);
    expect(res.body.finalize_automation).toBe('push');
  });

  it('leaves finalize_automation null when the user has no preference', async () => {
    const project = await createProject();
    const agent = await createAgent({ projectId: project.id as string });

    const res = await request
      .post(`/api/agents/${agent.id}/sessions`)
      .send({ name: 'No default' })
      .expect(200);
    // No stored preference → the session falls back to the global default.
    expect(res.body.finalize_automation).toBe('manual');
  });
});
