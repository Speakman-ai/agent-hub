import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createSession } from './helpers.js';
import { getDb } from '../db.js';
import { routeDeps } from '../index.js';
import { fakeEnvOwnedIo } from './fake-worktree-io.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/sessions/:id/changes', () => {
  it('returns 404 for an unknown session', async () => {
    await request.get('/api/sessions/does-not-exist/changes').expect(404);
  });

  it('returns an empty change set for a session with no worktree', async () => {
    const session = await createSession();
    const res = await request.get(`/api/sessions/${session.id}/changes`).expect(200);
    expect(res.body).toMatchObject({
      baseSha: null,
      headSha: null,
      dirty: false,
      files: [],
      truncated: false,
    });
    expect(Array.isArray(res.body.files)).toBe(true);
  });
});

describe('GET /api/sessions/:id/changes/diff', () => {
  it('returns 404 for an unknown session', async () => {
    await request.get('/api/sessions/nope/changes/diff?file=x.ts').expect(404);
  });

  it('requires a file query parameter', async () => {
    const session = await createSession();
    await request.get(`/api/sessions/${session.id}/changes/diff`).expect(400);
  });

  it('returns 404 when the session has no worktree', async () => {
    const session = await createSession();
    await request.get(`/api/sessions/${session.id}/changes/diff?file=x.ts`).expect(404);
  });
});

/**
 * A microVM session's worktree exists only inside the guest, and the recorded
 * `worktree_path` is the tree the VM booted from. Before the seam these routes
 * ran git on that path and rendered an empty pane for a session full of work.
 * The path below deliberately does not exist on disk, so any regression back
 * to host git surfaces as an error or an empty file list rather than passing.
 */
describe('Changes pane for an env-owned (microVM) worktree', () => {
  const NUL = '\0';

  async function sessionWithGuestWorktree() {
    const session = await createSession();
    getDb()
      .prepare('UPDATE sessions SET worktree_path = ?, worktree_branch = ? WHERE id = ?')
      .run('/nonexistent/host/seed', 'agent-hub/dev/session-x', session.id);
    return session;
  }

  it('builds the summary from the guest worktree, not the host seed', async () => {
    const session = await sessionWithGuestWorktree();
    vi.spyOn(routeDeps, 'getSessionWorktreeIo').mockResolvedValue(
      fakeEnvOwnedIo({
        git: (args) => {
          if (args[0] === 'status') return { stdout: ' M src/a.ts\n' };
          if (args.includes('--name-status')) return { stdout: `M${NUL}src/a.ts${NUL}` };
          if (args.includes('--numstat')) return { stdout: `4\t2\tsrc/a.ts${NUL}` };
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: 'guesthead\n' };
          if (args.includes('--abbrev-ref')) return { stdout: 'feature/in-vm\n' };
          return { stdout: '' };
        },
      }),
    );

    const res = await request.get(`/api/sessions/${session.id}/changes`).expect(200);

    expect(res.body.headSha).toBe('guesthead');
    expect(res.body.branch).toBe('feature/in-vm');
    expect(res.body.dirty).toBe(true);
    expect(res.body.files).toEqual([
      expect.objectContaining({ path: 'src/a.ts', additions: 4, deletions: 2 }),
    ]);
  });

  it('serves a per-file diff from the guest worktree', async () => {
    const session = await sessionWithGuestWorktree();
    const patch = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
    vi.spyOn(routeDeps, 'getSessionWorktreeIo').mockResolvedValue(
      fakeEnvOwnedIo({
        git: (args) => {
          if (args.includes('--name-status')) return { stdout: `M${NUL}src/a.ts${NUL}` };
          if (args[0] === 'diff') return { stdout: patch };
          if (args[0] === 'rev-parse') return { stdout: 'basesha\n' };
          if (args[0] === 'merge-base') return { stdout: 'mergebase\n' };
          return { stdout: '' };
        },
      }),
    );

    const res = await request
      .get(`/api/sessions/${session.id}/changes/diff?file=src/a.ts`)
      .expect(200);

    expect(res.body.path).toBe('src/a.ts');
    expect(res.body.unifiedDiff).toBe(patch);
  });

  it('still refuses a path that escapes the worktree', async () => {
    const session = await sessionWithGuestWorktree();
    const io = fakeEnvOwnedIo();
    vi.spyOn(routeDeps, 'getSessionWorktreeIo').mockResolvedValue(io);

    await request
      .get(
        `/api/sessions/${session.id}/changes/diff?file=${encodeURIComponent('../../etc/passwd')}`,
      )
      .expect(400);
    // Rejected at the boundary, before git was consulted at all.
    expect(io.gitCalls).toHaveLength(0);
  });
});
