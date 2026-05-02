import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import OpenProjectWizard, { NEW_PROJECT_WIZARD_DRAFT_KEY } from './OpenProjectWizard.jsx';

vi.mock('../utils/connection.js', () => ({
  getApiBase: () => '/api',
  getAuthHeaders: () => ({ Authorization: 'Bearer test-jwt' }),
  getConnectionConfig: () => ({ mode: 'local' }),
}));

function ok(body) {
  return { ok: true, status: 200, json: async () => body };
}
function err(body, status = 400) {
  return { ok: false, status, json: async () => body };
}

/**
 * Drive the wizard from its "Select Folder" step to the "GitHub" step
 * so the dual-source `detectGitHub()` flow runs. The wizard restores
 * sessionStorage drafts on first mount, so we seed a draft pinning step=3
 * with a usable `path`/`analysisResult` rather than clicking through the
 * earlier steps (which require WebSocket events we don't model here).
 */
function seedWizardAtGithubStep() {
  sessionStorage.setItem(
    NEW_PROJECT_WIZARD_DRAFT_KEY,
    JSON.stringify({
      v: 1,
      step: 3,
      sourceMode: 'local',
      path: '/tmp/some-project',
      name: 'some-project',
      projectId: 'some-project',
      color: '#6366F1',
      nameManuallyEdited: false,
      idManuallyEdited: false,
      analysisResult: { agents: [] },
    }),
  );
}

describe('OpenProjectWizard — dual-source GitHub detection', () => {
  let fetchMock;

  beforeEach(() => {
    seedWizardAtGithubStep();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    sessionStorage.removeItem(NEW_PROJECT_WIZARD_DRAFT_KEY);
    vi.restoreAllMocks();
  });

  /**
   * The wizard at step 3 only fires `detectGitHub()` when the user clicks
   * Next from step 2. Restoring a step=3 draft mounts the GitHub UI but
   * doesn't auto-detect, so we drive `detectGitHub` by clicking the
   * "Retry Detection" button after the first render. To make that button
   * appear we first seed an unauthenticated `ghStatus` via a no-op render,
   * then trigger detection.
   */
  async function triggerDetection() {
    // The step-3 view shows "Detecting GitHub configuration..." only while
    // ghLoading is true. With no draft `ghStatus`, the UI initially renders
    // the unauthenticated block (no auto-fetch). Click "Retry Detection".
    const retryBtn = await screen.findByRole('button', { name: /retry detection/i });
    fireEvent.click(retryBtn);
  }

  it('treats the user as authenticated when only the per-user OAuth/PAT path reports connected', async () => {
    fetchMock
      // Both endpoints fire in parallel inside detectGitHub:
      .mockImplementationOnce((url) => {
        // /api/github/status — host gh CLI absent
        expect(url).toBe('/api/github/status');
        return Promise.resolve(
          ok({
            authenticated: false,
            error: 'GitHub CLI not authenticated. Run: gh auth login',
          }),
        );
      })
      .mockImplementationOnce((url) => {
        // /api/auth/github/status — per-user OAuth says connected
        expect(url).toBe('/api/auth/github/status');
        return Promise.resolve(
          ok({
            connected: true,
            login: 'octocat',
            connectedAt: '2026-04-30T00:00:00.000Z',
            serverConfigured: true,
          }),
        );
      })
      // /api/github/detect-repo — repo not a git remote
      .mockResolvedValueOnce(ok({ hasRemote: false }));

    render(<OpenProjectWizard onClose={() => {}} onProjectCreated={() => {}} />);
    await triggerDetection();

    await waitFor(() => {
      expect(screen.getByText(/Authenticated as octocat/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/via your GitHub account/i)).toBeInTheDocument();
    // The misleading "GitHub CLI not authenticated" copy must be gone.
    expect(screen.queryByText(/GitHub CLI not authenticated/i)).toBeNull();
  });

  it('saves a trimmed PAT via /api/auth/github/connect-token and refetches status', async () => {
    // Initial detection — both sources unauthenticated.
    fetchMock
      .mockResolvedValueOnce(ok({ authenticated: false }))
      .mockResolvedValueOnce(ok({ connected: false, login: null, serverConfigured: true }));

    render(<OpenProjectWizard onClose={() => {}} onProjectCreated={() => {}} />);
    await triggerDetection();

    // The OAuth button + PAT toggle should both render once status comes back.
    await screen.findByRole('button', { name: /Sign in with GitHub/i });
    fireEvent.click(screen.getByRole('button', { name: /Use a personal access token/i }));

    const input = await screen.findByTestId('github-pat-input');
    // Whitespace must be trimmed before POST.
    fireEvent.change(input, { target: { value: '  ghp_abc123  ' } });

    // Queue the POST + the post-save re-detection.
    fetchMock
      .mockResolvedValueOnce(ok({ ok: true, login: 'octocat' })) // POST connect-token
      .mockResolvedValueOnce(ok({ authenticated: false })) // /github/status (still no CLI)
      .mockResolvedValueOnce(ok({ connected: true, login: 'octocat', serverConfigured: true })) // /auth/github/status now connected
      .mockResolvedValueOnce(ok({ hasRemote: false })); // detect-repo

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save token/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/Authenticated as octocat/i)).toBeInTheDocument();
    });

    const postCall = fetchMock.mock.calls.find((c) => c[0] === '/api/auth/github/connect-token');
    expect(postCall).toBeDefined();
    expect(postCall[1].method).toBe('POST');
    expect(JSON.parse(postCall[1].body)).toEqual({ token: 'ghp_abc123' });
  });

  it('hides the Sign-in-with-GitHub button when serverConfigured is false but keeps the PAT path', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ authenticated: false }))
      .mockResolvedValueOnce(ok({ connected: false, login: null, serverConfigured: false }));

    render(<OpenProjectWizard onClose={() => {}} onProjectCreated={() => {}} />);
    await triggerDetection();

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Paste a personal access token/i }),
      ).toBeInTheDocument();
    });
    // OAuth CTA must not render — the server can't complete that flow.
    expect(screen.queryByRole('button', { name: /Sign in with GitHub/i })).toBeNull();
  });

  it('surfaces a server-side rejection of an invalid token without flipping to the connected state', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ authenticated: false }))
      .mockResolvedValueOnce(ok({ connected: false, login: null, serverConfigured: false }));

    render(<OpenProjectWizard onClose={() => {}} onProjectCreated={() => {}} />);
    await triggerDetection();

    fireEvent.click(await screen.findByRole('button', { name: /Paste a personal access token/i }));

    const input = await screen.findByTestId('github-pat-input');
    fireEvent.change(input, { target: { value: 'ghp_bogus' } });

    fetchMock.mockResolvedValueOnce(
      err({ error: 'Invalid GitHub token (GitHub rejected it)' }, 400),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save token/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/invalid github token/i)).toBeInTheDocument();
    });
    // No transition to "Authenticated as …" — token rejected, UI stays put.
    expect(screen.queryByText(/Authenticated as/i)).toBeNull();
  });
});
