import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import NewProjectAdaptiveFlow from './NewProjectAdaptiveFlow';
import { ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY } from '@shared/utils/adaptiveQuestionnaire';

(vi as any).mock('../utils/connection.js', () => ({
  getApiBase: () => '/api',
  getAuthHeaders: () => ({ Authorization: 'Bearer test-jwt' }),
  getConnectionConfig: () => ({ mode: 'local' }),
}));

describe('NewProjectAdaptiveFlow — auto-open first build (no landing preview confirm)', () => {
  let subscribeHandlers: any;
  let provision: any;
  let subscribe: any;
  let onProjectCreated: any;

  beforeEach(() => {
    sessionStorage.removeItem(ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY);
    subscribeHandlers = null;
    onProjectCreated = vi.fn();
    provision = vi.fn().mockResolvedValue({ jobId: 'job-1', wsUrl: 'ws://x', projectId: 'proj-1' });
    subscribe = vi.fn().mockImplementation((wsUrl: any, handlers: any) => {
      subscribeHandlers = handlers;
      return { close: vi.fn() };
    });
  });

  afterEach(() => {
    sessionStorage.removeItem(ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY);
    vi.restoreAllMocks();
  });

  async function runThroughQuestionnaire() {
    render(
      <NewProjectAdaptiveFlow
        onClose={() => {}}
        onProjectCreated={onProjectCreated}
        provision={provision}
        subscribe={subscribe}
      />,
    );
    fireEvent.click(screen.getByTestId('ptp-code' as any) as any);
    fireEvent.change(screen.getByTestId('aq-description-input' as any), {
      target: { value: 'a cool thing' },
    });
    fireEvent.click(screen.getByTestId('aq-continue' as any) as any);
    fireEvent.click(screen.getByTestId('aq-hosting-agenthub' as any) as any);
    fireEvent.click(screen.getByTestId('aq-continue' as any) as any);
    fireEvent.change(screen.getByTestId('aq-name-input' as any), { target: { value: 'my-proj' } });
    fireEvent.click(screen.getByTestId('aq-visibility-private' as any) as any);
    fireEvent.click(screen.getByTestId('aq-continue' as any) as any);
    await act(async () => {
      fireEvent.click(screen.getByTestId('aq-submit' as any) as any);
    });
  }

  it('does not show the landing preview-confirm; first build session opens instead', async () => {
    await runThroughQuestionnaire();
    act(() => {
      window.dispatchEvent(
        new CustomEvent('preview-defaults-ws', {
          detail: {
            type: 'preview-defaults-detected',
            projectId: 'proj-1',
            detected: {
              stack: 'next',
              startScript: 'npm run dev',
              port: 3000,
              captureRoutes: ['/'],
              idleTTL: 600,
            },
          },
        }),
      );
    });
    act(() => {
      subscribeHandlers.onEvent({ type: 'done', repoUrl: 'https://github.com/acme/my-proj' });
    });
    expect(screen.queryByTestId('project-landing')).not.toBeInTheDocument();
    expect(screen.queryByTestId('preview-confirm')).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent('initial-build-ws', {
          detail: {
            type: 'initial_build_started',
            projectId: 'proj-1',
            sessionId: 'sess-1',
            agentId: 'proj-1-dev',
          },
        }),
      );
    });
    expect(onProjectCreated).toHaveBeenCalledWith({
      action: 'session',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      agentId: 'proj-1-dev',
    });
  });
});
