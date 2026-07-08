import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ReplaysDashboardPage from './ReplaysDashboardPage';
import { api } from '../utils/api';

// The player modal pulls in a heavy inlined rrweb bundle; stub it.
(vi as any).mock('./ReplayPlayerModal', () => ({ default: () => null }));

(vi as any).mock('../utils/api.js', () => ({
  api: {
    listReplays: vi.fn().mockResolvedValue({
      replays: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
      filter: 'all',
      kind: 'all',
      canViewOrphans: false,
    }),
    listRumSessions: vi.fn().mockResolvedValue({
      sessions: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
    }),
    linkReplayToTicket: vi.fn(),
    unlinkReplay: vi.fn(),
    getSupportTickets: vi.fn().mockResolvedValue([]),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ReplaysDashboardPage', () => {
  it('defaults to the Sessions explorer (session-grain rum_sessions)', async () => {
    render(<ReplaysDashboardPage projectId="proj-1" onNotify={() => {}} />);
    await waitFor(() => expect(api.listRumSessions).toHaveBeenCalled());
    // The capture-grain table must not load until its tab is selected.
    expect(api.listReplays).not.toHaveBeenCalled();
    // Session-explorer chrome is present (time-range picker).
    expect(screen.getByLabelText('Time range')).toBeTruthy();
  });

  it('switches to the capture-grain Replays table on tab click', async () => {
    render(<ReplaysDashboardPage projectId="proj-1" onNotify={() => {}} />);
    await waitFor(() => expect(api.listRumSessions).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Replays' }));

    await waitFor(() => expect(api.listReplays).toHaveBeenCalled());
    // The capture table's kind facet renders once switched.
    expect(screen.getByRole('button', { name: 'Continuous' })).toBeTruthy();
  });
});
