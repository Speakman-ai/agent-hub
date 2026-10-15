import { vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';
import createBoardRoutes from '../routes/board.js';
import { getEnrichedAgent, findProject } from '../project-model.js';
import { getStmts } from '../db.js';
import type { AuthenticatedRequest } from '../auth.js';
import type { RouteDeps } from '../types.js';

vi.mock('../per-user-cli-spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../per-user-cli-spawn.js')>();
  return { ...actual, assertEngineCredsOrThrow: vi.fn() };
});

let projectId: string;
const events: Record<string, unknown>[] = [];

function asUser(userId: string) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const r = req as AuthenticatedRequest;
    r.authUserId = userId;
    r.authUser = 'assigner';
    r.authRole = 'User';
    r.authOrgId = getActiveOrgId();
    next();
  });
  app.use(
    createBoardRoutes({
      findProject,
      findAgent: () => null,
      getEnrichedAgent,
      broadcast: (e: Record<string, unknown>) => events.push(e),
      stmts: getStmts(),
      handleChat: () => Promise.resolve(),
      lastDispatchedReviewId: new Map(),
      scheduleAutonomousEpic: () => {},
      autonomousCrons: new Map(),
      runAutonomousLoop: () => Promise.resolve(),
      config: { engineValidModels: {}, engineDefaultModels: {} },
    } as unknown as RouteDeps),
  );
  return supertest(app);
}

function member(name: string): string {
  const u = createUser({ username: `${name}-${Date.now()}-${Math.random()}`, passwordHash: 'x' });
  createMembership(u.id, getActiveOrgId(), 'User');
  return u.id;
}

const assigned = () => events.filter((e) => e.type === 'card_assigned');

beforeAll(async () => {
  await getRequest();
  projectId = (await createProject()).id as string;
});

beforeEach(() => {
  events.length = 0;
});

describe('card_assigned broadcast', () => {
  it('fires on create and on lead change, server-only, never for self-assignment', async () => {
    const alice = member('alice');
    const bob = member('bob');
    const req = asUser(alice);
    const columnId = (
      (await req.get(`/api/projects/${projectId}/board`).expect(200)).body as {
        columns: Array<{ id: string }>;
      }
    ).columns[0]!.id;

    // Creator defaults to lead: no notification.
    const self = await req
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'mine', columnId })
      .expect(200);
    expect(assigned()).toHaveLength(0);

    await req
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'for bob', columnId, assignedUserId: bob })
      .expect(200);
    expect(assigned()).toEqual([
      expect.objectContaining({
        assignedUserId: bob,
        cardTitle: 'for bob',
        projectId,
        suppressWebSocket: true,
      }),
    ]);

    events.length = 0;
    const cardId = (self.body as { id: string }).id;
    await req
      .put(`/api/projects/${projectId}/board/cards/${cardId}`)
      .send({ assignedUserId: bob })
      .expect(200);
    expect(assigned()).toEqual([expect.objectContaining({ assignedUserId: bob, cardId })]);

    // Same lead again: no repeat.
    events.length = 0;
    await req
      .put(`/api/projects/${projectId}/board/cards/${cardId}`)
      .send({ assignedUserId: bob })
      .expect(200);
    expect(assigned()).toHaveLength(0);
  });
});
