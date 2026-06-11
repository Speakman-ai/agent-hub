/**
 * Native-PR branches in routes/pr-list.ts and routes/pr-actions.ts —
 * drives the live Express app (supertest, open-mode auth). Hosted repos
 * are seeded via the real git-host enable flow; PRs via routeDeps.nativePr
 * (the same in-process service Finalize uses).
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { getRequest } from '../test/helpers.js';
import type { Project } from '../types.js';

let request: supertest.Agent;
let routeDeps: typeof import('../index.js').routeDeps;
let gitHostRepoPath: typeof import('../git-host/repo-store.js').gitHostRepoPath;
let findProject: (id: string) => Project | null;

beforeAll(async () => {
  request = await getRequest();
  ({ routeDeps } = await import('../index.js'));
  ({ gitHostRepoPath } = await import('../git-host/repo-store.js'));
  findProject = routeDeps.findProject;
});

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

/** Create a hosted project with main + one feature branch and an open PR. */
async function seedHostedProjectWithPr(): Promise<{
  projectId: string;
  branch: string;
  prUrl: string;
  bare: string;
}> {
  const projectId = `npr-route-${uuidv4().slice(0, 8)}`;
  await request
    .post('/api/projects')
    .send({ id: projectId, name: projectId, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  await request
    .post(`/api/projects/${projectId}/git-host/enable`)
    .send({ importFrom: 'empty' })
    .expect(202);
  await vi.waitFor(
    async () => {
      const res = await request.get(`/api/projects/${projectId}/git-host`).expect(200);
      expect(res.body.importState?.status).toBe('ready');
    },
    { timeout: 10_000 },
  );

  const bare = gitHostRepoPath(projectId);
  const work = path.join(os.tmpdir(), `npr-route-work-${uuidv4().slice(0, 8)}`);
  mkdirSync(work, { recursive: true });
  execSync('git init --initial-branch=main', { cwd: work, stdio: 'pipe' });
  git(work, 'config user.email "t@example.com"');
  git(work, 'config user.name "T"');
  writeFileSync(path.join(work, 'base.txt'), 'base\n');
  git(work, 'add base.txt');
  git(work, 'commit -m initial');
  git(work, `remote add origin "${bare}"`);
  git(work, 'push -u origin main');
  const branch = 'agent-hub/dev/session-aaaa1111';
  git(work, `checkout -b ${branch}`);
  writeFileSync(path.join(work, 'feat.txt'), 'feature\n');
  git(work, 'add feat.txt');
  git(work, 'commit -m "add feat"');
  git(work, `push -u origin ${branch}`);
  const headSha = git(work, 'rev-parse HEAD');

  const project = findProject(projectId)!;
  const { prUrl } = routeDeps.nativePr!.createOrGetOpenPr({
    project,
    headBranch: branch,
    baseBranch: 'main',
    headSha,
    title: 'Add feat',
    body: 'Adds feat.txt',
    author: 'finalize',
  });
  return { projectId, branch, prUrl, bare };
}

describe('native PR route branches', () => {
  it('GET /api/projects/:id/pulls lists native PRs without GitHub config', async () => {
    const { projectId, branch, prUrl } = await seedHostedProjectWithPr();
    const res = await request.get(`/api/projects/${projectId}/pulls`).expect(200);
    expect(res.body.source).toBe('agenthub');
    expect(res.body.pulls).toHaveLength(1);
    expect(res.body.pulls[0]).toMatchObject({
      number: 1,
      title: 'Add feat',
      state: 'open',
      html_url: prUrl,
      head: branch,
      base: 'main',
    });
  });

  it('GET /api/projects/:id/pulls/:number returns native detail with mergeability + commits', async () => {
    const { projectId } = await seedHostedProjectWithPr();
    const res = await request.get(`/api/projects/${projectId}/pulls/1`).expect(200);
    expect(res.body.source).toBe('agenthub');
    expect(res.body.pr).toMatchObject({ number: 1, mergeable: true, changed_files: 1 });
    expect(res.body.reviews).toEqual([]);
    expect(res.body.commits[0]).toMatchObject({ subject: 'add feat' });

    await request.get(`/api/projects/${projectId}/pulls/42`).expect(404);
  });

  it('GET /api/pr/diff and /api/pr/files serve from the bare repo via native prUrl', async () => {
    const { prUrl } = await seedHostedProjectWithPr();
    const diff = await request.get('/api/pr/diff').query({ prUrl }).expect(200);
    expect(diff.headers['x-pr-source']).toBe('agenthub');
    expect(diff.text).toContain('feat.txt');

    const files = await request.get('/api/pr/files').query({ prUrl }).expect(200);
    expect(files.body.files[0]).toMatchObject({ filename: 'feat.txt', status: 'added' });

    const status = await request.get('/api/pr/status').query({ prUrl }).expect(200);
    expect(status.body).toMatchObject({ state: 'open', mergeable: true, base: 'main' });
  });

  it('POST /api/pr/merge merges in the bare repo; rebase method is rejected', async () => {
    const { projectId, prUrl, bare } = await seedHostedProjectWithPr();

    await request.post('/api/pr/merge').send({ prUrl, mergeMethod: 'rebase' }).expect(400);

    const mainBefore = git(bare, 'rev-parse refs/heads/main');
    const res = await request.post('/api/pr/merge').send({ prUrl }).expect(200);
    expect(res.body).toMatchObject({ ok: true, method: 'agenthub', pr: '1' });
    expect(git(bare, 'rev-parse refs/heads/main')).not.toBe(mainBefore);

    const list = await request
      .get(`/api/projects/${projectId}/pulls`)
      .query({ state: 'closed' })
      .expect(200);
    expect(list.body.pulls[0]).toMatchObject({ number: 1, state: 'closed', merged: true });

    // Second merge attempt → 409 (no longer open).
    await request.post('/api/pr/merge').send({ prUrl }).expect(409);
  });

  it('POST /api/pr/close closes a native PR', async () => {
    const { prUrl } = await seedHostedProjectWithPr();
    const res = await request.post('/api/pr/close').send({ prUrl }).expect(200);
    expect(res.body).toMatchObject({ ok: true, method: 'agenthub' });
    await request.post('/api/pr/close').send({ prUrl }).expect(409);
  });

  it('GitHub prUrls still take the GitHub path (401 without a connection)', async () => {
    await request
      .post('/api/pr/merge')
      .send({ prUrl: 'https://github.com/owner/repo/pull/5' })
      .expect(401);
  });
});
