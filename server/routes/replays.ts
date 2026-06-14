import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import path from 'path';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { Project, RouteDeps, SessionReplayRow } from '../types.js';
import { storeReplay, readReplayEventsPage, DEFAULT_EVENTS_PAGE } from '../replays/replay-store.js';
import { ArtifactStoreUnavailableError } from '../artifacts/artifact-store.js';
import { canViewProject, type VisibilityCaller } from '../project-visibility.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';

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
 * Like the bug-report intake, ingest is intentionally unauthenticated (clients
 * may run on any origin), so it's gated by an in-memory per-IP rate limiter and
 * a hard body-size cap. The read endpoints are NOT public — replay events can
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
            { id: replayId, events: parsed.value.events, meta: parsed.value.meta ?? null },
          );
        } catch (err) {
          rmSync(dest, { force: true });
          throw err;
        }

        return res.status(201).json({
          replayId,
          replayRef,
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
