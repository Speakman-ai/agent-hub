/**
 * End-to-end spec for the per-user, per-agent engine override.
 *
 * Proves the override actually changes the engine field on the row
 * written by `POST /api/agents/:agentId/sessions`. The unit tests in
 * `effective-model.test.ts` already cover the resolver; this file
 * verifies the route is wired through the resolver (so a future
 * refactor that bypassed it would regress here).
 *
 * Flow:
 *   1. Save an auth record + create user A with Admin membership.
 *   2. Create an agent on engine `claude-code`.
 *   3. PUT `/api/auth/me/agent-engine-overrides` as A pointing the
 *      agent at `codex-cli`.
 *   4. POST a new session as A. Assert the row's `engine` field is
 *      `codex-cli` (and that the model defaults through the codex
 *      pipeline rather than the agent's shared model).
 *   5. A control test confirms that without an override the agent's
 *      `claude-code` engine is still respected.
 */
import './setup.js';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { unlinkSync, existsSync } from 'fs';

import { getRequest } from './helpers.js';
import { saveAuthRecord, reloadAuthRecord, generateJwtSecret } from '../auth-store.js';
import { signJwt } from '../jwt.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';
import config from '../config.js';
import {
  readCodexModelsCacheForUser,
  resolveSelectableCodexModels,
} from '../codex-model-capability.js';

interface User {
  id: string;
  username: string;
  token: string;
}

let request: supertest.Agent;
let authPath = '';
let userA: User;

function issueTokenForUser(jwtSecret: string, user: { id: string; username: string }): string {
  return signJwt(user.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'Owner', uid: user.id },
  });
}

let projectCounter = 0;

interface ProjectAndAgent {
  projectId: string;
  agentId: string;
}

async function createProjectAndAgentAs(
  user: User,
  agentEngine = 'claude-code',
): Promise<ProjectAndAgent> {
  projectCounter += 1;
  const projectId = `aeo-spawn-proj-${Date.now()}-${projectCounter}`;
  await request
    .post('/api/projects')
    .set('Authorization', `Bearer ${user.token}`)
    .send({ id: projectId, name: 'AEO Project', cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  const agentId = `aeo-spawn-agent-${Date.now()}-${projectCounter}`;
  await request
    .post('/api/agents')
    .set('Authorization', `Bearer ${user.token}`)
    .send({ id: agentId, projectId, name: 'AEO Agent', engine: agentEngine })
    .expect(201);
  return { projectId, agentId };
}

async function createCardAs(user: User, projectId: string, title: string): Promise<string> {
  const boardRes = await request
    .get(`/api/projects/${projectId}/board`)
    .set('Authorization', `Bearer ${user.token}`)
    .expect(200);
  const columns = (boardRes.body as { columns: Array<{ id: string }> }).columns;
  const columnId = columns[0]?.id;
  if (!columnId) throw new Error('No kanban columns provisioned for project');
  const res = await request
    .post(`/api/projects/${projectId}/board/cards`)
    .set('Authorization', `Bearer ${user.token}`)
    .send({ title, description: 'AEO test card', columnId, priority: 'medium' })
    .expect(200);
  return (res.body as { id: string }).id;
}

async function setAgentEngineOverrideAs(
  user: User,
  agentId: string,
  engine: string,
): Promise<void> {
  await request
    .put('/api/auth/me/agent-engine-overrides')
    .set('Authorization', `Bearer ${user.token}`)
    .send({ agentEngineOverrides: { [agentId]: { engine } } })
    .expect(200);
}

beforeAll(async () => {
  request = await getRequest();
  authPath = path.join(config.dataDir, 'auth.json');
  const jwtSecret = generateJwtSecret();
  saveAuthRecord({
    username: 'aeo-owner',
    passwordHash: 'scrypt$ignored',
    jwtSecret,
    role: 'Owner',
  });
  const orgId = getActiveOrgId();
  const aRow = createUser({
    username: `aeo-user-a-${Date.now()}`,
    passwordHash: 'h',
  });
  createMembership(aRow.id, orgId, 'Admin');
  userA = {
    id: aRow.id,
    username: aRow.username,
    token: issueTokenForUser(jwtSecret, aRow),
  };
});

afterAll(() => {
  try {
    if (authPath && existsSync(authPath)) unlinkSync(authPath);
  } catch {
    /* best-effort */
  }
  reloadAuthRecord();
});

describe('Per-user per-agent engine override — session spawn', () => {
  it('uses the agent default engine when no override is set', async () => {
    const { agentId } = await createProjectAndAgentAs(userA, 'claude-code');
    const res = await request
      .post(`/api/agents/${agentId}/sessions`)
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ name: 'control' })
      .expect(200);
    expect(res.body.engine).toBe('claude-code');
  });

  it('overrides the engine when the caller has an agentEngineOverride', async () => {
    const { agentId } = await createProjectAndAgentAs(userA, 'claude-code');

    // PUT the override as user A.
    const put = await request
      .put('/api/auth/me/agent-engine-overrides')
      .set('Authorization', `Bearer ${userA.token}`)
      .send({
        agentEngineOverrides: {
          [agentId]: { engine: 'codex-cli' },
        },
      })
      .expect(200);
    expect(put.body.agentEngineOverrides[agentId].engine).toBe('codex-cli');

    // Spawn a session. It must run on codex-cli, NOT the agent's
    // shared `claude-code` engine.
    const res = await request
      .post(`/api/agents/${agentId}/sessions`)
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ name: 'override' })
      .expect(200);
    expect(res.body.engine).toBe('codex-cli');
    // The model should be valid for codex-cli (i.e., should NOT be
    // whatever the agent shared as its claude-code default).
    const codexModels = resolveSelectableCodexModels(
      config.engineValidModels['codex-cli'] || [],
      readCodexModelsCacheForUser(userA.id, config.dataDir),
    );
    expect(codexModels).toContain(res.body.model);
  });
});

describe('Per-user per-agent engine override — kanban assign model validation', () => {
  // Regression: previously the assign route called
  // validateKanbanAssignModel(model, project, engine === agent.engine ? agent.name : null, config)
  // — so when a per-user override flipped engines the assignee-name fell back
  // to `null`, the validator widened to `cfg.allValidModels` (the global
  // union of every engine), and a claude-code model could be persisted to a
  // session that would actually spawn on codex-cli.
  it('rejects a cross-engine model on /assign when the per-user override changed the engine', async () => {
    const { projectId, agentId } = await createProjectAndAgentAs(userA, 'claude-code');
    const cardId = await createCardAs(userA, projectId, 'Cross-engine reject');

    await setAgentEngineOverrideAs(userA, agentId, 'codex-cli');

    // Pick a model that's valid for the agent's shared `claude-code`
    // engine but NOT for the override engine `codex-cli`. The pre-fix
    // validator accepted it because it lived in `cfg.allValidModels`.
    const claudeModels = config.engineValidModels['claude-code'] || [];
    const codexModels = config.engineValidModels['codex-cli'] || [];
    const crossEngineModel = claudeModels.find((m) => !codexModels.includes(m));
    expect(
      crossEngineModel,
      'expected at least one claude-code model that is not in the codex-cli allowlist',
    ).toBeTruthy();

    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${cardId}/assign`)
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ agentId, model: crossEngineModel })
      .expect(400);
    expect((res.body as { error?: string }).error).toContain('codex-cli');
    expect((res.body as { error?: string }).error).toContain(crossEngineModel!);
  });

  it('accepts an override-engine model on /assign when the per-user override changed the engine', async () => {
    const { projectId, agentId } = await createProjectAndAgentAs(userA, 'claude-code');
    const cardId = await createCardAs(userA, projectId, 'Cross-engine accept');

    await setAgentEngineOverrideAs(userA, agentId, 'codex-cli');

    // A model valid for the override engine must be accepted, and the
    // resulting session row must reflect both the override engine and the
    // explicit model.
    const codexModels = config.engineValidModels['codex-cli'] || [];
    const okModel = codexModels[0];
    expect(okModel, 'expected at least one codex-cli model in config').toBeTruthy();

    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${cardId}/assign`)
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ agentId, model: okModel })
      .expect(200);
    const sessionId = (res.body as { sessionId: string }).sessionId;
    const sessionRes = await request
      .get(`/api/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${userA.token}`)
      .expect(200);
    expect(sessionRes.body.engine).toBe('codex-cli');
    expect(sessionRes.body.model).toBe(okModel);
  });
});
