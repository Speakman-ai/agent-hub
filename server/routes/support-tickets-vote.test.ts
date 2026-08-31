import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import express from 'express';
import supertest from 'supertest';
import createSupportTicketRoutes, {
  _setVoteAfterApply,
  _voteLockWaiterCount,
} from './support-tickets.js';
import { getDb, getStmts } from '../db.js';
import { wipeTables } from '../test/destructive-db.js';
import type { Project, RouteDeps } from '../types.js';

const PROJECT: Project = { id: 'vote-proj', cwd: '/tmp' } as unknown as Project;

function makeApp(broadcast = vi.fn()) {
  const deps = {
    broadcast,
    findProject: (id: string) => (id === PROJECT.id ? PROJECT : null),
    stmts: getStmts(),
    config: {} as unknown,
    serverDir: tmpdir(),
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use(createSupportTicketRoutes(deps));
  return { app, broadcast };
}

async function createTicket(
  app: express.Express,
  type: string,
  body = 'please add dark mode',
): Promise<string> {
  const res = await supertest(app)
    .post(`/api/projects/${PROJECT.id}/support-tickets`)
    .send({ type, body })
    .expect(201);
  return res.body.id as string;
}

function votePath(id: string): string {
  return `/api/projects/${PROJECT.id}/support-tickets/${id}/vote`;
}

beforeEach(() => {
  wipeTables(getDb(), ['support_ticket_votes', 'support_ticket_comments', 'support_tickets']);
});

afterEach(() => {
  _setVoteAfterApply(null);
});

describe('PUT /support-tickets/:id/vote', () => {
  it('casts up then down, flipping score without double-counting the same voter_key', async () => {
    const { app, broadcast } = makeApp();
    const id = await createTicket(app, 'feature_request');

    const up = await supertest(app)
      .put(votePath(id))
      .send({ voterKey: 'voter-a', value: 1 })
      .expect(200);
    expect(up.body).toEqual({ score: 1, upvotes: 1, downvotes: 0, myVote: 1 });

    const again = await supertest(app)
      .put(votePath(id))
      .send({ voterKey: 'voter-a', value: 1 })
      .expect(200);
    expect(again.body).toEqual({ score: 1, upvotes: 1, downvotes: 0, myVote: 1 });

    const down = await supertest(app)
      .put(votePath(id))
      .send({ voterKey: 'voter-a', value: -1 })
      .expect(200);
    expect(down.body).toEqual({ score: -1, upvotes: 0, downvotes: 1, myVote: -1 });

    const count = getDb()
      .prepare('SELECT COUNT(*) AS n FROM support_ticket_votes WHERE support_ticket_id = ?')
      .get(id) as { n: number };
    expect(count.n).toBe(1);

    expect(broadcast).toHaveBeenLastCalledWith({
      type: 'support_ticket_vote_updated',
      ticketId: id,
      projectId: PROJECT.id,
      score: -1,
      upvotes: 0,
      downvotes: 1,
    });
  });

  it('retracts with value null and zeroes the aggregate', async () => {
    const { app, broadcast } = makeApp();
    const id = await createTicket(app, 'feature_request');

    await supertest(app).put(votePath(id)).send({ voterKey: 'voter-a', value: 1 }).expect(200);

    const retracted = await supertest(app)
      .put(votePath(id))
      .send({ voterKey: 'voter-a', value: null })
      .expect(200);
    expect(retracted.body).toEqual({ score: 0, upvotes: 0, downvotes: 0, myVote: null });

    const again = await supertest(app)
      .put(votePath(id))
      .send({ voterKey: 'voter-a', value: null })
      .expect(200);
    expect(again.body).toEqual({ score: 0, upvotes: 0, downvotes: 0, myVote: null });

    expect(broadcast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'support_ticket_vote_updated',
        ticketId: id,
        projectId: PROJECT.id,
        score: 0,
        upvotes: 0,
        downvotes: 0,
      }),
    );
    expect(broadcast.mock.lastCall?.[0]).not.toHaveProperty('myVote');
    expect(broadcast.mock.lastCall?.[0]).not.toHaveProperty('voterKey');
  });

  it('accumulates votes from different voter_keys', async () => {
    const { app } = makeApp();
    const id = await createTicket(app, 'feature_request');

    await supertest(app).put(votePath(id)).send({ voterKey: 'a', value: 1 }).expect(200);
    await supertest(app).put(votePath(id)).send({ voterKey: 'b', value: 1 }).expect(200);
    const res = await supertest(app)
      .put(votePath(id))
      .send({ voterKey: 'c', value: -1 })
      .expect(200);

    expect(res.body).toEqual({ score: 1, upvotes: 2, downvotes: 1, myVote: -1 });
  });

  it('rejects a non-feature_request ticket', async () => {
    const { app, broadcast } = makeApp();
    const id = await createTicket(app, 'question');
    broadcast.mockClear();

    const res = await supertest(app)
      .put(votePath(id))
      .send({ voterKey: 'voter-a', value: 1 })
      .expect(400);
    expect(res.body.error).toMatch(/feature_request/);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('404s for a missing project or ticket and 400s an invalid body', async () => {
    const { app } = makeApp();
    const id = await createTicket(app, 'feature_request');

    await supertest(app)
      .put(`/api/projects/nope/support-tickets/${id}/vote`)
      .send({ voterKey: 'a', value: 1 })
      .expect(404);
    await supertest(app)
      .put(votePath('missing-ticket'))
      .send({ voterKey: 'a', value: 1 })
      .expect(404);
    await supertest(app).put(votePath(id)).send({ voterKey: 'a', value: 0 }).expect(400);
    await supertest(app).put(votePath(id)).send({ value: 1 }).expect(400);
  });

  it('emits vote aggregates in write order when a later vote overlaps the first broadcast', async () => {
    const { app, broadcast } = makeApp();
    const id = await createTicket(app, 'feature_request');
    broadcast.mockClear();

    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstAtGate = false;
    const firstReachedGate = new Promise<void>((resolve) => {
      _setVoteAfterApply(async (ticketId) => {
        if (ticketId !== id || firstAtGate) return;
        firstAtGate = true;
        resolve();
        await held;
      });
    });

    const first = supertest(app)
      .put(votePath(id))
      .send({ voterKey: 'a', value: 1 })
      .then((res) => res);
    await firstReachedGate;
    const second = supertest(app)
      .put(votePath(id))
      .send({ voterKey: 'b', value: 1 })
      .then((res) => res);
    await vi.waitFor(() => {
      expect(_voteLockWaiterCount(id)).toBeGreaterThanOrEqual(2);
    });
    releaseFirst();
    const [firstRes, secondRes] = await Promise.all([first, second]);

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect(firstRes.body).toEqual({ score: 1, upvotes: 1, downvotes: 0, myVote: 1 });
    expect(secondRes.body).toEqual({ score: 2, upvotes: 2, downvotes: 0, myVote: 1 });

    const voteEvents = broadcast.mock.calls
      .map((call) => call[0] as { type?: string; score?: number; upvotes?: number })
      .filter((event) => event.type === 'support_ticket_vote_updated');
    expect(voteEvents.map((event) => event.score)).toEqual([1, 2]);
    expect(voteEvents.map((event) => event.upvotes)).toEqual([1, 2]);
  });
});
