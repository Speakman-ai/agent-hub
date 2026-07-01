import express, { type NextFunction, type Request, type Response } from 'express';
import supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { createOrg, getActiveOrgId } from '../orgs.js';
import createBoardRoutes from '../routes/board.js';
import { getEnrichedAgent, findProject } from '../project-model.js';
import { getStmts } from '../db.js';
import type { AuthenticatedRequest } from '../auth.js';
import type { RouteDeps } from '../types.js';

let request: Awaited<ReturnType<typeof getRequest>>;
let projectId: string;
let leadUserId: string;

function buildLeadUserBoardRequest(userId: string, orgId = getActiveOrgId()) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const authedReq = req as AuthenticatedRequest;
    authedReq.authUserId = userId;
    authedReq.authUser = 'epic-lead-user';
    authedReq.authRole = 'User';
    authedReq.authOrgId = orgId;
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

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;

  // Seed an org member so the board exposes a non-empty assignableUsers list
  // and the epic can carry a real lead user id.
  const orgId = getActiveOrgId();
  const user = createUser({ username: 'epic-lead-user', passwordHash: 'scrypt$deadbeef' });
  createMembership(user.id, orgId, 'User');
  leadUserId = user.id;
});

describe('Epic lead user bulk card assign', () => {
  it('defaults a newly created card lead user to the authenticated creator', async () => {
    const scopedRequest = buildLeadUserBoardRequest(leadUserId);
    const boardRes = await scopedRequest.get(`/api/projects/${projectId}/board`).expect(200);
    const columnId = (boardRes.body as { columns: Array<{ id: string }> }).columns[0]!.id;
    const suffix = Date.now().toString(36);

    const created = await scopedRequest
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: `Creator lead card ${suffix}`, columnId, createdBy: 'user' })
      .expect(200);

    expect((created.body as { assigned_user_id: string | null }).assigned_user_id).toBe(leadUserId);
  });

  it('defaults a newly created epic lead user to the authenticated creator', async () => {
    const suffix = Date.now().toString(36);
    const scopedRequest = buildLeadUserBoardRequest(leadUserId);

    const created = await scopedRequest
      .post(`/api/projects/${projectId}/board/epics`)
      .send({ name: `Creator lead epic ${suffix}`, description: '', color: '#6366F1' })
      .expect(200);

    expect((created.body as { assigned_user_id: string | null }).assigned_user_id).toBe(leadUserId);
  });

  it('assigns epic lead user to all cards in the epic', async () => {
    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const users = (boardRes.body as { assignableUsers?: Array<{ id: string; username: string }> })
      .assignableUsers;
    expect(users?.length).toBeGreaterThan(0);
    expect(users!.some((u) => u.id === leadUserId)).toBe(true);

    const epicRes = await request
      .post(`/api/projects/${projectId}/board/epics`)
      .send({
        name: 'Lead epic',
        description: '',
        color: '#6366F1',
        assignedUserId: leadUserId,
      })
      .expect(200);
    const epicId = (epicRes.body as { id: string }).id;

    const columns = (boardRes.body as { columns: Array<{ id: string }> }).columns;
    const columnId = columns[0]!.id;

    await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'Card A', columnId, epicId, createdBy: 'user' })
      .expect(200);
    await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'Card B', columnId, epicId, createdBy: 'user' })
      .expect(200);

    const bulk = await buildLeadUserBoardRequest(leadUserId)
      .post(`/api/projects/${projectId}/board/epics/${epicId}/assign-lead-to-cards`)
      .send({})
      .expect(200);
    expect((bulk.body as { updatedCount: number }).updatedCount).toBe(2);

    const boardAfter = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const cards = (
      boardAfter.body as { cards: Array<{ epic_id: string; assigned_user_id: string | null }> }
    ).cards;
    const epicCards = cards.filter((c) => c.epic_id === epicId);
    expect(epicCards).toHaveLength(2);
    for (const card of epicCards) {
      expect(card.assigned_user_id).toBe(leadUserId);
    }
  });

  it('does not assign cards when the epic belongs to a different project board', async () => {
    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const epicRes = await request
      .post(`/api/projects/${projectId}/board/epics`)
      .send({
        name: 'Foreign path lead epic',
        description: '',
        color: '#6366F1',
        assignedUserId: leadUserId,
      })
      .expect(200);
    const epicId = (epicRes.body as { id: string }).id;

    const columns = (boardRes.body as { columns: Array<{ id: string }> }).columns;
    const columnId = columns[0]!.id;

    await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'Foreign path card A', columnId, epicId, createdBy: 'user' })
      .expect(200);
    await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'Foreign path card B', columnId, epicId, createdBy: 'user' })
      .expect(200);

    const otherProject = await createProject({ name: 'Other lead-user project' });
    const otherProjectId = otherProject.id as string;
    await buildLeadUserBoardRequest(leadUserId)
      .post(`/api/projects/${otherProjectId}/board/epics/${epicId}/assign-lead-to-cards`)
      .send({})
      .expect(404);

    const boardAfter = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const cards = (
      boardAfter.body as { cards: Array<{ epic_id: string; assigned_user_id: string | null }> }
    ).cards;
    const epicCards = cards.filter((c) => c.epic_id === epicId);
    expect(epicCards).toHaveLength(2);
    for (const card of epicCards) {
      expect(card.assigned_user_id).toBeNull();
    }
  });

  it('uses the request org, not the process-active org, for lead-user choices', async () => {
    const suffix = Date.now().toString(36);
    const activeOrgId = getActiveOrgId();
    const requestOrgId = `lead-users-${suffix}`;
    createOrg({ id: requestOrgId, name: 'Lead Users Request Org' });

    const requestUser = createUser({
      username: `request-lead-${suffix}`,
      passwordHash: 'scrypt$deadbeef',
    });
    createMembership(requestUser.id, requestOrgId, 'User');
    const activeOnlyUser = createUser({
      username: `active-only-lead-${suffix}`,
      passwordHash: 'scrypt$deadbeef',
    });
    createMembership(activeOnlyUser.id, activeOrgId, 'User');

    const scopedRequest = buildLeadUserBoardRequest(requestUser.id, requestOrgId);
    const boardRes = await scopedRequest.get(`/api/projects/${projectId}/board`).expect(200);
    const users = (boardRes.body as { assignableUsers?: Array<{ id: string; username: string }> })
      .assignableUsers;
    expect(users?.some((u) => u.id === requestUser.id)).toBe(true);
    expect(users?.some((u) => u.id === activeOnlyUser.id)).toBe(false);

    await scopedRequest
      .post(`/api/projects/${projectId}/board/epics`)
      .send({
        name: `Request org lead epic ${suffix}`,
        description: '',
        color: '#6366F1',
        assignedUserId: requestUser.id,
      })
      .expect(200);

    await scopedRequest
      .post(`/api/projects/${projectId}/board/epics`)
      .send({
        name: `Wrong org lead epic ${suffix}`,
        description: '',
        color: '#6366F1',
        assignedUserId: activeOnlyUser.id,
      })
      .expect(400);
  });
});
