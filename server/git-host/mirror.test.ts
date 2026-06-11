/**
 * Mirror sync tests. The "GitHub" target is a second local bare repo via
 * `pushUrlOverride` (no network, no tokens). The end-to-end test drives
 * the real chain: git push → post-receive hook → notify endpoint →
 * debounced mirror push.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { execFile, execSync } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';

const mocks = vi.hoisted(() => ({
  config: { apiKey: null as string | null, dataDir: '/unused-by-tests' },
  getAuthRecord: vi.fn((): unknown => null),
  getActiveOrgId: vi.fn((): string => 'org-1'),
  getUserById: vi.fn((): { id: string; username: string } | null => null),
  getMembershipRole: vi.fn((): string | null => null),
  verifyApiKey: vi.fn(
    (_t: unknown): { userId: string; keyId: string; name: string } | null => null,
  ),
}));

vi.mock('../config.js', () => ({ default: mocks.config }));
vi.mock('../auth-store.js', () => ({ getAuthRecord: mocks.getAuthRecord }));
vi.mock('../orgs.js', () => ({ getActiveOrgId: mocks.getActiveOrgId }));
vi.mock('../users-store.js', () => ({ getUserById: mocks.getUserById }));
vi.mock('../memberships-store.js', () => ({ getMembershipRole: mocks.getMembershipRole }));
vi.mock('../api-keys-store.js', () => ({ verifyApiKey: mocks.verifyApiKey }));

const { notifyMirrorPush, readMirrorState, __clearMirrorQueues } = await import('./mirror.js');
const { createHostedRepo, gitHostRepoPath } = await import('./repo-store.js');
const { createGitSmartHttpRoutes } = await import('./smart-http.js');
import type { Project } from '../types.js';

const execFileP = promisify(execFile);

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

function makeProject(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: id,
    cwd: '',
    ahw: '',
    gitHost: 'agenthub',
    repoUrl: 'https://github.com/owner/repo.git',
    ...overrides,
  } as Project;
}

describe('git-host mirror sync', () => {
  let tmpRoot: string;
  let dataDir: string;
  let githubBare: string;
  let broadcast: ReturnType<typeof vi.fn<(data: Record<string, unknown>) => void>>;

  beforeEach(async () => {
    tmpRoot = path.join(
      os.tmpdir(),
      `mirror-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    dataDir = path.join(tmpRoot, 'data');
    mkdirSync(dataDir, { recursive: true });
    githubBare = path.join(tmpRoot, 'github.git');
    mkdirSync(githubBare, { recursive: true });
    execSync('git init --bare --initial-branch=main', { cwd: githubBare, stdio: 'pipe' });
    broadcast = vi.fn();
    __clearMirrorQueues();
  });

  afterEach(() => {
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  function seedWorkdir(dir: string): string {
    mkdirSync(dir, { recursive: true });
    execSync('git init --initial-branch=main', { cwd: dir, stdio: 'pipe' });
    git(dir, 'config user.email "t@example.com"');
    git(dir, 'config user.name "T"');
    writeFileSync(path.join(dir, 'f.txt'), 'x\n');
    git(dir, 'add f.txt');
    git(dir, 'commit -m one');
    return git(dir, 'rev-parse HEAD');
  }

  async function seedHostedRepo(projectId: string): Promise<string> {
    const cwd = path.join(tmpRoot, `${projectId}-seed`);
    const sha = seedWorkdir(cwd);
    await createHostedRepo({ id: projectId, cwd, repoUrl: null }, { dataDir });
    return sha;
  }

  it('mirrors the default branch when it moves (policy: default-branch)', async () => {
    const sha = await seedHostedRepo('m1');
    const project = makeProject('m1');

    await notifyMirrorPush(project, ['refs/heads/main'], {
      broadcast,
      dataDir,
      pushUrlOverride: githubBare,
      debounceMs: 10,
    });

    expect(git(githubBare, 'rev-parse refs/heads/main')).toBe(sha);
    expect(readMirrorState('m1', dataDir).lastSyncAt).toBeTruthy();
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'git_host_mirror', status: 'synced' }),
    );
  });

  it('skips sync when only a feature branch moved (policy: default-branch)', async () => {
    await seedHostedRepo('m2');
    const project = makeProject('m2');

    await notifyMirrorPush(project, ['refs/heads/feature-x'], {
      broadcast,
      dataDir,
      pushUrlOverride: githubBare,
      debounceMs: 10,
    });

    expect(() => git(githubBare, 'rev-parse refs/heads/main')).toThrow();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("mirrors every branch with refs: 'all'", async () => {
    await seedHostedRepo('m3');
    const bare = gitHostRepoPath('m3', dataDir);
    const mainSha = git(bare, 'rev-parse refs/heads/main');
    execSync(`git -C "${bare}" branch feature-y ${mainSha}`, { stdio: 'pipe' });
    const project = makeProject('m3', { gitMirror: { enabled: true, refs: 'all' } });

    await notifyMirrorPush(project, ['refs/heads/feature-y'], {
      broadcast,
      dataDir,
      pushUrlOverride: githubBare,
      debounceMs: 10,
    });

    expect(git(githubBare, 'rev-parse refs/heads/feature-y')).toBe(mainSha);
    expect(git(githubBare, 'rev-parse refs/heads/main')).toBe(mainSha);
  });

  it('does nothing when the mirror is disabled or the project is not hosted', async () => {
    await seedHostedRepo('m4');
    await notifyMirrorPush(
      makeProject('m4', { gitMirror: { enabled: false } }),
      ['refs/heads/main'],
      { broadcast, dataDir, pushUrlOverride: githubBare, debounceMs: 10 },
    );
    await notifyMirrorPush(makeProject('m4', { gitHost: 'github' }), ['refs/heads/main'], {
      broadcast,
      dataDir,
      pushUrlOverride: githubBare,
      debounceMs: 10,
    });
    expect(() => git(githubBare, 'rev-parse refs/heads/main')).toThrow();
  });

  it('records the error and keeps the push alive when the mirror target is broken', async () => {
    await seedHostedRepo('m5');
    const project = makeProject('m5');

    await notifyMirrorPush(project, ['refs/heads/main'], {
      broadcast,
      dataDir,
      pushUrlOverride: path.join(tmpRoot, 'does-not-exist.git'),
      debounceMs: 10,
      retryDelayMs: 60_000, // out of test scope
    });

    const state = readMirrorState('m5', dataDir);
    expect(state.lastError).toBeTruthy();
    expect(state.lastErrorAt).toBeTruthy();
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'git_host_mirror', status: 'error' }),
    );
  });

  it('end-to-end: push → post-receive hook → notify endpoint → mirror', async () => {
    const projects = new Map<string, Project>();
    const app = express();
    app.use(
      createGitSmartHttpRoutes({
        findProject: (id) => projects.get(id) ?? null,
        broadcast,
        dataDir,
      }),
    );
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;

    try {
      const project = makeProject('m6');
      projects.set('m6', project);
      // Patch the mirror to hit the local bare: notifyMirrorPush inside
      // the endpoint uses project.repoUrl as the target. Point repoUrl at
      // the local bare path — classifyCloneUrl treats it as 'other', so
      // policy still enables because repoUrl is set, and the push URL is
      // the path itself.
      project.repoUrl = githubBare;

      const cwd = path.join(tmpRoot, 'm6-seed');
      seedWorkdir(cwd);
      await createHostedRepo(
        { id: 'm6', cwd, repoUrl: null },
        { dataDir, notifyUrl: `http://127.0.0.1:${port}/git/internal/hooks/post-receive` },
      );

      // New commit pushed into the hosted bare → hook fires → mirror runs.
      writeFileSync(path.join(cwd, 'g.txt'), 'y\n');
      git(cwd, 'add g.txt');
      git(cwd, 'commit -m two');
      const bare = gitHostRepoPath('m6', dataDir);
      git(cwd, `remote add origin "${bare}"`);
      await execFileP('git', ['push', 'origin', 'main'], { cwd, timeout: 15_000 });

      await vi.waitFor(
        () => {
          expect(git(githubBare, 'rev-parse refs/heads/main')).toBe(git(cwd, 'rev-parse HEAD'));
        },
        { timeout: 15_000 },
      );
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'git_host_push', projectId: 'm6' }),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});
