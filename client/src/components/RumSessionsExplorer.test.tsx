import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import RumSessionsExplorer from './RumSessionsExplorer';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: { listRumSessions: vi.fn() },
}));

function session(over: any = {}) {
  return {
    sessionId: 's1',
    projectId: 'proj-1',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_050_000,
    timeSpent: 50_000,
    viewCount: 3,
    actionCount: 7,
    errorCount: 2,
    frustrationCount: 1,
    usrId: 'u1',
    usrEmail: 'ada@example.com',
    usrName: 'Ada',
    usrAttributes: null,
    deviceType: 'Desktop',
    browser: 'Chrome',
    os: 'macOS',
    geoCountry: 'US',
    firstSeenAt: '2026-06-25 12:00:00',
    updatedAt: '2026-06-25 12:00:00',
    ...over,
  };
}

function pageOf(sessions: any[], extra: any = {}) {
  return { sessions, total: sessions.length, limit: 50, offset: 0, hasMore: false, ...extra };
}

/** The filter payload of the most recent listRumSessions call. */
function lastParams(): any {
  const calls = (api.listRumSessions as any).mock.calls;
  return calls[calls.length - 1][1];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RumSessionsExplorer', () => {
  it('renders session-list columns from the rollup row', async () => {
    (api.listRumSessions as any).mockResolvedValue(pageOf([session()]));
    render(<RumSessionsExplorer projectId="proj-1" />);

    await waitFor(() => expect(screen.getByText('ada@example.com')).toBeTruthy());
    expect(screen.getByText('Desktop')).toBeTruthy();
    expect(screen.getByText('Chrome')).toBeTruthy();
    expect(screen.getByText('US')).toBeTruthy();
    // Frustration/error counts render.
    expect(screen.getByText('Views')).toBeTruthy();
  });

  it('applies the default time range (last 24h → a from bound) on mount', async () => {
    (api.listRumSessions as any).mockResolvedValue(pageOf([]));
    render(<RumSessionsExplorer projectId="proj-1" />);

    await waitFor(() => expect(api.listRumSessions).toHaveBeenCalled());
    const params = lastParams();
    expect(typeof params.from).toBe('number');
    // No `to` bound for a lookback-from-now range.
    expect(params.to).toBeUndefined();
  });

  it('does not reload when Apply is clicked with unchanged (empty) filters', async () => {
    (api.listRumSessions as any).mockResolvedValue(pageOf([]));
    render(<RumSessionsExplorer projectId="proj-1" />);
    await waitFor(() => expect(api.listRumSessions).toHaveBeenCalledTimes(1));

    // Apply with no filter changes must be a no-op (no extra request via the
    // applied-keyed effect).
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(api.listRumSessions).toHaveBeenCalledTimes(1);
  });

  it('sends the exact user-email facet after Apply', async () => {
    (api.listRumSessions as any).mockResolvedValue(pageOf([]));
    render(<RumSessionsExplorer projectId="proj-1" />);
    await waitFor(() => expect(api.listRumSessions).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('User email'), {
      target: { value: 'bob@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    await waitFor(() => expect(lastParams().usrEmail).toBe('bob@example.com'));
  });

  it('converts duration seconds inputs into millisecond bounds', async () => {
    (api.listRumSessions as any).mockResolvedValue(pageOf([]));
    render(<RumSessionsExplorer projectId="proj-1" />);
    await waitFor(() => expect(api.listRumSessions).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Min duration (s)'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Max duration (s)'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    await waitFor(() => expect(lastParams().durationMinMs).toBe(5000));
    expect(lastParams().durationMaxMs).toBe(30000);
  });

  it('drops the from bound when the range is set to All time', async () => {
    (api.listRumSessions as any).mockResolvedValue(pageOf([]));
    render(<RumSessionsExplorer projectId="proj-1" />);
    await waitFor(() => expect(api.listRumSessions).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Time range'), { target: { value: 'all' } });

    await waitFor(() => {
      const params = lastParams();
      expect(params.from).toBeUndefined();
      expect(params.to).toBeUndefined();
    });
  });

  it('sends a count lower bound (min errors) after Apply', async () => {
    (api.listRumSessions as any).mockResolvedValue(pageOf([]));
    render(<RumSessionsExplorer projectId="proj-1" />);
    await waitFor(() => expect(api.listRumSessions).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Min errors'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    await waitFor(() => expect(lastParams().errorCountMin).toBe(1));
  });
});
