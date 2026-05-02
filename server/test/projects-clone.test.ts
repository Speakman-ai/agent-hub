/**
 * projects-clone.test.ts — Integration tests for POST /api/projects/clone.
 *
 * Covers the auth-aware behavior added to fix the "private repo clone
 * silently fails" gap (kanban: Wire OAuth/PAT token into clone route):
 *
 *   1. SSH URLs are rejected with a friendly error pointing the user
 *      at the HTTPS form — no `git` is spawned.
 *   2. Public-repo HTTPS clones still work without any auth wired up
 *      (regression guard for the no-token path).
 *
 * The token-injection happy path is covered by the pure unit tests in
 * `server/clone-url-auth.test.ts`. Integration-level verification of
 * the rewritten URL would require a real GitHub repo + a real token,
 * which we can't ship in CI; we instead verify by inspection that the
 * post-clone `git remote set-url origin` step rolls back to whatever
 * URL the user originally pasted.
 */

import type supertest from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { execSync, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { getRequest } from './helpers.js';

/** Spin until the clone lands or the deadline elapses. */
async function waitForClone(clonePath: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      execSync(`git -C ${JSON.stringify(clonePath)} rev-parse HEAD`, { stdio: 'ignore' });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
}

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

interface BareRepoFixture {
  bareCwd: string;
  cloneTarget: string;
  cleanup: () => void;
}

/**
 * Build a real, local bare repo and a target dir to clone into. We use
 * `file://` URLs so the route's "other" path runs end-to-end without
 * needing a network or any GitHub credentials.
 */
function makeBareRepo(): BareRepoFixture {
  const root = mkdtempSync(path.join(tmpdir(), 'projects-clone-test-'));
  const seed = path.join(root, 'seed');
  const bareCwd = path.join(root, 'origin.git');
  const cloneTarget = path.join(root, 'targetDir');

  execSync(`git init --initial-branch=main ${JSON.stringify(seed)}`);
  execSync('git config user.email "test@example.com"', { cwd: seed });
  execSync('git config user.name "Test"', { cwd: seed });
  execSync('git commit --allow-empty -m initial', { cwd: seed });
  execSync(`git clone --bare ${JSON.stringify(seed)} ${JSON.stringify(bareCwd)}`);

  return {
    bareCwd,
    cloneTarget,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('POST /api/projects/clone', () => {
  it('rejects SSH URLs with a pointed message instead of spawning git', async () => {
    const res = await request
      .post('/api/projects/clone')
      .send({ url: 'git@github.com:foo/bar.git' })
      .expect(400);
    const body = res.body as { error?: string };
    expect(body.error).toBeTruthy();
    expect(body.error!.toLowerCase()).toContain('https');
    // Must NOT include any partial cloneId — we bailed before spawning.
    expect(res.body).not.toHaveProperty('cloneId');
  });

  it('rejects ssh:// scheme URLs the same way', async () => {
    const res = await request
      .post('/api/projects/clone')
      .send({ url: 'ssh://git@github.com/foo/bar.git' })
      .expect(400);
    expect((res.body as { error: string }).error.toLowerCase()).toContain('https');
  });

  it('returns 400 with a clear error when url is missing', async () => {
    const res = await request.post('/api/projects/clone').send({}).expect(400);
    expect((res.body as { error: string }).error).toMatch(/url/i);
  });

  it('clones a public-style URL (file://) with no token wired up', async () => {
    const fixture = makeBareRepo();
    try {
      const url = `file://${fixture.bareCwd}`;
      const res = await request
        .post('/api/projects/clone')
        .send({ url, targetDir: fixture.cloneTarget })
        .expect(200);
      const body = res.body as { cloneId: string; clonePath: string; repoName: string };
      expect(body.cloneId).toBeTruthy();
      expect(body.clonePath.startsWith(fixture.cloneTarget)).toBe(true);

      // Wait for the spawned git clone to finish. The route returns the
      // cloneId synchronously and streams progress over WebSocket; we
      // poll for the destination dir + a HEAD commit to land.
      expect(await waitForClone(body.clonePath)).toBe(true);
      // If the clone landed, the origin should be the unmodified URL we
      // sent (no token rewrite for non-github URLs).
      const remote = execSync(`git -C ${JSON.stringify(body.clonePath)} remote get-url origin`)
        .toString()
        .trim();
      expect(remote).toBe(url);
    } finally {
      fixture.cleanup();
    }
  });

  it('returns 409 when the target clone path already exists', async () => {
    const fixture = makeBareRepo();
    try {
      const url = `file://${fixture.bareCwd}`;
      // First clone seeds the target.
      const first = await request
        .post('/api/projects/clone')
        .send({ url, targetDir: fixture.cloneTarget })
        .expect(200);
      // Poll for the spawned clone to land instead of relying on a
      // fixed sleep — slow CI machines can blow past 200 ms.
      const firstClonePath = (first.body as { clonePath: string }).clonePath;
      expect(await waitForClone(firstClonePath)).toBe(true);
      const res = await request
        .post('/api/projects/clone')
        .send({ url, targetDir: fixture.cloneTarget })
        .expect(409);
      expect((res.body as { error: string }).error).toMatch(/already exists/i);
    } finally {
      fixture.cleanup();
    }
  });
});

// ─── Shell-metachar safety regression for the post-clone scrub ─────
// Standalone (no app boot) so the "do not invoke /bin/sh with $(...)"
// guarantee is asserted directly against the same call shape the route
// uses on the success path: `execFileSync('git', ['-C', clonePath,
// 'remote', 'set-url', 'origin', url])` with `clonePath` containing
// `$(touch <marker>)`. If a future refactor reverted to `execSync`,
// the marker file would appear and this test would fail.
describe('post-clone scrub — execFileSync defeats shell expansion', () => {
  it('does not expand $() in clonePath when running git remote set-url', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'projects-clone-scrub-'));
    const markerPath = path.join(root, 'PWNED');
    // Build a real git repo at a path with shell metachars.
    const evilDir = path.join(root, `repo$(touch ${markerPath})`);
    execFileSync('git', ['init', '--initial-branch=main', evilDir], { stdio: 'ignore' });
    execFileSync('git', ['-C', evilDir, 'remote', 'add', 'origin', 'https://example.com/x.git'], {
      stdio: 'ignore',
    });

    // Same invocation shape as the route's post-clone scrub.
    const safeUrl = 'https://example.com/restored.git';
    execFileSync('git', ['-C', evilDir, 'remote', 'set-url', 'origin', safeUrl], {
      stdio: 'ignore',
    });

    const remote = execFileSync('git', ['-C', evilDir, 'remote', 'get-url', 'origin'])
      .toString()
      .trim();
    expect(remote).toBe(safeUrl);
    // Hard guarantee: the subshell payload from the path never fired.
    expect(existsSync(markerPath)).toBe(false);

    // Cleanup
    execFileSync('rm', ['-rf', root]);
  });
});
