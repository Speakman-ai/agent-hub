import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import path from 'path';
import { gunzipSync } from 'zlib';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { Project, RouteDeps, SessionReplayRow } from '../types.js';
import {
  storeReplay,
  readReplayEventsPage,
  appendReplayEvents,
  ReplayEventCapError,
  ReplayFinalizedError,
  ReplayNeedsSnapshotError,
  DEFAULT_EVENTS_PAGE,
} from '../replays/replay-store.js';
import { ArtifactStoreUnavailableError } from '../artifacts/artifact-store.js';
import { canViewProject, type VisibilityCaller } from '../project-visibility.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import { verifyRumToken } from '../rum-clients-store.js';

/**
 * Public, rate-limited session-replay ingest endpoint, plus authenticated read
 * surfaces for the stored capture.
 *
 * Ingest (POST, public): accepts a JSON body of rrweb events (the trailing
 * rolling-buffer window the web client flushes on a bug-report submit or an
 * uncaught error). The events are gzipped and persisted as a durable blob via
 * the artifact store, indexed by a `session_replays` metadata row (see
 * server/replays/replay-store.ts). For backward compatibility a plain
 * `server/uploads/replay-<uuid>.json` companion is also written — the exact
 * textual form the support-ticket investigation's `resolveReplayContext` reads
 * back and splices into the triage prompt. The response carries the replay id
 * and the `/uploads/...` ref.
 *
 * Like the bug-report intake, anonymous ingest is intentionally unauthenticated
 * (the first-party in-app recorder may run on any origin), so it's gated by an
 * in-memory per-IP rate limiter and a hard body-size cap, and the resulting row
 * is left unattributed (`project_id IS NULL`). A third-party vendor site may
 * instead present an `X-RUM-Token` header (minted per project via
 * `POST /api/projects/:projectId/rum/clients`, see rum-clients-store.ts): a
 * valid token attributes the capture to its project and switches the request to
 * a per-PROJECT ingest budget; an invalid token is rejected 401. The read
 * endpoints are NOT public — replay events can
 * carry (masked) DOM content, so they require normal Hub auth AND a per-replay
 * authorization check: a replay linked to a project is only readable by callers
 * who can view that project (`canViewProject`), and an unattributed replay
 * (`project_id IS NULL`) is readable only by a privileged caller. Unauthorized
 * access is masked as 404 so a replay UUID leaked via a ticket / log / shared
 * URL can't be used to read another project's capture (no IDOR). These
 * endpoints live OUTSIDE the `/api/projects/:projectId` mount, so they cannot
 * inherit the shared visibility gate — the check is explicit here.
 */

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
// Per-project budget for token-authenticated (X-RUM-Token) vendor ingest. A
// single vendor's end users sit behind many client IPs, so a per-IP bucket
// would be meaningless for them; the budget is keyed by the token's project
// instead. Higher than the anonymous per-IP cap because it aggregates a whole
// site's traffic, but still bounded so one project can't flood the store.
export const RUM_PROJECT_RATE_LIMIT_MAX = 600;
const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MB of rrweb JSON
const MAX_EVENTS = 20_000;
// rrweb EventType.FullSnapshot. A replay that never carries a full snapshot
// cannot be reconstructed, so we refuse it rather than store a dead ref.
const RRWEB_FULL_SNAPSHOT = 2;

// ── Chunked-append endpoint (POST /api/replays/:id/events) ──────────
// A streaming client picks an id and flushes batches over the lifetime of a
// session, so the per-IP budget is far more generous than the one-shot ingest.
const EVENTS_RATE_LIMIT_MAX = 600; // ~10 batches/min/IP over the hour window
// rrweb batches gzip very well; bound the post-inflation byte count with a hard
// ceiling that also guards against a gzip bomb (applied by both express's own
// inflate `limit` and our manual gunzip `maxOutputLength`).
const MAX_BATCH_DECOMPRESSED_BYTES = 16 * 1024 * 1024; // 16 MB after gunzip
const MAX_EVENTS_PER_BATCH = 10_000;
// A caller-supplied id becomes both the PK and (sanitised) the storage key, so
// constrain it to the uuid-ish charset to keep the key 1:1 with the id.
const REPLAY_ID_RE = /^[A-Za-z0-9._-]{8,200}$/;

// ─── Rate limit ──────────────────────────────────────────────────
export const _rateBuckets = new Map<string, { count: number; resetAt: number }>();
export const _eventsRateBuckets = new Map<string, { count: number; resetAt: number }>();
// Token-authenticated ingest budget, keyed by project id (not IP).
export const _projectRateBuckets = new Map<string, { count: number; resetAt: number }>();

export function _resetRateLimit(): void {
  _rateBuckets.clear();
  _eventsRateBuckets.clear();
  _projectRateBuckets.clear();
}

function ipFromReq(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0]!.trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function bucketCheck(
  buckets: Map<string, { count: number; resetAt: number }>,
  ip: string,
  max: number,
): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const entry = buckets.get(ip);
  if (!entry || entry.resetAt <= now) {
    buckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { ok: true, retryAfterMs: 0 };
  }
  if (entry.count >= max) {
    return { ok: false, retryAfterMs: entry.resetAt - now };
  }
  entry.count += 1;
  return { ok: true, retryAfterMs: 0 };
}

function rateLimitCheck(ip: string): { ok: boolean; retryAfterMs: number } {
  return bucketCheck(_rateBuckets, ip, RATE_LIMIT_MAX);
}

/**
 * Non-consuming look at a bucket: reports whether `key` is already at/over `max`
 * for the current window WITHOUT incrementing it. Used as a cheap admission
 * precheck so an exhausted IP can be rejected BEFORE any expensive work (token
 * hashing + DB lookup) runs, while a request that's admitted still decides
 * separately whether to actually charge a bucket.
 */
function bucketPeek(
  buckets: Map<string, { count: number; resetAt: number }>,
  key: string,
  max: number,
): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || entry.resetAt <= now) return { ok: true, retryAfterMs: 0 };
  if (entry.count >= max) return { ok: false, retryAfterMs: entry.resetAt - now };
  return { ok: true, retryAfterMs: 0 };
}

// ─── Validation ──────────────────────────────────────────────────

export interface ReplayEvent {
  type: number;
  timestamp: number;
  data?: unknown;
}

export interface ValidatedReplay {
  events: ReplayEvent[];
  meta: Record<string, unknown> | undefined;
}

interface ValidateOpts {
  /** Require at least one rrweb full snapshot (type 2) in the array. */
  requireSnapshot: boolean;
  /** Upper bound on the number of events in this single payload. */
  maxEvents: number;
}

/**
 * Validate a parsed `{ events, meta? }` payload. Pure (no IO) so it can be
 * unit-tested. Requires a non-empty `events` array whose entries each carry a
 * numeric rrweb `type` and `timestamp`; `meta`, when present, must be a plain
 * object. `requireSnapshot` enforces the minimum-replayable shape (a full
 * snapshot anywhere in the array).
 */
function validateEvents(
  body: unknown,
  opts: ValidateOpts,
): { ok: true; value: ValidatedReplay } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const { events, meta } = body as { events?: unknown; meta?: unknown };
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: false, error: 'events must be a non-empty array' };
  }
  if (events.length > opts.maxEvents) {
    return { ok: false, error: `events exceeds ${opts.maxEvents} cap` };
  }
  let hasFullSnapshot = false;
  for (const e of events) {
    if (
      !e ||
      typeof e !== 'object' ||
      typeof (e as ReplayEvent).type !== 'number' ||
      typeof (e as ReplayEvent).timestamp !== 'number'
    ) {
      return { ok: false, error: 'each event needs numeric type and timestamp' };
    }
    if ((e as ReplayEvent).type === RRWEB_FULL_SNAPSHOT) hasFullSnapshot = true;
  }
  // Without a full snapshot the events can't reconstruct the DOM, and the
  // resulting ref is later trusted enough to surface in intake prompts.
  if (opts.requireSnapshot && !hasFullSnapshot) {
    return { ok: false, error: 'events must include a full snapshot (type 2)' };
  }
  if (meta != null && (typeof meta !== 'object' || Array.isArray(meta))) {
    return { ok: false, error: 'meta must be an object when present' };
  }
  return {
    ok: true,
    value: {
      events: events as ReplayEvent[],
      meta: (meta as Record<string, unknown> | undefined) ?? undefined,
    },
  };
}

/**
 * Validate a one-shot replay ingest body (`POST /api/replays`). Always requires
 * a full snapshot, since the whole capture arrives at once.
 */
export function validateReplayPayload(
  body: unknown,
): { ok: true; value: ValidatedReplay } | { ok: false; error: string } {
  return validateEvents(body, { requireSnapshot: true, maxEvents: MAX_EVENTS });
}

/**
 * Validate one chunk of a streamed replay (`POST /api/replays/:id/events`). The
 * FIRST chunk (no replay row yet) must carry the full snapshot so the capture is
 * replayable; later chunks append incremental events and need not repeat it.
 */
export function validateEventBatch(
  body: unknown,
  isFirstChunk: boolean,
): { ok: true; value: ValidatedReplay } | { ok: false; error: string } {
  return validateEvents(body, {
    requireSnapshot: isFirstChunk,
    maxEvents: MAX_EVENTS_PER_BATCH,
  });
}

/**
 * Decode a request body into a parsed JSON object, transparently gunzipping a
 * raw gzip-framed body (magic `1f 8b`). A `Content-Encoding: gzip` body is
 * already inflated by express before it reaches here, so we sniff the bytes
 * rather than the header to avoid a double-inflate. The decompressed size is
 * bounded by a hard ceiling so a small gzip body can't expand into a memory
 * bomb. Pure apart from the in-memory inflate.
 */
export function decodeReplayBatchBody(
  raw: Buffer,
): { ok: true; value: unknown } | { ok: false; status: number; error: string } {
  if (!Buffer.isBuffer(raw) || raw.length === 0) {
    return { ok: false, status: 400, error: 'empty request body' };
  }
  const looksGzip = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  let jsonBuf: Buffer;
  if (looksGzip) {
    try {
      jsonBuf = gunzipSync(raw, { maxOutputLength: MAX_BATCH_DECOMPRESSED_BYTES });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/maxOutputLength|buffer/i.test(msg)) {
        return { ok: false, status: 413, error: 'decompressed payload too large' };
      }
      return { ok: false, status: 400, error: 'malformed gzip payload' };
    }
  } else {
    jsonBuf = raw;
  }
  try {
    return { ok: true, value: JSON.parse(jsonBuf.toString('utf-8')) };
  } catch {
    return { ok: false, status: 400, error: 'body must be valid JSON' };
  }
}

// ─── Route factory ───────────────────────────────────────────────

export default function createReplayRoutes(deps: RouteDeps): Router {
  const { serverDir, stmts, config, findProject } = deps;
  const router = Router();
  const UPLOADS_DIR = path.join(serverDir, 'uploads');
  mkdirSync(UPLOADS_DIR, { recursive: true });

  /**
   * Fetch a replay row only if the caller is authorized to read it; otherwise
   * write a 404 and return null. Unauthorized and not-found collapse to the
   * same 404 so a leaked UUID can't probe for existence across projects.
   */
  function loadAuthorizedReplay(req: Request, res: Response): SessionReplayRow | null {
    const row = stmts.getSessionReplay.get(req.params.id) as SessionReplayRow | undefined;
    if (!row) {
      res.status(404).json({ error: 'Replay not found' });
      return null;
    }
    const caller = resolveVisibilityCaller(req);
    const project = row.project_id ? findProject(row.project_id) : null;
    if (!canViewReplay(row, caller, project)) {
      res.status(404).json({ error: 'Replay not found' });
      return null;
    }
    return row;
  }

  function applyCors(_req: Request, res: Response, next: NextFunction): void {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
    res.header('Access-Control-Max-Age', '600');
    next();
  }

  router.options('/api/replays', applyCors, (_req, res) => {
    res.status(204).end();
  });

  router.post(
    '/api/replays',
    applyCors,
    express.json({ limit: MAX_BODY_BYTES }),
    async (req: Request, res: Response) => {
      try {
        // Optional vendor authentication via `X-RUM-Token`.
        //
        //   - VALID token   → attribute the capture to its project and use a
        //                     per-PROJECT budget. The per-IP bucket is never
        //                     charged, so a vendor proxying many users through one
        //                     IP isn't throttled by the anonymous cap.
        //   - no token      → anonymous ingest on the per-IP budget.
        //   - INVALID token → charged to the per-IP budget, then 401.
        //
        // Crucially, the per-IP budget is PRECHECKED (without consuming) BEFORE
        // any token is verified: token verification hashes the token and hits the
        // DB, so an exhausted IP must be rejected with 429 *before* that work
        // runs — otherwise a bogus-token flood could keep forcing hash + indexed
        // lookups while already being rate-limited. Only well-formed unknown
        // tokens that pass the precheck reach `verifyRumToken`.
        const ip = ipFromReq(req);
        const rawToken = req.headers['x-rum-token'];
        const presentedToken = Array.isArray(rawToken) ? rawToken[0] : rawToken;
        const hasToken = presentedToken != null && String(presentedToken).trim() !== '';

        let attributedProjectId: string | null = null;
        if (hasToken) {
          // Cheap, non-consuming admission check guarding the verification path.
          const pre = bucketPeek(_rateBuckets, ip, RATE_LIMIT_MAX);
          if (!pre.ok) {
            res.setHeader('Retry-After', Math.ceil(pre.retryAfterMs / 1000));
            return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
          }
          const verified = verifyRumToken(String(presentedToken).trim());
          if (verified) {
            attributedProjectId = verified.projectId;
            const rl = bucketCheck(
              _projectRateBuckets,
              attributedProjectId,
              RUM_PROJECT_RATE_LIMIT_MAX,
            );
            if (!rl.ok) {
              res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
              return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
            }
          } else {
            // Malformed / unknown / revoked token: charge the per-IP budget (so a
            // bogus header is no cheaper than an anonymous ingest), then 401 — or
            // 429 if that charge tips the IP over its budget.
            const rl = rateLimitCheck(ip);
            if (!rl.ok) {
              res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
              return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
            }
            return res.status(401).json({ error: 'Invalid RUM token' });
          }
        } else {
          const rl = rateLimitCheck(ip);
          if (!rl.ok) {
            res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
            return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
          }
        }

        const parsed = validateReplayPayload(req.body);
        if (!parsed.ok) {
          return res.status(400).json({ error: parsed.error });
        }

        const replayId = uuidv4();
        const filename = `replay-${replayId}.json`;
        const dest = path.join(UPLOADS_DIR, filename);
        const record = {
          replayId,
          createdAt: new Date().toISOString(),
          meta: parsed.value.meta ?? null,
          events: parsed.value.events,
        };
        // Legacy plain-JSON companion that `resolveReplayContext` reads back.
        writeFileSync(dest, JSON.stringify(record));
        const replayRef = `/uploads/${filename}`;

        // Durable gzipped blob + metadata row (the new storage of record). If it
        // fails, remove the legacy companion: an orphaned `/uploads/replay-*`
        // file has no `session_replays` row, so it can't be authorized, linked,
        // listed, or deleted through the new model while still holding the
        // sensitive event payload.
        let row: SessionReplayRow;
        try {
          row = await storeReplay(
            { stmts, config },
            {
              id: replayId,
              events: parsed.value.events,
              meta: parsed.value.meta ?? null,
              projectId: attributedProjectId,
            },
          );
        } catch (err) {
          rmSync(dest, { force: true });
          throw err;
        }

        return res.status(201).json({
          replayId,
          replayRef,
          projectId: row.project_id,
          size: row.size,
          eventCount: row.event_count,
          durationMs: row.duration_ms,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[Replays] Unexpected failure:', message);
        return res.status(500).json({ error: message });
      }
    },
  );

  // ── Chunked append (public) ──────────────────────────────────────
  // A streaming client picks a replay id and POSTs gzipped batches of rrweb
  // events over the lifetime of a capture. The first batch creates the replay
  // (and must carry a full snapshot); later batches append. Public + CORS *,
  // mirroring the one-shot ingest, but on its own (more generous) per-IP budget.
  router.options('/api/replays/:id/events', applyCors, (_req, res) => {
    res.status(204).end();
  });

  // Cheap admission gate that runs BEFORE the raw body is read/inflated, so a
  // rate-limited or malformed-id caller can't force up to 16 MB of body parsing
  // + gunzip work on a public, unauthenticated endpoint. Both checks here are
  // O(1) and touch no body bytes.
  function eventsIngestGate(req: Request, res: Response, next: NextFunction): void {
    const ip = ipFromReq(req);
    const rl = bucketCheck(_eventsRateBuckets, ip, EVENTS_RATE_LIMIT_MAX);
    if (!rl.ok) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
      res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
      return;
    }
    if (!REPLAY_ID_RE.test(String(req.params.id))) {
      res.status(400).json({ error: 'invalid replay id' });
      return;
    }
    next();
  }

  router.post(
    '/api/replays/:id/events',
    applyCors,
    eventsIngestGate,
    // Accept any content type as raw bytes. express inflates a
    // `Content-Encoding: gzip` body itself (bounded by `limit`); a raw
    // gzip-framed body with no encoding header passes through and is inflated in
    // decodeReplayBatchBody. `limit` bounds the post-inflation byte count. This
    // only runs once the gate above has admitted the request.
    express.raw({ type: () => true, limit: MAX_BATCH_DECOMPRESSED_BYTES }),
    async (req: Request, res: Response) => {
      try {
        const id = String(req.params.id);
        const decoded = decodeReplayBatchBody(req.body as Buffer);
        if (!decoded.ok) {
          return res.status(decoded.status).json({ error: decoded.error });
        }

        // Structural validation only (shape / non-empty / per-batch cap / meta);
        // it does NOT depend on stored state, so it's safe to run before the
        // lock. The state-dependent decisions — whether the replay is finalized
        // and whether this is the creating (first) chunk that must carry a
        // snapshot — are enforced INSIDE appendReplayEvents' per-id critical
        // section against a freshly-read row, eliminating the TOCTOU between a
        // stale read here and the serialized blob overwrite.
        const parsed = validateEventBatch(decoded.value, false);
        if (!parsed.ok) {
          return res.status(400).json({ error: parsed.error });
        }

        let result;
        try {
          result = await appendReplayEvents(
            { stmts, config },
            { id, events: parsed.value.events, meta: parsed.value.meta ?? null },
            {
              totalEventCap: MAX_EVENTS,
              rejectIfFinalized: true,
              requireSnapshotOnFirstChunk: true,
            },
          );
        } catch (err) {
          if (err instanceof ReplayNeedsSnapshotError) {
            return res.status(400).json({ error: err.message });
          }
          if (err instanceof ReplayFinalizedError) {
            return res.status(409).json({ error: err.message });
          }
          if (err instanceof ReplayEventCapError) {
            return res.status(413).json({ error: err.message });
          }
          if (err instanceof ArtifactStoreUnavailableError) {
            return res.status(503).json({ error: err.message });
          }
          throw err;
        }

        const { row, created } = result;
        return res.status(created ? 201 : 200).json({
          replayId: row.id,
          created,
          eventCount: row.event_count,
          size: row.size,
          durationMs: row.duration_ms,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[Replays] Chunked append failed:', message);
        return res.status(500).json({ error: message });
      }
    },
  );

  // ── Read: metadata ────────────────────────────────────────────────
  // Authenticated (not in PUBLIC_PATHS / no CORS *). Replay events can carry
  // masked DOM content, so reads require normal Hub auth.
  router.get('/api/replays/:id', (req: Request, res: Response) => {
    const row = loadAuthorizedReplay(req, res);
    if (!row) return; // 404 already sent
    return res.json(toReplayView(row));
  });

  // ── Read: paginated events ────────────────────────────────────────
  // Large captures must not load in one request — the blob is gunzipped once
  // server-side and sliced by `offset`/`limit` (defaults applied + capped in
  // `paginateEvents`). The page carries `total`/`hasMore` so callers can walk.
  router.get('/api/replays/:id/events', async (req: Request, res: Response) => {
    const row = loadAuthorizedReplay(req, res);
    if (!row) return; // 404 already sent

    const offset = parseIntParam(req.query.offset);
    const limit = parseIntParam(req.query.limit);
    try {
      const page = await readReplayEventsPage({ stmts, config }, row, offset, limit);
      return res.json({ replayId: row.id, ...page });
    } catch (err) {
      if (err instanceof ArtifactStoreUnavailableError) {
        return res.status(503).json({ error: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Replays] Failed to read events:', message);
      return res.status(500).json({ error: 'Failed to read replay events' });
    }
  });

  return router;
}

/**
 * May `caller` read this replay? Pure (no IO) so it can be unit-tested.
 *
 *   - Project-linked replay: defer to `canViewProject` on the resolved project.
 *     A dangling `project_id` (project deleted / not found → `project` is null)
 *     denies, so a replay never outlives the access boundary of its project.
 *   - Unattributed replay (`project_id IS NULL`): no project to scope to, so
 *     only a privileged caller may read it — the global apiKey break-glass /
 *     local-bundled bypass (`caller.localBypass`) or an org Owner. This keeps
 *     anonymous-ingest captures (which carry masked DOM) out of reach of an
 *     ordinary member who happens to learn a UUID.
 */
export function canViewReplay(
  row: Pick<SessionReplayRow, 'project_id'>,
  caller: VisibilityCaller,
  project: Project | null,
): boolean {
  if (row.project_id) {
    if (!project) return false;
    return canViewProject(project, caller);
  }
  return Boolean(caller.localBypass) || caller.role === 'Owner';
}

/** Parse a numeric query param, returning undefined for missing / non-numeric
 *  values so `paginateEvents` applies its defaults. */
function parseIntParam(v: unknown): number | undefined {
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

interface ReplayView {
  id: string;
  projectId: string | null;
  createdAt: string;
  durationMs: number;
  eventCount: number;
  size: number;
  uncompressedSize: number;
  supportTicketId: string | null;
  cardId: string | null;
  meta: Record<string, unknown> | null;
  eventsUrl: string;
  defaultPageSize: number;
}

function toReplayView(row: SessionReplayRow): ReplayView {
  let meta: Record<string, unknown> | null = null;
  if (row.meta) {
    try {
      meta = JSON.parse(row.meta) as Record<string, unknown>;
    } catch {
      meta = null;
    }
  }
  return {
    id: row.id,
    projectId: row.project_id,
    createdAt: row.created_at,
    durationMs: row.duration_ms,
    eventCount: row.event_count,
    size: row.size,
    uncompressedSize: row.uncompressed_size,
    supportTicketId: row.support_ticket_id,
    cardId: row.card_id,
    meta,
    eventsUrl: `/api/replays/${row.id}/events`,
    defaultPageSize: DEFAULT_EVENTS_PAGE,
  };
}
