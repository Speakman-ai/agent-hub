/**
 * Wire-level tests for the GitHub Check Runs HTTP shape.
 *
 * The pure helpers (`renderProgressSummary`, `advancePhase`, etc.) are
 * exhaustively pinned in `check-runs.test.ts`. What's tested here is the
 * `createCheckRun` / `updateCheckRun` / `completeCheckRun` plumbing that
 * actually hits GitHub — specifically:
 *
 * - The right endpoint is requested (POST /repos/.../check-runs vs PATCH
 *   .../check-runs/:id).
 * - The body shape matches GitHub's contract (`name`, `head_sha`, `status`,
 *   `output.{title,summary}`, `conclusion`, `completed_at`).
 * - The auth tuple (`appId`, `privateKey`, `installationId`) is forwarded
 *   from the resolved App config.
 * - Feature-detection: when the App isn't installed for the owner, every
 *   wrapper short-circuits without calling GitHub.
 *
 * A regression here (e.g. dropping `head_sha`, renaming `output`, posting to
 * the wrong path) would land Check Runs on the wrong commit, render no panel,
 * or 422 the API. The pure-helper tests would not catch any of those.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig } from './types.js';

vi.mock('./github-app.js', () => ({
  githubApiRequest: vi.fn(),
  resolveInstallationId: vi.fn(),
}));

import { githubApiRequest, resolveInstallationId } from './github-app.js';
import { CHECK_RUN_NAME, completeCheckRun, createCheckRun, updateCheckRun } from './check-runs.js';

const mockedApiRequest = vi.mocked(githubApiRequest);
const mockedResolveInstallationId = vi.mocked(resolveInstallationId);

const APP_CONFIG = {
  githubApp: {
    appId: '12345',
    privateKey: 'test-private-key',
    installations: [{ id: '67890', account: 'octocat' }],
  },
} as unknown as AppConfig;

beforeEach(() => {
  mockedApiRequest.mockReset();
  mockedResolveInstallationId.mockReset();
  mockedResolveInstallationId.mockReturnValue('67890');
  mockedApiRequest.mockResolvedValue({ id: 999, html_url: 'https://example.test/check' });
});

describe('createCheckRun → POST /repos/{owner}/{repo}/check-runs', () => {
  it('hits the correct endpoint with method=POST', async () => {
    await createCheckRun(APP_CONFIG, {
      owner: 'octocat',
      repo: 'hello-world',
      headSha: 'deadbeef00112233',
    });
    expect(mockedApiRequest).toHaveBeenCalledTimes(1);
    const [endpoint, options] = mockedApiRequest.mock.calls[0];
    expect(endpoint).toBe('/repos/octocat/hello-world/check-runs');
    expect(options.method).toBe('POST');
  });

  it('sends a body with the stable check-run name and head_sha', async () => {
    await createCheckRun(APP_CONFIG, {
      owner: 'octocat',
      repo: 'hello-world',
      headSha: 'deadbeef00112233',
    });
    const [, options] = mockedApiRequest.mock.calls[0];
    const body = options.body as Record<string, unknown>;
    expect(body.name).toBe(CHECK_RUN_NAME);
    expect(body.head_sha).toBe('deadbeef00112233');
    // Default status when none is passed in.
    expect(body.status).toBe('queued');
  });

  it('forwards `output`, `details_url`, and `external_id` when supplied', async () => {
    await createCheckRun(APP_CONFIG, {
      owner: 'octocat',
      repo: 'hello-world',
      headSha: 'sha',
      status: 'in_progress',
      output: { title: 'Reviewer queued', summary: '- ⏳ context' },
      detailsUrl: 'https://example.test/details',
      externalId: 'octocat/hello-world#42',
    });
    const [, options] = mockedApiRequest.mock.calls[0];
    const body = options.body as Record<string, unknown>;
    expect(body.status).toBe('in_progress');
    expect(body.output).toEqual({ title: 'Reviewer queued', summary: '- ⏳ context' });
    expect(body.details_url).toBe('https://example.test/details');
    expect(body.external_id).toBe('octocat/hello-world#42');
  });

  it('threads the resolved App auth tuple to githubApiRequest', async () => {
    await createCheckRun(APP_CONFIG, {
      owner: 'octocat',
      repo: 'hello-world',
      headSha: 'sha',
    });
    const [, options] = mockedApiRequest.mock.calls[0];
    expect(options.appId).toBe('12345');
    expect(options.privateKey).toBe('test-private-key');
    expect(options.installationId).toBe('67890');
  });

  it('returns null and skips the HTTP call when the App is not installed for owner', async () => {
    mockedResolveInstallationId.mockReturnValue(null);
    const result = await createCheckRun(APP_CONFIG, {
      owner: 'unknown-org',
      repo: 'r',
      headSha: 'sha',
    });
    expect(result).toBeNull();
    expect(mockedApiRequest).not.toHaveBeenCalled();
  });
});

describe('updateCheckRun → PATCH /repos/{owner}/{repo}/check-runs/:id', () => {
  it('hits the correct endpoint with method=PATCH', async () => {
    await updateCheckRun(APP_CONFIG, 'octocat', 'hello-world', 4242, {
      status: 'in_progress',
      output: { title: 't', summary: 's' },
    });
    expect(mockedApiRequest).toHaveBeenCalledTimes(1);
    const [endpoint, options] = mockedApiRequest.mock.calls[0];
    expect(endpoint).toBe('/repos/octocat/hello-world/check-runs/4242');
    expect(options.method).toBe('PATCH');
  });

  it('sends only the fields that were supplied (no schema-leakage)', async () => {
    await updateCheckRun(APP_CONFIG, 'octocat', 'hello-world', 4242, {
      output: { title: 't', summary: 's' },
    });
    const [, options] = mockedApiRequest.mock.calls[0];
    const body = options.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['output']);
  });

  it('threads conclusion + completed_at + details_url when supplied', async () => {
    await updateCheckRun(APP_CONFIG, 'octocat', 'hello-world', 4242, {
      status: 'completed',
      conclusion: 'success',
      completedAt: '2026-04-16T20:00:00.000Z',
      detailsUrl: 'https://example.test/details',
    });
    const [, options] = mockedApiRequest.mock.calls[0];
    const body = options.body as Record<string, unknown>;
    expect(body.status).toBe('completed');
    expect(body.conclusion).toBe('success');
    expect(body.completed_at).toBe('2026-04-16T20:00:00.000Z');
    expect(body.details_url).toBe('https://example.test/details');
  });

  it('returns null and skips the HTTP call when the App is not installed for owner', async () => {
    mockedResolveInstallationId.mockReturnValue(null);
    const result = await updateCheckRun(APP_CONFIG, 'unknown-org', 'r', 4242, {
      status: 'completed',
      conclusion: 'success',
    });
    expect(result).toBeNull();
    expect(mockedApiRequest).not.toHaveBeenCalled();
  });
});

describe('completeCheckRun → PATCH with status=completed', () => {
  it('always sets status=completed and a fresh completed_at ISO timestamp', async () => {
    await completeCheckRun(APP_CONFIG, 'octocat', 'hello-world', 4242, 'neutral', {
      title: 'Done',
      summary: '- ✅ all phases',
    });
    expect(mockedApiRequest).toHaveBeenCalledTimes(1);
    const [endpoint, options] = mockedApiRequest.mock.calls[0];
    expect(endpoint).toBe('/repos/octocat/hello-world/check-runs/4242');
    expect(options.method).toBe('PATCH');
    const body = options.body as Record<string, unknown>;
    expect(body.status).toBe('completed');
    expect(body.conclusion).toBe('neutral');
    expect(body.output).toEqual({ title: 'Done', summary: '- ✅ all phases' });
    // completed_at is generated from Date.now() — assert ISO 8601 with `Z`.
    expect(body.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it.each(['success', 'neutral', 'action_required'] as const)(
    'forwards conclusion=%s verbatim',
    async (conclusion) => {
      await completeCheckRun(APP_CONFIG, 'o', 'r', 1, conclusion);
      const [, options] = mockedApiRequest.mock.calls[0];
      const body = options.body as Record<string, unknown>;
      expect(body.conclusion).toBe(conclusion);
    },
  );
});
