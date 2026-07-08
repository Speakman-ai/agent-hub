/**
 * rum-session-store.ts — the session-grain rollup row the RUM dashboard lists
 * and filters on (Datadog "session" grain).
 *
 * The segment store (`segment-store.ts`) writes one `rum_segments` row per
 * ingested segment. Those rows carry the playback pointers but NOT the
 * session-level aggregates a dashboard needs to list/sort/filter sessions
 * (view/action/error/frustration counts, time spent). Deriving those per query
 * from the raw event objects would not scale, so we maintain a `rum_sessions`
 * row per client-minted session id, rolled forward incrementally as each
 * segment ingests.
 *
 * Rollup semantics (mirroring the sessionization spec):
 *   - view_count — every view opens with an `index_in_view=0` segment exactly
 *     once, so we increment by 1 on each index-0 segment. Non-zero indices don't
 *     move the count (they extend an already-counted view).
 *   - action/error/frustration counts — summed from the per-segment counts the
 *     client sends in the segment `meta` (frustration signals are detected
 *     client-side and shipped as counts). Missing/invalid → 0.
 *   - started_at / ended_at — the earliest / latest event timestamp seen across
 *     the whole session (epoch ms); time_spent is their span. A segment with no
 *     usable timestamps (start/end 0) does not move the bounds.
 *   - project_id — first-non-null-wins, so an anonymous first segment that later
 *     attributes to a tenant keeps that tenant.
 *
 * Concurrency: the read-modify-write below is fully SYNCHRONOUS (better-sqlite3
 * statements block the event loop and there is no `await` between the read and
 * the write), so two segment appends to the same session cannot interleave in
 * the single-process Hub — the documented deployment topology, same assumption
 * `replay-store.ts` relies on. A future multi-process backend would need a
 * DB-level UPSERT / row lock instead.
 */
import type { RumSessionRow, Stmts } from '../types.js';
import type { SessionEnrichment } from './rum-enrichment.js';

/** Per-segment rollup counts the client ships in the segment `meta`. */
export interface SegmentRollupCounts {
  action: number;
  error: number;
  frustration: number;
}

/** Coerce an unknown meta value to a non-negative integer count (0 otherwise). */
function toCount(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The standard Datadog `usr` fields promoted to first-class indexed columns;
 *  every other key is a custom attribute. */
const STANDARD_USER_KEYS = new Set(['id', 'name', 'email']);

/** Per-segment user identity split from the segment `meta.usr` the client stamps
 *  forward-only. Standard fields become indexed columns; the rest are custom
 *  attributes persisted as JSON. */
export interface SegmentUserIdentity {
  id: string | null;
  name: string | null;
  email: string | null;
  /** Non-standard `usr` keys, or null when the identity carried none. */
  attributes: Record<string, unknown> | null;
}

/** Coerce a `usr` standard field (id can be a number in Datadog) to a trimmed,
 *  non-empty string, else null. Objects/arrays are rejected. */
function toIdentityString(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length ? t : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  return null;
}

/**
 * Split a segment's `meta.usr` into standard identity fields + custom attributes.
 * Standard keys (`id`/`name`/`email`) map to indexed columns; every other
 * non-null key becomes a custom attribute. Returns null when there is no usable
 * identity (missing/empty `usr`, or only null values) so the rollup leaves any
 * prior identity untouched (forward-only, last-non-null semantics). Pure — no IO.
 */
export function extractSegmentUser(
  meta: Record<string, unknown> | null | undefined,
): SegmentUserIdentity | null {
  const usr = meta?.usr;
  if (!usr || typeof usr !== 'object' || Array.isArray(usr)) return null;
  const obj = usr as Record<string, unknown>;

  const id = toIdentityString(obj.id);
  const name = toIdentityString(obj.name);
  const email = toIdentityString(obj.email);

  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (STANDARD_USER_KEYS.has(key) || value == null) continue;
    attributes[key] = value;
  }
  const attrs = Object.keys(attributes).length ? attributes : null;

  if (id == null && name == null && email == null && attrs == null) return null;
  return { id, name, email, attributes: attrs };
}

/** Serialize custom user attributes to a JSON string for storage, or null when
 *  there are none. Kept separate so callers can round-trip via `JSON.parse`. */
function serializeUserAttributes(attributes: Record<string, unknown> | null): string | null {
  if (!attributes || !Object.keys(attributes).length) return null;
  return JSON.stringify(attributes);
}

/**
 * Pull the action/error/frustration counts out of a segment's `meta`. Accepts
 * either camelCase (`actionCount`) or snake_case (`action_count`) keys so the
 * store is tolerant of the exact client contract. Anything missing or
 * non-numeric rolls up as 0. Pure — no IO.
 */
export function extractSegmentRollupCounts(
  meta: Record<string, unknown> | null | undefined,
): SegmentRollupCounts {
  const m = meta ?? {};
  return {
    action: toCount(m.actionCount ?? m.action_count),
    error: toCount(m.errorCount ?? m.error_count),
    frustration: toCount(m.frustrationCount ?? m.frustration_count),
  };
}

/** Fold a new epoch-ms bound into an existing one, ignoring 0/NULL "unset". */
function foldMin(existing: number | null, next: number | null): number | null {
  if (next == null || next <= 0) return existing;
  if (existing == null || existing <= 0) return next;
  return Math.min(existing, next);
}
function foldMax(existing: number | null, next: number | null): number | null {
  if (next == null || next <= 0) return existing;
  if (existing == null || existing <= 0) return next;
  return Math.max(existing, next);
}

/** Session duration from its bounds: `ended - started`, floored at 0. */
function durationFrom(started: number | null, ended: number | null): number {
  if (started == null || ended == null) return 0;
  const span = ended - started;
  return span > 0 ? span : 0;
}

export interface SegmentRollupInput {
  sessionId: string;
  projectId?: string | null;
  /** 0-based position within its view; index 0 opens a new (counted) view. */
  indexInView: number;
  /** Earliest event timestamp in the segment, epoch ms (0 when empty). */
  startTs: number;
  /** Latest event timestamp in the segment, epoch ms (0 when empty). */
  endTs: number;
  /** Per-segment counts (from `extractSegmentRollupCounts(meta)`). */
  counts: SegmentRollupCounts;
  /** Per-segment user identity (from `extractSegmentUser(meta)`); null when the
   *  segment carried no `usr`. Applied last-non-null per field. */
  user?: SegmentUserIdentity | null;
  /** Request-derived facets (device/browser/os/geo) from the ingest HTTP request
   *  (`computeEnrichment`); null when nothing could be derived. Applied
   *  first-non-null per field — a browser session's UA/IP is stable, so the first
   *  segment's values stick and a later request (proxy, missing UA) never wipes
   *  them. */
  enrichment?: SessionEnrichment | null;
}

/**
 * Roll one freshly-ingested segment into its session's `rum_sessions` row,
 * creating the row on first sight. Returns the updated row. Synchronous
 * read-modify-write — see the concurrency note atop this file. Callers invoke
 * this AFTER the segment's bytes are durably written so a rolled-up count never
 * out-runs the object it summarizes.
 */
export function rollupSegmentIntoSession(stmts: Stmts, input: SegmentRollupInput): RumSessionRow {
  const segStart = input.startTs > 0 ? input.startTs : null;
  const segEnd = input.endTs > 0 ? input.endTs : null;
  // A view is counted once, when its opening (index 0) segment arrives.
  const viewDelta = Math.max(0, Math.floor(input.indexInView)) === 0 ? 1 : 0;

  const user = input.user ?? null;
  const enrichment = input.enrichment ?? null;
  const existing = stmts.getRumSession.get(input.sessionId) as RumSessionRow | undefined;

  if (!existing) {
    stmts.insertRumSession.run(
      input.sessionId,
      input.projectId ?? null,
      segStart,
      segEnd,
      durationFrom(segStart, segEnd),
      viewDelta,
      input.counts.action,
      input.counts.error,
      input.counts.frustration,
      user?.id ?? null,
      user?.email ?? null,
      user?.name ?? null,
      serializeUserAttributes(user?.attributes ?? null),
      enrichment?.deviceType ?? null,
      enrichment?.browser ?? null,
      enrichment?.os ?? null,
      enrichment?.geoCountry ?? null,
    );
    return stmts.getRumSession.get(input.sessionId) as RumSessionRow;
  }

  const startedAt = foldMin(existing.started_at, segStart);
  const endedAt = foldMax(existing.ended_at, segEnd);
  // First-non-null-wins: keep an already-attributed tenant, else adopt this one.
  const projectId = existing.project_id ?? input.projectId ?? null;
  // Last-non-null-wins per field: a segment that identifies mid-stream updates the
  // stored identity, but a later anonymous segment (no `usr`) never wipes it. Each
  // field folds independently so a partial identity doesn't clear the others.
  const usrId = user?.id ?? existing.usr_id;
  const usrEmail = user?.email ?? existing.usr_email;
  const usrName = user?.name ?? existing.usr_name;
  const usrAttributes =
    user?.attributes != null ? serializeUserAttributes(user.attributes) : existing.usr_attributes;
  // First-non-null-wins per field: the first segment that carries a UA/IP fixes
  // the session's device/browser/os/geo; a later segment with a missing UA or a
  // proxied IP never overwrites an already-derived facet.
  const deviceType = existing.device_type ?? enrichment?.deviceType ?? null;
  const browser = existing.browser ?? enrichment?.browser ?? null;
  const os = existing.os ?? enrichment?.os ?? null;
  const geoCountry = existing.geo_country ?? enrichment?.geoCountry ?? null;

  stmts.updateRumSessionRollup.run(
    projectId,
    startedAt,
    endedAt,
    durationFrom(startedAt, endedAt),
    existing.view_count + viewDelta,
    existing.action_count + input.counts.action,
    existing.error_count + input.counts.error,
    existing.frustration_count + input.counts.frustration,
    usrId,
    usrEmail,
    usrName,
    usrAttributes,
    deviceType,
    browser,
    os,
    geoCountry,
    input.sessionId,
  );
  return stmts.getRumSession.get(input.sessionId) as RumSessionRow;
}

/** The session-grain row for one session id, or null when none exists yet. */
export function getRumSession(stmts: Stmts, sessionId: string): RumSessionRow | null {
  return (stmts.getRumSession.get(sessionId) as RumSessionRow | undefined) ?? null;
}

/** Tenant-scoped session list, most-recent first. `limit` caps the page. */
export function listRumSessionsByProject(
  stmts: Stmts,
  projectId: string,
  limit = 100,
): RumSessionRow[] {
  const capped = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 100;
  return stmts.listRumSessionsByProject.all(projectId, capped) as RumSessionRow[];
}
