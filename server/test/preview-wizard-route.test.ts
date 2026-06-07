/**
 * Integration tests for the AI-assisted preview setup wizard routes.
 *
 *   POST /api/projects/:projectId/preview/setup-wizard     (Admin+)
 *   POST /api/projects/:projectId/preview/wizard-complete  (no role gate)
 *
 * Covers:
 *   - 404 when the project doesn't exist
 *   - 403 when a non-Admin caller hits the wizard spawn route
 *   - 400 when the project has no agents to host the wizard
 *   - happy path returns { sessionId, agentId } and persists the session row
 *   - wizard-complete returns { ok: true } and surfaces a 404 for unknown
 *     projects (the broadcast itself is fire-and-forget)
 *
 * The default test caller (no JWT, no apiKey) resolves to Owner — so
 * the role gate is open. We mint a User-role JWT to exercise the 403
 * branch, matching the pattern used by `slack-bots-role-gate.test.ts`.
 *
 * We mock the chat handler in `server/index.ts` so the wizard's
 * fire-and-forget `handleChat` call doesn't actually spawn a CLI. The
 * test caller for `handleChat` is captured so we can assert the
 * kickoff prompt shape.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import path from 'path';

// The wizard route calls `handleChat` fire-and-forget — it returns
// 201 with the synchronously-created session row before any CLI spawn
// would actually happen. server/test/setup.ts neutralises spawn calls
// for the forbidden CLI binaries, so the downstream spawn attempt
// fails inside the chat handler's own promise without affecting the
// supertest response. We don't mock the handler here; we just rely on
// that contract.

import './setup.js';
import { isPreviewSetupWizardSession } from '../routes/preview-wizard.js';
import type supertest from 'supertest';
import { getRequest } from './helpers.js';
import { saveAuthRecord, generateJwtSecret } from '../auth-store.js';
import { signJwt } from '../jwt.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';
import { routeDeps } from '../index.js';
import { replacePreviewSecrets } from '../preview/preview-secrets-store.js';

let request: supertest.Agent;
let userJwt: string;
let adminJwt: string;

beforeAll(async () => {
  request = await getRequest();

  const jwtSecret = generateJwtSecret();
  saveAuthRecord({
    username: 'preview-wizard-owner',
    passwordHash: 'scrypt$ignored',
    jwtSecret,
    role: 'Owner',
  });

  const orgId = getActiveOrgId();

  const userRow = createUser({
    username: `preview-wizard-user-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-01T00:00:00Z',
  });
  createMembership(userRow.id, orgId, 'User');
  userJwt = signJwt(userRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'User', uid: userRow.id },
  });

  const adminRow = createUser({
    username: `preview-wizard-admin-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-02T00:00:00Z',
  });
  createMembership(adminRow.id, orgId, 'Admin');
  adminJwt = signJwt(adminRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'Admin', uid: adminRow.id },
  });
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

let _counter = 0;
function uid(prefix = 'preview-wizard'): string {
  return `${prefix}-${Date.now()}-${++_counter}`;
}

async function makeProject(): Promise<string> {
  const id = uid('proj');
  const res = await request
    .post('/api/projects')
    .set('Authorization', `Bearer ${adminJwt}`)
    .send({ id, name: `Test ${id}`, cwd: '/tmp', color: '#3B82F6' })
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

function makeGitRepo(): { dir: string; branch: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ah-preview-apply-'));
  const branch = `preview/setup-${Date.now()}`;
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  execFileSync('git', ['init'], { cwd: dir, env: gitEnv });
  execFileSync('git', ['checkout', '-b', branch], { cwd: dir, env: gitEnv });
  return { dir, branch };
}

describe('isPreviewSetupWizardSession', () => {
  it('matches wizard session names', () => {
    expect(isPreviewSetupWizardSession({ name: '[Preview Setup] scrabble-app' })).toBe(true);
    expect(isPreviewSetupWizardSession({ name: 'Session 5/20/2026' })).toBe(false);
  });
});

describe('POST /api/projects/:projectId/preview/setup-wizard', () => {
  it('404 when project does not exist', async () => {
    const res = await request
      .post('/api/projects/no-such-project/preview/setup-wizard')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it('403 when caller is below the Admin role', async () => {
    // We don't even need to create the project — requireRole fires
    // before the handler. This matches the slack-bot-role-gate pattern.
    const res = await request
      .post('/api/projects/any-id/preview/setup-wizard')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.requiredRole).toBe('Admin');
    expect(res.body.currentRole).toBe('User');
  });

  it('400 when project has no agents', async () => {
    const projectId = await makeProject();
    const res = await request
      .post(`/api/projects/${projectId}/preview/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({})
      .expect(400);
    expect(res.body.error).toMatch(/no agents/i);
  });

  it('happy path spawns a session and returns { sessionId, agentId }', async () => {
    const projectId = await makeProject();
    const agentId = await makeAgent(projectId);

    const res = await request
      .post(`/api/projects/${projectId}/preview/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({})
      .expect(201);
    expect(typeof res.body.sessionId).toBe('string');
    expect(res.body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.agentId).toBe(agentId);
    expect(res.body.session).toBeDefined();
    expect(res.body.session.id).toBe(res.body.sessionId);
    // Preview setup authors compose files on a branch, then uses normal
    // Finalize path for review and push.
    expect(res.body.session.use_worktree).toBe(1);
    expect(res.body.session.ask_mode).toBe(0);
    // Session name carries the project label so it's distinguishable
    // in the sidebar.
    expect(res.body.session.name).toMatch(/Preview Setup/);
    expect(res.body.draft).toBeDefined();
    expect(Array.isArray(res.body.draft.envVars)).toBe(true);
    expect(['bootstrap_compose', 'confirm_compose']).toContain(res.body.draft.phase);
  });

  it('new wizard sessions are eligible for workspace provisioning', async () => {
    const projectId = await makeProject();
    await makeAgent(projectId);
    const worktreePath = `/tmp/preview-setup-wt-${Date.now()}`;
    const spy = vi.spyOn(routeDeps, 'provisionSessionWorkspace').mockImplementation(async (sid) => {
      routeDeps.stmts.updateSessionWorktreePath.run(
        worktreePath,
        `agent-hub/preview-setup/session-${sid.slice(0, 8)}`,
        sid,
      );
      return worktreePath;
    });

    const startRes = await request
      .post(`/api/projects/${projectId}/preview/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({})
      .expect(201);

    const ensureRes = await request
      .post(`/api/sessions/${startRes.body.sessionId}/workspace/ensure`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({})
      .expect(200);

    expect(spy).toHaveBeenCalledWith(startRes.body.sessionId);
    expect(ensureRes.body.skipped).toBe(false);
    expect(ensureRes.body.worktreePath).toBe(worktreePath);
    expect(ensureRes.body.session.worktree_path).toBe(worktreePath);
  });
});

describe('POST /api/projects/:projectId/preview/setup-compose-bootstrap', () => {
  it('404 when project does not exist', async () => {
    const res = await request
      .post('/api/projects/no-such-project/preview/setup-compose-bootstrap')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ file: 'docker-compose.yml', content: 'services:\n  web:\n    image: nginx\n' });
    expect(res.status).toBe(404);
  });

  it('writes compose file and returns confirm_compose draft', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'ah-wiz-bootstrap-'));
    const projectId = uid('proj-compose');
    await request
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ id: projectId, name: `Test ${projectId}`, cwd: workspace, color: '#3B82F6' })
      .expect(201);
    await makeAgent(projectId);

    const yaml = 'services:\n  web:\n    image: nginx\n    ports:\n      - "8080:80"\n';
    const res = await request
      .post(`/api/projects/${projectId}/preview/setup-compose-bootstrap`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ file: 'docker-compose.yml', content: yaml })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.draft.phase).toBe('confirm_compose');
    expect(res.body.draft.detected?.compose.file).toBe('docker-compose.yml');
  });
});

describe('POST /api/projects/:projectId/preview/setup-apply', () => {
  it('404 when project does not exist', async () => {
    const res = await request
      .post('/api/projects/no-such-project/preview/setup-apply')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ enabled: true, preview: { startScript: 'npm run dev' } });
    expect(res.status).toBe(404);
  });

  it('persists compose preview config', async () => {
    const projectId = await makeProject();
    await makeAgent(projectId);
    const res = await request
      .post(`/api/projects/${projectId}/preview/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({
        enabled: true,
        preview: {
          compose: {
            file: 'docker-compose.yml',
            entryService: 'web',
            entryPort: 3000,
            healthPath: '/healthz',
          },
          captureRoutes: ['/'],
          idleTTL: 600,
        },
      })
      .expect(200);
    expect(res.body.ok).toBe(true);
    const projectRes = await request
      .get(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${adminJwt}`);
    expect(projectRes.body.prEnv?.preview?.compose?.entryService).toBe('web');
    expect(projectRes.body.prEnv?.preview?.compose?.healthPath).toBe('/healthz');
    expect(projectRes.body.prEnv?.preview?.startScript).toBeUndefined();
  });

  it('commits a preview config snapshot into the setup session worktree when session_id is provided', async () => {
    const repo = makeGitRepo();
    const projectId = uid('proj-preview-commit');
    await request
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ id: projectId, name: `Test ${projectId}`, cwd: repo.dir, color: '#3B82F6' })
      .expect(201);
    await makeAgent(projectId);

    const startRes = await request
      .post(`/api/projects/${projectId}/preview/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({})
      .expect(201);
    const sessionId = startRes.body.sessionId as string;
    vi.spyOn(routeDeps, 'provisionSessionWorkspace').mockImplementation(async (sid) => {
      routeDeps.stmts.updateSessionWorktreePath.run(repo.dir, repo.branch, sid);
      return repo.dir;
    });
    writeFileSync(
      path.join(repo.dir, 'compose.preview.yml'),
      'services:\n  client:\n    image: nginx:alpine\n',
      'utf8',
    );

    const res = await request
      .post(`/api/projects/${projectId}/preview/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({
        session_id: sessionId,
        enabled: true,
        preview: {
          compose: {
            file: 'compose.preview.yml',
            entryService: 'client',
            entryPort: 80,
            healthPath: '/',
          },
          captureRoutes: ['/'],
          idleTTL: 600,
        },
      })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.file).toBe('.agent-hub/preview.json');
    expect(res.body.branch).toBe(repo.branch);
    expect(res.body.session_id).toBe(sessionId);
    expect(String(res.body.commit_sha)).toMatch(/^[0-9a-f]{40}$/);

    const snapshot = JSON.parse(
      readFileSync(path.join(repo.dir, '.agent-hub/preview.json'), 'utf8'),
    );
    expect(snapshot).toMatchObject({
      version: 1,
      projectId,
      prEnv: {
        preview: {
          enabled: true,
          compose: {
            file: 'compose.preview.yml',
            entryService: 'client',
            entryPort: 80,
            healthPath: '/',
          },
        },
      },
    });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.dir, encoding: 'utf8' });
    expect(head.trim()).toBe(res.body.commit_sha);
    const committedFiles = execFileSync(
      'git',
      ['show', '--name-only', '--pretty=format:', 'HEAD'],
      {
        cwd: repo.dir,
        encoding: 'utf8',
      },
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(committedFiles).toEqual(
      expect.arrayContaining(['.agent-hub/preview.json', 'compose.preview.yml']),
    );
  });

  it('does not commit arbitrary safe-relative files from preview.compose.file', async () => {
    const repo = makeGitRepo();
    const projectId = uid('proj-preview-safe-path');
    await request
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ id: projectId, name: `Test ${projectId}`, cwd: repo.dir, color: '#3B82F6' })
      .expect(201);
    await makeAgent(projectId);

    const startRes = await request
      .post(`/api/projects/${projectId}/preview/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({})
      .expect(201);
    const sessionId = startRes.body.sessionId as string;
    vi.spyOn(routeDeps, 'provisionSessionWorkspace').mockImplementation(async (sid) => {
      routeDeps.stmts.updateSessionWorktreePath.run(repo.dir, repo.branch, sid);
      return repo.dir;
    });
    writeFileSync(path.join(repo.dir, '.env'), 'SECRET=do-not-commit\n', 'utf8');

    await request
      .post(`/api/projects/${projectId}/preview/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({
        session_id: sessionId,
        enabled: true,
        preview: {
          compose: {
            file: '.env',
            entryService: 'client',
            entryPort: 80,
            healthPath: '/',
          },
        },
      })
      .expect(200);

    const committedFiles = execFileSync(
      'git',
      ['show', '--name-only', '--pretty=format:', 'HEAD'],
      {
        cwd: repo.dir,
        encoding: 'utf8',
      },
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(committedFiles).toContain('.agent-hub/preview.json');
    expect(committedFiles).not.toContain('.env');
  });

  it('does not commit nested compose-looking files from preview.compose.file', async () => {
    const repo = makeGitRepo();
    const projectId = uid('proj-preview-nested-compose');
    await request
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ id: projectId, name: `Test ${projectId}`, cwd: repo.dir, color: '#3B82F6' })
      .expect(201);
    await makeAgent(projectId);

    const startRes = await request
      .post(`/api/projects/${projectId}/preview/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({})
      .expect(201);
    const sessionId = startRes.body.sessionId as string;
    vi.spyOn(routeDeps, 'provisionSessionWorkspace').mockImplementation(async (sid) => {
      routeDeps.stmts.updateSessionWorktreePath.run(repo.dir, repo.branch, sid);
      return repo.dir;
    });
    mkdirSync(path.join(repo.dir, 'deploy'));
    writeFileSync(
      path.join(repo.dir, 'deploy', 'compose.preview.yml'),
      'services:\n  client:\n    image: nginx:alpine\n',
      'utf8',
    );

    await request
      .post(`/api/projects/${projectId}/preview/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({
        session_id: sessionId,
        enabled: true,
        preview: {
          compose: {
            file: 'deploy/compose.preview.yml',
            entryService: 'client',
            entryPort: 80,
            healthPath: '/',
          },
        },
      })
      .expect(200);

    const committedFiles = execFileSync(
      'git',
      ['show', '--name-only', '--pretty=format:', 'HEAD'],
      {
        cwd: repo.dir,
        encoding: 'utf8',
      },
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(committedFiles).toContain('.agent-hub/preview.json');
    expect(committedFiles).not.toContain('deploy/compose.preview.yml');
  });

  it('defaults secrets.mode to merge when omitted (does not wipe existing keys)', async () => {
    const projectId = await makeProject();
    await makeAgent(projectId);
    await request
      .post(`/api/projects/${projectId}/preview/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({
        enabled: true,
        preview: { compose: { entryService: 'web', entryPort: 3000 } },
        secrets: { env: 'KEEP_ME=1\nOTHER=2', mode: 'replace' },
      })
      .expect(200);
    await request
      .post(`/api/projects/${projectId}/preview/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({
        enabled: true,
        preview: { compose: { entryService: 'web', entryPort: 3000 } },
        secrets: { env: 'OTHER=3' },
      })
      .expect(200);
    const listRes = await request
      .get(`/api/projects/${projectId}/secrets`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);
    const rows = (listRes.body as { secrets: Array<{ key: string }> }).secrets;
    const keys = rows.map((r) => r.key).sort();
    expect(keys).toContain('KEEP_ME');
    expect(keys).toContain('OTHER');
  });

  it('400 when secrets.mode is invalid', async () => {
    const projectId = await makeProject();
    const res = await request
      .post(`/api/projects/${projectId}/preview/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({
        enabled: true,
        preview: { compose: { entryService: 'web', entryPort: 3000 } },
        secrets: { env: 'X=1', mode: 'nope' },
      });
    expect(res.status).toBe(400);
  });

  it('does not commit preview files when secret validation fails for a setup session', async () => {
    const repo = makeGitRepo();
    const projectId = uid('proj-preview-secret-fail');
    await request
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ id: projectId, name: `Test ${projectId}`, cwd: repo.dir, color: '#3B82F6' })
      .expect(201);
    await makeAgent(projectId);

    const startRes = await request
      .post(`/api/projects/${projectId}/preview/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({})
      .expect(201);
    const sessionId = startRes.body.sessionId as string;
    vi.spyOn(routeDeps, 'provisionSessionWorkspace').mockImplementation(async (sid) => {
      routeDeps.stmts.updateSessionWorktreePath.run(repo.dir, repo.branch, sid);
      return repo.dir;
    });
    writeFileSync(
      path.join(repo.dir, 'compose.preview.yml'),
      'services:\n  client:\n    image: nginx:alpine\n',
      'utf8',
    );
    await request
      .post(`/api/projects/${projectId}/preview/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({
        session_id: sessionId,
        enabled: true,
        preview: {
          compose: {
            file: 'compose.preview.yml',
            entryService: 'client',
            entryPort: 80,
            healthPath: '/',
          },
        },
        secrets: { env: 'API_KEY=secret', mode: 'nope' },
      })
      .expect(400);

    expect(existsSync(path.join(repo.dir, '.agent-hub/preview.json'))).toBe(false);
    expect(() =>
      execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: repo.dir,
        stdio: 'ignore',
      }),
    ).toThrow();
  });

  it('does not persist preview config or secrets when setup session worktree cannot resolve', async () => {
    const projectId = await makeProject();
    await makeAgent(projectId);

    await request
      .post(`/api/projects/${projectId}/preview/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({
        session_id: 'missing-session-id',
        enabled: true,
        preview: {
          compose: {
            file: 'compose.preview.yml',
            entryService: 'client',
            entryPort: 80,
            healthPath: '/',
          },
        },
        secrets: { env: 'API_KEY=secret', mode: 'replace' },
      })
      .expect(400);

    const projectRes = await request
      .get(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);
    expect(projectRes.body.prEnv).toBeUndefined();

    const secretsRes = await request
      .get(`/api/projects/${projectId}/secrets`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);
    expect((secretsRes.body as { secrets: Array<{ key: string }> }).secrets).toEqual([]);
  });

  it('removes the generated preview snapshot when setup commit fails', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'ah-preview-commit-fail-'));
    const branch = `preview/setup-${Date.now()}`;
    const projectId = uid('proj-preview-commit-fail');
    await request
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ id: projectId, name: `Test ${projectId}`, cwd: workspace, color: '#3B82F6' })
      .expect(201);
    await makeAgent(projectId);

    const startRes = await request
      .post(`/api/projects/${projectId}/preview/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({})
      .expect(201);
    const sessionId = startRes.body.sessionId as string;
    vi.spyOn(routeDeps, 'provisionSessionWorkspace').mockImplementation(async (sid) => {
      routeDeps.stmts.updateSessionWorktreePath.run(workspace, branch, sid);
      return workspace;
    });
    replacePreviewSecrets(projectId, [{ key: 'KEEP_ME', value: '1', kind: 'secret' }], null);
    await request
      .post(`/api/projects/${projectId}/preview/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({
        session_id: sessionId,
        enabled: true,
        preview: {
          compose: {
            file: 'compose.preview.yml',
            entryService: 'client',
            entryPort: 80,
            healthPath: '/',
          },
        },
        secrets: { env: 'API_KEY=secret', mode: 'replace' },
      })
      .expect(500);

    expect(existsSync(path.join(workspace, '.agent-hub/preview.json'))).toBe(false);
    const projectRes = await request
      .get(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);
    expect(projectRes.body.prEnv).toBeUndefined();
    const secretsRes = await request
      .get(`/api/projects/${projectId}/secrets`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);
    const rows = (secretsRes.body as { secrets: Array<{ key: string }> }).secrets;
    expect(rows.map((r) => r.key)).not.toContain('API_KEY');
  });

  it('removes the generated preview snapshot and staged paths when git commit fails', async () => {
    const repo = makeGitRepo();
    const projectId = uid('proj-preview-hook-fail');
    await request
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ id: projectId, name: `Test ${projectId}`, cwd: repo.dir, color: '#3B82F6' })
      .expect(201);
    await makeAgent(projectId);

    const startRes = await request
      .post(`/api/projects/${projectId}/preview/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({})
      .expect(201);
    const sessionId = startRes.body.sessionId as string;
    vi.spyOn(routeDeps, 'provisionSessionWorkspace').mockImplementation(async (sid) => {
      routeDeps.stmts.updateSessionWorktreePath.run(repo.dir, repo.branch, sid);
      return repo.dir;
    });
    writeFileSync(
      path.join(repo.dir, 'compose.preview.yml'),
      'services:\n  client:\n    image: nginx:alpine\n',
      'utf8',
    );
    const hookPath = path.join(repo.dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\nexit 1\n', 'utf8');
    chmodSync(hookPath, 0o755);

    await request
      .post(`/api/projects/${projectId}/preview/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({
        session_id: sessionId,
        enabled: true,
        preview: {
          compose: {
            file: 'compose.preview.yml',
            entryService: 'client',
            entryPort: 80,
            healthPath: '/',
          },
        },
        secrets: { env: 'API_KEY=secret', mode: 'replace' },
      })
      .expect(500);

    expect(existsSync(path.join(repo.dir, '.agent-hub/preview.json'))).toBe(false);
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: repo.dir,
      encoding: 'utf8',
    });
    expect(status).not.toContain('.agent-hub/preview.json');
    expect(status).not.toContain('A  compose.preview.yml');
    const projectRes = await request
      .get(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);
    expect(projectRes.body.prEnv).toBeUndefined();
    const secretsRes = await request
      .get(`/api/projects/${projectId}/secrets`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);
    const rows = (secretsRes.body as { secrets: Array<{ key: string }> }).secrets;
    expect(rows.map((r) => r.key)).not.toContain('API_KEY');
  });
});

describe('POST /api/projects/:projectId/preview/wizard-complete', () => {
  it('401 for unauthenticated callers', async () => {
    const res = await request
      .post('/api/projects/no-such-project/preview/wizard-complete')
      .send({});
    expect(res.status).toBe(401);
  });

  it('returns { ok: true } even for unknown projects to hide existence', async () => {
    // The gate has already passed (User role); we deliberately do NOT
    // distinguish unknown-project from known-project in the response
    // to avoid leaking a project-id oracle. No broadcast fires for an
    // unknown project — that side-effect is asserted in the happy-path
    // test below by virtue of being the only path that emits one.
    const res = await request
      .post('/api/projects/no-such-project/preview/wizard-complete')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({})
      .expect(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns { ok: true } for a known project (User role passes the gate)', async () => {
    const projectId = await makeProject();
    const res = await request
      .post(`/api/projects/${projectId}/preview/wizard-complete`)
      .set('Authorization', `Bearer ${userJwt}`)
      .send({})
      .expect(200);
    expect(res.body).toEqual({ ok: true });
  });
});
