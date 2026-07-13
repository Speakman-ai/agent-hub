import '../test/setup.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import type supertest from 'supertest';
import supertestRequest from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getRequest } from '../test/helpers.js';
import { getDb, getStmts } from '../db.js';
import createSessionRoutes from './sessions.js';
import { reloadAuthRecord, saveAuthRecord, setAuthFilePathForTests } from '../auth-store.js';
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

function mountCredentialRoutes(authUserId: string): supertest.Agent {
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
      findAgent: () => null,
      findProject: () => null,
      getEnrichedAgent: () => null,
      config: {},
      activeProcesses: new Map(),
    } as unknown as RouteDeps),
  );
  return supertestRequest(app);
}

describe('session credential requests', () => {
  it('stores credentials off-transcript and consumes them once', async () => {
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

    const afterConsume = getDb()
      .prepare(
        `SELECT values_enc, consumed_at FROM session_credential_requests
         WHERE session_id = ? AND request_id = ?`,
      )
      .get(sessionId, requestId) as { values_enc: string; consumed_at: string | null };
    expect(afterConsume.values_enc).toBe('');
    expect(afterConsume.consumed_at).toBeTruthy();

    await request
      .post(`/api/sessions/${sessionId}/credential-requests/${requestId}/consume`)
      .expect(404);
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
