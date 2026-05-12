import type supertest from 'supertest';
import { getRequest, createProject, createAgent } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// Server-side normalization: the `assignee` column should always hold an
// agent's **display name** (`agent.name`), never the id slug. Earlier
// versions of the create/update endpoints accepted any string verbatim,
// which let agents using `scripts/board.sh create` paste their own id
// (e.g. "agent-hub") into `assignee`. That value is technically valid
// as a free-text string but:
//
//   - The autonomous-dispatch SQL filter excludes any card with a
//     non-empty `assignee`, so pre-stamping reserves the card out of
//     the pool the agent presumably wanted it picked up by.
//   - It reads inconsistent in the UI vs. the formal /assign and
//     autonomous-dispatch paths, both of which write `agent.name`.
//
// `normalizeAssignee` (server/routes/board.ts) closes the gap: any
// string that matches a known `agent.id` gets rewritten to `agent.name`
// on write. Unknown strings (human names, "system", etc.) pass through
// untouched — we don't 400 on those, because the column historically
// held human-typed values too.
// ═══════════════════════════════════════════════════════════════════

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

async function getFirstColumnId(projectId: string): Promise<string> {
  const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
  const cols = (boardRes.body as { columns: Array<{ id: string }> }).columns;
  if (!cols[0]) throw new Error('No columns');
  return cols[0].id;
}

describe('assignee normalization on card create/update', () => {
  it('POST /board/cards: normalizes agent.id → agent.name', async () => {
    const project = await createProject();
    const projectId = project.id as string;

    const agent = await createAgent({
      projectId,
      name: 'Hub Lead Dev',
    });
    const agentId = agent.id as string;

    const columnId = await getFirstColumnId(projectId);

    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({
        title: 'Card created with id-as-assignee',
        columnId,
        // Caller habit: pasting the id slug into the display-name column.
        assignee: agentId,
      })
      .expect(200);

    const body = res.body as Record<string, unknown>;
    expect(body.assignee).toBe('Hub Lead Dev');
  });

  it('POST /board/cards: preserves agent.name verbatim', async () => {
    const project = await createProject();
    const projectId = project.id as string;

    await createAgent({
      projectId,
      name: 'Hub Lead Dev',
    });

    const columnId = await getFirstColumnId(projectId);

    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({
        title: 'Card created with name-as-assignee',
        columnId,
        assignee: 'Hub Lead Dev',
      })
      .expect(200);

    const body = res.body as Record<string, unknown>;
    expect(body.assignee).toBe('Hub Lead Dev');
  });

  it('POST /board/cards: passes unknown free-text values through unchanged', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const columnId = await getFirstColumnId(projectId);

    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({
        title: 'Card with human-typed assignee',
        columnId,
        assignee: 'Alice (PM)',
      })
      .expect(200);

    const body = res.body as Record<string, unknown>;
    expect(body.assignee).toBe('Alice (PM)');
  });

  it('POST /board/cards: trims whitespace and converts empty-after-trim to null', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const columnId = await getFirstColumnId(projectId);

    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({
        title: 'Whitespace assignee',
        columnId,
        assignee: '   ',
      })
      .expect(200);

    const body = res.body as Record<string, unknown>;
    expect(body.assignee).toBeNull();
  });

  it('PUT /board/cards/:cardId: normalizes agent.id → agent.name', async () => {
    const project = await createProject();
    const projectId = project.id as string;

    const agent = await createAgent({
      projectId,
      name: 'Hub Lead Dev',
    });
    const agentId = agent.id as string;

    const columnId = await getFirstColumnId(projectId);

    const createRes = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'Card to update', columnId })
      .expect(200);
    const cardId = (createRes.body as Record<string, unknown>).id as string;

    const updateRes = await request
      .put(`/api/projects/${projectId}/board/cards/${cardId}`)
      .send({ assignee: agentId })
      .expect(200);

    const body = updateRes.body as Record<string, unknown>;
    expect(body.assignee).toBe('Hub Lead Dev');
  });

  it('PUT /board/cards/:cardId: explicit null still clears the column', async () => {
    const project = await createProject();
    const projectId = project.id as string;

    await createAgent({
      projectId,
      name: 'Hub Lead Dev',
    });

    const columnId = await getFirstColumnId(projectId);

    const createRes = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'Card to clear', columnId, assignee: 'Hub Lead Dev' })
      .expect(200);
    const cardId = (createRes.body as Record<string, unknown>).id as string;
    expect((createRes.body as Record<string, unknown>).assignee).toBe('Hub Lead Dev');

    const updateRes = await request
      .put(`/api/projects/${projectId}/board/cards/${cardId}`)
      .send({ assignee: null })
      .expect(200);

    const body = updateRes.body as Record<string, unknown>;
    expect(body.assignee).toBeNull();
  });
});
