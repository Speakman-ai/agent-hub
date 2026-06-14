import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import supertest from 'supertest';
import os from 'os';
import path from 'path';
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'fs';
import Database from 'better-sqlite3';
import createReplayRoutes, {
  _resetRateLimit,
  validateReplayPayload,
  canViewReplay,
} from './replays.js';
import { storeReplay } from '../replays/replay-store.js';
import { resetArtifactStoreCache } from '../artifacts/artifact-store.js';
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
      support_ticket_id TEXT,
      card_id TEXT,
      meta TEXT
    );
  `);
  return {
    insertSessionReplay: db.prepare(
      `INSERT INTO session_replays
         (id, project_id, duration_ms, event_count, size, uncompressed_size,
          storage_kind, storage_key, storage_bucket, storage_region,
          support_ticket_id, card_id, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getSessionReplay: db.prepare('SELECT * FROM session_replays WHERE id = ?'),
    deleteSessionReplay: db.prepare('DELETE FROM session_replays WHERE id = ?'),
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

  it('handles OPTIONS preflight with 204 + CORS headers', async () => {
    const res = await supertest(app).options('/api/replays').expect(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toMatch(/POST/);
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
