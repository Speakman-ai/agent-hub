import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Mirror the react-native stub the screen tests use so the component tree can be
// rendered to static markup in a plain node env (no Metro / native modules).
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  FlatList: ({ data, renderItem }: any) => (
    <div>{(data || []).map((item: any, index: number) => renderItem({ item, index }))}</div>
  ),
  Modal: ({ children, visible }: any) => (visible ? <div>{children}</div> : null),
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: ({ children }: any) => <button>{children}</button>,
  View: 'View',
}));
vi.mock('../utils/api', () => ({
  api: {
    listReplayPlaylists: vi.fn(() => Promise.resolve({ playlists: [] })),
    getReplayPlaylist: vi.fn(),
    createReplayPlaylist: vi.fn(),
    updateReplayPlaylist: vi.fn(),
    deleteReplayPlaylist: vi.fn(),
    addReplayPlaylistItem: vi.fn(),
    removeReplayPlaylistItem: vi.fn(),
    setReplayPlaylistRetention: vi.fn(),
  },
}));

const { ReplayPlaylistsView, AddToPlaylistModal, addToPlaylistMessage } = await import(
  './ReplayPlaylistsView'
);

describe('addToPlaylistMessage', () => {
  it('reports a fresh add using the server-echoed playlist name', () => {
    expect(addToPlaylistMessage({ added: true, name: 'Checkout' })).toBe('Added to Checkout');
  });

  it('reports an already-member add when the server returns added:false', () => {
    expect(addToPlaylistMessage({ added: false, name: 'Checkout' })).toBe('Already in Checkout');
  });

  it('prefers a freshly-created playlist name over the response body', () => {
    expect(addToPlaylistMessage({ added: true, name: 'ignored' }, 'Brand New')).toBe(
      'Added to Brand New',
    );
  });

  it('falls back to a generic label when no name is available', () => {
    expect(addToPlaylistMessage({})).toBe('Added to playlist');
  });
});

describe('ReplayPlaylistsView', () => {
  it('renders the create affordance and blurb', () => {
    const html = renderToStaticMarkup(<ReplayPlaylistsView projectId="p1" />);
    expect(html).toContain('+ New');
    expect(html).toContain('Named groups of saved captures');
  });
});

describe('AddToPlaylistModal', () => {
  it('renders the picker shell', () => {
    const html = renderToStaticMarkup(
      <AddToPlaylistModal projectId="p1" replay={{ id: 'r-1' }} />,
    );
    expect(html).toContain('Add to a playlist');
  });
});
