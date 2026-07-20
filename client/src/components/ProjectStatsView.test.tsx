import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ProjectStatsView, { formatStatsWindow, formatStatsWindowLength } from './ProjectStatsView';
import { api } from '../utils/api';

vi.mock('../utils/api', () => ({
  api: { getProjectStats: vi.fn() },
}));

const getProjectStats = api.getProjectStats as unknown as ReturnType<typeof vi.fn>;

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
