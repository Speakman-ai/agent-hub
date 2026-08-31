import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import express from 'express';
import supertest from 'supertest';
import createSupportTicketRoutes from './support-tickets.js';
import { getDb, getStmts } from '../db.js';
import { wipeTables } from '../test/destructive-db.js';
import { SUPPORT_TICKET_COMMENT_MAX_LEN } from '../support-ticket-voting-store.js';
import type { AuthenticatedRequest } from '../auth.js';
import type { Project, RouteDeps } from '../types.js';

const PROJECT: Project = { id: 'comment-proj', cwd: '/tmp' } as unknown as Project;

function makeApp(
  broadcast = vi.fn(),
  stamp?: Partial<
    Pick<AuthenticatedRequest, 'authViaApiKey' | 'authUserId' | 'authLocalOrgBypass'>
  >,
) {
  const deps = {
    broadcast,
    findProject: (id: string) => (id === PROJECT.id ? PROJECT : null),
    stmts: getStmts(),
    config: {} as unknown,
    serverDir: tmpdir(),
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  if (stamp) {
    app.use((req, _res, next) => {
      Object.assign(req, stamp);
      next();
    });
  }
  app.use(createSupportTicketRoutes(deps));
  return { app, broadcast };
}

async function createTicket(app: express.Express, body = 'please add dark mode'): Promise<string> {
  const res = await supertest(app)
    .post(`/api/projects/${PROJECT.id}/support-tickets`)
    .send({ type: 'feature_request', body })
    .expect(201);
  return res.body.id as string;
}

function commentsPath(id: string): string {
  return `/api/projects/${PROJECT.id}/support-tickets/${id}/comments`;
}

beforeEach(() => {
  wipeTables(getDb(), ['support_ticket_votes', 'support_ticket_comments', 'support_tickets']);
});

describe('support-ticket comment thread', () => {
  it('appends then lists oldest-first, including source and hidden_at for Hub-auth', async () => {
    const { app, broadcast } = makeApp();
    const id = await createTicket(app);

    const first = await supertest(app)
      .post(commentsPath(id))
      .send({ body: '  ship it  ', displayName: 'Ada' })
      .expect(201);
    expect(first.body.body).toBe('ship it');
    expect(first.body.display_name).toBe('Ada');
    expect(first.body.source).toBe('hub');
    expect(first.body.hidden_at).toBeNull();
    expect(first.body.support_ticket_id).toBe(id);
    expect(first.body.id).toBeTruthy();
    expect(first.body.created_at).toBeTruthy();

    const second = await supertest(app)
      .post(commentsPath(id))
      .send({ body: 'from hub too' })
      .expect(201);
    expect(second.body.display_name).toBeNull();

    const list = await supertest(app).get(commentsPath(id)).expect(200);
    expect(list.body.map((c: { body: string }) => c.body)).toEqual(['ship it', 'from hub too']);
    expect(list.body[0].source).toBe('hub');
    expect(list.body[0]).toHaveProperty('hidden_at');

    expect(broadcast).toHaveBeenCalledWith({
      type: 'support_ticket_comment_created',
      ticketId: id,
      projectId: PROJECT.id,
      comment: first.body,
    });
    expect(broadcast).toHaveBeenLastCalledWith({
      type: 'support_ticket_comment_created',
      ticketId: id,
      projectId: PROJECT.id,
      comment: second.body,
    });
  });

  it('rejects a body longer than 4000 characters', async () => {
    const { app, broadcast } = makeApp();
    const id = await createTicket(app);
    broadcast.mockClear();

    const res = await supertest(app)
      .post(commentsPath(id))
      .send({ body: 'x'.repeat(SUPPORT_TICKET_COMMENT_MAX_LEN + 1) })
      .expect(400);
    expect(res.body.error).toMatch(/Invalid request body/);

    const empty = await supertest(app).post(commentsPath(id)).send({ body: '   ' }).expect(400);
    expect(empty.body.error).toMatch(/Invalid request body/);

    expect(broadcast).not.toHaveBeenCalled();
    const list = await supertest(app).get(commentsPath(id)).expect(200);
    expect(list.body).toEqual([]);
  });

  it('soft-deletes so the hidden comment disappears from the list', async () => {
    const { app, broadcast } = makeApp();
    const id = await createTicket(app);

    const keep = await supertest(app).post(commentsPath(id)).send({ body: 'visible' }).expect(201);
    const hide = await supertest(app).post(commentsPath(id)).send({ body: 'spam' }).expect(201);
    broadcast.mockClear();

    await supertest(app)
      .delete(`${commentsPath(id)}/${hide.body.id}`)
      .expect(200);

    const list = await supertest(app).get(commentsPath(id)).expect(200);
    expect(list.body.map((c: { id: string }) => c.id)).toEqual([keep.body.id]);

    expect(broadcast).toHaveBeenCalledWith({
      type: 'support_ticket_comment_deleted',
      ticketId: id,
      projectId: PROJECT.id,
      commentId: hide.body.id,
    });
    expect(broadcast.mock.lastCall?.[0]).not.toHaveProperty('comment');

    await supertest(app)
      .delete(`${commentsPath(id)}/${hide.body.id}`)
      .expect(404);
  });

  it('tags API-key-only callers as external, omits hidden_at, and forbids DELETE', async () => {
    const { app, broadcast } = makeApp(vi.fn(), { authViaApiKey: true });
    const id = await createTicket(app);

    const created = await supertest(app)
      .post(commentsPath(id))
      .send({ body: 'from survey tracker' })
      .expect(201);
    expect(created.body.source).toBe('external');
    expect(created.body).not.toHaveProperty('hidden_at');

    const list = await supertest(app).get(commentsPath(id)).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).not.toHaveProperty('hidden_at');
    expect(list.body[0].source).toBe('external');

    const denied = await supertest(app)
      .delete(`${commentsPath(id)}/${created.body.id}`)
      .expect(403);
    expect(denied.body.error).toMatch(/Hub authentication/);
    expect(broadcast.mock.calls.some((c) => c[0]?.type === 'support_ticket_comment_deleted')).toBe(
      false,
    );

    const stillThere = await supertest(app).get(commentsPath(id)).expect(200);
    expect(stillThere.body).toHaveLength(1);
  });

  it('404s for a missing project, ticket, or comment', async () => {
    const { app } = makeApp();
    const id = await createTicket(app);

    await supertest(app).get(`/api/projects/nope/support-tickets/${id}/comments`).expect(404);
    await supertest(app).get(commentsPath('missing-ticket')).expect(404);
    await supertest(app).post(commentsPath('missing-ticket')).send({ body: 'hi' }).expect(404);
    await supertest(app)
      .delete(`${commentsPath(id)}/not-a-comment`)
      .expect(404);
  });
});
