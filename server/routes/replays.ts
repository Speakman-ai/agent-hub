import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import path from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { RouteDeps } from '../types.js';

/**
 * Public, rate-limited session-replay ingest endpoint.
 *
 * Accepts a JSON body of rrweb events (the trailing rolling-buffer window that
 * the web client flushes on a bug-report submit or an uncaught error) and
 * persists it as `server/uploads/replay-<uuid>.json`. Returns the replay id and
 * the `/uploads/...` ref — the exact textual form the support-ticket
 * investigation's `resolveReplayContext` will read back and splice into the
 * triage prompt.
 *
 * Like the bug-report intake, this is intentionally unauthenticated (clients
 * may run on any origin), so it's gated by an in-memory per-IP rate limiter and
 * a hard body-size cap.
 */

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MB of rrweb JSON
const MAX_EVENTS = 20_000;
// rrweb EventType.FullSnapshot. A replay that never carries a full snapshot
// cannot be reconstructed, so we refuse it rather than store a dead ref.
const RRWEB_FULL_SNAPSHOT = 2;

// ─── Rate limit ──────────────────────────────────────────────────
export const _rateBuckets = new Map<string, { count: number; resetAt: number }>();

export function _resetRateLimit(): void {
  _rateBuckets.clear();
}

function ipFromReq(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0]!.trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function rateLimitCheck(ip: string): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const entry = _rateBuckets.get(ip);
  if (!entry || entry.resetAt <= now) {
    _rateBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { ok: true, retryAfterMs: 0 };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return { ok: false, retryAfterMs: entry.resetAt - now };
  }
  entry.count += 1;
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

/**
 * Validate a parsed replay request body. Pure (no IO) so it can be unit-tested.
 * Requires a non-empty `events` array whose entries each carry a numeric
 * rrweb `type` and `timestamp`; `meta`, when present, must be a plain object.
 */
export function validateReplayPayload(
  body: unknown,
): { ok: true; value: ValidatedReplay } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const { events, meta } = body as { events?: unknown; meta?: unknown };
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: false, error: 'events must be a non-empty array' };
  }
  if (events.length > MAX_EVENTS) {
    return { ok: false, error: `events exceeds ${MAX_EVENTS} cap` };
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
  // Enforce the minimum replayable shape: without a full snapshot the events
  // can't reconstruct the DOM, and the resulting ref is later trusted enough to
  // surface in intake prompts.
  if (!hasFullSnapshot) {
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

// ─── Route factory ───────────────────────────────────────────────

export default function createReplayRoutes(deps: RouteDeps): Router {
  const { serverDir } = deps;
  const router = Router();
  const UPLOADS_DIR = path.join(serverDir, 'uploads');
  mkdirSync(UPLOADS_DIR, { recursive: true });

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
    (req: Request, res: Response) => {
      try {
        const ip = ipFromReq(req);
        const rl = rateLimitCheck(ip);
        if (!rl.ok) {
          res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
          return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
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
        writeFileSync(dest, JSON.stringify(record));
        const replayRef = `/uploads/${filename}`;

        return res.status(201).json({ replayId, replayRef });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[Replays] Unexpected failure:', message);
        return res.status(500).json({ error: message });
      }
    },
  );

  return router;
}
