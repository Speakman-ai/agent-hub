import express, { type NextFunction, type Request, type Response } from 'express';
import supertest from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { getRequest, createProject } from './helpers.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';
import createBoardRoutes from '../routes/board.js';
import { getEnrichedAgent, findProject } from '../project-model.js';
import { getStmts } from '../db.js';
import { setSessionOwner } from '../session-ownership.js';
import type { AuthenticatedRequest } from '../auth.js';
import type { RouteDeps } from '../types.js';

let request: Awaited<ReturnType<typeof getRequest>>;
let projectId: string;

/** Authenticated human caller (JWT-style): `authUserId` is stamped. */
function buildHumanRequest(userId: string, orgId = getActiveOrgId()) {
  return buildBoardRequest((authedReq) => {
    authedReq.authUserId = userId;
    authedReq.authUser = 'lead-default-user';
    authedReq.authRole = 'User';
    authedReq.authOrgId = orgId;
  });
}

/**
 * Agent caller via the global break-glass `AGENT_HUB_API_KEY`: Owner role and
 * an org are stamped, but there is NO `authUserId`. The acting user must be
 * resolved from the linked session's owner instead.
 */
function buildAgentRequest(orgId = getActiveOrgId()) {
  return buildBoardRequest((authedReq) => {
    authedReq.authViaApiKey = true;
    authedReq.authRole = 'Owner';
    authedReq.authOrgId = orgId;
  });
}

function buildBoardRequest(stamp: (req: AuthenticatedRequest) => void) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    stamp(req as AuthenticatedRequest);
    next();
  });
  app.use(
    createBoardRoutes({
      findProject,
      findAgent: () => null,
      getEnrichedAgent,
      broadcast: () => {},
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

/** Insert a session row owned by `ownerUserId` and return its id. */
function seedOwnedSession(ownerUserId: string): string {
  const sessionId = uuidv4();
  getStmts().createSession.run(
    sessionId,
    'agent-under-test',
    'Owned session',
    'claude',
    'sonnet',
    0,
    0,
    0,
  );
  setSessionOwner(sessionId, ownerUserId);
  return sessionId;
}

async function firstColumnId(req: typeof request): Promise<string> {
  const boardRes = await req.get(`/api/projects/${projectId}/board`).expect(200);
  return (boardRes.body as { columns: Array<{ id: string }> }).columns[0]!.id;
}

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
});

describe('Card/epic lead defaults', () => {
  it('defaults the lead to the creator when the body sends an explicit null assignedUserId', async () => {
    // Reproduces the web-UI create modal, which posts
    // `assignedUserId: detailForm.assigned_user_id || null` — an explicit null
    // when no lead is picked. Before the fix this cleared the lead instead of
    // defaulting to the creator.
    const orgId = getActiveOrgId();
    const user = createUser({
      username: `explicit-null-${Date.now()}`,
      passwordHash: 'scrypt$dead',
    });
    createMembership(user.id, orgId, 'User');
    const req = buildHumanRequest(user.id);
    const columnId = await firstColumnId(req);

    const created = await req
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: `explicit null lead ${Date.now()}`, columnId, assignedUserId: null })
      .expect(200);

    expect((created.body as { assigned_user_id: string | null }).assigned_user_id).toBe(user.id);
  });

  it('defaults a card lead to the session owner when an agent creates it (no authUserId)', async () => {
    const orgId = getActiveOrgId();
    const owner = createUser({
      username: `agent-card-owner-${Date.now()}`,
      passwordHash: 'scrypt$dead',
    });
    createMembership(owner.id, orgId, 'User');
    const sessionId = seedOwnedSession(owner.id);

    const agent = buildAgentRequest();
    const columnId = await firstColumnId(agent);

    const created = await agent
      .post(`/api/projects/${projectId}/board/cards`)
      .set('X-Agent-Hub-Session-Id', sessionId)
      .send({ title: `agent card ${Date.now()}`, columnId })
      .expect(200);

    expect((created.body as { assigned_user_id: string | null }).assigned_user_id).toBe(owner.id);
  });

  it('defaults an epic lead to the session owner when an agent creates it (no authUserId)', async () => {
    const orgId = getActiveOrgId();
    const owner = createUser({
      username: `agent-epic-owner-${Date.now()}`,
      passwordHash: 'scrypt$dead',
    });
    createMembership(owner.id, orgId, 'User');
    const sessionId = seedOwnedSession(owner.id);

    const agent = buildAgentRequest();

    const created = await agent
      .post(`/api/projects/${projectId}/board/epics`)
      .set('X-Agent-Hub-Session-Id', sessionId)
      .send({ name: `agent epic ${Date.now()}`, description: '', color: '#6366F1' })
      .expect(200);

    expect((created.body as { assigned_user_id: string | null }).assigned_user_id).toBe(owner.id);
  });

  it('leaves the lead unassigned when there is no acting user to resolve', async () => {
    const agent = buildAgentRequest();
    const columnId = await firstColumnId(agent);

    // No session header and no authUserId → nothing to attribute the lead to.
    const created = await agent
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: `orphan lead card ${Date.now()}`, columnId })
      .expect(200);

    expect((created.body as { assigned_user_id: string | null }).assigned_user_id).toBeNull();
  });

  it('honors an explicit assignedUserId over the acting-user default', async () => {
    const orgId = getActiveOrgId();
    const creator = createUser({ username: `creator-${Date.now()}`, passwordHash: 'scrypt$dead' });
    const chosen = createUser({
      username: `chosen-lead-${Date.now()}`,
      passwordHash: 'scrypt$dead',
    });
    createMembership(creator.id, orgId, 'User');
    createMembership(chosen.id, orgId, 'User');
    const req = buildHumanRequest(creator.id);
    const columnId = await firstColumnId(req);

    const created = await req
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: `explicit lead ${Date.now()}`, columnId, assignedUserId: chosen.id })
      .expect(200);

    expect((created.body as { assigned_user_id: string | null }).assigned_user_id).toBe(chosen.id);
  });
});
