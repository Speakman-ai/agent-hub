/**
 * Unit tests for the GitHub mirror-link helpers. Every GitHub call goes
 * through an injected fetch — nothing here touches the network (the test
 * network guard would reject api.github.com anyway).
 */
import '../test/setup.js';
import { describe, expect, it, vi } from 'vitest';
import {
  GithubApiError,
  createGithubRepo,
  listGithubOwners,
  mirrorCloneUrl,
  parseRepoRef,
  verifyGithubRepo,
} from './mirror-link.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Route fetches by path suffix so tests declare only what they need. */
function fakeFetch(routes: Record<string, () => Response>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    for (const [key, make] of Object.entries(routes)) {
      const [routeMethod, routePath] = key.split(' ');
      if (routeMethod === method && url === `https://api.github.com${routePath}`) return make();
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as unknown as typeof fetch;
}

describe('parseRepoRef', () => {
  it('accepts owner/repo, bare names, and GitHub clone URLs', () => {
    expect(parseRepoRef('acme/widgets')).toEqual({ owner: 'acme', repo: 'widgets' });
    expect(parseRepoRef('  widgets  ')).toEqual({ owner: null, repo: 'widgets' });
    expect(parseRepoRef('acme/widgets.git')).toEqual({ owner: 'acme', repo: 'widgets' });
    expect(parseRepoRef('https://github.com/acme/widgets.git')).toEqual({
      owner: 'acme',
      repo: 'widgets',
    });
    expect(parseRepoRef('git@github.com:acme/widgets.git')).toEqual({
      owner: 'acme',
      repo: 'widgets',
    });
  });

  it('rejects non-GitHub URLs, over-deep paths, and illegal names', () => {
    expect(() => parseRepoRef('https://gitlab.com/acme/widgets.git')).toThrow(GithubApiError);
    expect(() => parseRepoRef('acme/team/widgets')).toThrow(/owner\/repo/);
    expect(() => parseRepoRef('acme/wid gets')).toThrow(/not a valid GitHub repository name/);
    expect(() => parseRepoRef('   ')).toThrow(/required/);
  });
});

describe('listGithubOwners', () => {
  it('returns the login first, then orgs', async () => {
    const owners = await listGithubOwners('tok', {
      fetchImpl: fakeFetch({
        'GET /user': () => jsonResponse(200, { login: 'octocat' }),
        'GET /user/orgs?per_page=100': () =>
          jsonResponse(200, [{ login: 'acme' }, { login: 'globex' }]),
      }),
    });
    expect(owners).toEqual([
      { login: 'octocat', type: 'user' },
      { login: 'acme', type: 'organization' },
      { login: 'globex', type: 'organization' },
    ]);
  });

  it('still returns the login when the org read is denied', async () => {
    const owners = await listGithubOwners('tok', {
      fetchImpl: fakeFetch({
        'GET /user': () => jsonResponse(200, { login: 'octocat' }),
        'GET /user/orgs?per_page=100': () => jsonResponse(403, { message: 'no read:org' }),
      }),
    });
    expect(owners).toEqual([{ login: 'octocat', type: 'user' }]);
  });

  it('surfaces a bad token as a 400 so the caller is told to reconnect', async () => {
    await expect(
      listGithubOwners('tok', {
        fetchImpl: fakeFetch({ 'GET /user': () => jsonResponse(401, { message: 'Bad creds' }) }),
      }),
    ).rejects.toMatchObject({ status: 400, message: 'Bad creds' });
  });
});

describe('verifyGithubRepo', () => {
  it('returns the canonical push URL and default branch', async () => {
    const info = await verifyGithubRepo('tok', 'acme', 'widgets', {
      fetchImpl: fakeFetch({
        'GET /repos/acme/widgets': () =>
          jsonResponse(200, {
            name: 'Widgets',
            owner: { login: 'Acme' },
            default_branch: 'main',
            private: true,
            size: 12,
            permissions: { push: true },
          }),
      }),
    });
    expect(info).toEqual({
      owner: 'Acme',
      repo: 'Widgets',
      cloneUrl: 'https://github.com/Acme/Widgets.git',
      defaultBranch: 'main',
      private: true,
      empty: false,
    });
  });

  it('404s an invisible repo and rejects read-only access', async () => {
    await expect(
      verifyGithubRepo('tok', 'acme', 'widgets', {
        fetchImpl: fakeFetch({ 'GET /repos/acme/widgets': () => jsonResponse(404, {}) }),
      }),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      verifyGithubRepo('tok', 'acme', 'widgets', {
        fetchImpl: fakeFetch({
          'GET /repos/acme/widgets': () =>
            jsonResponse(200, { permissions: { push: false, admin: false } }),
        }),
      }),
    ).rejects.toMatchObject({ status: 403, message: /push access/ });
  });
});

describe('createGithubRepo', () => {
  it('creates under the caller account via /user/repos without auto_init', async () => {
    let body: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/user')) return jsonResponse(200, { login: 'octocat' });
      if (url.includes('/user/orgs')) return jsonResponse(200, []);
      if (url.endsWith('/user/repos')) {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(201, {
          name: 'widgets',
          owner: { login: 'octocat' },
          private: true,
          default_branch: null,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const info = await createGithubRepo(
      'tok',
      { owner: null, repo: 'widgets', private: true },
      { fetchImpl },
    );
    expect(body).toMatchObject({ name: 'widgets', private: true, auto_init: false });
    expect(info.cloneUrl).toBe(mirrorCloneUrl('octocat', 'widgets'));
    expect(info.empty).toBe(true);
  });

  it('creates under an org via /orgs/{org}/repos', async () => {
    const fetchImpl = fakeFetch({
      'GET /user': () => jsonResponse(200, { login: 'octocat' }),
      'GET /user/orgs?per_page=100': () => jsonResponse(200, [{ login: 'acme' }]),
      'POST /orgs/acme/repos': () =>
        jsonResponse(201, { name: 'widgets', owner: { login: 'acme' }, private: false }),
    });
    const info = await createGithubRepo(
      'tok',
      { owner: 'acme', repo: 'widgets', private: false },
      { fetchImpl },
    );
    expect(info.owner).toBe('acme');
    expect(info.cloneUrl).toBe('https://github.com/acme/widgets.git');
  });

  it('maps a name clash to 409 and a permission failure to 403', async () => {
    const base = {
      'GET /user': () => jsonResponse(200, { login: 'octocat' }),
      'GET /user/orgs?per_page=100': () => jsonResponse(200, []),
    };
    await expect(
      createGithubRepo(
        'tok',
        { owner: null, repo: 'widgets', private: true },
        {
          fetchImpl: fakeFetch({
            ...base,
            'POST /user/repos': () =>
              jsonResponse(422, { errors: [{ message: 'name already exists on this account' }] }),
          }),
        },
      ),
    ).rejects.toMatchObject({ status: 409, message: /already exists/ });

    await expect(
      createGithubRepo(
        'tok',
        { owner: 'acme', repo: 'widgets', private: true },
        {
          fetchImpl: fakeFetch({
            ...base,
            'POST /orgs/acme/repos': () =>
              jsonResponse(403, { message: 'Resource not accessible' }),
          }),
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects an illegal repo name before calling GitHub', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      createGithubRepo('tok', { owner: null, repo: 'bad name', private: true }, { fetchImpl }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
