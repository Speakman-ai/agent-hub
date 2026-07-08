/**
 * replay-playlist-store.ts — CRUD + view mappers for replay playlists (Datadog
 * "playlist"): named, project-scoped groups of saved replay captures.
 *
 * Playlists reuse the per-session two-tier retention model (card 1369): flagging
 * a whole playlist for extended retention stamps an absolute `retained_until`
 * (enable-time + the tenant's extension window) on the playlist AND fans the same
 * flag out onto every member capture's `session_replays` row, so the retention
 * sweeper skips those captures until the window lapses. Adding a capture to an
 * already-flagged playlist inherits the flag. Clearing the playlist flag clears
 * ONLY the playlist-level flag — member captures keep their `retained_until`
 * (they may be pinned independently or belong to another retained playlist) and
 * can be released individually via `POST /api/replays/:id/retention`.
 *
 * The DB helpers wrap prepared statements; the pure view mappers + the retention
 * fan-out math live here so the route stays thin and the mapping is unit-testable.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  Stmts,
  ReplayPlaylistRow,
  ReplayPlaylistWithCountRow,
  ReplayPlaylistItemRow,
  SessionReplayRow,
} from '../types.js';
import { computeRetainedUntil, toSqliteUtc } from './replay-retention.js';

/** Client-facing playlist shape (camelCase). */
export interface PlaylistView {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  itemCount: number;
  extendedRetention: boolean;
  retainedUntil: string | null;
  retentionFlaggedAt: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
}

/** Client-facing playlist-item shape: a compact capture summary + join columns. */
export interface PlaylistItemView {
  replayId: string;
  position: number;
  addedAt: string;
  createdAt: string;
  durationMs: number;
  eventCount: number;
  size: number;
  supportTicketId: string | null;
  cardId: string | null;
  retainedUntil: string | null;
  retentionFlaggedAt: string | null;
  eventsUrl: string;
}

/** Map a playlist row (optionally carrying an `item_count`) to its client view. */
export function toPlaylistView(
  row: ReplayPlaylistRow | ReplayPlaylistWithCountRow,
  itemCount?: number,
): PlaylistView {
  const count =
    typeof itemCount === 'number'
      ? itemCount
      : ((row as ReplayPlaylistWithCountRow).item_count ?? 0);
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description ?? null,
    itemCount: count,
    extendedRetention: row.extended_retention === 1,
    retainedUntil: row.retained_until ?? null,
    retentionFlaggedAt: row.retention_flagged_at ?? null,
    createdAt: row.created_at,
    createdBy: row.created_by ?? null,
    updatedAt: row.updated_at,
  };
}

/** Map a joined playlist-item row to its client view. */
export function toPlaylistItemView(row: ReplayPlaylistItemRow): PlaylistItemView {
  return {
    replayId: row.replay_id,
    position: row.position,
    addedAt: row.added_at,
    createdAt: row.created_at,
    durationMs: row.duration_ms,
    eventCount: row.event_count,
    size: row.size,
    supportTicketId: row.support_ticket_id,
    cardId: row.card_id,
    retainedUntil: row.retained_until ?? null,
    retentionFlaggedAt: row.retention_flagged_at ?? null,
    eventsUrl: `/api/replays/${row.replay_id}/events`,
  };
}

/**
 * Normalize + validate a playlist name. Trims, rejects empty, caps length so a
 * runaway body can't bloat the row. Returns the cleaned name or null when invalid.
 */
export function normalizePlaylistName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  return trimmed;
}

/** Normalize an optional description: trim, cap, coerce empty/absent to null. */
export function normalizePlaylistDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, 2000);
}

export interface PlaylistStoreDeps {
  stmts: Stmts;
}

export function createPlaylist(
  deps: PlaylistStoreDeps,
  args: { projectId: string; name: string; description: string | null; createdBy: string | null },
): ReplayPlaylistRow {
  const id = uuidv4();
  deps.stmts.insertReplayPlaylist.run(
    id,
    args.projectId,
    args.name,
    args.description,
    args.createdBy,
  );
  return deps.stmts.getReplayPlaylist.get(id) as ReplayPlaylistRow;
}

export function getPlaylist(deps: PlaylistStoreDeps, id: string): ReplayPlaylistRow | undefined {
  return deps.stmts.getReplayPlaylist.get(id) as ReplayPlaylistRow | undefined;
}

export function listPlaylists(
  deps: PlaylistStoreDeps,
  projectId: string,
): ReplayPlaylistWithCountRow[] {
  return deps.stmts.listReplayPlaylistsByProject.all(projectId) as ReplayPlaylistWithCountRow[];
}

export function listPlaylistItems(
  deps: PlaylistStoreDeps,
  playlistId: string,
): ReplayPlaylistItemRow[] {
  return deps.stmts.listReplayPlaylistItems.all(playlistId) as ReplayPlaylistItemRow[];
}

/**
 * Count of members whose capture still exists (same inner-join semantics as
 * {@link listPlaylistItems}), without materializing the metadata join. Use when
 * only the count is needed (PATCH / retention responses) so orphaned membership
 * rows never inflate the count and it always agrees with `items.length`.
 */
export function countPlaylistItems(deps: PlaylistStoreDeps, playlistId: string): number {
  return (deps.stmts.countReplayPlaylistItems.get(playlistId) as { n: number }).n;
}

/**
 * Add a capture to a playlist. Idempotent (composite PK + INSERT OR IGNORE): a
 * re-add is a no-op and does NOT move the item's position. If the playlist is
 * currently flagged for extended retention, the new member inherits the flag —
 * its `session_replays` row is stamped with the playlist's `retained_until` so
 * the sweeper skips it, matching the "whole playlist is kept" contract. Returns
 * whether a new row was inserted.
 */
export function addPlaylistItem(
  deps: PlaylistStoreDeps,
  playlist: ReplayPlaylistRow,
  replayId: string,
): boolean {
  const nextPos =
    ((deps.stmts.maxReplayPlaylistItemPosition.get(playlist.id) as { max_pos: number }).max_pos ??
      -1) + 1;
  const inserted = deps.stmts.insertReplayPlaylistItem.run(playlist.id, replayId, nextPos)
    .changes as number;
  if (inserted > 0 && playlist.extended_retention === 1 && playlist.retained_until) {
    deps.stmts.flagSessionReplayRetention.run(
      playlist.retained_until,
      playlist.retention_flagged_at ?? playlist.retained_until,
      replayId,
    );
  }
  return inserted > 0;
}

export function removePlaylistItem(
  deps: PlaylistStoreDeps,
  playlistId: string,
  replayId: string,
): boolean {
  return (deps.stmts.deleteReplayPlaylistItem.run(playlistId, replayId).changes as number) > 0;
}

/**
 * Flag or clear a playlist's extended retention, fanning the flag out to member
 * captures. Reuses `computeRetainedUntil` (enable-time + clamped window) so the
 * playlist and its members share ONE absolute instant.
 *
 *   - extend=true  → stamp `retained_until` on the playlist + every member's
 *     `session_replays` row (the reuse of the per-session mechanism).
 *   - extend=false → clear ONLY the playlist-level flag. Member captures keep
 *     their `retained_until`; they can be released individually.
 *
 * Returns the refreshed playlist row.
 */
export function setPlaylistRetention(
  deps: PlaylistStoreDeps,
  playlist: ReplayPlaylistRow,
  extend: boolean,
  extendedRetentionMonths: number | undefined,
  nowMs: number,
): ReplayPlaylistRow {
  if (extend) {
    const retainedUntil = toSqliteUtc(computeRetainedUntil(nowMs, extendedRetentionMonths));
    const flaggedAt = toSqliteUtc(nowMs);
    deps.stmts.flagReplayPlaylistRetention.run(retainedUntil, flaggedAt, playlist.id);
    const memberIds = deps.stmts.listReplayPlaylistItemIds.all(playlist.id) as Array<{
      replay_id: string;
    }>;
    for (const { replay_id } of memberIds) {
      deps.stmts.flagSessionReplayRetention.run(retainedUntil, flaggedAt, replay_id);
    }
  } else {
    deps.stmts.clearReplayPlaylistRetention.run(playlist.id);
  }
  return deps.stmts.getReplayPlaylist.get(playlist.id) as ReplayPlaylistRow;
}

/** A capture is eligible for a project's playlist only if it's a saved capture
 *  attributed to that same project. Unattributed / cross-project captures 404. */
export function isReplayInProject(
  row: SessionReplayRow | undefined,
  projectId: string,
): row is SessionReplayRow {
  return Boolean(row && row.project_id === projectId);
}
