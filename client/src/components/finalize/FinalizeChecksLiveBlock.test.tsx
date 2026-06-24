import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

(vi as any).mock('../../hooks/useFinalizeRun.js', async () => {
  const actual = await vi.importActual('../../hooks/useFinalizeRun.js');
  return {
    ...actual,
    useFinalizeRun: vi.fn(),
  };
});

import { useFinalizeRun } from '../../hooks/useFinalizeRun';
import FinalizeChecksLiveBlock from './FinalizeChecksLiveBlock';

describe('FinalizeChecksLiveBlock', () => {
  it('renders live step rows during the tasks phase', () => {
    (useFinalizeRun as any).mockReturnValue({
      run: { id: 'run-1', status: 'running', phase: 'tasks' },
      steps: [
        { index: 1, name: 'lint', state: 'passed', exitCode: 0, startedAt: 1, endedAt: 2 },
        { index: 2, name: 'test', state: 'running', exitCode: null, startedAt: 3, endedAt: null },
      ],
      phase: 'tasks',
      status: 'running',
    });

    render(<FinalizeChecksLiveBlock sessionId="sess-1" projectId="proj-1" />);
    expect(screen.getByTestId('finalize-checks-live-block')).toBeInTheDocument();
    expect(screen.getByText('test running…')).toBeInTheDocument();
    expect(screen.getByText('lint')).toBeInTheDocument();
  });

  it('stays visible while a fix is dispatched for a failed checks round', () => {
    (useFinalizeRun as any).mockReturnValue({
      run: { id: 'run-1', status: 'dispatching', phase: 'dispatching' },
      steps: [
        { index: 1, name: 'lint', state: 'passed', exitCode: 0, startedAt: 1, endedAt: 2 },
        { index: 2, name: 'test', state: 'failed', exitCode: 1, startedAt: 3, endedAt: 4 },
      ],
      phase: 'dispatching',
      status: 'dispatching',
      // The hook resolved that this dispatch came from the `tasks` phase.
      awaitingChecksFix: true,
    });

    render(<FinalizeChecksLiveBlock sessionId="sess-1" projectId="proj-1" />);
    expect(screen.getByTestId('finalize-checks-live-block')).toBeInTheDocument();
    expect(screen.getByText('Fixing failed checks…')).toBeInTheDocument();
    expect(screen.getByText('test')).toBeInTheDocument();
  });

  it('does not resurrect the checks box during a review-phase fix dispatch', () => {
    (useFinalizeRun as any).mockReturnValue({
      run: { id: 'run-1', status: 'dispatching', phase: 'dispatching' },
      // All checks passed earlier; this dispatch is for reviewer-requested
      // changes, so the checks box must stay hidden.
      steps: [
        { index: 1, name: 'lint', state: 'passed', exitCode: 0, startedAt: 1, endedAt: 2 },
        { index: 2, name: 'test', state: 'passed', exitCode: 0, startedAt: 3, endedAt: 4 },
      ],
      phase: 'dispatching',
      status: 'dispatching',
      awaitingChecksFix: false,
    });

    const { container } = render(<FinalizeChecksLiveBlock sessionId="sess-1" projectId="proj-1" />);
    expect(container!.firstChild).toBeNull();
  });

  // Reviewer-flagged regression: the common flow is fail checks → dispatch fix
  // → checks pass → reviewer requests changes. A stale `failed` step row from
  // the earlier checks round can linger in the hook's merged step list, so the
  // box must NOT be gated on `steps.some(failed)` — only on the hook's
  // phase-derived `awaitingChecksFix` (false here, since this dispatch came
  // from `review`).
  it('stays hidden on a review dispatch even when a stale failed step row lingers', () => {
    (useFinalizeRun as any).mockReturnValue({
      run: { id: 'run-1', status: 'dispatching', phase: 'dispatching' },
      steps: [
        { index: 1, name: 'lint', state: 'passed', exitCode: 0, startedAt: 1, endedAt: 2 },
        // Stale failure carried over from a prior round that the later passing
        // round never overwrote (e.g. the fix removed/renamed the step).
        { index: 9, name: 'old-e2e', state: 'failed', exitCode: 1, startedAt: 3, endedAt: 4 },
      ],
      phase: 'dispatching',
      status: 'dispatching',
      awaitingChecksFix: false,
    });

    const { container } = render(<FinalizeChecksLiveBlock sessionId="sess-1" projectId="proj-1" />);
    expect(container!.firstChild).toBeNull();
  });

  it('renders nothing when finalize is not running checks', () => {
    (useFinalizeRun as any).mockReturnValue({
      run: { id: 'run-1', status: 'reviewing', phase: 'review' },
      steps: [],
      phase: 'review',
      status: 'reviewing',
    });

    const { container } = render(<FinalizeChecksLiveBlock sessionId="sess-1" projectId="proj-1" />);
    expect(container!.firstChild).toBeNull();
  });
});
