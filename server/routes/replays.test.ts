import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import supertest from 'supertest';

// The route imports verifyRumToken from the store (which talks to the global DB,
// not the in-memory stmts these tests build). Mock it so we can both avoid the
// global DB and assert WHETHER it was called — the precheck guard must skip
// verification entirely once an IP is rate-limited. Tests that send no token
// never invoke it, so the mock is inert for them.
vi.mock('../rum-clients-store.js', () => ({ verifyRumToken: vi.fn(() => null) }));
import { verifyRumToken } from '../rum-clients-store.js';
import os from 'os';
import path from 'path';
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'fs';
import { gzipSync } from 'zlib';
import Database from 'better-sqlite3';
import createReplayRoutes, {
  _resetRateLimit,
  validateReplayPayload,
  validateEventBatch,
  decodeReplayBatchBody,
  canViewReplay,
} from './replays.js';
import {
  storeReplay,
  appendReplayEvents,
  readReplayEventsPage,
  linkReplay,
  ReplayEventCapError,
  ReplayByteCapError,
  ReplayFinalizedError,
  ReplayNeedsSnapshotError,
  ReplayAttributionMismatchError,
} from '../replays/replay-store.js';
import { appendSegment } from '../replays/segment-store.js';
import {
  resetArtifactStoreCache,
  getArtifactStoreForLocation,
} from '../artifacts/artifact-store.js';
import { DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS } from '../replays/replay-config.js';
import type { AppConfig, Project, RouteDeps, Stmts } from '../types.js';

/** Auth fields the gate reads — stamped onto the request by a test middleware. */
type AuthStamp = {
  authUserId?: string;
  authUser?: string;
  authRole?: string;
  authViaApiKey?: boolean;
  authLocalOrgBypass?: boolean;
};
function stampReq(req: express.Request, fields: AuthStamp): void {
  Object.assign(req, fields);
}

/**
 * Build the minimal slice of `stmts` the replay routes touch, backed by a real
 * in-memory SQLite DB. Mirrors the `session_replays` DDL in db.ts.
 */
function makeReplayStmts(): Stmts {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE session_replays (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      duration_ms INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 0,
      uncompressed_size INTEGER NOT NULL DEFAULT 0,
      storage_kind TEXT NOT NULL,
      storage_key TEXT NOT NULL,
      storage_bucket TEXT,
      storage_region TEXT,
      storage_layout TEXT NOT NULL DEFAULT 'monolithic',
      support_ticket_id TEXT,
      card_id TEXT,
      retained_until TEXT,
      retention_flagged_at TEXT,
      meta TEXT
    );
    CREATE TABLE rum_segments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      view_id TEXT NOT NULL,
      project_id TEXT,
      index_in_view INTEGER NOT NULL,
      has_full_snapshot INTEGER NOT NULL DEFAULT 0,
      start_ts INTEGER NOT NULL DEFAULT 0,
      end_ts INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      byte_size INTEGER NOT NULL DEFAULT 0,
      storage_kind TEXT NOT NULL,
      storage_key TEXT NOT NULL,
      storage_bucket TEXT,
      storage_region TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_rum_segments_slot
      ON rum_segments(session_id, view_id, index_in_view);
    CREATE INDEX idx_rum_segments_session
      ON rum_segments(session_id, start_ts, index_in_view);
    CREATE TABLE rum_sessions (
      session_id TEXT PRIMARY KEY,
      project_id TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      time_spent INTEGER NOT NULL DEFAULT 0,
      view_count INTEGER NOT NULL DEFAULT 0,
      action_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      frustration_count INTEGER NOT NULL DEFAULT 0,
      usr_id TEXT,
      usr_email TEXT,
      usr_name TEXT,
      usr_attributes TEXT,
      device_type TEXT,
      browser TEXT,
      os TEXT,
      geo_country TEXT,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_rum_sessions_project
      ON rum_sessions(project_id, started_at DESC);
  `);
  return {
    insertSessionReplay: db.prepare(
      `INSERT INTO session_replays
         (id, project_id, duration_ms, event_count, size, uncompressed_size,
          storage_kind, storage_key, storage_bucket, storage_region,
          support_ticket_id, card_id, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    // Test-only: seed a `segmented`-layout row to exercise the read discriminator.
    _insertSegmentedReplay: db.prepare(
      `INSERT INTO session_replays
         (id, project_id, storage_kind, storage_key, storage_layout)
       VALUES (?, ?, 'local', 'unused', 'segmented')`,
    ),
    getSessionReplay: db.prepare('SELECT * FROM session_replays WHERE id = ?'),
    insertRumSegment: db.prepare(
      `INSERT INTO rum_segments
         (id, session_id, view_id, project_id, index_in_view, has_full_snapshot,
          start_ts, end_ts, event_count, byte_size,
          storage_kind, storage_key, storage_bucket, storage_region)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getRumSegment: db.prepare('SELECT * FROM rum_segments WHERE id = ?'),
    listRumSegmentsBySession: db.prepare(
      `SELECT * FROM rum_segments
        WHERE session_id = ?
        ORDER BY start_ts ASC, index_in_view ASC, id ASC`,
    ),
    listRumSegmentsByView: db.prepare(
      `SELECT * FROM rum_segments
        WHERE session_id = ? AND view_id = ?
        ORDER BY index_in_view ASC`,
    ),
    deleteRumSegment: db.prepare('DELETE FROM rum_segments WHERE id = ?'),
    deleteRumSegmentsBySession: db.prepare('DELETE FROM rum_segments WHERE session_id = ?'),
    insertRumSession: db.prepare(
      `INSERT INTO rum_sessions
         (session_id, project_id, started_at, ended_at, time_spent,
          view_count, action_count, error_count, frustration_count,
          usr_id, usr_email, usr_name, usr_attributes,
          device_type, browser, os, geo_country)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getRumSession: db.prepare('SELECT * FROM rum_sessions WHERE session_id = ?'),
    updateRumSessionRollup: db.prepare(
      `UPDATE rum_sessions
          SET project_id = ?, started_at = ?, ended_at = ?, time_spent = ?,
              view_count = ?, action_count = ?, error_count = ?, frustration_count = ?,
              usr_id = ?, usr_email = ?, usr_name = ?, usr_attributes = ?,
              device_type = ?, browser = ?, os = ?, geo_country = ?,
              updated_at = datetime('now')
        WHERE session_id = ?`,
    ),
    listRumSessionsByProject: db.prepare(
      `SELECT * FROM rum_sessions
        WHERE project_id = ?
        ORDER BY started_at DESC, session_id DESC
        LIMIT ?`,
    ),
    deleteRumSession: db.prepare('DELETE FROM rum_sessions WHERE session_id = ?'),
    updateSessionReplayStats: db.prepare(
      `UPDATE session_replays
          SET duration_ms = ?, event_count = ?, size = ?, uncompressed_size = ?, meta = ?
        WHERE id = ?`,
    ),
    updateSessionReplayStatsForAppend: db.prepare(
      `UPDATE session_replays
          SET duration_ms = ?, event_count = ?, size = ?, uncompressed_size = ?, meta = ?,
              project_id = COALESCE(project_id, ?)
        WHERE id = ?
          AND support_ticket_id IS NULL
          AND card_id IS NULL
          AND (project_id IS NULL OR project_id = ?)`,
    ),
    linkSessionReplay: db.prepare(
      `UPDATE session_replays
          SET project_id        = COALESCE(project_id, ?),
              support_ticket_id = COALESCE(support_ticket_id, ?),
              card_id           = COALESCE(card_id, ?)
        WHERE id = ?
          AND (project_id IS NULL OR project_id = ?)`,
    ),
    deleteSessionReplay: db.prepare('DELETE FROM session_replays WHERE id = ?'),
    flagSessionReplayRetention: db.prepare(
      `UPDATE session_replays
          SET retained_until = ?, retention_flagged_at = ?
        WHERE id = ?`,
    ),
    clearSessionReplayRetention: db.prepare(
      `UPDATE session_replays
          SET retained_until = NULL, retention_flagged_at = NULL
        WHERE id = ?`,
    ),
  } as unknown as Stmts;
}

interface AppOpts {
  /** Stamp the auth context on every request. Defaults to the apiKey
   *  break-glass (localBypass → sees every replay), matching dev / Electron. */
  stampAuth?: AuthStamp;
  /** Projects `findProject` can resolve (for project-linked replay authz). */
  projects?: Project[];
}

function makeApp(opts: AppOpts = {}): {
  app: Express;
  serverDir: string;
  stmts: Stmts;
  config: AppConfig;
} {
  const serverDir = path.join(
    os.tmpdir(),
    `agent-hub-replay-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(path.join(serverDir, 'uploads'), { recursive: true });
  resetArtifactStoreCache();
  const config = { dataDir: serverDir } as unknown as AppConfig;
  const stmts = makeReplayStmts();
  const projects = opts.projects ?? [];
  const findProject = (id: string): Project | null => projects.find((p) => p.id === id) ?? null;
  const stamp: AuthStamp = opts.stampAuth ?? { authViaApiKey: true };
  const deps = { serverDir, stmts, config, findProject } as unknown as RouteDeps;
  const app = express();
  app.use((req, _res, next) => {
    stampReq(req, stamp);
    next();
  });
  app.use(createReplayRoutes(deps));
  return { app, serverDir, stmts, config };
}

const META = { type: 4, timestamp: 1000, data: {} };
const SNAPSHOT = { type: 2, timestamp: 1001, data: { node: {} } };
const INCREMENTAL = { type: 3, timestamp: 1500, data: { source: 2 } };
/** A cap high enough that the concurrency tests never trip the event ceiling. */
const MAX_TEST_CAP = 1000;

describe('validateReplayPayload', () => {
  it('accepts a well-formed events array', () => {
    const r = validateReplayPayload({ events: [META, SNAPSHOT], meta: { trigger: 'bug-report' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.events).toHaveLength(2);
      expect(r.value.meta).toEqual({ trigger: 'bug-report' });
    }
  });

  it('rejects a non-object body', () => {
    expect(validateReplayPayload(null).ok).toBe(false);
    expect(validateReplayPayload([META]).ok).toBe(false);
    expect(validateReplayPayload('x').ok).toBe(false);
  });

  it('rejects an empty events array', () => {
    const r = validateReplayPayload({ events: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/non-empty/);
  });

  it('rejects events missing numeric type/timestamp', () => {
    expect(validateReplayPayload({ events: [{ type: 'x', timestamp: 1 }] }).ok).toBe(false);
    expect(validateReplayPayload({ events: [{ type: 2 }] }).ok).toBe(false);
  });

  it('rejects events with no full snapshot (not replayable)', () => {
    const r = validateReplayPayload({ events: [META, INCREMENTAL] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/full snapshot/);
  });

  it('accepts events that include a full snapshot anywhere in the array', () => {
    expect(validateReplayPayload({ events: [INCREMENTAL, META, SNAPSHOT] }).ok).toBe(true);
  });

  it('rejects non-object meta', () => {
    expect(validateReplayPayload({ events: [SNAPSHOT], meta: [1, 2] }).ok).toBe(false);
    expect(validateReplayPayload({ events: [SNAPSHOT], meta: 'nope' }).ok).toBe(false);
  });

  it('treats missing meta as undefined', () => {
    const r = validateReplayPayload({ events: [SNAPSHOT] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.meta).toBeUndefined();
  });
});

describe('POST /api/replays', () => {
  let app: Express;
  let serverDir: string;

  beforeEach(() => {
    _resetRateLimit();
    ({ app, serverDir } = makeApp());
  });

  afterEach(() => {
    try {
      if (serverDir && existsSync(serverDir)) rmSync(serverDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  it('stores a replay and returns 201 with a /uploads/replay-*.json ref', async () => {
    const res = await supertest(app)
      .post('/api/replays')
      .send({ events: [META, SNAPSHOT, INCREMENTAL], meta: { trigger: 'bug-report' } })
      .expect(201);

    expect(typeof res.body.replayId).toBe('string');
    expect(res.body.replayRef).toMatch(/^\/uploads\/replay-[\w-]+\.json$/);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    // New durable-store stats ride along on the response.
    expect(res.body.eventCount).toBe(3);
    expect(typeof res.body.size).toBe('number');
    expect(res.body.size).toBeGreaterThan(0);
    expect(res.body.durationMs).toBe(500); // 1500 - 1000

    // The replay landed on disk as readable JSON (what resolveReplayContext reads).
    const files = readdirSync(path.join(serverDir, 'uploads'));
    expect(files).toHaveLength(1);
    const stored = JSON.parse(readFileSync(path.join(serverDir, 'uploads', files[0]!), 'utf-8'));
    expect(stored.replayId).toBe(res.body.replayId);
    expect(stored.events).toHaveLength(3);
    expect(stored.meta).toEqual({ trigger: 'bug-report' });

    // And a gzipped blob landed in the artifact store.
    const blob = path.join(serverDir, 'artifacts', 'replays', `${res.body.replayId}.json.gz`);
    expect(existsSync(blob)).toBe(true);
  });

  it('accepts a gzip-compressed body (raw gzip-framed bytes, no encoding header)', async () => {
    // Regression: a heavy page's raw rrweb JSON exceeds the body-size limit and
    // 413s. The recorder gzips it; the one-shot ingest must inflate it. A raw
    // gzip-framed body with no Content-Encoding header is sniffed by magic bytes.
    const body = gzipSync(
      Buffer.from(JSON.stringify({ events: [META, SNAPSHOT, INCREMENTAL] }), 'utf-8'),
    );
    const res = await supertest(app)
      .post('/api/replays')
      .set('Content-Type', 'application/octet-stream')
      .send(body)
      .expect(201);
    expect(res.body.eventCount).toBe(3);
    expect(res.body.replayRef).toMatch(/^\/uploads\/replay-[\w-]+\.json$/);
  });

  it('accepts a gzip body sent with a Content-Encoding: gzip header', async () => {
    const body = gzipSync(Buffer.from(JSON.stringify({ events: [META, SNAPSHOT] }), 'utf-8'));
    const res = await supertest(app)
      .post('/api/replays')
      .set('Content-Type', 'application/octet-stream')
      .set('Content-Encoding', 'gzip')
      .send(body)
      .expect(201);
    expect(res.body.eventCount).toBe(2);
  });

  it('returns 400 on an empty events array', async () => {
    const res = await supertest(app).post('/api/replays').send({ events: [] }).expect(400);
    expect(res.body.error).toMatch(/non-empty/);
  });

  it('returns 400 on malformed events', async () => {
    await supertest(app)
      .post('/api/replays')
      .send({ events: [{ foo: 'bar' }] })
      .expect(400);
  });

  it('returns 400 and stores nothing for a snapshot-less buffer', async () => {
    const res = await supertest(app)
      .post('/api/replays')
      .send({ events: [META, INCREMENTAL] })
      .expect(400);
    expect(res.body.error).toMatch(/full snapshot/);
    expect(readdirSync(path.join(serverDir, 'uploads'))).toHaveLength(0);
  });

  // Reproduce the production middleware ordering: the global `express.json`
  // parser is mounted BEFORE the replay routes (server/index.ts). It must skip
  // the replay ingest paths, or it would consume an `application/json` body
  // before `express.raw` sees it (leaving the route an empty stream) and would
  // choke on gzip bytes. This guards the index.ts REPLAY_INGEST_PATH bypass.
  describe('behind the global JSON parser (production ordering)', () => {
    // Mirrors the skip predicate in server/index.ts.
    const REPLAY_INGEST_PATH = /^\/api\/replays(?:\/[A-Za-z0-9._-]+\/events)?\/?$/;

    function makeAppWithGlobalParser() {
      const base = makeApp();
      // Rebuild the express app so the global parser sits in front of the route.
      const wrapped = express();
      const globalJsonParser = express.json({ limit: '20mb' });
      wrapped.use((req, res, next) => {
        if (req.method === 'POST' && REPLAY_INGEST_PATH.test(req.path)) return next();
        return globalJsonParser(req, res, next);
      });
      wrapped.use(base.app);
      return { ...base, app: wrapped };
    }

    it('reaches the route with a gzip octet-stream body (global parser skips it)', async () => {
      const { app: wrapped, serverDir: dir } = makeAppWithGlobalParser();
      try {
        const body = gzipSync(Buffer.from(JSON.stringify({ events: [META, SNAPSHOT] }), 'utf-8'));
        const res = await supertest(wrapped)
          .post('/api/replays')
          .set('Content-Type', 'application/octet-stream')
          .send(body)
          .expect(201);
        expect(res.body.eventCount).toBe(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('reaches the route with a plain application/json body (not eaten upstream)', async () => {
      const { app: wrapped, serverDir: dir } = makeAppWithGlobalParser();
      try {
        const res = await supertest(wrapped)
          .post('/api/replays')
          .send({ events: [META, SNAPSHOT, INCREMENTAL] })
          .expect(201);
        expect(res.body.eventCount).toBe(3);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('handles OPTIONS preflight with 204 + CORS headers', async () => {
    const res = await supertest(app).options('/api/replays').expect(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toMatch(/POST/);
    // Cross-origin embedded recorders attribute ingest via X-RUM-Token, so it
    // must be an allowed request header.
    expect(res.headers['access-control-allow-headers']).toMatch(/X-RUM-Token/i);
  });

  it('rate-limits to 30 ingests per IP per hour', async () => {
    for (let i = 0; i < 30; i++) {
      await supertest(app)
        .post('/api/replays')
        .send({ events: [SNAPSHOT] })
        .expect(201);
    }
    const res = await supertest(app)
      .post('/api/replays')
      .send({ events: [SNAPSHOT] })
      .expect(429);
    expect(res.body.error).toMatch(/rate limit/i);
    expect(res.headers['retry-after']).toBeDefined();
  });
});

describe('POST /api/replays — token verification precheck (abuse guard)', () => {
  let app: Express;
  let serverDir: string;

  beforeEach(() => {
    _resetRateLimit();
    (verifyRumToken as Mock).mockClear();
    ({ app, serverDir } = makeApp());
  });

  afterEach(() => {
    try {
      if (serverDir && existsSync(serverDir)) rmSync(serverDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  // Well-formed (passes the token regex) but unknown — exactly the shape that
  // would otherwise force a hash + indexed DB lookup on every attempt.
  const BAD_TOKEN = 'rum_wellformedbutunknown000000000000000000000000';

  it('429s a token request WITHOUT verifying once the per-IP budget is spent', async () => {
    // Spend the anonymous per-IP budget (30/hr) with token-less ingests.
    for (let i = 0; i < 30; i++) {
      await supertest(app)
        .post('/api/replays')
        .send({ events: [SNAPSHOT] })
        .expect(201);
    }
    (verifyRumToken as Mock).mockClear();

    // A token-bearing request from the same exhausted IP must be rejected by the
    // cheap precheck BEFORE verifyRumToken runs — no hash, no DB lookup.
    const res = await supertest(app)
      .post('/api/replays')
      .set('X-RUM-Token', BAD_TOKEN)
      .send({ events: [SNAPSHOT] });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(verifyRumToken).not.toHaveBeenCalled();
  });

  it('still verifies a token while the IP has budget (invalid → 401)', async () => {
    const res = await supertest(app)
      .post('/api/replays')
      .set('X-RUM-Token', BAD_TOKEN)
      .send({ events: [SNAPSHOT] });
    expect(res.status).toBe(401);
    expect(verifyRumToken).toHaveBeenCalledTimes(1);
  });
});

describe('per-tenant ingest quota (X-RUM-Token, configurable per project)', () => {
  let app: Express;
  let serverDir: string;

  const TENANT_TOKEN = 'rum_tenantwithacustomquota0000000000000000000000';
  const TENANT = { id: 'tenant-proj', replay: { ingestQuota: 2, eventsIngestQuota: 2 } };

  beforeEach(() => {
    _resetRateLimit();
    (verifyRumToken as Mock).mockReset();
    // A valid token for our low-quota tenant; anything else is unknown.
    (verifyRumToken as Mock).mockImplementation((t: string) =>
      t === TENANT_TOKEN ? { projectId: TENANT.id } : null,
    );
    ({ app, serverDir } = makeApp({ projects: [TENANT as unknown as Project] }));
  });

  afterEach(() => {
    try {
      if (serverDir && existsSync(serverDir)) rmSync(serverDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  it('rejects one-shot ingest with 429 once the per-project quota is spent', async () => {
    // The project's `replay.ingestQuota` is 2 — two token ingests succeed, the
    // third trips the per-project budget (well below the global default of 600),
    // proving the quota is read from project config rather than the constant.
    for (let i = 0; i < 2; i++) {
      await supertest(app)
        .post('/api/replays')
        .set('X-RUM-Token', TENANT_TOKEN)
        .send({ events: [SNAPSHOT] })
        .expect(201);
    }
    const res = await supertest(app)
      .post('/api/replays')
      .set('X-RUM-Token', TENANT_TOKEN)
      .send({ events: [SNAPSHOT] });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/rate limit/i);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('rejects chunked-event ingest with 429 once the per-project events quota is spent', async () => {
    // `eventsIngestQuota` is 2 — the third chunk (new id each time so the append
    // itself always succeeds) is rejected by the per-project events budget.
    for (let i = 0; i < 2; i++) {
      await supertest(app)
        .post(`/api/replays/quota-chunk-${i}00000/events`)
        .set('X-RUM-Token', TENANT_TOKEN)
        .send({ events: [META, SNAPSHOT] })
        .expect(201);
    }
    const res = await supertest(app)
      .post('/api/replays/quota-chunk-overflow/events')
      .set('X-RUM-Token', TENANT_TOKEN)
      .send({ events: [META, SNAPSHOT] });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('falls back to the global default budget for a project with no configured quota', async () => {
    // A different tenant (no replay quota) resolves to the generous global
    // default, so a handful of ingests are nowhere near the limit.
    const OTHER_TOKEN = 'rum_tenantwithnocustomquota000000000000000000000';
    (verifyRumToken as Mock).mockImplementation((t: string) =>
      t === OTHER_TOKEN ? { projectId: 'other-proj' } : null,
    );
    const other = makeApp({ projects: [{ id: 'other-proj' } as unknown as Project] });
    try {
      for (let i = 0; i < 5; i++) {
        await supertest(other.app)
          .post('/api/replays')
          .set('X-RUM-Token', OTHER_TOKEN)
          .send({ events: [SNAPSHOT] })
          .expect(201);
      }
    } finally {
      if (existsSync(other.serverDir)) rmSync(other.serverDir, { recursive: true, force: true });
    }
  });
});

describe('POST /api/replays durable-store failure cleanup', () => {
  let app: Express;
  let serverDir: string;
  let stmts: Stmts;

  beforeEach(() => {
    _resetRateLimit();
    ({ app, serverDir, stmts } = makeApp());
  });

  afterEach(() => {
    try {
      if (serverDir && existsSync(serverDir)) rmSync(serverDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  it('500s and leaves no orphaned legacy file or blob when the durable insert fails', async () => {
    // Force the durable metadata insert (the row claim, which now happens first)
    // to throw.
    (stmts as unknown as Record<string, unknown>).insertSessionReplay = {
      run() {
        throw new Error('insert boom');
      },
    };

    await supertest(app)
      .post('/api/replays')
      .send({ events: [META, SNAPSHOT, INCREMENTAL] })
      .expect(500);

    // The legacy /uploads companion was removed (no sensitive payload stranded
    // without a session_replays row).
    expect(readdirSync(path.join(serverDir, 'uploads'))).toHaveLength(0);
    // And no blob was written (row claim fails before store.put is reached).
    const blobDir = path.join(serverDir, 'artifacts', 'replays');
    expect(existsSync(blobDir) ? readdirSync(blobDir) : []).toHaveLength(0);
  });
});

describe('GET /api/replays/:id (metadata) + /events (paginated)', () => {
  let app: Express;
  let serverDir: string;
  let stmts: Stmts;

  beforeEach(() => {
    _resetRateLimit();
    ({ app, serverDir, stmts } = makeApp());
  });

  afterEach(() => {
    try {
      if (serverDir && existsSync(serverDir)) rmSync(serverDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  async function ingest(events: object[], meta?: object): Promise<string> {
    const res = await supertest(app)
      .post('/api/replays')
      .send(meta ? { events, meta } : { events })
      .expect(201);
    return res.body.replayId as string;
  }

  it('404s for an unknown replay id', async () => {
    await supertest(app).get('/api/replays/nope').expect(404);
    await supertest(app).get('/api/replays/nope/events').expect(404);
  });

  it('returns metadata with an events URL and default page size', async () => {
    const id = await ingest([META, SNAPSHOT, INCREMENTAL], { trigger: 'bug-report' });
    const res = await supertest(app).get(`/api/replays/${id}`).expect(200);
    expect(res.body.id).toBe(id);
    expect(res.body.eventCount).toBe(3);
    expect(res.body.durationMs).toBe(500);
    expect(res.body.size).toBeGreaterThan(0);
    expect(res.body.uncompressedSize).toBeGreaterThan(res.body.size);
    expect(res.body.meta).toEqual({ trigger: 'bug-report' });
    expect(res.body.eventsUrl).toBe(`/api/replays/${id}/events`);
    expect(res.body.defaultPageSize).toBe(500);
  });

  it('round-trips the stored events through the gzipped blob', async () => {
    const id = await ingest([META, SNAPSHOT, INCREMENTAL]);
    const res = await supertest(app).get(`/api/replays/${id}/events`).expect(200);
    expect(res.body.replayId).toBe(id);
    expect(res.body.total).toBe(3);
    expect(res.body.events).toHaveLength(3);
    expect(res.body.events[0]).toMatchObject({ type: META.type, timestamp: META.timestamp });
    expect(res.body.hasMore).toBe(false);
  });

  it('paginates large captures by offset/limit and reports hasMore', async () => {
    // 1 snapshot + many incremental events.
    const events: object[] = [SNAPSHOT];
    for (let i = 0; i < 50; i++) events.push({ type: 3, timestamp: 2000 + i, data: { source: 2 } });
    const id = await ingest(events);

    const first = await supertest(app)
      .get(`/api/replays/${id}/events?offset=0&limit=20`)
      .expect(200);
    expect(first.body.total).toBe(51);
    expect(first.body.events).toHaveLength(20);
    expect(first.body.offset).toBe(0);
    expect(first.body.limit).toBe(20);
    expect(first.body.hasMore).toBe(true);

    const last = await supertest(app)
      .get(`/api/replays/${id}/events?offset=40&limit=20`)
      .expect(200);
    expect(last.body.events).toHaveLength(11);
    expect(last.body.hasMore).toBe(false);
  });

  it('clamps an over-large limit to the page cap', async () => {
    const id = await ingest([META, SNAPSHOT]);
    const res = await supertest(app).get(`/api/replays/${id}/events?limit=999999`).expect(200);
    expect(res.body.limit).toBe(5000);
  });

  it('409s the monolithic events read for a segmented row (storage_layout discriminator)', async () => {
    // Seed a `segmented`-layout session_replays row: its bytes live in
    // rum_segments, so the monolithic paginated read must steer to the segments
    // API rather than gunzip the placeholder blob.
    (
      stmts as unknown as { _insertSegmentedReplay: { run: (...a: unknown[]) => void } }
    )._insertSegmentedReplay.run('seg-row', null);
    const res = await supertest(app).get('/api/replays/seg-row/events').expect(409);
    expect(res.body.error).toMatch(/segment/i);
  });
});

describe('POST /api/replays/:id/retention (extended-retention flag)', () => {
  let app: Express;
  let serverDir: string;
  let stmts: Stmts;

  // Tenant with a 6-month extension window so the flag route resolves a bounded
  // (non-default) window we can assert on.
  const TENANT = { id: 'tenant-x', replay: { extendedRetentionMonths: 6 } } as unknown as Project;

  // The retention route reads a JSON body, so mount it behind the same global
  // parser the production server uses (index.ts). The parser skips only the
  // ingest paths, so `/api/replays/:id/retention` gets parsed.
  function makeRetentionApp(projects: Project[], stampAuth?: AuthStamp) {
    const REPLAY_INGEST_PATH = /^\/api\/replays(?:\/[A-Za-z0-9._-]+\/events)?\/?$/;
    const base = makeApp({ projects, stampAuth });
    const wrapped = express();
    const globalJsonParser = express.json({ limit: '20mb' });
    wrapped.use((req, res, next) => {
      if (req.method === 'POST' && REPLAY_INGEST_PATH.test(req.path)) return next();
      return globalJsonParser(req, res, next);
    });
    wrapped.use(base.app);
    return { ...base, app: wrapped };
  }

  beforeEach(() => {
    _resetRateLimit();
    ({ app, serverDir, stmts } = makeRetentionApp([TENANT]));
  });

  afterEach(() => {
    try {
      if (serverDir && existsSync(serverDir)) rmSync(serverDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  /** Seed a project-attributed replay row directly (no bytes needed). */
  function seedRow(id: string, projectId: string | null): void {
    stmts.insertSessionReplay.run(
      id,
      projectId,
      100,
      3,
      200,
      400,
      'local',
      `k-${id}`,
      null,
      null,
      null,
      null,
      null,
    );
  }

  it('flags a capture for extended retention (clock starts now, window bounded)', async () => {
    seedRow('r-flag', 'tenant-x');
    const before = Date.now();
    const res = await supertest(app)
      .post('/api/replays/r-flag/retention')
      .send({ extend: true })
      .expect(200);

    expect(res.body.id).toBe('r-flag');
    expect(res.body.retainedUntil).toBeTruthy();
    expect(res.body.retentionFlaggedAt).toBeTruthy();
    // retained_until is in the future (a 6-month window from now).
    const retainedMs = Date.parse(`${String(res.body.retainedUntil).replace(' ', 'T')}Z`);
    expect(retainedMs).toBeGreaterThan(before);
    // ~6 months out: comfortably more than 5 months, less than 7.
    const fiveMonthsMs = 5 * 30 * 24 * 60 * 60 * 1000;
    const sevenMonthsMs = 7 * 31 * 24 * 60 * 60 * 1000;
    expect(retainedMs - before).toBeGreaterThan(fiveMonthsMs);
    expect(retainedMs - before).toBeLessThan(sevenMonthsMs);

    // Persisted on the row.
    const row = stmts.getSessionReplay.get('r-flag') as { retained_until: string | null };
    expect(row.retained_until).toBe(res.body.retainedUntil);
  });

  it('clears an extended-retention flag', async () => {
    seedRow('r-clear', 'tenant-x');
    await supertest(app).post('/api/replays/r-clear/retention').send({ extend: true }).expect(200);
    const res = await supertest(app)
      .post('/api/replays/r-clear/retention')
      .send({ extend: false })
      .expect(200);
    expect(res.body.retainedUntil).toBeNull();
    expect(res.body.retentionFlaggedAt).toBeNull();
    const row = stmts.getSessionReplay.get('r-clear') as {
      retained_until: string | null;
      retention_flagged_at: string | null;
    };
    expect(row.retained_until).toBeNull();
    expect(row.retention_flagged_at).toBeNull();
  });

  it('defaults to the 15-month ceiling when the tenant has no window configured', async () => {
    // Anonymous (project-less) capture → no tenant window → default 15 months.
    seedRow('r-default', null);
    const before = Date.now();
    const res = await supertest(app)
      .post('/api/replays/r-default/retention')
      .send({ extend: true })
      .expect(200);
    const retainedMs = Date.parse(`${String(res.body.retainedUntil).replace(' ', 'T')}Z`);
    const fourteenMonthsMs = 14 * 30 * 24 * 60 * 60 * 1000;
    expect(retainedMs - before).toBeGreaterThan(fourteenMonthsMs);
  });

  it('400s a body that is not { extend: boolean }', async () => {
    seedRow('r-bad', 'tenant-x');
    await supertest(app).post('/api/replays/r-bad/retention').send({ extend: 'yes' }).expect(400);
    await supertest(app).post('/api/replays/r-bad/retention').send({}).expect(400);
  });

  it('404s an unknown replay id', async () => {
    await supertest(app).post('/api/replays/nope/retention').send({ extend: true }).expect(404);
  });

  it('masks a project-attributed capture as 404 for a caller who cannot view it (no unauthorized write)', async () => {
    // This is a STATE-CHANGING endpoint sharing the read authz rule
    // (loadAuthorizedReplay). A non-member of the capture's private project must
    // NOT be able to flag it — unauthorized and not-found both collapse to 404 —
    // and the row must be left un-flagged.
    const project = {
      id: 'proj-private',
      visibility: 'private',
      memberUserIds: [],
    } as unknown as Project;
    const scoped = makeRetentionApp([project], { authUserId: 'outsider', authRole: 'User' });
    try {
      scoped.stmts.insertSessionReplay.run(
        'r-private',
        'proj-private',
        100,
        3,
        200,
        400,
        'local',
        'k-private',
        null,
        null,
        null,
        null,
        null,
      );
      await supertest(scoped.app)
        .post('/api/replays/r-private/retention')
        .send({ extend: true })
        .expect(404);
      // The write was rejected before any mutation — still un-flagged.
      const row = scoped.stmts.getSessionReplay.get('r-private') as {
        retained_until: string | null;
      };
      expect(row.retained_until).toBeNull();
    } finally {
      if (scoped.serverDir && existsSync(scoped.serverDir)) {
        rmSync(scoped.serverDir, { recursive: true, force: true });
      }
    }
  });
});

describe('GET /api/replays/sessions/:sessionId/segments (segmented playback)', () => {
  let app: Express;
  let serverDir: string;
  let stmts: Stmts;
  let config: AppConfig;

  beforeEach(() => {
    _resetRateLimit();
    ({ app, serverDir, stmts, config } = makeApp());
  });

  afterEach(() => {
    try {
      if (serverDir && existsSync(serverDir)) rmSync(serverDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  /** Seed a two-view session: view-A opens (snapshot) + one incremental,
   *  view-B opens (snapshot). Appended out of order to prove playback ordering. */
  async function seedTwoViewSession(sessionId: string, projectId: string | null): Promise<void> {
    const deps = { stmts, config };
    await appendSegment(deps, {
      sessionId,
      viewId: 'view-B',
      indexInView: 0,
      projectId,
      events: [{ ...SNAPSHOT, timestamp: 5000 }],
    });
    await appendSegment(deps, {
      sessionId,
      viewId: 'view-A',
      indexInView: 1,
      projectId,
      events: [{ type: 3, timestamp: 1100, data: { source: 2 } }],
    });
    await appendSegment(deps, {
      sessionId,
      viewId: 'view-A',
      indexInView: 0,
      projectId,
      events: [{ ...SNAPSHOT, timestamp: 1000 }],
    });
  }

  it('404s a session with no segments', async () => {
    await supertest(app).get('/api/replays/sessions/nope/segments').expect(404);
  });

  it('lists segments in playback order with per-view snapshot boundaries', async () => {
    await seedTwoViewSession('sess-1', null);
    const res = await supertest(app).get('/api/replays/sessions/sess-1/segments').expect(200);

    expect(res.body.sessionId).toBe('sess-1');
    expect(res.body.storageLayout).toBe('segmented');
    expect(res.body.segmentCount).toBe(3);

    // Ordered across views (view-A before view-B), sequential within a view.
    expect(
      res.body.segments.map((s: { viewId: string; indexInView: number }) => [
        s.viewId,
        s.indexInView,
      ]),
    ).toEqual([
      ['view-A', 0],
      ['view-A', 1],
      ['view-B', 0],
    ]);

    // has_full_snapshot boundaries: only each view's opening segment.
    expect(res.body.segments.map((s: { hasFullSnapshot: boolean }) => s.hasFullSnapshot)).toEqual([
      true,
      false,
      true,
    ]);

    // Every entry advertises its per-segment events URL.
    for (const s of res.body.segments) {
      expect(s.eventsUrl).toBe(`/api/replays/sessions/sess-1/segments/${s.segmentId}/events`);
    }
  });

  it('streams one segment’s decoded events for client-side concat', async () => {
    await seedTwoViewSession('sess-2', null);
    const manifest = await supertest(app).get('/api/replays/sessions/sess-2/segments').expect(200);
    const opener = manifest.body.segments[0];

    const res = await supertest(app).get(opener.eventsUrl).expect(200);
    expect(res.body.sessionId).toBe('sess-2');
    expect(res.body.segmentId).toBe(opener.segmentId);
    expect(res.body.viewId).toBe('view-A');
    expect(res.body.hasFullSnapshot).toBe(true);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({ type: 2, timestamp: 1000 });
  });

  it('404s a segment id that belongs to a different session', async () => {
    await seedTwoViewSession('sess-3', null);
    const manifest = await supertest(app).get('/api/replays/sessions/sess-3/segments').expect(200);
    const segId = manifest.body.segments[0].segmentId;
    // Real segment id, wrong session in the path → 404 (no cross-session read).
    await supertest(app).get(`/api/replays/sessions/other/segments/${segId}/events`).expect(404);
  });

  it('masks a project-attributed session as 404 for a caller who cannot view it', async () => {
    // A non-privileged user who is not a member of the segments' project must not
    // read the capture — masked as 404, same as the monolithic replay read.
    const project = {
      id: 'proj-x',
      visibility: 'private',
      memberUserIds: [],
    } as unknown as Project;
    const scoped = makeApp({
      projects: [project],
      stampAuth: { authUserId: 'outsider', authRole: 'User' },
    });
    try {
      await appendSegment(
        { stmts: scoped.stmts, config: scoped.config },
        {
          sessionId: 'sess-priv',
          viewId: 'v',
          indexInView: 0,
          projectId: 'proj-x',
          events: [{ ...SNAPSHOT, timestamp: 1000 }],
        },
      );
      await supertest(scoped.app).get('/api/replays/sessions/sess-priv/segments').expect(404);
    } finally {
      try {
        if (existsSync(scoped.serverDir))
          rmSync(scoped.serverDir, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
  });
});

describe('validateEventBatch', () => {
  it('requires a full snapshot on the first chunk', () => {
    expect(validateEventBatch({ events: [META, INCREMENTAL] }, true).ok).toBe(false);
    expect(validateEventBatch({ events: [META, SNAPSHOT] }, true).ok).toBe(true);
  });

  it('does NOT require a snapshot on later chunks', () => {
    const r = validateEventBatch({ events: [INCREMENTAL] }, false);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.events).toHaveLength(1);
  });

  it('still rejects an empty array and malformed events on any chunk', () => {
    expect(validateEventBatch({ events: [] }, false).ok).toBe(false);
    expect(validateEventBatch({ events: [{ type: 'x', timestamp: 1 }] }, false).ok).toBe(false);
  });
});

describe('decodeReplayBatchBody', () => {
  it('parses a plain JSON buffer', () => {
    const buf = Buffer.from(JSON.stringify({ events: [SNAPSHOT] }), 'utf-8');
    const r = decodeReplayBatchBody(buf);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value as { events: unknown[] }).events).toHaveLength(1);
  });

  it('gunzips a gzip-framed buffer (magic-byte sniff)', () => {
    const buf = gzipSync(Buffer.from(JSON.stringify({ events: [SNAPSHOT] }), 'utf-8'));
    const r = decodeReplayBatchBody(buf);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value as { events: unknown[] }).events).toHaveLength(1);
  });

  it('400s an empty body', () => {
    const r = decodeReplayBatchBody(Buffer.alloc(0));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('400s a non-JSON body', () => {
    const r = decodeReplayBatchBody(Buffer.from('not json', 'utf-8'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });
});

describe('POST /api/replays/:id/events (chunked append)', () => {
  let app: Express;
  let serverDir: string;
  let stmts: Stmts;
  let config: AppConfig;

  beforeEach(() => {
    _resetRateLimit();
    // Restore the inert default (anonymous): a token test overrides this.
    (verifyRumToken as Mock).mockReset();
    (verifyRumToken as Mock).mockReturnValue(null);
    ({ app, serverDir, stmts, config } = makeApp());
  });

  afterEach(() => {
    try {
      if (serverDir && existsSync(serverDir)) rmSync(serverDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  const ID = 'replay-stream-0001';

  it('creates the replay on the first chunk (201) and appends on the next (200)', async () => {
    const first = await supertest(app)
      .post(`/api/replays/${ID}/events`)
      .send({ events: [META, SNAPSHOT], meta: { trigger: 'error' } })
      .expect(201);
    expect(first.body.replayId).toBe(ID);
    expect(first.body.created).toBe(true);
    expect(first.body.eventCount).toBe(2);
    expect(first.headers['access-control-allow-origin']).toBe('*');

    const second = await supertest(app)
      .post(`/api/replays/${ID}/events`)
      .send({ events: [INCREMENTAL] })
      .expect(200);
    expect(second.body.created).toBe(false);
    expect(second.body.eventCount).toBe(3);

    // The accumulated events round-trip through the read API in order.
    const page = await supertest(app).get(`/api/replays/${ID}/events`).expect(200);
    expect(page.body.total).toBe(3);
    expect(page.body.events.map((e: { type: number }) => e.type)).toEqual([4, 2, 3]);
    // First-chunk meta is preserved across appends.
    const meta = await supertest(app).get(`/api/replays/${ID}`).expect(200);
    expect(meta.body.meta).toEqual({ trigger: 'error' });
  });

  it('rejects a first chunk with no full snapshot (400, stores nothing)', async () => {
    const res = await supertest(app)
      .post(`/api/replays/${ID}/events`)
      .send({ events: [META, INCREMENTAL] })
      .expect(400);
    expect(res.body.error).toMatch(/full snapshot/);
    expect(stmts.getSessionReplay.get(ID)).toBeUndefined();
  });

  it('accepts a gzip-compressed batch body', async () => {
    const body = gzipSync(Buffer.from(JSON.stringify({ events: [META, SNAPSHOT] }), 'utf-8'));
    const res = await supertest(app)
      .post(`/api/replays/${ID}/events`)
      .set('Content-Type', 'application/octet-stream')
      .set('Content-Encoding', 'gzip')
      .send(body)
      .expect(201);
    expect(res.body.eventCount).toBe(2);
  });

  it('rejects an invalid replay id (400)', async () => {
    await supertest(app)
      .post('/api/replays/short/events')
      .send({ events: [SNAPSHOT] })
      .expect(400);
    await supertest(app)
      .post('/api/replays/has spaces and stuff/events')
      .send({ events: [SNAPSHOT] })
      .expect(400);
  });

  it('409s a triage-finalized (ticket-linked) replay', async () => {
    await supertest(app)
      .post(`/api/replays/${ID}/events`)
      .send({ events: [META, SNAPSHOT] })
      .expect(201);
    // Triage-link it to a support ticket (what support-ticket / convert flows do).
    // This freezes the capture against further chunks (anti-tamper).
    stmts.linkSessionReplay.run('proj-1', 'ticket-1', null, ID, 'proj-1');
    const res = await supertest(app)
      .post(`/api/replays/${ID}/events`)
      .send({ events: [INCREMENTAL] })
      .expect(409);
    expect(res.body.error).toMatch(/finalized/);
  });

  it('attributes the capture to a project from a valid X-RUM-Token (no longer orphaned)', async () => {
    // The regression: before this fix the chunked path ignored the token, so
    // every recorder-streamed capture landed unattributed (project_id IS NULL).
    (verifyRumToken as Mock).mockReturnValue({
      clientId: 'c1',
      projectId: 'proj-1',
      name: 'web',
    });

    const first = await supertest(app)
      .post(`/api/replays/${ID}/events`)
      .set('X-RUM-Token', 'rum_validtoken00000000000000000000000000000000')
      .send({ events: [META, SNAPSHOT] })
      .expect(201);
    expect(first.body.created).toBe(true);
    expect(first.body.projectId).toBe('proj-1');
    expect((stmts.getSessionReplay.get(ID) as { project_id: string | null }).project_id).toBe(
      'proj-1',
    );

    // A later chunk carrying the SAME token keeps appending — a project
    // attribution must NOT freeze the still-streaming capture (that was the
    // subtle break: project_id used to count as "finalized").
    const second = await supertest(app)
      .post(`/api/replays/${ID}/events`)
      .set('X-RUM-Token', 'rum_validtoken00000000000000000000000000000000')
      .send({ events: [INCREMENTAL] })
      .expect(200);
    expect(second.body.created).toBe(false);
    expect(second.body.eventCount).toBe(3);
    expect(second.body.projectId).toBe('proj-1');
  });

  it('401s a chunk bearing an invalid X-RUM-Token (before any body work)', async () => {
    (verifyRumToken as Mock).mockReturnValue(null);
    const res = await supertest(app)
      .post(`/api/replays/${ID}/events`)
      .set('X-RUM-Token', 'rum_bogus00000000000000000000000000000000000000')
      .send({ events: [META, SNAPSHOT] })
      .expect(401);
    expect(res.body.error).toMatch(/Invalid RUM token/);
    // Nothing was created.
    expect(stmts.getSessionReplay.get(ID)).toBeUndefined();
  });

  it('403s an anonymous chunk into a project-attributed capture (attribution mismatch)', async () => {
    (verifyRumToken as Mock).mockReturnValue({
      clientId: 'c1',
      projectId: 'proj-1',
      name: 'web',
    });
    await supertest(app)
      .post(`/api/replays/${ID}/events`)
      .set('X-RUM-Token', 'rum_validtoken00000000000000000000000000000000')
      .send({ events: [META, SNAPSHOT] })
      .expect(201);

    // Same replay id, but now anonymous (no token) — a stranger who learned the
    // id can't inject events into the attributed capture.
    const res = await supertest(app)
      .post(`/api/replays/${ID}/events`)
      .send({ events: [INCREMENTAL] })
      .expect(403);
    expect(res.body.error).toMatch(/different project/);
    // The injected event was not stored.
    expect((stmts.getSessionReplay.get(ID) as { event_count: number }).event_count).toBe(2);
  });

  it('keeps an anonymous (token-less) stream working and unattributed', async () => {
    // Backward compatibility with the current recorder, which sends no token.
    await supertest(app)
      .post(`/api/replays/${ID}/events`)
      .send({ events: [META, SNAPSHOT] })
      .expect(201);
    await supertest(app)
      .post(`/api/replays/${ID}/events`)
      .send({ events: [INCREMENTAL] })
      .expect(200);
    const row = stmts.getSessionReplay.get(ID) as {
      project_id: string | null;
      event_count: number;
    };
    expect(row.project_id).toBeNull();
    expect(row.event_count).toBe(3);
  });

  it('handles OPTIONS preflight with 204 + CORS headers', async () => {
    const res = await supertest(app).options(`/api/replays/${ID}/events`).expect(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toMatch(/POST/);
    // Chunked ingest must accept the X-RUM-Token attribution header cross-origin.
    expect(res.headers['access-control-allow-headers']).toMatch(/X-RUM-Token/i);
  });

  it('uses a separate rate-limit budget from one-shot ingest', async () => {
    // Exhaust the one-shot /api/replays budget (30/hr).
    for (let i = 0; i < 30; i++) {
      await supertest(app)
        .post('/api/replays')
        .send({ events: [SNAPSHOT] })
        .expect(201);
    }
    await supertest(app)
      .post('/api/replays')
      .send({ events: [SNAPSHOT] })
      .expect(429);
    // The chunked-append endpoint is on its own bucket, so it still serves.
    await supertest(app)
      .post(`/api/replays/${ID}/events`)
      .send({ events: [META, SNAPSHOT] })
      .expect(201);
  });

  it('appendReplayEvents enforces the total-event cap (413 mapping source)', async () => {
    const row = await storeReplay({ stmts, config }, { id: ID, events: [META, SNAPSHOT] });
    expect(row.event_count).toBe(2);
    await expect(
      appendReplayEvents(
        { stmts, config },
        { id: ID, events: [INCREMENTAL, INCREMENTAL] },
        { totalEventCap: 3 },
      ),
    ).rejects.toBeInstanceOf(ReplayEventCapError);
    // The capped append left the stored row untouched.
    const after = stmts.getSessionReplay.get(ID) as { event_count: number };
    expect(after.event_count).toBe(2);
  });

  it('enforces the uncompressed-byte cap from row stats BEFORE the blob decode', async () => {
    const row = await storeReplay({ stmts, config }, { id: ID, events: [META, SNAPSHOT] });
    expect(row.uncompressed_size).toBeGreaterThan(0);
    // Delete the stored blob. If the append fetched/decoded it before the cap
    // check (the old, O(blob) order that froze prod on 200 MB captures), this
    // would surface a storage error — getting ReplayByteCapError proves the
    // reject cost no blob work at all.
    rmSync(path.join(serverDir, 'artifacts', 'replays', `${ID}.json.gz`));
    await expect(
      appendReplayEvents(
        { stmts, config },
        { id: ID, events: [INCREMENTAL] },
        { totalEventCap: MAX_TEST_CAP, totalUncompressedByteCap: row.uncompressed_size },
      ),
    ).rejects.toBeInstanceOf(ReplayByteCapError);
  });

  it('prechecks the event cap from row stats BEFORE the blob decode', async () => {
    await storeReplay({ stmts, config }, { id: ID, events: [META, SNAPSHOT] });
    // Same blob-deletion trick: an over-cap append must reject on the row's
    // stamped event_count without paying the decode.
    rmSync(path.join(serverDir, 'artifacts', 'replays', `${ID}.json.gz`));
    await expect(
      appendReplayEvents(
        { stmts, config },
        { id: ID, events: [INCREMENTAL, INCREMENTAL] },
        { totalEventCap: 3 },
      ),
    ).rejects.toBeInstanceOf(ReplayEventCapError);
  });

  it('413s an append once the capture reaches the uncompressed-byte cap (rotation signal)', async () => {
    await supertest(app)
      .post(`/api/replays/${ID}/events`)
      .send({ events: [META, SNAPSHOT] })
      .expect(201);
    const row = stmts.getSessionReplay.get(ID) as {
      duration_ms: number;
      event_count: number;
      size: number;
      meta: string | null;
    };
    // Stamp the row as if the capture had grown past the route's byte ceiling
    // (10 MB default) — the next append must 413 without touching the blob.
    stmts.updateSessionReplayStats.run(
      row.duration_ms,
      row.event_count,
      row.size,
      11 * 1024 * 1024,
      row.meta,
      ID,
    );
    const res = await supertest(app)
      .post(`/api/replays/${ID}/events`)
      .send({ events: [INCREMENTAL] })
      .expect(413);
    expect(res.body.error).toMatch(/uncompressed bytes/);
  });

  it('serializes concurrent appends to the same id without dropping a chunk', async () => {
    await storeReplay({ stmts, config }, { id: ID, events: [META, SNAPSHOT] });
    // Fire many overlapping appends at the SAME id. The read-modify-write would
    // lose chunks under a naive last-write-wins overwrite; the per-id lock makes
    // every batch land. Each batch carries a uniquely-timestamped event so we can
    // assert none were clobbered.
    const N = 8;
    const batches = Array.from({ length: N }, (_, i) => ({
      type: 3,
      timestamp: 5000 + i,
      data: {},
    }));
    const results = await Promise.all(
      batches.map((e) =>
        appendReplayEvents(
          { stmts, config },
          { id: ID, events: [e] },
          { totalEventCap: MAX_TEST_CAP },
        ),
      ),
    );
    // None reported `created` (the row already existed) and the final count is exact.
    expect(results.every((r) => r.created === false)).toBe(true);
    const row = stmts.getSessionReplay.get(ID) as { event_count: number };
    expect(row.event_count).toBe(2 + N);

    // And the stored blob actually holds every distinct event (no lost write).
    const page = await readReplayEventsPage({ stmts, config }, row as never);
    const seen = new Set(page.events.filter((e) => e.type === 3).map((e) => e.timestamp));
    for (let i = 0; i < N; i++) expect(seen.has(5000 + i)).toBe(true);
  });

  it('serializes concurrent first chunks into one replay (no duplicate-insert error)', async () => {
    // Two "first" batches racing on a fresh id: one creates, the other appends.
    const [a, b] = await Promise.all([
      appendReplayEvents(
        { stmts, config },
        { id: ID, events: [META, SNAPSHOT] },
        { totalEventCap: MAX_TEST_CAP },
      ),
      appendReplayEvents(
        { stmts, config },
        { id: ID, events: [SNAPSHOT, INCREMENTAL] },
        { totalEventCap: MAX_TEST_CAP },
      ),
    ]);
    // Exactly one created the row; the other appended.
    expect([a.created, b.created].sort()).toEqual([false, true]);
    const row = stmts.getSessionReplay.get(ID) as { event_count: number };
    expect(row.event_count).toBe(4);
  });

  it('enforces the finalized guard INSIDE the lock (triage-linked → rejectIfFinalized)', async () => {
    await storeReplay({ stmts, config }, { id: ID, events: [META, SNAPSHOT] });
    // Triage-link to a support ticket — the anti-tamper freeze. A bare project
    // attribution does NOT finalize (see the attribution-mismatch test below).
    stmts.linkSessionReplay.run('proj-1', 'ticket-1', null, ID, 'proj-1');
    await expect(
      appendReplayEvents(
        { stmts, config },
        { id: ID, events: [INCREMENTAL] },
        { totalEventCap: MAX_TEST_CAP, rejectIfFinalized: true },
      ),
    ).rejects.toBeInstanceOf(ReplayFinalizedError);
    // Nothing appended.
    const row = stmts.getSessionReplay.get(ID) as { event_count: number };
    expect(row.event_count).toBe(2);
  });

  it('attributes the creating chunk to its project and lets same-project chunks continue', async () => {
    const first = await appendReplayEvents(
      { stmts, config },
      { id: ID, events: [META, SNAPSHOT], projectId: 'proj-1' },
      { totalEventCap: MAX_TEST_CAP, rejectIfFinalized: true, requireSnapshotOnFirstChunk: true },
    );
    expect(first.created).toBe(true);
    expect(first.row.project_id).toBe('proj-1');

    // A bare project attribution must NOT freeze the still-streaming capture.
    const second = await appendReplayEvents(
      { stmts, config },
      { id: ID, events: [INCREMENTAL], projectId: 'proj-1' },
      { totalEventCap: MAX_TEST_CAP, rejectIfFinalized: true },
    );
    expect(second.created).toBe(false);
    expect(second.row.event_count).toBe(3);
    expect(second.row.project_id).toBe('proj-1');
  });

  it('rejects a chunk whose project disagrees with the attributed capture (mismatch)', async () => {
    await appendReplayEvents(
      { stmts, config },
      { id: ID, events: [META, SNAPSHOT], projectId: 'proj-1' },
      { totalEventCap: MAX_TEST_CAP, rejectIfFinalized: true, requireSnapshotOnFirstChunk: true },
    );
    // Anonymous chunk into an attributed capture.
    await expect(
      appendReplayEvents(
        { stmts, config },
        { id: ID, events: [INCREMENTAL] },
        { totalEventCap: MAX_TEST_CAP, rejectIfFinalized: true },
      ),
    ).rejects.toBeInstanceOf(ReplayAttributionMismatchError);
    // Foreign-token chunk into the capture.
    await expect(
      appendReplayEvents(
        { stmts, config },
        { id: ID, events: [INCREMENTAL], projectId: 'proj-2' },
        { totalEventCap: MAX_TEST_CAP, rejectIfFinalized: true },
      ),
    ).rejects.toBeInstanceOf(ReplayAttributionMismatchError);
    // Neither rejected chunk was stored.
    expect((stmts.getSessionReplay.get(ID) as { event_count: number }).event_count).toBe(2);
  });

  it('backfills project_id when a token-bearing chunk lands on an anonymous-created row', async () => {
    // First chunk anonymous (e.g. raced ahead of the token, or a pre-token row).
    const first = await appendReplayEvents(
      { stmts, config },
      { id: ID, events: [META, SNAPSHOT] },
      { totalEventCap: MAX_TEST_CAP, rejectIfFinalized: true, requireSnapshotOnFirstChunk: true },
    );
    expect(first.row.project_id).toBeNull();

    const second = await appendReplayEvents(
      { stmts, config },
      { id: ID, events: [INCREMENTAL], projectId: 'proj-1' },
      { totalEventCap: MAX_TEST_CAP, rejectIfFinalized: true },
    );
    expect(second.row.project_id).toBe('proj-1');
    expect(second.row.event_count).toBe(3);
  });

  it('enforces the first-chunk snapshot requirement INSIDE the lock', async () => {
    await expect(
      appendReplayEvents(
        { stmts, config },
        { id: ID, events: [INCREMENTAL] },
        { totalEventCap: MAX_TEST_CAP, requireSnapshotOnFirstChunk: true },
      ),
    ).rejects.toBeInstanceOf(ReplayNeedsSnapshotError);
    expect(stmts.getSessionReplay.get(ID)).toBeUndefined();
  });

  it('maps a raced re-attribution to a different project to a mismatch (CAS backstop, 403)', async () => {
    // The append lock does NOT cover linkSessionReplay. A concurrent writer
    // attributes the row to proj-1 DURING this proj-2 chunk's blob read — after
    // the under-lock pre-read passed (row still unattributed), before the guarded
    // restamp. The CAS matches zero rows; the re-read must classify this as an
    // ATTRIBUTION MISMATCH (-> 403), not collapse it to a finalize (-> 409). This
    // is the concurrency backstop — the only place a mismatch can surface that the
    // deterministic pre-read never saw.
    const created = await storeReplay({ stmts, config }, { id: ID, events: [META, SNAPSHOT] });
    const store = getArtifactStoreForLocation(created as never, config);
    const origGetBuffer = store.getBuffer.bind(store);
    let injected = false;
    (store as { getBuffer: (k: string) => Promise<Buffer> }).getBuffer = async (k: string) => {
      const buf = await origGetBuffer(k);
      if (!injected) {
        injected = true;
        // Project-only link (NO ticket) → not triage-finalized, just re-attributed.
        stmts.linkSessionReplay.run('proj-1', null, null, ID, 'proj-1');
      }
      return buf;
    };
    try {
      await expect(
        appendReplayEvents(
          { stmts, config },
          { id: ID, events: [INCREMENTAL], projectId: 'proj-2' },
          { totalEventCap: MAX_TEST_CAP, rejectIfFinalized: true },
        ),
      ).rejects.toBeInstanceOf(ReplayAttributionMismatchError);
    } finally {
      (store as { getBuffer: unknown }).getBuffer = origGetBuffer;
    }
    // Nothing appended; the racer's attribution stands and the blob is untouched.
    const row = stmts.getSessionReplay.get(ID) as {
      event_count: number;
      project_id: string | null;
    };
    expect(row.event_count).toBe(2);
    expect(row.project_id).toBe('proj-1');
    const page = await readReplayEventsPage({ stmts, config }, row as never);
    expect(page.total).toBe(2);
  });

  it('maps a raced triage link (ticket) mid-write to a finalize (CAS backstop, 409)', async () => {
    // Same race, but the concurrent writer TRIAGE-links the row (ticket). The
    // re-read sees a finalized capture → ReplayFinalizedError (409), the
    // anti-tamper path — distinct from the attribution mismatch above even though
    // both surface as a zero-row CAS. The chunk here carries the row's own project
    // (proj-1), so finalize is the ONLY reason for rejection.
    const created = await storeReplay({ stmts, config }, { id: ID, events: [META, SNAPSHOT] });
    const store = getArtifactStoreForLocation(created as never, config);
    const origGetBuffer = store.getBuffer.bind(store);
    let injected = false;
    (store as { getBuffer: (k: string) => Promise<Buffer> }).getBuffer = async (k: string) => {
      const buf = await origGetBuffer(k);
      if (!injected) {
        injected = true;
        stmts.linkSessionReplay.run('proj-1', 'ticket-1', null, ID, 'proj-1');
      }
      return buf;
    };
    try {
      await expect(
        appendReplayEvents(
          { stmts, config },
          { id: ID, events: [INCREMENTAL], projectId: 'proj-1' },
          { totalEventCap: MAX_TEST_CAP, rejectIfFinalized: true },
        ),
      ).rejects.toBeInstanceOf(ReplayFinalizedError);
    } finally {
      (store as { getBuffer: unknown }).getBuffer = origGetBuffer;
    }
    // Stats stayed at the pre-append value and the blob was never overwritten.
    const row = stmts.getSessionReplay.get(ID) as { event_count: number };
    expect(row.event_count).toBe(2);
    const page = await readReplayEventsPage({ stmts, config }, row as never);
    expect(page.total).toBe(2);
  });

  it('a concurrent link cannot interleave with an in-flight append (lock-coordinated)', async () => {
    // The real fix for the finalize race: linkReplay now takes the SAME per-id
    // lock as the append. Kick off an attribution link DURING the append's blob
    // read; because it's queued behind the append on the lock, it cannot finalize
    // the row mid-write — the append commits its chunk first, THEN the link lands.
    const created = await storeReplay({ stmts, config }, { id: ID, events: [META, SNAPSHOT] });
    const store = getArtifactStoreForLocation(created as never, config);
    const origGetBuffer = store.getBuffer.bind(store);
    let linkPromise: Promise<unknown> | null = null;
    (store as { getBuffer: (k: string) => Promise<Buffer> }).getBuffer = async (k: string) => {
      const buf = await origGetBuffer(k);
      // Triage-link (project + ticket): the ticket is what freezes the capture,
      // so a post-link chunk is rejected by the anti-tamper guard below.
      linkPromise ??= linkReplay(stmts, `/uploads/replay-${ID}.json`, {
        projectId: 'proj-1',
        supportTicketId: 'ticket-1',
      });
      return buf;
    };
    let appendResult;
    try {
      // The append must SUCCEED (not throw) — proof the link did not finalize the
      // row before the append's guarded restamp ran.
      appendResult = await appendReplayEvents(
        { stmts, config },
        { id: ID, events: [INCREMENTAL] },
        { totalEventCap: MAX_TEST_CAP, rejectIfFinalized: true },
      );
    } finally {
      (store as { getBuffer: unknown }).getBuffer = origGetBuffer;
    }
    expect(appendResult.created).toBe(false);
    expect(appendResult.row.event_count).toBe(3);

    // Now let the queued link settle: the replay ends finalized with the chunk
    // still present (the in-flight append won, the link waited).
    await linkPromise;
    const row = stmts.getSessionReplay.get(ID) as {
      event_count: number;
      project_id: string | null;
    };
    expect(row.event_count).toBe(3);
    expect(row.project_id).toBe('proj-1');

    // A chunk arriving AFTER attribution is rejected — the anti-tamper contract.
    await expect(
      appendReplayEvents(
        { stmts, config },
        { id: ID, events: [INCREMENTAL] },
        { totalEventCap: MAX_TEST_CAP, rejectIfFinalized: true },
      ),
    ).rejects.toBeInstanceOf(ReplayFinalizedError);
  });

  it('the guarded restamp (updateSessionReplayStatsForAppend) enforces triage + attribution', async () => {
    await storeReplay({ stmts, config }, { id: ID, events: [META, SNAPSHOT] });
    // Unattributed + anonymous chunk (backfill=null, guard=null) → matches.
    expect(
      stmts.updateSessionReplayStatsForAppend.run(9, 9, 9, 9, null, null, ID, null).changes,
    ).toBe(1);
    expect((stmts.getSessionReplay.get(ID) as { project_id: string | null }).project_id).toBeNull();

    // A token-bearing chunk backfills project_id on the still-anonymous row.
    expect(
      stmts.updateSessionReplayStatsForAppend.run(9, 9, 9, 9, null, 'proj-1', ID, 'proj-1').changes,
    ).toBe(1);
    expect((stmts.getSessionReplay.get(ID) as { project_id: string | null }).project_id).toBe(
      'proj-1',
    );

    // Same project still matches; an anonymous or foreign chunk no longer does.
    expect(
      stmts.updateSessionReplayStatsForAppend.run(9, 9, 9, 9, null, 'proj-1', ID, 'proj-1').changes,
    ).toBe(1);
    expect(
      stmts.updateSessionReplayStatsForAppend.run(9, 9, 9, 9, null, null, ID, null).changes,
    ).toBe(0);
    expect(
      stmts.updateSessionReplayStatsForAppend.run(9, 9, 9, 9, null, 'proj-2', ID, 'proj-2').changes,
    ).toBe(0);

    // Triage-finalize (ticket): even the owning project can no longer restamp.
    stmts.linkSessionReplay.run('proj-1', 'ticket-1', null, ID, 'proj-1');
    expect(
      stmts.updateSessionReplayStatsForAppend.run(7, 7, 7, 7, null, 'proj-1', ID, 'proj-1').changes,
    ).toBe(0);
  });

  it('does NOT reject a snapshot-less chunk that races behind the creating chunk', async () => {
    // The TOCTOU fix: the second batch carries no snapshot. Decided on a stale
    // pre-lock read it would be a "first chunk" and rejected; decided under the
    // lock it is correctly an append to the row the first batch just created.
    const [a, b] = await Promise.all([
      appendReplayEvents(
        { stmts, config },
        { id: ID, events: [META, SNAPSHOT] },
        { totalEventCap: MAX_TEST_CAP, requireSnapshotOnFirstChunk: true },
      ),
      appendReplayEvents(
        { stmts, config },
        { id: ID, events: [INCREMENTAL] },
        { totalEventCap: MAX_TEST_CAP, requireSnapshotOnFirstChunk: true },
      ),
    ]);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    const row = stmts.getSessionReplay.get(ID) as { event_count: number };
    expect(row.event_count).toBe(3);
  });
});

describe('canViewReplay (pure authorization)', () => {
  const shared = { id: 'p1', visibility: 'shared', ownerUserId: null } as unknown as Project;
  const priv = { id: 'p2', visibility: 'private', ownerUserId: 'u1' } as unknown as Project;

  it('allows any caller to read a replay linked to a shared project', () => {
    expect(canViewReplay({ project_id: 'p1' }, { userId: 'anyone' }, shared)).toBe(true);
  });

  it('restricts a private-project replay to its owner', () => {
    expect(canViewReplay({ project_id: 'p2' }, { userId: 'u1' }, priv)).toBe(true);
    expect(canViewReplay({ project_id: 'p2' }, { userId: 'u2' }, priv)).toBe(false);
    // Org Owner does NOT get a read bypass into a private project they don't own.
    expect(canViewReplay({ project_id: 'p2' }, { userId: 'u2', role: 'Owner' }, priv)).toBe(false);
  });

  it('denies when the linked project no longer resolves (dangling ref)', () => {
    expect(canViewReplay({ project_id: 'gone' }, { userId: 'u1', role: 'Owner' }, null)).toBe(
      false,
    );
  });

  it('restricts an unattributed replay to privileged callers only', () => {
    expect(canViewReplay({ project_id: null }, { userId: 'u1' }, null)).toBe(false);
    expect(canViewReplay({ project_id: null }, { userId: 'u1', role: 'User' }, null)).toBe(false);
    expect(canViewReplay({ project_id: null }, { userId: 'u1', role: 'Owner' }, null)).toBe(true);
    expect(canViewReplay({ project_id: null }, { userId: null, localBypass: true }, null)).toBe(
      true,
    );
  });
});

describe('GET /api/replays/:id authorization (route)', () => {
  let serverDir: string;

  afterEach(() => {
    try {
      if (serverDir && existsSync(serverDir)) rmSync(serverDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  const PRIVATE_PROJECT = {
    id: 'proj-private',
    visibility: 'private',
    ownerUserId: 'owner-1',
  } as unknown as Project;

  it('404s a private-project replay for a non-owner, but serves it to the owner', async () => {
    // App authed as a different user (u2) who is NOT the project owner.
    const intruder = makeApp({
      stampAuth: { authUserId: 'u2', authRole: 'User' },
      projects: [PRIVATE_PROJECT],
    });
    serverDir = intruder.serverDir;
    const row = await storeReplay(
      { stmts: intruder.stmts, config: intruder.config },
      { events: [META, SNAPSHOT], projectId: 'proj-private' },
    );

    // Intruder is masked with a 404 on both metadata and events.
    await supertest(intruder.app).get(`/api/replays/${row.id}`).expect(404);
    await supertest(intruder.app).get(`/api/replays/${row.id}/events`).expect(404);

    // Same in-memory DB + dataDir, but authed as the project owner → 200 + content.
    const ownerApp = express();
    ownerApp.use((req, _res, next) => {
      Object.assign(req, { authUserId: 'owner-1', authRole: 'User' });
      next();
    });
    ownerApp.use(
      createReplayRoutes({
        serverDir: intruder.serverDir,
        stmts: intruder.stmts,
        config: intruder.config,
        findProject: (id: string) => (id === 'proj-private' ? PRIVATE_PROJECT : null),
      } as unknown as RouteDeps),
    );
    const meta = await supertest(ownerApp).get(`/api/replays/${row.id}`).expect(200);
    expect(meta.body.id).toBe(row.id);
    expect(meta.body.projectId).toBe('proj-private');
    const events = await supertest(ownerApp).get(`/api/replays/${row.id}/events`).expect(200);
    expect(events.body.total).toBe(2);
  });

  it('404s an unattributed replay for an ordinary user but serves it via apiKey', async () => {
    const user = makeApp({ stampAuth: { authUserId: 'u9', authRole: 'User' } });
    serverDir = user.serverDir;
    const row = await storeReplay(
      { stmts: user.stmts, config: user.config },
      { events: [META, SNAPSHOT] }, // projectId omitted → null
    );
    await supertest(user.app).get(`/api/replays/${row.id}`).expect(404);

    // apiKey break-glass (localBypass) over the same DB → 200.
    const adminApp = express();
    adminApp.use((req, _res, next) => {
      Object.assign(req, { authViaApiKey: true });
      next();
    });
    adminApp.use(
      createReplayRoutes({
        serverDir: user.serverDir,
        stmts: user.stmts,
        config: user.config,
        findProject: () => null,
      } as unknown as RouteDeps),
    );
    await supertest(adminApp).get(`/api/replays/${row.id}`).expect(200);
  });
});

describe('GET /api/replays/config', () => {
  const PROJECT_WITH_REPLAY = {
    id: 'proj-continuous',
    name: 'Continuous',
    replay: { sampleRate: 0.25, continuous: true },
  } as unknown as Project;
  const PROJECT_PLAIN = { id: 'proj-plain', name: 'Plain' } as unknown as Project;
  // A misconfigured row: continuous on with no explicit rate. The resolver must
  // pin it to a safe 0 so the client never reads it as the default-100% rate.
  const PROJECT_CONTINUOUS_NO_RATE = {
    id: 'proj-cnr',
    name: 'ContinuousNoRate',
    replay: { continuous: true },
  } as unknown as Project;

  beforeEach(() => {
    (verifyRumToken as unknown as Mock).mockReset();
    (verifyRumToken as unknown as Mock).mockReturnValue(null);
  });

  it('returns the default policy when no project is identified', async () => {
    const { app } = makeApp();
    const res = await supertest(app).get('/api/replays/config').expect(200);
    expect(res.body).toEqual({
      sampleRate: null,
      continuous: false,
      segmented: false,
      maskAllEnforced: false,
      flushIntervalMs: DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS,
      sessionSampleRate: null,
      sessionReplaySampleRate: null,
      effectiveReplaySampleRate: null,
    });
    expect(verifyRumToken as unknown as Mock).not.toHaveBeenCalled();
  });

  it('resolves the policy from the projectId query param', async () => {
    const { app } = makeApp({ projects: [PROJECT_WITH_REPLAY] });
    const res = await supertest(app)
      .get('/api/replays/config?projectId=proj-continuous')
      .expect(200);
    expect(res.body).toEqual({
      sampleRate: 0.25,
      continuous: true,
      segmented: false,
      maskAllEnforced: true,
      flushIntervalMs: DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS,
      sessionSampleRate: null,
      sessionReplaySampleRate: null,
      effectiveReplaySampleRate: null,
    });
  });

  it('uses the configured environment mask-all default for continuous capture', async () => {
    const { app, config } = makeApp({ projects: [PROJECT_WITH_REPLAY] });
    config.replayMaskAllEnforced = false;
    const res = await supertest(app)
      .get('/api/replays/config?projectId=proj-continuous')
      .expect(200);
    expect(res.body.maskAllEnforced).toBe(false);
  });

  it('pins a continuous-on/no-rate project to an explicit sampleRate:0', async () => {
    const { app } = makeApp({ projects: [PROJECT_CONTINUOUS_NO_RATE] });
    const res = await supertest(app).get('/api/replays/config?projectId=proj-cnr').expect(200);
    expect(res.body).toEqual({
      sampleRate: 0,
      continuous: true,
      segmented: false,
      maskAllEnforced: true,
      flushIntervalMs: DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS,
      sessionSampleRate: null,
      sessionReplaySampleRate: null,
      effectiveReplaySampleRate: null,
    });
  });

  it('returns the default policy for a project with no replay config', async () => {
    const { app } = makeApp({ projects: [PROJECT_PLAIN] });
    const res = await supertest(app).get('/api/replays/config?projectId=proj-plain').expect(200);
    expect(res.body).toEqual({
      sampleRate: null,
      continuous: false,
      segmented: false,
      maskAllEnforced: false,
      flushIntervalMs: DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS,
      sessionSampleRate: null,
      sessionReplaySampleRate: null,
      effectiveReplaySampleRate: null,
    });
  });

  it('does not leak existence: unknown project resolves to the default policy', async () => {
    const { app } = makeApp({ projects: [PROJECT_WITH_REPLAY] });
    const res = await supertest(app).get('/api/replays/config?projectId=nope').expect(200);
    expect(res.body).toEqual({
      sampleRate: null,
      continuous: false,
      segmented: false,
      maskAllEnforced: false,
      flushIntervalMs: DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS,
      sessionSampleRate: null,
      sessionReplaySampleRate: null,
      effectiveReplaySampleRate: null,
    });
  });

  it('resolves the policy from a valid X-RUM-Token (token wins over query)', async () => {
    (verifyRumToken as unknown as Mock).mockReturnValue({
      clientId: 'c1',
      projectId: 'proj-continuous',
      name: 'web',
    });
    const { app } = makeApp({ projects: [PROJECT_WITH_REPLAY, PROJECT_PLAIN] });
    const res = await supertest(app)
      .get('/api/replays/config?projectId=proj-plain')
      .set('X-RUM-Token', 'rum_sometoken')
      .expect(200);
    expect(res.body).toEqual({
      sampleRate: 0.25,
      continuous: true,
      segmented: false,
      maskAllEnforced: true,
      flushIntervalMs: DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS,
      sessionSampleRate: null,
      sessionReplaySampleRate: null,
      effectiveReplaySampleRate: null,
    });
    expect(verifyRumToken as unknown as Mock).toHaveBeenCalledWith('rum_sometoken');
  });

  it('delivers a project-configured flush cadence', async () => {
    const project = {
      id: 'proj-cadence',
      name: 'Cadence',
      replay: { sampleRate: 1, continuous: true, flushIntervalMs: 120_000 },
    } as unknown as Project;
    const { app } = makeApp({ projects: [project] });
    const res = await supertest(app).get('/api/replays/config?projectId=proj-cadence').expect(200);
    expect(res.body.flushIntervalMs).toBe(120_000);
  });

  it('delivers segmented:true and a sub-minute cadence for a segmented project', async () => {
    const project = {
      id: 'proj-segmented',
      name: 'Segmented',
      replay: { sampleRate: 1, continuous: true, segmented: true, flushIntervalMs: 5_000 },
    } as unknown as Project;
    const { app } = makeApp({ projects: [project] });
    const res = await supertest(app)
      .get('/api/replays/config?projectId=proj-segmented')
      .expect(200);
    expect(res.body.segmented).toBe(true);
    // The segmented path lifts the monolithic 60s floor (O(1) append).
    expect(res.body.flushIntervalMs).toBe(5_000);
  });

  it('delivers the two-level nested sample rates and their effective product', async () => {
    const project = {
      id: 'proj-nested',
      name: 'Nested',
      replay: { sessionSampleRate: 0.5, sessionReplaySampleRate: 0.4 },
    } as unknown as Project;
    const { app } = makeApp({ projects: [project] });
    const res = await supertest(app).get('/api/replays/config?projectId=proj-nested').expect(200);
    expect(res.body.sessionSampleRate).toBeCloseTo(0.5);
    expect(res.body.sessionReplaySampleRate).toBeCloseTo(0.4);
    // Replay % is OF the sampled sessions → 0.5 × 0.4 = 0.2 effective.
    expect(res.body.effectiveReplaySampleRate).toBeCloseTo(0.2);
  });

  it('answers the CORS preflight with 204 and an allow-origin header', async () => {
    const { app } = makeApp();
    const res = await supertest(app).options('/api/replays/config').expect(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('POST /api/replays/sessions/:sessionId/views/:viewId/segments/:index', () => {
  let app: Express;
  let serverDir: string;
  let stmts: Stmts;

  beforeEach(() => {
    _resetRateLimit();
    (verifyRumToken as unknown as Mock).mockReset();
    (verifyRumToken as unknown as Mock).mockReturnValue(null);
    ({ app, serverDir, stmts } = makeApp());
  });

  afterEach(() => {
    try {
      if (serverDir && existsSync(serverDir)) rmSync(serverDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  const segUrl = (s: string, v: string, i: number) =>
    `/api/replays/sessions/${s}/views/${v}/segments/${i}`;

  it('stores a view-opening segment (index 0) and returns its manifest summary', async () => {
    const res = await supertest(app)
      .post(segUrl('sess1', 'view1', 0))
      .send({ events: [META, SNAPSHOT, INCREMENTAL], meta: { trigger: 'continuous' } })
      .expect(201);

    expect(typeof res.body.segmentId).toBe('string');
    expect(res.body.sessionId).toBe('sess1');
    expect(res.body.viewId).toBe('view1');
    expect(res.body.indexInView).toBe(0);
    expect(res.body.hasFullSnapshot).toBe(true);
    expect(res.body.projectId).toBeNull();
    expect(res.body.eventCount).toBe(3);
    expect(res.body.byteSize).toBeGreaterThan(0);
    expect(res.headers['access-control-allow-origin']).toBe('*');

    // The manifest row landed and points at the stored object.
    const rows = stmts.listRumSegmentsBySession.all('sess1') as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.view_id).toBe('view1');
    expect(rows[0]!.has_full_snapshot).toBe(1);
  });

  it('enriches the session row with device/browser/os parsed from the User-Agent', async () => {
    await supertest(app)
      .post(segUrl('sess-ua', 'view1', 0))
      .set(
        'User-Agent',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      )
      .send({ events: [META, SNAPSHOT] })
      .expect(201);

    const row = stmts.getRumSession.get('sess-ua') as any;
    expect(row.device_type).toBe('Mobile');
    expect(row.browser).toBe('Safari');
    expect(row.os).toBe('iOS');
    // No geo db is wired in tests / the loopback IP is private, so geo_country is null.
    expect(row.geo_country).toBeNull();
  });

  it('accepts an incremental segment (index > 0) with no snapshot', async () => {
    // Seed the view-opening segment first.
    await supertest(app)
      .post(segUrl('sess2', 'view1', 0))
      .send({ events: [META, SNAPSHOT] })
      .expect(201);

    const res = await supertest(app)
      .post(segUrl('sess2', 'view1', 1))
      .send({ events: [INCREMENTAL] })
      .expect(201);
    expect(res.body.indexInView).toBe(1);
    expect(res.body.hasFullSnapshot).toBe(false);

    const rows = stmts.listRumSegmentsBySession.all('sess2') as any[];
    expect(rows).toHaveLength(2);
  });

  it('rejects a view-opening segment (index 0) that carries no full snapshot (400)', async () => {
    const res = await supertest(app)
      .post(segUrl('sess3', 'view1', 0))
      .send({ events: [META, INCREMENTAL] })
      .expect(400);
    expect(res.body.error).toMatch(/full snapshot/i);
    expect(stmts.listRumSegmentsBySession.all('sess3')).toHaveLength(0);
  });

  it('accepts a gzip-compressed body (raw gzip-framed bytes)', async () => {
    const body = gzipSync(Buffer.from(JSON.stringify({ events: [META, SNAPSHOT] }), 'utf-8'));
    const res = await supertest(app)
      .post(segUrl('sessgz', 'view1', 0))
      .set('Content-Type', 'application/octet-stream')
      .send(body)
      .expect(201);
    expect(res.body.eventCount).toBe(2);
  });

  it('rejects re-writing an already-stored (session, view, index) slot (409)', async () => {
    await supertest(app)
      .post(segUrl('sessdup', 'view1', 0))
      .send({ events: [META, SNAPSHOT] })
      .expect(201);
    const res = await supertest(app)
      .post(segUrl('sessdup', 'view1', 0))
      .send({ events: [META, SNAPSHOT] })
      .expect(409);
    expect(res.body.error).toMatch(/already/i);
    expect(stmts.listRumSegmentsBySession.all('sessdup')).toHaveLength(1);
  });

  it('validates path components (400 on bad index / ids)', async () => {
    await supertest(app)
      .post('/api/replays/sessions/ok/views/ok/segments/notanumber')
      .send({ events: [SNAPSHOT] })
      .expect(400);
  });

  it('attributes the segment to a project on a valid X-RUM-Token', async () => {
    (verifyRumToken as unknown as Mock).mockReturnValue({ projectId: 'proj-x' });
    const res = await supertest(app)
      .post(segUrl('sesstok', 'view1', 0))
      .set('X-RUM-Token', 'rum_valid')
      .send({ events: [META, SNAPSHOT] })
      .expect(201);
    expect(res.body.projectId).toBe('proj-x');
    const rows = stmts.listRumSegmentsBySession.all('sesstok') as any[];
    expect(rows[0]!.project_id).toBe('proj-x');
  });

  it('rejects an invalid X-RUM-Token (401) and stores nothing', async () => {
    (verifyRumToken as unknown as Mock).mockReturnValue(null);
    const res = await supertest(app)
      .post(segUrl('sessbad', 'view1', 0))
      .set('X-RUM-Token', 'rum_bogus')
      .send({ events: [META, SNAPSHOT] })
      .expect(401);
    expect(res.body.error).toMatch(/invalid rum token/i);
    expect(stmts.listRumSegmentsBySession.all('sessbad')).toHaveLength(0);
  });

  it('answers the CORS preflight with 204 and an allow-origin header', async () => {
    const res = await supertest(app)
      .options(segUrl('s', 'v', 0))
      .expect(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});
