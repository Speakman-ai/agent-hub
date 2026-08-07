/**
 * Public, write-only ingest for AWS Health events delivered from EventBridge.
 *
 *   POST /api/infra/health/ingest
 *
 * The OPERATOR owns everything upstream of this endpoint: they create an
 * EventBridge rule in their own account matching `"source": ["aws.health"]`
 * and target it at an API destination pointing here, authenticated with an
 * `ahhealth_` token minted from the project's Infrastructure settings. The Hub
 * creates nothing in the monitored account — that keeps INFRA-CRED's read-only
 * posture intact and means this works on any AWS support tier, unlike the
 * Health API's `DescribeEvents` (Business Support+ only,
 * `SubscriptionRequiredException` otherwise). See
 * `docs/guides/aws-health-eventbridge.md`.
 *
 * Two properties of EventBridge shape this handler:
 *
 *   1. **5-second delivery timeout.** EventBridge times out an API-destination
 *      request that takes longer than 5s, so this route does one bounded
 *      SQLite write and answers. Nothing here calls AWS or blocks on SMTP.
 *   2. **At-least-once delivery, plus a deliberate backup-Region fan-out.**
 *      Duplicates are normal. Dedupe happens in the store's unique constraint,
 *      and the response reports `deduped` so an operator can confirm the
 *      integration is healthy rather than double-counting.
 *
 * Auth is the token alone — the request body never names a project. The route
 * is listed in `PUBLIC_METHOD_PATTERNS` (auth.ts) so the JWT middleware lets it
 * through, exactly like the `ahlog_` log ingest.
 */
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { isInfraDbInitialized } from '../infra/infra-db.js';
import { parseHealthEventBatch } from '../infra/health-event-parse.js';
import {
  markInfraHealthEventNotified,
  recordInfraHealthEvents,
} from '../infra/health-event-store.js';
import {
  buildHealthEventBroadcast,
  notifyInfraHealthEvent,
} from '../infra/health-event-notifications.js';
import { resolveInfraHealthIngestToken } from '../infra/health-ingest-token-store.js';
import { INFRA_HEALTH_INGEST_PATH } from '../infra/infra-schema.js';
import type { RouteDeps } from '../types.js';
import './infra-health-ingest.openapi.js';

/**
 * EventBridge caps a message at 256 KB. 1 MiB leaves room for a small
 * coalesced batch without letting an unauthenticated request allocate more.
 */
const MAX_REQUEST_BYTES = 1024 * 1024;

const RATE_WINDOW_MS = 60_000;

/**
 * A busy account sees a handful of Health events a day, so these ceilings are
 * generous by orders of magnitude. They exist to bound a misconfigured rule
 * (or a hostile caller probing tokens), not to shape normal traffic.
 */
function perTokenMax(): number {
  const raw = Number(process.env.INFRA_HEALTH_INGEST_PER_TOKEN_MAX);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 600;
}
function perIpMax(): number {
  const raw = Number(process.env.INFRA_HEALTH_INGEST_PER_IP_MAX);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1200;
}

interface Bucket {
  count: number;
  resetAt: number;
}
const tokenBuckets = new Map<string, Bucket>();
const ipBuckets = new Map<string, Bucket>();
/** Bounds memory if an attacker rotates the bucket key every request. */
const MAX_BUCKET_KEYS = 20_000;

function charge(buckets: Map<string, Bucket>, key: string, max: number, nowMs: number): boolean {
  const existing = buckets.get(key);
  if (existing && existing.resetAt > nowMs) {
    if (existing.count >= max) return false;
    existing.count += 1;
    return true;
  }
  if (!existing && buckets.size >= MAX_BUCKET_KEYS) {
    // Refuse a NEW key at the cap rather than evicting a live bucket — evicting
    // would let a key-rotating caller reset someone else's counter.
    return false;
  }
  buckets.set(key, { count: 1, resetAt: nowMs + RATE_WINDOW_MS });
  return true;
}

/** Test hook: clears both rate-limit maps. */
export function _resetInfraHealthIngestRateLimit(): void {
  tokenBuckets.clear();
  ipBuckets.clear();
}

/**
 * EventBridge API destinations authenticate with `API_KEY`, which sets a header
 * of the operator's choosing. `Authorization: Bearer` is the documented
 * default; the explicit header is offered because EventBridge strips a long
 * list of standard headers and operators sometimes front the endpoint with a
 * proxy that consumes `Authorization`.
 */
export function extractHealthIngestToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1]!.trim();
  }
  const header = req.headers['x-agenthub-health-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  return null;
}

export default function createInfraHealthIngestRoutes(deps: RouteDeps): Router {
  const { broadcast } = deps;
  const router = Router();
  const jsonParser = express.json({ limit: MAX_REQUEST_BYTES });

  router.post(INFRA_HEALTH_INGEST_PATH, jsonParser, (req: Request, res: Response) => {
    const nowMs = Date.now();

    // Per-IP first, before any hashing or database access, so an unauthenticated
    // flood is rejected at the cheapest possible point.
    if (!charge(ipBuckets, req.ip ?? 'unknown', perIpMax(), nowMs)) {
      res.setHeader('Retry-After', '60');
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }

    const token = extractHealthIngestToken(req);
    if (!token) {
      res.status(401).json({ error: 'missing ingest token' });
      return;
    }

    if (!isInfraDbInitialized()) {
      // 503 rather than 401: the credential may well be valid, and a retryable
      // status is what makes EventBridge redeliver instead of dropping.
      res.status(503).json({ error: 'infrastructure store is unavailable' });
      return;
    }

    const resolved = resolveInfraHealthIngestToken(token, nowMs);
    if (!resolved) {
      res.status(401).json({ error: 'invalid or revoked ingest token' });
      return;
    }

    if (!charge(tokenBuckets, resolved.projectId, perTokenMax(), nowMs)) {
      res.setHeader('Retry-After', '60');
      res.status(429).json({ error: 'project rate limit exceeded' });
      return;
    }

    const parsed = parseHealthEventBatch(req.body);
    if (parsed.events.length === 0) {
      // Nothing usable, but still 200. EventBridge does not retry a plain 4xx
      // (only 401/407/409/429 and 5xx), so a 400 would not cause a retry loop —
      // it would instead count as a failed invocation, filling the operator's
      // dead-letter queue and firing FailedInvocations alarms for deliveries
      // that are merely out of scope. A rule scoped a little too broadly is a
      // configuration nit, not an outage, and it must not look like one.
      //
      // The rejection reasons are echoed instead, so the miss is diagnosable
      // from the destination's own request logs.
      res.status(200).json({
        accepted: 0,
        deduped: 0,
        rejected: parsed.rejected.length,
        overflow: parsed.overflow,
        reasons: parsed.rejected.map((entry) => entry.reason),
      });
      return;
    }

    let result;
    try {
      result = recordInfraHealthEvents(resolved.projectId, parsed.events, nowMs);
    } catch (err) {
      console.error('[infra-health] ingest write failed:', err);
      res.status(503).json({ error: 'infrastructure store temporarily unavailable' });
      return;
    }

    // Answer EventBridge before fanning out. Delivery is best-effort from the
    // caller's point of view; the durable record is already committed, and a
    // crash between here and the fan-out is recovered from the pending sweep
    // over `notification_delivered_at_ms`.
    res.status(200).json({
      accepted: result.inserted.length,
      deduped: result.deduped,
      rejected: parsed.rejected.length,
      overflow: parsed.overflow,
    });

    for (const row of result.inserted) {
      try {
        const payload = buildHealthEventBroadcast(row);
        const notification = notifyInfraHealthEvent(row, payload);
        if (notification.broadcast && broadcast) broadcast(payload);
        if (notification.emailEnqueueFailures === 0) {
          markInfraHealthEventNotified(row.id, nowMs);
        }
      } catch (err) {
        // Leaving the row pending is the correct failure mode: the recovery
        // sweep retries it rather than the event being silently un-notified.
        console.error('[infra-health] notification fan-out failed:', err);
      }
    }
  });

  // Body-parser failures must not surface as an HTML 500 to EventBridge.
  router.use(
    INFRA_HEALTH_INGEST_PATH,
    (err: unknown, _req: Request, res: Response, next: NextFunction) => {
      const status = (err as { status?: number } | null)?.status;
      if (status === 413) {
        res.status(413).json({ error: 'request body exceeds size cap' });
        return;
      }
      if (status === 400) {
        res.status(400).json({ error: 'malformed JSON body' });
        return;
      }
      next(err);
    },
  );

  return router;
}
