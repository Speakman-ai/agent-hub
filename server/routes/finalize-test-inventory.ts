/**
 * `GET /api/projects/:projectId/finalize/test-inventory?baseSha=<sha>`
 *
 * The test inventory (which job instance runs which test file) learned from
 * the last full default-branch CI run, checked against a session base: `ok`
 * with the entries when the inventory's sha is an ancestor of `baseSha`,
 * `stale` when it isn't (or git can't tell), `missing` when no full run has
 * recorded one yet. Logic lives in `server/finalize/test-inventory.ts`.
 */
import { Router, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import config from '../config.js';
import type { Project, RouteDeps } from '../types.js';
import { getDb } from '../db.js';
import { lookupTestInventory, type IsAncestorFn } from '../finalize/test-inventory.js';
import { gitHostRepoPath, hostedRepoExists } from '../git-host/repo-store.js';
import { originMirrorExists, originMirrorPath } from '../git-host/origin-mirror.js';

const SHA_RE = /^[0-9a-f]{7,64}$/i;

/** The local repo that holds default-branch history for ancestry checks. */
export function inventoryRepoDir(project: Project, dataDir: string): string | null {
  if (project.gitHost === 'agenthub' && hostedRepoExists(project.id, dataDir)) {
    return gitHostRepoPath(project.id, dataDir);
  }
  if (originMirrorExists(project.id, dataDir)) return originMirrorPath(project.id, dataDir);
  return project.cwd || null;
}

export interface FinalizeTestInventoryRouteOpts {
  db?: () => Database.Database;
  dataDir?: string;
  isAncestor?: IsAncestorFn;
}

export default function createFinalizeTestInventoryRoutes(
  deps: Pick<RouteDeps, 'findProject'>,
  opts: FinalizeTestInventoryRouteOpts = {},
): Router {
  const router = Router();
  router.get(
    '/api/projects/:projectId/finalize/test-inventory',
    async (req: Request, res: Response) => {
      const project = deps.findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const baseSha = typeof req.query.baseSha === 'string' ? req.query.baseSha.trim() : '';
      if (!SHA_RE.test(baseSha)) {
        return res
          .status(400)
          .json({ error: 'invalid_base_sha', message: 'baseSha must be a hex commit sha' });
      }
      const repoDir = inventoryRepoDir(project, opts.dataDir ?? config.dataDir);
      try {
        const db = (opts.db ?? getDb)();
        const result = await lookupTestInventory(db, {
          projectId: project.id,
          baseSha,
          repoDir: repoDir ?? '',
          // No local history to check against: ancestry is unknown, so stale.
          isAncestor: repoDir ? opts.isAncestor : async () => null,
        });
        if (result.status === 'ok') {
          return res.json({
            project_id: project.id,
            base_sha: baseSha,
            status: 'ok',
            sha: result.sha,
            branch: result.branch,
            recorded_at: result.recordedAt,
            entries: result.entries.map((e) => ({
              job_id: e.jobId,
              matrix_key: e.matrixKey,
              test_file: e.testFile,
            })),
          });
        }
        if (result.status === 'stale') {
          return res.json({
            project_id: project.id,
            base_sha: baseSha,
            status: 'stale',
            sha: result.sha,
            branch: result.branch,
            recorded_at: result.recordedAt,
            reason: result.reason,
          });
        }
        return res.json({ project_id: project.id, base_sha: baseSha, status: 'missing' });
      } catch (err) {
        console.warn(
          `[finalize-test-inventory] lookup failed for project=${project.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return res.status(500).json({ error: 'test_inventory_read_failed' });
      }
    },
  );
  return router;
}
