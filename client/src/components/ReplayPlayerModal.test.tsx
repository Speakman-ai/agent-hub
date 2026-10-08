import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import ReplayPlayerModal from './ReplayPlayerModal';
import { api } from '../utils/api';

// jsdom doesn't execute srcDoc scripts, so the sandbox never posts its "ready"
// message — which is exactly the production race the iframe `onLoad` start path
// guards against. The API is mocked so streaming (triggered by onLoad /
// readyState) terminates immediately and never reaches the network.
(vi as any).mock('../utils/api.js', () => ({
  api: {
    getReplay: vi.fn(),
    getReplayEvents: vi.fn(),
    getSessionSegments: vi.fn(),
    getSessionSegmentEvents: vi.fn(),
    setReplayRetention: vi.fn(),
    setSessionRetention: vi.fn(),
  },
}));

// A two-view segmented session manifest for the session-grouped player mode.
function twoViewManifest() {
  return {
    sessionId: 'sess-1',
    storageLayout: 'segmented',
    projectId: 'p1',
    segmentCount: 3,
    durationMs: 20_000,
    segments: [
      {
        segmentId: 'a0',
        viewId: 'viewA',
        indexInView: 0,
        hasFullSnapshot: true,
        startTs: 1000,
        endTs: 6000,
        eventCount: 1,
      },
      {
        segmentId: 'a1',
        viewId: 'viewA',
        indexInView: 1,
        hasFullSnapshot: false,
        startTs: 6000,
        endTs: 11000,
        eventCount: 1,
      },
      {
        segmentId: 'b0',
        viewId: 'viewB',
        indexInView: 0,
        hasFullSnapshot: true,
        startTs: 12000,
        endTs: 21000,
        eventCount: 1,
      },
    ],
  };
}

describe('ReplayPlayerModal', () => {
  beforeEach(() => {
    (api.getReplay as any).mockReset().mockResolvedValue({ defaultPageSize: 500, eventCount: 0 });
    (api.getReplayEvents as any)
      .mockReset()
      .mockResolvedValue({ events: [], total: 0, offset: 0, hasMore: false });
    (api.getSessionSegments as any).mockReset().mockResolvedValue(twoViewManifest());
    (api.getSessionSegmentEvents as any)
      .mockReset()
      .mockImplementation((_sid: string, segId: string) =>
        Promise.resolve({ events: [{ type: 2, timestamp: 1 }], segmentId: segId }),
      );
    (api.setReplayRetention as any).mockReset();
    (api.setSessionRetention as any).mockReset();
  });

  it('loads the player from an isolated data: URL with the correct sandbox + CSP', () => {
    render(<ReplayPlayerModal replayId="abc123" title="Replay · crash" onClose={() => {}} />);

    const iframe = screen.getByTestId('replay-player-iframe');

    // Host isolation: the player MUST load via a data: URL (opaque origin,
    // cross-origin to the host app) and MUST NOT use srcDoc (which would inherit
    // the host origin and let the frame reach host DOM/cookies/storage). The
    // SecurityError boundary itself is proven at browser level in
    // e2e/tests/replay-player.spec.ts; this guard pins the wiring that creates it.
    expect(iframe.getAttribute('srcdoc')).toBeNull();
    const src = iframe.getAttribute('src') || '';
    expect(src.startsWith('data:text/html')).toBe(true);

    // Sandbox: allow-scripts allow-same-origin. allow-same-origin here keeps
    // rrweb's nested replay frame same-origin to the data: document's OWN opaque
    // origin (not the host's) so the rebuild lands; dropping it reintroduces the
    // blank-replay bug. The other sandbox restrictions (no top-nav/forms/popups)
    // stay off by omission.
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');

    // The decoded document carries the player root + the no-network CSP.
    const doc = decodeURIComponent(src.replace(/^data:text\/html;charset=utf-8,/, ''));
    expect(doc).toContain('id="root"');
    expect(doc).toContain('rrwebPlayer');
    expect(doc).toContain("connect-src 'none'");
    expect(doc).toContain("default-src 'none'");
  });

  it('shows the title and a loading state before playback', () => {
    render(<ReplayPlayerModal replayId="abc123" title="Replay · crash" onClose={() => {}} />);
    expect(screen.getByText('Replay · crash')).toBeInTheDocument();
    expect(screen.getAllByText(/Loading player|Streaming/i).length).toBeGreaterThan(0);
  });

  it('starts streaming from the iframe onLoad even when no "ready" message arrives', async () => {
    // Regression: previously the only start trigger was the sandbox's "ready"
    // postMessage. If that fired before the parent subscribed (or, as here, is
    // never delivered) the modal hung on "Loading player…" forever. The onLoad
    // handler fires after the sandbox bootstrap has run + subscribed, so it's a
    // race-free start path. We dispatch NO "ready" message — streaming must
    // still begin.
    (api.getReplay as any).mockResolvedValue({ defaultPageSize: 500, eventCount: 3 });
    (api.getReplayEvents as any).mockResolvedValue({
      events: [{ type: 2, timestamp: 1 }],
      total: 1,
      offset: 0,
      hasMore: false,
    });

    render(<ReplayPlayerModal replayId="race-1" onClose={() => {}} />);
    fireEvent.load(screen.getByTestId('replay-player-iframe') as any);

    await waitFor(() => expect(api.getReplay).toHaveBeenCalledWith('race-1'));
    await waitFor(() => expect(api.getReplayEvents).toHaveBeenCalled());
  });

  it('invokes onClose from the close button and the backdrop', () => {
    const onClose = vi.fn();
    render(<ReplayPlayerModal replayId="abc123" onClose={onClose} />);
    fireEvent.click(screen.getByTestId('replay-player-close' as any) as any);
    expect(onClose!).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('replay-player-overlay' as any) as any);
    expect(onClose!).toHaveBeenCalledTimes(2);
  });

  it('invokes onClose on Escape', () => {
    const onClose = vi.fn();
    render(<ReplayPlayerModal replayId="abc123" onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' } as any);
    expect(onClose!).toHaveBeenCalledTimes(1);
  });

  describe('segmented session mode', () => {
    it('stitches a session by fetching the manifest then every segment in order', async () => {
      render(<ReplayPlayerModal sessionId="sess-1" onClose={() => {}} />);
      fireEvent.load(screen.getByTestId('replay-player-iframe') as any);

      await waitFor(() => expect(api.getSessionSegments).toHaveBeenCalledWith('sess-1'));
      await waitFor(() => expect((api.getSessionSegmentEvents as any).mock.calls.length).toBe(3));
      // Fetched in playback order across the view boundary (viewA a0,a1 → viewB b0).
      const order = (api.getSessionSegmentEvents as any).mock.calls.map((c: any[]) => c[1]);
      expect(order).toEqual(['a0', 'a1', 'b0']);
      // Session mode never touches the monolithic events endpoint.
      expect(api.getReplayEvents).not.toHaveBeenCalled();
    });

    it('renders one view-chapter marker per view for cross-boundary seeking', async () => {
      render(<ReplayPlayerModal sessionId="sess-1" onClose={() => {}} />);
      fireEvent.load(screen.getByTestId('replay-player-iframe') as any);

      await waitFor(() => expect(screen.getByTestId('replay-view-chapters')).toBeInTheDocument());
      const chapters = screen.getAllByTestId('replay-view-chapter');
      expect(chapters).toHaveLength(2);
      expect(chapters[0]).toHaveTextContent('View 1');
      expect(chapters[1]).toHaveTextContent('View 2');
      // Clicking a chapter posts a goto without throwing (bootstrap applies it).
      expect(() => fireEvent.click(chapters[1] as any)).not.toThrow();
    });

    it('does not show chapters for a single-view session', async () => {
      (api.getSessionSegments as any).mockResolvedValue({
        sessionId: 'sess-2',
        storageLayout: 'segmented',
        projectId: 'p1',
        segmentCount: 1,
        durationMs: 5000,
        segments: [
          {
            segmentId: 'x0',
            viewId: 'only',
            indexInView: 0,
            hasFullSnapshot: true,
            startTs: 0,
            endTs: 5000,
            eventCount: 1,
          },
        ],
      });
      render(<ReplayPlayerModal sessionId="sess-2" onClose={() => {}} />);
      fireEvent.load(screen.getByTestId('replay-player-iframe') as any);

      await waitFor(() => expect(api.getSessionSegments).toHaveBeenCalledWith('sess-2'));
      await waitFor(() => expect((api.getSessionSegmentEvents as any).mock.calls.length).toBe(1));
      expect(screen.queryByTestId('replay-view-chapters')).not.toBeInTheDocument();
    });
  });

  describe('extended-retention flag', () => {
    it('reflects the loaded flag state (not kept when retainedUntil is null)', async () => {
      (api.getReplay as any).mockResolvedValue({
        defaultPageSize: 500,
        eventCount: 0,
        retainedUntil: null,
      });
      render(<ReplayPlayerModal replayId="abc123" onClose={() => {}} />);
      const btn = await screen.findByTestId('replay-retention-toggle');
      await waitFor(() => expect(btn).toHaveAttribute('aria-checked', 'false'));
      expect(btn).toHaveTextContent(/keep/i);
    });

    it('shows "Kept" when the capture is already flagged', async () => {
      (api.getReplay as any).mockResolvedValue({
        defaultPageSize: 500,
        eventCount: 0,
        retainedUntil: '2099-09-10 09:00:00',
      });
      render(<ReplayPlayerModal replayId="abc123" onClose={() => {}} />);
      const btn = await screen.findByTestId('replay-retention-toggle');
      await waitFor(() => expect(btn).toHaveAttribute('aria-checked', 'true'));
      expect(btn).toHaveTextContent(/kept/i);
    });

    it('flags the capture via setReplayRetention and reflects the new state', async () => {
      (api.getReplay as any).mockResolvedValue({
        defaultPageSize: 500,
        eventCount: 0,
        retainedUntil: null,
      });
      (api.setReplayRetention as any).mockResolvedValue({ retainedUntil: '2099-09-10 09:00:00' });
      render(<ReplayPlayerModal replayId="abc123" onClose={() => {}} />);
      const btn = await screen.findByTestId('replay-retention-toggle');
      await waitFor(() => expect(btn).toHaveAttribute('aria-checked', 'false'));

      fireEvent.click(btn as any);

      await waitFor(() => expect(api.setReplayRetention).toHaveBeenCalledWith('abc123', true));
      await waitFor(() => expect(btn).toHaveAttribute('aria-checked', 'true'));
    });

    it("reads a segmented session's Keep state from the manifest", async () => {
      (api.getSessionSegments as any).mockResolvedValue({
        ...twoViewManifest(),
        retainedUntil: '2099-09-10 09:00:00',
      });
      render(<ReplayPlayerModal sessionId="sess-1" onClose={() => {}} />);
      fireEvent.load(screen.getByTestId('replay-player-iframe') as any);
      const btn = await screen.findByTestId('replay-retention-toggle');
      await waitFor(() => expect(btn).toHaveAttribute('aria-checked', 'true'));
    });

    it('keeps a segmented session via setSessionRetention', async () => {
      (api.getSessionSegments as any).mockResolvedValue({
        ...twoViewManifest(),
        retainedUntil: null,
      });
      (api.setSessionRetention as any).mockResolvedValue({
        sessionId: 'sess-1',
        retainedUntil: '2099-09-10 09:00:00',
      });
      render(<ReplayPlayerModal sessionId="sess-1" onClose={() => {}} />);
      fireEvent.load(screen.getByTestId('replay-player-iframe') as any);
      const btn = await screen.findByTestId('replay-retention-toggle');
      await waitFor(() => expect(api.getSessionSegments).toHaveBeenCalled());

      fireEvent.click(btn as any);

      await waitFor(() => expect(api.setSessionRetention).toHaveBeenCalledWith('sess-1', true));
      await waitFor(() => expect(btn).toHaveAttribute('aria-checked', 'true'));
      expect(api.setReplayRetention).not.toHaveBeenCalled();
    });

    it('offers Retry Keep (extend: true) when reopening a session whose Keep is incomplete', async () => {
      (api.getSessionSegments as any).mockResolvedValue({
        ...twoViewManifest(),
        retainedUntil: '2099-09-10 09:00:00',
        relocationPending: true,
      });
      (api.setSessionRetention as any).mockResolvedValue({
        sessionId: 'sess-1',
        retainedUntil: '2099-09-10 09:00:00',
        relocationPending: false,
      });
      render(<ReplayPlayerModal sessionId="sess-1" onClose={() => {}} />);
      fireEvent.load(screen.getByTestId('replay-player-iframe') as any);
      const btn = await screen.findByTestId('replay-retention-toggle');
      await waitFor(() => expect(btn).toHaveAttribute('data-keep-state', 'pending'));
      expect(btn).toHaveTextContent('Retry Keep');
      expect(btn).toHaveAttribute('aria-checked', 'false');

      fireEvent.click(btn as any);

      await waitFor(() => expect(api.setSessionRetention).toHaveBeenCalledWith('sess-1', true));
      await waitFor(() => expect(btn).toHaveAttribute('data-keep-state', 'kept'));
    });

    it('shows Retry Keep after a partial failure instead of Kept', async () => {
      (api.getSessionSegments as any)
        .mockResolvedValueOnce({ ...twoViewManifest(), retainedUntil: null })
        .mockResolvedValue({
          ...twoViewManifest(),
          retainedUntil: '2099-09-10 09:00:00',
          relocationPending: true,
        });
      (api.setSessionRetention as any).mockRejectedValue(new Error('could not be moved'));
      render(<ReplayPlayerModal sessionId="sess-1" onClose={() => {}} />);
      fireEvent.load(screen.getByTestId('replay-player-iframe') as any);
      const btn = await screen.findByTestId('replay-retention-toggle');
      await waitFor(() => expect(btn).toHaveAttribute('data-keep-state', 'off'));

      fireEvent.click(btn as any);

      await waitFor(() => expect(btn).toHaveAttribute('data-keep-state', 'pending'));
      expect(screen.getByTestId('replay-retention-error')).toHaveTextContent('could not be moved');
    });

    it('treats a lapsed Keep as off and renews it with extend: true', async () => {
      (api.getSessionSegments as any).mockResolvedValue({
        ...twoViewManifest(),
        retainedUntil: '2020-01-01 00:00:00',
      });
      (api.setSessionRetention as any).mockResolvedValue({
        sessionId: 'sess-1',
        retainedUntil: '2099-01-01 00:00:00',
        relocationPending: false,
      });
      render(<ReplayPlayerModal sessionId="sess-1" onClose={() => {}} />);
      fireEvent.load(screen.getByTestId('replay-player-iframe') as any);
      const btn = await screen.findByTestId('replay-retention-toggle');
      await waitFor(() => expect(api.getSessionSegments).toHaveBeenCalled());
      expect(btn).toHaveAttribute('data-keep-state', 'off');

      fireEvent.click(btn as any);

      await waitFor(() => expect(api.setSessionRetention).toHaveBeenCalledWith('sess-1', true));
      await waitFor(() => expect(btn).toHaveAttribute('data-keep-state', 'kept'));
    });

    it('renews a Keep that lapsed while the player sat open, without another render', async () => {
      const start = Date.UTC(2026, 9, 2, 12, 0, 0);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(start);
      try {
        (api.getSessionSegments as any).mockResolvedValue({
          ...twoViewManifest(),
          retainedUntil: '2026-10-02 12:01:00',
        });
        (api.setSessionRetention as any).mockResolvedValue({
          sessionId: 'sess-1',
          retainedUntil: '2027-10-02 12:05:00',
          relocationPending: false,
        });
        render(<ReplayPlayerModal sessionId="sess-1" onClose={() => {}} />);
        fireEvent.load(screen.getByTestId('replay-player-iframe') as any);
        const btn = await screen.findByTestId('replay-retention-toggle');
        await waitFor(() => expect(btn).toHaveAttribute('data-keep-state', 'kept'));
        // Let streaming finish so no stray re-render refreshes the state for us.
        await waitFor(() => expect(api.getSessionSegmentEvents).toHaveBeenCalledTimes(3));
        await act(async () => {
          await new Promise((r) => setTimeout(r, 50));
        });
        expect(btn).toHaveAttribute('data-keep-state', 'kept');

        // The clock crosses retainedUntil; nothing re-renders the component.
        vi.setSystemTime(start + 5 * 60_000);
        fireEvent.click(btn as any);

        await waitFor(() => expect(api.setSessionRetention).toHaveBeenCalledTimes(1));
        expect(api.setSessionRetention).toHaveBeenCalledWith('sess-1', true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('flips the label to Keep on its own when the Keep lapses', async () => {
      // Fake clock and timers (advancing with real time so waitFor still
      // polls): the Keep lapses only when the test says so, not when a slow
      // runner happens to take longer than the retention window to render.
      const start = Date.UTC(2026, 9, 2, 12, 0, 0);
      vi.useFakeTimers({
        toFake: ['Date', 'setTimeout', 'clearTimeout'],
        shouldAdvanceTime: true,
      });
      vi.setSystemTime(start);
      try {
        (api.getSessionSegments as any).mockResolvedValue({
          ...twoViewManifest(),
          retainedUntil: '2026-10-02 12:01:00',
        });
        render(<ReplayPlayerModal sessionId="sess-1" onClose={() => {}} />);
        fireEvent.load(screen.getByTestId('replay-player-iframe') as any);
        const btn = await screen.findByTestId('replay-retention-toggle');
        await waitFor(() => expect(btn).toHaveAttribute('data-keep-state', 'kept'));
        await act(async () => {
          vi.advanceTimersByTime(61_000);
        });
        await waitFor(() => expect(btn).toHaveAttribute('data-keep-state', 'off'));
      } finally {
        vi.useRealTimers();
      }
    });

    it('shows the server error when Keep fails', async () => {
      (api.getSessionSegments as any).mockResolvedValue({
        ...twoViewManifest(),
        retainedUntil: null,
      });
      (api.setSessionRetention as any).mockRejectedValue(new Error('could not be moved'));
      render(<ReplayPlayerModal sessionId="sess-1" onClose={() => {}} />);
      const btn = await screen.findByTestId('replay-retention-toggle');

      fireEvent.click(btn as any);

      expect(await screen.findByTestId('replay-retention-error')).toHaveTextContent(
        'could not be moved',
      );
    });
  });
});
