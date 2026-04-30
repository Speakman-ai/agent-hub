import type supertest from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { getRequest, createProject } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// GET /api/projects/:projectId/branches
//
// The card configuration UI's PR base-branch picker fetches every
// branch the project's `origin` remote knows about. The endpoint shells
// out to `git ls-remote --heads origin` from the project cwd; we mirror
// that contract here against a real (but local) bare repo.
// ═══════════════════════════════════════════════════════════════════

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

interface RepoFixture {
  workCwd: string;
  bareCwd: string;
  cleanup: () => void;
}

function createGitFixture(branches: string[]): RepoFixture {
  const root = mkdtempSync(path.join(tmpdir(), 'pr-base-branches-'));
  const bareCwd = path.join(root, 'remote.git');
  const workCwd = path.join(root, 'work');
  execSync(`git init --bare --initial-branch=main ${JSON.stringify(bareCwd)}`);
  execSync(`git init --initial-branch=main ${JSON.stringify(workCwd)}`);
  // Configure local identity inside the work dir so commits don't fail in
  // sandboxed CI environments without a global git identity.
  execSync('git config user.email "test@example.com"', { cwd: workCwd });
  execSync('git config user.name "Test"', { cwd: workCwd });
  execSync('git commit --allow-empty -m initial', { cwd: workCwd });
  execSync(`git remote add origin ${JSON.stringify(bareCwd)}`, { cwd: workCwd });
  execSync('git push -u origin main', { cwd: workCwd });
  for (const branch of branches) {
    if (branch === 'main') continue;
    execSync(`git branch ${JSON.stringify(branch)} main`, { cwd: workCwd });
    execSync(`git push origin ${JSON.stringify(branch)}`, { cwd: workCwd });
  }
  return {
    workCwd,
    bareCwd,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('GET /api/projects/:projectId/branches', () => {
  let fixture: RepoFixture;
  let projectId: string;

  beforeAll(async () => {
    fixture = createGitFixture(['main', 'feature/parent', 'release/v1', 'bug/issue-42']);
    const project = await createProject({ cwd: fixture.workCwd });
    projectId = project.id as string;
  });

  afterAll(() => {
    fixture.cleanup();
  });

  it('lists every remote branch and flags the default', async () => {
    const res = await request
      .get(`/api/projects/${projectId}/branches`)
      .query({ refresh: '1' })
      .expect(200);
    const body = res.body as {
      branches: Array<{ name: string; isDefault: boolean }>;
      defaultBranch?: string;
    };
    const names = body.branches.map((b) => b.name).sort();
    expect(names).toEqual(['bug/issue-42', 'feature/parent', 'main', 'release/v1']);
    const defaults = body.branches.filter((b) => b.isDefault).map((b) => b.name);
    expect(defaults).toEqual(['main']);
  });

  it('returns 404 for an unknown project', async () => {
    await request.get('/api/projects/does-not-exist-xyz/branches').expect(404);
  });

  it('returns 400 when the project has no origin remote', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'no-origin-'));
    try {
      execSync(`git init --initial-branch=main ${JSON.stringify(root)}`);
      execSync('git config user.email "t@e.com"', { cwd: root });
      execSync('git config user.name "T"', { cwd: root });
      execSync('git commit --allow-empty -m init', { cwd: root });
      const project = await createProject({ cwd: root });
      const res = await request.get(`/api/projects/${project.id as string}/branches`).expect(400);
      expect(String((res.body as { error: string }).error)).toMatch(/origin/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
