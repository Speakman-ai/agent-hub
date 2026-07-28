import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import NewProjectAdaptiveFlow from './NewProjectAdaptiveFlow';
import { ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY } from '@shared/utils/adaptiveQuestionnaire';

(vi as any).mock('../utils/connection.js', () => ({
  getApiBase: () => '/api',
  getAuthHeaders: () => ({ Authorization: 'Bearer test-jwt' }),
  getConnectionConfig: () => ({ mode: 'local' }),
}));

describe('NewProjectAdaptiveFlow — preview defaults confirmation', () => {
  let subscribeHandlers: any;
  let provision: any;
  let subscribe: any;
  let fetchMock: any;

  beforeEach(() => {
    sessionStorage.removeItem(ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY);
    subscribeHandlers = null;
    provision = vi.fn().mockResolvedValue({ jobId: 'job-1', wsUrl: 'ws://x', projectId: 'proj-1' });
    subscribe = vi.fn().mockImplementation((wsUrl: any, handlers: any) => {
      subscribeHandlers = handlers;
      return { close: vi.fn() };
    });
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) as any });
    (globalThis as any).fetch = fetchMock;
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
    fireEvent.click(screen.getByTestId('ptp-code' as any) as any);
    fireEvent.change(screen.getByTestId('aq-description-input' as any), {
      target: { value: 'a cool thing' },
    });
    fireEvent.click(screen.getByTestId('aq-continue' as any) as any);
    fireEvent.click(screen.getByTestId('aq-apptype-web-app' as any) as any);
    fireEvent.click(screen.getByTestId('aq-continue' as any) as any);
    fireEvent.click(screen.getByTestId('aq-continue' as any) as any);
    fireEvent.click(screen.getByTestId('aq-integration-db' as any) as any);
    fireEvent.click(screen.getByTestId('aq-continue' as any) as any);
    // hosting step (Agent Hub default)
    fireEvent.click(screen.getByTestId('aq-hosting-agenthub' as any) as any);
    fireEvent.click(screen.getByTestId('aq-continue' as any) as any);
    fireEvent.change(screen.getByTestId('aq-name-input' as any), { target: { value: 'my-proj' } });
    fireEvent.click(screen.getByTestId('aq-visibility-private' as any) as any);
    fireEvent.click(screen.getByTestId('aq-continue' as any) as any);
    await act(async () => {
      fireEvent.click(screen.getByTestId('aq-submit' as any) as any);
    });
  }

  function fireDetected(detail: any) {
    act(() => {
      window.dispatchEvent(new CustomEvent('preview-defaults-ws', { detail }));
    });
  }

  async function transitionToLanding() {
    act(() => {
      subscribeHandlers.onEvent({ type: 'done', repoUrl: 'https://github.com/acme/my-proj' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('ps-success-close' as any) as any);
    });
    await screen.findByTestId('project-landing');
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
    await transitionToLanding();
    expect(screen.queryByTestId('preview-confirm')).not.toBeInTheDocument();
  });

  it('renders PreviewConfirm on the landing view when the matching scoped event arrives', async () => {
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
    await transitionToLanding();
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
    await transitionToLanding();
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
    await transitionToLanding();

    const beforeCount = (fetchMock as any).mock.calls.length;
    fireEvent.click(screen.getByTestId('preview-confirm-accept' as any) as any);

    await waitFor(() => {
      const newCalls = (fetchMock as any).mock.calls.slice(beforeCount);
      expect(
        newCalls.some((c: any) => c[0] === '/api/projects/proj-1' && c[1]?.method === 'PATCH'),
      ).toBe(true);
    });
    const patchCall = (fetchMock as any).mock.calls
      .slice(beforeCount)
      .find((c: any) => c[0] === '/api/projects/proj-1' && c[1]?.method === 'PATCH');
    const body = JSON.parse(patchCall[1].body);
    expect(body!).toEqual({
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
    await transitionToLanding();

    const beforeCount = (fetchMock as any).mock.calls.length;
    fireEvent.click(screen.getByTestId('preview-confirm-skip' as any) as any);

    await waitFor(() => {
      const patchCall = (fetchMock as any).mock.calls
        .slice(beforeCount)
        .find((c: any) => c[0] === '/api/projects/proj-1' && c[1]?.method === 'PATCH');
      expect(patchCall!).toBeTruthy();
      const body = JSON.parse(patchCall[1].body);
      expect(body!).toEqual({
        prEnv: { enabled: false, preview: { enabled: false } },
      });
    });
  });
});
