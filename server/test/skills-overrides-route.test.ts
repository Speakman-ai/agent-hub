import { getRequest, createProject, createAgent } from './helpers.js';
import type supertest from 'supertest';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('GET /api/agents/:agentId/skills/overrides', () => {
  // Regression: the `/overrides` route was registered AFTER `/:skillId`
  // inside server/routes/skills.ts. Express matches in registration order,
  // so requests for `/skills/overrides` hit the `:skillId='overrides'`
  // handler, which looks for a skill directory named "overrides" on disk
  // and 404s when it doesn't exist. The fix re-orders the two routes so
  // `/overrides` matches first.
  it('returns 200 with an array, not 404, for a valid agent', async () => {
    const project = await createProject();
    const agent = await createAgent({ projectId: project.id as string });

    const res = await request.get(`/api/agents/${agent.id}/skills/overrides`).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('is not shadowed by the /:skillId route when the agent has no workspace', async () => {
    // The `:skillId` handler short-circuits on `!found.project.ahw` with a
    // 404 ("No workspace configured"). If the route order regresses, this
    // test catches it — `/overrides` for a workspace-less project must
    // still succeed because it should never reach the `:skillId` handler.
    const project = await createProject({ ahw: null });
    const agent = await createAgent({ projectId: project.id as string });

    const res = await request.get(`/api/agents/${agent.id}/skills/overrides`).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
