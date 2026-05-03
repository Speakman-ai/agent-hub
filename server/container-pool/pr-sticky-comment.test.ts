import { describe, it, expect, vi } from 'vitest';
import {
  STICKY_MARKER_START,
  STICKY_MARKER_END,
  buildStickyCommentBody,
  findExistingStickyComment,
  upsertPrStickyComment,
  type GitHubApiClient,
  type GitHubIssueComment,
} from './pr-sticky-comment.js';

describe('buildStickyCommentBody', () => {
  it('wraps the ready body in start/end markers', () => {
    const body = buildStickyCommentBody({
      kind: 'ready',
      previewUrl: 'https://pr-12.preview.example.com',
      port: 4012,
    });
    expect(body.startsWith(STICKY_MARKER_START)).toBe(true);
    expect(body.endsWith(STICKY_MARKER_END)).toBe(true);
    expect(body).toContain('Preview environment ready');
    expect(body).toContain('https://pr-12.preview.example.com');
    expect(body).toContain('`4012`');
  });

  it('includes a short commit sha when provided', () => {
    const body = buildStickyCommentBody({
      kind: 'ready',
      previewUrl: 'https://pr-12.preview.example.com',
      port: 4012,
      commitSha: 'abcdef1234567890',
    });
    expect(body).toContain('`abcdef1`');
    // Should be a 7-char prefix, not the full sha.
    expect(body).not.toContain('abcdef1234567890');
  });

  it('omits the commit line when sha not provided', () => {
    const body = buildStickyCommentBody({
      kind: 'ready',
      previewUrl: 'https://pr-12.preview.example.com',
      port: 4012,
    });
    expect(body).not.toContain('Commit:');
  });

  it('builds a failure body with the reason', () => {
    const body = buildStickyCommentBody({
      kind: 'failed',
      reason: '.env.preview missing required fields: FOO, BAR.',
    });
    expect(body).toContain(STICKY_MARKER_START);
    expect(body).toContain(STICKY_MARKER_END);
    expect(body).toContain('build failed');
    expect(body).toContain('FOO, BAR');
    expect(body).toContain('Push a new commit to retry');
  });

  it('builds a torndown body', () => {
    const body = buildStickyCommentBody({ kind: 'torndown' });
    expect(body).toContain(STICKY_MARKER_START);
    expect(body).toContain(STICKY_MARKER_END);
    expect(body).toContain('torn down');
    expect(body).toContain('closed/merged');
  });

  it('always wraps every state in markers so subsequent runs find it', () => {
    for (const payload of [
      { kind: 'ready', previewUrl: 'u', port: 1 } as const,
      { kind: 'failed', reason: 'x' } as const,
      { kind: 'torndown' } as const,
    ]) {
      const body = buildStickyCommentBody(payload);
      expect(body.includes(STICKY_MARKER_START)).toBe(true);
      expect(body.includes(STICKY_MARKER_END)).toBe(true);
    }
  });
});

// ─── client fake ────────────────────────────────────────────────────────────

interface FakeCall {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: unknown;
}

function makeFakeClient(opts: {
  listResponse?: unknown;
  postResponse?: unknown;
  patchResponse?: unknown;
  throwOn?: 'GET' | 'POST' | 'PATCH';
}): GitHubApiClient & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  return {
    calls,
    async get(path) {
      calls.push({ method: 'GET', path });
      if (opts.throwOn === 'GET') throw new Error('boom-get');
      return opts.listResponse ?? [];
    },
    async post(path, body) {
      calls.push({ method: 'POST', path, body });
      if (opts.throwOn === 'POST') throw new Error('boom-post');
      return opts.postResponse ?? { id: 999 };
    },
    async patch(path, body) {
      calls.push({ method: 'PATCH', path, body });
      if (opts.throwOn === 'PATCH') throw new Error('boom-patch');
      return opts.patchResponse ?? {};
    },
  };
}

// ─── findExistingStickyComment ──────────────────────────────────────────────

describe('findExistingStickyComment', () => {
  it('returns the first comment whose body contains the start marker', async () => {
    const list: GitHubIssueComment[] = [
      { id: 1, body: 'unrelated comment' },
      { id: 2, body: `${STICKY_MARKER_START}\nold body\n${STICKY_MARKER_END}` },
      { id: 3, body: 'another comment' },
    ];
    const client = makeFakeClient({ listResponse: list });
    const found = await findExistingStickyComment(client, {
      owner: 'acme',
      repo: 'repo',
      prNumber: 7,
    });
    expect(found?.id).toBe(2);
    expect(client.calls[0]).toEqual({
      method: 'GET',
      path: '/repos/acme/repo/issues/7/comments?per_page=100',
    });
  });

  it('returns null when no comment matches', async () => {
    const list: GitHubIssueComment[] = [
      { id: 1, body: 'one' },
      { id: 2, body: 'two' },
    ];
    const client = makeFakeClient({ listResponse: list });
    expect(
      await findExistingStickyComment(client, { owner: 'a', repo: 'b', prNumber: 1 }),
    ).toBeNull();
  });

  it('returns null when API returns a non-array', async () => {
    const client = makeFakeClient({ listResponse: { message: 'Not Found' } });
    expect(
      await findExistingStickyComment(client, { owner: 'a', repo: 'b', prNumber: 1 }),
    ).toBeNull();
  });

  it('skips comments without a body field', async () => {
    const list = [
      { id: 1 },
      { id: 2, body: null },
      { id: 3, body: `${STICKY_MARKER_START}\nx\n${STICKY_MARKER_END}` },
    ];
    const client = makeFakeClient({ listResponse: list });
    const found = await findExistingStickyComment(client, {
      owner: 'a',
      repo: 'b',
      prNumber: 1,
    });
    expect(found?.id).toBe(3);
  });
});

// ─── upsertPrStickyComment ──────────────────────────────────────────────────

describe('upsertPrStickyComment', () => {
  it('POSTs a new comment when none exists', async () => {
    const client = makeFakeClient({ listResponse: [], postResponse: { id: 555 } });
    const id = await upsertPrStickyComment(client, {
      owner: 'acme',
      repo: 'repo',
      prNumber: 42,
      body: 'hello world',
    });
    expect(id).toBe(555);
    const post = client.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/repos/acme/repo/issues/42/comments');
    expect(post?.body).toEqual({ body: 'hello world' });
  });

  it('PATCHes the existing comment when one is found by marker', async () => {
    const list: GitHubIssueComment[] = [
      { id: 9, body: `${STICKY_MARKER_START}\nold\n${STICKY_MARKER_END}` },
    ];
    const client = makeFakeClient({ listResponse: list });
    const id = await upsertPrStickyComment(client, {
      owner: 'acme',
      repo: 'repo',
      prNumber: 42,
      body: 'new body',
    });
    expect(id).toBe(9);
    const patch = client.calls.find((c) => c.method === 'PATCH');
    expect(patch?.path).toBe('/repos/acme/repo/issues/comments/9');
    expect(patch?.body).toEqual({ body: 'new body' });
    // No POST should happen on the edit path.
    expect(client.calls.find((c) => c.method === 'POST')).toBeUndefined();
  });

  it('returns null when owner/repo/prNumber are missing', async () => {
    const client = makeFakeClient({});
    expect(
      await upsertPrStickyComment(client, { owner: '', repo: 'r', prNumber: 1, body: 'x' }),
    ).toBeNull();
    expect(
      await upsertPrStickyComment(client, { owner: 'o', repo: '', prNumber: 1, body: 'x' }),
    ).toBeNull();
    expect(
      await upsertPrStickyComment(client, { owner: 'o', repo: 'r', prNumber: 0, body: 'x' }),
    ).toBeNull();
    // No HTTP calls should have been made.
    expect(client.calls).toHaveLength(0);
  });

  it('propagates errors from the GitHub API (caller decides to swallow)', async () => {
    const client = makeFakeClient({ throwOn: 'POST' });
    await expect(
      upsertPrStickyComment(client, {
        owner: 'a',
        repo: 'b',
        prNumber: 1,
        body: 'x',
      }),
    ).rejects.toThrow(/boom-post/);
  });

  it('returns null when POST response has no numeric id', async () => {
    const client = makeFakeClient({ listResponse: [], postResponse: { weird: true } });
    const id = await upsertPrStickyComment(client, {
      owner: 'a',
      repo: 'b',
      prNumber: 1,
      body: 'x',
    });
    expect(id).toBeNull();
  });

  it('still returns the existing id even when PATCH response is empty', async () => {
    const list: GitHubIssueComment[] = [
      { id: 77, body: `${STICKY_MARKER_START}\nold\n${STICKY_MARKER_END}` },
    ];
    const client = makeFakeClient({ listResponse: list, patchResponse: undefined });
    const id = await upsertPrStickyComment(client, {
      owner: 'a',
      repo: 'b',
      prNumber: 1,
      body: 'x',
    });
    expect(id).toBe(77);
  });

  it('does not duplicate the comment on rapid back-to-back calls when the second sees the first', async () => {
    // Simulate: first call lands a new comment; second call sees it in
    // the list and edits in place.
    let stored: GitHubIssueComment[] = [];
    const client: GitHubApiClient & { posts: number; patches: number } = {
      posts: 0,
      patches: 0,
      async get() {
        return stored;
      },
      async post(_path, body) {
        const b = (body as { body: string }).body;
        const id = 1000 + stored.length;
        stored.push({ id, body: b });
        client.posts++;
        return { id };
      },
      async patch(path, body) {
        const m = path.match(/comments\/(\d+)$/);
        if (!m) throw new Error('bad patch path');
        const id = Number(m[1]);
        const idx = stored.findIndex((c) => c.id === id);
        if (idx >= 0) stored[idx] = { id, body: (body as { body: string }).body };
        client.patches++;
        return {};
      },
    };

    await upsertPrStickyComment(client, {
      owner: 'a',
      repo: 'b',
      prNumber: 1,
      body: buildStickyCommentBody({
        kind: 'ready',
        previewUrl: 'https://x',
        port: 1,
      }),
    });
    await upsertPrStickyComment(client, {
      owner: 'a',
      repo: 'b',
      prNumber: 1,
      body: buildStickyCommentBody({ kind: 'torndown' }),
    });

    expect(client.posts).toBe(1);
    expect(client.patches).toBe(1);
    expect(stored).toHaveLength(1);
    expect(stored[0].body).toContain('torn down');
  });
});

// keep vi referenced so the import isn't pruned
void vi;
