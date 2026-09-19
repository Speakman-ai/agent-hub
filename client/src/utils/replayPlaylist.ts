// Replay playlist helpers. Keep add-to-playlist copy in sync with mobile.

/** Notification copy after adding a capture to a playlist. `createdName` is set
 *  when a new playlist was created inline (always a fresh add); otherwise the
 *  server's `added` flag distinguishes a fresh add from an already-member. */
export function addToPlaylistMessage(res: any, createdName?: string): string {
  const label = createdName || res?.name || 'playlist';
  return res?.added === false ? `Already in ${label}` : `Added to ${label}`;
}
