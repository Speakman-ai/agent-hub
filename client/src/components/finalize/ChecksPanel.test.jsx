/**
 * Tests for the full <ChecksPanel /> mounted in the session view.
 *
 * The `useFinalizeRun` hook is mocked here so each test drives a fixed
 * shape; the embedded <ReviewerThreadsPanel /> talks to `api.*`, which
 * is mocked to return `{run: null}` so the sidecar stays out of the
 * way unless a test explicitly exercises it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ChecksPanel from './ChecksPanel.jsx';

vi.mock('../../hooks/useFinalizeRun.js', async () => {
  const actual = await vi.importActual('../../hooks/useFinalizeRun.js');
  return {
    ...actual,
    useFinalizeRun: vi.fn(),
  };
});

vi.mock('../../utils/api.js', () => ({
  api: {
    getLatestFinalizeRunForSession: vi.fn().mockResolvedValue({ run: null }),
    getFinalizeStepOutput: vi.fn().mockResolvedValue({ lines: [] }),
    getFinalizeRunResources: vi.fn().mockResolvedValue({ jobs: [] }),
    getReviewerThreads: vi.fn().mockResolvedValue({
      run_id: 'run-1',
      reviewer_verdict: null,
      threads: [],
    }),
  },
}));

import { useFinalizeRun } from '../../hooks/useFinalizeRun.js';
import { api } from '../../utils/api.js';

function setHook(overrides = {}) {
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
    ...overrides,
  });
}

function fakeRun(overrides = {}) {
  return {
    id: 'run-1',
    project_id: 'proj-1',
    session_id: 's1',
    status: 'reviewing',
    phase: 'review',
    trigger_source: 'ui_button',
    failure_reason: null,
    started_at: 1,
    ended_at: null,
    pr_url: null,
    ...overrides,
  };
}

beforeEach(() => {
  useFinalizeRun.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('<ChecksPanel />', () => {
  it('does not render the run panel when there is no finalize run', () => {
    setHook({ run: null });
    const { container } = render(<ChecksPanel sessionId="s1" />);
    expect(container.querySelector('[data-testid="finalize-checks-panel"]')).toBeNull();
  });

  it('renders the phase pill and both active and wall clocks distinctly labelled', () => {
    setHook({
      run: fakeRun(),
      phase: 'review',
      status: 'reviewing',
      isActive: true,
      activeSeconds: 240,
      wallSeconds: 360,
    });
    render(<ChecksPanel sessionId="s1" />);
    const panel = screen.getByTestId('finalize-checks-panel');
    expect(panel).toHaveAttribute('data-status', 'reviewing');
    expect(panel).toHaveAttribute('data-phase', 'review');
    expect(screen.getByTestId('finalize-run-phase-pill').textContent).toMatch(/reviewing/);

    // Active and wall are BOTH on screen — the acceptance criterion.
    const active = screen.getByTestId('finalize-run-active');
    const wall = screen.getByTestId('finalize-run-wall');
    expect(active.textContent).toMatch(/active/);
    expect(active.textContent).toMatch(/4m/);
    expect(wall.textContent).toMatch(/wall/);
    expect(wall.textContent).toMatch(/6m/);

    // Active tooltip explains it fires the 60-min cap.
    expect(active.getAttribute('title')).toMatch(/4-hour cap/);
  });

  it('surfaces the pause indicator when the run is waiting on session turn-end', () => {
    setHook({
      run: fakeRun({ status: 'dispatching', phase: 'dispatching' }),
      status: 'dispatching',
      phase: 'dispatching',
      isActive: true,
      isPaused: true,
      activeSeconds: 100,
      wallSeconds: 500,
    });
    render(<ChecksPanel sessionId="s1" />);
    expect(screen.getByTestId('finalize-checks-panel')).toHaveAttribute('data-paused', 'true');
    expect(screen.getByTestId('finalize-run-pause-indicator')).toBeInTheDocument();
    expect(screen.getByTestId('finalize-run-pause-indicator').textContent).toMatch(
      /waiting on session/i,
    );
  });

  it('does not show the pause indicator when the run is actively progressing', () => {
    setHook({
      run: fakeRun({ status: 'running', phase: 'tasks' }),
      status: 'running',
      phase: 'tasks',
      isActive: true,
      isPaused: false,
      activeSeconds: 30,
      wallSeconds: 30,
    });
    render(<ChecksPanel sessionId="s1" />);
    expect(screen.queryByTestId('finalize-run-pause-indicator')).toBeNull();
  });

  it('renders an empty-steps placeholder until the first finalize_run_step_state arrives', () => {
    setHook({
      run: fakeRun(),
      status: 'reviewing',
      phase: 'review',
      activeSeconds: 1,
      wallSeconds: 2,
      isActive: true,
      steps: [],
    });
    render(<ChecksPanel sessionId="s1" />);
    expect(screen.getByTestId('finalize-steps-empty')).toBeInTheDocument();
  });

  it('renders one row per declared step, with state, exit code, and deep-link', () => {
    setHook({
      run: fakeRun({ status: 'running', phase: 'tasks' }),
      status: 'running',
      phase: 'tasks',
      isActive: true,
      activeSeconds: 200,
      wallSeconds: 220,
      steps: [
        {
          index: 1,
          name: 'lint',
          state: 'passed',
          exitCode: 0,
          startedAt: 1000,
          endedAt: 13000,
        },
        {
          index: 2,
          name: 'test',
          state: 'running',
          exitCode: null,
          startedAt: 14000,
          endedAt: null,
        },
        {
          index: 3,
          name: 'build',
          state: 'queued',
          exitCode: null,
          startedAt: null,
          endedAt: null,
        },
      ],
    });
    render(<ChecksPanel sessionId="s1" />);

    const rows = screen.getAllByTestId('finalize-step-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute('data-step-state', 'passed');
    expect(rows[1]).toHaveAttribute('data-step-state', 'running');
    expect(rows[2]).toHaveAttribute('data-step-state', 'queued');

    // Exit code is shown for the finished row only.
    const exitCodes = screen.getAllByTestId('finalize-step-exit-code');
    expect(exitCodes).toHaveLength(1);
    expect(exitCodes[0].textContent).toMatch(/exit 0/);

    // Every row carries the deep-link affordance.
    const jumps = screen.getAllByTestId('finalize-step-jump');
    expect(jumps).toHaveLength(3);
    expect(jumps[0].textContent).toMatch(/view logs/i);
  });

  it('dispatches log modal open when view logs is clicked', async () => {
    setHook({
      run: fakeRun({ status: 'running', phase: 'tasks', project_id: 'proj-1' }),
      status: 'running',
      phase: 'tasks',
      isActive: true,
      activeSeconds: 1,
      wallSeconds: 1,
      steps: [
        {
          index: 4,
          name: 'typecheck',
          state: 'failed',
          exitCode: 1,
          startedAt: 1000,
          endedAt: 6000,
        },
      ],
    });
    api.getFinalizeStepOutput.mockResolvedValue({
      run_id: 'run-1',
      step_index: 4,
      lines: [{ stream: 'stderr', text: 'error TS2304', created_at: '2026-05-29T12:00:00.000Z' }],
    });
    render(<ChecksPanel sessionId="s1" projectId="proj-1" />);
    fireEvent.click(screen.getByTestId('finalize-step-jump'));
    expect(await screen.findByTestId('finalize-step-log-modal')).toBeInTheDocument();
    expect(await screen.findByText('error TS2304')).toBeInTheDocument();
  });

  it('renders trigger source = "agent block" when triggered from inside a session', () => {
    setHook({
      run: fakeRun({ trigger_source: 'agent_block' }),
      status: 'reviewing',
      phase: 'review',
      activeSeconds: 0,
      wallSeconds: 0,
      isActive: true,
    });
    render(<ChecksPanel sessionId="s1" />);
    expect(screen.getByTestId('finalize-run-trigger').textContent).toMatch(/agent block/);
  });

  it('renders an unknown trigger_source verbatim instead of mislabelling it (NB4)', () => {
    // Future server might learn about a new trigger source ahead of the
    // client; the v1 mapping defaulted everything-not-agent_block to "UI
    // button", which would silently mislabel. NB4 fix: pass through.
    setHook({
      run: fakeRun({ trigger_source: 'webhook_event' }),
      status: 'reviewing',
      phase: 'review',
      activeSeconds: 0,
      wallSeconds: 0,
      isActive: true,
    });
    render(<ChecksPanel sessionId="s1" />);
    expect(screen.getByTestId('finalize-run-trigger').textContent).toMatch(/webhook event/);
    expect(screen.getByTestId('finalize-run-trigger').textContent).not.toMatch(/UI button/);
  });

  it('renders the failure_reason chip on a terminal failure', () => {
    setHook({
      run: fakeRun({ status: 'failed', failure_reason: 'step_failed_after_retries' }),
      status: 'failed',
      phase: 'tasks',
      isTerminal: true,
      activeSeconds: 600,
      wallSeconds: 700,
    });
    render(<ChecksPanel sessionId="s1" />);
    expect(screen.getByTestId('finalize-run-failure-code').textContent).toBe(
      'step_failed_after_retries',
    );
  });

  it('explains review_failed with no CI steps in the empty-steps panel', () => {
    setHook({
      run: fakeRun({ status: 'failed', failure_reason: 'review_failed', phase: 'review' }),
      status: 'failed',
      phase: 'review',
      steps: [],
      isTerminal: true,
      activeSeconds: 97,
      wallSeconds: 109,
    });
    render(<ChecksPanel sessionId="s1" />);
    const empty = screen.getByTestId('finalize-steps-empty');
    expect(empty.textContent).toMatch(/Review failed before CI steps ran/);
    expect(empty.textContent).toMatch(/agenthub:review-verdict/);
  });

  it('renders a PR link when the run has pushed', () => {
    setHook({
      run: fakeRun({ status: 'pushed', pr_url: 'https://github.com/x/y/pull/42' }),
      status: 'pushed',
      phase: 'push',
      isTerminal: true,
      activeSeconds: 800,
      wallSeconds: 900,
    });
    render(<ChecksPanel sessionId="s1" />);
    const link = screen.getByTestId('finalize-run-pr-link');
    expect(link).toHaveAttribute('href', 'https://github.com/x/y/pull/42');
  });

  it('renders nothing in embedded mode when there is no finalize run', () => {
    setHook({ run: null });
    const { container } = render(<ChecksPanel sessionId="s1" variant="embedded" />);
    expect(container.firstChild).toBeNull();
  });

  it('marks embedded variant on the panel when a run exists', () => {
    setHook({
      run: fakeRun(),
      status: 'reviewing',
      phase: 'review',
      isActive: true,
      activeSeconds: 1,
      wallSeconds: 2,
    });
    render(<ChecksPanel sessionId="s1" variant="embedded" />);
    expect(screen.getByTestId('finalize-checks-panel')).toHaveAttribute('data-variant', 'embedded');
  });
});
