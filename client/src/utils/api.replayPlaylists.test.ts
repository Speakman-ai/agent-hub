import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from './api';

/**
 * URL + method + body parity for the replay-playlist api.* methods against the
 * backend contract in server/routes/replay-playlists.ts. These wire the
 * "Playlists" tab of the Replays dashboard (web + mobile).
 */
describe('api replay-playlist helpers', () => {
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockJson(body: any = {}, init: any = {}) {
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { 'Content-Type': 'application/json' },
        ...init,
      }),
    );
  }
  const call = (i = 0) => (fetchSpy as any).mock.calls[i];
  const url = (i = 0) => new URL(call(i)[0], 'http://x');
  const opts = (i = 0) => call(i)[1] || {};

  it('listReplayPlaylists → GET /projects/:p/replay-playlists', async () => {
    fetchSpy.mockReturnValue(mockJson({ playlists: [] }));
    await api.listReplayPlaylists('proj-1');
    expect(url().pathname).toBe('/api/projects/proj-1/replay-playlists');
    expect(opts().method ?? 'GET').toBe('GET');
  });

  it('getReplayPlaylist → GET /projects/:p/replay-playlists/:id', async () => {
    fetchSpy.mockReturnValue(mockJson({ id: 'pl-1', items: [] }));
    await api.getReplayPlaylist('proj-1', 'pl-1');
    expect(url().pathname).toBe('/api/projects/proj-1/replay-playlists/pl-1');
    expect(opts().method ?? 'GET').toBe('GET');
  });

  it('createReplayPlaylist → POST with name + description', async () => {
    fetchSpy.mockReturnValue(mockJson({ id: 'pl-1' }, { status: 201 }));
    await api.createReplayPlaylist('proj-1', { name: 'Checkout', description: 'bugs' });
    expect(url().pathname).toBe('/api/projects/proj-1/replay-playlists');
    expect(opts().method).toBe('POST');
    expect(JSON.parse(opts().body)).toEqual({ name: 'Checkout', description: 'bugs' });
  });

  it('createReplayPlaylist omits description when not provided', async () => {
    fetchSpy.mockReturnValue(mockJson({ id: 'pl-1' }, { status: 201 }));
    await api.createReplayPlaylist('proj-1', { name: 'Checkout' });
    expect(JSON.parse(opts().body)).toEqual({ name: 'Checkout' });
  });

  it('createReplayPlaylist omits a blank description (form sends trimmed "")', async () => {
    fetchSpy.mockReturnValue(mockJson({ id: 'pl-1' }, { status: 201 }));
    await api.createReplayPlaylist('proj-1', { name: 'Checkout', description: '' });
    expect(JSON.parse(opts().body)).toEqual({ name: 'Checkout' });
  });

  it('updateReplayPlaylist → PATCH with the given patch', async () => {
    fetchSpy.mockReturnValue(mockJson({ id: 'pl-1' }));
    await api.updateReplayPlaylist('proj-1', 'pl-1', { name: 'Renamed', description: null });
    expect(url().pathname).toBe('/api/projects/proj-1/replay-playlists/pl-1');
    expect(opts().method).toBe('PATCH');
    expect(JSON.parse(opts().body)).toEqual({ name: 'Renamed', description: null });
  });

  it('deleteReplayPlaylist → DELETE', async () => {
    fetchSpy.mockReturnValue(mockJson({}));
    await api.deleteReplayPlaylist('proj-1', 'pl-1');
    expect(url().pathname).toBe('/api/projects/proj-1/replay-playlists/pl-1');
    expect(opts().method).toBe('DELETE');
  });

  it('addReplayPlaylistItem → POST .../items with replayId', async () => {
    fetchSpy.mockReturnValue(mockJson({ added: true }, { status: 201 }));
    await api.addReplayPlaylistItem('proj-1', 'pl-1', 'r-9');
    expect(url().pathname).toBe('/api/projects/proj-1/replay-playlists/pl-1/items');
    expect(opts().method).toBe('POST');
    expect(JSON.parse(opts().body)).toEqual({ replayId: 'r-9' });
  });

  it('removeReplayPlaylistItem → DELETE .../items/:replayId (encoded)', async () => {
    fetchSpy.mockReturnValue(mockJson({}));
    await api.removeReplayPlaylistItem('proj-1', 'pl-1', 'r/9');
    expect(url().pathname).toBe('/api/projects/proj-1/replay-playlists/pl-1/items/r%2F9');
    expect(opts().method).toBe('DELETE');
  });

  it('setReplayPlaylistRetention → POST .../retention with { extend }', async () => {
    fetchSpy.mockReturnValue(mockJson({ id: 'pl-1', extendedRetention: true }));
    await api.setReplayPlaylistRetention('proj-1', 'pl-1', true);
    expect(url().pathname).toBe('/api/projects/proj-1/replay-playlists/pl-1/retention');
    expect(opts().method).toBe('POST');
    expect(JSON.parse(opts().body)).toEqual({ extend: true });
  });

  it('setReplayPlaylistRetention coerces truthiness to a boolean', async () => {
    fetchSpy.mockReturnValue(mockJson({ id: 'pl-1' }));
    await api.setReplayPlaylistRetention('proj-1', 'pl-1', 0 as any);
    expect(JSON.parse(opts().body)).toEqual({ extend: false });
  });
});
