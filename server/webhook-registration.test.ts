/**
 * Tests for webhook registration helpers introduced to eliminate the
 * gh CLI auth dependency inside the dev-hub container:
 *
 *   - callGitHubApiWithToken  — raw fetch wrapper with bearer-token auth
 *   - tryGetInstallationToken — GitHub App installation-token resolver
 *   - registerWebhookOnGitHub — hook create/update using installation token path
 *
 * All GitHub API calls and gh CLI invocations are stubbed — no real network
 * traffic or subprocesses are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// ─── Mutable config object (hoisted so vi.mock factory can reference it) ────

const mockConfig = vi.hoisted(() => ({
  port: 3051,
  publicUrl: 'https://hub.example.com',
  githubApp: null as {
    appId: string;
    privateKey: string;
    webhookSecret?: string;
    installationId?: number;
    installations?: Array<{ id: number; account: string; accountType: string }>;
  } | null,
}));

// ─── Module mocks (hoisted before any dynamic import) ───────────────────────

vi.mock('./config.js', () => ({
  default: mockConfig,
  defaultModelForEngine: vi.fn(() => 'claude-opus-4-5'),
  fileConfig: {},
}));

vi.mock('./github-app.js', () => ({
  githubApiRequest: vi.fn(),
  resolveInstallationId: vi.fn(
    (
      appCfg: { installationId?: number; installations?: Array<{ id: number; account: string }> },
      owner?: string,
    ) => {
      if (owner && Array.isArray(appCfg.installations)) {
        const match = appCfg.installations.find(
          (i) => i.account?.toLowerCase() === owner.toLowerCase(),
        );
        if (match) return match.id;
      }
      return appCfg.installationId ?? null;
    },
  ),
  getInstallationToken: vi.fn(),
}));

vi.mock('./routes/board.js', () => ({ getOrCreateBoard: vi.fn() }));
vi.mock('./routes/escalations.js', () => ({ createEscalation: vi.fn() }));
vi.mock('./capture-engine.js', () => ({ runCapture: vi.fn(), postPrComment: vi.fn() }));
vi.mock('./container-pool/pr-env-dispatch.js', () => ({
  dispatchPrEnvBuild: vi.fn(),
  dispatchPrEnvTeardown: vi.fn(),
}));
vi.mock('./container-pool/pr-env-runtime.js', () => ({
  getPrEnvBuilderDeps: vi.fn(),
  readPrEnvConfig: vi.fn(),
}));
vi.mock('./pr-env-store.js', () => ({ readPrEnvConfigRow: vi.fn() }));
vi.mock('./db.js', () => ({ getDb: vi.fn() }));
vi.mock('./check-runs.js', () => ({
  CHECK_RUN_NAME: 'Agent Hub Reviewer',
  DEFAULT_REVIEWER_PHASES: [] as unknown[],
  advancePhase: vi.fn(),
  createCheckRun: vi.fn(),
  finalizePhases: vi.fn(),
  parseSqliteTimestampMs: vi.fn(),
  renderProgressSummary: vi.fn(),
  updateCheckRun: vi.fn(),
}));
vi.mock('./reviewer-analyze-phase-timer.js', () => ({
  cancelAnalyzePhaseTimer: vi.fn(),
  clearAllAnalyzePhaseTimers: vi.fn(),
  scheduleReviewerAnalyzePhaseTransition: vi.fn(),
}));
vi.mock('./project-mode.js', () => ({ getProjectMode: vi.fn() }));
vi.mock('./session-ownership.js', () => ({
  setSessionOwner: vi.fn(),
  getOrgOwnerUserId: vi.fn(() => null),
  inheritOwnerFromSession: vi.fn(),
  resolveOwnerUserId: vi.fn(() => null),
  userOwnsSession: vi.fn(() => true),
}));

// ─── Imports under test (dynamic — after mocks are wired) ───────────────────

const { callGitHubApiWithToken, tryGetInstallationToken, registerWebhookOnGitHub } =
  await import('./routes/webhooks.js');

const { getInstallationToken: mockGetInstallationToken } = await import('./github-app.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FAKE_TOKEN = 'ghs_fake_installation_token_abc123';
const WEBHOOK_URL = 'https://hub.example.com/api/webhooks/github';

function makeWebhookConfig(
  overrides: Partial<{
    id: number;
    project_id: string;
    repo_url: string;
    secret: string;
    events: string;
    enabled: number;
    author_allowlist: string;
    created_at: string;
    updated_at: string;
  }> = {},
) {
  return {
    id: 1,
    project_id: 'surveytracker',
    repo_url: 'https://github.com/mcsteen/surveytracker',
    secret: 'mysecret',
    events: JSON.stringify({ 'pull_request.opened': true, 'pull_request.synchronize': true }),
    enabled: 1,
    author_allowlist: '',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeFetchResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn(async () => (typeof body === 'string' ? body : JSON.stringify(body))),
    json: vi.fn(async () => body),
  };
}

// ─── callGitHubApiWithToken ──────────────────────────────────────────────────

describe('callGitHubApiWithToken', () => {
  let fetchSpy: Mock;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends correct Authorization and Accept headers', async () => {
    fetchSpy.mockResolvedValue(makeFetchResponse({ id: 42 }));
    await callGitHubApiWithToken('repos/owner/repo/hooks', FAKE_TOKEN);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/owner/repo/hooks');
    expect((opts.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${FAKE_TOKEN}`);
    expect((opts.headers as Record<string, string>)['Accept']).toBe('application/vnd.github+json');
    expect((opts.headers as Record<string, string>)['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  it('returns parsed JSON for successful responses', async () => {
    const payload = [{ id: 1, active: true }];
    fetchSpy.mockResolvedValue(makeFetchResponse(payload));
    const result = await callGitHubApiWithToken<typeof payload>('repos/o/r/hooks', FAKE_TOKEN);
    expect(result).toEqual(payload);
  });

  it('returns undefined for 204 No Content', async () => {
    fetchSpy.mockResolvedValue(makeFetchResponse(undefined, 204));
    const result = await callGitHubApiWithToken('repos/o/r/hooks/99', FAKE_TOKEN, 'DELETE');
    expect(result).toBeUndefined();
  });

  it('includes JSON body and Content-Type for POST/PATCH', async () => {
    fetchSpy.mockResolvedValue(makeFetchResponse({ id: 10 }));
    const body = { name: 'web', active: true };
    await callGitHubApiWithToken('repos/o/r/hooks', FAKE_TOKEN, 'POST', body);

    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(opts.method).toBe('POST');
    expect((opts.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(opts.body).toBe(JSON.stringify(body));
  });

  it('throws on non-ok HTTP status', async () => {
    fetchSpy.mockResolvedValue(makeFetchResponse('Forbidden', 403));
    await expect(callGitHubApiWithToken('repos/o/r/hooks', FAKE_TOKEN)).rejects.toThrow(/403/);
  });
});

// ─── tryGetInstallationToken ─────────────────────────────────────────────────

describe('tryGetInstallationToken', () => {
  beforeEach(() => {
    vi.mocked(mockGetInstallationToken).mockResolvedValue(FAKE_TOKEN);
  });

  afterEach(() => {
    mockConfig.githubApp = null;
    vi.clearAllMocks();
  });

  it('returns null when githubApp is not configured', async () => {
    mockConfig.githubApp = null;
    const token = await tryGetInstallationToken('mcsteen');
    expect(token).toBeNull();
    expect(mockGetInstallationToken).not.toHaveBeenCalled();
  });

  it('returns null when githubApp has no appId', async () => {
    mockConfig.githubApp = { appId: '', privateKey: 'key', installationId: 1 };
    const token = await tryGetInstallationToken('mcsteen');
    expect(token).toBeNull();
  });

  it('returns null when githubApp has no privateKey', async () => {
    mockConfig.githubApp = { appId: '999', privateKey: '', installationId: 1 };
    const token = await tryGetInstallationToken('mcsteen');
    expect(token).toBeNull();
  });

  it('returns null when no installation found for owner', async () => {
    // resolveInstallationId mock returns null when no matching installation
    mockConfig.githubApp = { appId: '999', privateKey: 'pem', installations: [] };
    const token = await tryGetInstallationToken('mcsteen');
    expect(token).toBeNull();
  });

  it('returns an installation token when GitHub App is fully configured', async () => {
    mockConfig.githubApp = { appId: '999', privateKey: 'pem', installationId: 42 };
    const token = await tryGetInstallationToken('mcsteen');
    expect(token).toBe(FAKE_TOKEN);
    expect(mockGetInstallationToken).toHaveBeenCalledWith('999', 'pem', 42);
  });

  it('resolves installation by owner name when installations array is provided', async () => {
    mockConfig.githubApp = {
      appId: '999',
      privateKey: 'pem',
      installations: [{ id: 77, account: 'mcsteen', accountType: 'User' }],
    };
    const token = await tryGetInstallationToken('mcsteen');
    expect(token).toBe(FAKE_TOKEN);
    expect(mockGetInstallationToken).toHaveBeenCalledWith('999', 'pem', 77);
  });

  it('returns null and warns when getInstallationToken throws', async () => {
    mockConfig.githubApp = { appId: '999', privateKey: 'pem', installationId: 42 };
    vi.mocked(mockGetInstallationToken).mockRejectedValue(new Error('JWT sign failure'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = await tryGetInstallationToken('mcsteen');
    expect(token).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('JWT sign failure'));
    warnSpy.mockRestore();
  });
});

// ─── registerWebhookOnGitHub — installation token path ──────────────────────

describe('registerWebhookOnGitHub — installation token path', () => {
  let fetchSpy: Mock;

  beforeEach(() => {
    mockConfig.githubApp = { appId: '999', privateKey: 'pem', installationId: 42 };
    vi.mocked(mockGetInstallationToken).mockResolvedValue(FAKE_TOKEN);
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    mockConfig.githubApp = null;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('creates a new hook when none exists for the callback URL', async () => {
    // List returns empty
    fetchSpy
      .mockResolvedValueOnce(makeFetchResponse([])) // GET /hooks
      .mockResolvedValueOnce(makeFetchResponse({ id: 101 })); // POST /hooks

    const result = await registerWebhookOnGitHub(makeWebhookConfig());

    expect(result).toEqual({
      ok: true,
      hookId: 101,
      url: WEBHOOK_URL,
      events: ['pull_request'],
      updated: false,
    });

    // Verify POST body
    const [, postOpts] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(postOpts.method).toBe('POST');
    const body = JSON.parse(postOpts.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      name: 'web',
      active: true,
      events: ['pull_request'],
      config: {
        url: WEBHOOK_URL,
        content_type: 'json',
        secret: 'mysecret',
      },
    });
  });

  it('patches an existing hook that matches the callback URL', async () => {
    const existingHook = { id: 55, active: false, events: ['push'], config: { url: WEBHOOK_URL } };
    fetchSpy
      .mockResolvedValueOnce(makeFetchResponse([existingHook])) // GET /hooks
      .mockResolvedValueOnce(makeFetchResponse({ id: 55 })); // PATCH /hooks/55

    const result = await registerWebhookOnGitHub(makeWebhookConfig());

    expect(result).toEqual({
      ok: true,
      hookId: 55,
      url: WEBHOOK_URL,
      events: ['pull_request'],
      updated: true,
    });

    const [patchUrl, patchOpts] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(patchUrl).toContain('/hooks/55');
    expect(patchOpts.method).toBe('PATCH');
    const body = JSON.parse(patchOpts.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ active: true, events: ['pull_request'] });
  });

  it('falls through to create when listing hooks fails', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeFetchResponse('Not Found', 404)) // GET /hooks fails
      .mockResolvedValueOnce(makeFetchResponse({ id: 200 })); // POST /hooks

    const result = await registerWebhookOnGitHub(makeWebhookConfig());

    expect(result.ok).toBe(true);
    expect(result.hookId).toBe(200);
    expect(result.updated).toBe(false);
  });

  it('ignores hooks whose callback URL does not match', async () => {
    const otherHook = {
      id: 77,
      active: true,
      events: ['push'],
      config: { url: 'https://other.example.com/api/webhooks/github' },
    };
    fetchSpy
      .mockResolvedValueOnce(makeFetchResponse([otherHook])) // GET /hooks — no match
      .mockResolvedValueOnce(makeFetchResponse({ id: 88 })); // POST /hooks

    const result = await registerWebhookOnGitHub(makeWebhookConfig());

    expect(result.updated).toBe(false);
    expect(result.hookId).toBe(88);
  });

  it('defaults to push, pull_request, issues when events are empty', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeFetchResponse([]))
      .mockResolvedValueOnce(makeFetchResponse({ id: 300 }));

    const result = await registerWebhookOnGitHub(makeWebhookConfig({ events: '{}' }));
    expect(result.events).toEqual(['push', 'pull_request', 'issues']);
  });
});

// ─── registerWebhookOnGitHub — gh CLI fallback ───────────────────────────────

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn() };
});

const { execFileSync: mockExecFileSync } = await import('child_process');

describe('registerWebhookOnGitHub — gh CLI fallback', () => {
  beforeEach(() => {
    // No GitHub App configured → tryGetInstallationToken returns null
    mockConfig.githubApp = null;
  });

  afterEach(() => {
    mockConfig.githubApp = null;
    vi.clearAllMocks();
  });

  it('falls back to gh CLI when no GitHub App is configured', async () => {
    // Simulate: GET /hooks returns an empty list, POST /hooks creates hook id 500
    vi.mocked(mockExecFileSync)
      .mockReturnValueOnce('[]') // ghApi list call
      .mockReturnValueOnce(JSON.stringify({ id: 500 })); // ghApi create call

    const result = await registerWebhookOnGitHub(makeWebhookConfig());

    expect(result).toMatchObject({ ok: true, hookId: 500, updated: false });
    expect(mockGetInstallationToken).not.toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalled();
  });

  it('propagates gh CLI errors when unauthenticated', async () => {
    vi.mocked(mockExecFileSync).mockImplementation(() => {
      throw new Error('gh auth login required');
    });

    await expect(registerWebhookOnGitHub(makeWebhookConfig())).rejects.toThrow(
      /gh auth login required/,
    );
  });
});
