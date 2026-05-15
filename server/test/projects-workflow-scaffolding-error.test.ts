/**
 * Workflow POST /api/projects — when specialist seeding throws, the handler must
 * fail closed and roll back the persisted project (parity with /onboard).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type supertest from 'supertest';

vi.mock('../project-model.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../project-model.js')>();
  return {
    ...actual,
    ensureDocsAgents: () => {
      throw new Error('simulated workflow specialist seed failure');
    },
  };
});

import { getRequest } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
}, 60_000);

describe('POST /api/projects — workflow scaffolding errors', () => {
  it('returns 500 and rolls back when specialist seeding throws', async () => {
    const projectId = `wf-scaffold-fail-${Date.now()}`;
    const res = await request.post('/api/projects').send({
      id: projectId,
      name: 'WF Fail',
      cwd: '/tmp',
      mode: 'workflow',
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('workflow_scaffolding_failed');
    expect(String(res.body.message)).toContain('simulated workflow specialist seed failure');

    const getRes = await request.get(`/api/projects/${projectId}`);
    expect(getRes.status).toBe(404);
  });
});
