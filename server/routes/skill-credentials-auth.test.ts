/**
 * Skill credential REST — Vitest integration (real orgs.db + auth wiring).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync, writeFileSync } from 'fs';
import path from 'path';

vi.mock('../pr-env-store.js', () => ({
  encryptSecret(s: string) {
    return Buffer.from(s, 'utf8').toString('base64url');
  },
  decryptSecret(s: string) {
    return Buffer.from(s, 'base64url').toString('utf8');
  },
}));

vi.mock('../skill-credentials-resolve.js', () => ({
  readCredentialsSchemaForSkill: () => ({
    credentials: [
      {
        name: 'GH_TOKEN',
        label: 'GitHub PAT',
        description: '',
        required: false,
        type: 'secret',
      },
    ],
    error: null,
  }),
}));

let TMP_DIR = '';
const mockConfig = {
  apiKey: null as string | null,
  anthropicApiKey: null as string | null,
  claudeCodeOAuthToken: null as string | null,
  get dataDir() {
    return TMP_DIR;
  },
};

vi.mock('../config.js', () => ({ default: mockConfig }));

const { default: createAuthRoutes } = await import('./auth.js');
const { authMiddleware } = await import('../auth.js');
const { setAuthFilePathForTests, reloadAuthRecord } = await import('../auth-store.js');
const { initOrgsDb, setOrgsDbPathForTests, updateOrg } = await import('../orgs.js');

function buildGatedApp() {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(createAuthRoutes());
  return app;
}

async function setupOwner(app: ReturnType<typeof buildGatedApp>): Promise<string> {
  const res = await supertest(app)
    .post('/api/auth/setup')
    .send({ username: 'owner', password: 'x'.repeat(20) });
  if (res.status !== 200) throw new Error(`setup failed: ${JSON.stringify(res.body)}`);
  return res.body.token as string;
}

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'skill-cred-test-'));
  setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  writeFileSync(path.join(TMP_DIR, 'projects.json'), '[]');
  updateOrg('default', { mode: 'remote' });
  reloadAuthRecord();
  mockConfig.apiKey = null;
});

describe('/api/auth/me/skill-credentials', () => {
  it('returns 401 for api-key-only callers (no uid)', async () => {
    const app = buildGatedApp();
    mockConfig.apiKey = 'sekrit';
    const res = await supertest(app)
      .get('/api/auth/me/skill-credentials')
      .set('x-api-key', 'sekrit');
    expect(res.status).toBe(401);
  });

  it('PUT round-trips with masked GET and DELETE clears row', async () => {
    const app = buildGatedApp();
    const token = await setupOwner(app);

    const put = await supertest(app)
      .put('/api/auth/me/skill-credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({
        skill_id: 'github',
        key_name: 'GH_TOKEN',
        value: 'ghp_integration_test_value_xx',
      });
    expect(put.status).toBe(200);
    expect(put.body.credential.key_name).toBe('GH_TOKEN');
    expect(put.body.credential.masked_preview).toMatch(/^••••/);

    const listed = await supertest(app)
      .get('/api/auth/me/skill-credentials?skillId=github')
      .set('Authorization', `Bearer ${token}`);
    expect(listed.status).toBe(200);
    expect(listed.body.credentials).toHaveLength(1);

    const id = listed.body.credentials[0].id as string;

    await supertest(app)
      .delete(`/api/auth/me/skill-credentials/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const after = await supertest(app)
      .get('/api/auth/me/skill-credentials')
      .set('Authorization', `Bearer ${token}`);
    expect(after.body.credentials).toHaveLength(0);
  });

  it('rejects PUT for unknown credential key names', async () => {
    const app = buildGatedApp();
    const token = await setupOwner(app);
    const put = await supertest(app)
      .put('/api/auth/me/skill-credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({
        skill_id: 'github',
        key_name: 'NOT_A_REAL_KEY',
        value: 'x',
      });
    expect(put.status).toBe(400);
  });
});
