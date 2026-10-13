/**
 * A GitHub-hosted PR through the real environment lifecycle: the service, the
 * GitHub PR-state reader, and the ready handler that posts the PR comment,
 * with GitHub simulated behind a mocked fetch. Only the runtime (which would
 * boot containers) is a stub.
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { PR_ENVIRONMENTS_SCHEMA } from './pr-environments-schema.js';
import {
  createPrEnvironmentService,
  createPrEnvironmentStore,
  type PrEnvironmentReporter,
} from './pr-environments.js';
import {
  PR_ENVIRONMENT_COMMENTS_SCHEMA,
  createPrEnvironmentReadyHandler,
} from './pr-environment-comment.js';
import {
  githubPrPreviewAvailable,
  listOpenGithubPrs,
  prEnvironmentSourceFor,
  readGithubPrState,
} from './pr-environment-github.js';
import { buildPrEnvironmentPublicUrl } from './preview-subdomain-host.js';
import type { Project } from '../types.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const project = { id: 'shop', githubRepo: 'acme/shop' } as Project;
const PR = { source: 'github' as const, prNumber: 7 };
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Just enough of GitHub: one PR and its issue comments. */
function fakeGithub() {
  const pr = {
    number: 7,
    state: 'open',
    merged: false,
    head: { sha: SHA_A, ref: 'feature/x', repo: { full_name: 'acme/shop' } },
  };
  // An open PR from a fork: never discovered automatically.
  const forkPr = {
    number: 8,
    state: 'open',
    merged: false,
    head: { sha: 'f'.repeat(40), ref: 'patch-1', repo: { full_name: 'stranger/shop' } },
  };
  const comments = new Map<number, string>();
  let nextId = 5000;
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
    if (auth !== 'Bearer gh-token') return new Response('{}', { status: 401 });
    if (url === 'https://api.github.com/repos/acme/shop/pulls?state=open&per_page=100&page=1') {
      const open = [pr, forkPr].filter((p) => p.state === 'open');
      return new Response(JSON.stringify(open), { status: 200 });
    }
    if (url === 'https://api.github.com/repos/acme/shop/pulls/7' && !init.method) {
      return new Response(JSON.stringify(pr), { status: 200 });
    }
    if (url === 'https://api.github.com/repos/acme/shop/pulls/99') {
      return new Response('{}', { status: 404 });
    }
    const body = init.body ? (JSON.parse(String(init.body)).body as string) : '';
    if (
      init.method === 'POST' &&
      url === 'https://api.github.com/repos/acme/shop/issues/7/comments'
    ) {
      const id = nextId++;
      comments.set(id, body);
      return new Response(JSON.stringify({ id }), { status: 201 });
    }
    const edit = url.match(/\/repos\/acme\/shop\/issues\/comments\/(\d+)$/);
    if (init.method === 'PATCH' && edit) {
      const id = Number(edit[1]);
      if (!comments.has(id)) return new Response('{}', { status: 404 });
      comments.set(id, body);
      return new Response('{}', { status: 200 });
    }
    return new Response('{}', { status: 500 });
  });
  return { pr, comments, fetchImpl: fetchImpl as unknown as typeof fetch, calls: fetchImpl };
}

function setup(opts: { probe?: () => Promise<'present' | 'absent' | 'unresolved'> } = {}) {
  const db = new Database(':memory:');
  db.exec(PR_ENVIRONMENTS_SCHEMA);
  db.exec(PR_ENVIRONMENT_COMMENTS_SCHEMA);
  const gh = fakeGithub();
  const reporters: PrEnvironmentReporter[] = [];
  const runtime = {
    build: vi.fn(({ reporter }: { reporter: PrEnvironmentReporter }) => {
      reporters.push(reporter);
    }),
    teardown: vi.fn(),
  };
  const readState = () =>
    readGithubPrState({
      repo: 'acme/shop',
      prNumber: 7,
      getToken: async () => 'gh-token',
      fetchImpl: gh.fetchImpl,
    });
  const announce = createPrEnvironmentReadyHandler({
    db,
    getBase: () => 'preview.hub.example.com',
    getPublicUrl: () => 'https://hub.example.com',
    isHubHosted: (p) => p.gitHost === 'agenthub',
    getGithubToken: async (repo) => (repo === 'acme/shop' ? 'gh-token' : null),
    fetchImpl: gh.fetchImpl,
    buildUrl: buildPrEnvironmentPublicUrl,
  });
  let clock = Date.parse('2026-10-13T01:00:00.000Z');
  const service = createPrEnvironmentService({
    store: createPrEnvironmentStore(db),
    probePreviewConfig: opts.probe ?? (async () => 'present'),
    findProject: (id) => (id === project.id ? project : null),
    readPrState: (_project, pr) => (pr.prNumber === 7 ? readState() : Promise.resolve(null)),
    listOpenGithubPrs: async () =>
      (
        await listOpenGithubPrs({
          repo: 'acme/shop',
          getToken: async () => 'gh-token',
          fetchImpl: gh.fetchImpl,
        })
      ).map((p) => ({ projectId: project.id, ...p })),
    getRuntime: () => runtime,
    onReady: async (p, env) => {
      await announce(p, env);
    },
    now: () => (clock += 60_000),
    log: () => {},
  });
  return { db, gh, reporters, runtime, service, readState };
}

describe('GitHub-hosted PR environments', () => {
  it('a GitHub-hosted project gets github-source environments', () => {
    expect(prEnvironmentSourceFor(project)).toBe('github');
    expect(prEnvironmentSourceFor({ id: 'x', gitHost: 'agenthub' } as Project)).toBe('native');
    expect(prEnvironmentSourceFor({ id: 'y' } as Project)).toBeNull();
    expect(prEnvironmentSourceFor({ id: 'z', githubRepo: 'not a repo' } as Project)).toBeNull();
  });

  it('starts, reaches ready, comments on GitHub, edits on rebuild, and stops on merge', async () => {
    const { gh, reporters, runtime, service, readState } = setup();

    const started = await service.start(project, PR, readState);
    expect(started).toMatchObject({ ok: true, environment: { source: 'github', headSha: SHA_A } });
    await flush();
    expect(runtime.build).toHaveBeenCalledTimes(1);

    reporters[0].building('runner-1');
    reporters[0].ready('http://10.0.0.5:32801');
    await flush();
    expect(service.get('shop', PR)).toMatchObject({ status: 'ready' });
    expect([...gh.comments.keys()]).toEqual([5000]);
    const first = gh.comments.get(5000)!;
    expect(first).toContain('https://pr-7--shop.preview.hub.example.com/');
    expect(first).toContain('`aaaaaaa`');

    // A push to the PR: the periodic catch-up sees the new head and rebuilds.
    gh.pr.head.sha = SHA_B;
    await service.catchUp();
    await flush();
    expect(runtime.build).toHaveBeenCalledTimes(2);
    reporters[1].ready('http://10.0.0.6:32802');
    await flush();
    expect(gh.comments.size).toBe(1);
    expect(gh.comments.get(5000)).toContain('`bbbbbbb`');
    const patch = (gh.calls.mock.calls as Array<[string, RequestInit?]>).find(
      ([, init]) => init?.method === 'PATCH',
    );
    expect(patch?.[0]).toBe('https://api.github.com/repos/acme/shop/issues/comments/5000');

    // Merged on GitHub: the next catch-up stops and tears it down.
    gh.pr.state = 'closed';
    gh.pr.merged = true;
    await service.catchUp();
    await flush();
    expect(service.get('shop', PR)).toMatchObject({ status: 'stopped', stopReason: 'merged' });
    expect(runtime.teardown).toHaveBeenCalled();
  });

  it('a failed first comment is retried by catch-up without a rebuild, and only once', async () => {
    const { gh, reporters, runtime, service, readState } = setup();
    const realFetch = gh.calls.getMockImplementation()!;
    let failPosts = 1;
    gh.calls.mockImplementation(async (url: string, init: RequestInit = {}) => {
      if (init.method === 'POST' && failPosts > 0) {
        failPosts -= 1;
        return new Response('{}', { status: 502 });
      }
      return realFetch(url, init);
    });
    await service.start(project, PR, readState);
    await flush();
    reporters[0].ready('http://10.0.0.5:32801');
    await flush();
    expect(service.get('shop', PR)).toMatchObject({ status: 'ready' });
    expect(gh.comments.size).toBe(0);

    await service.catchUp();
    await flush();
    expect(runtime.build).toHaveBeenCalledTimes(1);
    expect([...gh.comments.keys()]).toEqual([5000]);
    expect(gh.comments.get(5000)).toContain('`aaaaaaa`');

    // Announced: later catch-ups neither post nor edit.
    const writes = () =>
      (gh.calls.mock.calls as Array<[string, RequestInit?]>).filter(
        ([, init]) => init?.method === 'POST' || init?.method === 'PATCH',
      ).length;
    const before = writes();
    await service.catchUp();
    await service.catchUp();
    expect(writes()).toBe(before);
    expect(gh.comments.size).toBe(1);
  });

  it('catch-up starts an environment for a new GitHub PR and posts the ready comment', async () => {
    const { gh, reporters, runtime, service } = setup();

    // Nobody pressed Start: the periodic listing finds the open PR.
    await service.catchUp();
    await flush();
    expect(service.get('shop', PR)).toMatchObject({ source: 'github', headSha: SHA_A });
    expect(runtime.build).toHaveBeenCalledTimes(1);
    expect(service.get('shop', { source: 'github', prNumber: 8 })).toBeNull();

    reporters[0].ready('http://10.0.0.5:32801');
    await flush();
    expect([...gh.comments.values()]).toEqual([
      expect.stringContaining('https://pr-7--shop.preview.hub.example.com/'),
    ]);

    // Nothing changed on GitHub: later catch-ups do not rebuild.
    await service.catchUp();
    await flush();
    expect(runtime.build).toHaveBeenCalledTimes(1);

    // Closed, then reopened at the same head: the reopen rebuilds it.
    gh.pr.state = 'closed';
    await service.catchUp();
    await flush();
    expect(service.get('shop', PR)).toMatchObject({ status: 'stopped', stopReason: 'closed' });
    gh.pr.state = 'open';
    await service.catchUp();
    await flush();
    expect(runtime.build).toHaveBeenCalledTimes(2);
  });

  it('a head with no preview block is probed once, and again after a push', async () => {
    const probe = vi.fn(async () => 'absent' as const);
    const { gh, runtime, service } = setup({ probe });

    await service.catchUp();
    await service.catchUp();
    expect(service.get('shop', PR)).toBeNull();
    const probesAtA = probe.mock.calls.length;
    expect(probesAtA).toBeGreaterThan(0);
    await service.catchUp();
    expect(probe.mock.calls.length).toBe(probesAtA);

    gh.pr.head.sha = SHA_B;
    probe.mockImplementation(async () => 'present' as never);
    await service.catchUp();
    await flush();
    expect(service.get('shop', PR)).toMatchObject({ headSha: SHA_B });
    expect(runtime.build).toHaveBeenCalledTimes(1);
  });

  it('an unresolved head is retried at the same sha, not cached as absent', async () => {
    const probe = vi.fn(async (): Promise<'present' | 'absent' | 'unresolved'> => 'unresolved');
    const { runtime, service } = setup({ probe });

    await service.catchUp();
    expect(runtime.build).not.toHaveBeenCalled();

    // Same head, now readable: the next catch-up builds it.
    probe.mockImplementation(async () => 'present');
    await service.catchUp();
    await flush();
    expect(service.get('shop', PR)).toMatchObject({ headSha: SHA_A, status: 'queued' });
    expect(runtime.build).toHaveBeenCalledTimes(1);
  });

  it('a probe that throws is retried at the same sha', async () => {
    const probe = vi.fn(async (): Promise<'present' | 'absent' | 'unresolved'> => {
      throw new Error('workspace busy');
    });
    const { runtime, service } = setup({ probe });

    await service.catchUp();
    probe.mockImplementation(async () => 'present');
    await service.catchUp();
    await flush();
    expect(runtime.build).toHaveBeenCalledTimes(1);
  });

  it('a failed PR read before any environment exists is retried', async () => {
    const probe = vi.fn(async (): Promise<'present' | 'absent' | 'unresolved'> => 'present');
    const { gh, runtime, service } = setup({ probe });
    const realFetch = gh.calls.getMockImplementation()!;
    let failReads = 1;
    gh.calls.mockImplementation(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/pulls/7') && failReads > 0) {
        failReads -= 1;
        return new Response('{}', { status: 502 });
      }
      return realFetch(url, init);
    });

    await service.catchUp();
    expect(service.get('shop', PR)).toBeNull();
    expect(runtime.build).not.toHaveBeenCalled();

    await service.catchUp();
    await flush();
    expect(service.get('shop', PR)).toMatchObject({ headSha: SHA_A });
    expect(runtime.build).toHaveBeenCalledTimes(1);
  });

  it('a PR read that briefly says not found is retried at the same sha', async () => {
    const { gh, runtime, service } = setup();
    const realFetch = gh.calls.getMockImplementation()!;
    let notFound = 1;
    gh.calls.mockImplementation(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/pulls/7') && notFound > 0) {
        notFound -= 1;
        return new Response('{}', { status: 404 });
      }
      return realFetch(url, init);
    });

    await service.catchUp();
    expect(service.get('shop', PR)).toBeNull();
    await service.catchUp();
    await flush();
    expect(runtime.build).toHaveBeenCalledTimes(1);
  });

  it('a failed GitHub PR listing changes nothing', async () => {
    const { gh, runtime, service } = setup();
    (gh.calls as ReturnType<typeof vi.fn>).mockImplementation(
      async () => new Response('{}', { status: 502 }),
    );
    await service.catchUp();
    expect(service.get('shop', PR)).toBeNull();
    expect(runtime.build).not.toHaveBeenCalled();
  });

  it('a failed GitHub read changes nothing', async () => {
    const { service, readState, reporters, gh } = setup();
    await service.start(project, PR, readState);
    await flush();
    reporters[0].ready('http://10.0.0.5:32801');
    await flush();
    (gh.calls as ReturnType<typeof vi.fn>).mockImplementation(
      async () => new Response('{}', { status: 502 }),
    );
    await service.catchUp();
    expect(service.get('shop', PR)).toMatchObject({ status: 'ready', headSha: SHA_A });
  });
});

describe('readGithubPrState', () => {
  const read = (prNumber: number, token: string | null = 'gh-token') => {
    const gh = fakeGithub();
    return {
      gh,
      run: () =>
        readGithubPrState({
          repo: 'acme/shop',
          prNumber,
          getToken: async () => token,
          fetchImpl: gh.fetchImpl,
        }),
    };
  };

  it('maps open, merged, closed, and missing PRs', async () => {
    const { gh, run } = read(7);
    expect(await run()).toEqual({ status: 'open', headSha: SHA_A, headBranch: 'feature/x' });
    gh.pr.state = 'closed';
    expect(await run()).toEqual({ status: 'closed' });
    gh.pr.merged = true;
    expect(await run()).toEqual({ status: 'merged' });
    expect(await read(99).run()).toBeNull();
  });

  it('throws when it cannot read the PR', async () => {
    await expect(read(7, null).run()).rejects.toThrow(/No GitHub token/);
    await expect(read(7, 'wrong').run()).rejects.toThrow(/HTTP 401/);
  });
});

describe('listOpenGithubPrs', () => {
  it('lists same-repo open PRs and leaves forks out', async () => {
    const gh = fakeGithub();
    const list = () =>
      listOpenGithubPrs({
        repo: 'acme/shop',
        getToken: async () => 'gh-token',
        fetchImpl: gh.fetchImpl,
      });
    expect(await list()).toEqual([{ prNumber: 7, headSha: SHA_A, headBranch: 'feature/x' }]);
    gh.pr.state = 'closed';
    expect(await list()).toEqual([]);
  });

  it('follows pages until a short one', async () => {
    const page = (n: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        number: n * 1000 + i,
        head: { sha: SHA_A, ref: `b${i}`, repo: { full_name: 'Acme/Shop' } },
      }));
    const fetchImpl = vi.fn(async (url: string) => {
      const n = Number(new URL(url).searchParams.get('page'));
      return new Response(JSON.stringify(page(n, n < 7 ? 100 : 3)), { status: 200 });
    });
    const prs = await listOpenGithubPrs({
      repo: 'acme/shop',
      getToken: async () => 'gh-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // More than 500 open PRs: the oldest, past page 5, are still listed.
    expect(prs).toHaveLength(603);
    expect(prs.map((p) => p.prNumber)).toContain(7002);
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  it('throws when it cannot list', async () => {
    const gh = fakeGithub();
    await expect(
      listOpenGithubPrs({ repo: 'acme/shop', getToken: async () => null, fetchImpl: gh.fetchImpl }),
    ).rejects.toThrow(/No GitHub token/);
    await expect(
      listOpenGithubPrs({
        repo: 'acme/shop',
        getToken: async () => 'bad',
        fetchImpl: gh.fetchImpl,
      }),
    ).rejects.toThrow(/HTTP 401/);
  });
});

describe('githubPrPreviewAvailable', () => {
  it('follows the Hub-hosted rule', async () => {
    const probe = vi.fn(async () => true);
    expect(await githubPrPreviewAvailable({ env: null, prOpen: true, headSha: SHA_A, probe })).toBe(
      true,
    );
    expect(
      await githubPrPreviewAvailable({ env: null, prOpen: false, headSha: SHA_A, probe }),
    ).toBe(false);
    // A live environment stays visible on a closed PR, without probing.
    probe.mockClear();
    expect(
      await githubPrPreviewAvailable({
        env: { status: 'ready', cleanupPending: false },
        prOpen: false,
        headSha: null,
        probe,
      }),
    ).toBe(true);
    expect(probe).not.toHaveBeenCalled();
    expect(
      await githubPrPreviewAvailable({
        env: null,
        prOpen: true,
        headSha: SHA_A,
        probe: async () => {
          throw new Error('no workspace');
        },
      }),
    ).toBe(false);
  });
});
