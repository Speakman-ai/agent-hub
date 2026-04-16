/**
 * routes/preview.ts — API endpoints for preview DB snapshot management.
 *
 * POST   /api/preview/snapshot                  — Create a snapshot of the live DB
 * POST   /api/preview/seed                      — Create a fresh seeded DB
 * GET    /api/preview/snapshots                  — List all snapshots (lightweight)
 * GET    /api/preview/snapshots/:id/detail       — Get snapshot detail with tables
 * DELETE /api/preview/snapshots/:id              — Delete a snapshot
 * GET    /api/preview/snapshots/:id/download     — Download a snapshot file
 */

import { Router, Request, Response } from 'express';
import path from 'path';
import { existsSync } from 'fs';
import { getDb } from '../db.js';
import type { RouteDeps } from '../types.js';
import {
  createSnapshot,
  createSeedDb,
  listSnapshots,
  deleteSnapshot,
  getSnapshotDetail,
  getSnapshotDir,
  type SeedRow,
} from '../preview-db.js';

export default function createPreviewRoutes(deps: RouteDeps): Router {
  const { config } = deps;
  const router = Router();

  /**
   * POST /api/preview/snapshot
   * Create a full snapshot of the current live database.
   * Body: { filename?: string }
   */
  router.post('/api/preview/snapshot', async (req: Request, res: Response) => {
    try {
      const { filename } = req.body as { filename?: string };
      const destDir = getSnapshotDir(config.dataDir);
      const db = getDb();

      const result = await createSnapshot(db, { destDir, filename });

      res.json({
        ok: true,
        snapshot: {
          ...result,
          // Return a relative filename instead of the absolute path
          filename: path.basename(result.path),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[preview] Snapshot failed:', message);
      res.status(500).json({ error: `Snapshot failed: ${message}` });
    }
  });

  /**
   * POST /api/preview/seed
   * Create a fresh seeded database with core schema + optional custom data.
   * Body: { filename?: string, seedData?: SeedRow[] }
   */
  router.post('/api/preview/seed', (req: Request, res: Response) => {
    try {
      const { filename, seedData } = req.body as {
        filename?: string;
        seedData?: SeedRow[];
      };
      const destDir = getSnapshotDir(config.dataDir);

      const sourceDb = getDb();
      const result = createSeedDb({ destDir, filename, sourceDb }, seedData);

      res.json({
        ok: true,
        snapshot: {
          ...result,
          filename: path.basename(result.path),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[preview] Seed failed:', message);
      res.status(500).json({ error: `Seed failed: ${message}` });
    }
  });

  /**
   * GET /api/preview/snapshots
   * List all available snapshot files (lightweight — no DB connections).
   */
  router.get('/api/preview/snapshots', (_req: Request, res: Response) => {
    try {
      const destDir = getSnapshotDir(config.dataDir);
      const snapshots = listSnapshots(destDir);

      res.json({ snapshots });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/preview/snapshots/:filename/detail
   * Get detailed info for a snapshot, including table list.
   */
  router.get('/api/preview/snapshots/:filename/detail', (req: Request, res: Response) => {
    try {
      const filename = req.params.filename as string;
      const destDir = getSnapshotDir(config.dataDir);
      const filePath = path.join(destDir, filename);

      // Safety: ensure the resolved path stays inside the snapshot dir
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(destDir))) {
        res.status(400).json({ error: 'Invalid filename' });
        return;
      }

      const detail = getSnapshotDetail(resolved);
      if (!detail) {
        res.status(404).json({ error: 'Snapshot not found' });
        return;
      }

      res.json({
        ...detail,
        filename: path.basename(detail.path),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * DELETE /api/preview/snapshots/:filename
   * Delete a specific snapshot file by filename.
   */
  router.delete('/api/preview/snapshots/:filename', (req: Request, res: Response) => {
    try {
      const filename = req.params.filename as string;
      const destDir = getSnapshotDir(config.dataDir);
      const filePath = path.join(destDir, filename);

      // Safety: ensure the resolved path stays inside the snapshot dir
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(destDir))) {
        res.status(400).json({ error: 'Invalid filename' });
        return;
      }

      const deleted = deleteSnapshot(resolved);
      if (!deleted) {
        res.status(404).json({ error: 'Snapshot not found' });
        return;
      }

      res.json({ ok: true, deleted: filename });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/preview/snapshots/:filename/download
   * Download a snapshot file for use in a preview container.
   */
  router.get('/api/preview/snapshots/:filename/download', (req: Request, res: Response) => {
    try {
      const filename = req.params.filename as string;
      const destDir = getSnapshotDir(config.dataDir);
      const filePath = path.join(destDir, filename);

      // Safety: ensure the resolved path stays inside the snapshot dir
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(destDir))) {
        res.status(400).json({ error: 'Invalid filename' });
        return;
      }

      if (!existsSync(resolved)) {
        res.status(404).json({ error: 'Snapshot not found' });
        return;
      }

      res.download(resolved, filename);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  return router;
}
