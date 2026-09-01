import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import express from 'express';
import supertest from 'supertest';
import createSupportTicketRoutes from './support-tickets.js';
import { getDb, getStmts } from '../db.js';
import { wipeTables } from '../test/destructive-db.js';
import { SUPPORT_TICKET_COMMENT_MAX_LEN } from '../support-ticket-voting-store.js';
import type { Project, RouteDeps } from '../types.js';

const PROJECT: Project = { id: 'abuse-proj', cwd: '/tmp' } as unknown as Project;

function makeApp(broadcast = vi.fn()) {
  const deps = {
    broadcast,
    findProject: (id: string) => (id === PROJECT.id ? PROJECT : null),
    stmts: getStmts(),
    config: {} as unknown,
    serverDir: tmpdir(),
  } as unknown as RouteDeps;
  const app = express();
  // Mirror production (`server/index.ts`): trust the loopback peer only.
  // supertest connects from 127.0.0.1, so X-Forwarded-For is honored and each
  // test can simulate a distinct client IP — without the permissive `true`
  // setting that would let a real client spoof its bucket key.
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.use(createSupportTicketRoutes(deps));
  return app;
}

async function createTicket(app: express.Express, type = 'feature_request'): Promise<string> {
  const res = await supertest(app)
    .post(`/api/projects/${PROJECT.id}/support-tickets`)
    .send({ type, body: 'please add dark mode' })
    .expect(201);
  return res.body.id as string;
}

const votePath = (id: string): string => `/api/projects/${PROJECT.id}/support-tickets/${id}/vote`;
const commentsPath = (id: string): string =>
  `/api/projects/${PROJECT.id}/support-tickets/${id}/comments`;

beforeEach(() => {
  // Each makeApp() builds its own limiter store, so no shared reset is needed.
  wipeTables(getDb(), ['support_ticket_votes', 'support_ticket_comments', 'support_tickets']);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('per-IP rate limiting on vote writes', () => {
  it('allows votes under the threshold, then returns a structured 429', async () => {
    vi.stubEnv('AGENT_HUB_VOTE_RATE_MAX', '2');
    const app = makeApp();
    const id = await createTicket(app);

    for (let i = 0; i < 2; i++) {
      await supertest(app)
        .put(votePath(id))
        .set('x-forwarded-for', '203.0.113.5')
        .send({ voterKey: `voter-${i}`, value: 1 })
        .expect(200);
    }

    const blocked = await supertest(app)
      .put(votePath(id))
      .set('x-forwarded-for', '203.0.113.5')
      .send({ voterKey: 'voter-3', value: 1 })
      .expect(429);

    expect(blocked.headers['retry-after']).toBeDefined();
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.body.error).toMatch(/too many vote/i);
  });

  it('buckets per IP — a second IP is unaffected by the first IP hitting the cap', async () => {
    vi.stubEnv('AGENT_HUB_VOTE_RATE_MAX', '1');
    const app = makeApp();
    const id = await createTicket(app);

    await supertest(app)
      .put(votePath(id))
      .set('x-forwarded-for', '198.51.100.1')
      .send({ voterKey: 'a', value: 1 })
      .expect(200);
    await supertest(app)
      .put(votePath(id))
      .set('x-forwarded-for', '198.51.100.1')
      .send({ voterKey: 'a2', value: 1 })
      .expect(429);

    // Different client IP still has its full quota.
    await supertest(app)
      .put(votePath(id))
      .set('x-forwarded-for', '198.51.100.2')
      .send({ voterKey: 'b', value: 1 })
      .expect(200);
  });
});

describe('per-IP rate limiting on comment writes', () => {
  it('allows comments under the threshold, then returns a structured 429', async () => {
    vi.stubEnv('AGENT_HUB_COMMENT_RATE_MAX', '2');
    const app = makeApp();
    const id = await createTicket(app);

    for (let i = 0; i < 2; i++) {
      await supertest(app)
        .post(commentsPath(id))
        .set('x-forwarded-for', '203.0.113.9')
        .send({ body: `comment ${i}` })
        .expect(201);
    }

    const blocked = await supertest(app)
      .post(commentsPath(id))
      .set('x-forwarded-for', '203.0.113.9')
      .send({ body: 'one too many' })
      .expect(429);

    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.body.error).toMatch(/too many comment/i);
  });
});

describe('input validation on vote writes', () => {
  it('rejects a malformed voterKey with 400 (whitespace, control chars, empty, oversize)', async () => {
    const app = makeApp();
    const id = await createTicket(app);

    const junk = [
      'has space',
      'line\nbreak',
      '\t',
      '',
      '   ',
      ' padded-token ', // leading/trailing whitespace must NOT be trimmed-then-accepted
      '\ttok',
      'a'.repeat(257),
    ];
    for (const voterKey of junk) {
      await supertest(app).put(votePath(id)).send({ voterKey, value: 1 }).expect(400);
    }

    // A clean opaque token (SHA-256 hex shape) still passes.
    await supertest(app)
      .put(votePath(id))
      .send({ voterKey: 'a'.repeat(64), value: 1 })
      .expect(200);
  });
});

describe('input validation on comment writes', () => {
  it('rejects an oversize comment body with 400 rather than truncating', async () => {
    const app = makeApp();
    const id = await createTicket(app);

    const tooLong = 'x'.repeat(SUPPORT_TICKET_COMMENT_MAX_LEN + 1);
    await supertest(app).post(commentsPath(id)).send({ body: tooLong }).expect(400);

    // The body at exactly the cap is accepted and stored in full (no truncation).
    const atCap = 'y'.repeat(SUPPORT_TICKET_COMMENT_MAX_LEN);
    const ok = await supertest(app).post(commentsPath(id)).send({ body: atCap }).expect(201);
    expect(ok.body.body).toHaveLength(SUPPORT_TICKET_COMMENT_MAX_LEN);
  });
});
