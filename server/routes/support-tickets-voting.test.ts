import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import express from 'express';
import supertest from 'supertest';
import createSupportTicketRoutes from './support-tickets.js';
import { getDb, getStmts } from '../db.js';
import { wipeTables } from '../test/destructive-db.js';
import { recordSupportTicketInvestigation } from '../support-tickets-store.js';
import type { AuthenticatedRequest } from '../auth.js';
import type { Project, RouteDeps } from '../types.js';

const PROJECT: Project = { id: 'voting-proj', cwd: '/tmp' } as unknown as Project;

function makeApp(
  stamp?: Partial<
    Pick<
      AuthenticatedRequest,
      'authViaApiKey' | 'authViaUserApiKey' | 'authUserId' | 'authLocalOrgBypass'
    >
  >,
) {
  const deps = {
    broadcast: vi.fn(),
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
  return app;
}

async function createTicket(app: express.Express, type: string, body: string): Promise<string> {
  const res = await supertest(app)
    .post(`/api/projects/${PROJECT.id}/support-tickets`)
    .send({ type, body })
    .expect(201);
  return res.body.id as string;
}

function votingPath(query = ''): string {
  return `/api/projects/${PROJECT.id}/support-tickets/voting${query}`;
}

beforeEach(() => {
  wipeTables(getDb(), ['support_ticket_votes', 'support_ticket_comments', 'support_tickets']);
});

describe('GET /support-tickets/voting', () => {
  it('returns only feature_request rows, score-desc, with voting tallies', async () => {
    const app = makeApp();
    const bug = await createTicket(app, 'bug', 'crash on launch');
    const low = await createTicket(app, 'feature_request', 'low');
    const high = await createTicket(app, 'feature_request', 'high');
    const mid = await createTicket(app, 'feature_request', 'mid');

    await supertest(app)
      .put(`/api/projects/${PROJECT.id}/support-tickets/${high}/vote`)
      .send({ voterKey: 'a', value: 1 })
      .expect(200);
    await supertest(app)
      .put(`/api/projects/${PROJECT.id}/support-tickets/${high}/vote`)
      .send({ voterKey: 'b', value: 1 })
      .expect(200);
    await supertest(app)
      .put(`/api/projects/${PROJECT.id}/support-tickets/${mid}/vote`)
      .send({ voterKey: 'a', value: 1 })
      .expect(200);
    await supertest(app)
      .put(`/api/projects/${PROJECT.id}/support-tickets/${low}/vote`)
      .send({ voterKey: 'a', value: -1 })
      .expect(200);

    const res = await supertest(app).get(votingPath()).expect(200);
    expect(res.body.map((row: { id: string }) => row.id)).toEqual([high, mid, low]);
    expect(res.body.every((row: { type: string }) => row.type === 'feature_request')).toBe(true);
    expect(res.body.find((row: { id: string }) => row.id === bug)).toBeUndefined();
    expect(res.body[0].voting).toEqual({
      score: 2,
      upvotes: 2,
      downvotes: 0,
      myVote: null,
      comment_count: 0,
    });
    expect(res.body[0].severity).toBeTruthy();
    expect(res.body[0].status).toBe('new');
    expect(res.body[0]).toHaveProperty('release_state');
    expect(res.body[0]).not.toHaveProperty('vote_score');
    expect(res.body[0]).not.toHaveProperty('my_vote');
  });

  it('populates myVote for the given voterKey', async () => {
    const app = makeApp();
    const ticket = await createTicket(app, 'feature_request', 'dark mode');
    await supertest(app)
      .put(`/api/projects/${PROJECT.id}/support-tickets/${ticket}/vote`)
      .send({ voterKey: 'alice', value: -1 })
      .expect(200);

    const asAlice = await supertest(app).get(votingPath('?voterKey=alice')).expect(200);
    expect(asAlice.body).toHaveLength(1);
    expect(asAlice.body[0].voting.myVote).toBe(-1);

    const asBob = await supertest(app).get(votingPath('?voterKey=bob')).expect(200);
    expect(asBob.body[0].voting.myVote).toBeNull();

    const anonymous = await supertest(app).get(votingPath()).expect(200);
    expect(anonymous.body[0].voting.myVote).toBeNull();
  });

  it('excludes hidden comments from comment_count', async () => {
    const app = makeApp();
    const ticket = await createTicket(app, 'feature_request', 'comments');
    const comments = `/api/projects/${PROJECT.id}/support-tickets/${ticket}/comments`;

    await supertest(app).post(comments).send({ body: 'keep me' }).expect(201);
    const spam = await supertest(app).post(comments).send({ body: 'spam' }).expect(201);
    await supertest(app).delete(`${comments}/${spam.body.id}`).expect(200);

    const res = await supertest(app).get(votingPath()).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].voting.comment_count).toBe(1);
  });

  it('404s an unknown project and 400s a too-long voterKey', async () => {
    const app = makeApp();
    await supertest(app).get('/api/projects/no-such/support-tickets/voting').expect(404);
    await supertest(app)
      .get(votingPath(`?voterKey=${'x'.repeat(257)}`))
      .expect(400);
  });
});

describe('GET /support-tickets/voting external projection', () => {
  // Fields the external (Survey-Tracker) projection must never expose.
  const OPERATOR_ONLY_FIELDS = [
    'reporter',
    'reporter_email',
    'reporter_email_masked',
    'ai_summary',
    'ai_investigation',
    'ai_investigated_at',
    'replay_ref',
    'screenshot_ref',
    'converted_card_id',
    'converted_card',
    'wont_do_reason',
    'release_state',
    'fixed_at',
    'released_to_prod_at',
    'release_deployment_id',
    'customer_notified_at',
    'read_at',
    'resolved_at',
    'release_notifications',
  ] as const;

  async function seedInvestigatedTicket(app: express.Express): Promise<string> {
    const id = await createTicket(app, 'feature_request', 'add SSO');
    // Populate operator-only investigation fields so the projection has
    // something to strip; without this the assertion would pass vacuously.
    recordSupportTicketInvestigation(id, {
      summary: 'operator summary',
      details: 'operator investigation notes',
    });
    await supertest(app)
      .put(`/api/projects/${PROJECT.id}/support-tickets/${id}/vote`)
      .send({ voterKey: 'a', value: 1 })
      .expect(200);
    return id;
  }

  it('strips operator-only fields for an external (API-key-only) caller', async () => {
    const seed = makeApp();
    const id = await seedInvestigatedTicket(seed);

    const external = makeApp({ authViaApiKey: true });
    const res = await supertest(external).get(votingPath()).expect(200);
    expect(res.body).toHaveLength(1);

    const item = res.body[0];
    expect(item.id).toBe(id);
    expect(Object.keys(item).sort()).toEqual(
      ['id', 'type', 'severity', 'status', 'subject', 'body', 'voting'].sort(),
    );
    for (const field of OPERATOR_ONLY_FIELDS) {
      expect(item).not.toHaveProperty(field);
    }
    expect(item.voting).toEqual({
      score: 1,
      upvotes: 1,
      downvotes: 0,
      myVote: null,
      comment_count: 0,
    });
  });

  it('strips operator-only fields for a per-user (ahub_*) API-key caller', async () => {
    const seed = makeApp();
    const id = await seedInvestigatedTicket(seed);

    // A per-user `ahub_*` key carries an authUserId but is still a
    // non-interactive API request (the card lets Survey Tracker present one),
    // so it must get the external projection — not the full ticket.
    const perUserKey = makeApp({ authViaUserApiKey: true, authUserId: 'user-123' });
    const res = await supertest(perUserKey).get(votingPath()).expect(200);
    const item = res.body.find((row: { id: string }) => row.id === id);
    expect(Object.keys(item).sort()).toEqual(
      ['id', 'type', 'severity', 'status', 'subject', 'body', 'voting'].sort(),
    );
    for (const field of OPERATOR_ONLY_FIELDS) {
      expect(item).not.toHaveProperty(field);
    }
  });

  it('keeps operator fields for a Hub caller', async () => {
    const seed = makeApp();
    const id = await seedInvestigatedTicket(seed);

    // Default caller (no api-key stamp) is a Hub operator → full shape.
    const hub = makeApp();
    const res = await supertest(hub).get(votingPath()).expect(200);
    const item = res.body.find((row: { id: string }) => row.id === id);
    expect(item.ai_summary).toBe('operator summary');
    expect(item.ai_investigation).toBe('operator investigation notes');
    expect(item).toHaveProperty('release_state');
    expect(item).toHaveProperty('reporter_email_masked');
    expect(item.voting.score).toBe(1);
  });

  it('keeps operator fields for an interactive JWT session (authUserId, no api-key flag)', async () => {
    const seed = makeApp();
    const id = await seedInvestigatedTicket(seed);

    // A JWT/cookie operator session sets authUserId but neither api-key flag.
    const jwtSession = makeApp({ authUserId: 'operator-1' });
    const res = await supertest(jwtSession).get(votingPath()).expect(200);
    const item = res.body.find((row: { id: string }) => row.id === id);
    expect(item).toHaveProperty('ai_summary');
    expect(item).toHaveProperty('reporter_email_masked');
  });

  it('a local-bundled caller is not external (keeps full shape)', async () => {
    const seed = makeApp();
    const id = await seedInvestigatedTicket(seed);

    // authViaApiKey with a local-org bypass is the single-tenant desktop
    // bundle, not Survey Tracker — it must still get the Hub shape.
    const local = makeApp({ authViaApiKey: true, authLocalOrgBypass: true });
    const res = await supertest(local).get(votingPath()).expect(200);
    const item = res.body.find((row: { id: string }) => row.id === id);
    expect(item).toHaveProperty('ai_summary');
    expect(item).toHaveProperty('release_state');
  });
});
