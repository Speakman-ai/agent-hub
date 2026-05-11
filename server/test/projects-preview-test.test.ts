/**
 * Integration tests for POST /api/projects/:projectId/preview/test.
 *
 * The route delegates to `runPreviewTest()` — these tests verify the
 * wire-level contract (404 on unknown project, well-formed shape) and
 * the validation branches that don't need a child process (preview not
 * enabled, missing cwd). The runner itself has dedicated unit tests in
 * `server/preview/preview-test.test.ts` that exercise all the spawn /
 * health / screenshot / teardown branches with injected fakes.
 */

import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('POST /api/projects/:projectId/preview/test', () => {
  it('returns 404 for an unknown project id', async () => {
    await request.post('/api/projects/no-such-project/preview/test').send({}).expect(404);
  });

  it('returns ok:false with a clear error when preview is not enabled', async () => {
    const project = await createProject({ cwd: '/tmp' });
    const projectId = project.id as string;

    const res = await request.post(`/api/projects/${projectId}/preview/test`).send({}).expect(200);
    const body = res.body as {
      ok: boolean;
      error?: string;
      ports: { allocated: number | null };
    };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/not enabled/i);
    expect(body.ports.allocated).toBeNull();
  });

  it('returns the documented shape: { ok, ports, durationMs, error? }', async () => {
    const project = await createProject({ cwd: '/tmp' });
    const projectId = project.id as string;

    const res = await request.post(`/api/projects/${projectId}/preview/test`).send({}).expect(200);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty('ok');
    expect(body).toHaveProperty('ports');
    expect(body).toHaveProperty('durationMs');
    expect(typeof body.durationMs).toBe('number');
    expect(body.ports).toEqual({ allocated: null });
  });
});
