/**
 * projects-webhook-auto-configure.test.ts
 *
 * Tests for POST /api/projects/:projectId/webhook/auto-configure — the
 * one-click missing-webhook backfill route powering the new client
 * banner.
 *
 * Coverage:
 *   - 404 on unknown project slug
 *   - 400 when the project has no `githubRepo`
 *   - 409 when an enabled `webhook_configs` row already exists
 *   - 200 with `config + registration` on the success path; mocks both
 *     `registerWebhookOnGitHub` and `tryGetInstallationToken` to keep
 *     the test isolated from GitHub API and `gh` CLI.
 *   - 200 with `registration.skipped: true` when a GitHub App
 *     installation token is available for the repo owner — the local
 *     row is still created so the missing-webhook banner clears, but
 *     no per-repo registration runs.
 *   - 200 with `registration.ok: false` when GitHub registration fails
 *     (mocked) — the local row is still created so the banner clears
 *     and the UI can surface a "configure manually" hint.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type supertest from 'supertest';

// Mock the heavy GitHub-side helpers so the test stays hermetic. The
// route imports these via `./webhooks.js` — we mock the same module.
const mockRegisterWebhookOnGitHub = vi.fn(async () => ({
  ok: true,
  hookId: 12345,
  url: 'https://example.test/api/webhooks/github',
  events: ['pull_request', 'pull_request_review_comment', 'check_suite'],
  updated: false,
}));
let mockInstallationToken: string | null = null;
// `callGitHubApiWithToken` is used to probe `GET repos/<owner>/<repo>`
// before short-circuiting the per-repo registration on App-installed
// owners. The probe lets us tell apart "all repositories" installations
// from "selected repositories" installations that don't include this
// repo — the latter case must fall through to per-repo registration
// even though `tryGetInstallationToken(owner)` returned a token.
const mockCallGitHubApi = vi.fn<(endpoint: string, token: string) => Promise<unknown>>(
  async () => ({}),
);
vi.mock('../routes/webhooks.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../routes/webhooks.js');
  return {
    ...actual,
    registerWebhookOnGitHub: (...args: unknown[]) =>
      (mockRegisterWebhookOnGitHub as unknown as (...a: unknown[]) => unknown)(...args),
    tryGetInstallationToken: async () => mockInstallationToken,
    callGitHubApiWithToken: (endpoint: string, token: string) => mockCallGitHubApi(endpoint, token),
  };
});

import { getRequest, createProject } from './helpers.js';

/**
 * Helper — creates a project + sets `githubRepo`, then sweeps out the
 * webhook_configs row that the PATCH path auto-seeds.
 *
 * The PATCH /api/projects/:id handler creates a `webhook_configs` row as
 * a side-effect whenever the body sets `githubRepo`. That's the right
 * thing to do for happy-path UI flows, but it defeats this test: the
 * auto-configure endpoint we're testing checks for existing enabled
 * rows and returns 409, so the PATCH side-effect would make every test
 * return 409. Production callers reach the auto-configure path because
 * they pre-date the PATCH-side-effect code (field-app / plus-150-golf /
 * spellinggame in the live install) — we replicate that initial state
 * by deleting the auto-seeded row before each test.
 */
async function createProjectWithRepo(
  githubRepo: string | null,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string }> {
  const project = await createProject(overrides);
  const id = project.id as string;
  if (githubRepo) {
    const req = await getRequest();
    await req.patch(`/api/projects/${id}`).send({ githubRepo }).expect(200);
    // Sweep any auto-seeded rows so the test starts from the same "no
    // webhook config exists" state production hits for legacy projects.
    const listRes = await req.get(`/api/webhooks/project/${id}`).expect(200);
    const rows = listRes.body as Array<{ id: number }>;
    for (const row of rows) {
      await req.delete(`/api/webhooks/${row.id}`).expect(200);
    }
  }
  return { id };
}

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

beforeEach(() => {
  mockRegisterWebhookOnGitHub.mockClear();
  mockRegisterWebhookOnGitHub.mockResolvedValue({
    ok: true,
    hookId: 12345,
    url: 'https://example.test/api/webhooks/github',
    events: ['pull_request', 'pull_request_review_comment', 'check_suite'],
    updated: false,
  });
  mockInstallationToken = null;
  mockCallGitHubApi.mockReset();
  mockCallGitHubApi.mockResolvedValue({});
});

describe('POST /api/projects/:projectId/webhook/auto-configure', () => {
  it('returns 404 for an unknown project slug', async () => {
    await request.post('/api/projects/no-such-project/webhook/auto-configure').expect(404);
  });

  it('returns 400 when the project has no githubRepo set', async () => {
    const project = await createProject();
    const res = await request
      .post(`/api/projects/${project.id}/webhook/auto-configure`)
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/githubRepo/);
  });

  it('creates a webhook config + calls registerWebhookOnGitHub on the happy path', async () => {
    const project = await createProjectWithRepo('owner/repo');

    const res = await request
      .post(`/api/projects/${project.id}/webhook/auto-configure`)
      .expect(200);

    const body = res.body as {
      config: { id: number; project_id: string; repo_url: string; enabled: number };
      registration: { ok: boolean };
    };
    expect(body.config.project_id).toBe(project.id);
    expect(body.config.repo_url).toBe('https://github.com/owner/repo');
    expect(body.config.enabled).toBe(1);
    expect(body.registration.ok).toBe(true);
    expect(mockRegisterWebhookOnGitHub).toHaveBeenCalledTimes(1);
  });

  it('normalises a githubRepo with a `.git` suffix into the canonical https URL', async () => {
    const project = await createProjectWithRepo('owner/repo.git');
    const res = await request
      .post(`/api/projects/${project.id}/webhook/auto-configure`)
      .expect(200);
    const body = res.body as { config: { repo_url: string } };
    expect(body.config.repo_url).toBe('https://github.com/owner/repo');
  });

  it('returns 409 when an enabled webhook config already exists', async () => {
    const project = await createProjectWithRepo('owner/repo');

    // First call seeds the row.
    await request.post(`/api/projects/${project.id}/webhook/auto-configure`).expect(200);

    // Second call must refuse.
    const res = await request
      .post(`/api/projects/${project.id}/webhook/auto-configure`)
      .expect(409);
    const body = res.body as { error: string; existingConfigId: number };
    expect(body.error).toMatch(/already enabled/i);
    expect(typeof body.existingConfigId).toBe('number');
    // Second call must NOT have hit GitHub again.
    expect(mockRegisterWebhookOnGitHub).toHaveBeenCalledTimes(1);
  });

  it('skips per-repo registration when the GitHub App probe confirms repo access', async () => {
    // Override config.githubApp so tryGetInstallationToken is even consulted.
    const config = (await import('../config.js')).default as {
      githubApp?: { appId?: string; privateKey?: string } | null;
    };
    const savedApp = config.githubApp;
    config.githubApp = { appId: 'app-1', privateKey: 'pk' };
    mockInstallationToken = 'ghs_installation_token_stub';
    // App "All repositories" — probe returns 200-equivalent.
    mockCallGitHubApi.mockResolvedValue({ full_name: 'owner/repo' });

    try {
      const project = await createProjectWithRepo('owner/repo');
      const res = await request
        .post(`/api/projects/${project.id}/webhook/auto-configure`)
        .expect(200);
      const body = res.body as {
        config: { id: number };
        registration: { ok: true; skipped: true; reason: string };
      };
      expect(body.config.id).toBeGreaterThan(0); // local row still created
      expect(body.registration.skipped).toBe(true);
      expect(body.registration.reason).toBe('github_app_installed');
      // Probe must have hit `repos/<owner>/<repo>` with the install token.
      expect(mockCallGitHubApi).toHaveBeenCalledWith('repos/owner/repo', mockInstallationToken);
      // Per-repo registration must NOT have run — App delivers events directly.
      expect(mockRegisterWebhookOnGitHub).not.toHaveBeenCalled();
    } finally {
      config.githubApp = savedApp;
    }
  });

  it('falls through to per-repo registration when the App lacks access to the repo (selected-repos scope)', async () => {
    // Same shape as the previous test — App is installed on the owner —
    // but the probe `GET repos/owner/repo` 404s because the App is
    // installed with "selected repositories" scope and this repo is NOT
    // in the selected list. The route must NOT report
    // `skipped: github_app_installed` (banner would clear but no events
    // would flow); it must fall through to per-repo registration.
    const config = (await import('../config.js')).default as {
      githubApp?: { appId?: string; privateKey?: string } | null;
    };
    const savedApp = config.githubApp;
    config.githubApp = { appId: 'app-1', privateKey: 'pk' };
    mockInstallationToken = 'ghs_installation_token_stub';
    mockCallGitHubApi.mockRejectedValue(
      new Error('GitHub API GET https://api.github.com/repos/owner/repo failed (404): Not Found'),
    );

    try {
      const project = await createProjectWithRepo('owner/repo');
      const res = await request
        .post(`/api/projects/${project.id}/webhook/auto-configure`)
        .expect(200);
      const body = res.body as {
        config: { id: number };
        registration: { ok: boolean; skipped?: boolean; reason?: string; hookId?: number };
      };
      expect(body.config.id).toBeGreaterThan(0);
      // Must NOT be the App-installed short-circuit. The reviewer would
      // otherwise silently miss this repo.
      expect(body.registration.skipped).not.toBe(true);
      expect(body.registration.reason).not.toBe('github_app_installed');
      // Must have called per-repo registration.
      expect(mockRegisterWebhookOnGitHub).toHaveBeenCalledTimes(1);
      // Probe was attempted.
      expect(mockCallGitHubApi).toHaveBeenCalledWith('repos/owner/repo', mockInstallationToken);
    } finally {
      config.githubApp = savedApp;
    }
  });

  it('returns 200 with registration.ok:false when GitHub registration throws', async () => {
    mockRegisterWebhookOnGitHub.mockRejectedValueOnce(new Error('gh: not authenticated'));
    const project = await createProjectWithRepo('owner/repo');

    const res = await request
      .post(`/api/projects/${project.id}/webhook/auto-configure`)
      .expect(200);

    const body = res.body as {
      config: { id: number };
      registration: { ok: false; error: string };
    };
    // Local row still created so the banner clears + UI can surface the
    // failure inline instead of bouncing on a 500.
    expect(body.config.id).toBeGreaterThan(0);
    expect(body.registration.ok).toBe(false);
    expect(body.registration.error).toMatch(/not authenticated/);
  });
});
