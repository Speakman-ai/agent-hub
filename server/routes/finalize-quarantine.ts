/**
 * finalize-quarantine.ts — REST surface for the Finalize flaky-test quarantine
 * lane + cross-run flake history.
 *
 *   - `GET    /api/projects/:projectId/finalize/quarantine`
 *       List quarantine entries with owner + expiry, split into active vs
 *       overdue (past expiry, awaiting human action).
 *
 *   - `POST   /api/projects/:projectId/finalize/quarantine`
 *       Quarantine a job instance: `{ job_id, matrix_key?, owner, reason?, days? }`.
 *       `days` is clamped to ≤30 (default 30). Idempotent per instance (upsert).
 *
 *   - `DELETE /api/projects/:projectId/finalize/quarantine/:id`
 *       Release a quarantine entry.
 *
 *   - `GET    /api/projects/:projectId/finalize/flakes?windowDays=`
 *       Per-instance flake statistics computed from recorded run history.
 *
 * The pure math lives in `server/finalize/flake-history.ts` +
 * `server/finalize/quarantine.ts`; this file is the thin HTTP shell.
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { FinalizeQuarantineRow, FinalizeTestHistoryRow, RouteDeps } from '../types.js';
import {
  clampQuarantineDays,
  computeExpiry,
  daysUntilExpiry,
  quarantineStatus,
  QUARANTINE_DEFAULT_DAYS,
  QUARANTINE_MAX_DAYS,
  type QuarantineEntry,
} from '../finalize/quarantine.js';
import { quarantineRowToEntry } from '../finalize/quarantine-gate.js';
import { instanceKey, summarizeFlakeHistory } from '../finalize/flake-history.js';

const DEFAULT_FLAKE_WINDOW_DAYS = 30;
const MAX_FLAKE_WINDOW_DAYS = 365;

function serializeEntry(entry: QuarantineEntry, nowMs: number) {
  return {
    id: entry.id,
    job_id: entry.jobId,
    matrix_key: entry.matrixKey,
    owner: entry.owner,
    reason: entry.reason,
    quarantined_at: entry.quarantinedAt,
    expires_at: entry.expiresAt,
    created_by: entry.createdBy,
    status: quarantineStatus(entry, nowMs),
    days_until_expiry: daysUntilExpiry(entry, nowMs),
  };
}

export default function createFinalizeQuarantineRoutes(deps: RouteDeps): Router {
  const { stmts, findProject } = deps;
  const router = Router();
  const now = (): number => Date.now();

  // ── GET quarantine list ─────────────────────────────────────────────
  router.get('/api/projects/:projectId/finalize/quarantine', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let rows: FinalizeQuarantineRow[];
    try {
      rows = stmts.listFinalizeQuarantineForProject.all(project.id) as FinalizeQuarantineRow[];
    } catch (err) {
      console.warn(
        `[finalize-quarantine] list failed for project=${project.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return res.status(500).json({ error: 'quarantine_read_failed' });
    }

    const nowMs = now();
    const entries = rows.map((r) => serializeEntry(quarantineRowToEntry(r), nowMs));
    return res.json({
      project_id: project.id,
      now: nowMs,
      max_days: QUARANTINE_MAX_DAYS,
      default_days: QUARANTINE_DEFAULT_DAYS,
      active: entries.filter((e) => e.status === 'active'),
      overdue: entries.filter((e) => e.status === 'overdue'),
    });
  });

  // ── POST quarantine a job instance ──────────────────────────────────
  router.post('/api/projects/:projectId/finalize/quarantine', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const jobId = typeof body.job_id === 'string' ? body.job_id.trim() : '';
    if (!jobId) return res.status(400).json({ error: 'job_id is required' });
    const owner = typeof body.owner === 'string' ? body.owner.trim() : '';
    if (!owner) return res.status(400).json({ error: 'owner is required' });
    const matrixKey = typeof body.matrix_key === 'string' ? body.matrix_key : '';
    const reason =
      typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null;
    if (body.days != null && typeof body.days !== 'number') {
      return res.status(400).json({ error: 'days must be a number' });
    }
    const days = clampQuarantineDays(body.days as number | undefined);

    const quarantinedAt = now();
    const expiresAt = computeExpiry(quarantinedAt, days);
    const id = uuidv4();
    const createdBy =
      typeof body.created_by === 'string' && body.created_by.trim() ? body.created_by.trim() : null;

    try {
      stmts.upsertFinalizeQuarantine.run(
        id,
        project.id,
        jobId,
        matrixKey,
        owner,
        reason,
        quarantinedAt,
        expiresAt,
        createdBy,
      );
    } catch (err) {
      console.warn(
        `[finalize-quarantine] upsert failed for project=${project.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return res.status(500).json({ error: 'quarantine_write_failed' });
    }

    // The upsert may have updated an existing row (UNIQUE on instance), so
    // read back the canonical row to return its real id + timestamps.
    let stored: FinalizeQuarantineRow | undefined;
    try {
      stored = (
        stmts.listFinalizeQuarantineForProject.all(project.id) as FinalizeQuarantineRow[]
      ).find((r) => r.job_id === jobId && r.matrix_key === matrixKey);
    } catch {
      /* fall back to the values we wrote */
    }
    const entry: QuarantineEntry = stored
      ? quarantineRowToEntry(stored)
      : {
          id,
          projectId: project.id,
          jobId,
          matrixKey,
          owner,
          reason,
          quarantinedAt,
          expiresAt,
          createdBy,
        };
    return res.status(201).json({ project_id: project.id, entry: serializeEntry(entry, now()) });
  });

  // ── DELETE release a quarantine entry ───────────────────────────────
  router.delete(
    '/api/projects/:projectId/finalize/quarantine/:id',
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const id = req.params.id as string;
      try {
        const info = stmts.deleteFinalizeQuarantine.run(id, project.id) as { changes: number };
        if (!info.changes) return res.status(404).json({ error: 'Quarantine entry not found' });
      } catch (err) {
        console.warn(
          `[finalize-quarantine] delete failed for project=${project.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return res.status(500).json({ error: 'quarantine_delete_failed' });
      }
      return res.status(204).end();
    },
  );

  // ── GET flake statistics ────────────────────────────────────────────
  router.get('/api/projects/:projectId/finalize/flakes', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let windowDays = DEFAULT_FLAKE_WINDOW_DAYS;
    if (typeof req.query.windowDays === 'string') {
      const parsed = Number(req.query.windowDays);
      // The contract (and OpenAPI schema) declares windowDays as a positive
      // integer; reject fractional/non-finite values rather than returning a
      // fractional window_days that violates the documented shape.
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return res.status(400).json({ error: 'windowDays must be a positive integer' });
      }
      windowDays = Math.min(parsed, MAX_FLAKE_WINDOW_DAYS);
    }

    const nowMs = now();
    const since = nowMs - windowDays * 24 * 60 * 60 * 1000;
    let rows: FinalizeTestHistoryRow[];
    try {
      rows = stmts.listFinalizeTestHistoryForProject.all(
        project.id,
        since,
      ) as FinalizeTestHistoryRow[];
    } catch (err) {
      console.warn(
        `[finalize-quarantine] flake history read failed for project=${project.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return res.status(500).json({ error: 'flake_history_read_failed' });
    }

    let quarantineRows: FinalizeQuarantineRow[] = [];
    try {
      quarantineRows = stmts.listFinalizeQuarantineForProject.all(
        project.id,
      ) as FinalizeQuarantineRow[];
    } catch {
      /* quarantine annotation is best-effort */
    }
    const quarantinedKeys = new Set(
      quarantineRows
        .filter((r) => nowMs < r.expires_at)
        .map((r) => instanceKey(r.job_id, r.matrix_key)),
    );

    const stats = summarizeFlakeHistory(
      rows.map((r) => ({
        jobId: r.job_id,
        matrixKey: r.matrix_key,
        finalState: r.final_state,
        flaked: r.flaked === 1,
        recordedAt: r.recorded_at,
      })),
    );

    return res.json({
      project_id: project.id,
      window_days: windowDays,
      instances: stats.map((s) => ({
        job_id: s.jobId,
        matrix_key: s.matrixKey,
        runs: s.runs,
        failed_runs: s.failedRuns,
        flaked_runs: s.flakedRuns,
        flake_rate: s.flakeRate,
        fail_rate: s.failRate,
        last_seen: s.lastSeen,
        quarantined: quarantinedKeys.has(instanceKey(s.jobId, s.matrixKey)),
      })),
    });
  });

  return router;
}
