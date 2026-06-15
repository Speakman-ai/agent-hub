/**
 * Integration tests for the AI RUM setup wizard routes.
 *
 *   GET  /api/projects/:projectId/rum/setup-draft     (Admin+)
 *   POST /api/projects/:projectId/rum/setup-wizard    (Admin+)
 *
 * Covers:
 *   - role gate (403 for a User-role caller) on both routes
 *   - 404 when the project does not exist
 *   - GET happy path returns { projectId, draft } with detected framework
 *   - POST 400 when the project has no agents to host the wizard
 *   - POST happy path spawns a worktree-backed session and returns
 *     { sessionId, agentId, draft, session }
 *   - buildRumKickoffPrompt embeds the draft, bound values, and rum-setup
 *     skill, and surfaces the framework-specific injection style
 *
 * No real CLI binaries are spawned: the wizard's `handleChat` is
 * fire-and-forget and returns the synchronously-created session row before
 * any CLI spawn; server/test/setup.ts neutralises the forbidden binaries so
 * the downstream spawn attempt fails inside the chat handler's own promise
 * without affecting the supertest response.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import './setup.js';
import { buildRumKickoffPrompt, isRumSetupWizardSession } from '../routes/rum-wizard.js';
import type { RumSetupDraft } from '../rum-setup-draft.js';
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
    username: 'rum-wizard-owner',
    passwordHash: 'scrypt$ignored',
    jwtSecret,
    role: 'Owner',
  });

  const orgId = getActiveOrgId();

  const userRow = createUser({
    username: `rum-wizard-user-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-01T00:00:00Z',
  });
  createMembership(userRow.id, orgId, 'User');
  userJwt = signJwt(userRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'User', uid: userRow.id },
  });

  const adminRow = createUser({
    username: `rum-wizard-admin-${Date.now()}`,
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
function uid(prefix = 'rum-wizard'): string {
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

/** Lay down a minimal Next.js app-router project under a temp cwd. */
function makeNextAppCwd(): string {
  const cwd = mkdtempSync(path.join(tmpdir(), 'ah-rum-cwd-'));
  writeFileSync(
    path.join(cwd, 'package.json'),
    JSON.stringify({ name: 'demo', dependencies: { next: '14.0.0', react: '18.2.0' } }),
  );
  writeFileSync(path.join(cwd, 'package-lock.json'), '{}');
  writeFileSync(path.join(cwd, 'tsconfig.json'), '{}');
  mkdirSync(path.join(cwd, 'app'), { recursive: true });
  writeFileSync(path.join(cwd, 'app', 'layout.tsx'), 'export default function L() {}');
  return cwd;
}

describe('GET /api/projects/:projectId/rum/setup-draft', () => {
  it('403 when caller is below the Admin role', async () => {
    const res = await request
      .get('/api/projects/any-id/rum/setup-draft')
      .set('Authorization', `Bearer ${userJwt}`);
    expect(res.status).toBe(403);
    expect(res.body.requiredRole).toBe('Admin');
  });

  it('404 when the project does not exist', async () => {
    const res = await request
      .get('/api/projects/no-such-project/rum/setup-draft')
      .set('Authorization', `Bearer ${adminJwt}`);
    expect(res.status).toBe(404);
  });

  it('happy path returns the detection draft for a Next.js app', async () => {
    const cwd = makeNextAppCwd();
    const projectId = await makeProject(cwd);

    const res = await request
      .get(`/api/projects/${projectId}/rum/setup-draft`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);

    expect(res.body.projectId).toBe(projectId);
    expect(res.body.draft.framework).toBe('next');
    expect(res.body.draft.packageManager).toBe('npm');
    expect(res.body.draft.typescript).toBe(true);
    expect(res.body.draft.plan.targetFile).toBe('app/layout.tsx');
    // Next app-router layout is a Server Component → client-component insertion.
    expect(res.body.draft.plan.injectionStyle).toBe('client-component');
  });
});

describe('POST /api/projects/:projectId/rum/setup-wizard', () => {
  it('403 when caller is below the Admin role', async () => {
    const res = await request
      .post('/api/projects/any-id/rum/setup-wizard')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.requiredRole).toBe('Admin');
  });

  it('404 when the project does not exist', async () => {
    const res = await request
      .post('/api/projects/no-such-project/rum/setup-wizard')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it('400 when the project has no agents to host the wizard', async () => {
    const cwd = makeNextAppCwd();
    const projectId = await makeProject(cwd);

    const res = await request
      .post(`/api/projects/${projectId}/rum/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no agents/i);
  });

  it('happy path spawns a worktree-backed session with the draft embedded', async () => {
    const cwd = makeNextAppCwd();
    const projectId = await makeProject(cwd);
    const agentId = await makeAgent(projectId);

    const res = await request
      .post(`/api/projects/${projectId}/rum/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({})
      .expect(201);

    expect(typeof res.body.sessionId).toBe('string');
    expect(res.body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.agentId).toBe(agentId);
    expect(res.body.session).toBeDefined();
    expect(res.body.session.id).toBe(res.body.sessionId);
    // Worktree-backed so the agent can author edits on its own branch and
    // use Finalize Code Changes for review/push.
    expect(res.body.session.use_worktree).toBe(1);
    expect(res.body.session.ask_mode).toBe(0);
    expect(isRumSetupWizardSession(res.body.session)).toBe(true);
    expect(res.body.session.name).toMatch(/RUM Setup/);
    // The detection draft rides along in the response and the kickoff.
    expect(res.body.draft.framework).toBe('next');
    expect(res.body.draft.plan.injectionStyle).toBe('client-component');
    expect(res.body.draft.plan.targetFile).toBe('app/layout.tsx');
  });
});

describe('buildRumKickoffPrompt', () => {
  const draft: RumSetupDraft = {
    framework: 'next',
    frameworkEvidence: ['next'],
    packageManager: 'npm',
    typescript: true,
    entryCandidates: [{ path: 'app/layout.tsx', kind: 'root-layout' }],
    cspHits: [{ path: 'next.config.js', source: 'header' }],
    recorder: { dependencyPresent: false, initDetected: false },
    plan: {
      alreadyInstrumented: false,
      targetFile: 'app/layout.tsx',
      injectionStyle: 'client-component',
      recommendedConnectSrc: 'https://hub.example.com',
      notes: ['Next app-router layout is a Server Component'],
    },
    readme: {
      readmePath: null,
      setupExcerpt: null,
      hasDockerHints: false,
      envKeysFromReadme: [],
    },
  };

  it('embeds bound values, the draft JSON, and the rum-setup skill', () => {
    const prompt = buildRumKickoffPrompt('proj-1', '/tmp/work', draft, 'sess-1');
    expect(prompt).toContain('PROJECT_ID');
    expect(prompt).toContain('proj-1');
    expect(prompt).toContain('/tmp/work');
    expect(prompt).toContain('sess-1');
    // Full draft is embedded so the agent does not re-scan.
    expect(prompt).toContain('"injectionStyle": "client-component"');
    expect(prompt).toContain('app/layout.tsx');
    // Skill is loaded for the framework-specific walkthrough.
    expect(prompt).toContain('<agenthub:skill>');
    expect(prompt).toContain('"name":"rum-setup"');
    // Surfaces the detected injection style and target in the summary.
    expect(prompt).toContain('client-component');
  });

  it('flags an undetermined target when nothing was detected', () => {
    const prompt = buildRumKickoffPrompt(
      'p',
      '/c',
      {
        ...draft,
        plan: { ...draft.plan, targetFile: null, injectionStyle: null },
      },
      's',
    );
    expect(prompt).toContain('none detected');
  });
});
