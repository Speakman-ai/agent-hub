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

const CLONE_ID = 'clone-xyz';

/**
 * Seed a draft pinning the wizard at Step 1 in clone mode. We then click
 * "Clone Repository" (with a mocked POST that returns CLONE_ID) so
 * cloneIdRef.current matches the events we dispatch, then dispatch the
 * preview-defaults event and the clone-complete event, click Analyze, and
 * skip step 2's WS-driven flow by also seeding `analysisResult` via the
 * draft. From there we land on step 4 (Review & Create).
 *
 * Pragmatic shortcut: rather than re-driving every step, we set step=4 in
 * the draft but also set sourceMode=clone with a usable cloneUrl, then
 * fire `clone-preview-defaults` after invoking handleClone to wire up the
 * cloneIdRef. The draft keeps the wizard already on the review step, so
 * the event handler still fires and the preview confirm panel renders.
 */
function seedWizardAtReviewStep(extras = {}) {
  sessionStorage.setItem(
    NEW_PROJECT_WIZARD_DRAFT_KEY,
    JSON.stringify({
      v: 1,
      step: 4,
      sourceMode: 'clone',
      path: '/tmp/cloned',
      name: 'cloned-project',
      projectId: 'cloned-project',
      color: '#10B981',
      nameManuallyEdited: false,
      idManuallyEdited: false,
      cloneUrl: 'https://github.com/example/cloned',
      cloneTarget: '',
      skipGitHub: true,
      repoOwner: '',
      repoName: '',
      selectedAgents: {},
      contextFiles: {},
      activeTab: 'SOUL.md',
      analysisResult: { agents: [] },
      ghStatus: null,
      repoInfo: null,
      testResult: null,
      progressText: '',
      progressLog: [],
      cloneLog: ['done'],
      ...extras,
    }),
  );
}

describe('OpenProjectWizard — preview-defaults confirmation', () => {
  let fetchMock;

  beforeEach(() => {
    seedWizardAtReviewStep();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    sessionStorage.removeItem(NEW_PROJECT_WIZARD_DRAFT_KEY);
    vi.restoreAllMocks();
  });

  /**
   * The cloneId filter in the clone-ws handler bails when
   * `data.cloneId !== cloneIdRef.current`. cloneIdRef starts as null on a
   * fresh mount even when the draft restores step=4 (refs don't survive
   * draft hydration). So we dispatch events with `cloneId: null` — which
   * matches the initial ref value — to drive the listener in tests.
   *
   * In production the ref is set inside handleClone after the POST resolves
   * with a real cloneId, and the server broadcasts use that same id.
   */
  function fireCloneWs(detail) {
    act(() => {
      window.dispatchEvent(new CustomEvent('clone-ws', { detail: { cloneId: null, ...detail } }));
    });
  }

  it('does NOT render the panel when no preview-defaults event has fired', () => {
    render(<OpenProjectWizard onClose={() => {}} onProjectCreated={() => {}} />);
    expect(screen.queryByTestId('preview-confirm')).not.toBeInTheDocument();
  });

  it('renders PreviewConfirm in Step 4 when clone-preview-defaults arrives with a detected stack', async () => {
    render(<OpenProjectWizard onClose={() => {}} onProjectCreated={() => {}} />);
    fireCloneWs({
      type: 'clone-preview-defaults',
      detected: {
        stack: 'vite',
        startScript: 'npm run dev',
        port: 5173,
        captureRoutes: ['/'],
        idleTTL: 600,
      },
    });
    await waitFor(() => {
      expect(screen.getByTestId('preview-confirm')).toBeInTheDocument();
    });
    expect(screen.getByText(/Detected Vite project/i)).toBeInTheDocument();
  });

  it('stays silent when detection returns null (unknown stack)', () => {
    render(<OpenProjectWizard onClose={() => {}} onProjectCreated={() => {}} />);
    fireCloneWs({ type: 'clone-preview-defaults', detected: null });
    expect(screen.queryByTestId('preview-confirm')).not.toBeInTheDocument();
  });

  it('PATCHes the project with the accepted preview config after onboard succeeds', async () => {
    const onProjectCreated = vi.fn();
    const onClose = vi.fn();

    // 1st fetch: POST /projects/onboard
    fetchMock.mockResolvedValueOnce(
      ok({ id: 'cloned-project', name: 'cloned-project', cwd: '/tmp/cloned' }),
    );
    // 2nd fetch: PATCH /projects/cloned-project
    fetchMock.mockResolvedValueOnce(ok({ id: 'cloned-project' }));

    render(<OpenProjectWizard onClose={onClose} onProjectCreated={onProjectCreated} />);
    fireCloneWs({
      type: 'clone-preview-defaults',
      detected: {
        stack: 'vite',
        startScript: 'npm run dev',
        port: 5173,
        captureRoutes: ['/'],
        idleTTL: 600,
      },
    });
    await screen.findByTestId('preview-confirm');
    fireEvent.click(screen.getByTestId('preview-confirm-accept'));

    // Submit the create flow.
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    await waitFor(() => {
      expect(onProjectCreated).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [onboardCall, patchCall] = fetchMock.mock.calls;
    expect(onboardCall[0]).toBe('/api/projects/onboard');
    expect(patchCall[0]).toBe('/api/projects/cloned-project');
    expect(patchCall[1].method).toBe('PATCH');
    const body = JSON.parse(patchCall[1].body);
    expect(body).toEqual({
      prEnv: {
        enabled: false,
        preview: {
          enabled: true,
          startScript: 'npm run dev',
          captureRoutes: ['/'],
          idleTTL: 600,
        },
      },
    });
  });

  it('PATCHes a disabled preview when the user skips', async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: 'cloned-project' }));
    fetchMock.mockResolvedValueOnce(ok({}));

    render(<OpenProjectWizard onClose={() => {}} onProjectCreated={() => {}} />);
    fireCloneWs({
      type: 'clone-preview-defaults',
      detected: {
        stack: 'next',
        startScript: 'npm run dev',
        port: 3000,
        captureRoutes: ['/'],
        idleTTL: 600,
      },
    });
    await screen.findByTestId('preview-confirm');
    fireEvent.click(screen.getByTestId('preview-confirm-skip'));
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const patchBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(patchBody).toEqual({
      prEnv: { enabled: false, preview: { enabled: false } },
    });
  });

  it('skips the PATCH when the user never confirmed a preview decision', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ id: 'cloned-project', name: 'cloned-project', cwd: '/tmp/cloned' }),
    );

    render(<OpenProjectWizard onClose={() => {}} onProjectCreated={() => {}} />);
    // No preview-defaults event fired — submit straight away.
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/onboard');
  });
});
