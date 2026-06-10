import { getRequest, createProject, createAgent } from './helpers.js';
import type supertest from 'supertest';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('GET /api/agents/:agentId/skills — allowlist editor options list', () => {
  // Regression: the per-agent skill allowlist made `listEnabledSkills` apply
  // the allowlist + overrides. This management endpoint MUST stay the
  // UNFILTERED merge — it backs the Settings checkbox list the operator uses
  // to EDIT the allowlist, so a restricted (or fully-denied) agent must still
  // see every skill, otherwise a previously denied skill can never be re-added.
  it('returns the full skill set regardless of the agent allowlist', async () => {
    const project = await createProject();

    // Unrestricted agent — baseline full set.
    const open = await createAgent({ projectId: project.id as string });
    const openRes = await request.get(`/api/agents/${open.id}/skills`).expect(200);
    const fullIds = (openRes.body as Array<{ id: string }>).map((s) => s.id).sort();
    expect(fullIds.length).toBeGreaterThan(0);

    // Fully-restricted agent (empty allowlist => the runtime/prompt list would
    // be empty). Same project => same skills dir.
    const locked = await createAgent({
      projectId: project.id as string,
      allowedSkills: [],
    });
    const lockedRes = await request.get(`/api/agents/${locked.id}/skills`).expect(200);
    const lockedIds = (lockedRes.body as Array<{ id: string }>).map((s) => s.id).sort();

    // The options list is identical — the allowlist does not filter it.
    expect(lockedIds).toEqual(fullIds);

    // Restrict to a single skill; the options list still shows everything.
    const partial = await createAgent({
      projectId: project.id as string,
      allowedSkills: [fullIds[0] as string],
    });
    const partialRes = await request.get(`/api/agents/${partial.id}/skills`).expect(200);
    const partialIds = (partialRes.body as Array<{ id: string }>).map((s) => s.id).sort();
    expect(partialIds).toEqual(fullIds);
  });

  it('tags each skill with its source so the editor can group them', async () => {
    const agent = await createAgent();
    const res = await request.get(`/api/agents/${agent.id}/skills`).expect(200);
    const body = res.body as Array<{ id: string; source: string }>;
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((s) => s.source === 'project' || s.source === 'default')).toBe(true);
  });
});
