/**
 * Integration tests for POST /api/projects/:projectId/voting/setup-wizard.
 *
 * Spawns a worktree-backed `[Voting Setup]` session seeded with the voting
 * integration task pack. The HTTP 201 waits until `handleChat` accepts the
 * seeded first turn (user message persisted or queued), not until the CLI
 * finishes. server/test/setup.ts points the forbidden binaries at a stub.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import express from 'express';
import supertest from 'supertest';

import './setup.js';
import { isVotingScaffolderSession } from '../voting-integration/scaffolder-session.js';
import createVotingWizardRoutes, { publicHubApiBase } from '../routes/voting-wizard.js';
import type {
  Agent,
  AppConfig,
  ChatMessage,
  Project,
  RouteDeps,
  SessionRow,
  Stmts,
} from '../types.js';
import { getRequest } from './helpers.js';
import { saveAuthRecord, generateJwtSecret } from '../auth-store.js';
import { signJwt } from '../jwt.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';

let request: supertest.Agent;
let userJwt: string;
let adminJwt: string;

beforeAll(async () => {
  request = await getRequest();

  const jwtSecret = generateJwtSecret();
  saveAuthRecord({
    username: 'voting-wizard-owner',
    passwordHash: 'scrypt$ignored',
    jwtSecret,
    role: 'Owner',
  });

  const orgId = getActiveOrgId();

  const userRow = createUser({
    username: `voting-wizard-user-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-01T00:00:00Z',
  });
  createMembership(userRow.id, orgId, 'User');
  userJwt = signJwt(userRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'User', uid: userRow.id },
  });

  const adminRow = createUser({
    username: `voting-wizard-admin-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-01T00:00:00Z',
  });
  createMembership(adminRow.id, orgId, 'Admin');
  adminJwt = signJwt(adminRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'Admin', uid: adminRow.id },
  });
});

let _counter = 0;
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++_counter}`;
}

async function makeProject(cwd: string): Promise<string> {
  const id = uid('proj');
  const res = await request
    .post('/api/projects')
    .set('Authorization', `Bearer ${adminJwt}`)
    .send({ id, name: `Test ${id}`, cwd, color: '#3B82F6' })
    .expect(201);
  return (res.body as { id: string }).id;
}

async function makeAgent(
  projectId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = uid('agent');
  const res = await request
    .post('/api/agents')
    .set('Authorization', `Bearer ${adminJwt}`)
    .send({ id, projectId, name: `Agent ${id}`, engine: 'claude-code', ...overrides })
    .expect(201);
  return (res.body as { id: string }).id;
}

function makeCwd(): string {
  return mkdtempSync(path.join(tmpdir(), 'ah-vote-cwd-'));
}

describe('publicHubApiBase', () => {
  it('returns a public http(s) origin and drops loopback', () => {
    expect(
      publicHubApiBase({ publicUrl: 'https://hub.example.com/' } as unknown as AppConfig),
    ).toBe('https://hub.example.com');
    expect(
      publicHubApiBase({ publicUrl: 'http://127.0.0.1:3051' } as unknown as AppConfig),
    ).toBeNull();
    expect(
      publicHubApiBase({ publicUrl: 'http://localhost:3051' } as unknown as AppConfig),
    ).toBeNull();
    expect(publicHubApiBase({ publicUrl: null } as unknown as AppConfig)).toBeNull();
    expect(publicHubApiBase({ publicUrl: 'not a url' } as unknown as AppConfig)).toBeNull();
  });
});

describe('POST /api/projects/:projectId/voting/setup-wizard', () => {
  it('404 when the project does not exist', async () => {
    const res = await request
      .post('/api/projects/no-such-project/voting/setup-wizard')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ agentId: 'any' });
    expect(res.status).toBe(404);
  });

  it('400 when agentId is missing', async () => {
    const projectId = await makeProject(makeCwd());
    const res = await request
      .post(`/api/projects/${projectId}/voting/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/agentId/i);
  });

  it('400 when the agent belongs to a different project', async () => {
    const targetId = await makeProject(makeCwd());
    const otherId = await makeProject(makeCwd());
    const foreignAgent = await makeAgent(otherId);
    const res = await request
      .post(`/api/projects/${targetId}/voting/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ agentId: foreignAgent });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not belong/i);
  });

  it('400 when the agent is a reviewer', async () => {
    const projectId = await makeProject(makeCwd());
    const reviewerId = await makeAgent(projectId, { role: 'reviewer' });
    const res = await request
      .post(`/api/projects/${projectId}/voting/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ agentId: reviewerId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reviewer/i);
  });

  it('400 when the agent is inactive', async () => {
    const projectId = await makeProject(makeCwd());
    const inactiveId = await makeAgent(projectId);
    await request
      .patch(`/api/agents/${inactiveId}`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ active: false })
      .expect(200);

    const res = await request
      .post(`/api/projects/${projectId}/voting/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ agentId: inactiveId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inactive/i);
  });

  it('spawns a worktree-backed [Voting Setup] session seeded with the task pack', async () => {
    const cwd = makeCwd();
    const projectId = await makeProject(cwd);
    const agentId = await makeAgent(projectId);

    const res = await request
      .post(`/api/projects/${projectId}/voting/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ agentId, pageNameHint: 'Ideas' })
      .expect(201);

    expect(res.body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.agentId).toBe(agentId);
    expect(res.body.session.id).toBe(res.body.sessionId);
    expect(res.body.session.use_worktree).toBe(1);
    expect(res.body.session.ask_mode).toBe(0);
    expect(isVotingScaffolderSession(res.body.session)).toBe(true);
    expect(res.body.session.name).toBe(`[Voting Setup] ${projectId}`);
  });

  it('lets a User-role owner spawn (not Admin-gated like other setup wizards)', async () => {
    const cwd = makeCwd();
    const id = uid('uproj');
    await request
      .post('/api/projects')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ id, name: `User ${id}`, cwd, color: '#3B82F6' })
      .expect(201);
    const agentId = uid('uagent');
    await request
      .post('/api/agents')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ id: agentId, projectId: id, name: `Agent ${agentId}`, engine: 'claude-code' })
      .expect(201);

    const res = await request
      .post(`/api/projects/${id}/voting/setup-wizard`)
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ agentId })
      .expect(201);

    expect(isVotingScaffolderSession(res.body.session)).toBe(true);
    expect(res.body.agentId).toBe(agentId);
  });
});

function persistThenHang(accepted: boolean) {
  return (_ws: unknown, msg: ChatMessage) => {
    queueMicrotask(() => msg._onUserMessagePersisted?.(accepted));
    return new Promise<void>(() => {});
  };
}

function mountWizard(handleChat: RouteDeps['handleChat']) {
  const projectId = 'acme-app';
  const agentId = 'agent-acme';
  const project = {
    id: projectId,
    name: 'Acme',
    cwd: '/tmp/acme-app',
    agents: [{ id: agentId, name: 'Acme Dev', engine: 'claude-code', active: true }],
  } as unknown as Project;
  const sessions = new Map<string, SessionRow>();
  const deleteSession = vi.fn((id: string) => {
    sessions.delete(id);
  });
  const stmts = {
    createSession: {
      run: vi.fn((...args: unknown[]) => {
        const [id, aid, name, engine, model, useWorktree, askMode] = args as [
          string,
          string,
          string,
          string,
          string,
          number,
          number,
        ];
        sessions.set(id, {
          id,
          agent_id: aid,
          name,
          engine,
          model,
          use_worktree: useWorktree,
          ask_mode: askMode,
          deleted_at: null,
        } as SessionRow);
      }),
    },
    getSession: { get: vi.fn((id: string) => sessions.get(id)) },
    deleteSession: { run: deleteSession },
  } as unknown as Stmts;
  const deps = {
    stmts,
    broadcast: vi.fn(),
    findProject: (id: string) => (id === projectId ? project : null),
    findAgent: (id: string) =>
      id === agentId
        ? {
            project,
            agent: {
              id: agentId,
              name: 'Acme Dev',
              engine: 'claude-code',
              active: true,
            } as Agent,
          }
        : null,
    handleChat,
    config: {},
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const auth = req as unknown as { authRole: string; authUserId: string };
    auth.authRole = 'User';
    auth.authUserId = 'user-1';
    next();
  });
  app.use(createVotingWizardRoutes(deps));
  return { app, sessions, deleteSession, projectId, agentId };
}

describe('POST /voting/setup-wizard — seed acceptance', () => {
  it('201s only after the seeded turn is accepted and does not delete the session', async () => {
    const { app, sessions, deleteSession, projectId, agentId } = mountWizard(persistThenHang(true));
    const res = await supertest(app)
      .post(`/api/projects/${projectId}/voting/setup-wizard`)
      .send({ agentId })
      .expect(201);
    expect(sessions.has(res.body.sessionId)).toBe(true);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('500s, deletes the empty row, and a retry can spawn a fresh session', async () => {
    let accept = false;
    const { app, sessions, deleteSession, projectId, agentId } = mountWizard((_ws, msg) => {
      queueMicrotask(() => msg._onUserMessagePersisted?.(accept));
      return new Promise<void>(() => {});
    });

    await supertest(app)
      .post(`/api/projects/${projectId}/voting/setup-wizard`)
      .send({ agentId })
      .expect(500);
    expect(deleteSession).toHaveBeenCalledTimes(1);
    const failedId = deleteSession.mock.calls[0]![0] as string;
    expect(sessions.has(failedId)).toBe(false);

    accept = true;
    const retry = await supertest(app)
      .post(`/api/projects/${projectId}/voting/setup-wizard`)
      .send({ agentId })
      .expect(201);
    expect(retry.body.sessionId).not.toBe(failedId);
    expect(sessions.has(retry.body.sessionId)).toBe(true);
  });
});
