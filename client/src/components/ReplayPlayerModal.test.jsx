import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ReplayPlayerModal from './ReplayPlayerModal.jsx';
import { api } from '../utils/api.js';

// jsdom doesn't execute srcDoc scripts, so the sandbox never posts its "ready"
// message — which is exactly the production race the iframe `onLoad` start path
// guards against. The API is mocked so streaming (triggered by onLoad /
// readyState) terminates immediately and never reaches the network.
vi.mock('../utils/api.js', () => ({
  api: { getReplay: vi.fn(), getReplayEvents: vi.fn() },
}));

describe('ReplayPlayerModal', () => {
  beforeEach(() => {
    api.getReplay.mockReset().mockResolvedValue({ defaultPageSize: 500, eventCount: 0 });
    api.getReplayEvents
      .mockReset()
      .mockResolvedValue({ events: [], total: 0, offset: 0, hasMore: false });
  });

  it('renders a sandboxed allow-scripts iframe with an inlined srcDoc', () => {
    render(<ReplayPlayerModal replayId="abc123" title="Replay · crash" onClose={() => {}} />);

    const iframe = screen.getByTestId('replay-player-iframe');
    // Acceptance criterion: sandboxed iframe isolation. allow-scripts only —
    // no allow-same-origin, so the player runs at an opaque origin with no
    // access to the host page, cookies, or network.
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    const srcDoc = iframe.getAttribute('srcdoc') || '';
    expect(srcDoc).toContain('id="root"');
    expect(srcDoc).toContain('rrwebPlayer');
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
    api.getReplay.mockResolvedValue({ defaultPageSize: 500, eventCount: 3 });
    api.getReplayEvents.mockResolvedValue({
      events: [{ type: 2, timestamp: 1 }],
      total: 1,
      offset: 0,
      hasMore: false,
    });

    render(<ReplayPlayerModal replayId="race-1" onClose={() => {}} />);
    fireEvent.load(screen.getByTestId('replay-player-iframe'));

    await waitFor(() => expect(api.getReplay).toHaveBeenCalledWith('race-1'));
    await waitFor(() => expect(api.getReplayEvents).toHaveBeenCalled());
  });

  it('invokes onClose from the close button and the backdrop', () => {
    const onClose = vi.fn();
    render(<ReplayPlayerModal replayId="abc123" onClose={onClose} />);
    fireEvent.click(screen.getByTestId('replay-player-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('replay-player-overlay'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('invokes onClose on Escape', () => {
    const onClose = vi.fn();
    render(<ReplayPlayerModal replayId="abc123" onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
