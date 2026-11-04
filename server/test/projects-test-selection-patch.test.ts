import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

// PATCH /api/projects/:projectId — testSelection. `mode: dynamic` depends on
// the full CI run after every default-branch merge (ciOnPush), so the two
// settings are validated together.

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

type Body = {
  error?: string;
  code?: string;
  name?: string;
  testSelection?: Record<string, unknown>;
  ciOnPush?: { enabled?: boolean };
};

describe('PATCH /api/projects/:projectId — testSelection', () => {
  it('accepts mode dynamic without ciOnPush', async () => {
    const { id } = await createProject();
    const res = await request
      .patch(`/api/projects/${id}`)
      .send({ name: 'renamed', testSelection: { mode: 'dynamic' } })
      .expect(200);
    expect((res.body as Body).testSelection).toEqual({ mode: 'dynamic' });
    expect((res.body as Body).name).toBe('renamed');
  });

  it('accepts mode dynamic when ciOnPush is enabled in the same request', async () => {
    const { id } = await createProject();
    const res = await request
      .patch(`/api/projects/${id}`)
      .send({
        ciOnPush: { enabled: true },
        testSelection: { mode: 'dynamic', alwaysRun: ['lint', ' lint ', 'build'] },
      })
      .expect(200);
    expect((res.body as Body).testSelection).toEqual({
      mode: 'dynamic',
      alwaysRun: ['lint', 'build'],
    });
  });

  it('allows turning ciOnPush off while dynamic is on', async () => {
    const { id } = await createProject();
    await request
      .patch(`/api/projects/${id}`)
      .send({ ciOnPush: { enabled: true }, testSelection: { mode: 'dynamic' } })
      .expect(200);

    const res = await request
      .patch(`/api/projects/${id}`)
      .send({ ciOnPush: { enabled: false } })
      .expect(200);
    expect((res.body as Body).ciOnPush).toEqual({ enabled: false });
    expect((res.body as Body).testSelection).toEqual({ mode: 'dynamic' });
  });

  it('rejects a malformed testSelection without applying other fields', async () => {
    const { id } = await createProject();
    const before = await request.get(`/api/projects/${id}`).expect(200);
    const res = await request
      .patch(`/api/projects/${id}`)
      .send({ name: 'renamed', testSelection: { mode: 'smart' } })
      .expect(400);
    expect((res.body as Body).error).toMatch(/testSelection.mode must be one of/);
    const after = await request.get(`/api/projects/${id}`).expect(200);
    expect((after.body as Body).name).toBe((before.body as Body).name);
    expect((after.body as Body).testSelection).toBeUndefined();
  });

  it('rejects malformed values', async () => {
    const { id } = await createProject();
    const bad = await request
      .patch(`/api/projects/${id}`)
      .send({ testSelection: { mode: 'smart' } })
      .expect(400);
    expect((bad.body as Body).error).toMatch(/testSelection.mode must be one of full, dynamic/);
    await request
      .patch(`/api/projects/${id}`)
      .send({ testSelection: { fullRunPaths: 'x' } })
      .expect(400);
  });

  it('clears the setting when null is sent', async () => {
    const { id } = await createProject();
    await request
      .patch(`/api/projects/${id}`)
      .send({ testSelection: { fullRunPaths: ['docs/schema/**'] } })
      .expect(200);
    const res = await request
      .patch(`/api/projects/${id}`)
      .send({ testSelection: null })
      .expect(200);
    expect((res.body as Body).testSelection).toBeUndefined();
  });
});
