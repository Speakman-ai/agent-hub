/**
 * Replay → agent-readable context, resolved from storage.
 *
 * This is the delivery half of the replay-transcript work. `replay-transcript.ts`
 * turns rrweb events into a timeline and `replay-context-pack.ts` fences it for
 * a prompt; this module is the only piece that touches storage, so it owns:
 *
 *  - reading a capture's events through the right door for its layout
 *    (`monolithic` → the paginated blob read; `segmented` → the per-segment
 *    session read), paging until the whole capture (or the cap) is loaded;
 *  - resolving a replay from the surfaces that reference one — a kanban card
 *    (`session_replays.card_id`), a support-ticket `/uploads/replay-<id>.json`
 *    ref, or a bare replay id;
 *  - guaranteeing the whole thing is **non-fatal**. Seeding replay context into
 *    an agent session is additive: a missing blob, an S3 outage, or a corrupt
 *    capture must degrade to "no replay context", never fail the assignment
 *    that a human is waiting on. Every public entry point here returns `null`
 *    instead of throwing.
 */
import type { AppConfig, SessionReplayRow, Stmts } from '../types.js';
import {
  readReplayEventsPage,
  parseReplayIdFromRef,
  MAX_EVENTS_PAGE,
  type ReplayEvent,
} from './replay-store.js';
import { listSessionSegments, readSegment } from './segment-store.js';
import { buildReplayTranscript, type ReplayTranscript } from './replay-transcript.js';
import { buildReplayContextPack, type ReplayContextPack } from './replay-context-pack.js';

/** Hard cap on events pulled into one transcript build. Matches the ingest
 *  event cap, so a full capture is readable but a pathological row can't pin
 *  the event loop rebuilding a mirror over hundreds of thousands of nodes. */
export const MAX_TRANSCRIPT_EVENTS = 20_000;

export interface ReplayContextDeps {
  stmts: Stmts;
  config: AppConfig;
}

/**
 * Read every event of a capture, honoring its storage layout. Monolithic rows
 * page through the gunzipped blob; segmented rows concatenate their per-view
 * segments. Throws on storage failure — callers that need the non-fatal
 * contract use the `load*` helpers below.
 */
export async function readAllReplayEvents(
  deps: ReplayContextDeps,
  row: SessionReplayRow,
  maxEvents: number = MAX_TRANSCRIPT_EVENTS,
): Promise<ReplayEvent[]> {
  if (row.storage_layout === 'segmented') {
    return readSegmentedEvents(deps, row.id, maxEvents);
  }
  const events: ReplayEvent[] = [];
  let offset = 0;
  // Paginated rather than one big read: `readReplayEventsPage` caps a single
  // page at MAX_EVENTS_PAGE, so a 20k-event capture needs several passes.
  for (;;) {
    const page = await readReplayEventsPage(deps, row, offset, MAX_EVENTS_PAGE);
    for (const event of page.events) {
      events.push(event);
      if (events.length >= maxEvents) return events;
    }
    if (!page.hasMore || page.events.length === 0) break;
    offset += page.events.length;
  }
  return events;
}

/**
 * Read a segmented capture's events, stopping at `maxEvents`.
 *
 * Walks the manifest segment by segment rather than calling
 * `readSessionEvents`, which fetches and concatenates EVERY segment object
 * before a caller can trim. On a long-running continuous capture that is an
 * unbounded fetch + allocation happening inline on the assign path, and slicing
 * afterwards doesn't undo it — the cap has to bind while reading. Here the loop
 * stops issuing storage reads as soon as the budget is met, so a session with
 * 900 segments costs the same as one with the handful the cap covers.
 *
 * Segments arrive in manifest order (by `start_ts`), and the accumulated events
 * are stable-sorted by timestamp — the same guarantee `readSessionEvents`
 * provides for overlapping views, applied to the bounded prefix.
 */
async function readSegmentedEvents(
  deps: ReplayContextDeps,
  sessionId: string,
  maxEvents: number,
): Promise<ReplayEvent[]> {
  const segments = listSessionSegments(deps.stmts, sessionId);
  const events: ReplayEvent[] = [];
  for (const segment of segments) {
    if (events.length >= maxEvents) break;
    const blob = await readSegment(deps, segment);
    for (const event of blob.events) {
      events.push(event);
      if (events.length >= maxEvents) break;
    }
  }
  events.sort((a, b) => a.timestamp - b.timestamp);
  return events;
}

export interface ReplayContextResult {
  row: SessionReplayRow;
  transcript: ReplayTranscript;
  pack: ReplayContextPack;
}

/**
 * Build the full transcript + prompt pack for one replay row. Returns null on
 * any storage/decode failure (logged, never thrown).
 */
export async function loadReplayContextForRow(
  deps: ReplayContextDeps,
  row: SessionReplayRow,
  opts: { maxBytes?: number; maxEvents?: number } = {},
): Promise<ReplayContextResult | null> {
  try {
    const events = await readAllReplayEvents(deps, row, opts.maxEvents ?? MAX_TRANSCRIPT_EVENTS);
    const transcript = buildReplayTranscript(events);
    const pack = buildReplayContextPack({
      transcript,
      replay: {
        id: row.id,
        createdAt: row.created_at,
        durationMs: row.duration_ms,
        eventCount: row.event_count,
      },
      ...(opts.maxBytes != null ? { maxBytes: opts.maxBytes } : {}),
    });
    return { row, transcript, pack };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Replay Context] Failed to build transcript for replay ${row.id}: ${message}`);
    return null;
  }
}

/** Look up a replay row by id, tolerating a missing statement/row. */
export function findReplayById(stmts: Stmts, id: string): SessionReplayRow | null {
  try {
    return (stmts.getSessionReplay.get(id) as SessionReplayRow | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * The kanban-card entry point: the replay attributed to a card via
 * `session_replays.card_id` (set when a support ticket carrying a replay is
 * converted). Returns the prompt-ready context block, or null when the card has
 * no replay or the capture can't be read.
 *
 * This is what makes a fix session actually *see* the replay: the card's
 * description only ever carried an inert `/uploads/replay-<id>.json` string.
 */
export async function loadCardReplayContext(
  deps: ReplayContextDeps,
  cardId: string,
  opts: { maxBytes?: number } = {},
): Promise<string | null> {
  try {
    const row = deps.stmts.getSessionReplayByCard.get(cardId) as SessionReplayRow | undefined;
    if (!row) return null;
    const result = await loadReplayContextForRow(deps, row, opts);
    return result?.pack.contextBlock ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Replay Context] Failed to resolve replay for card ${cardId}: ${message}`);
    return null;
  }
}

/**
 * The support-ticket entry point: resolve a `/uploads/replay-<id>.json` ref to
 * its stored capture and build the same context block. Returns null for a
 * non-replay ref (an external URL, a video attachment) or an unreadable
 * capture.
 */
export async function loadReplayRefResult(
  deps: ReplayContextDeps,
  replayRef: string | null | undefined,
  opts: { maxBytes?: number } = {},
): Promise<ReplayContextResult | null> {
  const id = parseReplayIdFromRef(replayRef);
  if (!id) return null;
  const row = findReplayById(deps.stmts, id);
  if (!row) return null;
  return loadReplayContextForRow(deps, row, opts);
}

/** As {@link loadReplayRefResult}, reduced to the prompt-ready context block. */
export async function loadReplayRefContext(
  deps: ReplayContextDeps,
  replayRef: string | null | undefined,
  opts: { maxBytes?: number } = {},
): Promise<string | null> {
  const result = await loadReplayRefResult(deps, replayRef, opts);
  return result?.pack.contextBlock ?? null;
}
