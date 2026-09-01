import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import path from 'path';
import { gunzipSync } from 'zlib';
import { mkdirSync } from 'fs';
import { writeFile, rm } from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import type { Project, RouteDeps, SessionReplayRow } from '../types.js';
import type { RumSegmentRow } from '../types.js';
import {
  storeReplay,
  readReplayEventsPage,
  appendReplayEvents,
  ReplayEventCapError,
  ReplayByteCapError,
  ReplayFinalizedError,
  ReplayNeedsSnapshotError,
  ReplayAttributionMismatchError,
  ReplaySegmentedLayoutError,
  DEFAULT_EVENTS_PAGE,
} from '../replays/replay-store.js';
import {
  listSessionSegments,
  buildSessionSegmentManifest,
  readSegment,
  appendSegment,
  SegmentNeedsSnapshotError,
} from '../replays/segment-store.js';
import { computeEnrichment } from '../replays/rum-enrichment.js';
import { readAllReplayEvents } from '../replays/replay-context-loader.js';
import { buildReplayTranscript } from '../replays/replay-transcript.js';
import { buildReplayContextPack } from '../replays/replay-context-pack.js';
import { ArtifactStoreUnavailableError } from '../artifacts/artifact-store.js';
import { WalPressureError } from '../db-checkpoint.js';
import { canViewProject, type VisibilityCaller } from '../project-visibility.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import { verifyRumToken } from '../rum-clients-store.js';
import { resolveReplayPolicy, resolveIngestQuota } from '../replays/replay-config.js';
import { computeRetainedUntil, toSqliteUtc } from '../replays/replay-retention.js';
import { resolveUploadsDir } from '../uploads-dir.js';

/**
 * Public, rate-limited session-replay ingest endpoint, plus authenticated read
 * surfaces for the stored capture.
 *
 * Ingest (POST, public): accepts a JSON body of rrweb events (the trailing
 * rolling-buffer window the web client flushes on a bug-report submit or an
 * uncaught error). The events are gzipped and persisted as a durable blob via
 * the artifact store, indexed by a `session_replays` metadata row (see
 * server/replays/replay-store.ts). For backward compatibility a plain
 * `<uploadsDir>/replay-<uuid>.json` companion is also written — the exact
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
const MAX_EVENTS = 20_000;
// Uncompressed-byte ceiling on one monolithic capture. The event cap alone is
// no byte bound — prod grew 20k-event captures past 200 MB, and the per-append
// whole-blob JSON parse/stringify froze the event loop for seconds per flush
// (2026-07-08 incident). Once a capture reaches this, further appends 413 and
// the recorder rotates to a fresh id, so per-append main-thread cost is bounded
// by the cap. Env-overridable for tuning without a deploy.
const MAX_UNCOMPRESSED_BYTES = (() => {
  const raw = Number(process.env.REPLAY_MAX_UNCOMPRESSED_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10 * 1024 * 1024; // 10 MB
})();
// rrweb EventType.FullSnapshot. A replay that never carries a full snapshot
// cannot be reconstructed, so we refuse it rather than store a dead ref.
const RRWEB_FULL_SNAPSHOT = 2;

// ── Chunked-append endpoint (POST /api/replays/:id/events) ──────────
// A streaming client picks an id and flushes batches over the lifetime of a
// session, so the per-IP budget is far more generous than the one-shot ingest.
const EVENTS_RATE_LIMIT_MAX = 600; // ~10 batches/min/IP over the hour window
// Per-project budget for token-authenticated (X-RUM-Token) chunked ingest, the
// streaming analogue of RUM_PROJECT_RATE_LIMIT_MAX for the one-shot path. A
// vendor's end users sit behind many IPs, so a per-IP bucket is meaningless for
// them; the budget is keyed by the token's project instead. Higher than the
// per-IP events cap because it aggregates a whole site's streaming traffic, but
// still bounded so one project can't flood the store.
export const RUM_PROJECT_EVENTS_RATE_LIMIT_MAX = 6000;
// rrweb batches gzip very well; bound the post-inflation byte count with a hard
// ceiling that also guards against a gzip bomb (applied by both express's own
// inflate `limit` and our manual gunzip `maxOutputLength`).
const MAX_BATCH_DECOMPRESSED_BYTES = 16 * 1024 * 1024; // 16 MB after gunzip
const MAX_EVENTS_PER_BATCH = 10_000;
// A caller-supplied id becomes both the PK and (sanitised) the storage key, so
// constrain it to the uuid-ish charset to keep the key 1:1 with the id.
const REPLAY_ID_RE = /^[A-Za-z0-9._-]{8,200}$/;
// Client-minted session / view ids that become path + storage-key components.
// Same charset as a replay id, but the minimum length is relaxed to 1 so a short
// client-generated view id (e.g. a small counter) is accepted.
const SEGMENT_PART_RE = /^[A-Za-z0-9._-]{1,200}$/;
// index_in_view path component: a small non-negative integer.
const SEGMENT_INDEX_RE = /^\d{1,7}$/;

// ─── Rate limit ──────────────────────────────────────────────────
export const _rateBuckets = new Map<string, { count: number; resetAt: number }>();
export const _eventsRateBuckets = new Map<string, { count: number; resetAt: number }>();
// Token-authenticated ingest budget, keyed by project id (not IP).
export const _projectRateBuckets = new Map<string, { count: number; resetAt: number }>();
// Token-authenticated CHUNKED ingest budget, keyed by project id (not IP).
export const _projectEventsRateBuckets = new Map<string, { count: number; resetAt: number }>();

export function _resetRateLimit(): void {
  _rateBuckets.clear();
  _eventsRateBuckets.clear();
  _projectRateBuckets.clear();
  _projectEventsRateBuckets.clear();
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
  const UPLOADS_DIR = resolveUploadsDir(config, serverDir);
  mkdirSync(UPLOADS_DIR, { recursive: true });

  // Per-tenant hourly ingest budgets, keyed on the RUM token's project. A tenant
  // may override the global default (`replay.ingestQuota` / `eventsIngestQuota`);
  // an unset / invalid override falls back to the global constant. The one-shot
  // and streaming (chunked + segment) paths carry independent budgets.
  const projectIngestQuota = (projectId: string): number =>
    resolveIngestQuota(findProject(projectId)?.replay?.ingestQuota, RUM_PROJECT_RATE_LIMIT_MAX);
  const projectEventsIngestQuota = (projectId: string): number =>
    resolveIngestQuota(
      findProject(projectId)?.replay?.eventsIngestQuota,
      RUM_PROJECT_EVENTS_RATE_LIMIT_MAX,
    );

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
    // X-RUM-Token lets a cross-origin embedded recorder attribute its ingest
    // (one-shot and chunked) to its project — mirrors the config endpoint's CORS.
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With, X-RUM-Token');
    res.header('Access-Control-Max-Age', '600');
    next();
  }

  router.options('/api/replays', applyCors, (_req, res) => {
    res.status(204).end();
  });

  router.post(
    '/api/replays',
    applyCors,
    // Accept the body as raw bytes so a large rrweb capture can arrive
    // gzip-compressed (rrweb JSON compresses ~10-20x). express inflates a
    // `Content-Encoding: gzip` body itself (bounded by `limit`); a raw
    // gzip-framed body with no encoding header passes through and is inflated by
    // decodeReplayBatchBody, which also handles a plain-JSON body. `limit` bounds
    // the post-inflation byte count — the same ceiling the chunked endpoint uses.
    express.raw({ type: () => true, limit: MAX_BATCH_DECOMPRESSED_BYTES }),
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
              projectIngestQuota(attributedProjectId),
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

        // Decode (and transparently gunzip) the raw body only after the
        // rate-limit admission above, so a throttled caller never forces gunzip
        // work. Handles plain JSON, a gzip-framed body, and an already-inflated
        // `Content-Encoding: gzip` body uniformly.
        const decoded = decodeReplayBatchBody(req.body as Buffer);
        if (!decoded.ok) {
          return res.status(decoded.status).json({ error: decoded.error });
        }

        const parsed = validateReplayPayload(decoded.value);
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
        // Async write: synchronous `writeFileSync` of the (uncompressed,
        // 250-400 KB) record here was ~26% of the Hub's event-loop CPU under
        // active replay ingest — the single largest blocker. `fs/promises`
        // moves the write off the main thread.
        await writeFile(dest, JSON.stringify(record));
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
          await rm(dest, { force: true });
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
  // mirroring the one-shot ingest. Like the one-shot path it honors an optional
  // `X-RUM-Token`: a valid token attributes the whole stream to its project (the
  // creating chunk stamps `project_id`) and switches to a per-PROJECT events
  // budget; without a token the capture stays anonymous on the per-IP budget.
  // This is what keeps recorder-streamed captures from landing as orphans.
  router.options('/api/replays/:id/events', applyCors, (_req, res) => {
    res.status(204).end();
  });

  // Cheap admission gate that runs BEFORE the raw body is read/inflated, so a
  // rate-limited, malformed-id, or bad-token caller can't force up to 16 MB of
  // body parsing + gunzip work on a public, unauthenticated endpoint. Every check
  // here is O(1) (plus, for a well-formed token, one indexed lookup) and touches
  // no body bytes.
  //
  // Optional vendor authentication mirrors the one-shot path:
  //   - VALID token   → attribute the stream to its project, charge a per-PROJECT
  //                     events budget, and stash the project on res.locals so the
  //                     handler can pass it to appendReplayEvents.
  //   - no token      → anonymous ingest on the per-IP events budget (unchanged).
  //   - INVALID token → charged to the per-IP events budget, then 401.
  // The per-IP budget is PRECHECKED (without consuming) before verifyRumToken so
  // an exhausted IP is rejected before the token hash + DB lookup runs.
  function eventsIngestGate(req: Request, res: Response, next: NextFunction): void {
    if (!REPLAY_ID_RE.test(String(req.params.id))) {
      res.status(400).json({ error: 'invalid replay id' });
      return;
    }
    const ip = ipFromReq(req);
    const rawToken = req.headers['x-rum-token'];
    const presentedToken = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    const hasToken = presentedToken != null && String(presentedToken).trim() !== '';

    if (hasToken) {
      const pre = bucketPeek(_eventsRateBuckets, ip, EVENTS_RATE_LIMIT_MAX);
      if (!pre.ok) {
        res.setHeader('Retry-After', Math.ceil(pre.retryAfterMs / 1000));
        res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
        return;
      }
      const verified = verifyRumToken(String(presentedToken).trim());
      if (verified) {
        const rl = bucketCheck(
          _projectEventsRateBuckets,
          verified.projectId,
          projectEventsIngestQuota(verified.projectId),
        );
        if (!rl.ok) {
          res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
          res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
          return;
        }
        res.locals.rumProjectId = verified.projectId;
      } else {
        // Malformed / unknown / revoked token: charge the per-IP budget (so a
        // bogus header is no cheaper than an anonymous ingest), then 401 — or 429
        // if that charge tips the IP over its budget.
        const rl = bucketCheck(_eventsRateBuckets, ip, EVENTS_RATE_LIMIT_MAX);
        if (!rl.ok) {
          res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
          res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
          return;
        }
        res.status(401).json({ error: 'Invalid RUM token' });
        return;
      }
    } else {
      const rl = bucketCheck(_eventsRateBuckets, ip, EVENTS_RATE_LIMIT_MAX);
      if (!rl.ok) {
        res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
        res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
        return;
      }
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

        // Resolved by eventsIngestGate from a verified X-RUM-Token (null =
        // anonymous). The creating chunk stamps it; later chunks must agree.
        const attributedProjectId = (res.locals.rumProjectId as string | undefined) ?? null;

        let result;
        try {
          result = await appendReplayEvents(
            { stmts, config },
            {
              id,
              events: parsed.value.events,
              meta: parsed.value.meta ?? null,
              projectId: attributedProjectId,
            },
            {
              totalEventCap: MAX_EVENTS,
              totalUncompressedByteCap: MAX_UNCOMPRESSED_BYTES,
              rejectIfFinalized: true,
              requireSnapshotOnFirstChunk: true,
            },
          );
        } catch (err) {
          if (err instanceof ReplayNeedsSnapshotError) {
            return res.status(400).json({ error: err.message });
          }
          if (err instanceof ReplayAttributionMismatchError) {
            return res.status(403).json({ error: err.message });
          }
          if (err instanceof ReplayFinalizedError) {
            return res.status(409).json({ error: err.message });
          }
          if (err instanceof ReplayEventCapError) {
            return res.status(413).json({ error: err.message });
          }
          if (err instanceof ReplayByteCapError) {
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
          projectId: row.project_id,
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

  // ── Segment append (public, view-scoped) ─────────────────────────
  // The forward write path for continuous capture: instead of re-uploading a
  // growing monolithic blob, the recorder streams VIEW-SCOPED segments — one
  // gzipped object per `(sessionId, viewId, index_in_view)` slot, an O(1) append
  // (`appendSegment`) indexed by the `rum_segments` manifest. The view-opening
  // segment (index_in_view=0) must carry a full snapshot; later indices append
  // incrementally. Public + CORS *, mirroring the monolithic ingest paths, with
  // the same optional `X-RUM-Token` attribution and the same events rate budget
  // (a segment is just a smaller, view-scoped chunk).
  router.options(
    '/api/replays/sessions/:sessionId/views/:viewId/segments/:index',
    applyCors,
    (_req, res) => {
      res.status(204).end();
    },
  );

  // Cheap admission gate: validates the path components and charges the events
  // rate budget BEFORE any body is read/inflated. Mirrors `eventsIngestGate` but
  // keys on the segment's `(sessionId, viewId, index)` triple, and reuses the same
  // per-IP / per-project events buckets so a client streaming segments is bounded
  // by one budget regardless of which append shape it uses.
  function segmentIngestGate(req: Request, res: Response, next: NextFunction): void {
    if (!SEGMENT_PART_RE.test(String(req.params.sessionId))) {
      res.status(400).json({ error: 'invalid session id' });
      return;
    }
    if (!SEGMENT_PART_RE.test(String(req.params.viewId))) {
      res.status(400).json({ error: 'invalid view id' });
      return;
    }
    if (!SEGMENT_INDEX_RE.test(String(req.params.index))) {
      res.status(400).json({ error: 'invalid segment index' });
      return;
    }
    const ip = ipFromReq(req);
    const rawToken = req.headers['x-rum-token'];
    const presentedToken = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    const hasToken = presentedToken != null && String(presentedToken).trim() !== '';

    if (hasToken) {
      const pre = bucketPeek(_eventsRateBuckets, ip, EVENTS_RATE_LIMIT_MAX);
      if (!pre.ok) {
        res.setHeader('Retry-After', Math.ceil(pre.retryAfterMs / 1000));
        res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
        return;
      }
      const verified = verifyRumToken(String(presentedToken).trim());
      if (verified) {
        const rl = bucketCheck(
          _projectEventsRateBuckets,
          verified.projectId,
          projectEventsIngestQuota(verified.projectId),
        );
        if (!rl.ok) {
          res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
          res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
          return;
        }
        res.locals.rumProjectId = verified.projectId;
      } else {
        const rl = bucketCheck(_eventsRateBuckets, ip, EVENTS_RATE_LIMIT_MAX);
        if (!rl.ok) {
          res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
          res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
          return;
        }
        res.status(401).json({ error: 'Invalid RUM token' });
        return;
      }
    } else {
      const rl = bucketCheck(_eventsRateBuckets, ip, EVENTS_RATE_LIMIT_MAX);
      if (!rl.ok) {
        res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
        res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
        return;
      }
    }
    next();
  }

  router.post(
    '/api/replays/sessions/:sessionId/views/:viewId/segments/:index',
    applyCors,
    segmentIngestGate,
    express.raw({ type: () => true, limit: MAX_BATCH_DECOMPRESSED_BYTES }),
    async (req: Request, res: Response) => {
      try {
        const sessionId = String(req.params.sessionId);
        const viewId = String(req.params.viewId);
        const indexInView = Number(req.params.index);

        const decoded = decodeReplayBatchBody(req.body as Buffer);
        if (!decoded.ok) {
          return res.status(decoded.status).json({ error: decoded.error });
        }

        // The view-opening segment (index 0) must carry a full snapshot; later
        // segments append incrementally. `appendSegment` re-checks this too.
        const parsed = validateEventBatch(decoded.value, indexInView === 0);
        if (!parsed.ok) {
          return res.status(400).json({ error: parsed.error });
        }

        // Resolved by the gate from a verified X-RUM-Token (null = anonymous).
        const attributedProjectId = (res.locals.rumProjectId as string | undefined) ?? null;

        // Derive the request facets (device/browser/os from the UA, geo_country
        // from the client IP) so the session row indexes them. First-non-null-wins
        // in the rollup, so only the first segment of a session actually sets them.
        const enrichment = computeEnrichment({
          userAgent: req.headers['user-agent'],
          ip: ipFromReq(req),
        });

        let row: RumSegmentRow;
        try {
          row = await appendSegment(
            { stmts, config },
            {
              sessionId,
              viewId,
              indexInView,
              projectId: attributedProjectId,
              events: parsed.value.events,
              meta: parsed.value.meta ?? null,
              enrichment,
            },
          );
        } catch (err) {
          if (err instanceof SegmentNeedsSnapshotError) {
            return res.status(400).json({ error: err.message });
          }
          if (err instanceof WalPressureError) {
            // rum.db WAL is over its hard limit and can't be checkpointed; shed
            // ingest until it drains so the WAL stops growing.
            res.setHeader('Retry-After', '30');
            return res.status(503).json({ error: err.message });
          }
          if (err instanceof ArtifactStoreUnavailableError) {
            return res.status(503).json({ error: err.message });
          }
          // A reused (session, view, index) slot trips the UNIQUE manifest index.
          const msg = err instanceof Error ? err.message : String(err);
          if (/UNIQUE|constraint/i.test(msg)) {
            return res.status(409).json({ error: 'segment slot already written' });
          }
          throw err;
        }

        return res.status(201).json({
          segmentId: row.id,
          sessionId: row.session_id,
          viewId: row.view_id,
          indexInView: row.index_in_view,
          hasFullSnapshot: row.has_full_snapshot === 1,
          projectId: row.project_id,
          eventCount: row.event_count,
          byteSize: row.byte_size,
          startTs: row.start_ts,
          endTs: row.end_ts,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[Replays] Segment append failed:', message);
        return res.status(500).json({ error: message });
      }
    },
  );

  // ── Read: per-project replay policy (public) ──────────────────────
  // Server-delivered replay config a recorder fetches at boot to learn the
  // sample rate / continuous-tier opt-in for its project. Replaces the legacy
  // per-browser localStorage sample rate so the policy applies to every user.
  //
  // Project resolution (first match wins): a valid `X-RUM-Token` (injected
  // third-party recorders), else `?projectId=` (the Hub's own UI). No project
  // → the default policy (sampleRate null → client keeps its built-in default;
  // continuous off). Public + CORS `*` so cross-origin instrumented apps can
  // read it; the policy carries no secrets. An unknown project resolves to the
  // default policy so it is not an existence oracle.
  function applyConfigCors(_req: Request, res: Response, next: NextFunction): void {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With, X-RUM-Token');
    res.header('Access-Control-Max-Age', '600');
    next();
  }

  router.options('/api/replays/config', applyConfigCors, (_req, res) => {
    res.status(204).end();
  });

  router.get('/api/replays/config', applyConfigCors, (req: Request, res: Response) => {
    let project: Project | null = null;

    const rawToken = req.headers['x-rum-token'];
    const presentedToken = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    if (presentedToken != null && String(presentedToken).trim() !== '') {
      const verified = verifyRumToken(String(presentedToken).trim());
      if (verified) project = findProject(verified.projectId) ?? null;
    }
    if (!project) {
      const rawPid = req.query.projectId;
      const pid = Array.isArray(rawPid) ? rawPid[0] : rawPid;
      if (typeof pid === 'string' && pid.trim() !== '') {
        project = findProject(pid.trim()) ?? null;
      }
    }

    const policy = resolveReplayPolicy(project?.replay ?? null, config.replayMaskAllEnforced);
    res.json(policy);
  });

  // ── Read: metadata ────────────────────────────────────────────────
  // Authenticated (not in PUBLIC_PATHS / no CORS *). Replay events can carry
  // masked DOM content, so reads require normal Hub auth.
  router.get('/api/replays/:id', (req: Request, res: Response) => {
    const row = loadAuthorizedReplay(req, res);
    if (!row) return; // 404 already sent
    return res.json(toReplayView(row));
  });

  // ── Flag / unflag a capture for extended retention ────────────────
  // Two-tier retention: an operator keeps an individual session past the default
  // window (up to 15 months). `{ extend: true }` stamps an absolute
  // `retained_until` = now + the tenant's extension window (clamped [1,15]
  // months, default 15 by computeRetainedUntil) — the clock starts NOW (enable
  // time), not at capture — and the retention sweeper skips the row until that
  // instant passes. `{ extend: false }` clears the flag so the row rejoins the
  // default sweep.
  //
  // Authorization is DELIBERATELY the same per-replay VIEW rule as the metadata
  // GET (`loadAuthorizedReplay` → `canViewReplay`): view == manage here, so any
  // caller who can view a capture can pin it to extended retention. This is
  // intentional and bounded: the ceiling (`extendedRetentionMonths`) is itself
  // set with project-admin perms via `PATCH /api/projects/:id`, the flag is
  // reversible (`{ extend: false }`), and per-session pinning is a triage action
  // (mirroring how a viewer can already link a capture to a ticket/card, which
  // also exempts it from the sweep). If per-session pinning ever needs to be
  // Admin-only, gate it here rather than in the shared view rule.
  router.post('/api/replays/:id/retention', (req: Request, res: Response) => {
    const row = loadAuthorizedReplay(req, res);
    if (!row) return; // 404 already sent (unauthorized + not-found both mask to 404)

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.extend !== 'boolean') {
      return res.status(400).json({ error: 'Body must be { extend: boolean }' });
    }

    if (body.extend) {
      // Pass the raw per-tenant window straight through — computeRetainedUntil
      // owns the [1,15]-month clamp (and the unset → 15 default).
      const nowMs = Date.now();
      const retainedUntil = toSqliteUtc(
        computeRetainedUntil(
          nowMs,
          (row.project_id ? findProject(row.project_id) : null)?.replay?.extendedRetentionMonths,
        ),
      );
      const flaggedAt = toSqliteUtc(nowMs);
      stmts.flagSessionReplayRetention.run(retainedUntil, flaggedAt, row.id);
    } else {
      stmts.clearSessionReplayRetention.run(row.id);
    }

    const updated = stmts.getSessionReplay.get(row.id) as SessionReplayRow | undefined;
    return res.json(toReplayView(updated ?? row));
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
      if (err instanceof ReplaySegmentedLayoutError) {
        // Segmented captures don't have a monolithic blob to paginate — steer the
        // caller to the session segments API instead of returning a broken page.
        return res.status(409).json({ error: err.message });
      }
      if (err instanceof ArtifactStoreUnavailableError) {
        return res.status(503).json({ error: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Replays] Failed to read events:', message);
      return res.status(500).json({ error: 'Failed to read replay events' });
    }
  });

  // ── Read: agent-readable transcript ───────────────────────────────
  // The events endpoint above returns raw rrweb — a DOM-diff stream keyed by
  // opaque node ids, useless to anything but a player. This renders the same
  // capture as a timeline (clicks, inputs, navigations, console errors,
  // network outcomes) so a human OR an agent can read what the user did
  // without replaying 400 KB of node soup. Same per-replay authorization as
  // every other read; handles both storage layouts.
  router.get('/api/replays/:id/transcript', async (req: Request, res: Response) => {
    const row = loadAuthorizedReplay(req, res);
    if (!row) return; // 404 already sent

    const maxBytes = parseIntParam(req.query.maxBytes);
    try {
      const events = await readAllReplayEvents({ stmts, config }, row);
      // `maxBytes` bounds the RENDERED timeline (and, below, the fenced context
      // block built from it) — not the number of events read, which is capped
      // separately by the loader.
      const transcript = buildReplayTranscript(events, maxBytes ? { maxBytes } : {});
      const pack = buildReplayContextPack({
        transcript,
        replay: {
          id: row.id,
          createdAt: row.created_at,
          durationMs: row.duration_ms,
          eventCount: row.event_count,
        },
        ...(maxBytes ? { maxBytes } : {}),
      });
      return res.json({
        replayId: row.id,
        transcript: transcript.text,
        stats: transcript.stats,
        contextBlock: pack.contextBlock,
      });
    } catch (err) {
      if (err instanceof ArtifactStoreUnavailableError) {
        return res.status(503).json({ error: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Replays] Failed to build transcript:', message);
      return res.status(500).json({ error: 'Failed to build replay transcript' });
    }
  });

  // ── Read: segmented-capture playback manifest ─────────────────────
  // A `segmented` capture (server/replays/segment-store.ts) stores its bytes as
  // append-only per-segment objects indexed by `rum_segments`, keyed by the
  // client-minted session id (not a `session_replays` row). Playback lists the
  // segments in order and the player fetches + concatenates each one's events.
  //
  // Authorization mirrors the monolithic read path via the shared per-replay
  // rule (`canViewReplay`): segments carry a `project_id`, and every segment of a
  // session shares one attribution (ingest rejects a cross-project append), so we
  // authorize the session on that project. A session with no segments — or one
  // the caller can't view — collapses to 404 so a leaked session id can't probe
  // for existence or read another tenant's capture.
  router.get('/api/replays/sessions/:sessionId/segments', (req: Request, res: Response) => {
    const segments = loadAuthorizedSessionSegments(req, res);
    if (!segments) return; // 404 already sent
    return res.json(buildSessionSegmentManifest(String(req.params.sessionId), segments));
  });

  // ── Read: one segment's decoded events ────────────────────────────
  // The player fetches each manifest segment here and concatenates the events
  // client-side. The segment must belong to the path session id (keeps URLs
  // coherent and blocks cross-session id-guessing), and is authorized on its own
  // `project_id`. Not-found / wrong-session / unauthorized all collapse to 404.
  router.get(
    '/api/replays/sessions/:sessionId/segments/:segmentId/events',
    async (req: Request, res: Response) => {
      const row = stmts.getRumSegment.get(req.params.segmentId) as RumSegmentRow | undefined;
      if (!row || row.session_id !== String(req.params.sessionId) || !canViewSegment(req, row)) {
        res.status(404).json({ error: 'Segment not found' });
        return;
      }
      try {
        const blob = await readSegment({ stmts, config }, row);
        return res.json({
          sessionId: row.session_id,
          segmentId: row.id,
          viewId: row.view_id,
          indexInView: row.index_in_view,
          hasFullSnapshot: row.has_full_snapshot === 1,
          events: blob.events,
          eventCount: blob.events.length,
        });
      } catch (err) {
        if (err instanceof ArtifactStoreUnavailableError) {
          return res.status(503).json({ error: err.message });
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error('[Replays] Failed to read segment events:', message);
        return res.status(500).json({ error: 'Failed to read segment events' });
      }
    },
  );

  return router;

  /**
   * Load a session's ordered segment manifest only if the caller is authorized
   * to read it; otherwise write a 404 and return null. Empty (no such session)
   * and unauthorized collapse to the same 404 so a leaked session id can't probe
   * for existence across projects. Authorizes on the segments' shared
   * `project_id` via the same rule as the monolithic replay read.
   */
  function loadAuthorizedSessionSegments(req: Request, res: Response): RumSegmentRow[] | null {
    const segments = listSessionSegments(stmts, String(req.params.sessionId));
    if (segments.length === 0) {
      res.status(404).json({ error: 'Replay not found' });
      return null;
    }
    if (!canViewSegment(req, segments[0]!)) {
      res.status(404).json({ error: 'Replay not found' });
      return null;
    }
    return segments;
  }

  /** Per-segment authorization: identical rule to `canViewReplay`, keyed on the
   *  segment's `project_id` (segments carry the same attribution as a replay). */
  function canViewSegment(req: Request, row: Pick<RumSegmentRow, 'project_id'>): boolean {
    const caller = resolveVisibilityCaller(req);
    const project = row.project_id ? findProject(row.project_id) : null;
    return canViewReplay(row, caller, project);
  }
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
  /** Extended-retention flag: absolute instant this capture is retained until,
   *  or null when on the default window. */
  retainedUntil: string | null;
  /** When the extended-retention flag was enabled, or null. */
  retentionFlaggedAt: string | null;
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
    retainedUntil: row.retained_until ?? null,
    retentionFlaggedAt: row.retention_flagged_at ?? null,
    meta,
    eventsUrl: `/api/replays/${row.id}/events`,
    defaultPageSize: DEFAULT_EVENTS_PAGE,
  };
}
