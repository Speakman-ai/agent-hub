/**
 * Integration tests for the Finalize ci.yaml setup wizard routes.
 *
 *   POST /api/projects/:projectId/finalize/setup-wizard     (Admin+)
 *   POST /api/projects/:projectId/finalize/setup-apply      (Admin+)
 *   POST /api/projects/:projectId/finalize/wizard-complete  (User+)
 *
 * Covers:
 *   - role gates (403 for User-role caller on setup-wizard / setup-apply)
 *   - 404 when the project doesn't exist
 *   - 400 when the project has no agents to host the wizard
 *   - happy path returns { sessionId, agentId, draft, session }
 *   - setup-apply: 400 on missing/invalid YAML, schema error envelope
 *   - setup-apply: 400 when no session with a worktree exists
 *   - setup-apply: writes the file + commits it, returns sha + branch
 *   - wizard-complete: 200 with { ok: true }, fires broadcast for known
 *     projects
 *
 * Real git is exercised — these tests initialise a temp repo per case and
 * the apply endpoint runs `git add` / `git commit` against it. No CLI
 * binaries are spawned (the chat handler is fire-and-forget; see the
 * preview-wizard route test for the same contract).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import './setup.js';
import { isFinalizeSetupWizardSession } from '../routes/finalize-wizard.js';
import type supertest from 'supertest';
import { getRequest } from './helpers.js';
import { saveAuthRecord, generateJwtSecret } from '../auth-store.js';
import { signJwt } from '../jwt.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';
import { getDb } from '../db.js';

let request: supertest.Agent;
let userJwt: string;
let adminJwt: string;

beforeAll(async () => {
  request = await getRequest();

  const jwtSecret = generateJwtSecret();
  saveAuthRecord({
    username: 'finalize-wizard-owner',
    passwordHash: 'scrypt$ignored',
    jwtSecret,
    role: 'Owner',
  });

  const orgId = getActiveOrgId();

  const userRow = createUser({
    username: `finalize-wizard-user-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-01T00:00:00Z',
  });
  createMembership(userRow.id, orgId, 'User');
  userJwt = signJwt(userRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'User', uid: userRow.id },
  });

  const adminRow = createUser({
    username: `finalize-wizard-admin-${Date.now()}`,
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
function uid(prefix = 'finalize-wizard'): string {
  return `${prefix}-${Date.now()}-${++_counter}`;
}

async function makeProject(cwd: string = '/tmp'): Promise<string> {
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

/**
 * Spin up a temp git repo + seed a session with a worktree_path/branch
 * pointing at it. Returns `{ worktreeDir, sessionId, branch }`.
 *
 * We use a single-branch repo (no actual `git worktree add`) — the apply
 * endpoint only needs `worktree_path` to be a working git dir, not an
 * actual linked worktree. Keeps the test setup cheap.
 */
function seedSessionWithRepo(agentId: string): {
  worktreeDir: string;
  sessionId: string;
  branch: string;
} {
  const worktreeDir = mkdtempSync(path.join(tmpdir(), 'ah-finalize-wt-'));
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: worktreeDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: worktreeDir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: worktreeDir });
  writeFileSync(path.join(worktreeDir, 'README.md'), 'seed\n');
  execFileSync('git', ['add', '.'], { cwd: worktreeDir });
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: worktreeDir });

  const sessionId = uid('sess');
  const branch = 'feature/ci-yaml';
  execFileSync('git', ['checkout', '-b', branch], { cwd: worktreeDir });
  getDb()
    .prepare(
      'INSERT INTO sessions (id, agent_id, name, engine, model, use_worktree, ask_mode, worktree_path, worktree_branch, wiki_hybrid_rag_budget_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      sessionId,
      agentId,
      'Test seed',
      'claude-code',
      'claude-sonnet-4-5',
      1,
      0,
      worktreeDir,
      branch,
      1,
    );
  return { worktreeDir, sessionId, branch };
}

describe('isFinalizeSetupWizardSession', () => {
  it('matches wizard session names', () => {
    expect(isFinalizeSetupWizardSession({ name: '[Finalize Setup] demo' })).toBe(true);
    expect(isFinalizeSetupWizardSession({ name: 'Session 5/29/2026' })).toBe(false);
    expect(isFinalizeSetupWizardSession({ name: null })).toBe(false);
  });
});

describe('POST /api/projects/:projectId/finalize/setup-wizard', () => {
  it('404 when project does not exist', async () => {
    const res = await request
      .post('/api/projects/no-such-project/finalize/setup-wizard')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it('403 when caller is below the Admin role', async () => {
    const res = await request
      .post('/api/projects/any-id/finalize/setup-wizard')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.requiredRole).toBe('Admin');
  });

  it('400 when project has no agents', async () => {
    const projectId = await makeProject();
    const res = await request
      .post(`/api/projects/${projectId}/finalize/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({})
      .expect(400);
    expect(res.body.error).toMatch(/no agents/i);
  });

  it('happy path spawns a session and returns the draft', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'ah-finalize-cwd-'));
    writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    writeFileSync(path.join(cwd, 'package-lock.json'), '{}');
    const projectId = await makeProject(cwd);
    const agentId = await makeAgent(projectId);

    const res = await request
      .post(`/api/projects/${projectId}/finalize/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({})
      .expect(201);
    expect(typeof res.body.sessionId).toBe('string');
    expect(res.body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.agentId).toBe(agentId);
    expect(res.body.session.use_worktree).toBe(0);
    expect(res.body.session.name).toMatch(/Finalize Setup/);
    expect(res.body.draft.stack).toBe('node');
    expect(res.body.draft.packageManager).toBe('npm');
    expect(res.body.draft.proposedCiYaml).toMatch(/npm ci --include=dev/);
  });
});

describe('POST /api/projects/:projectId/finalize/setup-apply', () => {
  it('404 when project does not exist', async () => {
    const res = await request
      .post('/api/projects/no-such-project/finalize/setup-apply')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ ci_yaml_content: 'version: 1\non:\n  - manual\nsteps:\n  - run: echo ok\n' });
    expect(res.status).toBe(404);
  });

  it('403 when caller is below Admin', async () => {
    const res = await request
      .post('/api/projects/any-id/finalize/setup-apply')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ ci_yaml_content: 'x' });
    expect(res.status).toBe(403);
  });

  it('400 when ci_yaml_content is missing', async () => {
    const projectId = await makeProject();
    const res = await request
      .post(`/api/projects/${projectId}/finalize/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({})
      .expect(400);
    expect(res.body.error).toMatch(/non-empty/i);
  });

  it('400 with ci_config_invalid envelope when YAML fails v1 validation', async () => {
    const projectId = await makeProject();
    const res = await request
      .post(`/api/projects/${projectId}/finalize/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ ci_yaml_content: 'version: 2\non:\n  - manual\nsteps:\n  - run: x\n' })
      .expect(400);
    expect(res.body.error).toBe('ci_config_invalid');
    expect(res.body.code).toBe('invalid_version');
    expect(typeof res.body.message).toBe('string');
  });

  it('400 when no session with a worktree exists for the project', async () => {
    const projectId = await makeProject();
    await makeAgent(projectId);
    const yaml = 'version: 1\non:\n  - manual\nsteps:\n  - run: echo ok\n';
    const res = await request
      .post(`/api/projects/${projectId}/finalize/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ ci_yaml_content: yaml })
      .expect(400);
    expect(res.body.error).toBe('no_worktree');
  });

  it('happy path: writes the file and commits it on the session branch', async () => {
    const projectId = await makeProject();
    const agentId = await makeAgent(projectId);
    const { worktreeDir, sessionId, branch } = seedSessionWithRepo(agentId);

    const yaml = [
      'version: 1',
      'on:',
      '  - finalize',
      '  - manual',
      'timeout_minutes: 30',
      'steps:',
      '  - name: test',
      '    run: npm test',
      '',
    ].join('\n');

    const res = await request
      .post(`/api/projects/${projectId}/finalize/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ ci_yaml_content: yaml, session_id: sessionId })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.file).toBe('.agent-hub/ci.yaml');
    expect(res.body.branch).toBe(branch);
    expect(res.body.session_id).toBe(sessionId);
    expect(typeof res.body.commit_sha).toBe('string');
    expect(res.body.commit_sha).toMatch(/^[0-9a-f]{40}$/);

    // File landed in the worktree on the expected branch.
    const written = readFileSync(path.join(worktreeDir, '.agent-hub', 'ci.yaml'), 'utf8');
    expect(written).toBe(yaml);

    // Commit exists with the expected message.
    const log = execFileSync('git', ['log', '-1', '--pretty=%s'], {
      cwd: worktreeDir,
      encoding: 'utf8',
    });
    expect(log.trim()).toBe('Add .agent-hub/ci.yaml via Finalize setup wizard');

    // Author identity was overridden (local fallback — push signing is
    // unaffected).
    const authorEmail = execFileSync('git', ['log', '-1', '--pretty=%ae'], {
      cwd: worktreeDir,
      encoding: 'utf8',
    });
    expect(authorEmail.trim()).toBe('agent-hub-bot@local');
  });

  it('appends a trailing newline when the input lacks one', async () => {
    const projectId = await makeProject();
    const agentId = await makeAgent(projectId);
    const { worktreeDir, sessionId } = seedSessionWithRepo(agentId);

    const yaml = 'version: 1\non:\n  - manual\nsteps:\n  - run: echo ok'; // no \n
    await request
      .post(`/api/projects/${projectId}/finalize/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ ci_yaml_content: yaml, session_id: sessionId })
      .expect(200);

    const written = readFileSync(path.join(worktreeDir, '.agent-hub', 'ci.yaml'), 'utf8');
    expect(written.endsWith('\n')).toBe(true);
  });

  it('400 when the worktree path is missing on disk', async () => {
    const projectId = await makeProject();
    const agentId = await makeAgent(projectId);
    const sessionId = uid('sess-bogus');
    getDb()
      .prepare(
        'INSERT INTO sessions (id, agent_id, name, engine, model, use_worktree, ask_mode, worktree_path, worktree_branch, wiki_hybrid_rag_budget_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        sessionId,
        agentId,
        'Test',
        'claude-code',
        'claude-sonnet-4-5',
        1,
        0,
        '/no/such/dir',
        'main',
        1,
      );

    const yaml = 'version: 1\non:\n  - manual\nsteps:\n  - run: echo ok\n';
    const res = await request
      .post(`/api/projects/${projectId}/finalize/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ ci_yaml_content: yaml, session_id: sessionId })
      .expect(400);
    expect(res.body.error).toBe('worktree_missing');
  });
});

describe('POST /api/projects/:projectId/finalize/wizard-complete', () => {
  it('returns { ok: true } even for unknown projects (broadcast is fire-and-forget)', async () => {
    const res = await request
      .post('/api/projects/no-such-project/finalize/wizard-complete')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({})
      .expect(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns { ok: true } for known projects', async () => {
    const projectId = await makeProject();
    const res = await request
      .post(`/api/projects/${projectId}/finalize/wizard-complete`)
      .set('Authorization', `Bearer ${userJwt}`)
      .send({})
      .expect(200);
    expect(res.body.ok).toBe(true);
  });
});
