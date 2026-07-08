/**
 * segment-store.ts — append-only per-segment storage for `segmented` replays.
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
import type { AppConfig, RumSegmentRow, Stmts } from '../types.js';
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
  const key = buildSegmentKey({
    projectId,
    sessionId: input.sessionId,
    viewId: input.viewId,
    indexInView,
    startTs: start,
  });
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
  segments: SegmentManifestEntry[];
}

/**
 * Build the session playback manifest from its ordered segment rows. Pure (no
 * IO) so it can be unit-tested. Segments arrive in playback order (the
 * `listRumSegmentsBySession` order: chronological by `start_ts`, then
 * `index_in_view` within a view) and each carries a per-segment events URL the
 * player concatenates. `durationMs` spans the earliest start to the latest end
 * across all segments (floored at 0).
 */
export function buildSessionSegmentManifest(
  sessionId: string,
  segments: RumSegmentRow[],
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
