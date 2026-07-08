import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import ReplayCaptureTable from './ReplayCaptureTable';
import { api } from '../utils/api';

// The player modal pulls in a heavy inlined rrweb bundle; stub it (it only
// mounts on "Watch", which these tests don't exercise).
(vi as any).mock('./ReplayPlayerModal', () => ({ default: () => null }));

(vi as any).mock('../utils/api.js', () => ({
  api: {
    listReplays: vi.fn(),
    linkReplayToTicket: vi.fn(),
    unlinkReplay: vi.fn(),
    getSupportTickets: vi.fn().mockResolvedValue([]),
  },
}));

function replay(over: any = {}) {
  return {
    id: 'r1',
    projectId: 'proj-1',
    orphaned: false,
    createdAt: '2026-06-25 12:00:00',
    updatedAt: '2026-06-25 12:00:00',
    captureKind: 'on-error',
    live: false,
    durationMs: 5000,
    eventCount: 42,
    size: 1024,
    uncompressedSize: 4096,
    supportTicketId: null,
    cardId: null,
    pageUrl: 'https://app.example/orders',
    trigger: 'error',
    errorMessage: null,
    meta: null,
    eventsUrl: '/api/replays/r1/events',
    replayRef: '/uploads/replay-r1.json',
    ticket: null,
    ...over,
  };
}

function pageOf(replays: any[], extra: any = {}) {
  return {
    replays,
    total: replays.length,
    limit: 50,
    offset: 0,
    hasMore: false,
    filter: 'all',
    kind: 'all',
    canViewOrphans: false,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ReplayCaptureTable', () => {
  it('renders a LIVE badge for a still-streaming continuous capture', async () => {
    (api.listReplays as any).mockResolvedValue(
      pageOf([replay({ id: 'live1', captureKind: 'continuous', live: true })]),
    );
    render(<ReplayCaptureTable projectId="proj-1" onNotify={() => {}} />);

    await waitFor(() => expect(screen.getByText('LIVE')).toBeTruthy());
    // A finished continuous capture shows the plain "continuous" chip instead.
    expect(screen.queryByText('continuous')).toBeNull();
  });

  it('shows the continuous chip (not LIVE) for a finished continuous capture', async () => {
    (api.listReplays as any).mockResolvedValue(
      pageOf([replay({ id: 'done1', captureKind: 'continuous', live: false })]),
    );
    render(<ReplayCaptureTable projectId="proj-1" onNotify={() => {}} />);

    await waitFor(() => expect(screen.getByText('continuous')).toBeTruthy());
    expect(screen.queryByText('LIVE')).toBeNull();
  });

  it('requests the continuous kind when the facet tab is clicked', async () => {
    (api.listReplays as any).mockResolvedValue(pageOf([replay()]));
    render(<ReplayCaptureTable projectId="proj-1" onNotify={() => {}} />);

    await waitFor(() => expect(api.listReplays).toHaveBeenCalled());
    // Initial load uses the default kind.
    expect((api.listReplays as any).mock.calls[0][1]).toMatchObject({ kind: 'all' });

    fireEvent.click(screen.getByRole('button', { name: 'Continuous' }));

    await waitFor(() =>
      expect(
        (api.listReplays as any).mock.calls.some((c: any[]) => c[1]?.kind === 'continuous'),
      ).toBe(true),
    );
  });

  it('does not strand the loading spinner when a silent live-refresh interleaves with a visible load', async () => {
    vi.useFakeTimers();
    try {
      const deferred = () => {
        let resolve!: (v: any) => void;
        const promise = new Promise<any>((r) => {
          resolve = r;
        });
        return { promise, resolve };
      };

      const livePage = pageOf([replay({ id: 'live1', captureKind: 'continuous', live: true })]);
      const d1 = deferred(); // initial mount load
      const d2 = deferred(); // visible load from the kind-tab change
      const d3 = deferred(); // silent live-refresh poll (left pending)
      (api.listReplays as any)
        .mockReturnValueOnce(d1.promise)
        .mockReturnValueOnce(d2.promise)
        .mockReturnValueOnce(d3.promise);

      render(<ReplayCaptureTable projectId="proj-1" onNotify={() => {}} />);

      // Initial load resolves with a live capture → the 30s poll interval arms.
      await act(async () => {
        d1.resolve(livePage);
      });
      const refreshBtn = screen.getByTitle('Refresh');
      expect(refreshBtn.querySelector('.animate-spin')).toBeNull();

      // Visible load starts (kind change) and stays in flight → spinner shows.
      fireEvent.click(screen.getByRole('button', { name: 'On-error' }));
      expect(refreshBtn.querySelector('.animate-spin')).toBeTruthy();

      // A silent poll fires while the visible load is still pending. Pre-fix it
      // bumped the shared reqSeq and stranded the visible load's loading state.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      // Visible load resolves → loading MUST clear despite the interleaved poll.
      await act(async () => {
        d2.resolve(pageOf([replay({ id: 'e1' })]));
      });
      expect(refreshBtn.querySelector('.animate-spin')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a load error', async () => {
    (api.listReplays as any).mockRejectedValue(new Error('boom'));
    render(<ReplayCaptureTable projectId="proj-1" onNotify={() => {}} />);
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
  });

  it('renders the on-error capture without a continuous/LIVE badge', async () => {
    (api.listReplays as any).mockResolvedValue(pageOf([replay({ id: 'e1' })]));
    const { container } = render(<ReplayCaptureTable projectId="proj-1" onNotify={() => {}} />);
    await waitFor(() => expect(screen.getByText('42')).toBeTruthy());
    const row = within(container).queryByText('LIVE');
    expect(row).toBeNull();
    expect(screen.queryByText('continuous')).toBeNull();
  });
});
