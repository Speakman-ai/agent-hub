/**
 * Isolated fork: `ensureSkillBuilderAgents` is mocked to throw so we can assert the
 * onboard route fails the HTTP request instead of returning 201 with a
 * silently incomplete specialist roster.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type supertest from 'supertest';

vi.mock('../project-model.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../project-model.js')>();
  return {
    ...actual,
    ensureSkillBuilderAgents: () => {
      throw new Error('simulated specialist seed failure');
    },
  };
});

import { getRequest } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
}, 60_000);

describe('POST /api/projects/onboard — specialist seeding errors', () => {
  it('returns 500 when specialist seeding throws', async () => {
    const projId = `onboard-seed-fail-${Date.now()}`;
    const res = await request.post('/api/projects/onboard').send({
      project: { id: projId, name: 'Seed Fail', cwd: '/tmp' },
      agents: [
        {
          id: `${projId}-dev`,
          name: 'Dev',
          engine: 'claude-code',
          systemPrompt: 'You are the dev agent.',
        },
      ],
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('specialist_agent_seeding_failed');
    expect(String(res.body.message)).toContain('simulated specialist seed failure');
  });

  it('rolls back the project so the id is not left reserved (GET 404)', async () => {
    const projId = `onboard-seed-rollback-${Date.now()}`;
    const res = await request.post('/api/projects/onboard').send({
      project: { id: projId, name: 'Seed Fail', cwd: '/tmp' },
      agents: [
        {
          id: `${projId}-dev`,
          name: 'Dev',
          engine: 'claude-code',
          systemPrompt: 'You are the dev agent.',
        },
      ],
    });
    expect(res.status).toBe(500);
    const getRes = await request.get(`/api/projects/${projId}`);
    expect(getRes.status).toBe(404);
  });
});
