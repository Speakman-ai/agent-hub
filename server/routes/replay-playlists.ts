import { Router, Request, Response } from 'express';
import type { RouteDeps, ReplayPlaylistRow, SessionReplayRow } from '../types.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import {
  createPlaylist,
  getPlaylist,
  listPlaylists,
  listPlaylistItems,
  countPlaylistItems,
  addPlaylistItem,
  removePlaylistItem,
  setPlaylistRetention,
  isReplayInProject,
  toPlaylistView,
  toPlaylistItemView,
  normalizePlaylistName,
  normalizePlaylistDescription,
} from '../replays/replay-playlist-store.js';

/**
 * Replay playlists (Datadog "playlist"): named, project-scoped groups of saved
 * replay captures, plus playlist-level extended retention.
 *
 * All routes mount under `/api/projects/:projectId`, so they inherit the shared
 * project-visibility gate (`createProjectVisibilityGate`) — a caller who can't
 * view the project never reaches a handler. Membership is restricted to the
 * project's OWN saved captures (`session_replays` rows attributed to this
 * project); an unattributed or cross-project replay id collapses to 404 so a
 * leaked id can't be smuggled into another tenant's playlist.
 *
 * Retention: flagging a playlist for extended retention reuses the per-session
 * two-tier model (card 1369) — it stamps an absolute `retained_until` on the
 * playlist AND every member's `session_replays` row, so the sweeper keeps the
 * whole playlist until the window lapses. Adding a capture to a flagged playlist
 * inherits the flag. See server/replays/replay-playlist-store.ts.
 */
export default function createReplayPlaylistRoutes(deps: RouteDeps): Router {
  const { stmts, findProject } = deps;
  const router = Router();

  /** Resolve the playlist for this request, scoped to the path project. Writes a
   *  404 and returns null when the project or playlist is missing, or the
   *  playlist belongs to another project (no cross-project probing). */
  function loadPlaylist(req: Request, res: Response): ReplayPlaylistRow | null {
    const project = findProject(req.params.projectId as string);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return null;
    }
    const playlist = getPlaylist({ stmts }, req.params.playlistId as string);
    if (!playlist || playlist.project_id !== project.id) {
      res.status(404).json({ error: 'Playlist not found' });
      return null;
    }
    return playlist;
  }

  // ── List playlists ────────────────────────────────────────────────
  router.get('/api/projects/:projectId/replay-playlists', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const rows = listPlaylists({ stmts }, project.id);
    return res.json({ playlists: rows.map((r) => toPlaylistView(r)) });
  });

  // ── Create a playlist ─────────────────────────────────────────────
  router.post('/api/projects/:projectId/replay-playlists', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = normalizePlaylistName(body.name);
    if (!name) {
      return res.status(400).json({ error: 'name is required (1–200 chars)' });
    }
    const description = normalizePlaylistDescription(body.description);
    const createdBy = resolveVisibilityCaller(req).userId ?? null;

    const row = createPlaylist(
      { stmts },
      {
        projectId: project.id,
        name,
        description,
        createdBy,
      },
    );
    return res.status(201).json(toPlaylistView(row, 0));
  });

  // ── Get one playlist with its items ───────────────────────────────
  router.get(
    '/api/projects/:projectId/replay-playlists/:playlistId',
    (req: Request, res: Response) => {
      const playlist = loadPlaylist(req, res);
      if (!playlist) return; // 404 already sent
      const items = listPlaylistItems({ stmts }, playlist.id);
      return res.json({
        ...toPlaylistView(playlist, items.length),
        items: items.map(toPlaylistItemView),
      });
    },
  );

  // ── Rename / update a playlist ────────────────────────────────────
  router.patch(
    '/api/projects/:projectId/replay-playlists/:playlistId',
    (req: Request, res: Response) => {
      const playlist = loadPlaylist(req, res);
      if (!playlist) return; // 404 already sent

      const body = (req.body ?? {}) as Record<string, unknown>;
      // name, when present, must be valid; description is optional and nullable.
      let name = playlist.name;
      if (body.name !== undefined) {
        const normalized = normalizePlaylistName(body.name);
        if (!normalized) return res.status(400).json({ error: 'name must be 1–200 chars' });
        name = normalized;
      }
      const description =
        body.description !== undefined
          ? normalizePlaylistDescription(body.description)
          : (playlist.description ?? null);

      stmts.updateReplayPlaylist.run(name, description, playlist.id);
      const updated = stmts.getReplayPlaylist.get(playlist.id) as ReplayPlaylistRow;
      const count = countPlaylistItems({ stmts }, playlist.id);
      return res.json(toPlaylistView(updated, count));
    },
  );

  // ── Delete a playlist ─────────────────────────────────────────────
  // Items cascade (FK ON DELETE CASCADE). Member captures are NOT deleted or
  // un-flagged — a capture may be pinned independently or live in another
  // playlist; dropping a grouping never reaps captures.
  router.delete(
    '/api/projects/:projectId/replay-playlists/:playlistId',
    (req: Request, res: Response) => {
      const playlist = loadPlaylist(req, res);
      if (!playlist) return; // 404 already sent
      stmts.deleteReplayPlaylist.run(playlist.id);
      return res.status(204).end();
    },
  );

  // ── Add a capture to a playlist ───────────────────────────────────
  router.post(
    '/api/projects/:projectId/replay-playlists/:playlistId/items',
    (req: Request, res: Response) => {
      const playlist = loadPlaylist(req, res);
      if (!playlist) return; // 404 already sent

      const body = (req.body ?? {}) as Record<string, unknown>;
      const replayId = typeof body.replayId === 'string' ? body.replayId.trim() : '';
      if (!replayId) return res.status(400).json({ error: 'replayId is required' });

      const row = stmts.getSessionReplay.get(replayId) as SessionReplayRow | undefined;
      // 404 (not 403) when the capture is missing OR owned by another project, so
      // a leaked id can't probe cross-project existence (matches canViewReplay).
      if (!isReplayInProject(row, playlist.project_id)) {
        return res.status(404).json({ error: 'Replay not found' });
      }

      const added = addPlaylistItem({ stmts }, playlist, replayId);
      const items = listPlaylistItems({ stmts }, playlist.id);
      return res.status(added ? 201 : 200).json({
        added,
        ...toPlaylistView(playlist, items.length),
        items: items.map(toPlaylistItemView),
      });
    },
  );

  // ── Remove a capture from a playlist ──────────────────────────────
  router.delete(
    '/api/projects/:projectId/replay-playlists/:playlistId/items/:replayId',
    (req: Request, res: Response) => {
      const playlist = loadPlaylist(req, res);
      if (!playlist) return; // 404 already sent
      const removed = removePlaylistItem({ stmts }, playlist.id, req.params.replayId as string);
      if (!removed) return res.status(404).json({ error: 'Playlist item not found' });
      return res.status(204).end();
    },
  );

  // ── Flag / unflag a playlist for extended retention ───────────────
  // `{ extend: true }` stamps an absolute `retained_until` (enable-time + the
  // tenant's extension window) on the playlist AND every member capture's
  // session_replays row, so the sweeper keeps the whole playlist until the
  // window lapses. `{ extend: false }` clears ONLY the playlist-level flag;
  // member captures keep their retained_until and can be released individually
  // via POST /api/replays/:id/retention.
  router.post(
    '/api/projects/:projectId/replay-playlists/:playlistId/retention',
    (req: Request, res: Response) => {
      const playlist = loadPlaylist(req, res);
      if (!playlist) return; // 404 already sent

      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.extend !== 'boolean') {
        return res.status(400).json({ error: 'Body must be { extend: boolean }' });
      }

      const project = findProject(playlist.project_id);
      const updated = setPlaylistRetention(
        { stmts },
        playlist,
        body.extend,
        project?.replay?.extendedRetentionMonths,
        Date.now(),
      );
      const count = countPlaylistItems({ stmts }, playlist.id);
      return res.json(toPlaylistView(updated, count));
    },
  );

  return router;
}
