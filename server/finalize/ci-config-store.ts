/**
 * ci-config-store.ts — server-side persistence for a project's Finalize CI
 * config (`ci.yaml` content) when it is NOT committed to the repo.
 *
 * Why this exists
 * ----------------
 * A committed `.agent-hub/ci.yaml` forces one shared gate on everyone who
 * touches the repo — ideal when Agent Hub IS the team's CI. But for repos where
 * Agent Hub is only a build/pre-approve/send-to-GitHub tool for a single
 * operator, committing a Hub-specific config into a repo shared with outside
 * collaborators is noise. This store lets the same `ci.yaml` schema live on the
 * Hub instead of in git. The resolver (`ci-config-source.ts`) always prefers a
 * committed file; this store is the fallback.
 *
 * Scoping
 * -------
 * Two scopes share one table, disambiguated by `owner_user_id`:
 *   - `project` — one shared config per project (`owner_user_id IS NULL`).
 *   - `personal` — a per-user override (`owner_user_id = <uid>`) that only
 *     applies to that user's own Finalize runs, for personal workflow checks.
 * The unique index keys on `(project_id, IFNULL(owner_user_id, ''))` so each
 * (project, scope/user) pair has at most one row; writes upsert in place.
 *
 * This module is the ONLY coupling to the `finalize_server_ci` table. The YAML
 * text is stored verbatim (validated against the ci.yaml schema at the write
 * boundary — the route + wizard call `parseCiConfig` before persisting); this
 * store does not re-validate on read so a schema that a newer Hub build wrote
 * can still be read by an older reader without a parse coupling.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Stmts } from '../types.js';

// ─── DDL ──────────────────────────────────────────────────────────────

/**
 * One row per (project, scope). `owner_user_id IS NULL` is the project-scoped
 * (shared) config; a non-null value is a personal per-user override. The unique
 * index backs the idempotent upsert — SQLite treats each distinct
 * `IFNULL(owner_user_id, '')` as its own key, so a project row and any number of
 * per-user rows coexist for the same project.
 */
export const FINALIZE_SERVER_CI_SCHEMA = `
  CREATE TABLE IF NOT EXISTS finalize_server_ci (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    owner_user_id TEXT,
    yaml_text TEXT NOT NULL,
    updated_by TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_finalize_server_ci_scope
    ON finalize_server_ci(project_id, IFNULL(owner_user_id, ''));
`;

// ─── Types ────────────────────────────────────────────────────────────

/** Raw `finalize_server_ci` row as stored. */
export interface ServerCiConfigRow {
  id: string;
  project_id: string;
  /** NULL = project-scoped (shared); set = personal per-user override. */
  owner_user_id: string | null;
  yaml_text: string;
  updated_by: string | null;
  updated_at: number;
}

export type ServerCiScope = 'project' | 'personal';

type StoreStmts = Pick<
  Stmts,
  | 'getFinalizeServerCi'
  | 'upsertFinalizeServerCi'
  | 'deleteFinalizeServerCi'
  | 'listFinalizeServerCiForProject'
>;

/**
 * The store accepts any `stmts`-like object exposing SOME subset of the
 * server-CI statements. Callers only ever need the statements for the op they
 * invoke — the read-only orchestrator path, for example, is handed a `stmts`
 * with just `getFinalizeServerCi`. We guard per-operation (below) rather than
 * requiring the full set, so a partial `stmts` (common in unit suites, and the
 * orchestrator's own narrowed `Pick`) behaves as "no server config" for the ops
 * it can't service, instead of throwing.
 */
type PartialStoreStmts = Partial<StoreStmts>;

const hasStmt = (
  stmts: PartialStoreStmts,
  key: keyof StoreStmts,
  method: 'get' | 'all' | 'run',
): boolean =>
  typeof (stmts as Record<string, { [m: string]: unknown }>)[key]?.[method] === 'function';

// ─── Reads ────────────────────────────────────────────────────────────

/**
 * Fetch the stored config for one scope. `ownerUserId = null` reads the
 * project-scoped row; a non-null value reads that user's personal override.
 * Returns `null` when absent (or when the statements are not wired). Never
 * throws for a missing statement — see {@link hasStmt}.
 */
export function getServerCiConfig(
  stmts: PartialStoreStmts,
  projectId: string,
  ownerUserId: string | null = null,
): ServerCiConfigRow | null {
  if (!hasStmt(stmts, 'getFinalizeServerCi', 'get')) return null;
  const row = stmts.getFinalizeServerCi!.get(projectId, ownerUserId) as
    | ServerCiConfigRow
    | undefined;
  return row ?? null;
}

/** All stored configs for a project (project-scoped row + every personal one). */
export function listServerCiConfigs(
  stmts: PartialStoreStmts,
  projectId: string,
): ServerCiConfigRow[] {
  if (!hasStmt(stmts, 'listFinalizeServerCiForProject', 'all')) return [];
  return stmts.listFinalizeServerCiForProject!.all(projectId) as ServerCiConfigRow[];
}

// ─── Writes ───────────────────────────────────────────────────────────

export interface UpsertServerCiInput {
  projectId: string;
  /** null/undefined → project scope; a uid → personal scope for that user. */
  ownerUserId?: string | null;
  yamlText: string;
  /** uid of the writer, for audit. */
  updatedBy?: string | null;
}

/**
 * Insert or replace the config for a (project, scope) pair. The caller is
 * responsible for validating `yamlText` against the ci.yaml schema BEFORE
 * calling — this store persists verbatim.
 */
export function upsertServerCiConfig(
  stmts: PartialStoreStmts,
  input: UpsertServerCiInput,
  now: () => number = Date.now,
  newId: () => string = uuidv4,
): ServerCiConfigRow {
  if (!hasStmt(stmts, 'upsertFinalizeServerCi', 'run')) {
    throw new Error('finalize_server_ci statements are not available on this Hub build');
  }
  const ownerUserId = input.ownerUserId ?? null;
  const id = newId();
  stmts.upsertFinalizeServerCi!.run(
    id,
    input.projectId,
    ownerUserId,
    input.yamlText,
    input.updatedBy ?? null,
    now(),
  );
  // Read back so the returned row reflects the actual (possibly pre-existing)
  // id after an upsert conflict.
  const row = getServerCiConfig(stmts, input.projectId, ownerUserId);
  if (!row) throw new Error('finalize_server_ci upsert did not persist a row');
  return row;
}

/** Remove one scope's config. Returns true when a row was deleted. */
export function deleteServerCiConfig(
  stmts: PartialStoreStmts,
  projectId: string,
  ownerUserId: string | null = null,
): boolean {
  if (!hasStmt(stmts, 'deleteFinalizeServerCi', 'run')) return false;
  const info = stmts.deleteFinalizeServerCi!.run(projectId, ownerUserId);
  return info.changes > 0;
}
