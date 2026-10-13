import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  PR_ENVIRONMENT_COMMENTS_SCHEMA,
  announcePrEnvironmentReady,
  githubPrCommentPoster,
  nativePrCommentPoster,
  prCommentPosterFor,
  prEnvironmentCommentBody,
} from './pr-environment-comment.js';

function setup(prStatus = 'open') {
  const db = new Database(':memory:');
  db.exec(PR_ENVIRONMENT_COMMENTS_SCHEMA);
  db.exec(`
    CREATE TABLE pull_requests (project_id TEXT, number INTEGER, status TEXT);
    CREATE TABLE pull_request_reviews (
      id TEXT PRIMARY KEY, project_id TEXT, pr_number INTEGER, reviewer TEXT,
      state TEXT, body TEXT, created_at INTEGER
    );
  `);
  db.prepare('INSERT INTO pull_requests VALUES (?, ?, ?)').run('demo', 7, prStatus);
  const broadcast = vi.fn();
  const poster = nativePrCommentPoster({
    db,
    projectId: 'demo',
    prNumber: 7,
    now: () => 5,
    broadcast,
  });
  const reviews = () =>
    db.prepare('SELECT reviewer, state, body FROM pull_request_reviews').all() as Array<{
      reviewer: string;
      state: string;
      body: string;
    }>;
  return { db, poster, broadcast, reviews };
}

const URL = 'https://pr-7--demo.preview.example.com/';
const env = (sha: string, readyAt: string) => ({
  projectId: 'demo',
  source: 'native' as const,
  prNumber: 7,
  headSha: sha,
  readyAt,
});

describe('PR environment comment', () => {
  it('posts one comment on first ready and edits it on rebuild', async () => {
    const { db, poster, broadcast, reviews } = setup();
    const first = env('a'.repeat(40), '2026-10-13T01:00:00.000Z');
    expect(await announcePrEnvironmentReady(db, first, URL, poster)).toBe('created');
    expect(reviews()).toEqual([
      { reviewer: 'Agent Hub', state: 'commented', body: expect.stringContaining(URL) },
    ]);
    expect(reviews()[0].body).toContain('`aaaaaaa`');
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'native_pr_update', projectId: 'demo', prNumber: 7 }),
    );

    // The same build reported again (restart, reattach) changes nothing.
    expect(await announcePrEnvironmentReady(db, first, URL, poster)).toBe('unchanged');

    const rebuilt = env('b'.repeat(40), '2026-10-13T02:00:00.000Z');
    expect(await announcePrEnvironmentReady(db, rebuilt, URL, poster)).toBe('updated');
    expect(reviews()).toHaveLength(1);
    expect(reviews()[0].body).toContain('`bbbbbbb`');
    expect(reviews()[0].body).toContain('2026-10-13 02:00:00 UTC');
  });

  it('posts a fresh comment when the earlier one was deleted', async () => {
    const { db, poster, reviews } = setup();
    await announcePrEnvironmentReady(db, env('a'.repeat(40), 't1'), URL, poster);
    db.exec('DELETE FROM pull_request_reviews');
    expect(await announcePrEnvironmentReady(db, env('b'.repeat(40), 't2'), URL, poster)).toBe(
      'created',
    );
    expect(reviews()).toHaveLength(1);
  });

  it('does not comment on a PR that is no longer open', async () => {
    const { db, poster, reviews } = setup('merged');
    expect(await announcePrEnvironmentReady(db, env('a'.repeat(40), 't1'), URL, poster)).toBe(
      'skipped',
    );
    expect(reviews()).toHaveLength(0);
  });

  it('body names the URL and points outsiders at share links', () => {
    const body = prEnvironmentCommentBody({ url: URL, headSha: 'c'.repeat(40), readyAt: null });
    expect(body).toContain(URL);
    expect(body).toContain('share link');
  });
});

describe('GitHub PR environment comment', () => {
  function gh(opts: { token?: string | null } = {}) {
    const db = new Database(':memory:');
    db.exec(PR_ENVIRONMENT_COMMENTS_SCHEMA);
    const comments = new Map<string, string>();
    let nextId = 900;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)).body as string;
      const create = url.match(/\/repos\/acme\/app\/issues\/(\d+)\/comments$/);
      if (init.method === 'POST' && create) {
        const id = String(nextId++);
        comments.set(id, body);
        return new Response(JSON.stringify({ id: Number(id) }), { status: 201 });
      }
      const edit = url.match(/\/repos\/acme\/app\/issues\/comments\/(\d+)$/);
      if (init.method === 'PATCH' && edit) {
        if (!comments.has(edit[1])) return new Response('{}', { status: 404 });
        comments.set(edit[1], body);
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 500 });
    });
    const poster = githubPrCommentPoster({
      repo: 'acme/app',
      prNumber: 7,
      getToken: async () => (opts.token === undefined ? 'tok' : opts.token),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    return { db, poster, comments, fetchImpl };
  }

  it('creates an issue comment on first ready and edits it on rebuild', async () => {
    const { db, poster, comments, fetchImpl } = gh();
    expect(await announcePrEnvironmentReady(db, env('a'.repeat(40), 't1'), URL, poster)).toBe(
      'created',
    );
    expect([...comments.keys()]).toEqual(['900']);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/acme/app/issues/7/comments');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');

    expect(await announcePrEnvironmentReady(db, env('a'.repeat(40), 't1'), URL, poster)).toBe(
      'unchanged',
    );
    expect(await announcePrEnvironmentReady(db, env('b'.repeat(40), 't2'), URL, poster)).toBe(
      'updated',
    );
    expect(comments.size).toBe(1);
    expect(comments.get('900')).toContain('`bbbbbbb`');
    expect(fetchImpl.mock.calls[1][0]).toBe(
      'https://api.github.com/repos/acme/app/issues/comments/900',
    );
  });

  it('posts a new comment when the old one was deleted on GitHub', async () => {
    const { db, poster, comments } = gh();
    await announcePrEnvironmentReady(db, env('a'.repeat(40), 't1'), URL, poster);
    comments.clear();
    expect(await announcePrEnvironmentReady(db, env('b'.repeat(40), 't2'), URL, poster)).toBe(
      'created',
    );
    expect([...comments.keys()]).toEqual(['901']);
  });

  it('skips without a usable token', async () => {
    const { db, poster, fetchImpl } = gh({ token: null });
    expect(await announcePrEnvironmentReady(db, env('a'.repeat(40), 't1'), URL, poster)).toBe(
      'skipped',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('picks the poster by where the project is hosted', () => {
    const native = { create: () => 'n', update: () => true };
    const github = vi.fn(() => ({ create: () => 'g', update: () => true }));
    expect(
      prCommentPosterFor({ hubHosted: true, githubRepo: 'acme/app', native: () => native, github }),
    ).toBe(native);
    expect(
      prCommentPosterFor({
        hubHosted: false,
        githubRepo: ' acme/app ',
        native: () => native,
        github,
      }),
    ).not.toBeNull();
    expect(github).toHaveBeenCalledWith('acme/app');
    expect(
      prCommentPosterFor({ hubHosted: false, githubRepo: null, native: () => native, github }),
    ).toBeNull();
  });
});

describe('overlapping announcements', () => {
  /** An in-memory poster whose calls resolve only after `delayMs`. */
  function slowPoster(delayMs: number) {
    const comments = new Map<string, string>();
    let next = 1;
    const calls: string[] = [];
    const wait = () => new Promise((r) => setTimeout(r, delayMs));
    return {
      comments,
      calls,
      poster: {
        async create(body: string) {
          calls.push('create');
          await wait();
          const id = `c${next++}`;
          comments.set(id, body);
          return id;
        },
        async update(ref: string, body: string) {
          calls.push('update');
          await wait();
          if (!comments.has(ref)) return false;
          comments.set(ref, body);
          return true;
        },
      },
    };
  }
  const freshDb = () => {
    const db = new Database(':memory:');
    db.exec(PR_ENVIRONMENT_COMMENTS_SCHEMA);
    return db;
  };
  const A = env('a'.repeat(40), '2026-10-13T01:00:00.000Z');
  const B = env('b'.repeat(40), '2026-10-13T02:00:00.000Z');

  it('a first build and its rebuild racing produce one comment describing the newer build', async () => {
    const db = freshDb();
    const { poster, comments, calls } = slowPoster(30);
    const results = await Promise.all([
      announcePrEnvironmentReady(db, A, URL, poster),
      announcePrEnvironmentReady(db, B, URL, poster),
    ]);
    expect(results).toEqual(['created', 'updated']);
    expect(calls).toEqual(['create', 'update']);
    expect(comments.size).toBe(1);
    expect([...comments.values()][0]).toContain('`bbbbbbb`');
  });

  it('the same build reported twice at once posts once', async () => {
    const db = freshDb();
    const { poster, comments } = slowPoster(30);
    const results = await Promise.all([
      announcePrEnvironmentReady(db, A, URL, poster),
      announcePrEnvironmentReady(db, A, URL, poster),
    ]);
    expect(results).toEqual(['created', 'unchanged']);
    expect(comments.size).toBe(1);
  });

  it('a late hook from an older build does not overwrite the newer one', async () => {
    const db = freshDb();
    const { poster, comments, calls } = slowPoster(10);
    await announcePrEnvironmentReady(db, B, URL, poster);
    expect(await announcePrEnvironmentReady(db, A, URL, poster)).toBe('stale');
    expect(calls).toEqual(['create']);
    expect([...comments.values()][0]).toContain('`bbbbbbb`');
  });

  it('a failed post does not block the next announcement', async () => {
    const db = freshDb();
    const { poster, comments } = slowPoster(5);
    const failing = {
      create: vi.fn().mockRejectedValue(new Error('GitHub 502')),
      update: vi.fn(),
    };
    await expect(announcePrEnvironmentReady(db, A, URL, failing)).rejects.toThrow('GitHub 502');
    expect(await announcePrEnvironmentReady(db, A, URL, poster)).toBe('created');
    expect(comments.size).toBe(1);
  });

  it('different PRs do not wait on each other', async () => {
    const db = freshDb();
    const slow = slowPoster(200);
    const fast = slowPoster(1);
    const other = { ...A, prNumber: 8 };
    const started = Date.now();
    const slowRun = announcePrEnvironmentReady(db, A, URL, slow.poster);
    expect(await announcePrEnvironmentReady(db, other, URL, fast.poster)).toBe('created');
    expect(Date.now() - started).toBeLessThan(150);
    await slowRun;
  });
});
