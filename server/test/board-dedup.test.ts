import type supertest from 'supertest';
import { getRequest, createProject, createAgent, createCard } from './helpers.js';

let request: supertest.Agent;
let projectId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
});

// ═══════════════════════════════════════════════════════════════════
// Board card deduplication
// ═══════════════════════════════════════════════════════════════════

describe('Card creation deduplication', () => {
  let columnId: string;

  beforeAll(async () => {
    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const body = boardRes.body as { columns: Array<{ id: string; name: string }> };
    columnId = body.columns[0]?.id;
  });

  it('returns existing card when creating with duplicate title', async () => {
    const title = 'Unique dedup test card';

    // First creation succeeds
    const res1 = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title, columnId, description: 'first' })
      .expect(200);
    const card1 = res1.body as { id: string; title: string };
    expect(card1.title).toBe(title);

    // Second creation with same title returns existing card
    const res2 = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title, columnId, description: 'second' })
      .expect(200);
    const card2 = res2.body as { id: string; title: string };
    expect(card2.id).toBe(card1.id);
  });

  it('deduplicates case-insensitively', async () => {
    const res1 = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'Case Test Card', columnId })
      .expect(200);
    const card1 = res1.body as { id: string };

    const res2 = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'case test card', columnId })
      .expect(200);
    const card2 = res2.body as { id: string };

    expect(card2.id).toBe(card1.id);
  });

  it('deduplicates across surrounding whitespace (trim normalization)', async () => {
    // The dedup query normalizes with lower(trim(title)); a padded title must
    // still collide with its trimmed twin.
    const res1 = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'Trim Test Card', columnId })
      .expect(200);
    const card1 = res1.body as { id: string };

    const res2 = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: '  trim test card  ', columnId })
      .expect(200);
    const card2 = res2.body as { id: string };

    expect(card2.id).toBe(card1.id);
  });

  it('deduplicates non-ASCII titles case-insensitively (Unicode fold)', async () => {
    // SQLite's built-in lower() folds ASCII only, so a naive lower(title)
    // predicate would treat "Éclair" and "éclair" as distinct and create a
    // duplicate. The dedup must fold the full Unicode range (JS toLowerCase).
    const res1 = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'Éclair Recipe', columnId })
      .expect(200);
    const card1 = res1.body as { id: string };

    const res2 = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'éclair recipe', columnId })
      .expect(200);
    const card2 = res2.body as { id: string };

    expect(card2.id).toBe(card1.id);
  });

  it('allows cards with different titles', async () => {
    const res1 = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'Card Alpha', columnId })
      .expect(200);
    const card1 = res1.body as { id: string };

    const res2 = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'Card Beta', columnId })
      .expect(200);
    const card2 = res2.body as { id: string };

    expect(card2.id).not.toBe(card1.id);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Session-id deduplication — guards the "kanban assign spawns
// duplicate card via Bias-to-Action prompt" failure mode (card
// ddfa8ba5). When an agent has been spawned via /assign, its session
// is already linked to a card; if the agent then POSTs a *new* card
// with that same session_id, the server must return the existing card
// instead of opening a parallel ticket.
// ═══════════════════════════════════════════════════════════════════

describe('Card creation deduplication by session_id', () => {
  let dedupProjectId: string;
  let dedupColumnId: string;
  let dedupAgentId: string;

  beforeAll(async () => {
    const project = await createProject();
    dedupProjectId = project.id as string;
    const agent = await createAgent({ projectId: dedupProjectId });
    dedupAgentId = agent.id as string;
    const boardRes = await request.get(`/api/projects/${dedupProjectId}/board`).expect(200);
    const body = boardRes.body as { columns: Array<{ id: string; name: string }> };
    dedupColumnId = body.columns[0]?.id as string;
  });

  it('returns existing card when create payload reuses an already-linked session_id', async () => {
    // Set up: create a card, assign an agent, capture the linked sessionId.
    const original = await createCard(dedupProjectId, {
      title: 'Original ticket spawned via assign',
      description: 'Body of the original ticket',
    });
    const assignRes = await request
      .post(`/api/projects/${dedupProjectId}/board/cards/${original.id}/assign`)
      .send({ agentId: dedupAgentId })
      .expect(200);
    const linkedSessionId = (assignRes.body as { sessionId: string }).sessionId;
    expect(linkedSessionId).toBeTruthy();

    // The agent — following the Bias-to-Action prompt — POSTs a new card
    // with the same session_id and a paraphrased title. Server should
    // short-circuit and hand back the original card.
    const dupRes = await request
      .post(`/api/projects/${dedupProjectId}/board/cards`)
      .send({
        title: 'Original ticket — reworded by agent',
        columnId: dedupColumnId,
        session_id: linkedSessionId,
      })
      .expect(200);

    const dup = dupRes.body as { id: string };
    expect(dup.id).toBe(original.id as string);
  });

  it('still creates a new card when the session is unlinked', async () => {
    // A session_id that has never been stamped on a card must NOT collide
    // with any existing row — the dedup guard is keyed on the existing
    // link, not on the mere presence of session_id.
    const fakeSessionId = 'unlinked-session-' + Math.random().toString(36).slice(2, 10);
    const res = await request
      .post(`/api/projects/${dedupProjectId}/board/cards`)
      .send({
        title: 'Brand new card with unlinked session',
        columnId: dedupColumnId,
        session_id: fakeSessionId,
      })
      .expect(200);
    const card = res.body as { id: string; session_id: string | null };
    expect(card.id).toBeTruthy();
    expect(card.session_id).toBe(fakeSessionId);
  });

  it('does not collide across boards in different projects', async () => {
    // Set up project A with a session linked to a card.
    const projA = await createProject();
    const projAId = projA.id as string;
    const agentA = await createAgent({ projectId: projAId });
    const cardA = await createCard(projAId, { title: 'Cross-project A card' });
    const assignA = await request
      .post(`/api/projects/${projAId}/board/cards/${cardA.id}/assign`)
      .send({ agentId: agentA.id })
      .expect(200);
    const sessionIdA = (assignA.body as { sessionId: string }).sessionId;

    // Project B uses the same session_id (should be impossible in
    // practice but worth pinning down) — the dedup is scoped to the
    // requested project's board, so a card MUST be created here.
    const projB = await createProject();
    const projBId = projB.id as string;
    const boardBRes = await request.get(`/api/projects/${projBId}/board`).expect(200);
    const boardBCols = (boardBRes.body as { columns: Array<{ id: string }> }).columns;
    const colB = boardBCols[0]?.id as string;

    const res = await request
      .post(`/api/projects/${projBId}/board/cards`)
      .send({
        title: 'Project B fresh card',
        columnId: colB,
        session_id: sessionIdA,
      })
      .expect(200);
    const card = res.body as { id: string };
    expect(card.id).not.toBe(cardA.id as string);
  });
});
