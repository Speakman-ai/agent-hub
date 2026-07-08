/**
 * replay-retention-sweeper.ts — periodic TTL garbage collection for the session
 * replay INDEX ROWS.
 *
 * Session replays are gzipped blobs in the artifact store plus a `session_replays`
 * index row. Until retention existed NOTHING expired them, so a busy deployment
 * grew storage without bound. This sweeper enforces a retention window
 * (`config.replayRetentionDays`), the same way Datadog Session Replay defaults to
 * a 30-day TTL.
 *
 * Byte ownership (who deletes the blob) is split by backend, matching the
 * multi-tenant retention decision (S3-native lifecycle for bytes, app sweeper for
 * the index):
 *   - **S3 backend** — the sweeper delegates blob expiry to the S3-native
 *     lifecycle rules (`replay-lifecycle.ts`) keyed on the storage prefix ONLY
 *     when provisioning is CONFIRMED (`isLifecycleProvisioned()`), because an O(n)
 *     list+delete sweep on the event loop does not scale and can't tier cold
 *     objects. In that case it removes just the index row, reconciling SQLite
 *     against the bytes lifecycle reaps. If provisioning is NOT confirmed (e.g. a
 *     missing `s3:PutLifecycleConfiguration` permission — provisioning is
 *     best-effort), the sweeper falls back to deleting the object itself before
 *     the row, so dropping the only pointer can never strand un-indexed,
 *     never-expiring S3 orphans (the exact failure this feature exists to avoid).
 *   - **Local backend** — there is no lifecycle mechanism for on-disk files, so
 *     the sweeper still deletes the local blob to reclaim disk (single-host /
 *     dev installs). This is the orphan/reclamation path for that backend.
 *
 * Policy:
 *   - Retention runs when the global window is on (`replayRetentionDays > 0`) OR
 *     any project sets a per-tenant BASE override (`getRetentionOverrides`); with
 *     neither the sweep is a no-op, matching the off/opt-in posture. Each
 *     overriding tenant gets its own bounded pass at its own (tighter) cutoff and
 *     `project_id` filter so a heavy tenant can't stall another tenant's window.
 *   - Only UNLINKED replays are deleted. A replay attached to a support ticket
 *     or kanban card (`support_ticket_id` / `card_id`) is an intentional triage
 *     artifact; expiring it would silently destroy investigation history, so
 *     those are excluded by the query and never swept.
 *   - Sessions FLAGGED for extended retention (a future `retained_until`, set by
 *     `POST /api/replays/:id/retention`) are exempt from the default expiry until
 *     that instant passes. The 15-month clock starts when the flag is enabled,
 *     not at capture (`replay-retention.ts`). Once `retained_until` lapses the
 *     row rejoins the normal sweep.
 *   - Byte-then-row ordering (local backend): the blob is removed before the row
 *     so we never strand a row pointing at a missing blob, and an idempotent
 *     store.delete tolerates an already-gone object on retry.
 *   - Work is bounded per sweep (`maxPerSweep`) so a large backlog drains over
 *     several ticks instead of blocking the event loop. Oldest-first ordering
 *     means the longest-lived captures go first.
 */

import { getArtifactStoreForLocation } from '../artifacts/artifact-store.js';
import { toSqliteUtc } from './replay-retention.js';
import type { ProjectRetentionOverride } from './replay-config.js';
import type { AppConfig, SessionReplayRow, Stmts } from '../types.js';

// Re-exported from the pure retention module (`replay-retention.ts`) so existing
// importers (and the sweeper test) keep resolving it from here.
export { toSqliteUtc };

/** Default cadence: sweep every 6 hours. Retention is a slow-moving TTL, not a
 *  realtime concern, so an infrequent sweep keeps overhead negligible. */
export const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Default ceiling on deletions per sweep so a huge backlog can't wedge the loop
 *  on one tick. A backlog larger than this drains across subsequent sweeps. */
export const DEFAULT_MAX_PER_SWEEP = 500;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ReplayRetentionDeps {
  stmts: Stmts;
  config: AppConfig;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /** Optional structured logger. Defaults to console.error. */
  log?: (msg: string) => void;
  /**
   * Whether the GLOBAL `rum/` S3-native lifecycle rule is CONFIRMED provisioned.
   * Only when this returns true does the DEFAULT (global-window) pass trust the
   * bucket lifecycle to expire S3 bytes and drop just the index row; otherwise it
   * deletes the object itself so a provisioning gap (best-effort, may fail on a
   * missing IAM permission) can't orphan un-indexed bytes. Read fresh each sweep
   * (provisioning completes asynchronously after boot). Defaults to "not
   * provisioned" (safe fallback).
   */
  isLifecycleProvisioned?: () => boolean;
  /**
   * Whether the PER-PROJECT `rum/<project>/` S3 lifecycle rule for a specific
   * tenant is CONFIRMED provisioned. A per-tenant pass may only delegate S3 byte
   * expiry to lifecycle once THIS tenant's own (tighter) prefix rule is confirmed
   * installed — the global `rum/` rule expires at the looser global window, so
   * trusting it for a tighter-window tenant would keep bytes past the tenant's
   * contract (or forever, when the global window is off). Until confirmed, the
   * per-tenant pass deletes the bytes itself (no orphans, honors the tighter
   * window). Read fresh each sweep. Defaults to "not provisioned" (safe fallback).
   */
  isProjectLifecycleProvisioned?: (projectId: string) => boolean;
  /**
   * Projects whose effective BASE (hot/index) retention window differs from the
   * global default (see `collectRetentionOverrides`). Each gets its own bounded
   * pass at its own tighter cutoff and `project_id` filter, so a heavy tenant
   * can't stall another tenant's window and each per-tenant override is enforced.
   * Read fresh each sweep so project edits take effect without a restart. Unset /
   * empty → the single global-window pass (legacy behavior).
   */
  getRetentionOverrides?: () => ProjectRetentionOverride[];
}

export interface RetentionSweepResult {
  /** Whether retention ran (global `replayRetentionDays > 0` OR any per-project
   *  override is set). */
  enabled: boolean;
  /** The GLOBAL-window cutoff; rows older than this were eligible in the default
   *  pass. Null when the global window is off (only per-project passes ran). */
  cutoff: string | null;
  /** Number of replays whose blob + row were removed this sweep (all passes). */
  deleted: number;
  /** Replays matched but whose deletion threw (left for the next sweep). */
  failed: number;
}

/**
 * Expire one replay's INDEX ROW, reclaiming its bytes only when the app must own
 * them. For a local-backed row the blob is deleted first (no lifecycle for on-disk
 * files), then the row. For an S3-backed row the object is left for the bucket
 * lifecycle rules to expire ONLY when `lifecycleProvisioned` is true; otherwise
 * (provisioning failed / unconfirmed) the object is deleted here first, so
 * dropping the row can never strand an un-indexed, never-expiring S3 orphan.
 * Bytes-before-row ordering keeps a failed delete from orphaning the row.
 */
export async function expireReplayRow(
  deps: { stmts: Stmts; config: AppConfig },
  row: SessionReplayRow,
  lifecycleProvisioned: boolean = false,
): Promise<void> {
  const store = getArtifactStoreForLocation(row, deps.config);
  // Local: always reclaim the file. S3: reclaim only when we CAN'T trust the
  // bucket lifecycle to do it (unconfirmed provisioning) — the safe fallback.
  if (store.kind === 'local' || !lifecycleProvisioned) {
    await store.delete(row.storage_key);
  }
  deps.stmts.deleteSessionReplay.run(row.id);
  // Reap any playlist memberships so a swept capture leaves no orphan rows.
  deps.stmts.deleteReplayPlaylistItemsByReplay.run(row.id);
}

/**
 * Run one retention sweep. Deletes up to `maxPerSweep` expired, unlinked
 * replays. Safe to call when retention is disabled (returns immediately with
 * `enabled: false`). Never throws for an individual blob-delete failure — it
 * counts the failure and moves on so one bad object can't stall the whole sweep.
 */
export async function runReplayRetentionSweep(
  deps: ReplayRetentionDeps,
  maxPerSweep: number = DEFAULT_MAX_PER_SWEEP,
): Promise<RetentionSweepResult> {
  const { stmts, config } = deps;
  const log = deps.log ?? ((msg: string) => console.error(msg));
  const now = deps.now ?? Date.now;

  const globalDays = config.replayRetentionDays;
  const globalEnabled = Number.isFinite(globalDays) && globalDays > 0;
  const overrides = deps.getRetentionOverrides?.() ?? [];
  // Nothing to do when neither a global window nor any per-tenant override exists.
  if (!globalEnabled && overrides.length === 0) {
    return { enabled: false, cutoff: null, deleted: 0, failed: 0 };
  }

  const nowMs = now();
  // A session flagged for extended retention carries a future `retained_until`;
  // it stays exempt from every pass until that instant passes. Pass the current
  // UTC instant so each query can filter those rows out.
  const nowUtc = toSqliteUtc(nowMs);
  const cap = Math.max(1, Math.trunc(maxPerSweep));

  let deleted = 0;
  let failed = 0;
  // `provisioned` is scoped PER PASS: the default pass trusts the global `rum/`
  // rule; a per-tenant pass trusts ONLY that tenant's own `rum/<project>/` rule.
  const reap = async (rows: SessionReplayRow[], provisioned: boolean): Promise<void> => {
    for (const row of rows) {
      try {
        await expireReplayRow({ stmts, config }, row, provisioned);
        deleted += 1;
      } catch (err) {
        failed += 1;
        log(`[replay-retention] failed to delete replay ${row.id}: ${(err as Error).message}`);
      }
    }
  };

  // Per-tenant passes first: each override gets its own bounded budget at its own
  // tighter cutoff + project_id filter, so a heavy tenant can't starve another's
  // window (batch-stall avoidance). Overrides only tighten, so a row reaped here
  // would also be eligible in the looser global pass below — reaping it here
  // first keeps the global pass's budget for default-window tenants. A per-tenant
  // pass delegates S3 bytes to lifecycle ONLY when this tenant's own prefix rule
  // is confirmed provisioned; otherwise the bytes are deleted here (the global
  // rule would keep them past the tenant's tighter window / forever if global-off).
  for (const o of overrides) {
    const cutoff = toSqliteUtc(nowMs - o.retentionDays * MS_PER_DAY);
    const projectProvisioned = deps.isProjectLifecycleProvisioned?.(o.projectId) ?? false;
    const rows = stmts.getExpiredUnlinkedSessionReplaysByProject.all(
      cutoff,
      nowUtc,
      o.projectId,
      cap,
    ) as SessionReplayRow[];
    await reap(rows, projectProvisioned);
  }

  // Default pass at the global window (skipped when the global window is off:
  // non-overridden tenants keep-forever). Harmlessly mops up any overridden-tenant
  // rows past the global window too (delete is idempotent), but in steady state
  // the per-tenant pass already reaped them at the tighter cutoff.
  let globalCutoff: string | null = null;
  if (globalEnabled) {
    const globalProvisioned = deps.isLifecycleProvisioned?.() ?? false;
    globalCutoff = toSqliteUtc(nowMs - globalDays * MS_PER_DAY);
    const rows = stmts.getExpiredUnlinkedSessionReplays.all(
      globalCutoff,
      nowUtc,
      cap,
    ) as SessionReplayRow[];
    await reap(rows, globalProvisioned);
  }

  if (deleted > 0 || failed > 0) {
    const windowDesc = globalEnabled ? `${globalDays}d global` : 'per-tenant';
    log(
      `[replay-retention] swept ${deleted} expired replay(s) ` +
        `(${windowDesc}${overrides.length ? ` + ${overrides.length} tenant override(s)` : ''})` +
        `${failed ? `, ${failed} failed` : ''}`,
    );
  }

  return { enabled: true, cutoff: globalCutoff, deleted, failed };
}

/**
 * Launch the periodic retention sweeper. Mirrors `startStalePrChecker`: the
 * first run is scheduled one interval ahead (nothing is freshly expired at
 * boot), the timer is `unref`'d so it never keeps the process alive, and the
 * returned function clears it. Returns a no-op stopper when retention is
 * disabled so callers don't have to special-case the config.
 */
export function startReplayRetentionSweeper(
  deps: ReplayRetentionDeps,
  intervalMs: number = RETENTION_SWEEP_INTERVAL_MS,
): () => void {
  const globalEnabled =
    Number.isFinite(deps.config.replayRetentionDays) && deps.config.replayRetentionDays > 0;
  // Start the timer when a global window is set OR per-tenant overrides may exist
  // (the dep is wired). A project can enable/disable an override at runtime, so
  // with the dep present we always run and let each sweep no-op when idle.
  if (!globalEnabled && !deps.getRetentionOverrides) {
    return () => {};
  }
  const timer = setInterval(() => {
    runReplayRetentionSweep(deps).catch((err) => {
      const log = deps.log ?? ((msg: string) => console.error(msg));
      log(`[replay-retention] sweep failed: ${(err as Error).message}`);
    });
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
