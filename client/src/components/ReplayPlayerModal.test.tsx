import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ReplayPlayerModal from './ReplayPlayerModal';
import { api } from '../utils/api';

// jsdom doesn't execute srcDoc scripts, so the sandbox never posts its "ready"
// message — which is exactly the production race the iframe `onLoad` start path
// guards against. The API is mocked so streaming (triggered by onLoad /
// readyState) terminates immediately and never reaches the network.
(vi as any).mock('../utils/api.js', () => ({
  api: { getReplay: vi.fn(), getReplayEvents: vi.fn() },
}));

describe('ReplayPlayerModal', () => {
  beforeEach(() => {
    (api.getReplay as any).mockReset().mockResolvedValue({ defaultPageSize: 500, eventCount: 0 });
    (api.getReplayEvents as any)
      .mockReset()
      .mockResolvedValue({ events: [], total: 0, offset: 0, hasMore: false });
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
});
