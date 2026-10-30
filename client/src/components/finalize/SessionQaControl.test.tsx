import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const getSessionQaRequest = vi.fn();
const setSessionQaRequestArmed = vi.fn();
const runSessionQaRequest = vi.fn();
vi.mock('../../utils/api', () => ({
  api: {
    getSessionQaRequest: (...a: unknown[]) => getSessionQaRequest(...a),
    setSessionQaRequestArmed: (...a: unknown[]) => setSessionQaRequestArmed(...a),
    runSessionQaRequest: (...a: unknown[]) => runSessionQaRequest(...a),
  },
}));

import SessionQaControl from './SessionQaControl';

/** The mutation changes server state, so the GET that follows returns `next`. */
function serverMovesTo(fn: ReturnType<typeof vi.fn>, next: unknown) {
  fn.mockImplementation(async () => {
    getSessionQaRequest.mockResolvedValue(next);
    return next;
  });
}

const env = { id: 'e1', name: 'Staging', baseUrl: 'https://s.example.com' };
const state = (over: Record<string, unknown> = {}) => ({
  request: null,
  merged: false,
  defaultEnvironment: env,
  delayMinutes: 5,
  hasQaAgent: true,
  ...over,
});
const request = (over: Record<string, unknown> = {}) => ({
  sessionId: 's1',
  projectId: 'p',
  status: 'armed',
  planId: null,
  planTitle: null,
  runId: null,
  dueAt: null,
  error: null,
  createdAt: '',
  updatedAt: '',
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('SessionQaControl', () => {
  it('shows a checkbox before merge and arms the request', async () => {
    getSessionQaRequest.mockResolvedValue(state());
    serverMovesTo(setSessionQaRequestArmed, state({ request: request() }));
    render(<SessionQaControl sessionId="s1" />);
    const box = (await screen.findByTestId('session-qa-checkbox')) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText('Run QA Tests')).toBeTruthy();
    fireEvent.click(box);
    await waitFor(() => expect(setSessionQaRequestArmed).toHaveBeenCalledWith('s1', true));
    await waitFor(() =>
      expect((screen.getByTestId('session-qa-checkbox') as HTMLInputElement).checked).toBe(true),
    );
  });

  it('shows a button after merge and links the created plan', async () => {
    getSessionQaRequest.mockResolvedValue(state({ merged: true }));
    serverMovesTo(
      runSessionQaRequest,
      state({ merged: true, request: request({ status: 'authoring', planId: 'plan-9' }) }),
    );
    const onOpenPlan = vi.fn();
    render(<SessionQaControl sessionId="s1" onOpenPlan={onOpenPlan} />);
    fireEvent.click(await screen.findByTestId('session-qa-run-button'));
    await waitFor(() => expect(runSessionQaRequest).toHaveBeenCalledWith('s1'));
    fireEvent.click(await screen.findByTestId('session-qa-plan-link'));
    expect(onOpenPlan).toHaveBeenCalledWith('plan-9');
    expect(screen.getByTestId('session-qa-status').textContent).toContain('drafting');
  });

  it('disables the control without a default environment', async () => {
    getSessionQaRequest.mockResolvedValue(state({ defaultEnvironment: null }));
    render(<SessionQaControl sessionId="s1" />);
    const box = (await screen.findByTestId('session-qa-checkbox')) as HTMLInputElement;
    expect(box.disabled).toBe(true);
  });

  it('ignores a mutation that resolves after switching to another session', async () => {
    getSessionQaRequest.mockImplementation(async (id: string) =>
      id === 'a' ? state({ merged: true }) : state({ merged: true }),
    );
    let resolveRun!: (v: unknown) => void;
    runSessionQaRequest.mockImplementation(() => new Promise((r) => (resolveRun = r)));
    const { rerender } = render(<SessionQaControl sessionId="a" />);
    fireEvent.click(await screen.findByTestId('session-qa-run-button'));
    await waitFor(() => expect(runSessionQaRequest).toHaveBeenCalledWith('a'));
    rerender(<SessionQaControl sessionId="b" />);
    await waitFor(() => expect(getSessionQaRequest).toHaveBeenCalledWith('b'));
    const button = (await screen.findByTestId('session-qa-run-button')) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    resolveRun(
      state({ merged: true, request: request({ status: 'authoring', planId: 'plan-a' }) }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('session-qa-plan-link')).toBeNull();
    expect((screen.getByTestId('session-qa-run-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('refetches when a PR merges so the checkbox becomes the button', async () => {
    getSessionQaRequest.mockResolvedValueOnce(state()).mockResolvedValue(state({ merged: true }));
    render(<SessionQaControl sessionId="s1" />);
    await screen.findByTestId('session-qa-checkbox');
    window.dispatchEvent(
      new CustomEvent('qa_update', { detail: { projectId: 'p', action: 'pr_merged' } }),
    );
    expect(await screen.findByTestId('session-qa-run-button')).toBeTruthy();
  });

  it('lets an armed request be unticked after the default environment is removed', async () => {
    getSessionQaRequest.mockResolvedValue(state({ defaultEnvironment: null, request: request() }));
    serverMovesTo(setSessionQaRequestArmed, state({ defaultEnvironment: null }));
    render(<SessionQaControl sessionId="s1" />);
    const box = (await screen.findByTestId('session-qa-checkbox')) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(setSessionQaRequestArmed).toHaveBeenCalledWith('s1', false));
    await waitFor(() =>
      expect((screen.getByTestId('session-qa-checkbox') as HTMLInputElement).disabled).toBe(true),
    );
  });

  it('a mutation response that arrives after a newer update does not overwrite it', async () => {
    getSessionQaRequest.mockResolvedValue(state({ merged: true }));
    let resolveRun!: (v: unknown) => void;
    runSessionQaRequest.mockImplementation(() => new Promise((r) => (resolveRun = r)));
    render(<SessionQaControl sessionId="s1" />);
    fireEvent.click(await screen.findByTestId('session-qa-run-button'));
    await waitFor(() => expect(runSessionQaRequest).toHaveBeenCalled());

    // Drafting finished server-side and its update reaches the client first.
    const newer = state({
      merged: true,
      request: request({ status: 'waiting', planId: 'p1', dueAt: '2999-01-01T00:00:00Z' }),
    });
    getSessionQaRequest.mockResolvedValue(newer);
    window.dispatchEvent(new CustomEvent('qa_update', { detail: { sessionId: 's1' } }));
    await waitFor(() =>
      expect(screen.getByTestId('session-qa-status').textContent).toMatch(/QA run starts/),
    );

    // Then the /run response, captured while still drafting, lands.
    resolveRun(state({ merged: true, request: request({ status: 'authoring', planId: 'p1' }) }));
    await waitFor(() => expect(getSessionQaRequest.mock.calls.length).toBeGreaterThanOrEqual(3));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId('session-qa-status').textContent).toMatch(/QA run starts/);
  });
});
