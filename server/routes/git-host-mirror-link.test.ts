/**
 * Integration tests for the mirror link/unlink routes — the path that lets
 * a project born on the Hub forge acquire a GitHub mirror after the fact.
 *
 * GitHub is faked at the global `fetch` seam and the caller's token at the
 * `resolveUserGithubToken` seam; `pushMirrorNow` is stubbed so linking
 * never shells out to a real `git push`.
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getRequest } from '../test/helpers.js';

const resolveUserGithubToken = vi.fn<() => Promise<string | null>>();
const pushMirrorNow = vi.fn(async () => true);

vi.mock('../skill-credentials-github.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveUserGithubToken: (...args: unknown[]) => resolveUserGithubToken(...(args as [])),
  };
});

vi.mock('../git-host/mirror.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, pushMirrorNow: (...args: unknown[]) => pushMirrorNow(...(args as [])) };
});

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Fake api.github.com; unmatched paths fail loudly. */
function stubGithub(routes: Record<string, () => Response>): ReturnType<typeof vi.fn> {
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const key = `${method} ${url.replace('https://api.github.com', '')}`;
    const make = routes[key];
    if (!make) throw new Error(`unexpected fetch: ${key}`);
    return make();
  });
  vi.stubGlobal('fetch', impl);
  return impl as unknown as ReturnType<typeof vi.fn>;
}

async function hostedProject(): Promise<string> {
  const id = `mirror-link-${uuidv4().slice(0, 8)}`;
  await request
    .post('/api/projects')
    .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  await request
    .post(`/api/projects/${id}/git-host/enable`)
    .send({ importFrom: 'empty' })
    .expect(202);
  await vi.waitFor(
    async () => {
      const res = await request.get(`/api/projects/${id}/git-host`).expect(200);
      expect(res.body.importState?.status).toBe('ready');
    },
    { timeout: 10_000 },
  );
  return id;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  resolveUserGithubToken.mockReset();
  resolveUserGithubToken.mockResolvedValue('gh-token');
  pushMirrorNow.mockClear();
});

describe('mirror link routes', () => {
  it('404s for a project that is not Hub-hosted', async () => {
    const id = `plain-${uuidv4().slice(0, 8)}`;
    await request
      .post('/api/projects')
      .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
      .expect(201);
    await request.get(`/api/projects/${id}/git-host/mirror/owners`).expect(404);
    await request
      .post(`/api/projects/${id}/git-host/mirror/link`)
      .send({ mode: 'existing', repo: 'acme/widgets' })
      .expect(404);
    await request.delete(`/api/projects/${id}/git-host/mirror/link`).expect(404);
  });

  it('lists the caller GitHub login and orgs, and reports a missing token', async () => {
    const id = await hostedProject();
    stubGithub({
      'GET /user': () => jsonResponse(200, { login: 'octocat' }),
      'GET /user/orgs?per_page=100': () => jsonResponse(200, [{ login: 'acme' }]),
    });
    const res = await request.get(`/api/projects/${id}/git-host/mirror/owners`).expect(200);
    expect(res.body).toEqual({
      connected: true,
      owners: [
        { login: 'octocat', type: 'user' },
        { login: 'acme', type: 'organization' },
      ],
    });

    resolveUserGithubToken.mockResolvedValue(null);
    const none = await request.get(`/api/projects/${id}/git-host/mirror/owners`).expect(200);
    expect(none.body).toEqual({ connected: false, owners: [] });
  });

  it('links an existing repo, enabling mirroring and seeding the first push', async () => {
    const id = await hostedProject();
    stubGithub({
      'GET /repos/acme/widgets': () =>
        jsonResponse(200, {
          name: 'widgets',
          owner: { login: 'acme' },
          default_branch: 'main',
          private: true,
          size: 4,
          permissions: { push: true },
        }),
    });

    const res = await request
      .post(`/api/projects/${id}/git-host/mirror/link`)
      .send({ mode: 'existing', repo: 'https://github.com/acme/widgets.git' })
      .expect(200);
    expect(res.body).toMatchObject({
      created: false,
      githubRepo: 'acme/widgets',
      repoUrl: 'https://github.com/acme/widgets.git',
    });
    expect(res.body.status.mirror).toMatchObject({
      enabled: true,
      refs: 'default-branch',
      githubRepo: 'acme/widgets',
    });
    expect(pushMirrorNow).toHaveBeenCalledTimes(1);

    // Persisted on the project record — this is what mirrorPolicy reads.
    const project = await request.get(`/api/projects/${id}`).expect(200);
    expect(project.body).toMatchObject({
      githubRepo: 'acme/widgets',
      repoUrl: 'https://github.com/acme/widgets.git',
      gitMirror: { enabled: true, refs: 'default-branch' },
    });
  });

  it('creates a new repo on the caller account and links it', async () => {
    const id = await hostedProject();
    const fetchMock = stubGithub({
      'GET /user': () => jsonResponse(200, { login: 'octocat' }),
      'GET /user/orgs?per_page=100': () => jsonResponse(200, []),
      'POST /user/repos': () =>
        jsonResponse(201, { name: 'fresh-repo', owner: { login: 'octocat' }, private: true }),
    });

    const res = await request
      .post(`/api/projects/${id}/git-host/mirror/link`)
      .send({ mode: 'create', repo: 'fresh-repo', private: true, refs: 'all' })
      .expect(200);
    expect(res.body).toMatchObject({
      created: true,
      githubRepo: 'octocat/fresh-repo',
      repoUrl: 'https://github.com/octocat/fresh-repo.git',
    });
    expect(res.body.status.mirror).toMatchObject({ enabled: true, refs: 'all' });

    const created = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/user/repos'));
    expect(JSON.parse(String((created?.[1] as RequestInit).body))).toMatchObject({
      name: 'fresh-repo',
      private: true,
      auto_init: false,
    });
  });

  it('rejects create when the caller has no GitHub token', async () => {
    const id = await hostedProject();
    resolveUserGithubToken.mockResolvedValue(null);
    const res = await request
      .post(`/api/projects/${id}/git-host/mirror/link`)
      .send({ mode: 'create', repo: 'fresh-repo' })
      .expect(400);
    expect(res.body.error).toMatch(/Settings → GitHub/);
  });

  it('surfaces GitHub failures verbatim (404 unknown repo, 409 name taken)', async () => {
    const id = await hostedProject();
    stubGithub({ 'GET /repos/acme/nope': () => jsonResponse(404, { message: 'Not Found' }) });
    await request
      .post(`/api/projects/${id}/git-host/mirror/link`)
      .send({ mode: 'existing', repo: 'acme/nope' })
      .expect(404);

    stubGithub({
      'GET /user': () => jsonResponse(200, { login: 'octocat' }),
      'GET /user/orgs?per_page=100': () => jsonResponse(200, []),
      'POST /user/repos': () =>
        jsonResponse(422, { errors: [{ message: 'name already exists on this account' }] }),
    });
    const clash = await request
      .post(`/api/projects/${id}/git-host/mirror/link`)
      .send({ mode: 'create', repo: 'taken' })
      .expect(409);
    expect(clash.body.error).toMatch(/already exists/);
  });

  it('validates the body before touching GitHub', async () => {
    const id = await hostedProject();
    const fetchMock = stubGithub({});
    await request.post(`/api/projects/${id}/git-host/mirror/link`).send({}).expect(400);
    await request
      .post(`/api/projects/${id}/git-host/mirror/link`)
      .send({ mode: 'nope', repo: 'acme/widgets' })
      .expect(400);
    await request
      .post(`/api/projects/${id}/git-host/mirror/link`)
      .send({ mode: 'existing', repo: 'https://gitlab.com/acme/widgets.git' })
      .expect(400);
    await request
      .post(`/api/projects/${id}/git-host/mirror/link`)
      .send({ mode: 'existing', repo: 'widgets' })
      .expect(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unlinks: clears the target and turns mirroring off', async () => {
    const id = await hostedProject();
    stubGithub({
      'GET /repos/acme/widgets': () =>
        jsonResponse(200, {
          name: 'widgets',
          owner: { login: 'acme' },
          default_branch: 'main',
          permissions: { push: true },
        }),
    });
    await request
      .post(`/api/projects/${id}/git-host/mirror/link`)
      .send({ mode: 'existing', repo: 'acme/widgets' })
      .expect(200);

    const res = await request.delete(`/api/projects/${id}/git-host/mirror/link`).expect(200);
    expect(res.body.mirror).toMatchObject({ enabled: false, githubRepo: null, repoUrl: null });

    const project = await request.get(`/api/projects/${id}`).expect(200);
    expect(project.body.githubRepo).toBeUndefined();
    expect(project.body.repoUrl).toBeUndefined();
  });
});
