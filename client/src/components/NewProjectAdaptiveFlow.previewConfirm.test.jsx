import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import NewProjectAdaptiveFlow from './NewProjectAdaptiveFlow.jsx';
import { ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY } from '../utils/adaptiveQuestionnaire.js';

vi.mock('../utils/connection.js', () => ({
  getApiBase: () => '/api',
  getAuthHeaders: () => ({ Authorization: 'Bearer test-jwt' }),
  getConnectionConfig: () => ({ mode: 'local' }),
}));

// The post-scaffold audit makes network calls on mount; stub them so the
// audit view renders without errors when we transition to it.
vi.mock('../utils/auditClient.js', () => ({
  fetchAuditReport: vi.fn(async () => ({
    projectId: 'proj-1',
    score: 88,
    categories: [],
    findings: [],
    gaps: [],
  })),
  refreshAuditReport: vi.fn(async () => ({})),
  fetchRosterSuggestions: vi.fn(async () => ({ tracks: [] })),
  saveRoster: vi.fn(async () => ({ tracks: [], updatedAt: '2026-04-23T21:00:00Z' })),
  fetchAgents: vi.fn(async () => []),
}));

describe('NewProjectAdaptiveFlow — preview defaults confirmation', () => {
  let subscribeHandlers;
  let provision;
  let subscribe;
  let fetchMock;

  beforeEach(() => {
    sessionStorage.removeItem(ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY);
    subscribeHandlers = null;
    provision = vi.fn().mockResolvedValue({ jobId: 'job-1', wsUrl: 'ws://x', projectId: 'proj-1' });
    subscribe = vi.fn().mockImplementation((wsUrl, handlers) => {
      subscribeHandlers = handlers;
      return { close: vi.fn() };
    });
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    sessionStorage.removeItem(ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY);
    vi.restoreAllMocks();
  });

  async function runThroughQuestionnaire() {
    render(
      <NewProjectAdaptiveFlow
        onClose={() => {}}
        onProjectCreated={() => {}}
        provision={provision}
        subscribe={subscribe}
      />,
    );
    fireEvent.click(screen.getByTestId('ptp-code'));
    fireEvent.change(screen.getByTestId('aq-description-input'), {
      target: { value: 'a cool thing' },
    });
    fireEvent.click(screen.getByTestId('aq-continue'));
    fireEvent.click(screen.getByTestId('aq-apptype-web-app'));
    fireEvent.click(screen.getByTestId('aq-continue'));
    fireEvent.click(screen.getByTestId('aq-continue'));
    fireEvent.click(screen.getByTestId('aq-integration-db'));
    fireEvent.click(screen.getByTestId('aq-continue'));
    // hosting step (Agent Hub default)
    fireEvent.click(screen.getByTestId('aq-hosting-agenthub'));
    fireEvent.click(screen.getByTestId('aq-continue'));
    fireEvent.change(screen.getByTestId('aq-name-input'), { target: { value: 'my-proj' } });
    fireEvent.click(screen.getByTestId('aq-visibility-private'));
    fireEvent.click(screen.getByTestId('aq-continue'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('aq-submit'));
    });
  }

  function fireDetected(detail) {
    act(() => {
      window.dispatchEvent(new CustomEvent('preview-defaults-ws', { detail }));
    });
  }

  async function transitionToAudit() {
    act(() => {
      subscribeHandlers.onEvent({ type: 'done', repoUrl: 'https://github.com/acme/my-proj' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('ps-success-close'));
    });
    await screen.findByTestId('post-scaffold-audit');
  }

  it('ignores preview-defaults events that do not match the created project id', async () => {
    await runThroughQuestionnaire();
    fireDetected({
      type: 'preview-defaults-detected',
      projectId: 'someone-elses-project',
      detected: {
        stack: 'vite',
        startScript: 'npm run dev',
        port: 5173,
        captureRoutes: ['/'],
        idleTTL: 600,
      },
    });
    await transitionToAudit();
    expect(screen.queryByTestId('preview-confirm')).not.toBeInTheDocument();
  });

  it('renders PreviewConfirm in the audit view when the matching scoped event arrives', async () => {
    await runThroughQuestionnaire();
    fireDetected({
      type: 'preview-defaults-detected',
      projectId: 'proj-1',
      detected: {
        stack: 'next',
        startScript: 'npm run dev',
        port: 3000,
        captureRoutes: ['/'],
        idleTTL: 600,
      },
    });
    await transitionToAudit();
    expect(screen.getByTestId('preview-confirm')).toBeInTheDocument();
    expect(screen.getByText(/Detected Next project/i)).toBeInTheDocument();
  });

  it('stays silent when the server reports detected: null', async () => {
    await runThroughQuestionnaire();
    fireDetected({
      type: 'preview-defaults-detected',
      projectId: 'proj-1',
      detected: null,
    });
    await transitionToAudit();
    expect(screen.queryByTestId('preview-confirm')).not.toBeInTheDocument();
  });

  it('PATCHes the project with the detected defaults when the user accepts', async () => {
    await runThroughQuestionnaire();
    fireDetected({
      type: 'preview-defaults-detected',
      projectId: 'proj-1',
      detected: {
        stack: 'vite',
        startScript: 'npm run dev',
        port: 5173,
        captureRoutes: ['/'],
        idleTTL: 600,
      },
    });
    await transitionToAudit();

    // Audit mount triggers an audit fetch; ignore those for the assertion.
    const beforeCount = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByTestId('preview-confirm-accept'));

    await waitFor(() => {
      const newCalls = fetchMock.mock.calls.slice(beforeCount);
      expect(
        newCalls.some((c) => c[0] === '/api/projects/proj-1' && c[1]?.method === 'PATCH'),
      ).toBe(true);
    });
    const patchCall = fetchMock.mock.calls
      .slice(beforeCount)
      .find((c) => c[0] === '/api/projects/proj-1' && c[1]?.method === 'PATCH');
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
    await runThroughQuestionnaire();
    fireDetected({
      type: 'preview-defaults-detected',
      projectId: 'proj-1',
      detected: {
        stack: 'astro',
        startScript: 'npm run dev',
        port: 4321,
        captureRoutes: ['/'],
        idleTTL: 600,
      },
    });
    await transitionToAudit();

    const beforeCount = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByTestId('preview-confirm-skip'));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls
        .slice(beforeCount)
        .find((c) => c[0] === '/api/projects/proj-1' && c[1]?.method === 'PATCH');
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(patchCall[1].body);
      expect(body).toEqual({
        prEnv: { enabled: false, preview: { enabled: false } },
      });
    });
  });
});
