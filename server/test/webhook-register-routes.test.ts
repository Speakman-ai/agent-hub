/**
 * HTTP coverage for GET/DELETE /api/webhooks/:id/register on the GitHub App
 * installation-token path (no gh subprocess).
 */

import { randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../github-app.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../github-app.js')>();
  return {
    ...actual,
    resolveInstallationId: vi.fn(() => 42),
    getInstallationToken: vi.fn().mockResolvedValue('ghs_install_token_route_test'),
    getAppInfo: vi.fn().mockResolvedValue({ id: 12345, slug: 'stub-app', name: 'Stub App' }),
  };
});

import { getRequest } from './helpers.js';

const WEBHOOK_URL = 'https://hub.test/api/webhooks/github';

function makeFetchResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn(async () => (typeof body === 'string' ? body : JSON.stringify(body))),
  };
}

describe('GET/DELETE /api/webhooks/:id/register (installation token path)', () => {
  let fetchSpy: Mock;

  beforeAll(() => {
    const dir = process.env.AGENT_HUB_DATA_DIR!;
    writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({
        port: 3051,
        publicUrl: 'https://hub.test',
        githubApp: {
          appId: '12345',
          privateKey: 'fake-pem',
          installationId: 42,
        },
      }),
    );
  });

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('GET register lists hooks via installation token', async () => {
    const request = await getRequest();
    const pid = `wh-reg-${randomUUID().slice(0, 8)}`;
    const projRes = await request
      .post('/api/projects')
      .send({ id: pid, name: 'Wh Reg', cwd: '/tmp', color: '#000' })
      .expect(201);

    const whRes = await request
      .post('/api/webhooks')
      .send({
        projectId: projRes.body.id,
        repoUrl: 'https://github.com/octocat/Hello-World',
        events: { push: true },
      })
      .expect(200);

    const hookRow = {
      id: 77,
      active: true,
      events: ['push'],
      config: { url: WEBHOOK_URL },
      last_response: { code: 200 },
    };
    fetchSpy.mockResolvedValueOnce(makeFetchResponse([hookRow]));

    const res = await request.get(`/api/webhooks/${whRes.body.id}/register`).expect(200);

    expect(res.body.webhookUrl).toBe(WEBHOOK_URL);
    expect(res.body.registered).toBe(true);
    expect(res.body.hooks).toHaveLength(1);
    expect(res.body.hooks[0].id).toBe(77);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/octocat/Hello-World/hooks');
    expect(init.method ?? 'GET').toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer ghs_install_token_route_test',
    );
  });

  it('DELETE register removes matching hooks via installation token', async () => {
    const request = await getRequest();
    const pid = `wh-unreg-${randomUUID().slice(0, 8)}`;
    const projRes = await request
      .post('/api/projects')
      .send({ id: pid, name: 'Wh Unreg', cwd: '/tmp', color: '#111' })
      .expect(201);

    const whRes = await request
      .post('/api/webhooks')
      .send({
        projectId: projRes.body.id,
        repoUrl: 'https://github.com/acme/widget',
        events: { push: true },
      })
      .expect(200);

    const matching = {
      id: 50,
      active: true,
      events: ['push'],
      config: { url: WEBHOOK_URL },
    };
    const other = {
      id: 51,
      active: true,
      events: ['push'],
      config: { url: 'https://other.example/hook' },
    };
    fetchSpy
      .mockResolvedValueOnce(makeFetchResponse([matching, other]))
      .mockResolvedValueOnce(makeFetchResponse(undefined, 204));

    const res = await request.delete(`/api/webhooks/${whRes.body.id}/register`).expect(200);

    expect(res.body).toEqual({ ok: true, removed: 1 });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const delUrl = fetchSpy.mock.calls[1][0] as string;
    expect(delUrl).toBe('https://api.github.com/repos/acme/widget/hooks/50');
    expect((fetchSpy.mock.calls[1][1] as RequestInit).method).toBe('DELETE');
  });
});
