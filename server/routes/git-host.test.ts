/**
 * Integration tests for the git-host lifecycle routes, driving the live
 * Express app via supertest (open-mode auth → Owner). The enable path
 * runs a real `git init --bare` import into the test data dir.
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

let request: supertest.Agent;
let gitHostRepoPath: typeof import('../git-host/repo-store.js').gitHostRepoPath;

beforeAll(async () => {
  request = await getRequest();
  ({ gitHostRepoPath } = await import('../git-host/repo-store.js'));
});

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

async function freshProject(): Promise<string> {
  const id = `git-host-test-${uuidv4().slice(0, 8)}`;
  await request
    .post('/api/projects')
    .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  return id;
}

async function waitForReady(projectId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const res = await request.get(`/api/projects/${projectId}/git-host`).expect(200);
      expect(['ready', 'error']).toContain(res.body.importState?.status);
      expect(res.body.importState?.status).toBe('ready');
    },
    { timeout: 10_000 },
  );
}

describe('git-host lifecycle routes', () => {
  it('404s for unknown projects on all three endpoints', async () => {
    await request.get('/api/projects/nope/git-host').expect(404);
    await request.post('/api/projects/nope/git-host/enable').send({}).expect(404);
    await request.post('/api/projects/nope/git-host/disable').expect(404);
  });

  it('reports disabled status by default', async () => {
    const id = await freshProject();
    const res = await request.get(`/api/projects/${id}/git-host`).expect(200);
    expect(res.body).toMatchObject({ enabled: false, cloneUrl: null, mirror: null });
  });

  it('enable → 202, background import completes, status flips to enabled', async () => {
    const id = await freshProject();
    const res = await request
      .post(`/api/projects/${id}/git-host/enable`)
      .send({ importFrom: 'empty' })
      .expect(202);
    expect(res.body.importState.status).toBe('importing');

    await waitForReady(id);
    const status = await request.get(`/api/projects/${id}/git-host`).expect(200);
    expect(status.body.enabled).toBe(true);
    expect(status.body.cloneUrl).toContain(`/git/${id}.git`);
    expect(status.body.defaultBranch).toBe('main');
  });

  it('enable is rejected when already enabled (409) and importFrom is validated (400)', async () => {
    const id = await freshProject();
    await request
      .post(`/api/projects/${id}/git-host/enable`)
      .send({ importFrom: 'bogus' })
      .expect(400);
    await request.post(`/api/projects/${id}/git-host/enable`).send({ importFrom: 'empty' });
    await waitForReady(id);
    await request.post(`/api/projects/${id}/git-host/enable`).send({}).expect(409);
  });

  it('disable flips back to github (and 409s when not enabled)', async () => {
    const id = await freshProject();
    await request.post(`/api/projects/${id}/git-host/disable`).expect(409);

    await request
      .post(`/api/projects/${id}/git-host/enable`)
      .send({ importFrom: 'empty' })
      .expect(202);
    await waitForReady(id);

    const res = await request.post(`/api/projects/${id}/git-host/disable`).expect(200);
    expect(res.body.enabled).toBe(false);
  });

  it('projects PATCH rejects direct gitHost writes and validates gitMirror', async () => {
    const id = await freshProject();
    await request.patch(`/api/projects/${id}`).send({ gitHost: 'agenthub' }).expect(400);

    await request
      .patch(`/api/projects/${id}`)
      .send({ gitMirror: { refs: 'sideways' } })
      .expect(400);
    await request
      .patch(`/api/projects/${id}`)
      .send({ gitMirror: { enabled: 'yes' } })
      .expect(400);
    await request
      .patch(`/api/projects/${id}`)
      .send({ gitMirror: { enabled: false, refs: 'all' } })
      .expect(200);

    const projects = await request.get('/api/projects').expect(200);
    const project = (projects.body as Array<Record<string, unknown>>).find((p) => p.id === id);
    expect(project?.gitMirror).toEqual({ enabled: false, refs: 'all' });
  });

  it('projects PATCH validates securityScan triggers', async () => {
    const id = await freshProject();
    await request.patch(`/api/projects/${id}`).send({ securityScan: 'on' }).expect(400);
    await request
      .patch(`/api/projects/${id}`)
      .send({ securityScan: { onPush: 'yes' } })
      .expect(400);
    await request
      .patch(`/api/projects/${id}`)
      .send({ securityScan: { schedule: 'hourly' } })
      .expect(400);
    await request
      .patch(`/api/projects/${id}`)
      .send({ securityScan: { onPush: true, schedule: 'weekly' } })
      .expect(200);

    const projects = await request.get('/api/projects').expect(200);
    const project = (projects.body as Array<Record<string, unknown>>).find((p) => p.id === id);
    expect(project?.securityScan).toEqual({ onPush: true, schedule: 'weekly' });

    // null clears it.
    await request.patch(`/api/projects/${id}`).send({ securityScan: null }).expect(200);
    const after = await request.get('/api/projects').expect(200);
    const cleared = (after.body as Array<Record<string, unknown>>).find((p) => p.id === id);
    expect(cleared?.securityScan).toBeUndefined();
  });
});

describe('git-host repository browsing routes', () => {
  /** Enable hosting for a fresh project, then push main + a feature branch. */
  async function hostedProjectWithHistory(): Promise<{ id: string; shas: string[] }> {
    const id = await freshProject();
    await request
      .post(`/api/projects/${id}/git-host/enable`)
      .send({ importFrom: 'empty' })
      .expect(202);
    await waitForReady(id);

    const bare = gitHostRepoPath(id);
    const work = path.join(os.tmpdir(), `git-host-browse-${uuidv4().slice(0, 8)}`);
    mkdirSync(work, { recursive: true });
    execSync('git init --initial-branch=main', { cwd: work, stdio: 'pipe' });
    git(work, 'config user.email "t@example.com"');
    git(work, 'config user.name "Tester"');
    const shas: string[] = [];
    for (const n of ['one', 'two']) {
      writeFileSync(path.join(work, `${n}.txt`), `${n}\n`);
      git(work, `add ${n}.txt`);
      git(work, `commit -m "commit ${n}"`);
      shas.push(git(work, 'rev-parse HEAD'));
    }
    git(work, `remote add origin "${bare}"`);
    git(work, 'push -u origin main');
    git(work, 'checkout -b agent-hub/dev/session-beef0001');
    writeFileSync(path.join(work, 'three.txt'), 'three\n');
    git(work, 'add three.txt');
    git(work, 'commit -m "commit three"');
    shas.push(git(work, 'rev-parse HEAD'));
    git(work, 'push -u origin agent-hub/dev/session-beef0001');
    return { id, shas };
  }

  it('404s for non-hosted projects', async () => {
    const id = await freshProject();
    await request.get(`/api/projects/${id}/git-host/branches`).expect(404);
    await request.get(`/api/projects/${id}/git-host/commits`).expect(404);
    await request.get(`/api/projects/${id}/git-host/commits/abc1234`).expect(404);
  });

  it('mirror status + reconcile: 404 for non-hosted, wired for hosted', async () => {
    const nonHosted = await freshProject();
    await request.get(`/api/projects/${nonHosted}/git-host/mirror`).expect(404);
    await request.post(`/api/projects/${nonHosted}/git-host/mirror/reconcile`).expect(404);

    const id = await freshProject();
    await request
      .post(`/api/projects/${id}/git-host/enable`)
      .send({ importFrom: 'empty' })
      .expect(202);
    await waitForReady(id);

    const status = await request.get(`/api/projects/${id}/git-host/mirror`).expect(200);
    expect(status.body).toHaveProperty('enabled');
    expect(status.body).toHaveProperty('refs');
    expect(status.body).toHaveProperty('state');

    // No repoUrl on this project → mirror policy disabled → reconcile no-ops.
    const rec = await request.post(`/api/projects/${id}/git-host/mirror/reconcile`).expect(200);
    expect(rec.body.action).toBe('skipped');
    expect(rec.body).toHaveProperty('state');
  });

  it('lists branches with default flag and ahead/behind counts', async () => {
    const { id } = await hostedProjectWithHistory();
    const res = await request.get(`/api/projects/${id}/git-host/branches`).expect(200);
    expect(res.body.defaultBranch).toBe('main');
    const byName = Object.fromEntries(
      (res.body.branches as Array<Record<string, unknown>>).map((b) => [b.name, b]),
    );
    expect(byName['main']).toMatchObject({ isDefault: true, ahead: 0, behind: 0 });
    expect(byName['agent-hub/dev/session-beef0001']).toMatchObject({
      isDefault: false,
      ahead: 1,
      behind: 0,
      subject: 'commit three',
      author: 'Tester',
    });
  });

  it('lists commits (default branch + explicit branch) and validates branch names', async () => {
    const { id, shas } = await hostedProjectWithHistory();

    const main = await request.get(`/api/projects/${id}/git-host/commits`).expect(200);
    expect(main.body.branch).toBe('main');
    expect(main.body.commits.map((c: { subject: string }) => c.subject)).toEqual([
      'commit two',
      'commit one',
    ]);
    expect(main.body.commits[0].sha).toBe(shas[1]);

    const feature = await request
      .get(`/api/projects/${id}/git-host/commits`)
      .query({ branch: 'agent-hub/dev/session-beef0001', limit: 1 })
      .expect(200);
    expect(feature.body.commits).toHaveLength(1);
    expect(feature.body.commits[0].subject).toBe('commit three');

    await request
      .get(`/api/projects/${id}/git-host/commits`)
      .query({ branch: '--upload-pack=evil' })
      .expect(400);
    await request
      .get(`/api/projects/${id}/git-host/commits`)
      .query({ branch: 'no-such-branch' })
      .expect(404);
  });

  it('returns commit detail with stat + patch; 404s unknown shas', async () => {
    const { id, shas } = await hostedProjectWithHistory();
    const res = await request.get(`/api/projects/${id}/git-host/commits/${shas[1]}`).expect(200);
    expect(res.body).toMatchObject({
      sha: shas[1],
      subject: 'commit two',
      author: 'Tester',
      patchTruncated: false,
    });
    expect(res.body.parents).toEqual([shas[0]]);
    expect(res.body.stat).toContain('two.txt');
    expect(res.body.patch).toContain('+two');

    await request.get(`/api/projects/${id}/git-host/commits/${'0'.repeat(40)}`).expect(404);
    await request.get(`/api/projects/${id}/git-host/commits/not-a-sha`).expect(404);
  });

  /** Hosted project whose main has a README.md and a branch with a plain README. */
  async function hostedProjectWithReadme(): Promise<string> {
    const id = await freshProject();
    await request
      .post(`/api/projects/${id}/git-host/enable`)
      .send({ importFrom: 'empty' })
      .expect(202);
    await waitForReady(id);

    const bare = gitHostRepoPath(id);
    const work = path.join(os.tmpdir(), `git-host-readme-${uuidv4().slice(0, 8)}`);
    mkdirSync(work, { recursive: true });
    execSync('git init --initial-branch=main', { cwd: work, stdio: 'pipe' });
    git(work, 'config user.email "t@example.com"');
    git(work, 'config user.name "Tester"');
    writeFileSync(path.join(work, 'README.md'), '# Hello Repo\n\nRendered overview.\n');
    writeFileSync(path.join(work, 'noise.txt'), 'noise\n');
    git(work, 'add -A');
    git(work, 'commit -m "add readme"');
    git(work, `remote add origin "${bare}"`);
    git(work, 'push -u origin main');

    git(work, 'checkout -b docs/plain');
    writeFileSync(path.join(work, 'README'), 'plain text readme\n');
    git(work, 'rm --quiet README.md');
    git(work, 'add -A');
    git(work, 'commit -m "plain readme"');
    git(work, 'push -u origin docs/plain');
    return id;
  }

  it('returns the default-branch README content and path', async () => {
    const id = await hostedProjectWithReadme();
    const res = await request.get(`/api/projects/${id}/git-host/readme`).expect(200);
    expect(res.body.readme).toMatchObject({
      branch: 'main',
      path: 'README.md',
      truncated: false,
    });
    expect(res.body.readme.content).toContain('# Hello Repo');
  });

  it('reads the README of an explicit branch and validates the branch name', async () => {
    const id = await hostedProjectWithReadme();
    const res = await request
      .get(`/api/projects/${id}/git-host/readme`)
      .query({ branch: 'docs/plain' })
      .expect(200);
    expect(res.body.readme).toMatchObject({ branch: 'docs/plain', path: 'README' });
    expect(res.body.readme.content).toContain('plain text readme');

    await request
      .get(`/api/projects/${id}/git-host/readme`)
      .query({ branch: '--upload-pack=evil' })
      .expect(400);
  });

  it('returns { readme: null } when the branch has no root README', async () => {
    const { id } = await hostedProjectWithHistory();
    const res = await request.get(`/api/projects/${id}/git-host/readme`).expect(200);
    expect(res.body).toEqual({ readme: null });
  });

  it('404s the readme endpoint for non-hosted projects', async () => {
    const id = await freshProject();
    await request.get(`/api/projects/${id}/git-host/readme`).expect(404);
  });

  it('truncates an oversized README by bytes and flags truncated', async () => {
    const id = await freshProject();
    await request
      .post(`/api/projects/${id}/git-host/enable`)
      .send({ importFrom: 'empty' })
      .expect(202);
    await waitForReady(id);

    const bare = gitHostRepoPath(id);
    const work = path.join(os.tmpdir(), `git-host-bigreadme-${uuidv4().slice(0, 8)}`);
    mkdirSync(work, { recursive: true });
    execSync('git init --initial-branch=main', { cwd: work, stdio: 'pipe' });
    git(work, 'config user.email "t@example.com"');
    git(work, 'config user.name "Tester"');
    // Comfortably larger than the 512 KiB server cap.
    writeFileSync(path.join(work, 'README.md'), '# Big\n'.concat('x'.repeat(700 * 1024)));
    git(work, 'add README.md');
    git(work, 'commit -m "big readme"');
    git(work, `remote add origin "${bare}"`);
    git(work, 'push -u origin main');

    const res = await request.get(`/api/projects/${id}/git-host/readme`).expect(200);
    expect(res.body.readme.truncated).toBe(true);
    expect(res.body.readme.path).toBe('README.md');
    expect(res.body.readme.content).toContain('# Big');
    expect(res.body.readme.content).toContain('README truncated');
    // Capped near 512 KiB (+ the short marker), nowhere near the 700 KiB source.
    expect(Buffer.byteLength(res.body.readme.content, 'utf8')).toBeLessThan(520 * 1024);
  });
});
