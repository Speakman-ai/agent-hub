// replayPlaylist.ts — pure presentation/branching helpers for the replay
// playlists UI. Kept separate from the components so the add-to-playlist
// message logic is unit-testable across all branches (mirrors the mobile
// `addToPlaylistMessage` in mobile/src/components/ReplayPlaylistsView.tsx so the
// two clients derive identical notice copy).

/** Notification copy after adding a capture to a playlist. `createdName` is set
 *  when a new playlist was created inline (always a fresh add); otherwise the
 *  server's `added` flag distinguishes a fresh add from an already-member. */
export function addToPlaylistMessage(res: any, createdName?: string): string {
  const label = createdName || res?.name || 'playlist';
  return res?.added === false ? `Already in ${label}` : `Added to ${label}`;
}
