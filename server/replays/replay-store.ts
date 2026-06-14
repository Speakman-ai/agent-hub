/**
 * replay-store.ts — durable storage for record-on-error rrweb session replays.
 *
 * The rrweb event array (the trailing rolling-buffer window the web client
 * flushes on a bug-report submit or an uncaught error) is JSON-encoded, gzipped
 * (~250–400 KB/session → far smaller compressed), and written as a single blob
 * via the shared artifact store (S3 or a local dir; see
 * server/artifacts/artifact-store.ts). A `session_replays` metadata row indexes
 * the blob so the paginated read API and support-ticket investigation can
 * resolve it without scanning storage.
 *
 * Pagination: large captures must not be returned in one response. The blob is
 * read + gunzipped once server-side, then the events array is sliced by
 * `offset`/`limit`; the page carries `total`/`hasMore` so callers can walk it.
 *
 * The pure helpers (encode/decode/duration/pagination) carry no IO so they can
 * be unit-tested directly; `storeReplay` / `readReplayEventsPage` do the
 * gzip + artifact-store + SQLite orchestration.
 */
import { gzipSync, gunzipSync } from 'zlib';
import { v4 as uuidv4 } from 'uuid';
import type { AppConfig, SessionReplayRow, Stmts } from '../types.js';
import {
  getArtifactStore,
  getArtifactStoreForLocation,
  buildReplayKey,
} from '../artifacts/artifact-store.js';

/** Minimal rrweb event shape the store persists. */
export interface ReplayEvent {
  type: number;
  timestamp: number;
  data?: unknown;
}

/** What gets gzipped into the blob: the events plus optional ingest context. */
export interface ReplayBlob {
  events: ReplayEvent[];
  meta: Record<string, unknown> | null;
}

const REPLAY_CONTENT_TYPE = 'application/gzip';

/** rrweb EventType.FullSnapshot — the marker a first chunk must carry so the
 *  capture can reconstruct the DOM. */
const RRWEB_FULL_SNAPSHOT = 2;

/** Default page size when a reader doesn't ask for one. */
export const DEFAULT_EVENTS_PAGE = 500;
/** Hard cap on a single page so a huge `limit` can't defeat pagination. */
export const MAX_EVENTS_PAGE = 5000;

/**
 * Duration of a capture: the span between its earliest and latest event
 * timestamp, in ms. Never negative (events may arrive out of order in the
 * buffer, so we use min/max rather than last-minus-first). Returns 0 for an
 * empty array.
 */
export function computeDurationMs(events: ReplayEvent[]): number {
  if (events.length === 0) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (const e of events) {
    const t = e.timestamp;
    if (typeof t !== 'number' || Number.isNaN(t)) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (min === Infinity || max === -Infinity) return 0;
  const span = max - min;
  return span > 0 ? span : 0;
}

/** Gzip the events + meta into a blob, reporting the pre-gzip byte length. */
export function encodeReplayBlob(
  events: ReplayEvent[],
  meta: Record<string, unknown> | null | undefined,
): { buffer: Buffer; uncompressedSize: number } {
  const json = JSON.stringify({ events, meta: meta ?? null } satisfies ReplayBlob);
  const raw = Buffer.from(json, 'utf-8');
  return { buffer: gzipSync(raw), uncompressedSize: raw.length };
}

/** Inverse of `encodeReplayBlob` — gunzip + parse a stored blob. */
export function decodeReplayBlob(buf: Buffer): ReplayBlob {
  const json = gunzipSync(buf).toString('utf-8');
  const parsed = JSON.parse(json) as Partial<ReplayBlob>;
  return {
    events: Array.isArray(parsed.events) ? parsed.events : [],
    meta: parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : null,
  };
}

export interface EventsPage {
  events: ReplayEvent[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

/**
 * Clamp a requested `(offset, limit)` to sane bounds and slice the events.
 * `offset` floors at 0; `limit` floors at 1 and caps at `MAX_EVENTS_PAGE`.
 * Non-finite / missing inputs fall back to defaults. Pure — no IO.
 */
export function paginateEvents(
  events: ReplayEvent[],
  offsetInput?: number,
  limitInput?: number,
): EventsPage {
  const total = events.length;
  let offset = Number.isFinite(offsetInput) ? Math.floor(offsetInput as number) : 0;
  if (offset < 0) offset = 0;
  if (offset > total) offset = total;
  let limit = Number.isFinite(limitInput) ? Math.floor(limitInput as number) : DEFAULT_EVENTS_PAGE;
  if (limit < 1) limit = 1;
  if (limit > MAX_EVENTS_PAGE) limit = MAX_EVENTS_PAGE;
  const page = events.slice(offset, offset + limit);
  return { events: page, total, offset, limit, hasMore: offset + page.length < total };
}

export interface StoreReplayInput {
  /** Use this id instead of minting one — lets a caller share an id with a
   *  legacy `/uploads/replay-<id>.json` companion. */
  id?: string;
  events: ReplayEvent[];
  meta?: Record<string, unknown> | null;
  projectId?: string | null;
  supportTicketId?: string | null;
  cardId?: string | null;
}

export interface ReplayStoreDeps {
  stmts: Stmts;
  config: AppConfig;
}

/**
 * Persist a replay: gzip the events into a blob, write it to the configured
 * artifact store, and insert the `session_replays` metadata row. Returns the
 * inserted row. The blob's storage backend (kind + bucket/region) is stamped on
 * the row so reads resolve the ORIGINAL backend even if config later changes —
 * same contract as the artifacts table.
 */
export async function storeReplay(
  deps: ReplayStoreDeps,
  input: StoreReplayInput,
): Promise<SessionReplayRow> {
  const { stmts, config } = deps;
  const id = input.id ?? uuidv4();
  const meta = input.meta ?? null;
  const { buffer, uncompressedSize } = encodeReplayBlob(input.events, meta);

  const store = getArtifactStore(config);
  const key = buildReplayKey(id);
  const storageBucket = store.kind === 's3' ? config.artifactsBucket : null;
  const storageRegion = store.kind === 's3' ? config.artifactsBucketRegion : null;

  // Claim the metadata row FIRST, before touching object storage. The id is the
  // primary key, so a reused id (retry / internal caller) fails the INSERT here
  // and never reaches `store.put` — so it can't overwrite or then delete another
  // replay's blob. The key is 1:1 with the id, so once the row is ours the blob
  // slot is ours too.
  stmts.insertSessionReplay.run(
    id,
    input.projectId ?? null,
    computeDurationMs(input.events),
    input.events.length,
    buffer.length,
    uncompressedSize,
    store.kind,
    key,
    storageBucket,
    storageRegion,
    input.supportTicketId ?? null,
    input.cardId ?? null,
    meta ? JSON.stringify(meta) : null,
  );

  // Row claimed; now write the blob. If that fails, roll the row back so we
  // never leave a metadata row pointing at a missing blob.
  try {
    await store.put(key, buffer, REPLAY_CONTENT_TYPE);
  } catch (err) {
    try {
      stmts.deleteSessionReplay.run(id);
    } catch {
      /* best-effort */
    }
    try {
      await store.delete(key); // drop any partial object
    } catch {
      /* best-effort — surface the original put error */
    }
    throw err;
  }

  return stmts.getSessionReplay.get(id) as SessionReplayRow;
}

/**
 * Thrown by `appendReplayEvents` when a chunked append would push a capture past
 * its total-event ceiling. The route maps this to a 413 so a streaming client
 * can't grow a single replay without bound across many batches.
 */
export class ReplayEventCapError extends Error {
  readonly total: number;
  readonly cap: number;
  constructor(total: number, cap: number) {
    super(`replay would hold ${total} events, exceeding the ${cap} cap`);
    this.name = 'ReplayEventCapError';
    this.total = total;
    this.cap = cap;
  }
}

/**
 * Thrown by `appendReplayEvents` when `rejectIfFinalized` is set and the replay
 * (re-read inside the per-id lock) is already attributed to a project / ticket /
 * card. The route maps this to a 409 anti-tamper guard. Because the check runs
 * INSIDE the serialized section, a link landing concurrently is observed here —
 * no TOCTOU window between a stale route read and the blob overwrite.
 */
export class ReplayFinalizedError extends Error {
  constructor() {
    super('replay is finalized and cannot accept more events');
    this.name = 'ReplayFinalizedError';
  }
}

/**
 * Thrown by `appendReplayEvents` when `requireSnapshotOnFirstChunk` is set and
 * the batch that creates the replay (determined under the lock) carries no rrweb
 * full snapshot. The route maps this to a 400. Deciding "first chunk?" inside
 * the lock means an incremental chunk that raced behind the creating chunk is
 * correctly treated as an append, not wrongly rejected for lacking a snapshot.
 */
export class ReplayNeedsSnapshotError extends Error {
  constructor() {
    super('first chunk must include a full snapshot (type 2)');
    this.name = 'ReplayNeedsSnapshotError';
  }
}

export interface AppendReplayInput {
  /** Caller-supplied replay id (the `:id` path param). The first batch creates
   *  the row under this id; later batches append to it. */
  id: string;
  events: ReplayEvent[];
  meta?: Record<string, unknown> | null;
}

export interface AppendReplayOptions {
  /** Upper bound on the merged event count; exceeding throws ReplayEventCapError. */
  totalEventCap?: number;
  /** Reject (ReplayFinalizedError) when the under-lock row is already attributed. */
  rejectIfFinalized?: boolean;
  /** Reject (ReplayNeedsSnapshotError) when the creating chunk has no snapshot. */
  requireSnapshotOnFirstChunk?: boolean;
}

export interface AppendReplayResult {
  row: SessionReplayRow;
  /** True when this batch created the replay (first chunk), false on append. */
  created: boolean;
}

/** A replay is "finalized" once triage has attributed it to a project, support
 *  ticket, or card. Pure — no IO. */
export function isReplayFinalized(
  row: Pick<SessionReplayRow, 'project_id' | 'support_ticket_id' | 'card_id'>,
): boolean {
  return Boolean(row.project_id || row.support_ticket_id || row.card_id);
}

// ── Per-replay critical section ──────────────────────────────────
//
// A chunked append is a read-modify-write on a single blob slot: read the
// current blob, concatenate this batch, overwrite the key. Two overlapping
// appends to the SAME id would both read the same base blob and the later
// `put` would clobber the earlier one — silently dropping an already-acked
// chunk. Worse, an append straddles `await`s (blob read + write), so a
// *synchronous* attribution write (`linkSessionReplay`) could finalize the row
// mid-append and the in-flight chunk would land AFTER finalization, defeating
// the 409 anti-tamper guard.
//
// Both appends AND attribution (`linkReplay`) run inside this per-id promise
// chain, so they are mutually exclusive: a link can never interleave with an
// in-flight append's blob write, and an append always observes the prior link's
// committed finalized state. This holds within the single-process Hub (the
// documented deployment topology); a future multi-process / multi-host backend
// would need storage-level coordination (conditional put / object versioning)
// instead.
const _replayLocks = new Map<string, Promise<unknown>>();

function withReplayLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = _replayLocks.get(id) ?? Promise.resolve();
  // Run `fn` only after the previous critical section for this id settles
  // (success OR failure — `.then(fn, fn)` so one failure can't wedge the chain).
  const run = prev.then(fn, fn);
  // Park a rejection-swallowed tail as the chain head so the next waiter never
  // sees an unhandled rejection from our result.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  _replayLocks.set(id, tail);
  // Garbage-collect the map entry once we're the last link in the chain.
  void tail.finally(() => {
    if (_replayLocks.get(id) === tail) _replayLocks.delete(id);
  });
  return run;
}

/**
 * Append a batch of events to a replay, supporting the chunked-ingest endpoint.
 * Appends AND attribution (`linkReplay`) to the same id are SERIALIZED (see
 * `withReplayLock`) so a concurrent overlapping batch can never drop an
 * already-acknowledged chunk, and a `linkReplay` finalize can never interleave
 * with an in-flight append's blob write.
 *
 * ALL state-dependent decisions are made INSIDE the lock against a freshly-read
 * row, so there is no TOCTOU window between a stale caller read and the blob
 * overwrite:
 *   - No row yet → create it via `storeReplay` (first chunk). When
 *     `requireSnapshotOnFirstChunk` is set, the creating batch must carry an
 *     rrweb full snapshot or `ReplayNeedsSnapshotError` is thrown.
 *   - Row exists → read the existing blob, concatenate the new events, re-gzip,
 *     overwrite the SAME storage key, and re-stamp the metadata row's
 *     counts/sizes/duration. Existing `meta` wins (first-write); a still-null
 *     meta is filled from this batch.
 *   - `rejectIfFinalized` → throw `ReplayFinalizedError` when the replay is
 *     attributed to a project / ticket / card. Attribution (`linkSessionReplay`)
 *     does NOT take the append lock, so the check is made authoritative at the
 *     DB via a guarded compare-and-update (see the CAS-before-blob note below),
 *     not just the under-lock read — a link landing during the blob read/write
 *     window still rejects the chunk.
 *
 * `totalEventCap` bounds the merged length — exceeding it throws
 * `ReplayEventCapError` and leaves the stored blob untouched (the cap is checked
 * before any write).
 */
export function appendReplayEvents(
  deps: ReplayStoreDeps,
  input: AppendReplayInput,
  options: AppendReplayOptions = {},
): Promise<AppendReplayResult> {
  return withReplayLock(input.id, () => appendReplayEventsUnlocked(deps, input, options));
}

async function appendReplayEventsUnlocked(
  deps: ReplayStoreDeps,
  input: AppendReplayInput,
  options: AppendReplayOptions,
): Promise<AppendReplayResult> {
  const { stmts, config } = deps;
  const totalEventCap = options.totalEventCap ?? Infinity;
  // Re-read the row inside the critical section so finalized / first-chunk state
  // can't be stale relative to a concurrent create or link.
  const existing = stmts.getSessionReplay.get(input.id) as SessionReplayRow | undefined;

  if (existing && options.rejectIfFinalized && isReplayFinalized(existing)) {
    throw new ReplayFinalizedError();
  }

  if (!existing) {
    if (
      options.requireSnapshotOnFirstChunk &&
      !input.events.some((e) => e.type === RRWEB_FULL_SNAPSHOT)
    ) {
      throw new ReplayNeedsSnapshotError();
    }
    if (input.events.length > totalEventCap) {
      throw new ReplayEventCapError(input.events.length, totalEventCap);
    }
    const row = await storeReplay(deps, {
      id: input.id,
      events: input.events,
      meta: input.meta ?? null,
    });
    return { row, created: true };
  }

  const store = getArtifactStoreForLocation(existing, config);
  const prev = decodeReplayBlob(await store.getBuffer(existing.storage_key));
  const mergedEvents = prev.events.concat(input.events);
  if (mergedEvents.length > totalEventCap) {
    throw new ReplayEventCapError(mergedEvents.length, totalEventCap);
  }

  const meta = prev.meta ?? input.meta ?? null;
  const { buffer, uncompressedSize } = encodeReplayBlob(mergedEvents, meta);

  // CAS-before-blob, a DB-level backstop UNDER the per-id lock. The lock already
  // makes `linkReplay` mutually exclusive with this whole critical section, so
  // attribution cannot interleave with the `getBuffer`/`put` awaits here. As a
  // second, storage-independent authority we still claim the stats with a
  // guarded UPDATE that only matches while the row is unattributed: if a finalize
  // ever lands before this statement (e.g. a future link path that bypasses the
  // lock), it matches zero rows and we reject WITHOUT having touched the blob.
  // The blob is overwritten only AFTER a successful claim.
  if (options.rejectIfFinalized) {
    const claimed = stmts.updateSessionReplayStatsIfUnfinalized.run(
      computeDurationMs(mergedEvents),
      mergedEvents.length,
      buffer.length,
      uncompressedSize,
      meta ? JSON.stringify(meta) : null,
      input.id,
    );
    if (claimed.changes === 0) {
      // Finalized (or removed) during our read window — the authoritative reject.
      throw new ReplayFinalizedError();
    }
  } else {
    stmts.updateSessionReplayStats.run(
      computeDurationMs(mergedEvents),
      mergedEvents.length,
      buffer.length,
      uncompressedSize,
      meta ? JSON.stringify(meta) : null,
      input.id,
    );
  }

  try {
    await store.put(existing.storage_key, buffer, REPLAY_CONTENT_TYPE);
  } catch (err) {
    // The stats were claimed but the blob write failed — roll the row back to
    // its prior committed stats so it never claims events the blob lacks.
    try {
      stmts.updateSessionReplayStats.run(
        existing.duration_ms,
        existing.event_count,
        existing.size,
        existing.uncompressed_size,
        existing.meta,
        input.id,
      );
    } catch {
      /* best-effort restore — surface the original put error */
    }
    throw err;
  }

  return { row: stmts.getSessionReplay.get(input.id) as SessionReplayRow, created: false };
}

/**
 * Read a stored replay's blob and return one paginated page of its events.
 * Resolves the blob's ORIGINAL backend from the row (not current config), so a
 * storage reconfiguration doesn't strand existing replays.
 */
export async function readReplayEventsPage(
  deps: ReplayStoreDeps,
  row: SessionReplayRow,
  offset?: number,
  limit?: number,
): Promise<EventsPage> {
  const store = getArtifactStoreForLocation(row, deps.config);
  const buf = await store.getBuffer(row.storage_key);
  const { events } = decodeReplayBlob(buf);
  return paginateEvents(events, offset, limit);
}

/** Delete a replay blob then its metadata row. Bytes first so a failed delete
 *  leaves the row for retry rather than orphaning the blob. */
export async function deleteReplay(deps: ReplayStoreDeps, row: SessionReplayRow): Promise<void> {
  const store = getArtifactStoreForLocation(row, deps.config);
  await store.delete(row.storage_key);
  deps.stmts.deleteSessionReplay.run(row.id);
}

// ─── Linking ─────────────────────────────────────────────────────
//
// Ingest (`POST /api/replays`) is public and anonymous — it has no trusted
// project context, so a fresh replay row starts unattributed (`project_id`
// NULL). Attribution is persisted LATER, from authenticated project-scoped
// callers that hold both the `/uploads/replay-<id>.json` ref and a project:
// support-ticket creation / replay-ref update / convert-to-card. Once linked,
// the read API's per-project authorization (`canViewReplay`) lets that
// project's members read the capture; unlinked replays stay privileged-only.

const REPLAY_REF_RE = /^\/uploads\/replay-(.+)\.json$/;

/**
 * Extract the replay id from a `/uploads/replay-<id>.json` ref (the exact form
 * the ingest endpoint returns and `sanitizeReplayRef` admits). Returns null for
 * anything else. Pure.
 */
export function parseReplayIdFromRef(ref: string | null | undefined): string | null {
  if (typeof ref !== 'string') return null;
  const m = REPLAY_REF_RE.exec(ref.trim());
  return m ? m[1]! : null;
}

export interface ReplayLink {
  projectId?: string | null;
  supportTicketId?: string | null;
  cardId?: string | null;
}

/**
 * Attribute a stored replay to a project / support ticket / card, given the
 * ref a trusted, project-scoped caller holds. Ownership-guarded and
 * first-write-wins:
 *   - The row is mutated ONLY when it is unattributed (`project_id IS NULL`) or
 *     already owned by `link.projectId`. A caller from a different project is a
 *     complete no-op on EVERY field — they can't steal the replay into their
 *     project (read auth is project-scoped) nor poison its ticket/card metadata
 *     nor pre-stamp card_id to block the rightful convert.
 *   - Within the owning project only still-NULL fields are filled, so a later
 *     convert-to-card sets the NULL `card_id` without disturbing the rest.
 *
 * Pass `link.projectId` whenever you have it (all real callers do) — without it
 * the ownership guard collapses to "unattributed rows only". Best effort:
 * returns the current row (possibly unchanged), or null when the ref is
 * unparseable or no such replay row exists (e.g. a file-only legacy capture).
 * Never throws on a missing row.
 *
 * ASYNC + LOCKED: attribution runs inside the SAME per-id critical section as
 * `appendReplayEvents` (see `withReplayLock`). This is what closes the finalize
 * race — a link cannot land while an append is mid-write (it waits for the
 * append to commit or roll back first), and an append always observes a prior
 * link's finalized state. Callers must `await` it.
 */
export function linkReplay(
  stmts: Stmts,
  ref: string | null | undefined,
  link: ReplayLink,
): Promise<SessionReplayRow | null> {
  const id = parseReplayIdFromRef(ref);
  if (!id) return Promise.resolve(null);
  return withReplayLock(id, async () => {
    const existing = stmts.getSessionReplay.get(id) as SessionReplayRow | undefined;
    if (!existing) return null;
    const projectId = link.projectId ?? null;
    stmts.linkSessionReplay.run(
      projectId,
      link.supportTicketId ?? null,
      link.cardId ?? null,
      id,
      projectId, // WHERE ownership guard — same value as the COALESCE fill
    );
    return stmts.getSessionReplay.get(id) as SessionReplayRow;
  });
}
