import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

(vi as any).mock('../../utils/api.js', () => ({
  api: {
    startFinalizeRun: vi.fn(),
    startFinalizeRunForSession: vi.fn(),
    pushFinalizeRun: vi.fn(),
    pushSessionToGithub: vi.fn(),
    cancelFinalizeRun: vi.fn(),
    getSessionWorktreeChanges: vi.fn().mockResolvedValue({ committable: true }),
  },
}));

(vi as any).mock('../../utils/connection.js', () => ({
  getApiBase: () => '/api',
  getAuthHeaders: () => ({}),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

(vi as any).mock('../../hooks/useFinalizeRun.js', async () => {
  const actual = await vi.importActual('../../hooks/useFinalizeRun.js');
  return {
    ...actual,
    useFinalizeRun: vi.fn(),
  };
});

import FinalizeButton, { pushConfirmMessage } from './FinalizeButton';
import { api } from '../../utils/api';
import { useFinalizeRun } from '../../hooks/useFinalizeRun';

const setHookState = (state: any) => {
  (useFinalizeRun as any).mockReturnValue({
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
  pendingChanges: { branch: 'feature/x', hasUncommitted: false, hasUnpushed: true },
};

describe('FinalizeButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fetchMock as any).mockResolvedValue({
      ok: true,
      json: async () => ({ connected: true }) as any,
    });
    setHookState({});
    // Re-establish the default worktree response — `clearAllMocks` wipes
    // call history but NOT implementations, so a per-test override (e.g. the
    // staleness specs that inject a `headSha`) would otherwise leak forward.
    (api.getSessionWorktreeChanges as any).mockResolvedValue({ committable: true });
    (api.startFinalizeRun as any).mockResolvedValue({
      run_id: 'run-1',
      status: 'queued',
      reused: false,
    });
    (api.cancelFinalizeRun as any).mockResolvedValue({ ok: true, status: 'cancelled' } as any);
  });

  it('renders a single enabled "Finalize" button when idle', () => {
    render(<FinalizeButton {...baseProps} />);
    const finalize = screen.getByTestId('finalize-button');
    expect(finalize!).toBeInTheDocument();
    expect(finalize!).not.toBeDisabled();
    expect(finalize!).toHaveTextContent('Finalize');
    // The split "Run Tests" / "Reviewer" buttons are gone.
    expect(screen.queryByTestId('finalize-run-tests-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('finalize-reviewer-button')).not.toBeInTheDocument();
  });

  it('starts a full run when "Finalize" is clicked', async () => {
    render(<FinalizeButton {...baseProps} />);
    fireEvent.click(screen.getByTestId('finalize-button' as any) as any);
    await waitFor(() => {
      expect(api.startFinalizeRun).toHaveBeenCalledWith('proj-1', 'card-1', { mode: 'full' });
    });
  });

  it('calls startFinalizeRunForSession with mode=full when cardId is missing', async () => {
    (api.startFinalizeRunForSession as any).mockResolvedValue({
      run_id: 'run-1',
      status: 'queued',
      reused: false,
      card_id: 'card-new',
      card_created: true,
    });
    render(<FinalizeButton {...baseProps} cardId={null} />);
    fireEvent.click(screen.getByTestId('finalize-button' as any) as any);
    await waitFor(() => {
      expect(api.startFinalizeRunForSession).toHaveBeenCalledWith('proj-1', 'session-1', {
        mode: 'full',
      });
    });
    expect(api.startFinalizeRun).not.toHaveBeenCalled();
  });

  it('disables the trigger optimistically as soon as a click fires', async () => {
    let resolveStart: any;
    (api.startFinalizeRun as any).mockImplementation(
      () =>
        new Promise((resolve: any) => {
          resolveStart = resolve;
        }),
    );
    render(<FinalizeButton {...baseProps} />);
    const finalize = screen.getByTestId('finalize-button');
    expect(finalize!).not.toBeDisabled();
    fireEvent.click(finalize as any);
    await waitFor(() => {
      expect(finalize!).toBeDisabled();
    });
    // It flips to its Stop label during the optimistic window, but stays
    // disabled until the run row (with an id) lands.
    expect(finalize!).toHaveTextContent('Stop Finalize');
    resolveStart?.({ run_id: 'run-1', status: 'queued', reused: false });
  });

  it('turns the button into an enabled "Stop Finalize" while a run is in flight', () => {
    setHookState({
      run: { id: 'run-99', status: 'running', phase: 'tasks', mode: 'full' },
      status: 'running',
      phase: 'tasks',
      isActive: true,
      isTerminal: false,
      activeSeconds: 42,
    });
    render(<FinalizeButton {...baseProps} />);
    const finalize = screen.getByTestId('finalize-button');
    expect(finalize!).toHaveTextContent('Stop Finalize');
    expect(finalize!).not.toBeDisabled();
    expect(screen.queryByTestId('finalize-code-changes-cancel')).not.toBeInTheDocument();
  });

  it('lights up Stop for a review-phase full run too', () => {
    setHookState({
      run: { id: 'run-99', status: 'reviewing', phase: 'review', mode: 'full' },
      status: 'reviewing',
      phase: 'review',
      isActive: true,
      isTerminal: false,
    });
    render(<FinalizeButton {...baseProps} />);
    const finalize = screen.getByTestId('finalize-button');
    expect(finalize!).toHaveTextContent('Stop Finalize');
    expect(finalize!).not.toBeDisabled();
  });

  it('does NOT show "Finalized" when only checks passed (one phase)', () => {
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
    expect(screen.getByTestId('finalize-button')).toHaveTextContent('Finalize');
    expect(screen.getByTestId('finalize-button')).not.toHaveTextContent('Finalized');
  });

  it('shows "Finalized" when both phases passed on the same commit', () => {
    setHookState({
      phases: {
        checks: { run_id: 'r1', status: 'ready_to_push', mode: 'full', validated_head_sha: 'sha1' },
        review: { run_id: 'r1', status: 'ready_to_push', mode: 'full', validated_head_sha: 'sha1' },
      },
    });
    render(<FinalizeButton {...baseProps} />);
    expect(screen.getByTestId('finalize-button')).toHaveTextContent('Finalized');
  });

  it('shows "Finalized" for a ready_to_push full run even when per-phase summaries are absent (pre-poll)', () => {
    // Regression: the prefetch path can deliver a completed `full` run with
    // no `phases`. The button must trust the same fallback `handlePush` uses
    // (readyToPush && mode === 'full'), so it renders "Finalized" instead of
    // an un-finalized "Finalize" while Push would silently skip its confirm.
    // The default worktree mock has no `headSha`, so the poll has not pinned a
    // HEAD yet — the fallback trusts the server's status (no freshness gate).
    setHookState({
      run: { id: 'run-ready', status: 'ready_to_push', phase: null, mode: 'full' },
      status: 'ready_to_push',
      phases: null,
    });
    render(<FinalizeButton {...baseProps} />);
    expect(screen.getByTestId('finalize-button')).toHaveTextContent('Finalized');
  });

  it('does NOT show "Finalized" for a ready_to_push run that is not a full run (no phases)', () => {
    setHookState({
      run: { id: 'run-checks', status: 'ready_to_push', phase: null, mode: 'checks' },
      status: 'ready_to_push',
      phases: null,
    });
    render(<FinalizeButton {...baseProps} />);
    expect(screen.getByTestId('finalize-button')).not.toHaveTextContent('Finalized');
  });

  it('expires the no-phases fallback once HEAD moves past the run-validated commit', async () => {
    // The `phases`-absent fallback must be freshness-gated too: once the
    // worktree poll resolves with a HEAD that does not match the run's
    // validated commit, a new commit has landed — "Finalized" is stale and
    // Push must warn again.
    window.confirm = vi.fn(() => false);
    (api.getSessionWorktreeChanges as any).mockResolvedValue({
      committable: true,
      headSha: 'sha-NEW',
    });
    setHookState({
      run: {
        id: 'run-ready',
        status: 'ready_to_push',
        phase: null,
        mode: 'full',
        validated_head_sha: 'sha-OLD',
      },
      status: 'ready_to_push',
      phases: null,
    });
    render(<FinalizeButton {...baseProps} />);
    // Done-state reverts to "Finalize" after the stale HEAD is detected.
    await waitFor(() => {
      const finalize = screen.getByTestId('finalize-button');
      expect(finalize!).toHaveTextContent('Finalize');
      expect(finalize!).not.toHaveTextContent('Finalized');
    });
    // And Push now demands confirmation instead of a silent confirm-free push.
    const pushBtn = await screen.findByTestId('finalize-push-to-github-button');
    fireEvent.click(pushBtn as any);
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(api.pushFinalizeRun).not.toHaveBeenCalled();
  });

  it('keeps the no-phases fallback Finalized + confirm-free while HEAD matches the run commit', async () => {
    window.confirm = vi.fn(() => true);
    (api.getSessionWorktreeChanges as any).mockResolvedValue({
      committable: true,
      headSha: 'sha-OLD',
    });
    (api.pushFinalizeRun as any).mockResolvedValue({
      ok: true,
      pr_url: 'https://github.com/x/y/pull/1',
    } as any);
    setHookState({
      run: {
        id: 'run-ready',
        status: 'ready_to_push',
        phase: null,
        mode: 'full',
        validated_head_sha: 'sha-OLD',
      },
      status: 'ready_to_push',
      phases: null,
    });
    render(<FinalizeButton {...baseProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('finalize-button')).toHaveTextContent('Finalized');
    });
    const pushBtn = await screen.findByTestId('finalize-push-to-github-button');
    fireEvent.click(pushBtn as any);
    await waitFor(() => {
      expect(api.pushFinalizeRun).toHaveBeenCalledWith('proj-1', 'run-ready');
    });
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('resets the Finalized state once a new commit moves HEAD past the validated commit', async () => {
    (api.getSessionWorktreeChanges as any).mockResolvedValue({
      committable: true,
      headSha: 'sha-NEW',
    });
    setHookState({
      run: { id: 'r1', mode: 'full', status: 'ready_to_push' },
      status: 'ready_to_push',
      phases: {
        checks: {
          run_id: 'r1',
          status: 'ready_to_push',
          mode: 'full',
          validated_head_sha: 'sha-OLD',
        },
        review: {
          run_id: 'r1',
          status: 'ready_to_push',
          mode: 'full',
          validated_head_sha: 'sha-OLD',
        },
      },
    });
    render(<FinalizeButton {...baseProps} />);
    // Once the worktree poll resolves, HEAD (sha-NEW) no longer matches the
    // validated commit (sha-OLD), so the stale pass reverts to "Finalize".
    await waitFor(() => {
      const finalize = screen.getByTestId('finalize-button');
      expect(finalize!).toHaveTextContent('Finalize');
      expect(finalize!).not.toHaveTextContent('Finalized');
    });
  });

  it('keeps the Finalized state while HEAD still matches the validated commit', async () => {
    (api.getSessionWorktreeChanges as any).mockResolvedValue({
      committable: true,
      headSha: 'sha-OLD',
    });
    setHookState({
      run: { id: 'r1', mode: 'full', status: 'ready_to_push' },
      status: 'ready_to_push',
      phases: {
        checks: {
          run_id: 'r1',
          status: 'ready_to_push',
          mode: 'full',
          validated_head_sha: 'sha-OLD',
        },
        review: {
          run_id: 'r1',
          status: 'ready_to_push',
          mode: 'full',
          validated_head_sha: 'sha-OLD',
        },
      },
    });
    render(<FinalizeButton {...baseProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('finalize-button')).toHaveTextContent('Finalized');
    });
  });

  it('calls api.cancelFinalizeRun(projectId, runId) when "Stop Finalize" is clicked', async () => {
    setHookState({
      run: { id: 'run-99', status: 'running', phase: 'tasks', mode: 'full' },
      status: 'running',
      phase: 'tasks',
      isActive: true,
      isTerminal: false,
    });
    render(<FinalizeButton {...baseProps} />);
    fireEvent.click(screen.getByTestId('finalize-button' as any) as any);
    await waitFor(() => {
      expect(api.cancelFinalizeRun).toHaveBeenCalledWith('proj-1', 'run-99');
    });
  });

  it('re-enables the trigger once the run reaches a terminal status', () => {
    setHookState({
      run: { id: 'run-99', status: 'pushed', phase: null, mode: 'full' },
      status: 'pushed',
      phase: null,
      isActive: false,
      isTerminal: true,
    });
    render(<FinalizeButton {...baseProps} />);
    expect(screen.getByTestId('finalize-button')).not.toBeDisabled();
    expect(screen.queryByTestId('finalize-code-changes-cancel')).not.toBeInTheDocument();
  });

  it('forwards api errors to onError', async () => {
    (api.startFinalizeRun as any).mockRejectedValue(new Error('boom'));
    const onError = vi.fn();
    render(<FinalizeButton {...baseProps} onError={onError} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('finalize-button' as any) as any);
    });
    await waitFor(() => {
      expect(onError!).toHaveBeenCalledWith('boom');
    });
  });

  it('forwards stop errors to onError', async () => {
    (api.cancelFinalizeRun as any).mockRejectedValue(new Error('cant cancel'));
    const onError = vi.fn();
    setHookState({
      run: { id: 'run-99', status: 'running', phase: 'tasks', mode: 'full' },
      status: 'running',
      phase: 'tasks',
      isActive: true,
      isTerminal: false,
    });
    render(<FinalizeButton {...baseProps} onError={onError} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('finalize-button' as any) as any);
    });
    await waitFor(() => {
      expect(onError!).toHaveBeenCalledWith('cant cancel');
    });
  });

  it('shows Push changes when GitHub is connected', async () => {
    render(<FinalizeButton {...baseProps} />);
    const pushBtn = await screen.findByTestId('finalize-push-to-github-button');
    expect(pushBtn).toHaveTextContent('Push changes');
  });

  it('shows Push changes for hosted projects even without GitHub OAuth', async () => {
    (fetchMock as any).mockResolvedValue({
      ok: true,
      json: async () => ({ connected: false }) as any,
    });
    render(<FinalizeButton {...baseProps} hosted />);
    const pushBtn = await screen.findByTestId('finalize-push-to-github-button');
    expect(pushBtn).toBeInTheDocument();
    expect(pushBtn).toHaveTextContent('Push changes');
  });

  it('hides Push for GitHub-backed projects when GitHub is not connected', async () => {
    (fetchMock as any).mockResolvedValue({
      ok: true,
      json: async () => ({ connected: false }) as any,
    });
    render(<FinalizeButton {...baseProps} hosted={false} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('finalize-push-to-github-button')).not.toBeInTheDocument();
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
    (api.pushFinalizeRun as any).mockResolvedValue({
      ok: true,
      pr_url: 'https://github.com/x/y/pull/1',
    } as any);
    render(<FinalizeButton {...baseProps} />);
    const pushBtn = await screen.findByTestId('finalize-push-to-github-button');
    fireEvent.click(pushBtn as any);
    await waitFor(() => {
      expect(api.pushFinalizeRun).toHaveBeenCalledWith('proj-1', 'run-ready');
    });
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('treats push-step infra_error with validated_head_sha as still finalized', async () => {
    // Auto-push can fail after gates (stale lease, etc.) and leave the run at
    // infra_error while validated_head_sha remains — Push must not warn that
    // Finalize never ran.
    window.confirm = vi.fn(() => true);
    setHookState({
      run: {
        id: 'run-push-fail',
        status: 'infra_error',
        phase: 'push',
        mode: 'full',
        validated_head_sha: 'sha1',
      },
      status: 'infra_error',
      phase: 'push',
      isActive: false,
      isTerminal: true,
      phases: {
        checks: {
          run_id: 'run-push-fail',
          status: 'infra_error',
          mode: 'full',
          validated_head_sha: 'sha1',
        },
        review: {
          run_id: 'run-push-fail',
          status: 'infra_error',
          mode: 'full',
          validated_head_sha: 'sha1',
        },
      },
    });
    (api.pushFinalizeRun as any).mockResolvedValue({
      ok: true,
      pr_url: '/projects/proj-1/pulls/1',
    } as any);
    render(<FinalizeButton {...baseProps} />);
    expect(screen.getByTestId('finalize-button').textContent).toMatch(/Finalized/);
    const pushBtn = await screen.findByTestId('finalize-push-to-github-button');
    fireEvent.click(pushBtn as any);
    await waitFor(() => {
      expect(api.pushFinalizeRun).toHaveBeenCalledWith('proj-1', 'run-push-fail');
    });
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('pushes without a confirm for a ready_to_push full run with no per-phase summaries', async () => {
    // Same fallback as the button's "Finalized" state: a completed full run
    // delivered without `phases` is still treated as fully validated, so Push
    // does not warn.
    window.confirm = vi.fn(() => true);
    setHookState({
      run: { id: 'run-ready', status: 'ready_to_push', phase: null, mode: 'full' },
      status: 'ready_to_push',
      phase: null,
      isActive: false,
      isTerminal: false,
      phases: null,
    });
    (api.pushFinalizeRun as any).mockResolvedValue({
      ok: true,
      pr_url: 'https://github.com/x/y/pull/1',
    } as any);
    render(<FinalizeButton {...baseProps} />);
    const pushBtn = await screen.findByTestId('finalize-push-to-github-button');
    fireEvent.click(pushBtn as any);
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
    (api.pushFinalizeRun as any).mockResolvedValue({
      ok: true,
      pr_url: 'https://github.com/x/y/pull/1',
    } as any);
    render(<FinalizeButton {...baseProps} />);
    const pushBtn = await screen.findByTestId('finalize-push-to-github-button');
    fireEvent.click(pushBtn as any);
    await waitFor(() => {
      expect(window.confirm).toHaveBeenCalled();
    });
    expect(api.pushFinalizeRun).toHaveBeenCalledWith('proj-1', 'run-checks', { force: true });
  });

  it('confirms before pushing when the two phases validated different commits', async () => {
    window.confirm = vi.fn(() => true);
    setHookState({
      run: { id: 'run-review', status: 'ready_to_push', phase: null, mode: 'full' },
      status: 'ready_to_push',
      phase: null,
      isActive: false,
      isTerminal: false,
      phases: {
        checks: {
          run_id: 'run-checks',
          status: 'ready_to_push',
          mode: 'full',
          validated_head_sha: 'sha1',
        },
        review: {
          run_id: 'run-review',
          status: 'ready_to_push',
          mode: 'full',
          validated_head_sha: 'sha2',
        },
      },
    });
    (api.pushFinalizeRun as any).mockResolvedValue({
      ok: true,
      pr_url: 'https://github.com/x/y/pull/1',
    } as any);
    render(<FinalizeButton {...baseProps} />);
    const pushBtn = await screen.findByTestId('finalize-push-to-github-button');
    fireEvent.click(pushBtn as any);
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
    fireEvent.click(pushBtn as any);
    await waitFor(() => {
      expect(window.confirm).toHaveBeenCalled();
    });
    expect(api.pushFinalizeRun).not.toHaveBeenCalled();
  });

  it('honors the compact variant by applying tighter padding classes', () => {
    render(<FinalizeButton {...baseProps} variant="compact" />);
    const btn = screen.getByTestId('finalize-button');
    expect(btn!.className).toMatch(/px-2 py-1/);
    expect(btn!.className).toMatch(/text-\[11px\]/);
    // Compact variant suppresses the tooltip wrapper.
    expect(btn!.getAttribute('title')).toBeNull();
  });

  it('disables the trigger and Push when the worktree has no committable changes', async () => {
    (api.getSessionWorktreeChanges as any).mockResolvedValue({ committable: false });
    render(<FinalizeButton {...baseProps} pendingChanges={null} />);
    const finalize = await screen.findByTestId('finalize-button');
    const pushBtn = await screen.findByTestId('finalize-push-to-github-button');
    await waitFor(() => {
      expect(finalize!).toBeDisabled();
      expect(pushBtn!).toBeDisabled();
    });
  });

  it('enables the trigger when pendingChanges reports committable work', async () => {
    (api.getSessionWorktreeChanges as any).mockResolvedValue({ committable: false });
    render(
      <FinalizeButton
        {...baseProps}
        pendingChanges={{ branch: 'feature/x', hasUncommitted: false, hasUnpushed: true }}
      />,
    );
    const finalize = await screen.findByTestId('finalize-button');
    await waitFor(() => expect(finalize!).not.toBeDisabled());
  });

  // Regression: an agent that edited files but never committed left the trigger
  // enabled, so Finalize ran a full review + CI cycle and ended at "no commits
  // on this branch, so nothing would ship" beside a Changes badge counting
  // those files. Refuse up front, and say why.
  it('disables the trigger for uncommitted-only work and explains it in the hint', async () => {
    (api.getSessionWorktreeChanges as any).mockResolvedValue({
      committable: false,
      hasUncommitted: true,
      hasUnpushed: false,
      branch: 'feature/x',
    });
    render(
      <FinalizeButton
        {...baseProps}
        pendingChanges={{ branch: 'feature/x', hasUncommitted: true, hasUnpushed: false }}
      />,
    );
    const finalize = await screen.findByTestId('finalize-button');
    await waitFor(() => expect(finalize!).toBeDisabled());
    expect(finalize!.getAttribute('title')).toMatch(/uncommitted changes but no commits/i);
  });

  it('disables Push when there are no code changes, even at ready_to_push', async () => {
    // A validated-but-already-pushed branch has nothing left to push.
    (api.getSessionWorktreeChanges as any).mockResolvedValue({ committable: false });
    setHookState({
      run: { id: 'r1', mode: 'full', status: 'ready_to_push' },
      status: 'ready_to_push',
    });
    render(<FinalizeButton {...baseProps} pendingChanges={null} />);
    const pushBtn = await screen.findByTestId('finalize-push-to-github-button');
    await waitFor(() => expect(pushBtn!).toBeDisabled());
  });
});

describe('pushConfirmMessage', () => {
  it('warns about opening a new PR for a normal session', () => {
    const msg = pushConfirmMessage(false);
    expect(msg!).toContain('open PR on GitHub');
    expect(msg!).not.toContain('existing pull request');
  });

  it('warns about pushing to the existing PR for a resolve session', () => {
    const msg = pushConfirmMessage(true);
    expect(msg!).toContain('existing pull request');
    expect(msg!).not.toContain('open PR on GitHub');
  });
});
