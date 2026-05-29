import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../../utils/api.js', () => ({
  api: {
    startFinalizeRun: vi.fn(),
    cancelFinalizeRun: vi.fn(),
  },
}));

vi.mock('../../hooks/useFinalizeRun.js', async () => {
  const actual = await vi.importActual('../../hooks/useFinalizeRun.js');
  return {
    ...actual,
    useFinalizeRun: vi.fn(),
  };
});

import FinalizeButton from './FinalizeButton.jsx';
import { api } from '../../utils/api.js';
import { useFinalizeRun } from '../../hooks/useFinalizeRun.js';

const setHookState = (state) => {
  useFinalizeRun.mockReturnValue({
    run: null,
    steps: [],
    phase: null,
    status: null,
    isActive: false,
    isPaused: false,
    isTerminal: false,
    activeSeconds: null,
    wallSeconds: null,
    loadError: null,
    ...state,
  });
};

const baseProps = {
  projectId: 'proj-1',
  cardId: 'card-1',
  sessionId: 'session-1',
  branchLabel: 'feature/x',
};

describe('FinalizeButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setHookState({});
    api.startFinalizeRun.mockResolvedValue({
      run_id: 'run-1',
      status: 'queued',
      reused: false,
    });
    api.cancelFinalizeRun.mockResolvedValue({ ok: true, status: 'cancelled' });
  });

  it('renders an enabled "Finalize Code Changes" button when idle', () => {
    render(<FinalizeButton {...baseProps} />);
    const btn = screen.getByTestId('finalize-code-changes-button');
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveTextContent('Finalize Code Changes');
    // No cancel control while idle.
    expect(screen.queryByTestId('finalize-code-changes-cancel')).not.toBeInTheDocument();
  });

  it('calls api.startFinalizeRun(projectId, cardId) on click', async () => {
    render(<FinalizeButton {...baseProps} />);
    fireEvent.click(screen.getByTestId('finalize-code-changes-button'));
    await waitFor(() => {
      expect(api.startFinalizeRun).toHaveBeenCalledWith('proj-1', 'card-1');
    });
  });

  it('disables optimistically as soon as click fires (before WS update)', async () => {
    // Hold the promise open so the optimistic disable is the only effect.
    let resolveStart;
    api.startFinalizeRun.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );
    render(<FinalizeButton {...baseProps} />);
    const btn = screen.getByTestId('finalize-code-changes-button');
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    await waitFor(() => {
      expect(btn).toBeDisabled();
    });
    expect(btn).toHaveTextContent(/Finalizing/);
    resolveStart?.({ run_id: 'run-1', status: 'queued', reused: false });
  });

  it('renders disabled "Finalizing: {phase}" with cancel button while in-flight', () => {
    setHookState({
      run: { id: 'run-99', status: 'running', phase: 'tasks' },
      status: 'running',
      phase: 'tasks',
      isActive: true,
      isTerminal: false,
      activeSeconds: 42,
    });
    render(<FinalizeButton {...baseProps} />);
    const btn = screen.getByTestId('finalize-code-changes-button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent('Finalizing: running checks');
    expect(screen.getByTestId('finalize-code-changes-cancel')).toBeInTheDocument();
  });

  it('calls api.cancelFinalizeRun(projectId, runId) when cancel clicked', async () => {
    setHookState({
      run: { id: 'run-99', status: 'running', phase: 'tasks' },
      status: 'running',
      phase: 'tasks',
      isActive: true,
      isTerminal: false,
    });
    render(<FinalizeButton {...baseProps} />);
    fireEvent.click(screen.getByTestId('finalize-code-changes-cancel'));
    await waitFor(() => {
      expect(api.cancelFinalizeRun).toHaveBeenCalledWith('proj-1', 'run-99');
    });
  });

  it('re-enables the button once the run reaches a terminal status', () => {
    setHookState({
      run: { id: 'run-99', status: 'pushed', phase: null },
      status: 'pushed',
      phase: null,
      isActive: false,
      isTerminal: true,
    });
    render(<FinalizeButton {...baseProps} />);
    const btn = screen.getByTestId('finalize-code-changes-button');
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveTextContent('Finalize Code Changes');
    expect(screen.queryByTestId('finalize-code-changes-cancel')).not.toBeInTheDocument();
  });

  it('forwards api errors to onError', async () => {
    api.startFinalizeRun.mockRejectedValue(new Error('boom'));
    const onError = vi.fn();
    render(<FinalizeButton {...baseProps} onError={onError} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('finalize-code-changes-button'));
    });
    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith('boom');
    });
  });

  it('forwards cancel errors to onError', async () => {
    api.cancelFinalizeRun.mockRejectedValue(new Error('cant cancel'));
    const onError = vi.fn();
    setHookState({
      run: { id: 'run-99', status: 'running', phase: 'tasks' },
      status: 'running',
      phase: 'tasks',
      isActive: true,
      isTerminal: false,
    });
    render(<FinalizeButton {...baseProps} onError={onError} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('finalize-code-changes-cancel'));
    });
    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith('cant cancel');
    });
  });

  it('honors the compact variant by applying tighter padding classes', () => {
    render(<FinalizeButton {...baseProps} variant="compact" />);
    const btn = screen.getByTestId('finalize-code-changes-button');
    expect(btn.className).toMatch(/px-2 py-1/);
    expect(btn.className).toMatch(/text-\[11px\]/);
    // Compact variant suppresses the tooltip wrapper.
    expect(btn.getAttribute('title')).toBeNull();
  });

  describe('v0 reviewer-stub caveat', () => {
    // Surfaces the operator-visible warning that runs terminate at the
    // reviewer phase until card eeb3380b lands. The caveat is the
    // user-discoverable counterpart to the PR description warning —
    // removing it before the reviewer wiring ships is a regression.
    it('renders the caveat note next to the idle (default) button', () => {
      render(<FinalizeButton {...baseProps} />);
      const note = screen.getByTestId('finalize-v0-caveat');
      expect(note).toBeTruthy();
      expect(note.textContent).toMatch(/v0:\s*reviewer wiring deferred/i);
      // Tooltip on the note carries the full sentence + the follow-up card id.
      expect(note.getAttribute('title')).toMatch(/eeb3380b/i);
    });

    it('includes the caveat in the button title tooltip when idle', () => {
      render(<FinalizeButton {...baseProps} />);
      const btn = screen.getByTestId('finalize-code-changes-button');
      // The title aggregates: "Finalize Code Changes · branch · caveat"
      expect(btn.getAttribute('title')).toMatch(/eeb3380b/i);
    });

    it('omits the adjacent caveat note (but keeps the title) on compact variant', () => {
      // Compact mode renders on kanban card rows where there's no room
      // for the trailing italic note; the button title tooltip in
      // compact is also suppressed (caller is responsible for surface).
      render(<FinalizeButton {...baseProps} variant="compact" />);
      expect(screen.queryByTestId('finalize-v0-caveat')).toBeNull();
    });

    it('drops the caveat note while a run is in flight', () => {
      // The in-flight surface already shows "Finalizing: <phase>" which
      // crowds the row; the caveat is most useful on idle (pre-click).
      useFinalizeRun.mockReturnValue({
        run: { id: 'run-1' },
        status: 'rebasing',
        phase: 'rebasing',
        activeSeconds: 4,
      });
      render(<FinalizeButton {...baseProps} />);
      expect(screen.queryByTestId('finalize-v0-caveat')).toBeNull();
    });
  });
});
