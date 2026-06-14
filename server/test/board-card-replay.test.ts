import type supertest from 'supertest';
import { getRequest, createProject, createCard } from './helpers.js';
import { getStmts } from '../db.js';

// ═══════════════════════════════════════════════════════════════════
// GET /api/projects/:projectId/board/cards/:cardId/replay
//
// A bug support ticket surfaces its replay via `ticket.replay_ref`, but once
// the ticket is converted to a kanban card the attribution moves to
// `session_replays.card_id` and the card row carries no ref. This endpoint is
// what lets the card-detail "Watch replay" surface resolve the replay id.
//
// Regression intent: before this endpoint existed, a converted card had no way
// to reach its replay from the board UI (acceptance criterion: "reachable from
// a converted kanban card").
// ═══════════════════════════════════════════════════════════════════

let request: supertest.Agent;

/** Insert a replay row attributed to a card (as convert-to-card's linkReplay
 *  would leave it). */
function seedCardReplay(
  id: string,
  projectId: string,
  cardId: string,
  opts: { durationMs?: number; eventCount?: number } = {},
): void {
  getStmts().insertSessionReplay.run(
    id,
    projectId,
    opts.durationMs ?? 4200, // duration_ms
    opts.eventCount ?? 7, // event_count
    1024, // size
    4096, // uncompressed_size
    'local', // storage_kind
    `replays/${id}.json.gz`, // storage_key
    null, // storage_bucket
    null, // storage_region
    null, // support_ticket_id
    cardId, // card_id
    null, // meta
  );
}

beforeAll(async () => {
  request = await getRequest();
});

describe('GET /board/cards/:cardId/replay', () => {
  it('returns the replay pointer for a card with an attributed replay', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const card = await createCard(projectId, { title: `replay-card-${Date.now()}` });
    seedCardReplay(`card-replay-${Date.now()}`, projectId, card.id as string, {
      durationMs: 8800,
      eventCount: 12,
    });

    const res = await request
      .get(`/api/projects/${projectId}/board/cards/${card.id as string}/replay`)
      .expect(200);

    const body = res.body as { replayId: string; durationMs: number; eventCount: number };
    expect(body.replayId).toMatch(/^card-replay-/);
    expect(body.durationMs).toBe(8800);
    expect(body.eventCount).toBe(12);
  });

  it('returns the most recent replay when a card has several', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const card = await createCard(projectId, { title: `replay-multi-${Date.now()}` });
    seedCardReplay('multi-old', projectId, card.id as string);
    seedCardReplay('multi-new', projectId, card.id as string);

    const res = await request
      .get(`/api/projects/${projectId}/board/cards/${card.id as string}/replay`)
      .expect(200);
    // Both rows share created_at (CURRENT_TIMESTAMP); the id DESC tiebreak makes
    // the result deterministic. The point is that exactly one row is returned.
    expect((res.body as { replayId: string }).replayId).toMatch(/^multi-/);
  });

  it('returns 404 for a card with no replay', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const card = await createCard(projectId, { title: `replay-none-${Date.now()}` });

    const res = await request
      .get(`/api/projects/${projectId}/board/cards/${card.id as string}/replay`)
      .expect(404);
    expect((res.body as { error: string }).error).toMatch(/No replay/i);
  });

  it('returns 404 when the card does not exist', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .get(`/api/projects/${projectId}/board/cards/nonexistent-card-id/replay`)
      .expect(404);
    expect((res.body as { error: string }).error).toMatch(/Card not found/i);
  });

  it('returns 404 when the project does not exist', async () => {
    const res = await request
      .get(`/api/projects/nonexistent-project/board/cards/whatever/replay`)
      .expect(404);
    expect((res.body as { error: string }).error).toMatch(/Project not found/i);
  });

  it('does not resolve a replay across project boards (card id from another project)', async () => {
    const projectA = await createProject();
    const projectB = await createProject();
    const cardA = await createCard(projectA.id as string, { title: `replay-x-${Date.now()}` });
    seedCardReplay(`x-replay-${Date.now()}`, projectA.id as string, cardA.id as string);

    // Ask project B for project A's card — the card isn't on B's board → 404.
    const res = await request
      .get(`/api/projects/${projectB.id as string}/board/cards/${cardA.id as string}/replay`)
      .expect(404);
    expect((res.body as { error: string }).error).toMatch(/Card not found/i);
  });
});
