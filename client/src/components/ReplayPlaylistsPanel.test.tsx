import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ReplayPlaylistsPanel from './ReplayPlaylistsPanel';
import { api } from '../utils/api';

// The player modal pulls in a heavy inlined rrweb bundle; stub it (it only
// mounts on "Watch" inside the detail view).
(vi as any).mock('./ReplayPlayerModal', () => ({ default: () => null }));

(vi as any).mock('../utils/api.js', () => ({
  api: {
    listReplayPlaylists: vi.fn(),
    getReplayPlaylist: vi.fn(),
    createReplayPlaylist: vi.fn(),
    updateReplayPlaylist: vi.fn(),
    deleteReplayPlaylist: vi.fn(),
    setReplayPlaylistRetention: vi.fn(),
    removeReplayPlaylistItem: vi.fn(),
  },
}));

function playlist(over: any = {}) {
  return {
    id: 'pl-1',
    projectId: 'proj-1',
    name: 'Checkout errors',
    description: null,
    itemCount: 2,
    extendedRetention: false,
    retainedUntil: null,
    retentionFlaggedAt: null,
    createdAt: '2026-06-25 12:00:00',
    createdBy: null,
    updatedAt: '2026-06-25 12:00:00',
    ...over,
  };
}

describe('ReplayPlaylistsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists playlists with their capture count', async () => {
    (api.listReplayPlaylists as any).mockResolvedValue({ playlists: [playlist()] });
    render(<ReplayPlaylistsPanel projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Checkout errors')).toBeTruthy());
    expect(screen.getByText('2 captures')).toBeTruthy();
    expect(api.listReplayPlaylists).toHaveBeenCalledWith('proj-1');
  });

  it('shows the empty state when there are no playlists', async () => {
    (api.listReplayPlaylists as any).mockResolvedValue({ playlists: [] });
    render(<ReplayPlaylistsPanel projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText(/No playlists yet/)).toBeTruthy());
  });

  it('creates a playlist through the new-playlist modal', async () => {
    (api.listReplayPlaylists as any).mockResolvedValue({ playlists: [] });
    (api.createReplayPlaylist as any).mockResolvedValue(playlist({ itemCount: 0 }));
    render(<ReplayPlaylistsPanel projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText(/No playlists yet/)).toBeTruthy());

    fireEvent.click(screen.getByText('New playlist'));
    fireEvent.change(screen.getByPlaceholderText('e.g. Checkout errors'), {
      target: { value: '  Rage clicks  ' },
    });
    fireEvent.click(screen.getByText('Create'));

    await waitFor(() =>
      expect(api.createReplayPlaylist).toHaveBeenCalledWith('proj-1', {
        name: 'Rage clicks',
        description: '',
      }),
    );
  });

  it('toggles a playlist Keep (extended retention) from the list', async () => {
    (api.listReplayPlaylists as any).mockResolvedValue({ playlists: [playlist()] });
    (api.setReplayPlaylistRetention as any).mockResolvedValue(
      playlist({ extendedRetention: true }),
    );
    render(<ReplayPlaylistsPanel projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Checkout errors')).toBeTruthy());

    fireEvent.click(screen.getByTitle('Keep this playlist (extended retention)'));
    await waitFor(() =>
      expect(api.setReplayPlaylistRetention).toHaveBeenCalledWith('proj-1', 'pl-1', true),
    );
  });

  it('opens a playlist and renders its captures', async () => {
    (api.listReplayPlaylists as any).mockResolvedValue({ playlists: [playlist()] });
    (api.getReplayPlaylist as any).mockResolvedValue({
      ...playlist(),
      items: [
        {
          replayId: 'r-1',
          position: 0,
          addedAt: '2026-06-25 12:00:00',
          createdAt: '2026-06-25 12:00:00',
          durationMs: 5000,
          eventCount: 42,
          size: 1024,
          supportTicketId: null,
          cardId: null,
          retainedUntil: null,
          retentionFlaggedAt: null,
          eventsUrl: '/api/replays/r-1/events',
        },
      ],
    });
    render(<ReplayPlaylistsPanel projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Checkout errors')).toBeTruthy());

    fireEvent.click(screen.getByTitle('Open playlist'));
    await waitFor(() => expect(api.getReplayPlaylist).toHaveBeenCalledWith('proj-1', 'pl-1'));
    expect(await screen.findByText('Watch')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
  });
});
