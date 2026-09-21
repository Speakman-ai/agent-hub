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
import { validateGitHostMediaToken } from '../git-host-media-mount.js';

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
    expect(typeof res.body.readme.mediaToken).toBe('string');
    expect(validateGitHostMediaToken(id, 'main', res.body.readme.mediaToken)).toBe(true);
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

  it('lists the root tree with last-commit metadata and commit count', async () => {
    const { id, shas } = await hostedProjectWithHistory();
    const res = await request.get(`/api/projects/${id}/git-host/tree`).expect(200);
    expect(res.body.branch).toBe('main');
    expect(res.body.path).toBe('');
    expect(res.body.commitCount).toBe(2);
    expect(res.body.latestCommit.sha).toBe(shas[1]);
    expect(res.body.latestCommit.subject).toBe('commit two');
    const names = (res.body.entries as Array<{ name: string; type: string }>).map((e) => e.name);
    expect(names).toEqual(['one.txt', 'two.txt']);
    const two = res.body.entries.find((e: { name: string }) => e.name === 'two.txt');
    expect(two.lastCommit.subject).toBe('commit two');
    const one = res.body.entries.find((e: { name: string }) => e.name === 'one.txt');
    expect(one.lastCommit.subject).toBe('commit one');
  });

  it('lists a subdirectory, reads a file blob, and indexes paths', async () => {
    const id = await freshProject();
    await request
      .post(`/api/projects/${id}/git-host/enable`)
      .send({ importFrom: 'empty' })
      .expect(202);
    await waitForReady(id);

    const bare = gitHostRepoPath(id);
    const work = path.join(os.tmpdir(), `git-host-tree-${uuidv4().slice(0, 8)}`);
    mkdirSync(work, { recursive: true });
    mkdirSync(path.join(work, 'src'), { recursive: true });
    execSync('git init --initial-branch=main', { cwd: work, stdio: 'pipe' });
    git(work, 'config user.email "t@example.com"');
    git(work, 'config user.name "Tester"');
    writeFileSync(path.join(work, 'README.md'), '# Hello\n');
    writeFileSync(path.join(work, 'src', 'app.ts'), 'export const n = 1;\n');
    git(work, 'add -A');
    git(work, 'commit -m "add src"');
    git(work, `remote add origin "${bare}"`);
    git(work, 'push -u origin main');

    const root = await request.get(`/api/projects/${id}/git-host/tree`).expect(200);
    expect(root.body.entries.map((e: { name: string }) => e.name)).toEqual(['src', 'README.md']);
    expect(root.body.entries[0].type).toBe('tree');

    const nested = await request
      .get(`/api/projects/${id}/git-host/tree`)
      .query({ path: 'src' })
      .expect(200);
    expect(nested.body.path).toBe('src');
    expect(nested.body.entries).toHaveLength(1);
    expect(nested.body.entries[0]).toMatchObject({
      name: 'app.ts',
      type: 'blob',
      path: 'src/app.ts',
    });

    const file = await request
      .get(`/api/projects/${id}/git-host/file`)
      .query({ path: 'src/app.ts' })
      .expect(200);
    expect(file.body).toMatchObject({
      path: 'src/app.ts',
      binary: false,
      truncated: false,
      content: 'export const n = 1;\n',
    });
    expect(file.body.size).toBeGreaterThan(0);
    // Markdown blobs resolve repo-relative images through the media mount, so
    // the blob payload must carry the same authorization the README does.
    expect(typeof file.body.mediaToken).toBe('string');
    expect(validateGitHostMediaToken(id, 'main', file.body.mediaToken)).toBe(true);
    // Scoped to this project+branch, not a bearer for anything else.
    expect(validateGitHostMediaToken(id, 'other-branch', file.body.mediaToken)).toBe(false);
    expect(validateGitHostMediaToken('other-project', 'main', file.body.mediaToken)).toBe(false);

    const paths = await request.get(`/api/projects/${id}/git-host/paths`).expect(200);
    expect(paths.body.paths).toEqual(['README.md', 'src/app.ts']);

    await request.get(`/api/projects/${id}/git-host/file`).expect(400);
    await request
      .get(`/api/projects/${id}/git-host/file`)
      .query({ path: '../etc/passwd' })
      .expect(400);
    await request
      .get(`/api/projects/${id}/git-host/file`)
      .query({ path: 'missing.ts' })
      .expect(404);
    await request.get(`/api/projects/${id}/git-host/tree`).query({ path: 'nope' }).expect(404);
  });

  it('404s tree/file/paths for non-hosted projects', async () => {
    const id = await freshProject();
    await request.get(`/api/projects/${id}/git-host/tree`).expect(404);
    await request.get(`/api/projects/${id}/git-host/file`).query({ path: 'a.ts' }).expect(404);
    await request.get(`/api/projects/${id}/git-host/paths`).expect(404);
  });

  it('returns unicode and space-padded filenames byte-exactly through tree, paths, and file', async () => {
    const id = await freshProject();
    await request
      .post(`/api/projects/${id}/git-host/enable`)
      .send({ importFrom: 'empty' })
      .expect(202);
    await waitForReady(id);

    const bare = gitHostRepoPath(id);
    const work = path.join(os.tmpdir(), `git-host-unicode-${uuidv4().slice(0, 8)}`);
    mkdirSync(path.join(work, 'dossier'), { recursive: true });
    execSync('git init --initial-branch=main', { cwd: work, stdio: 'pipe' });
    git(work, 'config user.email "t@example.com"');
    git(work, 'config user.name "Tester"');
    // git quotes these by default (`"caf\303\251.txt"`), which is exactly the
    // shape that used to escape into the API and then 404 when opened.
    const unicodeName = 'café.txt';
    const spacedName = ' plain.txt';
    const nestedName = 'dossier/naïve.md';
    writeFileSync(path.join(work, unicodeName), 'unicode body\n');
    writeFileSync(path.join(work, spacedName), 'spaced body\n');
    writeFileSync(path.join(work, nestedName), 'nested body\n');
    git(work, 'add -A');
    git(work, 'commit -m "unicode fixtures"');
    git(work, `remote add origin "${bare}"`);
    git(work, 'push -u origin main');

    const root = await request.get(`/api/projects/${id}/git-host/tree`).expect(200);
    const names = root.body.entries.map((e: { name: string }) => e.name);
    expect(names).toContain(unicodeName);
    expect(names).toContain(spacedName);
    expect(names.some((n: string) => n.includes('\\303'))).toBe(false);
    expect(names.some((n: string) => n.startsWith('"'))).toBe(false);
    // Every entry carries the commit that introduced it — the last-commit
    // matcher has to see the same unquoted name the tree does.
    for (const entry of root.body.entries) {
      expect(entry.lastCommit?.subject).toBe('unicode fixtures');
    }

    const paths = await request.get(`/api/projects/${id}/git-host/paths`).expect(200);
    expect(paths.body.paths).toEqual(expect.arrayContaining([unicodeName, spacedName, nestedName]));

    // The names the tree/paths APIs hand out must round-trip back as blobs.
    for (const [name, body] of [
      [unicodeName, 'unicode body\n'],
      [spacedName, 'spaced body\n'],
      [nestedName, 'nested body\n'],
    ] as const) {
      const file = await request
        .get(`/api/projects/${id}/git-host/file`)
        .query({ path: name })
        .expect(200);
      expect(file.body).toMatchObject({ path: name, binary: false, content: body });
    }
  });

  it('lists submodules as gitlink entries and keeps them out of Go to file', async () => {
    const id = await freshProject();
    await request
      .post(`/api/projects/${id}/git-host/enable`)
      .send({ importFrom: 'empty' })
      .expect(202);
    await waitForReady(id);

    const bare = gitHostRepoPath(id);
    const root = path.join(os.tmpdir(), `git-host-submodule-${uuidv4().slice(0, 8)}`);
    const upstream = path.join(root, 'upstream');
    const work = path.join(root, 'work');
    mkdirSync(upstream, { recursive: true });
    mkdirSync(work, { recursive: true });

    // A real repository to embed as a submodule.
    execSync('git init --initial-branch=main', { cwd: upstream, stdio: 'pipe' });
    git(upstream, 'config user.email "t@example.com"');
    git(upstream, 'config user.name "Tester"');
    writeFileSync(path.join(upstream, 'lib.ts'), 'export const x = 1;\n');
    git(upstream, 'add -A');
    git(upstream, 'commit -m "upstream"');

    execSync('git init --initial-branch=main', { cwd: work, stdio: 'pipe' });
    git(work, 'config user.email "t@example.com"');
    git(work, 'config user.name "Tester"');
    writeFileSync(path.join(work, 'root.txt'), 'root\n');
    git(work, 'add -A');
    git(work, 'commit -m "root"');
    // `vendor/` ends up containing ONLY the submodule, which is the case that
    // used to render as an empty directory.
    git(work, `-c protocol.file.allow=always submodule add "${upstream}" vendor/dep`);
    git(work, 'commit -m "add submodule"');
    git(work, `remote add origin "${bare}"`);
    git(work, 'push -u origin main');

    const vendor = await request
      .get(`/api/projects/${id}/git-host/tree`)
      .query({ path: 'vendor' })
      .expect(200);
    expect(vendor.body.entries).toHaveLength(1);
    expect(vendor.body.entries[0]).toMatchObject({
      name: 'dep',
      path: 'vendor/dep',
      type: 'commit',
      mode: '160000',
    });

    // Go to file offers blobs only: a gitlink path is not readable and would
    // 404 the moment the user selected it.
    const paths = await request.get(`/api/projects/${id}/git-host/paths`).expect(200);
    expect(paths.body.paths).toContain('root.txt');
    expect(paths.body.paths).toContain('.gitmodules');
    expect(paths.body.paths).not.toContain('vendor/dep');
    await request
      .get(`/api/projects/${id}/git-host/file`)
      .query({ path: 'vendor/dep' })
      .expect(404);
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
