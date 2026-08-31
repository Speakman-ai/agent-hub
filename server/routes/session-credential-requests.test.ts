import '../test/setup.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import type supertest from 'supertest';
import supertestRequest from 'supertest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getRequest } from '../test/helpers.js';
import { getDb, getStmts } from '../db.js';
import createSessionRoutes from './sessions.js';
import { reloadAuthRecord, saveAuthRecord, setAuthFilePathForTests } from '../auth-store.js';
import { setProjectSkillsDataDir } from '../project-skill-paths.js';
import { listMaskedUserSkillCredentials } from '../skill-credentials-store.js';
import { createUser } from '../users-store.js';
import config from '../config.js';
import type { RouteDeps } from '../types.js';
import {
  __setSessionCredentialConsumeBeforeUpdateForTests,
  consumeSessionCredentialRequest,
} from '../session-credential-requests.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

afterEach(() => {
  setAuthFilePathForTests(null);
  reloadAuthRecord();
  __setSessionCredentialConsumeBeforeUpdateForTests(null);
});

function createSession(ownerUserId: string | null = null): string {
  const sessionId = `session-cred-${uuidv4()}`;
  getDb()
    .prepare(
      `INSERT INTO sessions
         (id, agent_id, name, engine, model, use_worktree, ask_mode, owner_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(sessionId, 'agent-dev', 'Credential test', 'codex-cli', 'gpt-5', 1, 0, ownerUserId);
  return sessionId;
}

function enableStrictAuth(): void {
  const authDir = mkdtempSync(path.join(tmpdir(), 'session-cred-auth-'));
  setAuthFilePathForTests(path.join(authDir, 'auth.json'));
  saveAuthRecord({
    username: 'owner@example.com',
    passwordHash: 'scrypt$hash',
    jwtSecret: 'a'.repeat(64),
  });
  reloadAuthRecord();
}

function mountCredentialRoutes(
  authUserId: string,
  findAgent: RouteDeps['findAgent'] = () => null,
): supertest.Agent {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    Object.assign(req, { authUserId, authUser: 'tester@example.com', authRole: 'User' });
    next();
  });
  app.use(
    createSessionRoutes({
      stmts: getStmts(),
      broadcast: vi.fn(),
      findAgent,
      findProject: () => null,
      getEnrichedAgent: () => null,
      config: {},
      activeProcesses: new Map(),
    } as unknown as RouteDeps),
  );
  return supertestRequest(app);
}

describe('session credential requests', () => {
  it('stores credentials off-transcript and re-reads them until they expire', async () => {
    const sessionId = createSession();
    const requestId = 'survey-tracker-login';

    const submit = await request
      .put(`/api/sessions/${sessionId}/credential-requests/${requestId}`)
      .send({
        service: 'Survey Tracker',
        purpose: 'Sign in to query work orders.',
        ttlSeconds: 900,
        fields: [
          { key: 'username', label: 'Username', type: 'username' },
          { key: 'password', label: 'Password', type: 'password' },
        ],
        values: {
          username: 'employee@example.com',
          password: 'survey-secret-password',
        },
      })
      .expect(200);

    expect(submit.body).toMatchObject({
      requestId,
      service: 'Survey Tracker',
      status: 'submitted',
    });
    expect(JSON.stringify(submit.body)).not.toContain('survey-secret-password');
    expect(JSON.stringify(submit.body)).not.toContain('employee@example.com');

    const raw = getDb()
      .prepare(
        `SELECT values_enc, consumed_at FROM session_credential_requests
         WHERE session_id = ? AND request_id = ?`,
      )
      .get(sessionId, requestId) as { values_enc: string; consumed_at: string | null };
    expect(raw.values_enc).not.toContain('survey-secret-password');
    expect(raw.consumed_at).toBeNull();

    const status = await request
      .get(`/api/sessions/${sessionId}/credential-requests/${requestId}`)
      .expect(200);
    expect(status.body.status).toBe('submitted');
    expect(JSON.stringify(status.body)).not.toContain('survey-secret-password');
    expect(JSON.stringify(status.body)).not.toContain('employee@example.com');

    const consumed = await request
      .post(`/api/sessions/${sessionId}/credential-requests/${requestId}/consume`)
      .expect(200);
    expect(consumed.body).toMatchObject({
      requestId,
      values: {
        username: 'employee@example.com',
        password: 'survey-secret-password',
      },
    });

    // First consume stamps consumed_at but keeps the payload retrievable, so a
    // second consume of the SAME requestId returns the same values instead of
    // forcing the user to resubmit the secret (the "asked multiple times" bug).
    const afterConsume = getDb()
      .prepare(
        `SELECT values_enc, consumed_at FROM session_credential_requests
         WHERE session_id = ? AND request_id = ?`,
      )
      .get(sessionId, requestId) as { values_enc: string; consumed_at: string | null };
    expect(afterConsume.values_enc).not.toBe('');
    expect(afterConsume.consumed_at).toBeTruthy();

    const reconsumed = await request
      .post(`/api/sessions/${sessionId}/credential-requests/${requestId}/consume`)
      .expect(200);
    expect(reconsumed.body).toMatchObject({
      requestId,
      values: {
        username: 'employee@example.com',
        password: 'survey-secret-password',
      },
    });

    // Once the request expires, the payload is erased and consume returns 404.
    getDb()
      .prepare(
        `UPDATE session_credential_requests
         SET expires_at = ?
         WHERE session_id = ? AND request_id = ?`,
      )
      .run(new Date(Date.now() - 1000).toISOString(), sessionId, requestId);

    await request
      .post(`/api/sessions/${sessionId}/credential-requests/${requestId}/consume`)
      .expect(404);

    const afterExpiry = getDb()
      .prepare(
        `SELECT values_enc FROM session_credential_requests
         WHERE session_id = ? AND request_id = ?`,
      )
      .get(sessionId, requestId) as { values_enc: string };
    expect(afterExpiry.values_enc).toBe('');
  });

  it('reports expired (not consumed) and erases the payload for a consumed-then-expired request', async () => {
    const sessionId = createSession();
    const requestId = 'survey-tracker-consumed-expired';
    await request
      .put(`/api/sessions/${sessionId}/credential-requests/${requestId}`)
      .send({
        service: 'Survey Tracker',
        purpose: 'Sign in to query work orders.',
        fields: [{ key: 'password', label: 'Password', type: 'password' }],
        values: { password: 'consumed-then-expired-secret' },
      })
      .expect(200);

    // Consume once while still valid — the payload is retained (re-readable).
    await request
      .post(`/api/sessions/${sessionId}/credential-requests/${requestId}/consume`)
      .expect(200);
    const afterConsume = getDb()
      .prepare(
        `SELECT values_enc FROM session_credential_requests
         WHERE session_id = ? AND request_id = ?`,
      )
      .get(sessionId, requestId) as { values_enc: string };
    expect(afterConsume.values_enc).not.toBe('');

    // Now expire it. Even though consumed_at is set, the shared status model
    // must rank expiry first so the read path reports 'expired' and cleans up
    // the ciphertext (rather than reporting 'consumed' and leaking it past TTL).
    getDb()
      .prepare(
        `UPDATE session_credential_requests
         SET expires_at = ?
         WHERE session_id = ? AND request_id = ?`,
      )
      .run(new Date(Date.now() - 1000).toISOString(), sessionId, requestId);

    const status = await request
      .get(`/api/sessions/${sessionId}/credential-requests/${requestId}`)
      .expect(200);
    expect(status.body.status).toBe('expired');

    const afterStatus = getDb()
      .prepare(
        `SELECT values_enc FROM session_credential_requests
         WHERE session_id = ? AND request_id = ?`,
      )
      .get(sessionId, requestId) as { values_enc: string };
    expect(afterStatus.values_enc).toBe('');
  });

  it('does not return plaintext when another consume wins the row transition', async () => {
    const sessionId = createSession();
    const requestId = 'survey-tracker-race';
    await request
      .put(`/api/sessions/${sessionId}/credential-requests/${requestId}`)
      .send({
        service: 'Survey Tracker',
        purpose: 'Sign in to query work orders.',
        fields: [{ key: 'password', label: 'Password', type: 'password' }],
        values: { password: 'race-secret' },
      })
      .expect(200);

    __setSessionCredentialConsumeBeforeUpdateForTests(() => {
      const consumedAt = new Date().toISOString();
      getDb()
        .prepare(
          `UPDATE session_credential_requests
           SET values_enc = '', consumed_at = ?, updated_at = ?
           WHERE session_id = ? AND request_id = ?`,
        )
        .run(consumedAt, consumedAt, sessionId, requestId);
    });

    expect(consumeSessionCredentialRequest(sessionId, requestId)).toBeNull();
  });

  it('erases the payload when the request expires between the initial check and the re-read', async () => {
    const sessionId = createSession();
    const requestId = 'survey-tracker-toctou-expiry';
    await request
      .put(`/api/sessions/${sessionId}/credential-requests/${requestId}`)
      .send({
        service: 'Survey Tracker',
        purpose: 'Sign in to query work orders.',
        fields: [{ key: 'password', label: 'Password', type: 'password' }],
        values: { password: 'toctou-secret' },
      })
      .expect(200);

    // Fire between the initial rowIsExpired() check and the re-read: push the
    // request past its TTL so the fresh row is expired. The consume must not
    // return plaintext AND must erase the retained ciphertext on that boundary.
    __setSessionCredentialConsumeBeforeUpdateForTests(() => {
      getDb()
        .prepare(
          `UPDATE session_credential_requests
           SET expires_at = ?
           WHERE session_id = ? AND request_id = ?`,
        )
        .run(new Date(Date.now() - 1000).toISOString(), sessionId, requestId);
    });

    expect(consumeSessionCredentialRequest(sessionId, requestId)).toBeNull();

    const raw = getDb()
      .prepare(
        `SELECT values_enc FROM session_credential_requests
         WHERE session_id = ? AND request_id = ?`,
      )
      .get(sessionId, requestId) as { values_enc: string };
    expect(raw.values_enc).toBe('');
  });

  it('erases encrypted payload when an expired request is observed', async () => {
    const sessionId = createSession();
    const requestId = 'survey-tracker-expired';
    await request
      .put(`/api/sessions/${sessionId}/credential-requests/${requestId}`)
      .send({
        service: 'Survey Tracker',
        purpose: 'Sign in to query work orders.',
        fields: [{ key: 'password', label: 'Password', type: 'password' }],
        values: { password: 'expired-secret' },
      })
      .expect(200);

    const expiredAt = new Date(Date.now() - 1000).toISOString();
    getDb()
      .prepare(
        `UPDATE session_credential_requests
         SET expires_at = ?
         WHERE session_id = ? AND request_id = ?`,
      )
      .run(expiredAt, sessionId, requestId);

    const beforeStatus = getDb()
      .prepare(
        `SELECT values_enc FROM session_credential_requests
         WHERE session_id = ? AND request_id = ?`,
      )
      .get(sessionId, requestId) as { values_enc: string };
    expect(beforeStatus.values_enc).not.toBe('');

    const status = await request
      .get(`/api/sessions/${sessionId}/credential-requests/${requestId}`)
      .expect(200);
    expect(status.body.status).toBe('expired');

    const afterStatus = getDb()
      .prepare(
        `SELECT values_enc FROM session_credential_requests
         WHERE session_id = ? AND request_id = ?`,
      )
      .get(sessionId, requestId) as { values_enc: string };
    expect(afterStatus.values_enc).toBe('');
  });

  it('rejects credential submission for a session owned by another user', async () => {
    enableStrictAuth();
    const sessionId = createSession('owner-user');
    const requestId = 'survey-tracker-login';

    await mountCredentialRoutes('other-user')
      .put(`/api/sessions/${sessionId}/credential-requests/${requestId}`)
      .send({
        service: 'Survey Tracker',
        purpose: 'Sign in to query work orders.',
        fields: [{ key: 'password', label: 'Password', type: 'password' }],
        values: { password: 'poisoned-secret' },
      })
      .expect(404);

    const raw = getDb()
      .prepare(
        `SELECT values_enc FROM session_credential_requests
         WHERE session_id = ? AND request_id = ?`,
      )
      .get(sessionId, requestId);
    expect(raw).toBeUndefined();
  });

  it('persists box-collected values into the owner skill store when the request declares a persist target', async () => {
    const originalDataDir = config.dataDir;
    const dataDir = mkdtempSync(path.join(tmpdir(), 'session-cred-persist-route-'));
    setProjectSkillsDataDir(dataDir);
    try {
      const projectId = 'proj-persist';
      const skillId = 'survey-tracker';
      const skillDir = path.join(dataDir, 'project-skills', projectId, skillId);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: survey-tracker
credentials:
  - name: SURVEYTRACKER_API_DATA_USERNAME
    label: Username
    required: false
    type: secret
  - name: SURVEYTRACKER_API_DATA_PASSWORD
    label: Password
    required: false
    type: secret
---
# Survey Tracker
`,
        'utf8',
      );

      const ownerUserId = createUser({
        username: `owner-${uuidv4()}@example.com`,
        passwordHash: 'scrypt$hash',
      }).id;
      const sessionId = createSession(ownerUserId);
      const findAgent = (() => ({
        agent: { id: 'agent-dev' },
        project: { id: projectId },
      })) as unknown as RouteDeps['findAgent'];

      const submit = await mountCredentialRoutes(ownerUserId, findAgent)
        .put(`/api/sessions/${sessionId}/credential-requests/survey-tracker-login`)
        .send({
          service: 'Survey Tracker',
          purpose: 'Sign in to query work orders.',
          fields: [
            { key: 'username', label: 'Username', type: 'username' },
            { key: 'password', label: 'Password', type: 'password' },
          ],
          values: { username: 'ryan@example.com', password: 'survey-secret-password' },
          persist: {
            skillId,
            map: {
              username: 'SURVEYTRACKER_API_DATA_USERNAME',
              password: 'SURVEYTRACKER_API_DATA_PASSWORD',
            },
          },
        })
        .expect(200);

      expect(submit.body.status).toBe('submitted');
      expect(submit.body.persisted.skillId).toBe(skillId);
      expect(submit.body.persisted.error ?? 'no-error').toBe('no-error');
      expect(submit.body.persisted.skipped).toEqual([]);
      expect(submit.body.persisted.stored.sort()).toEqual([
        'SURVEYTRACKER_API_DATA_PASSWORD',
        'SURVEYTRACKER_API_DATA_USERNAME',
      ]);
      // No plaintext ever echoes back on the response.
      expect(JSON.stringify(submit.body)).not.toContain('survey-secret-password');

      // The values now live in the owner's persistent skill credential store.
      const stored = listMaskedUserSkillCredentials(ownerUserId, skillId);
      expect(stored.map((r) => r.key_name).sort()).toEqual([
        'SURVEYTRACKER_API_DATA_PASSWORD',
        'SURVEYTRACKER_API_DATA_USERNAME',
      ]);
    } finally {
      setProjectSkillsDataDir(originalDataDir);
    }
  });

  it('reports a persist error (without failing the submit) when the skill declares no credentials', async () => {
    const originalDataDir = config.dataDir;
    const dataDir = mkdtempSync(path.join(tmpdir(), 'session-cred-persist-route-err-'));
    setProjectSkillsDataDir(dataDir);
    try {
      const ownerUserId = `owner-${uuidv4()}`;
      const sessionId = createSession(ownerUserId);
      const findAgent = (() => ({
        agent: { id: 'agent-dev' },
        project: { id: 'proj-no-skill' },
      })) as unknown as RouteDeps['findAgent'];

      const submit = await mountCredentialRoutes(ownerUserId, findAgent)
        .put(`/api/sessions/${sessionId}/credential-requests/no-skill-login`)
        .send({
          service: 'Nowhere',
          purpose: 'Sign in.',
          fields: [{ key: 'password', label: 'Password', type: 'password' }],
          values: { password: 'x' },
          persist: { skillId: 'this-skill-does-not-exist', map: { password: 'FOO' } },
        })
        .expect(200);

      // Ephemeral submit still succeeded so the agent can use the value now.
      expect(submit.body.status).toBe('submitted');
      expect(submit.body.persisted.stored).toEqual([]);
      expect(submit.body.persisted.error).toMatch(/declares no credentials/);
    } finally {
      setProjectSkillsDataDir(originalDataDir);
    }
  });

  it('rejects credential consumption for a session owned by another user', async () => {
    enableStrictAuth();
    const sessionId = createSession('owner-user');
    const requestId = 'survey-tracker-login';
    await mountCredentialRoutes('owner-user')
      .put(`/api/sessions/${sessionId}/credential-requests/${requestId}`)
      .send({
        service: 'Survey Tracker',
        purpose: 'Sign in to query work orders.',
        fields: [{ key: 'password', label: 'Password', type: 'password' }],
        values: { password: 'owner-secret' },
      })
      .expect(200);

    await mountCredentialRoutes('other-user')
      .post(`/api/sessions/${sessionId}/credential-requests/${requestId}/consume`)
      .expect(404);

    const consumed = await mountCredentialRoutes('owner-user')
      .post(`/api/sessions/${sessionId}/credential-requests/${requestId}/consume`)
      .expect(200);
    expect(consumed.body.values.password).toBe('owner-secret');
  });
});
