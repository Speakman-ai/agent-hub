/**
 * Tests for `PUT /api/sessions/:sessionId/linked-design`.
 *
 * Regression coverage for the "embed live design preview pane in a session"
 * feature: a regular chat session can link to (and unlink from) a Design
 * Studio design so the web client renders that design's live canvas beside
 * the chat. The link is stored on `sessions.linked_design_id` and is *not* a
 * foreign key — a design deleted out from under the session leaves a stale id
 * that the render layer tolerates, so the API does not eagerly clear it.
 */
import type supertest from 'supertest';
import { getRequest, createSession } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

interface DesignBody {
  id: string;
  name: string;
}

interface SessionBody {
  id: string;
  linked_design_id?: string | null;
}

async function makeDesign(name = 'Linkable design'): Promise<string> {
  const res = await request.post('/api/designs').send({ name }).expect(201);
  return (res.body as DesignBody).id;
}

describe('PUT /api/sessions/:sessionId/linked-design', () => {
  it('links a design and surfaces linked_design_id on the session', async () => {
    const session = (await createSession()) as unknown as SessionBody;
    const designId = await makeDesign('Hero mockup');

    const res = await request
      .put(`/api/sessions/${session.id}/linked-design`)
      .send({ designId })
      .expect(200);

    expect((res.body as SessionBody).linked_design_id).toBe(designId);

    // The link must round-trip through the GET session detail (proves the
    // column persists and flows through enrichSessionForClient).
    const detail = await request.get(`/api/sessions/${session.id}`).expect(200);
    expect((detail.body as SessionBody).linked_design_id).toBe(designId);
  });

  it('unlinks when designId is null', async () => {
    const session = (await createSession()) as unknown as SessionBody;
    const designId = await makeDesign('To be unlinked');

    await request.put(`/api/sessions/${session.id}/linked-design`).send({ designId }).expect(200);

    const cleared = await request
      .put(`/api/sessions/${session.id}/linked-design`)
      .send({ designId: null })
      .expect(200);
    expect((cleared.body as SessionBody).linked_design_id).toBeNull();

    const detail = await request.get(`/api/sessions/${session.id}`).expect(200);
    expect((detail.body as SessionBody).linked_design_id).toBeNull();
  });

  it('returns 404 when the design does not exist', async () => {
    const session = (await createSession()) as unknown as SessionBody;
    await request
      .put(`/api/sessions/${session.id}/linked-design`)
      .send({ designId: 'no-such-design' })
      .expect(404);
  });

  it('returns 404 when the design belongs to another org', async () => {
    const session = (await createSession()) as unknown as SessionBody;
    const designId = await makeDesign('Other org design');

    const { getDb } = await import('../db.js');
    getDb().prepare("UPDATE designs SET org_id = 'other-org' WHERE id = ?").run(designId);

    await request.put(`/api/sessions/${session.id}/linked-design`).send({ designId }).expect(404);
  });

  it('returns 404 when the session does not exist', async () => {
    const designId = await makeDesign('Orphan link');
    await request
      .put('/api/sessions/00000000-0000-0000-0000-000000000000/linked-design')
      .send({ designId })
      .expect(404);
  });

  it('rejects an empty-string designId with 400', async () => {
    const session = (await createSession()) as unknown as SessionBody;
    await request
      .put(`/api/sessions/${session.id}/linked-design`)
      .send({ designId: '' })
      .expect(400);
  });

  it('rejects a missing designId field with 400', async () => {
    const session = (await createSession()) as unknown as SessionBody;
    await request.put(`/api/sessions/${session.id}/linked-design`).send({}).expect(400);
  });

  it('tolerates a stale link after the design is deleted (no eager clear)', async () => {
    const session = (await createSession()) as unknown as SessionBody;
    const designId = await makeDesign('Soon deleted');

    await request.put(`/api/sessions/${session.id}/linked-design`).send({ designId }).expect(200);
    await request.delete(`/api/designs/${designId}`).expect(200);

    // The column still holds the (now stale) id — the render layer ignores it.
    const detail = await request.get(`/api/sessions/${session.id}`).expect(200);
    expect((detail.body as SessionBody).linked_design_id).toBe(designId);
  });
});
