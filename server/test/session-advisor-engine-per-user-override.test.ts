/**
 * Picker/API integration spec for adding an advisor whose agent carries a
 * per-user engine override.
 *
 * The reviewer flagged that the add-row picker shows the agent's configured
 * engine but used to send no override, so the server's per-user override could
 * silently spawn a different CLI than the one displayed (and reject a model
 * populated for the shown engine). The client now sends the displayed engine
 * explicitly. This test proves, end-to-end through the real auth + preferences
 * stack, that:
 *
 *   1. An explicit engine on POST /agents is authoritative — it wins over the
 *      owner's per-user override, and a model valid for that explicit engine is
 *      accepted.
 *   2. Omitting the engine (the old buggy behavior) instead resolves to the
 *      per-user override — the divergence the explicit send now prevents.
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

interface User {
  id: string;
  username: string;
  token: string;
}

let request: supertest.Agent;
let authPath = '';
let userA: User;
let counter = 0;

function issueToken(jwtSecret: string, user: { id: string; username: string }): string {
  return signJwt(user.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'Owner', uid: user.id },
  });
}

async function createAgentAs(user: User, engine = 'claude-code'): Promise<string> {
  counter += 1;
  const projectId = `advisor-eo-proj-${Date.now()}-${counter}`;
  await request
    .post('/api/projects')
    .set('Authorization', `Bearer ${user.token}`)
    .send({ id: projectId, name: 'Advisor EO Project', cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  const agentId = `advisor-eo-agent-${Date.now()}-${counter}`;
  await request
    .post('/api/agents')
    .set('Authorization', `Bearer ${user.token}`)
    .send({ id: agentId, projectId, name: 'Advisor EO Agent', engine })
    .expect(201);
  return agentId;
}

async function createSessionAs(user: User, agentId: string): Promise<string> {
  const res = await request
    .post(`/api/agents/${agentId}/sessions`)
    .set('Authorization', `Bearer ${user.token}`)
    .send({ name: 'advisor-eo-session' })
    .expect(200);
  return res.body.id as string;
}

function advisors(body: {
  agents?: Array<{ role: string; engine: string; engineOverride: string | null }>;
}) {
  return (body.agents || []).filter((a) => a.role === 'advisor');
}

beforeAll(async () => {
  request = await getRequest();
  authPath = path.join(config.dataDir, 'auth.json');
  const jwtSecret = generateJwtSecret();
  saveAuthRecord({
    username: 'advisor-eo-owner',
    passwordHash: 'scrypt$ignored',
    jwtSecret,
    role: 'Owner',
  });
  const orgId = getActiveOrgId();
  const aRow = createUser({ username: `advisor-eo-user-${Date.now()}`, passwordHash: 'h' });
  createMembership(aRow.id, orgId, 'Admin');
  userA = { id: aRow.id, username: aRow.username, token: issueToken(jwtSecret, aRow) };
});

afterAll(() => {
  try {
    if (authPath && existsSync(authPath)) unlinkSync(authPath);
  } catch {
    /* best-effort */
  }
  reloadAuthRecord();
});

describe('Add advisor for an agent with a per-user engine override', () => {
  it('honors an explicit engine over the per-user override and accepts its model', async () => {
    const agentId = await createAgentAs(userA, 'claude-code');
    // The owner overrides this agent to cursor-agent for their own sessions.
    await request
      .put('/api/auth/me/agent-engine-overrides')
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ agentEngineOverrides: { [agentId]: { engine: 'cursor-agent' } } })
      .expect(200);
    const sessionId = await createSessionAs(userA, agentId);

    // The picker displays claude-code (the agent engine) and now sends it
    // explicitly, along with a claude model.
    const claudeModel = config.engineValidModels['claude-code']![0]!;
    const res = await request
      .post(`/api/sessions/${sessionId}/agents`)
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ agentId, engine: 'claude-code', model: claudeModel })
      .expect(200);

    const advisor = advisors(res.body).at(-1)!;
    expect(advisor.engine).toBe('claude-code');
    expect(advisor.engineOverride).toBe('claude-code');
  });

  it('resolves to the per-user override when no engine is sent (the divergence the picker now prevents)', async () => {
    const agentId = await createAgentAs(userA, 'claude-code');
    await request
      .put('/api/auth/me/agent-engine-overrides')
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ agentEngineOverrides: { [agentId]: { engine: 'cursor-agent' } } })
      .expect(200);
    const sessionId = await createSessionAs(userA, agentId);

    const res = await request
      .post(`/api/sessions/${sessionId}/agents`)
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ agentId })
      .expect(200);

    const advisor = advisors(res.body).at(-1)!;
    // No stored override, but the reported engine reflects the per-user override
    // (== the CLI the spawn would run) — proving why the picker must send the
    // displayed engine explicitly.
    expect(advisor.engineOverride).toBeNull();
    expect(advisor.engine).toBe('cursor-agent');
  });
});
