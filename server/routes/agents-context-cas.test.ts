import type supertest from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';
import { getRequest, createProject, createAgent } from '../test/helpers.js';

// Regression for the ContextFilePanel save race that no client-side guard can
// fix: two saves for the SAME agent + file can be in flight (e.g. a slow first
// save during an A -> B -> A round-trip). The server must enforce write
// ordering via compare-and-swap on `expectedPrevious` so a stale/out-of-order
// request cannot commit over a newer one on disk.
describe('PUT /api/agents/:agentId/context/:filename — compare-and-swap ordering', () => {
  let request: supertest.Agent;

  beforeAll(async () => {
    request = await getRequest();
  }, 60_000);

  async function setup() {
    const project = await createProject();
    expect(project.ahw).toBeTruthy();
    const agent = await createAgent({ projectId: project.id as string });
    return { agentId: agent.id as string };
  }

  const read = async (agentId: string): Promise<string | undefined> => {
    const res = await request.get(`/api/agents/${agentId}/context`).expect(200);
    return (res.body as Record<string, string | undefined>)['AGENTS.md'];
  };

  it('rejects a stale write whose base no longer matches the file', async () => {
    const { agentId } = await setup();

    // Seed the file (no base sent → unconditional write).
    await request
      .put(`/api/agents/${agentId}/context/AGENTS.md`)
      .send({ content: 'V1' })
      .expect(200);
    expect(await read(agentId)).toBe('V1');

    // A newer save, correctly based on V1, lands first and moves the file to X.
    await request
      .put(`/api/agents/${agentId}/context/AGENTS.md`)
      .send({ content: 'X', expectedPrevious: 'V1' })
      .expect(200);
    expect(await read(agentId)).toBe('X');

    // The stale save (still based on V1) arrives late. It must be rejected with
    // 409 and must NOT clobber X on disk.
    const stale = await request
      .put(`/api/agents/${agentId}/context/AGENTS.md`)
      .send({ content: 'Y', expectedPrevious: 'V1' })
      .expect(409);
    expect(stale.body.error).toBe('stale_write');
    expect(await read(agentId)).toBe('X');

    // A save correctly based on the current content still succeeds.
    await request
      .put(`/api/agents/${agentId}/context/AGENTS.md`)
      .send({ content: 'Z', expectedPrevious: 'X' })
      .expect(200);
    expect(await read(agentId)).toBe('Z');
  });

  it('treats an empty-string base as "expected no existing file"', async () => {
    const { agentId } = await setup();

    // First writer bases on empty (file absent) and creates it.
    await request
      .put(`/api/agents/${agentId}/context/IDENTITY.md`)
      .send({ content: 'FIRST', expectedPrevious: '' })
      .expect(200);
    const idRes = await request.get(`/api/agents/${agentId}/context`).expect(200);
    expect((idRes.body as Record<string, string>)['IDENTITY.md']).toBe('FIRST');

    // A second create that still assumes an empty file is now stale → 409.
    await request
      .put(`/api/agents/${agentId}/context/IDENTITY.md`)
      .send({ content: 'SECOND', expectedPrevious: '' })
      .expect(409);
    const idRes2 = await request.get(`/api/agents/${agentId}/context`).expect(200);
    expect((idRes2.body as Record<string, string>)['IDENTITY.md']).toBe('FIRST');
  });

  it('still allows an unconditional write when no base is provided', async () => {
    const { agentId } = await setup();
    await request
      .put(`/api/agents/${agentId}/context/AGENTS.md`)
      .send({ content: 'A' })
      .expect(200);
    // No expectedPrevious → last write wins (back-compat for non-UI callers).
    await request
      .put(`/api/agents/${agentId}/context/AGENTS.md`)
      .send({ content: 'B' })
      .expect(200);
    expect(await read(agentId)).toBe('B');
  });
});
