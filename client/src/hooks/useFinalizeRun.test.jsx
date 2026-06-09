/**
 * Tests for the `useFinalizeRun` hook — covers initial-load, status/phase
 * mirroring, step-state accumulation, paused/terminal classification, and
 * the helper exports (isFinalizeBlocked, describeRunPhase, formatDuration).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import {
  useFinalizeRun,
  isFinalizeBlocked,
  isTerminalStatus,
  describeRunPhase,
  formatDuration,
} from './useFinalizeRun.js';
import { api } from '../utils/api.js';

vi.mock('../utils/api.js', () => ({
  api: {
    getLatestFinalizeRunForSession: vi.fn(),
  },
}));

function fakeRun(overrides = {}) {
  return {
    id: 'run-1',
    project_id: 'proj-1',
    session_id: 's1',
    status: 'reviewing',
    phase: 'review',
    reviewer_verdict: null,
    failure_reason: null,
    trigger_source: 'ui_button',
    active_seconds_consumed: 60,
    started_at: Date.now() - 120_000,
    ended_at: null,
    pr_url: null,
    ...overrides,
  };
}

/**
 * Headless harness: renders nothing but writes the hook's return value
 * into a ref the tests can assert against. Keeps each test focused on
 * one branch without React-component noise.
 */
function HookProbe({ args, capture }) {
  const value = useFinalizeRun(args);
  capture.current = value;
  return <div data-testid="probe" data-status={value.status || ''} />;
}

beforeEach(() => {
  api.getLatestFinalizeRunForSession.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useFinalizeRun — initial load', () => {
  it('returns null run when sessionId is null and never fetches', async () => {
    const ref = { current: null };
    render(<HookProbe args={{ sessionId: null }} capture={ref} />);
    expect(api.getLatestFinalizeRunForSession).not.toHaveBeenCalled();
    expect(ref.current?.run).toBe(null);
    expect(ref.current?.isActive).toBe(false);
    expect(ref.current?.isPaused).toBe(false);
    expect(ref.current?.isTerminal).toBe(false);
    expect(ref.current?.steps).toEqual([]);
  });

  it('fetches the latest run on mount and exposes phase + status', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValue({ run: fakeRun() });
    const ref = { current: null };
    render(<HookProbe args={{ sessionId: 's1' }} capture={ref} />);
    await waitFor(() => {
      expect(ref.current?.run?.id).toBe('run-1');
    });
    expect(ref.current?.status).toBe('reviewing');
    expect(ref.current?.phase).toBe('review');
    expect(ref.current?.isActive).toBe(true);
    expect(ref.current?.isTerminal).toBe(false);
    expect(ref.current?.isPaused).toBe(false);
  });

  it('skips the round-trip when initialRun matches the session', async () => {
    const ref = { current: null };
    render(
      <HookProbe
        args={{ sessionId: 's1', initialRun: fakeRun({ status: 'rebasing', phase: 'rebase' }) }}
        capture={ref}
      />,
    );
    // initialRun is consumed synchronously on mount.
    expect(ref.current?.status).toBe('rebasing');
    expect(api.getLatestFinalizeRunForSession).not.toHaveBeenCalled();
  });

  it('skips the round-trip when prefetchedRun is a matching FinalizeRunRow', async () => {
    const ref = { current: null };
    render(
      <HookProbe
        args={{
          sessionId: 's1',
          prefetchedRun: fakeRun({ status: 'pushed', phase: 'push' }),
        }}
        capture={ref}
      />,
    );
    expect(ref.current?.status).toBe('pushed');
    expect(api.getLatestFinalizeRunForSession).not.toHaveBeenCalled();
  });

  it('skips the round-trip when prefetchedRun is `null` ("we already checked, no run")', async () => {
    const ref = { current: null };
    render(<HookProbe args={{ sessionId: 's1', prefetchedRun: null }} capture={ref} />);
    expect(ref.current?.run).toBe(null);
    // The whole point of `null` (vs undefined) — caller asserted "no
    // run", we must NOT self-fetch and re-issue the same lookup.
    expect(api.getLatestFinalizeRunForSession).not.toHaveBeenCalled();
  });

  it('falls back to self-fetch when prefetchedRun is for a different session (defensive)', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValue({ run: fakeRun({ session_id: 's2' }) });
    const ref = { current: null };
    render(
      <HookProbe
        args={{ sessionId: 's2', prefetchedRun: fakeRun({ session_id: 'other' }) }}
        capture={ref}
      />,
    );
    await waitFor(() => {
      expect(api.getLatestFinalizeRunForSession).toHaveBeenCalledWith(
        's2',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  it('does NOT skip the round-trip when initialRun is for a different session', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValue({ run: fakeRun({ session_id: 's2' }) });
    const ref = { current: null };
    render(
      <HookProbe
        args={{ sessionId: 's2', initialRun: fakeRun({ session_id: 'other' }) }}
        capture={ref}
      />,
    );
    await waitFor(() => {
      expect(api.getLatestFinalizeRunForSession).toHaveBeenCalledWith(
        's2',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });
});

describe('useFinalizeRun — phase change events', () => {
  it('updates status and phase on finalize_run_phase_changed', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValue({ run: fakeRun() });
    const ref = { current: null };
    render(<HookProbe args={{ sessionId: 's1' }} capture={ref} />);
    await waitFor(() => expect(ref.current?.run?.id).toBe('run-1'));

    api.getLatestFinalizeRunForSession.mockResolvedValueOnce({
      run: fakeRun({ status: 'pushing', phase: 'push' }),
    });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('finalize_run_phase_changed', {
          detail: { run_id: 'run-1', phase: 'push', status: 'pushing' },
        }),
      );
    });
    await waitFor(() => expect(ref.current?.status).toBe('pushing'));
    expect(ref.current?.phase).toBe('push');
  });

  it('falls back to previous phase when a phase-change event omits phase (NB5)', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValue({
      run: fakeRun({ status: 'reviewing', phase: 'review' }),
    });
    const ref = { current: null };
    render(<HookProbe args={{ sessionId: 's1' }} capture={ref} />);
    await waitFor(() => expect(ref.current?.run?.id).toBe('run-1'));

    // Refetch will land a `running` row whose phase is set; the optimistic
    // local update should NOT briefly null the phase between the event
    // and the refetch — that would cause a visible flicker.
    api.getLatestFinalizeRunForSession.mockResolvedValueOnce({
      run: fakeRun({ status: 'running', phase: 'tasks' }),
    });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('finalize_run_phase_changed', {
          detail: { run_id: 'run-1', status: 'running' }, // no `phase`
        }),
      );
    });
    // Status flipped optimistically; phase preserved from prev value
    // (the refetch will resolve to 'tasks' a moment later).
    await waitFor(() => expect(ref.current?.status).toBe('running'));
    // Either 'review' (the pre-event value preserved) or 'tasks' (the
    // refetch resolved) is acceptable — what must NOT happen is `null`.
    expect(ref.current?.phase).not.toBe(null);
  });

  it('ignores phase-change events for an unrelated run', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValue({ run: fakeRun() });
    const ref = { current: null };
    render(<HookProbe args={{ sessionId: 's1' }} capture={ref} />);
    await waitFor(() => expect(ref.current?.run?.id).toBe('run-1'));

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('finalize_run_phase_changed', {
          detail: { run_id: 'run-OTHER', phase: 'push', status: 'pushing' },
        }),
      );
    });
    // No additional fetch; status stays put.
    expect(api.getLatestFinalizeRunForSession).toHaveBeenCalledTimes(1);
    expect(ref.current?.status).toBe('reviewing');
  });
});

describe('useFinalizeRun — step state events', () => {
  it('accumulates step rows in declared order and stamps state transitions', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValue({ run: fakeRun() });
    const ref = { current: null };
    render(<HookProbe args={{ sessionId: 's1' }} capture={ref} />);
    await waitFor(() => expect(ref.current?.run?.id).toBe('run-1'));

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('finalize_run_step_state', {
          detail: { run_id: 'run-1', step_index: 1, step_name: 'lint', state: 'running' },
        }),
      );
    });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('finalize_run_step_state', {
          detail: { run_id: 'run-1', step_index: 2, step_name: 'test', state: 'running' },
        }),
      );
    });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('finalize_run_step_state', {
          detail: {
            run_id: 'run-1',
            step_index: 1,
            step_name: 'lint',
            state: 'passed',
            exit_code: 0,
          },
        }),
      );
    });

    const steps = ref.current?.steps || [];
    expect(steps.map((s) => s.index)).toEqual([1, 2]);
    expect(steps[0].state).toBe('passed');
    expect(steps[0].exitCode).toBe(0);
    expect(steps[0].endedAt).toBeTypeOf('number');
    expect(steps[1].state).toBe('running');
    expect(steps[1].exitCode).toBe(null);
  });

  it('marks a failed step with its non-zero exit code', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValue({ run: fakeRun() });
    const ref = { current: null };
    render(<HookProbe args={{ sessionId: 's1' }} capture={ref} />);
    await waitFor(() => expect(ref.current?.run?.id).toBe('run-1'));

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('finalize_run_step_state', {
          detail: { run_id: 'run-1', step_index: 3, step_name: 'build', state: 'running' },
        }),
      );
    });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('finalize_run_step_state', {
          detail: {
            run_id: 'run-1',
            step_index: 3,
            step_name: 'build',
            state: 'failed',
            exit_code: 2,
          },
        }),
      );
    });

    const step = ref.current?.steps?.find((s) => s.index === 3);
    expect(step?.state).toBe('failed');
    expect(step?.exitCode).toBe(2);
  });

  it('does not let a stale refetch demote a live running step back to queued', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValueOnce({ run: fakeRun() });
    const ref = { current: null };
    render(<HookProbe args={{ sessionId: 's1' }} capture={ref} />);
    await waitFor(() => expect(ref.current?.run?.id).toBe('run-1'));

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('finalize_run_step_state', {
          detail: {
            run_id: 'run-1',
            session_id: 's1',
            step_index: 1,
            step_name: 'lint',
            state: 'running',
          },
        }),
      );
    });
    expect(ref.current?.steps?.[0]?.state).toBe('running');

    api.getLatestFinalizeRunForSession.mockResolvedValueOnce({
      run: fakeRun({ status: 'running', phase: 'tasks' }),
      steps: [{ step_index: 1, name: 'lint', state: 'queued', started_at: null, ended_at: null }],
    });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('finalize_run_phase_changed', {
          detail: { run_id: 'run-1', session_id: 's1', phase: 'tasks', status: 'running' },
        }),
      );
    });

    await waitFor(() => expect(api.getLatestFinalizeRunForSession).toHaveBeenCalledTimes(2));
    expect(ref.current?.steps?.[0]?.state).toBe('running');
  });

  it('promotes a same-session step event for a newer run into the active run state', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValueOnce({
      run: fakeRun({ id: 'old-run', status: 'ready_to_push', phase: null }),
      steps: [
        {
          step_index: 9,
          name: 'old lint',
          state: 'passed',
          exit_code: 0,
          started_at: 100,
          ended_at: 200,
        },
      ],
    });
    const ref = { current: null };
    render(<HookProbe args={{ sessionId: 's1' }} capture={ref} />);
    await waitFor(() => expect(ref.current?.run?.id).toBe('old-run'));
    expect(ref.current?.steps?.map((s) => s.index)).toEqual([9]);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('finalize_run_step_state', {
          detail: {
            run_id: 'new-run',
            session_id: 's1',
            step_index: 1,
            step_name: 'Install dependencies',
            state: 'running',
          },
        }),
      );
    });

    expect(ref.current?.run?.id).toBe('new-run');
    expect(ref.current?.status).toBe('running');
    expect(ref.current?.phase).toBe('tasks');
    expect(ref.current?.steps?.[0]?.state).toBe('running');
    expect(ref.current?.steps?.map((s) => s.index)).toEqual([1]);
  });

  it('ignores step events for unrelated runs', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValue({ run: fakeRun() });
    const ref = { current: null };
    render(<HookProbe args={{ sessionId: 's1' }} capture={ref} />);
    await waitFor(() => expect(ref.current?.run?.id).toBe('run-1'));

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('finalize_run_step_state', {
          detail: { run_id: 'run-zzz', step_index: 1, step_name: 'x', state: 'running' },
        }),
      );
    });
    expect(ref.current?.steps).toEqual([]);
  });
});

describe('useFinalizeRun — active_seconds + paused/terminal classification', () => {
  it('mirrors finalize_run_active_seconds into the run row', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValue({ run: fakeRun() });
    const ref = { current: null };
    render(<HookProbe args={{ sessionId: 's1' }} capture={ref} />);
    await waitFor(() => expect(ref.current?.run?.id).toBe('run-1'));

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('finalize_run_active_seconds', {
          detail: { run_id: 'run-1', active_seconds_consumed: 240 },
        }),
      );
    });
    expect(ref.current?.activeSeconds).toBe(240);
  });

  it('marks dispatching as paused (waiting on session turn-end)', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValue({
      run: fakeRun({ status: 'dispatching', phase: 'dispatching' }),
    });
    const ref = { current: null };
    render(<HookProbe args={{ sessionId: 's1' }} capture={ref} />);
    await waitFor(() => expect(ref.current?.status).toBe('dispatching'));
    expect(ref.current?.isPaused).toBe(true);
    expect(ref.current?.isActive).toBe(true);
    expect(ref.current?.isTerminal).toBe(false);
  });

  it('marks stalled_no_response as paused AND terminal', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValue({
      run: fakeRun({ status: 'stalled_no_response', phase: 'dispatching', ended_at: Date.now() }),
    });
    const ref = { current: null };
    render(<HookProbe args={{ sessionId: 's1' }} capture={ref} />);
    await waitFor(() => expect(ref.current?.status).toBe('stalled_no_response'));
    expect(ref.current?.isPaused).toBe(true);
    expect(ref.current?.isTerminal).toBe(true);
    expect(ref.current?.isActive).toBe(false);
  });

  it('marks pushed (terminal success) as not active, not paused', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValue({
      run: fakeRun({ status: 'pushed', ended_at: Date.now() }),
    });
    const ref = { current: null };
    render(<HookProbe args={{ sessionId: 's1' }} capture={ref} />);
    await waitFor(() => expect(ref.current?.status).toBe('pushed'));
    expect(ref.current?.isTerminal).toBe(true);
    expect(ref.current?.isActive).toBe(false);
    expect(ref.current?.isPaused).toBe(false);
  });

  it('computes wallSeconds from started_at when active, freezes at ended_at when terminal', async () => {
    const start = Date.now() - 90_000;
    api.getLatestFinalizeRunForSession.mockResolvedValue({
      run: fakeRun({ status: 'pushed', started_at: start, ended_at: start + 30_000 }),
    });
    const ref = { current: null };
    render(<HookProbe args={{ sessionId: 's1' }} capture={ref} />);
    await waitFor(() => expect(ref.current?.wallSeconds).toBe(30));
  });
});

describe('useFinalizeRun — re-trigger reuses the panel (no stale rows / timer carry-over)', () => {
  it('replaces (not merges) step rows when a fresh run is created for the same session', async () => {
    // A finished, failed run with two terminal step rows.
    const oldStart = Date.now() - 600_000; // 10m ago
    api.getLatestFinalizeRunForSession.mockResolvedValueOnce({
      run: fakeRun({
        id: 'run-A',
        status: 'failed',
        phase: 'tasks',
        started_at: oldStart,
        ended_at: oldStart + 360_000,
      }),
      steps: [
        {
          step_index: 1,
          name: 'backend',
          state: 'passed',
          exit_code: 0,
          started_at: oldStart,
          ended_at: oldStart + 120_000,
        },
        {
          step_index: 2,
          name: 'e2e',
          state: 'failed',
          exit_code: 1,
          started_at: oldStart + 120_000,
          ended_at: oldStart + 360_000,
        },
      ],
    });
    const ref = { current: null };
    render(<HookProbe args={{ sessionId: 's1' }} capture={ref} />);
    await waitFor(() => expect(ref.current?.run?.id).toBe('run-A'));
    expect(ref.current.steps.map((s) => [s.index, s.state])).toEqual([
      [1, 'passed'],
      [2, 'failed'],
    ]);

    // User re-clicks Finalize → server opens a fresh attempt (run-B) with a
    // new started_at and queued steps. The panel must reset to the fresh
    // run instead of showing the prior run's passed/failed rows.
    const freshStart = Date.now();
    api.getLatestFinalizeRunForSession.mockResolvedValueOnce({
      run: fakeRun({
        id: 'run-B',
        status: 'running',
        phase: 'tasks',
        started_at: freshStart,
        ended_at: null,
      }),
      steps: [
        { step_index: 1, name: 'backend', state: 'queued', started_at: null, ended_at: null },
        { step_index: 2, name: 'e2e', state: 'queued', started_at: null, ended_at: null },
      ],
    });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('finalize_run_created', {
          detail: { run_id: 'run-B', session_id: 's1' },
        }),
      );
    });

    await waitFor(() => expect(ref.current?.run?.id).toBe('run-B'));
    // Rows reflect the FRESH run — no stale passed/failed carried over.
    expect(ref.current.steps.map((s) => [s.index, s.state])).toEqual([
      [1, 'queued'],
      [2, 'queued'],
    ]);
    // No stale per-row durations leaking from the prior run.
    expect(ref.current.steps.every((s) => s.startedAt == null && s.endedAt == null)).toBe(true);
    // Wall clock keys off the fresh run's started_at, not the old run's —
    // the timer resets instead of compounding across attempts.
    expect(ref.current.wallSeconds).toBeLessThan(60);
  });

  it('clears prior rows even when the fresh run reports no steps yet', async () => {
    const oldStart = Date.now() - 300_000;
    api.getLatestFinalizeRunForSession.mockResolvedValueOnce({
      run: fakeRun({
        id: 'run-A',
        status: 'failed',
        started_at: oldStart,
        ended_at: oldStart + 1000,
      }),
      steps: [
        {
          step_index: 1,
          name: 'lint',
          state: 'failed',
          exit_code: 1,
          started_at: oldStart,
          ended_at: oldStart + 1000,
        },
      ],
    });
    const ref = { current: null };
    render(<HookProbe args={{ sessionId: 's1' }} capture={ref} />);
    await waitFor(() => expect(ref.current?.steps?.length).toBe(1));

    api.getLatestFinalizeRunForSession.mockResolvedValueOnce({
      run: fakeRun({
        id: 'run-B',
        status: 'queued',
        phase: null,
        started_at: Date.now(),
        ended_at: null,
      }),
      // No steps array — the run row exists before any step has been reported.
    });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('finalize_run_created', {
          detail: { run_id: 'run-B', session_id: 's1' },
        }),
      );
    });

    await waitFor(() => expect(ref.current?.run?.id).toBe('run-B'));
    expect(ref.current.steps).toEqual([]);
  });
});

describe('useFinalizeRun — created and completed events', () => {
  it('refetches on finalize_run_created when session matches', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValueOnce({ run: null });
    const ref = { current: null };
    render(<HookProbe args={{ sessionId: 's1' }} capture={ref} />);
    await waitFor(() => expect(api.getLatestFinalizeRunForSession).toHaveBeenCalledTimes(1));

    api.getLatestFinalizeRunForSession.mockResolvedValueOnce({ run: fakeRun({ id: 'run-new' }) });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('finalize_run_created', {
          detail: { run_id: 'run-new', session_id: 's1' },
        }),
      );
    });
    await waitFor(() => expect(ref.current?.run?.id).toBe('run-new'));
  });

  it('refetches on finalize_run_completed when run id matches', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValueOnce({ run: fakeRun() });
    const ref = { current: null };
    render(<HookProbe args={{ sessionId: 's1' }} capture={ref} />);
    await waitFor(() => expect(ref.current?.run?.id).toBe('run-1'));

    api.getLatestFinalizeRunForSession.mockResolvedValueOnce({
      run: fakeRun({ status: 'pushed', ended_at: Date.now() }),
    });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('finalize_run_completed', {
          detail: { run_id: 'run-1', status: 'pushed' },
        }),
      );
    });
    await waitFor(() => expect(ref.current?.status).toBe('pushed'));
  });
});

describe('useFinalizeRun — helpers', () => {
  it('isFinalizeBlocked is true for in-flight statuses, false for terminal + null', () => {
    for (const s of ['queued', 'rebasing', 'reviewing', 'running', 'dispatching', 'pushing']) {
      expect(isFinalizeBlocked(s)).toBe(true);
    }
    for (const s of ['pushed', 'failed', 'timed_out', 'cancelled', 'stalled_no_response', null]) {
      expect(isFinalizeBlocked(s)).toBe(false);
    }
  });

  it('isTerminalStatus matches the documented set', () => {
    for (const s of [
      'pushed',
      'failed',
      'timed_out',
      'infra_error',
      'cancelled',
      'stalled_no_response',
    ]) {
      expect(isTerminalStatus(s)).toBe(true);
    }
    for (const s of ['queued', 'rebasing', 'reviewing', null]) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });

  it('describeRunPhase distinguishes running-checks from generic running', () => {
    expect(describeRunPhase('running', 'tasks')).toBe('running checks');
    expect(describeRunPhase('running', 'rebase')).toBe('running');
    expect(describeRunPhase('dispatching')).toBe('awaiting fix');
    expect(describeRunPhase('stalled_no_response')).toBe('stalled');
    expect(describeRunPhase(null)).toBe('idle');
  });

  it('formatDuration handles seconds / minutes / hours and edge cases', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(NaN)).toBe('—');
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(60)).toBe('1m');
    expect(formatDuration(90)).toBe('1m 30s');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(3720)).toBe('1h 2m');
  });
});

describe('useFinalizeRun — probe id', () => {
  it('exposes status on the probe for visual sanity (smoke test)', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValue({ run: fakeRun({ status: 'pushed' }) });
    const ref = { current: null };
    render(<HookProbe args={{ sessionId: 's1' }} capture={ref} />);
    const node = await screen.findByTestId('probe');
    await waitFor(() => expect(node.dataset.status).toBe('pushed'));
  });
});
