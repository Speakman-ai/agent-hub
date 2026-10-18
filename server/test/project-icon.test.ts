import { beforeAll, describe, expect, it } from 'vitest';
import type supertest from 'supertest';
import { createProject, getRequest } from './helpers.js';

let request: supertest.Agent;
beforeAll(async () => {
  request = await getRequest();
});

describe('project icons', () => {
  it('creates, updates, lists and clears an icon without losing the accent color', async () => {
    const project = await createProject({ icon: '👩🏽‍💻', color: '#123456' });
    expect(project.icon).toBe('👩🏽‍💻');
    const url = `/api/projects/${project.id}`;
    const updated = await request.patch(url).send({ icon: ' ★ ' }).expect(200);
    expect(updated.body.icon).toBe('★');
    expect(updated.body.color).toBe('#123456');
    const list = await request.get('/api/projects').expect(200);
    expect(list.body.find((p: { id: string }) => p.id === project.id).icon).toBe('★');
    await request.patch(url).send({ name: 'Renamed' }).expect(200);
    expect((await request.get(url).expect(200)).body.icon).toBe('★');
    await request.patch(url).send({ icon: '' }).expect(200);
    expect((await request.get(url).expect(200)).body.icon).toBeNull();
    await request.patch(url).send({ icon: null }).expect(200);
  });

  it('preserves icons through export and both import paths', async () => {
    const source = await createProject({ icon: '🚀' });
    const exported = await request.get(`/api/projects/${source.id}/export`).expect(200);
    expect(exported.body.project.icon).toBe('🚀');
    const imported = await request.post('/api/projects/import').send(exported.body).expect(201);
    expect(imported.body.project.icon).toBe('🚀');
    const target = await createProject({ icon: '★' });
    await request.post(`/api/projects/${target.id}/import`).send(exported.body).expect(200);
    expect((await request.get(`/api/projects/${target.id}`).expect(200)).body.icon).toBe('🚀');
    exported.body.project.icon = null;
    await request.post(`/api/projects/${target.id}/import`).send(exported.body).expect(200);
    expect((await request.get(`/api/projects/${target.id}`).expect(200)).body.icon).toBeNull();
  });

  it('rejects invalid imported icons without creating a project', async () => {
    const id = 'invalid-import-icon';
    await request
      .post('/api/projects/import')
      .send({ version: 3, type: 'project', project: { id, icon: {} } })
      .expect(400);
    await request.get(`/api/projects/${id}`).expect(404);
  });

  it.each([42, {}, ['🚀'], 'x'.repeat(33), 'one\ntwo'])(
    'rejects invalid icon %j before changing the project',
    async (icon) => {
      const project = await createProject({ name: 'Original' });
      await request
        .patch(`/api/projects/${project.id}`)
        .send({ name: 'Changed', icon })
        .expect(400);
      expect((await request.get(`/api/projects/${project.id}`).expect(200)).body.name).toBe(
        'Original',
      );
      await request
        .post('/api/projects')
        .send({ id: `${project.id}-invalid`, icon })
        .expect(400);
    },
  );
});
