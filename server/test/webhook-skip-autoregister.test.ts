/**
 * `POST /api/webhooks` with `autoRegister: true` should skip the per-repo
 * webhook registration on GitHub when the configured GitHub App already
 * has an installation covering the repo's owner. Otherwise we have two
 * delivery paths into the same handler signed with two different secrets,
 * which was the 2026-05-18 HMAC-drift incident.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type supertest from 'supertest';
import { generateKeyPairSync } from 'crypto';
import { getRequest, createProject } from './helpers.js';
import { clearTokenCache } from '../github-app.js';

const { privateKey: appPrivateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

let request: supertest.Agent;
let projectId: string;
let originalGithubApp: unknown;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;

  const { default: config } = await import('../config.js');
  originalGithubApp = (config as { githubApp: unknown }).githubApp;
});

afterAll(async () => {
  const { default: config } = await import('../config.js');
  (config as unknown as { githubApp: unknown }).githubApp = originalGithubApp;
});

describe('POST /api/webhooks autoRegister with GitHub App installed', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    // Each test installs its own App config — token cache from a previous
    // test would otherwise satisfy a token lookup that we explicitly want
    // to fail in the fallback test.
    clearTokenCache();
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    clearTokenCache();
    const { default: config } = await import('../config.js');
    (config as unknown as { githubApp: unknown }).githubApp = originalGithubApp;
  });

  it('skips registration and returns reason github_app_installed when App covers the owner', async () => {
    const { default: config } = await import('../config.js');
    (config as unknown as { githubApp: unknown }).githubApp = {
      appId: '4242',
      privateKey: appPrivateKey,
      webhookSecret: 'irrelevant-for-this-test',
      installations: [{ id: 999, account: 'app-installed-org', accountType: 'Organization' }],
      installationId: 999,
    };

    // The first fetch call inside tryGetInstallationToken is to mint the
    // installation access token. Returning a fake token is enough — the
    // route should then short-circuit and NOT make any /hooks calls.
    fetchSpy.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/installations/') && u.endsWith('/access_tokens')) {
        return new Response(
          JSON.stringify({
            token: 'ghs_fake_install_token',
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch in skip-autoregister test: ${u}`);
    });

    const res = await request
      .post('/api/webhooks')
      .send({
        projectId,
        repoUrl: 'https://github.com/app-installed-org/some-repo',
        events: { pull_request: { enabled: true } },
        enabled: true,
        autoRegister: true,
      })
      .expect(200);

    expect(res.body.registration).toMatchObject({
      ok: true,
      skipped: true,
      reason: 'github_app_installed',
    });

    // Critically, the route must NOT have called repos/.../hooks at all.
    const hookCalls = fetchSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('/hooks'));
    expect(hookCalls).toHaveLength(0);
  });

  it('falls back to per-repo registration when no App installation covers the owner', async () => {
    // App config has no `installations` array and no default `installationId`,
    // so resolveInstallationId returns null, tryGetInstallationToken returns
    // null, and we fall through to the legacy registerWebhookOnGitHub path.
    const { default: config } = await import('../config.js');
    (config as unknown as { githubApp: unknown }).githubApp = {
      appId: '4242',
      privateKey: appPrivateKey,
      webhookSecret: 'irrelevant-for-this-test',
      installations: [],
      // No installationId — guarantees resolveInstallationId returns null.
    };

    fetchSpy.mockImplementation(async (url: unknown) => {
      const u = String(url);
      // No `/installations/.../access_tokens` should be called because
      // resolveInstallationId returns null before we get there.
      throw new Error(`unexpected fetch in fallback test: ${u}`);
    });

    const res = await request
      .post('/api/webhooks')
      .send({
        projectId,
        repoUrl: 'https://github.com/some-other-org/some-repo',
        events: { pull_request: { enabled: true } },
        enabled: true,
        autoRegister: true,
      })
      .expect(200);

    // Did not short-circuit — registration result is either ok:false from
    // the gh CLI fallback, or a real registration result. Either way it
    // is NOT `{ skipped: true, reason: 'github_app_installed' }`.
    expect(res.body.registration?.skipped).not.toBe(true);
  });
});
