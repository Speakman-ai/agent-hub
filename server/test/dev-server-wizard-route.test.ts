/**
 * Integration tests for the AI-assisted Dev Server setup wizard routes.
 *
 *   GET  /api/projects/:projectId/dev-server/setup-draft      (Admin+)
 *   POST /api/projects/:projectId/dev-server/setup-wizard     (Admin+)
 *   POST /api/projects/:projectId/dev-server/setup-apply      (Admin+)
 *   POST /api/projects/:projectId/dev-server/wizard-complete  (User+)
 *
 * No real CLI binaries are spawned: the wizard's `handleChat` is
 * fire-and-forget and returns the synchronously-created session row before
 * any CLI spawn; server/test/setup.ts neutralises the forbidden binaries.
 * setup-apply persists to projects.json (no git), so these tests verify
 * persistence by reading the project back over HTTP.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import './setup.js';
import {
  buildDevServerKickoffPrompt,
  isDevServerSetupWizardSession,
} from '../routes/dev-server-wizard.js';
import type { DevServerSetupDraft } from '../dev-server-setup-draft.js';
import type supertest from 'supertest';
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
    username: 'ds-wizard-owner',
    passwordHash: 'scrypt$ignored',
    jwtSecret,
    role: 'Owner',
  });

  const orgId = getActiveOrgId();

  const userRow = createUser({
    username: `ds-wizard-user-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-01T00:00:00Z',
  });
  createMembership(userRow.id, orgId, 'User');
  userJwt = signJwt(userRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'User', uid: userRow.id },
  });

  const adminRow = createUser({
    username: `ds-wizard-admin-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-02T00:00:00Z',
  });
  createMembership(adminRow.id, orgId, 'Admin');
  adminJwt = signJwt(adminRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'Admin', uid: adminRow.id },
  });
}, 60_000);

let _counter = 0;
function uid(prefix = 'ds-wizard'): string {
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

async function makeAgent(projectId: string): Promise<string> {
  const id = uid('agent');
  const res = await request
    .post('/api/agents')
    .set('Authorization', `Bearer ${adminJwt}`)
    .send({ id, projectId, name: `Agent ${id}`, engine: 'claude-code' })
    .expect(201);
  return (res.body as { id: string }).id;
}

/** Lay down a minimal Vite project under a temp cwd. */
function makeViteCwd(): string {
  const cwd = mkdtempSync(path.join(tmpdir(), 'ah-ds-cwd-'));
  writeFileSync(
    path.join(cwd, 'package.json'),
    JSON.stringify({ name: 'demo', scripts: { dev: 'vite' }, devDependencies: { vite: '^5.0.0' } }),
  );
  writeFileSync(path.join(cwd, 'package-lock.json'), '{}');
  return cwd;
}

describe('GET /api/projects/:projectId/dev-server/setup-draft', () => {
  it('403 when caller is below the Admin role', async () => {
    const res = await request
      .get('/api/projects/any-id/dev-server/setup-draft')
      .set('Authorization', `Bearer ${userJwt}`);
    expect(res.status).toBe(403);
    expect(res.body.requiredRole).toBe('Admin');
  });

  it('404 when the project does not exist', async () => {
    const res = await request
      .get('/api/projects/no-such-project/dev-server/setup-draft')
      .set('Authorization', `Bearer ${adminJwt}`);
    expect(res.status).toBe(404);
  });

  it('happy path returns the detection draft for a Vite app', async () => {
    const cwd = makeViteCwd();
    const projectId = await makeProject(cwd);

    const res = await request
      .get(`/api/projects/${projectId}/dev-server/setup-draft`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);

    expect(res.body.projectId).toBe(projectId);
    expect(res.body.draft.packageManager).toBe('npm');
    expect(res.body.draft.frameworks).toContain('vite');
    expect(res.body.draft.startCommandCandidates[0].command).toBe('npm run dev');
    expect(res.body.draft.existing).toBeNull();
  });
});

describe('POST /api/projects/:projectId/dev-server/setup-wizard', () => {
  it('403 when caller is below the Admin role', async () => {
    const res = await request
      .post('/api/projects/any-id/dev-server/setup-wizard')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('404 when the project does not exist', async () => {
    const res = await request
      .post('/api/projects/no-such-project/dev-server/setup-wizard')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it('400 when the project has no agents to host the wizard', async () => {
    const cwd = makeViteCwd();
    const projectId = await makeProject(cwd);
    const res = await request
      .post(`/api/projects/${projectId}/dev-server/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no agents/i);
  });

  it('happy path spawns a worktree-backed [Dev Server Setup] session with the draft', async () => {
    const cwd = makeViteCwd();
    const projectId = await makeProject(cwd);
    const agentId = await makeAgent(projectId);

    const res = await request
      .post(`/api/projects/${projectId}/dev-server/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({})
      .expect(201);

    expect(res.body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.agentId).toBe(agentId);
    expect(res.body.session.id).toBe(res.body.sessionId);
    expect(res.body.session.use_worktree).toBe(1);
    expect(res.body.session.ask_mode).toBe(0);
    expect(isDevServerSetupWizardSession(res.body.session)).toBe(true);
    expect(res.body.session.name).toMatch(/Dev Server Setup/);
    expect(res.body.draft.frameworks).toContain('vite');
  });
});

describe('buildDevServerKickoffPrompt', () => {
  const draft: DevServerSetupDraft = {
    cwd: '/tmp/work',
    packageManager: 'npm',
    isMonorepo: false,
    monorepoDirs: [],
    startCommandCandidates: [
      { command: 'npm run dev', script: 'dev', raw: 'vite', recommended: true },
    ],
    frameworks: ['vite'],
    portGuesses: [{ internalPort: 5173, label: 'web', source: 'vite default' }],
    healthPathGuess: '/',
    existing: null,
    readme: { path: 'README.md', excerpt: 'run npm run dev' },
  };

  it('embeds bound values, the draft JSON, and the dev-server-setup skill', () => {
    const prompt = buildDevServerKickoffPrompt('proj-1', '/tmp/work', draft, 'sess-1');
    expect(prompt).toContain('proj-1');
    expect(prompt).toContain('/tmp/work');
    expect(prompt).toContain('sess-1');
    expect(prompt).toContain('"internalPort": 5173');
    expect(prompt).toContain('/dev-server/setup-apply');
    expect(prompt).toContain('<agenthub:skill>');
    expect(prompt).toContain('"name":"dev-server-setup"');
    // Surfaces the recommended start command in the summary.
    expect(prompt).toContain('npm run dev');
  });
});

describe('POST /api/projects/:projectId/dev-server/setup-apply', () => {
  it('403 when caller is below the Admin role', async () => {
    const res = await request
      .post('/api/projects/any-id/dev-server/setup-apply')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ devServer: {} });
    expect(res.status).toBe(403);
  });

  it('404 when the project does not exist', async () => {
    const res = await request
      .post('/api/projects/no-such-project/dev-server/setup-apply')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ devServer: {} });
    expect(res.status).toBe(404);
  });

  it('400 when devServer is missing', async () => {
    const cwd = makeViteCwd();
    const projectId = await makeProject(cwd);
    const res = await request
      .post(`/api/projects/${projectId}/dev-server/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({})
      .expect(400);
    expect(res.body.error).toMatch(/devServer must be an object/i);
  });

  it('400 with a prEnv.devServer.<path> message on invalid config', async () => {
    const cwd = makeViteCwd();
    const projectId = await makeProject(cwd);
    const res = await request
      .post(`/api/projects/${projectId}/dev-server/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ devServer: { portMap: [{ internalPort: 70000, label: 'web' }] } })
      .expect(400);
    expect(res.body.error).toMatch(/prEnv\.devServer\.portMap/);
  });

  it('happy path persists prEnv.devServer and stores referenced secrets', async () => {
    const cwd = makeViteCwd();
    const projectId = await makeProject(cwd);

    const res = await request
      .post(`/api/projects/${projectId}/dev-server/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({
        devServer: {
          startCommand: 'npm run dev',
          env: { API_BASE_URL: 'http://localhost:4000' },
          secretKeys: ['STRIPE_SECRET_KEY'],
          portMap: [{ internalPort: 3000, label: 'web' }],
          healthPath: '/',
        },
        secrets: { env: 'STRIPE_SECRET_KEY=sk_test_123', defaultKind: 'secret' },
      })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.secretsImported).toBe(1);

    // Read the project back — config landed in projects.json (no git commit).
    const proj = await request
      .get(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);
    const devServer = proj.body.prEnv.devServer;
    expect(devServer.startCommand).toBe('npm run dev');
    expect(devServer.env.API_BASE_URL).toBe('http://localhost:4000');
    expect(devServer.secretKeys).toEqual(['STRIPE_SECRET_KEY']);
    // The single port map entry is promoted to primary by parseDevServerConfig.
    expect(devServer.portMap).toEqual([{ internalPort: 3000, label: 'web', primary: true }]);
    expect(devServer.healthPath).toBe('/');
  });
});

describe('POST /api/projects/:projectId/dev-server/wizard-complete', () => {
  it('returns ok (idempotent broadcast)', async () => {
    const cwd = makeViteCwd();
    const projectId = await makeProject(cwd);
    const res = await request
      .post(`/api/projects/${projectId}/dev-server/wizard-complete`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({})
      .expect(200);
    expect(res.body.ok).toBe(true);
  });
});
