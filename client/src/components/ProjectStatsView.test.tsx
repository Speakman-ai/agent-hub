import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ProjectStatsView from './ProjectStatsView';
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
});
