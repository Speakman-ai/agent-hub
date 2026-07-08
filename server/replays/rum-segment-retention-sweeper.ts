/**
 * rum-segment-retention-sweeper.ts — periodic TTL garbage collection for the
 * SEGMENTED replay index rows (`rum_sessions` + `rum_segments`).
 *
 * The monolithic sweeper (`replay-retention-sweeper.ts`) reaps the
 * `session_replays` index. Segmented captures live in a different table set:
 * one `rum_segments` row per S3 object plus one `rum_sessions` rollup row per
 * client-minted session. Until now those rows were only ever deleted by an
 * explicit `deleteSessionSegments` on session delete — there was NO age-based
 * sweep. Once the S3-native lifecycle rule (T61) expires the `rum/` bytes, the
 * index rows point at objects that no longer exist and grow without bound. This
 * sweeper reconciles the index against that byte expiry.
 *
 * Byte ownership mirrors the monolithic sweeper and the locked retention
 * decision (S3-native lifecycle owns bytes; the app sweeper owns the index +
 * orphan reconciliation):
 *   - **S3 segment, lifecycle CONFIRMED provisioned** → drop ONLY the index rows;
 *     the object is left for the bucket lifecycle rule to expire. The sweeper
 *     issues no S3 delete, so it can't be the bottleneck at scale.
 *   - **S3 segment, provisioning UNCONFIRMED** → delete the object itself before
 *     the rows. Provisioning is best-effort (a missing IAM permission only logs),
 *     so in that failure mode lifecycle would NEVER expire the object; dropping
 *     the only pointer would strand an un-indexed, never-expiring orphan.
 *   - **Local segment** → delete the on-disk blob to reclaim disk (there is no
 *     lifecycle mechanism for on-disk files).
 *
 * Age basis: a session's `rum_sessions.updated_at` bumps on every segment
 * rollup, so it is the wall-clock of the session's NEWEST segment. Reaping a
 * session only once that instant is older than the retention cutoff guarantees
 * ALL its segment objects are already past their own expiry — we can never drop
 * an index row whose bytes still live. Byte-before-row ordering (and an
 * idempotent store.delete that tolerates an already-gone object) means a failed
 * delete leaves the rows for the next sweep instead of stranding bytes.
 *
 * Policy mirrors the monolithic sweeper: OFF unless `replayRetentionDays > 0`,
 * bounded per sweep (`maxPerSweep`) so a large backlog drains over several ticks,
 * oldest-first so the longest-lived rows go first.
 */

import { getArtifactStoreForLocation } from '../artifacts/artifact-store.js';
import { listSessionSegments } from './segment-store.js';
import { toSqliteUtc } from './replay-retention.js';
import { RETENTION_SWEEP_INTERVAL_MS, DEFAULT_MAX_PER_SWEEP } from './replay-retention-sweeper.js';
import type { AppConfig, RumSegmentRow, RumSessionRow, Stmts } from '../types.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RumSegmentRetentionDeps {
  stmts: Stmts;
  config: AppConfig;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /** Optional structured logger. Defaults to console.error. */
  log?: (msg: string) => void;
  /**
   * Whether the S3-native RUM lifecycle policy is CONFIRMED provisioned. Only
   * when this returns true does the sweeper trust the bucket lifecycle to expire
   * S3 segment objects and drop just the index rows; otherwise it deletes the
   * object itself so a provisioning gap can't orphan un-indexed bytes. Read fresh
   * each sweep. Defaults to "not provisioned" (the safe fallback).
   */
  isLifecycleProvisioned?: () => boolean;
}

export interface RumSegmentSweepResult {
  /** Whether retention is enabled (replayRetentionDays > 0). */
  enabled: boolean;
  /** ISO cutoff; rows older than this were eligible. Null when disabled. */
  cutoff: string | null;
  /** Number of `rum_sessions` rows reaped this sweep. */
  sessionsDeleted: number;
  /** Number of `rum_segments` rows reaped this sweep (session-keyed + orphan). */
  segmentsDeleted: number;
  /** Sessions/orphan-segments matched but whose deletion threw (left for next sweep). */
  failed: number;
}

/**
 * Reclaim one segment's bytes IF the app must own them. Branches EXPLICITLY on
 * the storage backend so byte ownership is never inferred from a fallthrough:
 *   - `local`  → always delete (no lifecycle mechanism for on-disk files).
 *   - `s3` + lifecycle CONFIRMED provisioned → return without deleting; the
 *     bucket lifecycle rule owns the bytes.
 *   - `s3` + provisioning UNCONFIRMED → delete the object ourselves (lifecycle
 *     may never run, so dropping the row would strand an orphan).
 *   - anything else (corrupt/unknown `storage_kind`) → THROW. We can't reason
 *     about who owns the bytes, so we must not let the caller drop the index row
 *     — the byte-before-row invariant. The caller counts it failed and leaves the
 *     rows for the next sweep.
 * Also throws on a delete failure so the caller can leave the rows for retry.
 */
async function reclaimSegmentBytes(
  config: AppConfig,
  seg: RumSegmentRow,
  lifecycleProvisioned: boolean,
): Promise<void> {
  if (seg.storage_kind === 'local') {
    await getArtifactStoreForLocation(seg, config).delete(seg.storage_key);
    return;
  }
  if (seg.storage_kind === 's3') {
    if (lifecycleProvisioned) return;
    await getArtifactStoreForLocation(seg, config).delete(seg.storage_key);
    return;
  }
  throw new Error(`unknown storage_kind "${seg.storage_kind}" for segment ${seg.id}`);
}

/** Outcome of expiring one session: how many segment rows were dropped and
 *  whether the session-grain row itself was removed (false when a mid-sweep
 *  ingest refreshed it past the cutoff and it was intentionally kept). */
export interface ExpireRumSessionResult {
  segmentsDeleted: number;
  sessionDeleted: boolean;
}

/**
 * Expire one session's index against the retention `cutoff`: reclaim the bytes of
 * the segments observed NOW (gated on backend + lifecycle-provisioned), then drop
 * exactly those segment rows and — only if the session is still expired — the
 * `rum_sessions` rollup row. Bytes-before-rows so a delete failure leaves the
 * rows for the next sweep rather than stranding an object. Throws if any byte
 * delete fails.
 *
 * Concurrency: byte reclamation is the only `await` (it yields the event loop), so
 * a late ingest for this same session can append a NEW segment and bump
 * `updated_at` while we reclaim. Two guards make that safe:
 *   1. We delete ONLY the segment ids we actually listed+reclaimed — never the
 *      newly-appended one, whose bytes we never touched.
 *   2. The session row delete is conditional on `updated_at < cutoff`, so a
 *      refreshed (now-active) session is KEPT rather than dropped out from under
 *      its fresh segment.
 * Everything after the reclamation loop is fully SYNCHRONOUS (no `await`), so no
 * concurrent append can interleave between the row deletes in the single-process
 * Hub — the same assumption `rum-session-store.ts` relies on.
 */
export async function expireRumSession(
  deps: { stmts: Stmts; config: AppConfig },
  sessionId: string,
  cutoff: string,
  lifecycleProvisioned: boolean = false,
): Promise<ExpireRumSessionResult> {
  const segments = listSessionSegments(deps.stmts, sessionId);
  for (const seg of segments) {
    await reclaimSegmentBytes(deps.config, seg, lifecycleProvisioned);
  }
  // --- synchronous from here (no await) ---
  let segmentsDeleted = 0;
  for (const seg of segments) {
    segmentsDeleted += deps.stmts.deleteRumSegment.run(seg.id).changes as number;
  }
  const sessionDeleted =
    (deps.stmts.deleteExpiredRumSession.run(sessionId, cutoff).changes as number) > 0;
  return { segmentsDeleted, sessionDeleted };
}

/**
 * Run one index-only retention sweep over segmented captures. Reaps up to
 * `maxPerSweep` expired sessions (and their segments), then up to `maxPerSweep`
 * orphan segment rows whose session-grain row is already gone. Safe to call when
 * retention is disabled (returns immediately with `enabled: false`). A single
 * row's delete failure is counted and skipped so one bad object can't stall the
 * sweep.
 */
export async function runRumSegmentRetentionSweep(
  deps: RumSegmentRetentionDeps,
  maxPerSweep: number = DEFAULT_MAX_PER_SWEEP,
): Promise<RumSegmentSweepResult> {
  const { stmts, config } = deps;
  const log = deps.log ?? ((msg: string) => console.error(msg));
  const now = deps.now ?? Date.now;

  const days = config.replayRetentionDays;
  if (!Number.isFinite(days) || days <= 0) {
    return { enabled: false, cutoff: null, sessionsDeleted: 0, segmentsDeleted: 0, failed: 0 };
  }

  const cutoff = toSqliteUtc(now() - days * MS_PER_DAY);
  const cap = Math.max(1, Math.trunc(maxPerSweep));
  const lifecycleProvisioned = deps.isLifecycleProvisioned?.() ?? false;

  let sessionsDeleted = 0;
  let segmentsDeleted = 0;
  let failed = 0;

  const sessions = stmts.getExpiredRumSessions.all(cutoff, cap) as RumSessionRow[];
  for (const row of sessions) {
    try {
      const outcome = await expireRumSession(
        { stmts, config },
        row.session_id,
        cutoff,
        lifecycleProvisioned,
      );
      segmentsDeleted += outcome.segmentsDeleted;
      // A session refreshed by a mid-sweep ingest is intentionally kept; only
      // count rows we actually removed.
      if (outcome.sessionDeleted) sessionsDeleted += 1;
    } catch (err) {
      failed += 1;
      log(`[rum-retention] failed to expire session ${row.session_id}: ${(err as Error).message}`);
    }
  }

  // Orphan-segment reconciliation: segments whose rum_sessions row no longer
  // exists (a rollup that threw at ingest, or a partial prior sweep) are never
  // reached by the session-keyed pass. Reap the aged ones directly.
  const orphans = stmts.getExpiredOrphanRumSegments.all(cutoff, cap) as RumSegmentRow[];
  for (const seg of orphans) {
    try {
      await reclaimSegmentBytes(config, seg, lifecycleProvisioned);
      stmts.deleteRumSegment.run(seg.id);
      segmentsDeleted += 1;
    } catch (err) {
      failed += 1;
      log(`[rum-retention] failed to expire orphan segment ${seg.id}: ${(err as Error).message}`);
    }
  }

  if (sessionsDeleted > 0 || segmentsDeleted > 0 || failed > 0) {
    log(
      `[rum-retention] swept ${sessionsDeleted} session(s) / ${segmentsDeleted} segment(s) ` +
        `older than ${cutoff} (${days}d retention)${failed ? `, ${failed} failed` : ''}`,
    );
  }

  return { enabled: true, cutoff, sessionsDeleted, segmentsDeleted, failed };
}

/**
 * Launch the periodic segmented-index sweeper. Mirrors
 * `startReplayRetentionSweeper`: first run scheduled one interval ahead, timer
 * `unref`'d so it never keeps the process alive, and the returned function clears
 * it. Returns a no-op stopper when retention is disabled.
 */
export function startRumSegmentRetentionSweeper(
  deps: RumSegmentRetentionDeps,
  intervalMs: number = RETENTION_SWEEP_INTERVAL_MS,
): () => void {
  if (!Number.isFinite(deps.config.replayRetentionDays) || deps.config.replayRetentionDays <= 0) {
    return () => {};
  }
  const timer = setInterval(() => {
    runRumSegmentRetentionSweep(deps).catch((err) => {
      const log = deps.log ?? ((msg: string) => console.error(msg));
      log(`[rum-retention] sweep failed: ${(err as Error).message}`);
    });
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
