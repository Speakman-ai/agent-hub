import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../../utils/api.js', () => ({
  api: {
    startFinalizeRun: vi.fn(),
    startFinalizeRunForSession: vi.fn(),
    pushFinalizeRun: vi.fn(),
    pushSessionToGithub: vi.fn(),
    cancelFinalizeRun: vi.fn(),
    getSessionWorktreeChanges: vi.fn().mockResolvedValue({ committable: true }),
    getFinalizeCiJobs: vi.fn().mockResolvedValue({ version: 1, jobs: [], error: null }),
  },
}));

vi.mock('../../utils/connection.js', () => ({
  getApiBase: () => '/api',
  getAuthHeaders: () => ({}),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

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
    phases: null,
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
  pendingChanges: { branch: 'feature/x', hasUncommitted: true, hasUnpushed: false },
};

describe('FinalizeButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ connected: true }),
    });
    setHookState({});
    // Re-establish the default worktree response — `clearAllMocks` wipes
    // call history but NOT implementations, so a per-test override (e.g. the
    // staleness specs that inject a `headSha`) would otherwise leak forward.
    api.getSessionWorktreeChanges.mockResolvedValue({ committable: true });
    api.getFinalizeCiJobs.mockResolvedValue({ version: 1, jobs: [], error: null });
    api.startFinalizeRun.mockResolvedValue({
      run_id: 'run-1',
      status: 'queued',
      reused: false,
    });
    api.cancelFinalizeRun.mockResolvedValue({ ok: true, status: 'cancelled' });
  });

  it('renders enabled "Run Tests" and "Reviewer" buttons when idle', () => {
    render(<FinalizeButton {...baseProps} />);
    const runTests = screen.getByTestId('finalize-run-tests-button');
    const reviewer = screen.getByTestId('finalize-reviewer-button');
    expect(runTests).toBeInTheDocument();
    expect(reviewer).toBeInTheDocument();
    expect(runTests).not.toBeDisabled();
    expect(reviewer).not.toBeDisabled();
    expect(runTests).toHaveTextContent('Run Tests');
    expect(reviewer).toHaveTextContent('Reviewer');
    // No cancel control while idle.
    expect(screen.queryByTestId('finalize-code-changes-cancel')).not.toBeInTheDocument();
  });

  it('starts a checks-only run when "Run Tests" is clicked', async () => {
    render(<FinalizeButton {...baseProps} />);
    fireEvent.click(screen.getByTestId('finalize-run-tests-button'));
    await waitFor(() => {
      expect(api.startFinalizeRun).toHaveBeenCalledWith('proj-1', 'card-1', { mode: 'checks' });
    });
  });

  it('starts a review-only run when "Reviewer" is clicked', async () => {
    render(<FinalizeButton {...baseProps} />);
    fireEvent.click(screen.getByTestId('finalize-reviewer-button'));
    await waitFor(() => {
      expect(api.startFinalizeRun).toHaveBeenCalledWith('proj-1', 'card-1', { mode: 'review' });
    });
  });

  it('calls startFinalizeRunForSession with the mode when cardId is missing', async () => {
    api.startFinalizeRunForSession.mockResolvedValue({
      run_id: 'run-1',
      status: 'queued',
      reused: false,
      card_id: 'card-new',
      card_created: true,
    });
    render(<FinalizeButton {...baseProps} cardId={null} />);
    fireEvent.click(screen.getByTestId('finalize-run-tests-button'));
    await waitFor(() => {
      expect(api.startFinalizeRunForSession).toHaveBeenCalledWith('proj-1', 'session-1', {
        mode: 'checks',
      });
    });
    expect(api.startFinalizeRun).not.toHaveBeenCalled();
  });

  it('disables both triggers optimistically as soon as a click fires', async () => {
    // Hold the promise open so the optimistic disable is the only effect.
    let resolveStart;
    api.startFinalizeRun.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );
    render(<FinalizeButton {...baseProps} />);
    const runTests = screen.getByTestId('finalize-run-tests-button');
    const reviewer = screen.getByTestId('finalize-reviewer-button');
    expect(runTests).not.toBeDisabled();
    fireEvent.click(runTests);
    await waitFor(() => {
      expect(runTests).toBeDisabled();
      expect(reviewer).toBeDisabled();
    });
    // The clicked button flips to its Stop label during the optimistic window,
    // but stays disabled until the run row (with an id) lands.
    expect(runTests).toHaveTextContent('Stop Tests');
    resolveStart?.({ run_id: 'run-1', status: 'queued', reused: false });
  });

  it('turns the Run Tests button into an enabled "Stop Tests" while a checks run is in flight', () => {
    setHookState({
      run: { id: 'run-99', status: 'running', phase: 'tasks', mode: 'checks' },
      status: 'running',
      phase: 'tasks',
      isActive: true,
      isTerminal: false,
      activeSeconds: 42,
    });
    render(<FinalizeButton {...baseProps} />);
    const runTests = screen.getByTestId('finalize-run-tests-button');
    const reviewer = screen.getByTestId('finalize-reviewer-button');
    // The active phase becomes a Stop button (enabled); the idle phase stays
    // disabled while a run is in flight.
    expect(runTests).toHaveTextContent('Stop Tests');
    expect(runTests).not.toBeDisabled();
    expect(reviewer).toBeDisabled();
    // The standalone cancel control is gone — the trigger button stops the run.
    expect(screen.queryByTestId('finalize-code-changes-cancel')).not.toBeInTheDocument();
  });

  it('turns the Reviewer button into "Stop Reviewing" while a review run is in flight', () => {
    setHookState({
      run: { id: 'run-99', status: 'reviewing', phase: 'review', mode: 'review' },
      status: 'reviewing',
      phase: 'review',
      isActive: true,
      isTerminal: false,
    });
    render(<FinalizeButton {...baseProps} />);
    const reviewer = screen.getByTestId('finalize-reviewer-button');
    expect(reviewer).toHaveTextContent('Stop Reviewing');
    expect(reviewer).not.toBeDisabled();
  });

  it('shows "Tested" only on the Run Tests button when checks passed alone', () => {
    setHookState({
      phases: {
        checks: {
          run_id: 'r1',
          status: 'ready_to_push',
          mode: 'checks',
          validated_head_sha: 'sha1',
        },
        review: null,
      },
    });
    render(<FinalizeButton {...baseProps} />);
    expect(screen.getByTestId('finalize-run-tests-button')).toHaveTextContent('Tested');
    // Review has not run, so the reviewer button stays in its idle label.
    expect(screen.getByTestId('finalize-reviewer-button')).toHaveTextContent('Reviewer');
  });

  it('shows "Reviewed" only on the Reviewer button when review passed alone', () => {
    setHookState({
      phases: {
        checks: null,
        review: {
          run_id: 'r2',
          status: 'ready_to_push',
          mode: 'review',
          validated_head_sha: 'sha1',
        },
      },
    });
    render(<FinalizeButton {...baseProps} />);
    expect(screen.getByTestId('finalize-reviewer-button')).toHaveTextContent('Reviewed');
    expect(screen.getByTestId('finalize-run-tests-button')).toHaveTextContent('Run Tests');
  });

  it('shows both "Tested" and "Reviewed" when both phases passed', () => {
    setHookState({
      phases: {
        checks: { run_id: 'r1', status: 'ready_to_push', mode: 'full', validated_head_sha: 'sha1' },
        review: { run_id: 'r1', status: 'ready_to_push', mode: 'full', validated_head_sha: 'sha1' },
      },
    });
    render(<FinalizeButton {...baseProps} />);
    expect(screen.getByTestId('finalize-run-tests-button')).toHaveTextContent('Tested');
    expect(screen.getByTestId('finalize-reviewer-button')).toHaveTextContent('Reviewed');
  });

  it('resets the Tested badge once a new commit moves HEAD past the validated commit', async () => {
    api.getSessionWorktreeChanges.mockResolvedValue({ committable: true, headSha: 'sha-NEW' });
    setHookState({
      run: { id: 'r1', mode: 'checks', status: 'ready_to_push' },
      status: 'ready_to_push',
      phases: {
        checks: {
          run_id: 'r1',
          status: 'ready_to_push',
          mode: 'checks',
          validated_head_sha: 'sha-OLD',
        },
        review: null,
      },
    });
    render(<FinalizeButton {...baseProps} />);
    // Once the worktree poll resolves, HEAD (sha-NEW) no longer matches the
    // validated commit (sha-OLD), so the stale pass reverts to "Run Tests".
    await waitFor(() => {
      expect(screen.getByTestId('finalize-run-tests-button')).toHaveTextContent('Run Tests');
    });
  });

  it('keeps the Tested badge while HEAD still matches the validated commit', async () => {
    api.getSessionWorktreeChanges.mockResolvedValue({ committable: true, headSha: 'sha-OLD' });
    setHookState({
      run: { id: 'r1', mode: 'checks', status: 'ready_to_push' },
      status: 'ready_to_push',
      phases: {
        checks: {
          run_id: 'r1',
          status: 'ready_to_push',
          mode: 'checks',
          validated_head_sha: 'sha-OLD',
        },
        review: null,
      },
    });
    render(<FinalizeButton {...baseProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('finalize-run-tests-button')).toHaveTextContent('Tested');
    });
  });

  it('calls api.cancelFinalizeRun(projectId, runId) when "Stop Tests" is clicked', async () => {
    setHookState({
      run: { id: 'run-99', status: 'running', phase: 'tasks', mode: 'checks' },
      status: 'running',
      phase: 'tasks',
      isActive: true,
      isTerminal: false,
    });
    render(<FinalizeButton {...baseProps} />);
    fireEvent.click(screen.getByTestId('finalize-run-tests-button'));
    await waitFor(() => {
      expect(api.cancelFinalizeRun).toHaveBeenCalledWith('proj-1', 'run-99');
    });
  });

  it('calls api.cancelFinalizeRun when "Stop Reviewing" is clicked', async () => {
    setHookState({
      run: { id: 'run-77', status: 'reviewing', phase: 'review', mode: 'review' },
      status: 'reviewing',
      phase: 'review',
      isActive: true,
      isTerminal: false,
    });
    render(<FinalizeButton {...baseProps} />);
    fireEvent.click(screen.getByTestId('finalize-reviewer-button'));
    await waitFor(() => {
      expect(api.cancelFinalizeRun).toHaveBeenCalledWith('proj-1', 'run-77');
    });
  });

  it('re-enables the triggers once the run reaches a terminal status', () => {
    setHookState({
      run: { id: 'run-99', status: 'pushed', phase: null, mode: 'full' },
      status: 'pushed',
      phase: null,
      isActive: false,
      isTerminal: true,
    });
    render(<FinalizeButton {...baseProps} />);
    const runTests = screen.getByTestId('finalize-run-tests-button');
    expect(runTests).not.toBeDisabled();
    expect(screen.queryByTestId('finalize-code-changes-cancel')).not.toBeInTheDocument();
  });

  it('forwards api errors to onError', async () => {
    api.startFinalizeRun.mockRejectedValue(new Error('boom'));
    const onError = vi.fn();
    render(<FinalizeButton {...baseProps} onError={onError} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('finalize-run-tests-button'));
    });
    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith('boom');
    });
  });

  it('forwards stop errors to onError', async () => {
    api.cancelFinalizeRun.mockRejectedValue(new Error('cant cancel'));
    const onError = vi.fn();
    setHookState({
      run: { id: 'run-99', status: 'running', phase: 'tasks', mode: 'checks' },
      status: 'running',
      phase: 'tasks',
      isActive: true,
      isTerminal: false,
    });
    render(<FinalizeButton {...baseProps} onError={onError} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('finalize-run-tests-button'));
    });
    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith('cant cancel');
    });
  });

  it('shows Push to GitHub when GitHub is connected', async () => {
    render(<FinalizeButton {...baseProps} />);
    expect(await screen.findByTestId('finalize-push-to-github-button')).toBeInTheDocument();
  });

  it('pushes without a confirm when both phases passed on the same commit', async () => {
    window.confirm = vi.fn(() => true);
    setHookState({
      run: { id: 'run-ready', status: 'ready_to_push', phase: null, mode: 'full' },
      status: 'ready_to_push',
      phase: null,
      isActive: false,
      isTerminal: false,
      phases: {
        checks: {
          run_id: 'run-ready',
          status: 'ready_to_push',
          mode: 'full',
          validated_head_sha: 'sha1',
        },
        review: {
          run_id: 'run-ready',
          status: 'ready_to_push',
          mode: 'full',
          validated_head_sha: 'sha1',
        },
      },
    });
    api.pushFinalizeRun.mockResolvedValue({ ok: true, pr_url: 'https://github.com/x/y/pull/1' });
    render(<FinalizeButton {...baseProps} />);
    const pushBtn = await screen.findByTestId('finalize-push-to-github-button');
    fireEvent.click(pushBtn);
    await waitFor(() => {
      expect(api.pushFinalizeRun).toHaveBeenCalledWith('proj-1', 'run-ready');
    });
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('confirms and force-pushes when only checks passed', async () => {
    window.confirm = vi.fn(() => true);
    setHookState({
      run: { id: 'run-checks', status: 'ready_to_push', phase: null, mode: 'checks' },
      status: 'ready_to_push',
      phase: null,
      isActive: false,
      isTerminal: false,
      phases: {
        checks: {
          run_id: 'run-checks',
          status: 'ready_to_push',
          mode: 'checks',
          validated_head_sha: 'sha1',
        },
        review: null,
      },
    });
    api.pushFinalizeRun.mockResolvedValue({ ok: true, pr_url: 'https://github.com/x/y/pull/1' });
    render(<FinalizeButton {...baseProps} />);
    const pushBtn = await screen.findByTestId('finalize-push-to-github-button');
    fireEvent.click(pushBtn);
    await waitFor(() => {
      expect(window.confirm).toHaveBeenCalled();
    });
    expect(api.pushFinalizeRun).toHaveBeenCalledWith('proj-1', 'run-checks', { force: true });
  });

  it('confirms before pushing when the two phases validated different commits', async () => {
    window.confirm = vi.fn(() => true);
    setHookState({
      run: { id: 'run-review', status: 'ready_to_push', phase: null, mode: 'review' },
      status: 'ready_to_push',
      phase: null,
      isActive: false,
      isTerminal: false,
      phases: {
        checks: {
          run_id: 'run-checks',
          status: 'ready_to_push',
          mode: 'checks',
          validated_head_sha: 'sha1',
        },
        review: {
          run_id: 'run-review',
          status: 'ready_to_push',
          mode: 'review',
          validated_head_sha: 'sha2',
        },
      },
    });
    api.pushFinalizeRun.mockResolvedValue({ ok: true, pr_url: 'https://github.com/x/y/pull/1' });
    render(<FinalizeButton {...baseProps} />);
    const pushBtn = await screen.findByTestId('finalize-push-to-github-button');
    fireEvent.click(pushBtn);
    await waitFor(() => {
      expect(window.confirm).toHaveBeenCalled();
    });
  });

  it('aborts the push when the confirm is dismissed', async () => {
    window.confirm = vi.fn(() => false);
    setHookState({
      run: { id: 'run-checks', status: 'ready_to_push', phase: null, mode: 'checks' },
      status: 'ready_to_push',
      phase: null,
      isActive: false,
      isTerminal: false,
      phases: {
        checks: {
          run_id: 'run-checks',
          status: 'ready_to_push',
          mode: 'checks',
          validated_head_sha: 'sha1',
        },
        review: null,
      },
    });
    render(<FinalizeButton {...baseProps} />);
    const pushBtn = await screen.findByTestId('finalize-push-to-github-button');
    fireEvent.click(pushBtn);
    await waitFor(() => {
      expect(window.confirm).toHaveBeenCalled();
    });
    expect(api.pushFinalizeRun).not.toHaveBeenCalled();
  });

  it('honors the compact variant by applying tighter padding classes', () => {
    render(<FinalizeButton {...baseProps} variant="compact" />);
    const btn = screen.getByTestId('finalize-run-tests-button');
    expect(btn.className).toMatch(/px-2 py-1/);
    expect(btn.className).toMatch(/text-\[11px\]/);
    // Compact variant suppresses the tooltip wrapper.
    expect(btn.getAttribute('title')).toBeNull();
  });

  it('disables both triggers and Push when the worktree has no committable changes', async () => {
    api.getSessionWorktreeChanges.mockResolvedValue({ committable: false });
    render(<FinalizeButton {...baseProps} pendingChanges={null} />);
    const runTests = await screen.findByTestId('finalize-run-tests-button');
    const reviewer = await screen.findByTestId('finalize-reviewer-button');
    const pushBtn = await screen.findByTestId('finalize-push-to-github-button');
    await waitFor(() => {
      expect(runTests).toBeDisabled();
      expect(reviewer).toBeDisabled();
      expect(pushBtn).toBeDisabled();
    });
  });

  it('enables triggers when pendingChanges reports committable work', async () => {
    api.getSessionWorktreeChanges.mockResolvedValue({ committable: false });
    render(
      <FinalizeButton
        {...baseProps}
        pendingChanges={{ branch: 'feature/x', hasUncommitted: true, hasUnpushed: false }}
      />,
    );
    const runTests = await screen.findByTestId('finalize-run-tests-button');
    await waitFor(() => expect(runTests).not.toBeDisabled());
  });

  it('disables Push when there are no code changes, even at ready_to_push', async () => {
    // A validated-but-already-pushed branch has nothing left to push.
    api.getSessionWorktreeChanges.mockResolvedValue({ committable: false });
    setHookState({
      run: { id: 'r1', mode: 'full', status: 'ready_to_push' },
      status: 'ready_to_push',
    });
    render(<FinalizeButton {...baseProps} pendingChanges={null} />);
    const pushBtn = await screen.findByTestId('finalize-push-to-github-button');
    await waitFor(() => expect(pushBtn).toBeDisabled());
  });

  describe('single-job "Run Tests" dropdown', () => {
    it('shows no caret when the config exposes no selectable jobs', async () => {
      api.getFinalizeCiJobs.mockResolvedValue({ version: 1, jobs: [], error: null });
      render(<FinalizeButton {...baseProps} />);
      await screen.findByTestId('finalize-run-tests-button');
      expect(screen.queryByTestId('finalize-run-tests-caret')).not.toBeInTheDocument();
    });

    it('renders a caret and lists jobs (with needs) when v2 jobs exist', async () => {
      api.getFinalizeCiJobs.mockResolvedValue({
        version: 2,
        jobs: [
          { id: 'build', needs: [], warmup: false },
          { id: 'test', needs: ['build'], warmup: false },
        ],
        error: null,
      });
      render(<FinalizeButton {...baseProps} />);
      const caret = await screen.findByTestId('finalize-run-tests-caret');
      fireEvent.click(caret);

      expect(await screen.findByTestId('finalize-run-tests-menu')).toBeInTheDocument();
      expect(screen.getByTestId('finalize-run-job-build')).toBeInTheDocument();
      const testItem = screen.getByTestId('finalize-run-job-test');
      expect(testItem).toHaveTextContent('test');
      expect(testItem).toHaveTextContent('needs build');
    });

    it('running a single job posts mode=checks with that job and never the full suite', async () => {
      api.getFinalizeCiJobs.mockResolvedValue({
        version: 2,
        jobs: [{ id: 'test', needs: ['build'], warmup: false }],
        error: null,
      });
      render(<FinalizeButton {...baseProps} />);
      const caret = await screen.findByTestId('finalize-run-tests-caret');
      fireEvent.click(caret);
      const testItem = await screen.findByTestId('finalize-run-job-test');

      await act(async () => {
        fireEvent.click(testItem);
      });

      expect(api.startFinalizeRun).toHaveBeenCalledWith('proj-1', 'card-1', {
        mode: 'checks',
        jobs: ['test'],
      });
      // The menu closes after selection.
      await waitFor(() =>
        expect(screen.queryByTestId('finalize-run-tests-menu')).not.toBeInTheDocument(),
      );
    });

    it('the main Run Tests button still runs the full suite (no jobs filter)', async () => {
      api.getFinalizeCiJobs.mockResolvedValue({
        version: 2,
        jobs: [{ id: 'test', needs: [], warmup: false }],
        error: null,
      });
      render(<FinalizeButton {...baseProps} />);
      const runTests = await screen.findByTestId('finalize-run-tests-button');
      await act(async () => {
        fireEvent.click(runTests);
      });
      expect(api.startFinalizeRun).toHaveBeenCalledWith('proj-1', 'card-1', { mode: 'checks' });
    });
  });
});
