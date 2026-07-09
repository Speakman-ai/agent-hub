import { describe, it, expect } from 'vitest';
import { addToPlaylistMessage } from './replayPlaylist';

// Covers all four branches of the add-to-playlist toast: fresh add via the
// server-echoed name, already-member (added:false), inline-created name wins,
// and the generic fallback when no name is available.
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
