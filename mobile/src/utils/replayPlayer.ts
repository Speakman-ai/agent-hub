// Session-grouped multi-view playback — pure stitch helpers (mobile parity of
// client/src/utils/replayPlayer.ts). A continuous (segmented) capture is stored
// as per-segment objects grouped session → view → segment (see
// server/replays/segment-store.ts). The player fetches the session manifest,
// then pulls each segment's events in playback order and concatenates them into
// ONE continuous rrweb timeline. Every view opens with a fresh full snapshot
// (`hasFullSnapshot`, indexInView 0), so concatenating in manifest order lets
// rrweb rebuild the DOM at each view boundary and seek across boundaries
// natively.
//
// This module carries ONLY the framework-agnostic data layer (manifest walk,
// view chapters, seek-baseline reasoning) so it stays unit-testable without a
// bundler. The in-app rrweb WebView player that consumes these helpers is a
// separate ticket ("Mobile: in-app rrweb WebView replay player"); until it
// lands, ReplaysScreen uses `computeSessionViews` to surface the session's view
// breakdown in the player modal.

// rrweb EventType.FullSnapshot — the event that starts each view. Kept here so
// the stitch helpers can reason about view boundaries without importing rrweb.
export const RRWEB_FULL_SNAPSHOT = 2;

/**
 * One playback-manifest segment entry (subset the player reads). Mirrors the
 * server `SegmentManifestEntry`.
 */
export interface SessionSegmentEntry {
  segmentId: string;
  viewId: string;
  indexInView: number;
  hasFullSnapshot: boolean;
  startTs: number;
  endTs: number;
  eventCount: number;
  byteSize?: number;
  eventsUrl?: string;
}

/** The session playback manifest (subset). Mirrors server `SessionSegmentManifest`. */
export interface SessionSegmentManifest {
  sessionId: string;
  storageLayout?: string;
  projectId?: string | null;
  segmentCount?: number;
  durationMs?: number;
  segments?: SessionSegmentEntry[];
}

/** A view chapter marker for the player's timeline: where the view begins on the
 *  stitched, continuous timeline (ms offset from the session's first event). */
export interface SessionViewChapter {
  viewId: string;
  /** 0-based ordinal in playback order. */
  index: number;
  /** Absolute timestamp of the view's first segment. */
  startTs: number;
  /** ms offset from the session's first event — what rrweb-player `goto` takes. */
  offsetMs: number;
}

/**
 * Collapse a session manifest into ordered per-view chapter markers. Segments
 * arrive in playback order and are view-scoped (a view never spans segments of
 * another view), so the first occurrence of each `viewId` is that view's start.
 * `offsetMs` is the view's first-segment start relative to the earliest segment
 * start in the session — the same origin rrweb-player's timeline uses — so a
 * chapter click maps directly to `player.goto(offsetMs)`. Pure and
 * side-effect-free for unit testing.
 */
export function computeSessionViews(
  manifest?: SessionSegmentManifest | null,
): SessionViewChapter[] {
  const segments = Array.isArray(manifest?.segments) ? manifest!.segments! : [];
  if (!segments.length) return [];
  let sessionStart = Infinity;
  for (const s of segments) {
    if (typeof s?.startTs === 'number' && s.startTs < sessionStart) sessionStart = s.startTs;
  }
  if (!Number.isFinite(sessionStart)) sessionStart = 0;
  const chapters: SessionViewChapter[] = [];
  const seen = new Set<string>();
  for (const s of segments) {
    if (!s || seen.has(s.viewId)) continue;
    seen.add(s.viewId);
    const startTs = typeof s.startTs === 'number' ? s.startTs : sessionStart;
    chapters.push({
      viewId: s.viewId,
      index: chapters.length,
      startTs,
      offsetMs: Math.max(0, startTs - sessionStart),
    });
  }
  return chapters;
}

/**
 * Fetch a session's segment manifest, then walk its segments IN PLAYBACK ORDER,
 * fetching each segment's events and invoking `onChunk(events, segment)` so the
 * caller can stream them into the player and concatenate them into one
 * continuous timeline. Pure over its injected `getManifest` / `getSegmentEvents`
 * so it's testable without a network. Honors an optional AbortSignal between
 * segments. Returns the manifest plus the total segment/event counts streamed.
 */
export async function streamSessionSegments({
  getManifest,
  getSegmentEvents,
  sessionId,
  onManifest,
  onChunk,
  signal,
}: {
  getManifest: (sessionId: string) => Promise<SessionSegmentManifest>;
  getSegmentEvents: (
    sessionId: string,
    segmentId: string,
  ) => Promise<{ events?: unknown[]; eventCount?: number }>;
  sessionId: string;
  onManifest?: (manifest: SessionSegmentManifest) => void;
  onChunk?: (events: unknown[], segment: SessionSegmentEntry) => void;
  signal?: AbortSignal;
}) {
  const manifest = await getManifest(sessionId);
  if (typeof onManifest === 'function') onManifest(manifest);
  const segments = Array.isArray(manifest?.segments) ? manifest.segments : [];
  let eventCount = 0;
  for (const segment of segments) {
    if (signal && signal.aborted) break;
    const res = await getSegmentEvents(sessionId, segment.segmentId);
    const events: unknown[] = Array.isArray(res?.events) ? res.events : [];
    if (events.length && typeof onChunk === 'function') onChunk(events, segment);
    eventCount += events.length;
  }
  return {
    manifest,
    segmentCount: segments.length,
    eventCount,
    durationMs: typeof manifest?.durationMs === 'number' ? manifest.durationMs : 0,
  };
}

/**
 * The rrweb event index a seek to `targetTimestamp` rebuilds from: the last full
 * snapshot at or before the target time (mirrors rrweb's own rebuild-from-last-
 * full-snapshot seek). Given a stitched, multi-view timeline this proves a seek
 * into a later view lands on THAT view's snapshot (not view 0's), i.e. seeking
 * across a view boundary is well-formed. `events` must be in timeline order and
 * carry rrweb `{ type, timestamp }`. Returns -1 if no snapshot precedes the
 * target. Pure helper for tests + reasoning about the continuous timeline.
 */
export function seekBaselineIndex(
  events: Array<{ type?: number; timestamp?: number }>,
  targetTimestamp: number,
): number {
  let baseline = -1;
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    if (!e || typeof e.timestamp !== 'number') continue;
    if (e.timestamp > targetTimestamp) break;
    if (e.type === RRWEB_FULL_SNAPSHOT) baseline = i;
  }
  return baseline;
}
