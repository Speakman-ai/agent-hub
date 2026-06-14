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
 */
export function linkReplay(
  stmts: Stmts,
  ref: string | null | undefined,
  link: ReplayLink,
): SessionReplayRow | null {
  const id = parseReplayIdFromRef(ref);
  if (!id) return null;
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
}
