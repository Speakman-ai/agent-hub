/**
 * Project.noGuardrails toggle + the No Guardrails session mode gate.
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getRequest, createProject, createAgent, createSession } from '../test/helpers.js';
import config from '../config.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';
import { createApiKey } from '../api-keys-store.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
}, 60_000);

async function sessionInNewProject(): Promise<{ projectId: string; sessionId: string }> {
  const project = await createProject();
  const agent = await createAgent({ projectId: project.id as string });
  const session = await createSession({ agentId: agent.id as string });
  return { projectId: project.id as string, sessionId: session.id as string };
}

const enabled = (projectId: string) =>
  request
    .get(`/api/projects/${projectId}`)
    .expect(200)
    .then((r) => r.body.noGuardrails?.enabled === true);

describe('No Guardrails session mode', () => {
  it('is refused while the project toggle is off (the default)', async () => {
    const { projectId, sessionId } = await sessionInNewProject();
    expect(await enabled(projectId)).toBe(false);

    const put = await request
      .put(`/api/sessions/${sessionId}/mode`)
      .send({ mode: 'no-guardrails' })
      .expect(400);
    expect(put.body.error).toBe('no_guardrails_not_enabled');

    const patch = await request
      .patch(`/api/sessions/${sessionId}`)
      .send({ session_mode: 'no-guardrails' })
      .expect(400);
    expect(patch.body.error).toBe('no_guardrails_not_enabled');
  });

  it('is accepted once the project enables it, and refused again after it is turned off', async () => {
    const { projectId, sessionId } = await sessionInNewProject();
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ noGuardrails: { enabled: true } })
      .expect(200);
    expect(await enabled(projectId)).toBe(true);

    await request
      .put(`/api/sessions/${sessionId}/mode`)
      .send({ mode: 'no-guardrails' })
      .expect(200);

    await request
      .patch(`/api/projects/${projectId}`)
      .send({ noGuardrails: { enabled: false } })
      .expect(200);
    await request.put(`/api/sessions/${sessionId}/mode`).send({ mode: 'chat' }).expect(200);
    await request
      .put(`/api/sessions/${sessionId}/mode`)
      .send({ mode: 'no-guardrails' })
      .expect(400);
  });

  it('rejects malformed toggles without changing the stored value', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    await request.patch(`/api/projects/${projectId}`).send({ noGuardrails: true }).expect(400);
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ noGuardrails: { enabled: 'yes' } })
      .expect(400);
    // A rejected toggle must not half-apply other fields in the same PATCH.
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ name: 'renamed', noGuardrails: [] })
      .expect(400);
    const after = await request.get(`/api/projects/${projectId}`).expect(200);
    expect(after.body.noGuardrails?.enabled).not.toBe(true);
    expect(after.body.name).not.toBe('renamed');
  });
});

describe('No Guardrails toggle permissions', () => {
  let originalApiKey: string | null;
  let projectId: string;
  let userKey: string;
  let adminKey: string;

  beforeAll(async () => {
    originalApiKey = config.apiKey;
    config.apiKey = null;
    projectId = (await createProject()).id as string;

    const orgId = getActiveOrgId();
    const stamp = Date.now();
    const user = createUser({
      username: `ng-user-${stamp}@example.com`,
      passwordHash: 'h',
      createdAt: '2026-01-01T00:00:00Z',
    });
    createMembership(user.id, orgId, 'User');
    userKey = createApiKey(user.id, 'ng-user').token;
    const admin = createUser({
      username: `ng-admin-${stamp}@example.com`,
      passwordHash: 'h',
      createdAt: '2026-01-01T00:00:00Z',
    });
    createMembership(admin.id, orgId, 'Admin');
    adminKey = createApiKey(admin.id, 'ng-admin').token;

    config.apiKey = 'no-guardrails-secret';
  }, 60_000);

  afterAll(() => {
    config.apiKey = originalApiKey;
  });

  it('refuses the global API key that spawned agents carry', async () => {
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .set('x-api-key', 'no-guardrails-secret')
      .send({ noGuardrails: { enabled: true } })
      .expect(403);
    expect(res.body.code).toBe('no_guardrails_requires_person');
  });

  it('refuses a User-role caller and accepts an Admin', async () => {
    const denied = await request
      .patch(`/api/projects/${projectId}`)
      .set('x-api-key', userKey)
      .send({ noGuardrails: { enabled: true } });
    expect(denied.status).toBe(403);

    const ok = await request
      .patch(`/api/projects/${projectId}`)
      .set('x-api-key', adminKey)
      .send({ noGuardrails: { enabled: true } })
      .expect(200);
    expect(ok.body.noGuardrails?.enabled).toBe(true);
  });
});
