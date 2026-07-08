import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  extractSegmentRollupCounts,
  extractSegmentUser,
  rollupSegmentIntoSession,
  getRumSession,
  listRumSessionsByProject,
  type SegmentRollupInput,
} from './rum-session-store.js';
import type { RumSessionRow, Stmts } from '../types.js';

function makeStmts(): Stmts {
  const db = new Database(':memory:');
  db.exec(`
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
    CREATE INDEX idx_rum_sessions_usr_email
      ON rum_sessions(project_id, usr_email);
    CREATE INDEX idx_rum_sessions_usr_id
      ON rum_sessions(project_id, usr_id);
    CREATE INDEX idx_rum_sessions_usr_name
      ON rum_sessions(project_id, usr_name);
  `);
  return {
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
  } as unknown as Stmts;
}

/** Build a rollup input with sensible defaults; override per test. */
function input(over: Partial<SegmentRollupInput> = {}): SegmentRollupInput {
  return {
    sessionId: 'sess',
    projectId: 'proj',
    indexInView: 0,
    startTs: 1000,
    endTs: 2000,
    counts: { action: 0, error: 0, frustration: 0 },
    ...over,
  };
}

describe('extractSegmentRollupCounts', () => {
  it('reads camelCase count keys', () => {
    expect(
      extractSegmentRollupCounts({ actionCount: 3, errorCount: 1, frustrationCount: 2 }),
    ).toEqual({ action: 3, error: 1, frustration: 2 });
  });

  it('reads snake_case count keys', () => {
    expect(
      extractSegmentRollupCounts({ action_count: 4, error_count: 2, frustration_count: 5 }),
    ).toEqual({ action: 4, error: 2, frustration: 5 });
  });

  it('defaults missing / invalid counts to 0', () => {
    expect(extractSegmentRollupCounts(null)).toEqual({ action: 0, error: 0, frustration: 0 });
    expect(extractSegmentRollupCounts({})).toEqual({ action: 0, error: 0, frustration: 0 });
    expect(
      extractSegmentRollupCounts({ actionCount: -1, errorCount: NaN, frustrationCount: 'x' }),
    ).toEqual({ action: 0, error: 0, frustration: 0 });
  });

  it('coerces numeric strings and floors fractional counts', () => {
    expect(extractSegmentRollupCounts({ actionCount: '7', errorCount: 2.9 })).toEqual({
      action: 7,
      error: 2,
      frustration: 0,
    });
  });
});

describe('rollupSegmentIntoSession', () => {
  let stmts: Stmts;
  beforeEach(() => {
    stmts = makeStmts();
  });

  it('creates the session row from the first (index 0) segment', () => {
    const row = rollupSegmentIntoSession(
      stmts,
      input({ startTs: 1000, endTs: 1500, counts: { action: 2, error: 1, frustration: 0 } }),
    );
    expect(row.session_id).toBe('sess');
    expect(row.project_id).toBe('proj');
    expect(row.view_count).toBe(1);
    expect(row.action_count).toBe(2);
    expect(row.error_count).toBe(1);
    expect(row.frustration_count).toBe(0);
    expect(row.started_at).toBe(1000);
    expect(row.ended_at).toBe(1500);
    expect(row.time_spent).toBe(500);
  });

  it('accumulates counts across segments within the same view (view_count stays 1)', () => {
    rollupSegmentIntoSession(
      stmts,
      input({
        indexInView: 0,
        startTs: 1000,
        endTs: 1500,
        counts: { action: 1, error: 0, frustration: 0 },
      }),
    );
    rollupSegmentIntoSession(
      stmts,
      input({
        indexInView: 1,
        startTs: 1500,
        endTs: 2000,
        counts: { action: 2, error: 1, frustration: 3 },
      }),
    );
    const row = rollupSegmentIntoSession(
      stmts,
      input({
        indexInView: 2,
        startTs: 2000,
        endTs: 2600,
        counts: { action: 0, error: 2, frustration: 1 },
      }),
    );
    expect(row.view_count).toBe(1); // one view, three segments
    expect(row.action_count).toBe(3);
    expect(row.error_count).toBe(3);
    expect(row.frustration_count).toBe(4);
    // time_spent spans first-segment start to last-segment end.
    expect(row.started_at).toBe(1000);
    expect(row.ended_at).toBe(2600);
    expect(row.time_spent).toBe(1600);
  });

  it('increments view_count once per view (each index-0 segment)', () => {
    rollupSegmentIntoSession(stmts, input({ indexInView: 0, startTs: 1000, endTs: 1200 }));
    rollupSegmentIntoSession(stmts, input({ indexInView: 1, startTs: 1200, endTs: 1400 }));
    // Second view opens with its own index-0 segment.
    const row = rollupSegmentIntoSession(
      stmts,
      input({ indexInView: 0, startTs: 1400, endTs: 1800 }),
    );
    expect(row.view_count).toBe(2);
    expect(row.ended_at).toBe(1800);
    expect(row.time_spent).toBe(800);
  });

  it('derives time_spent from first/last event across many views', () => {
    rollupSegmentIntoSession(stmts, input({ indexInView: 0, startTs: 5000, endTs: 5200 }));
    rollupSegmentIntoSession(stmts, input({ indexInView: 0, startTs: 6000, endTs: 6400 }));
    const row = getRumSession(stmts, 'sess')!;
    expect(row.started_at).toBe(5000);
    expect(row.ended_at).toBe(6400);
    expect(row.time_spent).toBe(1400);
  });

  it('attributes project first-non-null-wins (anonymous first, then a token)', () => {
    rollupSegmentIntoSession(stmts, input({ projectId: null, indexInView: 0 }));
    let row = getRumSession(stmts, 'sess')!;
    expect(row.project_id).toBeNull();
    // A later attributed segment adopts the tenant.
    row = rollupSegmentIntoSession(stmts, input({ projectId: 'proj-x', indexInView: 1 }));
    expect(row.project_id).toBe('proj-x');
    // A still-later different token does NOT steal the session.
    row = rollupSegmentIntoSession(stmts, input({ projectId: 'proj-y', indexInView: 2 }));
    expect(row.project_id).toBe('proj-x');
  });

  it('ignores empty segments (start/end 0) when folding time bounds', () => {
    rollupSegmentIntoSession(stmts, input({ indexInView: 0, startTs: 1000, endTs: 1500 }));
    const row = rollupSegmentIntoSession(stmts, input({ indexInView: 1, startTs: 0, endTs: 0 }));
    expect(row.started_at).toBe(1000);
    expect(row.ended_at).toBe(1500);
    expect(row.time_spent).toBe(500);
  });

  it('rolls independent sessions into independent rows', () => {
    rollupSegmentIntoSession(stmts, input({ sessionId: 'a', projectId: 'proj', indexInView: 0 }));
    rollupSegmentIntoSession(stmts, input({ sessionId: 'b', projectId: 'proj', indexInView: 0 }));
    rollupSegmentIntoSession(stmts, input({ sessionId: 'b', projectId: 'proj', indexInView: 1 }));
    const list = listRumSessionsByProject(stmts, 'proj', 100);
    expect(list.map((r: RumSessionRow) => r.session_id).sort()).toEqual(['a', 'b']);
  });
});

describe('extractSegmentUser', () => {
  it('splits standard fields from custom attributes', () => {
    expect(
      extractSegmentUser({
        usr: { id: 'u1', name: 'Ada', email: 'ada@x.io', plan: 'pro', seats: 5 },
      }),
    ).toEqual({
      id: 'u1',
      name: 'Ada',
      email: 'ada@x.io',
      attributes: { plan: 'pro', seats: 5 },
    });
  });

  it('coerces a numeric id to string and trims strings', () => {
    expect(extractSegmentUser({ usr: { id: 42, email: '  ada@x.io  ' } })).toEqual({
      id: '42',
      name: null,
      email: 'ada@x.io',
      attributes: null,
    });
  });

  it('drops null/empty standard values and null custom attrs', () => {
    expect(extractSegmentUser({ usr: { id: 'u1', name: '', email: null, plan: null } })).toEqual({
      id: 'u1',
      name: null,
      email: null,
      attributes: null,
    });
  });

  it('returns null for missing / empty / non-object usr', () => {
    expect(extractSegmentUser(null)).toBeNull();
    expect(extractSegmentUser({})).toBeNull();
    expect(extractSegmentUser({ usr: {} })).toBeNull();
    expect(extractSegmentUser({ usr: { id: null, name: undefined } })).toBeNull();
    expect(extractSegmentUser({ usr: 'nope' })).toBeNull();
    expect(extractSegmentUser({ usr: ['a'] })).toBeNull();
  });
});

describe('rollupSegmentIntoSession — user identity', () => {
  let stmts: Stmts;
  beforeEach(() => {
    stmts = makeStmts();
  });

  it('persists identity on the first segment (indexed columns + JSON attributes)', () => {
    const row = rollupSegmentIntoSession(
      stmts,
      input({ user: { id: 'u1', name: 'Ada', email: 'ada@x.io', attributes: { plan: 'pro' } } }),
    );
    expect(row.usr_id).toBe('u1');
    expect(row.usr_name).toBe('Ada');
    expect(row.usr_email).toBe('ada@x.io');
    expect(JSON.parse(row.usr_attributes!)).toEqual({ plan: 'pro' });
  });

  it('is anonymous (all NULL) when no segment carries a usr', () => {
    const row = rollupSegmentIntoSession(stmts, input({ user: null }));
    expect(row.usr_id).toBeNull();
    expect(row.usr_email).toBeNull();
    expect(row.usr_name).toBeNull();
    expect(row.usr_attributes).toBeNull();
  });

  it('mid-session identify: anonymous first segment, then a later usr shows up', () => {
    rollupSegmentIntoSession(stmts, input({ indexInView: 0, user: null }));
    let row = getRumSession(stmts, 'sess')!;
    expect(row.usr_email).toBeNull();
    row = rollupSegmentIntoSession(
      stmts,
      input({
        indexInView: 1,
        user: { id: 'u1', name: null, email: 'ada@x.io', attributes: null },
      }),
    );
    expect(row.usr_id).toBe('u1');
    expect(row.usr_email).toBe('ada@x.io');
  });

  it('last-seen wins: a later non-null identity overwrites the earlier one', () => {
    rollupSegmentIntoSession(
      stmts,
      input({
        indexInView: 0,
        user: { id: 'u1', name: 'Ada', email: 'ada@x.io', attributes: { plan: 'free' } },
      }),
    );
    const row = rollupSegmentIntoSession(
      stmts,
      input({
        indexInView: 1,
        user: { id: 'u2', name: 'Grace', email: 'grace@x.io', attributes: { plan: 'pro' } },
      }),
    );
    expect(row.usr_id).toBe('u2');
    expect(row.usr_name).toBe('Grace');
    expect(row.usr_email).toBe('grace@x.io');
    expect(JSON.parse(row.usr_attributes!)).toEqual({ plan: 'pro' });
  });

  it('keeps the last non-null value per field (a later anonymous segment never wipes it)', () => {
    rollupSegmentIntoSession(
      stmts,
      input({
        indexInView: 0,
        user: { id: 'u1', name: 'Ada', email: 'ada@x.io', attributes: { plan: 'pro' } },
      }),
    );
    const row = rollupSegmentIntoSession(stmts, input({ indexInView: 1, user: null }));
    expect(row.usr_id).toBe('u1');
    expect(row.usr_name).toBe('Ada');
    expect(row.usr_email).toBe('ada@x.io');
    expect(JSON.parse(row.usr_attributes!)).toEqual({ plan: 'pro' });
  });

  it('folds identity fields independently (a partial later identity does not clear the others)', () => {
    rollupSegmentIntoSession(
      stmts,
      input({
        indexInView: 0,
        user: { id: 'u1', name: 'Ada', email: 'ada@x.io', attributes: null },
      }),
    );
    // Later segment only re-declares email; id/name must survive.
    const row = rollupSegmentIntoSession(
      stmts,
      input({
        indexInView: 1,
        user: { id: null, name: null, email: 'new@x.io', attributes: null },
      }),
    );
    expect(row.usr_id).toBe('u1');
    expect(row.usr_name).toBe('Ada');
    expect(row.usr_email).toBe('new@x.io');
  });

  it('scopes identity to its tenant — same user id in two projects stays isolated', () => {
    rollupSegmentIntoSession(
      stmts,
      input({
        sessionId: 'a',
        projectId: 'proj-a',
        user: { id: 'shared', name: null, email: 'a@x.io', attributes: null },
      }),
    );
    rollupSegmentIntoSession(
      stmts,
      input({
        sessionId: 'b',
        projectId: 'proj-b',
        user: { id: 'shared', name: null, email: 'b@x.io', attributes: null },
      }),
    );
    const listA = listRumSessionsByProject(stmts, 'proj-a', 100);
    const listB = listRumSessionsByProject(stmts, 'proj-b', 100);
    expect(listA.map((r) => r.session_id)).toEqual(['a']);
    expect(listB.map((r) => r.session_id)).toEqual(['b']);
    expect(listA[0].usr_email).toBe('a@x.io');
    expect(listB[0].usr_email).toBe('b@x.io');
    // The shared identifier never leaks a row across the tenant boundary.
    expect(listA.some((r) => r.usr_email === 'b@x.io')).toBe(false);
  });
});

describe('rollupSegmentIntoSession — request enrichment', () => {
  let stmts: Stmts;
  beforeEach(() => {
    stmts = makeStmts();
  });

  it('writes device/browser/os/geo on the first segment', () => {
    const row = rollupSegmentIntoSession(
      stmts,
      input({
        enrichment: { deviceType: 'Mobile', browser: 'Safari', os: 'iOS', geoCountry: 'US' },
      }),
    );
    expect(row.device_type).toBe('Mobile');
    expect(row.browser).toBe('Safari');
    expect(row.os).toBe('iOS');
    expect(row.geo_country).toBe('US');
  });

  it('leaves facets NULL when the first segment carries no enrichment', () => {
    const row = rollupSegmentIntoSession(stmts, input({ enrichment: null }));
    expect(row.device_type).toBeNull();
    expect(row.browser).toBeNull();
    expect(row.os).toBeNull();
    expect(row.geo_country).toBeNull();
  });

  it('is first-non-null-wins: a later segment never overwrites a derived facet', () => {
    rollupSegmentIntoSession(
      stmts,
      input({
        indexInView: 0,
        enrichment: { deviceType: 'Desktop', browser: 'Chrome', os: 'Windows', geoCountry: 'US' },
      }),
    );
    // A later segment (e.g. proxied IP, stripped UA) reports different/absent facets.
    const row = rollupSegmentIntoSession(
      stmts,
      input({
        indexInView: 1,
        enrichment: { deviceType: 'Mobile', browser: 'Safari', os: 'iOS', geoCountry: 'DE' },
      }),
    );
    expect(row.device_type).toBe('Desktop');
    expect(row.browser).toBe('Chrome');
    expect(row.os).toBe('Windows');
    expect(row.geo_country).toBe('US');
  });

  it('back-fills a facet a first anonymous segment left NULL', () => {
    rollupSegmentIntoSession(
      stmts,
      input({
        indexInView: 0,
        enrichment: { deviceType: null, browser: null, os: null, geoCountry: null },
      }),
    );
    const row = rollupSegmentIntoSession(
      stmts,
      input({
        indexInView: 1,
        enrichment: { deviceType: 'Desktop', browser: 'Firefox', os: 'Linux', geoCountry: 'FR' },
      }),
    );
    expect(row.device_type).toBe('Desktop');
    expect(row.browser).toBe('Firefox');
    expect(row.os).toBe('Linux');
    expect(row.geo_country).toBe('FR');
  });
});
