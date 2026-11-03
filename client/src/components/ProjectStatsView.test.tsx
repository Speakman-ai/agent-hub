import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ProjectStatsView, { formatStatsWindow, formatStatsWindowLength } from './ProjectStatsView';
import { api } from '../utils/api';

vi.mock('../utils/api', () => ({
  api: { getProjectStats: vi.fn(), getProjectSessionHistory: vi.fn() },
}));

const getProjectStats = api.getProjectStats as unknown as ReturnType<typeof vi.fn>;
const getProjectSessionHistory = api.getProjectSessionHistory as unknown as ReturnType<
  typeof vi.fn
>;

function statsPayload(prsMerged: number) {
  return {
    granularity: 'day',
    buckets: [{ start: '2026-07-16', label: '2026-07-16' }],
    series: {
      prs_merged: [prsMerged],
      support_tickets_resolved: [0],
      tickets_made: [0],
      tickets_completed: [0],
      epics_completed: [0],
    },
    totals: {
      prs_merged: prsMerged,
      support_tickets_resolved: 0,
      tickets_made: 0,
      tickets_completed: 0,
      epics_completed: 0,
    },
    model_usage: [],
    top_model: null,
  };
}

describe('ProjectStatsView', () => {
  beforeEach(() => {
    getProjectStats.mockReset();
    getProjectSessionHistory.mockReset();
    getProjectSessionHistory.mockResolvedValue({ sessions: [] });
  });

  it('clears stale metrics when a project switch reload fails', async () => {
    // p1 loads successfully with a distinctive PRs-merged total of 7.
    getProjectStats.mockResolvedValueOnce(statsPayload(7));
    const { rerender } = render(
      <ProjectStatsView projects={[{ id: 'p1', name: 'Project One' }]} />,
    );
    await waitFor(() => expect(screen.getByText(/Project One/)).toBeTruthy());
    await waitFor(() => expect(screen.getByText('7')).toBeTruthy());

    // Switch to p2; its reload rejects (transient API failure).
    getProjectStats.mockRejectedValueOnce(new Error('boom'));
    rerender(<ProjectStatsView projects={[{ id: 'p2', name: 'Project Two' }]} />);

    // The header flips to p2, the error banner shows, and — crucially — p1's
    // "7" metric is gone rather than rendered under the p2 header.
    await waitFor(() => expect(screen.getByText(/Project Two/)).toBeTruthy());
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
    expect(screen.queryByText('7')).toBeNull();
  });

  it('renders the covered time window so window-scoped totals are not read as frozen', async () => {
    const payload = {
      ...statsPayload(3),
      buckets: [
        { start: '2026-06-21', label: '2026-06-21' },
        { start: '2026-07-20', label: '2026-07-20' },
      ],
    };
    getProjectStats.mockResolvedValueOnce(payload);
    render(<ProjectStatsView projects={[{ id: 'p1', name: 'Project One' }]} />);
    await waitFor(() =>
      expect(screen.getByText('2 days · Jun 21, 2026 to Jul 20, 2026')).toBeTruthy(),
    );
    expect(screen.getByText('Totals over the last 2 days')).toBeTruthy();
  });
});

describe('formatStatsWindow', () => {
  it('labels a daily window with a day-level date range', () => {
    const buckets = [
      { start: '2026-06-21', label: '2026-06-21' },
      { start: '2026-07-20', label: '2026-07-20' },
    ];
    expect(formatStatsWindow('day', buckets)).toBe('2 days · Jun 21, 2026 to Jul 20, 2026');
  });

  it('labels a monthly window with month/year endpoints across a year boundary', () => {
    const buckets = [
      { start: '2025-08-01', label: '2025-08' },
      { start: '2026-07-01', label: '2026-07' },
    ];
    expect(formatStatsWindow('month', buckets)).toBe('2 months · Aug 2025 to Jul 2026');
  });

  it('collapses to a single endpoint when the window has one bucket', () => {
    expect(formatStatsWindow('week', [{ start: '2026-07-13', label: '2026-07-13' }])).toBe(
      '1 weeks · Jul 13, 2026',
    );
  });

  it('returns empty string for an empty window', () => {
    expect(formatStatsWindow('day', [])).toBe('');
    expect(formatStatsWindowLength('day', [])).toBe('');
  });

  it('formatStatsWindowLength reports only the period length per granularity', () => {
    const b = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ start: `2026-07-${10 + i}`, label: '' }));
    expect(formatStatsWindowLength('day', b(30))).toBe('30 days');
    expect(formatStatsWindowLength('week', b(12))).toBe('12 weeks');
    expect(formatStatsWindowLength('month', b(12))).toBe('12 months');
  });
});

describe('ProjectStatsView session history', () => {
  beforeEach(() => {
    getProjectStats.mockReset();
    getProjectSessionHistory.mockReset();
    getProjectStats.mockResolvedValue(statsPayload(0));
  });

  it('renders session, ticket, PR, review rounds, and CI rounds and wires navigation', async () => {
    getProjectSessionHistory.mockResolvedValue({
      sessions: [
        {
          session_id: 's1',
          agent_id: 'a1',
          title: 'Add history table',
          created_at: '2026-11-02 10:00:00',
          updated_at: '2026-11-02 11:00:00',
          card: { id: 'c1', short_id: 42, card_prefix: 'AH', title: 'History card' },
          pr: { number: 9, url: '/projects/p1/pulls/9', title: 'History PR', status: 'merged' },
          review_rounds: 3,
          finalize_review_rounds: 2,
          pr_reviews: 1,
          ci_rounds: 4,
          ship_seconds: 2 * 3600 + 15 * 60,
          shipped_via: 'merged',
          shipped_at: '2026-11-02T12:15:00.000Z',
        },
      ],
    });
    const onOpenSession = vi.fn();
    const onOpenPr = vi.fn();
    const onOpenCard = vi.fn();
    render(
      <ProjectStatsView
        projects={[{ id: 'p1', name: 'Project One' }]}
        onOpenSession={onOpenSession}
        onOpenPr={onOpenPr}
        onOpenCard={onOpenCard}
      />,
    );
    await waitFor(() => expect(screen.getByText('Add history table')).toBeTruthy());
    expect(getProjectSessionHistory).toHaveBeenCalledWith('p1');
    expect(screen.getByText('AH-42')).toBeTruthy();
    expect(screen.getByText('#9')).toBeTruthy();
    expect(screen.getByText('merged')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('Time to ship')).toBeTruthy();
    expect(screen.getByTestId('session-history-ship-time').textContent).toBe('2h 15m');

    fireEvent.click(screen.getByText('Add history table'));
    expect(onOpenSession).toHaveBeenCalledWith('a1', 's1');
    fireEvent.click(screen.getByText('#9'));
    expect(onOpenPr).toHaveBeenCalledWith('p1', 9);
    fireEvent.click(screen.getByText('AH-42'));
    expect(onOpenCard).toHaveBeenCalledWith('p1', 'c1');
  });

  it('shows an empty state when no work sessions exist', async () => {
    getProjectSessionHistory.mockResolvedValue({ sessions: [] });
    render(<ProjectStatsView projects={[{ id: 'p1', name: 'Project One' }]} />);
    await waitFor(() =>
      expect(
        screen.getByText(/No sessions with a linked ticket, PR, or Finalize run yet/),
      ).toBeTruthy(),
    );
  });

  it('renders an unroutable native PR link as plain text instead of routing it locally', async () => {
    getProjectSessionHistory.mockResolvedValue({
      sessions: [
        {
          session_id: 's2',
          agent_id: 'a1',
          title: 'Cross project',
          created_at: '',
          updated_at: '',
          card: null,
          pr: { number: null, url: '/projects/other/pulls/7', title: null, status: null },
          review_rounds: 0,
          finalize_review_rounds: 0,
          pr_reviews: 0,
          ci_rounds: 0,
          ship_seconds: null,
          shipped_via: null,
          shipped_at: null,
        },
      ],
    });
    const onOpenPr = vi.fn();
    render(<ProjectStatsView projects={[{ id: 'p1', name: 'Project One' }]} onOpenPr={onOpenPr} />);
    await waitFor(() => expect(screen.getByTitle('/projects/other/pulls/7')).toBeTruthy());
    const label = screen.getByTitle('/projects/other/pulls/7');
    expect(label.textContent).toBe('PR');
    expect(label.tagName).toBe('SPAN');
    fireEvent.click(label);
    expect(onOpenPr).not.toHaveBeenCalled();
    // A session that never pushed code leaves the time-to-ship cell empty.
    expect(screen.getByTestId('session-history-ship-time').textContent).toBe('');
  });
});
