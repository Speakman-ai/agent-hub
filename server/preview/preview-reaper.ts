/**
 * Worktree-preview reaper.
 *
 * Walks `worktree_previews` once per tick (default 60 s, scheduled
 * from `heartbeat.ts`) and tears down rows whose `last_active_at` is
 * older than the project's configured idle TTL.
 *
 * Mirrors the invariants of the (now-deleted) PR-env reaper — there is
 * a long-form rationale in the history of `server/<pr-env-dir>/reaper.ts`
 * for why an authoritative cleanup path is needed even when the happy-path
 * (chat-end / session-delete hook) usually wins. The short version:
 * webhooks drop, sessions get force-killed, the server restarts mid-
 * idle. Without a reaper a stuck preview holds its port forever.
 *
 * Idle TTL resolution:
 *   1. `project.prEnv.preview.idleTTL` (seconds) when set.
 *   2. Constructor default (configurable via `defaultIdleTtlMs`).
 * Bounds 60..86400 are enforced upstream by the validator.
 *
 * Reaping is delegated to the runtime's `stopPreview()` so the SIGTERM
 * + row-delete sequence runs through one path. The reaper only
 * decides *which* rows are stale.
 */

import type { Database } from 'better-sqlite3';
import type { PreviewRuntime } from './preview-runtime.js';
import type { Project } from '../types.js';

/** Default cron — every 60 seconds. */
export const PREVIEW_REAPER_CRON = '* * * * *';

export interface PreviewReaperConfig {
  /** Fallback idle TTL when a project has no `preview.idleTTL` set. Default 600 s. */
  defaultIdleTtlSeconds: number;
}

export const DEFAULT_PREVIEW_REAPER_CONFIG: PreviewReaperConfig = {
  defaultIdleTtlSeconds: 600,
};

export interface PreviewReaperDeps {
  db: Database;
  runtime: PreviewRuntime;
  /**
   * Resolve a project record by id. Returns `null` for rows whose
   * project has been deleted — the reaper treats those as immediately
   * stale (no project means no config, no place to render the iframe).
   */
  getProject: (projectId: string) => Project | null;
  config?: Partial<PreviewReaperConfig>;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
}

export interface PreviewReaperTickResult {
  scanned: number;
  reaped: number;
  orphaned: number;
  notes: string[];
}

interface ScanRow {
  id: string;
  session_id: string;
  project_id: string;
  last_active_at: string;
  status: string;
}

/**
 * Run one reaper pass. Never throws — operational failures are logged
 * + surfaced in `notes`. The return shape matches the legacy PR-env
 * reaper so dashboards / tests can assert against a uniform contract.
 */
export async function runPreviewReaper(deps: PreviewReaperDeps): Promise<PreviewReaperTickResult> {
  const config = { ...DEFAULT_PREVIEW_REAPER_CONFIG, ...(deps.config ?? {}) };
  const logger = deps.logger ?? { log: (m) => console.log(m), warn: (m) => console.warn(m) };
  const result: PreviewReaperTickResult = { scanned: 0, reaped: 0, orphaned: 0, notes: [] };

  // Read from the new groups table — `worktree_previews` is retained
  // for downgrade safety but the runtime writes its canonical state to
  // `worktree_preview_groups` now (see `preview-schema.ts`). The
  // boot-time migration folds any legacy rows into the new tables, so
  // this query sees the union of legacy + new state.
  const rows = deps.db
    .prepare(
      `SELECT id, session_id, project_id, last_active_at, status
         FROM worktree_preview_groups
        WHERE status IN ('starting','ready','failed')`,
    )
    .all() as ScanRow[];
  result.scanned = rows.length;
  if (rows.length === 0) return result;

  const nowMs = Date.now();
  for (const row of rows) {
    const project = deps.getProject(row.project_id);
    if (!project) {
      // Project gone → reap. No config to consult; the row is orphaned.
      try {
        await deps.runtime.stopPreview(row.id);
        result.orphaned++;
        result.notes.push(`reaped orphan ${row.id} (project ${row.project_id} missing)`);
      } catch (err) {
        logger.warn(`[preview-reaper] stopPreview(${row.id}) failed: ${(err as Error).message}`);
      }
      continue;
    }
    const ttlSec = resolveIdleTtl(project, config.defaultIdleTtlSeconds);
    const lastActiveMs = parseDbTime(row.last_active_at);
    if (lastActiveMs == null) continue; // unparseable timestamp — skip; next tick will retry
    const idleMs = nowMs - lastActiveMs;
    if (idleMs < ttlSec * 1000) continue;
    try {
      await deps.runtime.stopPreview(row.id);
      result.reaped++;
      result.notes.push(`reaped ${row.id} (idle ${Math.round(idleMs / 1000)}s ≥ ttl ${ttlSec}s)`);
    } catch (err) {
      logger.warn(`[preview-reaper] stopPreview(${row.id}) failed: ${(err as Error).message}`);
    }
  }
  if (result.reaped > 0 || result.orphaned > 0) {
    logger.log(
      `[preview-reaper] tick: scanned=${result.scanned} reaped=${result.reaped} orphaned=${result.orphaned}`,
    );
  }
  return result;
}

function resolveIdleTtl(project: Project, fallbackSec: number): number {
  const v = project.prEnv?.preview?.idleTTL;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  return fallbackSec;
}

/**
 * Parse the `datetime('now')` / ISO format that SQLite emits without a
 * trailing Z. Returns null on missing/unparseable input so callers can
 * skip the row instead of NaN-bombing the comparison.
 */
function parseDbTime(raw: string | null): number | null {
  if (!raw) return null;
  const normalised = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
  const parsed = Date.parse(normalised);
  return Number.isFinite(parsed) ? parsed : null;
}
