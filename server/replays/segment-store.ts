/**
 * Append-only per-segment storage for `segmented` replays.
 *
 * The monolithic backend (`replay-store.ts`) appends by gunzip-concat-regzip of
 * the whole growing blob — O(n²) in session length, which caps flush cadence and
 * re-uploads the entire capture every flush. This backend replaces that for
 * continuous capture: each flush writes ONE gzipped S3 object holding just that
 * segment's events (O(1) append — one PUT, one INSERT, never re-reading prior
 * segments), and a `rum_segments` manifest row indexes the pointer + metadata.
 *
 * Layout (Datadog-style, session→view→segment):
 *   rum/<project>/<yyyy>/<mm>/<dd>/<sessionId>/<viewId>/<index_in_view>.json.gz
 * Segments are view-scoped and never span views; every view opens with a fresh
 * full snapshot at index_in_view=0. Playback lists segments ordered by
 * (start_ts, index_in_view) and concatenates client-side.
 *
 * S3 is the byte source of truth; SQLite indexes pointers + metadata. The
 * segment object reuses the monolithic `{events, meta}` gzip envelope
 * (`encodeReplayBlob`/`decodeReplayBlob`) so playback decodes both layouts the
 * same way.
 */
import { v4 as uuidv4 } from 'uuid';
import type { AppConfig, RumSegmentRow, RumSessionRow, Stmts } from '../types.js';
import { getArtifactStore, getArtifactStoreForLocation } from '../artifacts/artifact-store.js';
import {
  encodeReplayBlob,
  decodeReplayBlob,
  computeDurationMs,
  type ReplayEvent,
  type ReplayBlob,
} from './replay-store.js';
import {
  rollupSegmentIntoSession,
  extractSegmentRollupCounts,
  extractSegmentUser,
} from './rum-session-store.js';
import type { SessionEnrichment } from './rum-enrichment.js';
import { getRumEventsDbIfPresent } from './rum-events-db.js';
import { isWalUnderPressure, WalPressureError } from '../db-checkpoint.js';
import { activeRetention } from './replay-retention.js';
import { withSessionLock } from './session-lock.js';

const SEGMENT_CONTENT_TYPE = 'application/gzip';

/** rrweb EventType.FullSnapshot — the marker index_in_view=0 must carry. */
const RRWEB_FULL_SNAPSHOT = 2;

/** Two-digit zero-pad for the yyyy/mm/dd date-partition path segments. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Sanitize a path component so a client-minted id can never traverse outside the
 * storage root. Same defensive rule as `buildReplayKey`.
 */
function safeSegment(s: string): string {
  // Char-sanitize, then collapse any dot-run (`..`, `...`) so no component can
  // be a traversal token — belt-and-braces with LocalArtifactStore's own
  // containment check and S3's literal-key semantics.
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '_');
  return cleaned.length > 0 ? cleaned : '_';
}

/**
 * The S3 key prefix all of one project's segment objects live under:
 * `rum/<safe(projectId)>/`. Applies the SAME id sanitization as
 * {@link buildSegmentKey} (a client-minted project id can't traverse the storage
 * root), so a per-project S3 lifecycle rule keyed on this prefix matches the
 * exact objects the store writes. `null` (anonymous ingest) → `rum/_anon/`. Pure.
 */
export function buildProjectStoragePrefix(projectId?: string | null): string {
  return `rum/${safeSegment(projectId ?? '_anon')}/`;
}

/**
 * Build the storage key for a segment object. Date-partitioned by the segment's
 * start timestamp (epoch ms, UTC) so S3 lifecycle rules can key on the
 * tenant/date prefix. `projectId` null (anonymous ingest) partitions under
 * `_anon`. All id inputs are sanitized. Pure — no IO.
 */
export function buildSegmentKey(input: {
  projectId?: string | null;
  sessionId: string;
  viewId: string;
  indexInView: number;
  startTs: number;
}): string {
  const project = safeSegment(input.projectId ?? '_anon');
  const session = safeSegment(input.sessionId);
  const view = safeSegment(input.viewId);
  const idx = Math.max(0, Math.floor(input.indexInView));
  // Partition by the segment's own start time; fall back to epoch 0 when empty.
  const d = new Date(Number.isFinite(input.startTs) ? input.startTs : 0);
  const yyyy = d.getUTCFullYear();
  const mm = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  return `rum/${project}/${yyyy}/${mm}/${dd}/${session}/${view}/${idx}.json.gz`;
}

/**
 * Prefix for segment objects of a session someone chose to Keep. It sits outside
 * `rum/` on purpose: the S3 lifecycle rules expire everything under `rum/`, and S3
 * always applies the shortest matching expiration, so a kept session's bytes have
 * to live somewhere no rule matches. The app sweeper owns deleting them once the
 * Keep lapses.
 */
export const RUM_RETAINED_STORAGE_PREFIX = 'rum-retained/';

const RUM_PREFIX = 'rum/';

/** True when a segment object lives under the kept (non-lifecycle) prefix. */
export function isRetainedSegmentKey(key: string): boolean {
  return key.startsWith(RUM_RETAINED_STORAGE_PREFIX);
}

/** Map a `rum/...` segment key to its kept location (`rum-retained/...`),
 *  keeping the rest of the path. Idempotent on an already-kept key. Pure. */
export function toRetainedSegmentKey(key: string): string {
  if (isRetainedSegmentKey(key)) return key;
  const rest = key.startsWith(RUM_PREFIX) ? key.slice(RUM_PREFIX.length) : key;
  return `${RUM_RETAINED_STORAGE_PREFIX}${rest}`;
}

/** Whether a session row carries a Keep flag that hasn't lapsed at `nowMs`. */
export function isSessionRetained(
  row: Pick<RumSessionRow, 'retained_until'> | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  return activeRetention(row?.retained_until, null, nowMs).retainedUntil !== null;
}

/**
 * A kept session still has S3 segments under the expiring `rum/` prefix: its Keep
 * didn't finish moving them, so lifecycle can still delete those bytes. Local
 * segments never move (no lifecycle on disk) and don't count.
 */
export function isRelocationPending(
  session: Pick<RumSessionRow, 'retained_until'> | null | undefined,
  segments: Pick<RumSegmentRow, 'storage_kind' | 'storage_key'>[],
  nowMs: number = Date.now(),
): boolean {
  if (!isSessionRetained(session, nowMs)) return false;
  return segments.some((s) => s.storage_kind === 's3' && !isRetainedSegmentKey(s.storage_key));
}

/** Earliest/latest event timestamps in a segment (epoch ms). 0/0 when empty. */
export function segmentTimeBounds(events: ReplayEvent[]): { start: number; end: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const e of events) {
    const t = e.timestamp;
    if (typeof t !== 'number' || Number.isNaN(t)) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (min === Infinity || max === -Infinity) return { start: 0, end: 0 };
  return { start: min, end: max };
}

export interface SegmentStoreDeps {
  stmts: Stmts;
  config: AppConfig;
}

export interface AppendSegmentInput {
  /** Explicit segment id; minted when omitted. */
  id?: string;
  sessionId: string;
  viewId: string;
  /** 0-based position within the view. Index 0 must carry a full snapshot. */
  indexInView: number;
  projectId?: string | null;
  events: ReplayEvent[];
  meta?: Record<string, unknown> | null;
  /** Request-derived facets (device/browser/os/geo) computed by the ingest route
   *  from the HTTP User-Agent + client IP (`computeEnrichment`). Rolled into the
   *  session row first-non-null-wins; null/omitted leaves the row's facets as-is. */
  enrichment?: SessionEnrichment | null;
}

/**
 * Thrown by `appendSegment` when index_in_view=0 (the view-opening segment)
 * carries no rrweb full snapshot. Every view must open with a fresh snapshot so
 * playback can reconstruct the DOM without replaying prior views.
 */
export class SegmentNeedsSnapshotError extends Error {
  constructor() {
    super('the view-opening segment (index_in_view=0) must include a full snapshot (type 2)');
    this.name = 'SegmentNeedsSnapshotError';
  }
}

/**
 * Append ONE segment: gzip just this segment's events, write a single object,
 * insert the manifest row. O(1) — no prior segment is read or re-gzipped.
 *
 * The manifest row is claimed FIRST (same ordering as `storeReplay`): the UNIQUE
 * (session_id, view_id, index_in_view) index makes a reused slot throw before
 * `store.put`, so a duplicate index can never clobber an existing segment's
 * object. Because the INSERT autocommits before the PUT completes, the manifest
 * row is briefly visible to a concurrent reader before its S3 object exists — a
 * `readSegment`/`readSessionEvents` racing an in-flight append can therefore
 * throw from `getBuffer` (harmless today: no live-capture read consumer is
 * wired). On a PUT failure the row is rolled back so the manifest never points at
 * a missing object; that rollback is best-effort and NOT atomic — a crash between
 * the failed PUT and the row delete can leave an orphan manifest row, which the
 * retention/reconciliation sweeper is expected to reap.
 *
 * `index_in_view` gap-freeness / monotonicity is NOT enforced: the client owns
 * segment sequencing (like Datadog), so appending index 0 then index 5 is
 * accepted by design. The UNIQUE index only guards against double-writing the
 * SAME slot; playback tolerates gaps by ordering on the indices that do exist.
 */
export async function appendSegment(
  deps: SegmentStoreDeps,
  input: AppendSegmentInput,
): Promise<RumSegmentRow> {
  // WAL-pressure backpressure: if rum.db has grown past its hard limit and cannot
  // be checkpointed, reject the ingest (mapped to 503 by the route) so segment
  // writes stop appending to — and growing — the WAL until it drains.
  const rumDb = getRumEventsDbIfPresent();
  if (rumDb && isWalUnderPressure(rumDb)) {
    throw new WalPressureError('rum.db');
  }
  // Held through the upload and row publish, so a concurrent Keep either sees
  // this segment already stored or sets the flag before its key is chosen.
  return withSessionLock(input.sessionId, () => appendSegmentLocked(deps, input));
}

async function appendSegmentLocked(
  deps: SegmentStoreDeps,
  input: AppendSegmentInput,
): Promise<RumSegmentRow> {
  const { stmts, config } = deps;
  const indexInView = Math.max(0, Math.floor(input.indexInView));
  const hasFullSnapshot = input.events.some((e) => e.type === RRWEB_FULL_SNAPSHOT);

  if (indexInView === 0 && !hasFullSnapshot) {
    throw new SegmentNeedsSnapshotError();
  }

  const id = input.id ?? uuidv4();
  const meta = input.meta ?? null;
  const { start, end } = segmentTimeBounds(input.events);
  const { buffer } = await encodeReplayBlob(input.events, meta);

  const store = getArtifactStore(config);
  const projectId = input.projectId ?? null;
  const baseKey = buildSegmentKey({
    projectId,
    sessionId: input.sessionId,
    viewId: input.viewId,
    indexInView,
    startTs: start,
  });
  // A session kept while still recording writes its new segments straight to
  // the kept prefix, so they aren't left behind for the lifecycle rule.
  const sessionRow = stmts.getRumSession.get(input.sessionId) as RumSessionRow | undefined;
  const key = isSessionRetained(sessionRow) ? toRetainedSegmentKey(baseKey) : baseKey;
  const storageBucket = store.kind === 's3' ? config.artifactsBucket : null;
  const storageRegion = store.kind === 's3' ? config.artifactsBucketRegion : null;

  // Claim the manifest slot before touching object storage. A reused
  // (session, view, index) fails the UNIQUE index here and never reaches
  // store.put, so it cannot overwrite an existing segment's bytes.
  stmts.insertRumSegment.run(
    id,
    input.sessionId,
    input.viewId,
    projectId,
    indexInView,
    hasFullSnapshot ? 1 : 0,
    start,
    end,
    input.events.length,
    buffer.length,
    store.kind,
    key,
    storageBucket,
    storageRegion,
  );

  try {
    await store.put(key, buffer, SEGMENT_CONTENT_TYPE);
  } catch (err) {
    try {
      stmts.deleteRumSegment.run(id);
    } catch {
      /* best-effort */
    }
    try {
      await store.delete(key);
    } catch {
      /* best-effort — surface the original put error */
    }
    throw err;
  }

  // Roll this now-durable segment into the session-grain metadata row the
  // dashboard lists/filters (view/action/error/frustration counts, time spent).
  // Runs AFTER the object PUT so a counted segment always has its bytes; a
  // rollup failure must NOT fail an already-committed append (the row can be
  // reconciled), so it is best-effort.
  try {
    rollupSegmentIntoSession(stmts, {
      sessionId: input.sessionId,
      projectId,
      indexInView,
      startTs: start,
      endTs: end,
      counts: extractSegmentRollupCounts(meta),
      user: extractSegmentUser(meta),
      enrichment: input.enrichment ?? null,
    });
  } catch (err) {
    console.warn(
      '[Replays] session rollup update failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  return stmts.getRumSegment.get(id) as RumSegmentRow;
}

/**
 * The playback manifest for a whole session: every segment across all views,
 * ordered chronologically (start_ts) then by index within a view. Concatenating
 * the decoded events in this order reconstructs the session.
 */
export function listSessionSegments(stmts: Stmts, sessionId: string): RumSegmentRow[] {
  return stmts.listRumSegmentsBySession.all(sessionId) as RumSegmentRow[];
}

/** The manifest for a single view, strictly by append order (index_in_view). */
export function listViewSegments(stmts: Stmts, sessionId: string, viewId: string): RumSegmentRow[] {
  return stmts.listRumSegmentsByView.all(sessionId, viewId) as RumSegmentRow[];
}

/** One playback-manifest entry: the pointer + metadata a player needs to decide
 *  when/whether to fetch a segment, plus the URL to fetch its decoded events. */
export interface SegmentManifestEntry {
  segmentId: string;
  viewId: string;
  indexInView: number;
  hasFullSnapshot: boolean;
  startTs: number;
  endTs: number;
  eventCount: number;
  byteSize: number;
  /** Per-segment events endpoint the player fetches to concat this slice. */
  eventsUrl: string;
}

/** The whole session's playback manifest: every segment in playback order plus
 *  session-level rollups the player/dashboard reads without fetching bytes. */
export interface SessionSegmentManifest {
  sessionId: string;
  storageLayout: 'segmented';
  /** Attribution shared by the session's segments (NULL for anonymous ingest). */
  projectId: string | null;
  segmentCount: number;
  /** Span between the earliest segment start and latest segment end, in ms. */
  durationMs: number;
  /** Keep (extended retention) instant, SQLite-UTC, or null on the default window. */
  retainedUntil: string | null;
  /** When Keep was enabled, or null. */
  retentionFlaggedAt: string | null;
  /** Kept, but some S3 segments are still under the expiring `rum/` prefix
   *  (a Keep whose move partly failed). Keeping again retries the move. */
  relocationPending: boolean;
  segments: SegmentManifestEntry[];
}

/**
 * Build the session playback manifest from its ordered segment rows. No IO.
 * Segments arrive in playback order (the
 * `listRumSegmentsBySession` order: chronological by `start_ts`, then
 * `index_in_view` within a view) and each carries a per-segment events URL the
 * player concatenates. `durationMs` spans the earliest start to the latest end
 * across all segments (floored at 0).
 */
export function buildSessionSegmentManifest(
  sessionId: string,
  segments: RumSegmentRow[],
  session?: Pick<RumSessionRow, 'retained_until' | 'retention_flagged_at'> | null,
): SessionSegmentManifest {
  let minStart = Infinity;
  let maxEnd = -Infinity;
  const entries: SegmentManifestEntry[] = segments.map((s) => {
    if (s.start_ts < minStart) minStart = s.start_ts;
    if (s.end_ts > maxEnd) maxEnd = s.end_ts;
    return {
      segmentId: s.id,
      viewId: s.view_id,
      indexInView: s.index_in_view,
      hasFullSnapshot: s.has_full_snapshot === 1,
      startTs: s.start_ts,
      endTs: s.end_ts,
      eventCount: s.event_count,
      byteSize: s.byte_size,
      eventsUrl: `/api/replays/sessions/${encodeURIComponent(sessionId)}/segments/${encodeURIComponent(
        s.id,
      )}/events`,
    };
  });
  const durationMs =
    minStart === Infinity || maxEnd === -Infinity ? 0 : Math.max(0, maxEnd - minStart);
  return {
    sessionId,
    storageLayout: 'segmented',
    projectId: segments[0]?.project_id ?? null,
    segmentCount: segments.length,
    durationMs,
    ...activeRetention(session?.retained_until, session?.retention_flagged_at),
    relocationPending: isRelocationPending(session, segments),
    segments: entries,
  };
}

/**
 * Read + decode one segment's object. Resolves the segment's ORIGINAL backend
 * from its recorded storage_kind/bucket/region, so a storage reconfiguration
 * doesn't strand existing segments.
 */
export async function readSegment(deps: SegmentStoreDeps, row: RumSegmentRow): Promise<ReplayBlob> {
  const store = getArtifactStoreForLocation(row, deps.config);
  return decodeReplayBlob(await store.getBuffer(row.storage_key));
}

/**
 * Read a whole `segmented` session as a single flat, chronological events array
 * (the server-side equivalent of the client concatenating segments for
 * playback). Duration is derived from the merged timeline.
 *
 * Events are concatenated in manifest order (by segment `start_ts`) and then
 * STABLE-sorted by event `timestamp`. Normal captures have strictly sequential
 * views, so the concatenation is already monotonic and the sort is a no-op; the
 * sort only matters when two views' spans overlap (clock skew, a long trailing
 * event) — rrweb playback assumes non-decreasing timestamps, so we guarantee it
 * rather than trust the manifest order. `Array.prototype.sort` is stable
 * (ES2019+), so events sharing a timestamp keep their in-segment order.
 */
export async function readSessionEvents(
  deps: SegmentStoreDeps,
  sessionId: string,
): Promise<{ events: ReplayEvent[]; durationMs: number; segmentCount: number }> {
  const segments = listSessionSegments(deps.stmts, sessionId);
  const events: ReplayEvent[] = [];
  for (const seg of segments) {
    const blob = await readSegment(deps, seg);
    for (const e of blob.events) events.push(e);
  }
  events.sort((a, b) => a.timestamp - b.timestamp);
  return { events, durationMs: computeDurationMs(events), segmentCount: segments.length };
}

/** Delete every segment (objects + manifest rows) for a session. Best-effort on
 *  each object; the manifest rows are cleared after the objects. */
export async function deleteSessionSegments(
  deps: SegmentStoreDeps,
  sessionId: string,
): Promise<void> {
  // Under the session lock so an in-flight append can't publish a segment after
  // the listing below and leave it orphaned.
  return withSessionLock(sessionId, () => deleteSessionSegmentsLocked(deps, sessionId));
}

async function deleteSessionSegmentsLocked(
  deps: SegmentStoreDeps,
  sessionId: string,
): Promise<void> {
  const segments = listSessionSegments(deps.stmts, sessionId);
  for (const seg of segments) {
    try {
      const store = getArtifactStoreForLocation(seg, deps.config);
      await store.delete(seg.storage_key);
    } catch {
      /* best-effort — a missing object shouldn't strand the row */
    }
  }
  deps.stmts.deleteRumSegmentsBySession.run(sessionId);
  // Drop the session-grain rollup row alongside its segments so a deleted
  // session leaves no orphan dashboard entry.
  deps.stmts.deleteRumSession.run(sessionId);
}

export interface SetSessionRetentionResult {
  /** False when the session has no index row (never rolled up, or just expired). */
  found: boolean;
  /** Segments moved to the kept prefix by this call. */
  moved: number;
  /** Segments left at their old key; calling Keep again retries them. */
  failed: number;
}

/**
 * Keep (`retainedUntil` set) or un-Keep (`null`) a segmented session. Runs under
 * the session lock: an append can't be mid-upload to the expiring prefix, and
 * the retention sweep can't be mid-delete, while the flag changes and the
 * existing objects move. If the sweep already expired the session, the row is
 * gone and this reports `found: false` instead of a Keep that has no data.
 */
export async function setSessionRetention(
  deps: SegmentStoreDeps,
  sessionId: string,
  retention: { retainedUntil: string; flaggedAt: string } | null,
  log?: (msg: string) => void,
): Promise<SetSessionRetentionResult> {
  return withSessionLock(sessionId, async () => {
    if (!deps.stmts.getRumSession.get(sessionId)) return { found: false, moved: 0, failed: 0 };
    if (!retention) {
      deps.stmts.clearRumSessionRetention.run(sessionId);
      return { found: true, moved: 0, failed: 0 };
    }
    deps.stmts.flagRumSessionRetention.run(retention.retainedUntil, retention.flaggedAt, sessionId);
    const { moved, failed } = await relocateSessionSegmentsForRetention(deps, sessionId, log);
    return { found: true, moved, failed };
  });
}

export interface RelocateSegmentsResult {
  /** Segments whose object was copied to the kept prefix this call. */
  moved: number;
  /** Segments that couldn't be moved (left at their old key; retry is safe). */
  failed: number;
}

/**
 * Move a kept session's S3 segment objects from `rum/` to the kept prefix so the
 * bucket lifecycle rule can't expire them. Per segment: copy the bytes, repoint
 * the manifest row, then delete the old object (best-effort: a leftover old copy
 * still expires under the lifecycle rule). Already-kept segments are skipped, so
 * calling it again only retries what failed. Local segments stay put: there is no
 * lifecycle on disk, and the sweeper already skips kept sessions.
 */
export async function relocateSessionSegmentsForRetention(
  deps: SegmentStoreDeps,
  sessionId: string,
  log: (msg: string) => void = (msg) => console.warn(msg),
): Promise<RelocateSegmentsResult> {
  let moved = 0;
  let failed = 0;
  for (const seg of listSessionSegments(deps.stmts, sessionId)) {
    if (seg.storage_kind !== 's3' || isRetainedSegmentKey(seg.storage_key)) continue;
    const newKey = toRetainedSegmentKey(seg.storage_key);
    try {
      const store = getArtifactStoreForLocation(seg, deps.config);
      const bytes = await store.getBuffer(seg.storage_key);
      await store.put(newKey, bytes, SEGMENT_CONTENT_TYPE);
      try {
        deps.stmts.updateRumSegmentStorageKey.run(newKey, seg.id);
      } catch (err) {
        // The row still points at the old key, so nothing would ever find or
        // expire the copy under the kept prefix. Remove it before reporting.
        try {
          await store.delete(newKey);
        } catch (cleanupErr) {
          log(
            `[Replays] could not remove unreferenced kept copy ${newKey}: ${
              cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
            }`,
          );
        }
        throw err;
      }
      moved += 1;
      try {
        await store.delete(seg.storage_key);
      } catch {
        /* the old copy is still under rum/, so lifecycle expires it */
      }
    } catch (err) {
      failed += 1;
      log(
        `[Replays] failed to move segment ${seg.id} to the kept prefix: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return { moved, failed };
}
