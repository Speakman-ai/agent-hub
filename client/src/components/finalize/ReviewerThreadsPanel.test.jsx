/**
 * Tests for the read-only reviewer-threads side-panel.
 *
 * The panel does two REST fetches (latest run for session, then threads
 * for that run) and refetches on `reviewer_thread_added` window events.
 * The api module is mocked so each test drives the panel's branches
 * deterministically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import ReviewerThreadsPanel from './ReviewerThreadsPanel.jsx';
import { api } from '../../utils/api.js';

vi.mock('../../utils/api.js', () => ({
  api: {
    getLatestFinalizeRunForSession: vi.fn(),
    getReviewerThreads: vi.fn(),
  },
}));

function fakeRun(overrides = {}) {
  return {
    id: 'run-1',
    project_id: 'proj-1',
    session_id: 's1',
    status: 'reviewing',
    reviewer_verdict: null,
    started_at: 1,
    ...overrides,
  };
}

function fakeThread(overrides) {
  return {
    id: overrides.id || `t-${Math.random().toString(36).slice(2)}`,
    run_id: 'run-1',
    author: 'reviewer-agent',
    created_at: 1,
    file_path: 'server/foo.ts',
    line_start: 1,
    line_end: 1,
    body: '[5/10] note',
    ...overrides,
  };
}

beforeEach(() => {
  api.getLatestFinalizeRunForSession.mockReset();
  api.getReviewerThreads.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('<ReviewerThreadsPanel />', () => {
  it('renders nothing when there is no finalize run for the session', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValue({ run: null });
    const { container } = render(<ReviewerThreadsPanel sessionId="s-empty" />);
    await waitFor(() => {
      expect(api.getLatestFinalizeRunForSession).toHaveBeenCalledWith('s-empty');
    });
    // Threads fetch must NOT fire when there's no run.
    expect(api.getReviewerThreads).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="reviewer-threads-panel"]')).toBeNull();
  });

  it('renders nothing when sessionId is null', () => {
    const { container } = render(<ReviewerThreadsPanel sessionId={null} />);
    expect(api.getLatestFinalizeRunForSession).not.toHaveBeenCalled();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the run has no verdict and no threads', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValue({ run: fakeRun() });
    api.getReviewerThreads.mockResolvedValue({
      run_id: 'run-1',
      reviewer_verdict: null,
      threads: [],
    });
    const { container } = render(<ReviewerThreadsPanel sessionId="s1" />);
    await waitFor(() => {
      expect(api.getReviewerThreads).toHaveBeenCalledWith('proj-1', 'run-1');
    });
    expect(container.querySelector('[data-testid="reviewer-threads-panel"]')).toBeNull();
  });

  it('renders the approved pill for an approved run even when there are zero findings', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValue({ run: fakeRun() });
    api.getReviewerThreads.mockResolvedValue({
      run_id: 'run-1',
      reviewer_verdict: 'approved',
      threads: [],
    });
    render(<ReviewerThreadsPanel sessionId="s1" />);
    const pill = await screen.findByTestId('reviewer-verdict');
    expect(pill).toHaveAttribute('data-verdict', 'approved');
    expect(screen.getByText(/no findings on this pass/i)).toBeInTheDocument();
  });

  it('groups findings by file_path and renders file-level + ranged anchors', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValue({ run: fakeRun() });
    api.getReviewerThreads.mockResolvedValue({
      run_id: 'run-1',
      reviewer_verdict: 'changes_requested',
      threads: [
        fakeThread({
          id: 't1',
          file_path: 'server/a.ts',
          line_start: null,
          line_end: null,
          body: 'file-level',
        }),
        fakeThread({
          id: 't2',
          file_path: 'server/a.ts',
          line_start: 5,
          line_end: 5,
          body: 'single',
        }),
        fakeThread({
          id: 't3',
          file_path: 'server/a.ts',
          line_start: 10,
          line_end: 14,
          body: 'ranged',
        }),
        fakeThread({
          id: 't4',
          file_path: 'server/b.ts',
          line_start: 2,
          line_end: 2,
          body: 'b-side',
        }),
      ],
    });
    render(<ReviewerThreadsPanel sessionId="s1" />);

    await screen.findByTestId('reviewer-threads-panel');

    const groups = screen.getAllByTestId('reviewer-threads-file-group');
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveAttribute('data-file-path', 'server/a.ts');
    expect(groups[1]).toHaveAttribute('data-file-path', 'server/b.ts');

    // Anchor rendering covers all three null/single/range cases.
    expect(screen.getByText('(file-level note)')).toBeInTheDocument();
    expect(screen.getByText(':5')).toBeInTheDocument();
    expect(screen.getByText(':10-14')).toBeInTheDocument();
    expect(screen.getByText(':2')).toBeInTheDocument();

    // Verdict pill is "changes requested".
    expect(screen.getByTestId('reviewer-verdict')).toHaveAttribute(
      'data-verdict',
      'changes_requested',
    );

    // Footer count matches.
    expect(screen.getByText('4 findings')).toBeInTheDocument();
  });

  it('refetches threads when a reviewer_thread_added event fires for the current run', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValue({ run: fakeRun() });
    api.getReviewerThreads
      .mockResolvedValueOnce({
        run_id: 'run-1',
        reviewer_verdict: null,
        threads: [
          fakeThread({ id: 't1', file_path: 'a.ts', line_start: 1, line_end: 1, body: 'first' }),
        ],
      })
      .mockResolvedValueOnce({
        run_id: 'run-1',
        reviewer_verdict: 'changes_requested',
        threads: [
          fakeThread({ id: 't1', file_path: 'a.ts', line_start: 1, line_end: 1, body: 'first' }),
          fakeThread({ id: 't2', file_path: 'a.ts', line_start: 4, line_end: 4, body: 'second' }),
        ],
      });

    render(<ReviewerThreadsPanel sessionId="s1" />);
    await screen.findByTestId('reviewer-threads-panel');
    expect(screen.getByText('1 finding')).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('reviewer_thread_added', {
          detail: { run_id: 'run-1', thread_id: 't2', file_path: 'a.ts', line_start: 4 },
        }),
      );
    });

    await waitFor(() => {
      expect(api.getReviewerThreads).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByText('2 findings')).toBeInTheDocument();
    });
  });

  it('ignores reviewer_thread_added events for unrelated run ids', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValue({ run: fakeRun() });
    api.getReviewerThreads.mockResolvedValue({
      run_id: 'run-1',
      reviewer_verdict: null,
      threads: [fakeThread({ id: 't1' })],
    });
    render(<ReviewerThreadsPanel sessionId="s1" />);
    await screen.findByTestId('reviewer-threads-panel');
    expect(api.getReviewerThreads).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('reviewer_thread_added', {
          detail: { run_id: 'run-OTHER', thread_id: 'tx' },
        }),
      );
    });
    // Still one call — the unrelated event must not cause a refetch.
    expect(api.getReviewerThreads).toHaveBeenCalledTimes(1);
  });

  it('collapses a file section when the header is clicked, and re-expands on a second click', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValue({ run: fakeRun() });
    api.getReviewerThreads.mockResolvedValue({
      run_id: 'run-1',
      reviewer_verdict: null,
      threads: [
        fakeThread({
          id: 't1',
          file_path: 'a.ts',
          line_start: 1,
          line_end: 1,
          body: 'only finding',
        }),
      ],
    });
    render(<ReviewerThreadsPanel sessionId="s1" />);
    await screen.findByTestId('reviewer-threads-panel');

    // Initially expanded — the thread body is visible.
    expect(screen.getByText('only finding')).toBeInTheDocument();

    const header = screen.getByRole('button', { name: /a\.ts/i });
    fireEvent.click(header);
    expect(screen.queryByText('only finding')).not.toBeInTheDocument();

    fireEvent.click(header);
    expect(screen.getByText('only finding')).toBeInTheDocument();
  });

  it('exposes the run id on the panel root so consumers can match it to lifecycle events', async () => {
    api.getLatestFinalizeRunForSession.mockResolvedValue({ run: fakeRun({ id: 'run-zzz' }) });
    api.getReviewerThreads.mockResolvedValue({
      run_id: 'run-zzz',
      reviewer_verdict: 'approved',
      threads: [],
    });
    render(<ReviewerThreadsPanel sessionId="s1" />);
    const panel = await screen.findByTestId('reviewer-threads-panel');
    expect(panel).toHaveAttribute('data-run-id', 'run-zzz');
  });
});
