/**
 * Integration tests for the git smart-HTTP transport using the REAL git
 * binary (precedent: worktree-auto-clone.test.ts). No agent CLIs are
 * spawned. The Hub-side auth stores are mocked; git itself is not.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { execFile, execSync } from 'child_process';
import { promisify } from 'util';
import { gzipSync } from 'zlib';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  config: { apiKey: null as string | null, dataDir: '/unused-by-tests' },
  getAuthRecord: vi.fn((): unknown => null),
  getActiveOrgId: vi.fn((): string => 'org-1'),
  getUserById: vi.fn((): { id: string; username: string } | null => ({
    id: 'u1',
    username: 'alice',
  })),
  getUserByUsername: vi.fn(
    (): { id: string; username: string; password_hash: string } | null => null,
  ),
  getMembershipRole: vi.fn((): string | null => 'User'),
  verifyApiKey: vi.fn(
    (_token: unknown): { userId: string; keyId: string; name: string } | null => null,
  ),
}));

vi.mock('../config.js', () => ({ default: mocks.config }));
vi.mock('../auth-store.js', () => ({ getAuthRecord: mocks.getAuthRecord }));
vi.mock('../orgs.js', () => ({ getActiveOrgId: mocks.getActiveOrgId }));
vi.mock('../users-store.js', () => ({
  getUserById: mocks.getUserById,
  getUserByUsername: mocks.getUserByUsername,
}));
vi.mock('../memberships-store.js', () => ({ getMembershipRole: mocks.getMembershipRole }));
vi.mock('../api-keys-store.js', () => ({ verifyApiKey: mocks.verifyApiKey }));

const { createGitSmartHttpRoutes } = await import('./smart-http.js');
const { createHostedRepo } = await import('./repo-store.js');
import type { Project } from '../types.js';

const execFileP = promisify(execFile);

/** Local-only git (no network) — sync is fine. */
function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

/**
 * Git that talks to the in-process HTTP server (clone/push/fetch) MUST be
 * async: execSync blocks the event loop, the server can never respond,
 * and the test deadlocks until the timeout.
 */
async function gitNet(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    cwd,
    timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

function makeProject(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: id,
    cwd: '',
    ahw: '',
    gitHost: 'agenthub',
    ...overrides,
  } as Project;
}

describe('git smart-HTTP transport (real git)', () => {
  let tmpRoot: string;
  let dataDir: string;
  let server: Server;
  let port: number;
  let app: express.Express;
  const projects = new Map<string, Project>();

  beforeAll(async () => {
    tmpRoot = path.join(
      os.tmpdir(),
      `smart-http-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    dataDir = path.join(tmpRoot, 'data');
    mkdirSync(dataDir, { recursive: true });

    app = express();
    app.use(
      createGitSmartHttpRoutes({
        findProject: (id) => projects.get(id) ?? null,
        dataDir,
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Default: open mode (no auth configured) — like a fresh dev install.
    mocks.config.apiKey = null;
    mocks.getAuthRecord.mockReturnValue(null);
    mocks.verifyApiKey.mockReturnValue(null);
    mocks.getMembershipRole.mockReturnValue('User');
  });

  function repoUrl(projectId: string, creds?: string): string {
    const auth = creds ? `${creds}@` : '';
    return `http://${auth}127.0.0.1:${port}/git/${projectId}.git`;
  }

  function seedWorkdir(dir: string): void {
    mkdirSync(dir, { recursive: true });
    execSync('git init --initial-branch=main', { cwd: dir, stdio: 'pipe' });
    git(dir, 'config user.email "test@example.com"');
    git(dir, 'config user.name "Test"');
    writeFileSync(path.join(dir, 'file.txt'), 'v1\n');
    git(dir, 'add file.txt');
    git(dir, 'commit -m one');
  }

  it('clones an empty hosted repo, pushes, and a second clone sees the commit', async () => {
    projects.set('proj-a', makeProject('proj-a'));
    await createHostedRepo({ id: 'proj-a', cwd: '', repoUrl: null }, { dataDir });

    const work = path.join(tmpRoot, 'work-a');
    seedWorkdir(work);
    git(work, `remote add origin "${repoUrl('proj-a')}"`);
    await gitNet(['push', '-u', 'origin', 'main'], work);

    const clone2 = path.join(tmpRoot, 'clone-a2');
    await gitNet(['clone', '--quiet', repoUrl('proj-a'), clone2]);
    expect(git(clone2, 'log --format=%s -n1')).toBe('one');
    expect(git(clone2, 'symbolic-ref --short HEAD')).toBe('main');
  });

  it('returns 400 for a dumb-protocol probe (missing service param)', async () => {
    projects.set('proj-b', makeProject('proj-b'));
    await createHostedRepo({ id: 'proj-b', cwd: '', repoUrl: null }, { dataDir });
    const res = await request(app).get('/git/proj-b.git/info/refs');
    expect(res.status).toBe(400);
  });

  it('404s unknown repos, non-agenthub projects, and traversal-shaped ids', async () => {
    expect((await request(app).get('/git/nope.git/info/refs?service=git-upload-pack')).status).toBe(
      404,
    );

    projects.set('gh-proj', makeProject('gh-proj', { gitHost: 'github' }));
    await createHostedRepo({ id: 'gh-proj', cwd: '', repoUrl: null }, { dataDir });
    expect(
      (await request(app).get('/git/gh-proj.git/info/refs?service=git-upload-pack')).status,
    ).toBe(404);

    expect(
      (await request(app).get('/git/..%2Fescape.git/info/refs?service=git-upload-pack')).status,
    ).toBe(404);
  });

  it('401s with WWW-Authenticate when auth is configured and no creds sent', async () => {
    mocks.config.apiKey = 'global-secret';
    projects.set('proj-c', makeProject('proj-c'));
    await createHostedRepo({ id: 'proj-c', cwd: '', repoUrl: null }, { dataDir });

    const res = await request(app).get('/git/proj-c.git/info/refs?service=git-upload-pack');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Basic');
  });

  it('authenticates clone+push via Basic password = global apiKey', async () => {
    mocks.config.apiKey = 'global-secret';
    projects.set('proj-d', makeProject('proj-d'));
    await createHostedRepo({ id: 'proj-d', cwd: '', repoUrl: null }, { dataDir });

    const work = path.join(tmpRoot, 'work-d');
    seedWorkdir(work);
    git(work, `remote add origin "${repoUrl('proj-d', 'agent-hub:global-secret')}"`);
    await gitNet(['push', '-u', 'origin', 'main'], work);

    const clone = path.join(tmpRoot, 'clone-d');
    await gitNet(['clone', '--quiet', repoUrl('proj-d', 'agent-hub:global-secret'), clone]);
    expect(git(clone, 'log --format=%s -n1')).toBe('one');
  });

  it('authenticates via ahub_ API key and enforces org membership', async () => {
    mocks.config.apiKey = 'global-secret';
    mocks.verifyApiKey.mockImplementation((token: unknown) =>
      token === 'ahub_valid' ? { userId: 'u1', keyId: 'k1', name: 'test key' } : null,
    );
    projects.set('proj-e', makeProject('proj-e'));
    await createHostedRepo({ id: 'proj-e', cwd: '', repoUrl: null }, { dataDir });

    const clone = path.join(tmpRoot, 'clone-e');
    await gitNet(['clone', '--quiet', repoUrl('proj-e', 'alice:ahub_valid'), clone]);
    expect(existsSync(path.join(clone, '.git'))).toBe(true);

    // Non-member of the active org → 403, not a clone.
    mocks.getMembershipRole.mockReturnValue(null);
    const res = await request(app)
      .get('/git/proj-e.git/info/refs?service=git-upload-pack')
      .auth('alice', 'ahub_valid');
    expect(res.status).toBe(403);
  });

  it('hides private projects from non-owners (404, not 403)', async () => {
    mocks.config.apiKey = 'global-secret';
    mocks.verifyApiKey.mockImplementation((token: unknown) =>
      token === 'ahub_valid' ? { userId: 'u1', keyId: 'k1', name: 'test key' } : null,
    );
    projects.set(
      'proj-f',
      makeProject('proj-f', { visibility: 'private', ownerUserId: 'someone-else' }),
    );
    await createHostedRepo({ id: 'proj-f', cwd: '', repoUrl: null }, { dataDir });

    const res = await request(app)
      .get('/git/proj-f.git/info/refs?service=git-upload-pack')
      .auth('alice', 'ahub_valid');
    expect(res.status).toBe(404);
  });

  it('accepts gzip-encoded request bodies (git compresses bodies >1KB)', async () => {
    projects.set('proj-g', makeProject('proj-g'));
    await createHostedRepo({ id: 'proj-g', cwd: '', repoUrl: null }, { dataDir });

    // A lone flush-pkt is a valid "client hung up" upload-pack request;
    // if gunzip wiring were broken, git would see gzip bytes and error.
    const res = await request(app)
      .post('/git/proj-g.git/git-upload-pack')
      .set('Content-Type', 'application/x-git-upload-pack-request')
      .set('Content-Encoding', 'gzip')
      .send(gzipSync(Buffer.from('0000')));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-git-upload-pack-result');
  });

  it('rejects pack POSTs with the wrong content type', async () => {
    projects.set('proj-h', makeProject('proj-h'));
    await createHostedRepo({ id: 'proj-h', cwd: '', repoUrl: null }, { dataDir });
    const res = await request(app)
      .post('/git/proj-h.git/git-upload-pack')
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(res.status).toBe(415);
  });

  it('advertisement response starts with the pkt-line service preamble', async () => {
    projects.set('proj-i', makeProject('proj-i'));
    await createHostedRepo({ id: 'proj-i', cwd: '', repoUrl: null }, { dataDir });
    const res = await request(app).get('/git/proj-i.git/info/refs?service=git-upload-pack');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-git-upload-pack-advertisement');
    expect(res.headers['cache-control']).toContain('no-cache');
    expect(res.text.startsWith('001e# service=git-upload-pack\n0000')).toBe(true);
  });
});

describe('git smart-HTTP — username + account password auth', () => {
  // Re-declare the suite-level handles (this block appends to the file).
  it('accepts the web-login password and rejects wrong ones', async () => {
    const { hashPassword } = await import('../password.js');
    const { __clearGitPasswordLockouts } = await import('./auth.js');
    __clearGitPasswordLockouts();
    const hash = await hashPassword('hunter2');

    // Auth configured via the single-user auth.json record (owner).
    mocks.config.apiKey = null;
    mocks.getAuthRecord.mockReturnValue({
      username: 'ryan',
      passwordHash: hash,
      jwtSecret: 'x',
      role: 'Owner',
      createdAt: 0,
    });
    mocks.getUserByUsername.mockReturnValue(null); // pre-migration record

    const app2 = (await import('express')).default();
    const dataDir2 = path.join(os.tmpdir(), `smart-http-pw-${Date.now()}`);
    mkdirSync(dataDir2, { recursive: true });
    app2.use(
      createGitSmartHttpRoutes({
        findProject: (id) => (id === 'pw-proj' ? makeProjectPw() : null),
        dataDir: dataDir2,
      }),
    );
    const server2: Server = await new Promise((resolve) => {
      const s = app2.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server2.address();
    const port2 = typeof addr === 'object' && addr ? addr.port : 0;
    function makeProjectPw(): Project {
      return { id: 'pw-proj', name: 'pw', cwd: '', ahw: '', gitHost: 'agenthub' } as Project;
    }
    await createHostedRepo({ id: 'pw-proj', cwd: '', repoUrl: null }, { dataDir: dataDir2 });

    try {
      // Correct password → clone + push round-trip works.
      const work = path.join(dataDir2, 'work');
      mkdirSync(work, { recursive: true });
      execSync('git init --initial-branch=main', { cwd: work, stdio: 'pipe' });
      git(work, 'config user.email "t@example.com"');
      git(work, 'config user.name "T"');
      writeFileSync(path.join(work, 'f.txt'), 'pw\n');
      git(work, 'add f.txt');
      git(work, 'commit -m pw');
      git(work, `remote add origin "http://ryan:hunter2@127.0.0.1:${port2}/git/pw-proj.git"`);
      await gitNet(['push', '-u', 'origin', 'main'], work);

      // Wrong password → 401 (and never a hang).
      const bad = await request(app2)
        .get('/git/pw-proj.git/info/refs?service=git-receive-pack')
        .auth('ryan', 'wrong-password');
      expect(bad.status).toBe(401);

      // Unknown username with the right password shape → 401 too.
      const unknown = await request(app2)
        .get('/git/pw-proj.git/info/refs?service=git-receive-pack')
        .auth('mallory', 'hunter2');
      expect(unknown.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
      rmSync(dataDir2, { recursive: true, force: true });
      __clearGitPasswordLockouts();
    }
  }, 30_000);
});
