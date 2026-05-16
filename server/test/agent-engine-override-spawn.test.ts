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
import { resetOrgOwnerCache } from '../session-ownership.js';
import config from '../config.js';

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

async function createProjectAndAgentAs(user: User, agentEngine = 'claude-code'): Promise<string> {
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
  return agentId;
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
  resetOrgOwnerCache();
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
  resetOrgOwnerCache();
});

describe('Per-user per-agent engine override — session spawn', () => {
  it('uses the agent default engine when no override is set', async () => {
    const agentId = await createProjectAndAgentAs(userA, 'claude-code');
    const res = await request
      .post(`/api/agents/${agentId}/sessions`)
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ name: 'control' })
      .expect(200);
    expect(res.body.engine).toBe('claude-code');
  });

  it('overrides the engine when the caller has an agentEngineOverride', async () => {
    const agentId = await createProjectAndAgentAs(userA, 'claude-code');

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
    const codexModels = config.engineValidModels['codex-cli'] || [];
    expect(codexModels).toContain(res.body.model);
  });
});
