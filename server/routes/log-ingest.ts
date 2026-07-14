/**
 * Log-ingest endpoints (decision LOG-INGEST / LOG-AUTH / LOG-TRUST):
 *
 *   POST /api/otel/v1/logs   — OTLP/HTTP logs. Accepts JSON (`application/json`)
 *                              and binary Protobuf (`application/x-protobuf`),
 *                              each optionally gzip-compressed. Replies with an
 *                              `ExportLogsServiceResponse` (partial_success when
 *                              some records were rejected), matching the request
 *                              wire format.
 *   POST /api/logs/ingest    — simple Agent Hub JSON batch, mapped to the same
 *                              canonical LogRecord model.
 *
 * Both are WRITE-ONLY and self-authenticate from an `ahlog_` ingest token
 * (`Authorization: Bearer <token>` or `X-AgentHub-Log-Token`). Identity
 * (project + source) is derived solely from the token via
 * `resolveLogSourceByToken` — never from the request body — so a caller cannot
 * spoof another project/source. These paths are in `auth.ts`
 * PUBLIC_METHOD_PATTERNS (POST-only) so the normal Hub auth middleware does not
 * gate them; the token IS the credential and grants no read/query/management
 * access.
 *
 * Limits (decision LOG-STORE): request and decompressed body ≤ 1 MiB (413
 * past that), batch ≤ 1,000 records (overflow
 * rejected and counted in partial-success), single normalized record ≤ 256 KiB
 * (dropped by the store and counted). A source-level per-minute rate limit and a
 * per-IP pre-auth guard keep one source (or an anonymous flood) from exhausting
 * the Hub. Every ingest failure returns a bounded 4xx/5xx and never blocks the
 * source application.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import express from 'express';
import { gunzipSync } from 'zlib';
import type { RouteDeps } from '../types.js';
import { resolveLogSourceByToken } from '../logs/log-sources-store.js';
import { insertLogRecords } from '../logs/logs-db.js';
import { MAX_REQUEST_BYTES } from '../logs/logs-schema.js';
import { buildRedactionConfig } from '../logs/log-redaction.js';
import {
  normalizeAhBatch,
  normalizeOtlpLogsData,
  type AhLogBatch,
  type IngestContext,
  type NormalizeResult,
} from '../logs/log-ingest.js';
import {
  decodeExportLogsServiceRequest,
  encodeExportLogsServiceResponse,
  encodeGoogleRpcStatus,
  OtlpProtobufError,
} from '../logs/otlp-protobuf.js';

// ─── Rate limiting ──────────────────────────────────────────────────
const RATE_WINDOW_MS = 60_000;
// Read at call time (not module load) so a low cap can be set via env in tests
// without re-importing the module.
function perSourceMax(): number {
  return envInt('LOG_INGEST_PER_SOURCE_MAX', 3000);
}
function perIpMax(): number {
  return envInt('LOG_INGEST_PER_IP_MAX', 6000);
}
/**
 * Cap on distinct live keys per bucket map. Expired entries are swept
 * periodically; while every bucket at the cap is still live, new keys are
 * rejected instead of evicting an active bucket and resetting its window. This
 * keeps one-shot IPs/sources from growing either map without bound.
 */
const MAX_BUCKET_KEYS = 50_000;
const SWEEP_EVERY_CHARGES = 1_024;
let chargesSinceSweep = 0;

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

interface Bucket {
  count: number;
  resetAt: number;
}
export const _sourceRateBuckets = new Map<string, Bucket>();
export const _ipRateBuckets = new Map<string, Bucket>();

/** Test hook: clear the in-memory ingest rate-limit buckets. */
export function _resetLogIngestRateLimit(): void {
  _sourceRateBuckets.clear();
  _ipRateBuckets.clear();
  chargesSinceSweep = 0;
}

/**
 * Evict expired (window-elapsed) entries. Called periodically for both maps so
 * one-shot keys disappear even when they are never charged again.
 */
function sweepBuckets(buckets: Map<string, Bucket>, now: number): void {
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) buckets.delete(key);
  }
}

/** Test hook for the same expiration sweep used by the periodic limiter path. */
export function _sweepLogIngestRateLimit(now = Date.now()): void {
  sweepBuckets(_sourceRateBuckets, now);
  sweepBuckets(_ipRateBuckets, now);
  chargesSinceSweep = 0;
}

function charge(buckets: Map<string, Bucket>, key: string, max: number, now: number): boolean {
  chargesSinceSweep += 1;
  if (chargesSinceSweep >= SWEEP_EVERY_CHARGES) {
    _sweepLogIngestRateLimit(now);
  }
  const entry = buckets.get(key);
  if (!entry || entry.resetAt <= now) {
    if (!entry && buckets.size >= MAX_BUCKET_KEYS) {
      // Never evict a still-live bucket: doing so resets that key's window and
      // briefly lets an active source/IP exceed its cap. At the extremely high
      // 50k-key ceiling, reject a new key until the periodic expiry sweep frees
      // capacity instead.
      return false;
    }
    buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count += 1;
  return true;
}

/**
 * Client IP for the per-IP flood guard. Uses `req.ip`, which Express derives
 * from the configured `trust proxy` setting (`'loopback'`, see index.ts) — the
 * last untrusted hop, NOT the caller-controlled first `X-Forwarded-For` token.
 * Hand-parsing XFF here would let an unauthenticated client spoof a fresh IP per
 * request and defeat the guard, so we defer to Express like the per-IP limiters
 * in routes/auth.ts.
 */
function ipFromReq(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

// ─── Token / body helpers ───────────────────────────────────────────

/** Pull the ingest token from `Authorization: Bearer` or the custom header. */
export function extractIngestToken(req: Request): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1]!.trim();
  }
  const h = req.headers['x-agenthub-log-token'] ?? req.headers['x-log-token'];
  const v = Array.isArray(h) ? h[0] : h;
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return null;
}

/**
 * Decode the raw body. `express.raw` (with its default `inflate: true`) already
 * inflates a `Content-Encoding: gzip` body, bounding the DECOMPRESSED size to
 * `MAX_REQUEST_BYTES` via the parser `limit`, so we sniff the bytes — NOT the
 * header — to catch the remaining case: a raw gzip-framed body (magic `1f 8b`)
 * sent with no encoding header. That path is inflated here and bounded to the
 * SAME `MAX_REQUEST_BYTES` decompressed ceiling (a decompression-bomb guard),
 * so both gzip paths share one decompressed cap. Same approach as the replay
 * ingest path (`decodeReplayBatchBody`).
 */
export function decodeIngestBody(
  raw: Buffer,
): { ok: true; buf: Buffer } | { ok: false; status: number; error: string } {
  if (!Buffer.isBuffer(raw)) {
    return { ok: false, status: 400, error: 'request body must be bytes' };
  }
  const looksGzip = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  if (looksGzip) {
    try {
      return { ok: true, buf: gunzipSync(raw, { maxOutputLength: MAX_REQUEST_BYTES }) };
    } catch (err) {
      if (isGzipSizeError(err)) {
        return { ok: false, status: 413, error: 'decompressed payload too large' };
      }
      return { ok: false, status: 400, error: 'malformed gzip payload' };
    }
  }
  return { ok: true, buf: raw };
}

/** Classify Node's stable zlib overflow code, retaining wording fallback. */
export function isGzipSizeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
  return code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|buffer/i.test(msg);
}

function contentType(req: Request): string {
  return String(req.headers['content-type'] ?? '').toLowerCase();
}

/** Choose OTLP wire format: content-type wins, else sniff the first byte. */
function otlpFormat(req: Request, buf: Buffer): 'json' | 'protobuf' {
  const ct = contentType(req);
  if (ct.includes('json')) return 'json';
  if (ct.includes('protobuf')) return 'protobuf';
  // No/unknown content type: sniff. A JSON body starts with `{` or `[`.
  const firstNonWs = buf.find((b) => b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d);
  return firstNonWs === 0x7b || firstNonWs === 0x5b ? 'json' : 'protobuf';
}

// ─── Route factory ──────────────────────────────────────────────────

export default function createLogIngestRoutes({ findProject }: RouteDeps): Router {
  const router = Router();

  // `inflate` defaults true, so a `Content-Encoding: gzip` body is inflated by
  // the parser (bounded by `limit`); a raw gzip-framed body with no header is
  // inflated in `decodeIngestBody`. `limit` caps the decoded request at 1 MiB.
  const rawBody = express.raw({ type: () => true, limit: MAX_REQUEST_BYTES });

  /**
   * Shared front of every ingest request: rate-limit (per-IP pre-auth guard,
   * then per-source), resolve the token to a (project, source) identity, and
   * decode/decompress the body. Returns the resolved context + body bytes, or
   * writes an error response and returns null.
   */
  function admit(req: Request, res: Response): { ctx: IngestContext; body: Buffer } | null {
    const now = Date.now();

    // Pre-auth per-IP guard: reject a flood BEFORE hashing a token / DB lookup.
    if (!charge(_ipRateBuckets, ipFromReq(req), perIpMax(), now)) {
      res.setHeader('Retry-After', '60');
      res.status(429).json({ error: 'rate limit exceeded' });
      return null;
    }

    const token = extractIngestToken(req);
    if (!token) {
      res.status(401).json({ error: 'missing ingest token' });
      return null;
    }
    const resolved = resolveLogSourceByToken(token);
    if (!resolved) {
      res.status(401).json({ error: 'invalid or revoked ingest token' });
      return null;
    }

    // Source-level rate limit (decision LOG-AUTH: enforce source-level limits).
    if (!charge(_sourceRateBuckets, resolved.sourceId, perSourceMax(), now)) {
      res.setHeader('Retry-After', '60');
      res.status(429).json({ error: 'source rate limit exceeded' });
      return null;
    }

    const decoded = decodeIngestBody(req.body as Buffer);
    if (!decoded.ok) {
      res.status(decoded.status).json({ error: decoded.error });
      return null;
    }

    const overrides = findProject(resolved.projectId)?.logIngest ?? null;
    const ctx: IngestContext = {
      projectId: resolved.projectId,
      sourceId: resolved.sourceId,
      defaultServiceName: resolved.serviceName,
      defaultEnvironment: resolved.environment,
      redaction: buildRedactionConfig(overrides),
      nowMs: now,
    };
    return { ctx, body: decoded.buf };
  }

  /** Persist normalized records; returns total accepted / rejected or a 503. */
  function persist(
    normalized: NormalizeResult,
    ctx: IngestContext,
    res: Response,
  ): { accepted: number; rejected: number } | null {
    try {
      const result = insertLogRecords(normalized.records, ctx.nowMs);
      return {
        accepted: result.inserted,
        rejected: normalized.rejected + result.rejectedOversize,
      };
    } catch (err) {
      // Store failure must not blow up the source app — bounded 503 backpressure.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[log-ingest] store write failed:', msg);
      res.status(503).json({ error: 'log store temporarily unavailable' });
      return null;
    }
  }

  // ─── OTLP/HTTP logs ───────────────────────────────────────────────
  router.post('/api/otel/v1/logs', rawBody, (req: Request, res: Response) => {
    const admitted = admit(req, res);
    if (!admitted) return;
    const { ctx, body } = admitted;
    const format = otlpFormat(req, body);

    let normalized: NormalizeResult;
    if (format === 'protobuf') {
      let decodedData;
      try {
        decodedData = decodeExportLogsServiceRequest(body);
      } catch (err) {
        if (err instanceof OtlpProtobufError) {
          const message = `malformed protobuf: ${err.message}`;
          return res
            .status(400)
            .type('application/x-protobuf')
            .send(encodeGoogleRpcStatus(3, message)); // INVALID_ARGUMENT
        }
        // Defensive boundary: a future decoder regression must still return a
        // bounded protobuf error rather than Express's default HTML 500.
        const detail = (err instanceof Error ? err.message : String(err)).slice(0, 500);
        console.warn('[log-ingest] unexpected protobuf decoder failure:', detail);
        return res
          .status(500)
          .type('application/x-protobuf')
          .send(encodeGoogleRpcStatus(13, 'protobuf decoder failed')); // INTERNAL
      }
      normalized = normalizeOtlpLogsData(decodedData, ctx);
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'body must be valid JSON' });
      }
      if (!parsed || typeof parsed !== 'object') {
        return res.status(400).json({ error: 'body must be a JSON object' });
      }
      const shapeError = validateOtlpJsonShape(parsed);
      if (shapeError) return res.status(400).json({ error: shapeError });
      normalized = normalizeOtlpLogsData(
        parsed as Parameters<typeof normalizeOtlpLogsData>[0],
        ctx,
      );
    }

    const outcome = persist(normalized, ctx, res);
    if (!outcome) return;

    // 200 even on partial success — the source app must not treat a rejected
    // record as a failed request (decision LOG-STORE).
    return sendOtlp(res, format, 200, {
      rejected: outcome.rejected,
      errorMessage: outcome.rejected > 0 ? `${outcome.rejected} log record(s) rejected` : undefined,
    });
  });

  // ─── Agent Hub JSON batch ─────────────────────────────────────────
  router.post('/api/logs/ingest', rawBody, (req: Request, res: Response) => {
    const admitted = admit(req, res);
    if (!admitted) return;
    const { ctx, body } = admitted;

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'body must be valid JSON' });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return res.status(400).json({ error: 'body must be a JSON object: { records: [...] }' });
    }
    const batch = parsed as AhLogBatch;
    if (!Array.isArray(batch.records)) {
      return res.status(400).json({ error: '`records` must be an array' });
    }
    if (
      batch.records.some((record) => !record || typeof record !== 'object' || Array.isArray(record))
    ) {
      return res.status(400).json({ error: '`records` entries must be objects' });
    }

    const normalized = normalizeAhBatch(batch, ctx);
    const outcome = persist(normalized, ctx, res);
    if (!outcome) return;

    return res.status(200).json({
      accepted: outcome.accepted,
      rejected: outcome.rejected,
      redactions: normalized.redactions,
    });
  });

  // Convert body-parser failures (over-limit / unsupported encoding) into a
  // bounded JSON error instead of the default HTML — a logging failure must
  // never surface an unexpected shape to the source app.
  router.use(
    '/api/otel/v1/logs',
    (
      err: Error & { type?: string; status?: number },
      _req: Request,
      res: Response,
      next: NextFunction,
    ) => handleBodyParserError(err, res, next),
  );
  router.use(
    '/api/logs/ingest',
    (
      err: Error & { type?: string; status?: number },
      _req: Request,
      res: Response,
      next: NextFunction,
    ) => handleBodyParserError(err, res, next),
  );

  return router;
}

/**
 * Validate the repeated-message containers that the OTLP normalizer traverses.
 * TypeScript types do not protect this public JSON boundary; without these
 * checks a valid-JSON body such as `{ "resourceLogs": {} }` reaches `for...of`
 * and escapes as an HTML 500. Empty/omitted arrays remain valid protobuf-default
 * values, while wrong-typed containers receive the documented JSON 400.
 */
function validateOtlpJsonShape(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'body must be a JSON object';
  }
  const root = value as Record<string, unknown>;
  if (root.resourceLogs !== undefined && !Array.isArray(root.resourceLogs)) {
    return '`resourceLogs` must be an array';
  }
  const resourceLogEntries = Array.isArray(root.resourceLogs) ? root.resourceLogs : [];
  for (const rl of resourceLogEntries) {
    if (!rl || typeof rl !== 'object' || Array.isArray(rl)) {
      return '`resourceLogs` entries must be objects';
    }
    const resourceLogs = rl as Record<string, unknown>;
    if (resourceLogs.scopeLogs !== undefined && !Array.isArray(resourceLogs.scopeLogs)) {
      return '`scopeLogs` must be an array';
    }
    const resource = resourceLogs.resource;
    if (
      resource !== undefined &&
      (!resource || typeof resource !== 'object' || Array.isArray(resource))
    ) {
      return '`resource` must be an object';
    }
    if (
      resource &&
      (resource as Record<string, unknown>).attributes !== undefined &&
      !Array.isArray((resource as Record<string, unknown>).attributes)
    ) {
      return '`resource.attributes` must be an array';
    }
    const scopeLogEntries = Array.isArray(resourceLogs.scopeLogs) ? resourceLogs.scopeLogs : [];
    for (const sl of scopeLogEntries) {
      if (!sl || typeof sl !== 'object' || Array.isArray(sl)) {
        return '`scopeLogs` entries must be objects';
      }
      const scopeLogs = sl as Record<string, unknown>;
      if (scopeLogs.logRecords !== undefined && !Array.isArray(scopeLogs.logRecords)) {
        return '`logRecords` must be an array';
      }
      const logRecordEntries = Array.isArray(scopeLogs.logRecords) ? scopeLogs.logRecords : [];
      for (const rec of logRecordEntries) {
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
          return '`logRecords` entries must be objects';
        }
        const attributes = (rec as Record<string, unknown>).attributes;
        if (attributes !== undefined && !Array.isArray(attributes)) {
          return '`logRecord.attributes` must be an array';
        }
      }
    }
  }
  return null;
}

function handleBodyParserError(
  err: Error & { type?: string; status?: number },
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    res.status(413).json({ error: 'request body exceeds size cap' });
    return;
  }
  if (err?.type === 'encoding.unsupported' || err?.status === 415) {
    res.status(415).json({ error: 'unsupported content encoding' });
    return;
  }
  next(err);
}

/** Serialize an OTLP export response in the request's wire format. */
function sendOtlp(
  res: Response,
  format: 'json' | 'protobuf',
  status: number,
  opts: { rejected: number; errorMessage?: string },
): void {
  if (format === 'protobuf') {
    const buf = encodeExportLogsServiceResponse(opts);
    res.status(status).type('application/x-protobuf').send(buf);
    return;
  }
  const partial =
    opts.rejected > 0 || opts.errorMessage
      ? {
          partialSuccess: {
            rejectedLogRecords: String(opts.rejected),
            ...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}),
          },
        }
      : {};
  res.status(status).json(partial);
}

// ─── OpenAPI registration (side-effect import) ──────────────────────
import './log-ingest.openapi.js';
