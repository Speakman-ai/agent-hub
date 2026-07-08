import { describe, it, expect, beforeAll } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createProject } from '../test/helpers.js';
import { getDb } from '../db.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
}, 60_000);

async function newProjectId(): Promise<string> {
  return (await createProject()).id as string;
}

interface SessionSeed {
  sessionId: string;
  projectId: string;
  startedAt?: number | null;
  endedAt?: number | null;
  timeSpent?: number;
  viewCount?: number;
  actionCount?: number;
  errorCount?: number;
  frustrationCount?: number;
  usrId?: string | null;
  usrEmail?: string | null;
  usrName?: string | null;
  usrAttributes?: string | null;
  deviceType?: string | null;
  browser?: string | null;
  os?: string | null;
  geoCountry?: string | null;
}

/** Namespace a session label by its project so the globally-unique
 *  rum_sessions PK doesn't collide across tests that share the app DB. */
function nsId(projectId: string, label: string): string {
  return `${projectId}::${label}`;
}

/** Map a response page back to the per-test session labels (strip the project
 *  namespace prefix), preserving response order. */
function labelsOrdered(sessions: any[]): string[] {
  return sessions.map((s) => String(s.sessionId).split('::')[1]);
}

/** Same, sorted, for order-independent assertions. */
function labels(sessions: any[]): string[] {
  return labelsOrdered(sessions).sort();
}

/** Insert a rum_sessions row directly (the recorder→rollup path is exercised in
 *  rum-session-store.test.ts; here we seed rows to test the list query). */
function seedSession(s: SessionSeed): void {
  getDb()
    .prepare(
      `INSERT INTO rum_sessions
         (session_id, project_id, started_at, ended_at, time_spent, view_count,
          action_count, error_count, frustration_count, usr_id, usr_email, usr_name,
          usr_attributes, device_type, browser, os, geo_country)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      nsId(s.projectId, s.sessionId),
      s.projectId,
      s.startedAt ?? null,
      s.endedAt ?? null,
      s.timeSpent ?? 0,
      s.viewCount ?? 0,
      s.actionCount ?? 0,
      s.errorCount ?? 0,
      s.frustrationCount ?? 0,
      s.usrId ?? null,
      s.usrEmail ?? null,
      s.usrName ?? null,
      s.usrAttributes ?? null,
      s.deviceType ?? null,
      s.browser ?? null,
      s.os ?? null,
      s.geoCountry ?? null,
    );
}

async function list(
  projectId: string,
  query: Record<string, string | number> = {},
): Promise<{ sessions: any[]; total: number; limit: number; offset: number; hasMore: boolean }> {
  const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
  const res = await request
    .get(`/api/projects/${projectId}/rum/sessions${qs ? `?${qs}` : ''}`)
    .expect(200);
  return res.body;
}

describe('rum-sessions routes', () => {
  it('404s for an unknown project', async () => {
    await request.get('/api/projects/does-not-exist/rum/sessions').expect(404);
  });

  it('returns an empty page for a project with no sessions', async () => {
    const projectId = await newProjectId();
    const body = await list(projectId);
    expect(body.sessions).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.hasMore).toBe(false);
  });

  it('scopes to the project and maps row fields to the view shape', async () => {
    const projectId = await newProjectId();
    const otherId = await newProjectId();
    seedSession({
      sessionId: 's-mine',
      projectId,
      startedAt: 1_000,
      endedAt: 6_000,
      timeSpent: 5_000,
      viewCount: 3,
      actionCount: 7,
      errorCount: 2,
      frustrationCount: 1,
      usrEmail: 'a@example.com',
      usrName: 'Ada',
      usrId: 'u1',
      usrAttributes: JSON.stringify({ plan: 'pro' }),
      deviceType: 'Desktop',
      browser: 'Chrome',
      os: 'macOS',
      geoCountry: 'US',
    });
    seedSession({ sessionId: 's-other', projectId: otherId, startedAt: 2_000 });

    const body = await list(projectId);
    expect(body.total).toBe(1);
    const row = body.sessions[0];
    expect(row.sessionId).toBe(nsId(projectId, 's-mine'));
    expect(row.timeSpent).toBe(5_000);
    expect(row.viewCount).toBe(3);
    expect(row.errorCount).toBe(2);
    expect(row.frustrationCount).toBe(1);
    expect(row.usrEmail).toBe('a@example.com');
    expect(row.usrAttributes).toEqual({ plan: 'pro' });
    expect(row.deviceType).toBe('Desktop');
    expect(row.geoCountry).toBe('US');
  });

  it('orders most-recent (started_at DESC) first', async () => {
    const projectId = await newProjectId();
    seedSession({ sessionId: 'old', projectId, startedAt: 1_000 });
    seedSession({ sessionId: 'new', projectId, startedAt: 9_000 });
    seedSession({ sessionId: 'mid', projectId, startedAt: 5_000 });

    const body = await list(projectId);
    expect(labelsOrdered(body.sessions)).toEqual(['new', 'mid', 'old']);
  });

  describe('facet filters', () => {
    it('filters by exact usrEmail', async () => {
      const projectId = await newProjectId();
      seedSession({ sessionId: 'a', projectId, startedAt: 1, usrEmail: 'alice@x.com' });
      seedSession({ sessionId: 'b', projectId, startedAt: 2, usrEmail: 'bob@x.com' });

      const body = await list(projectId, { usrEmail: 'alice@x.com' });
      expect(labels(body.sessions)).toEqual(['a']);
      expect(body.total).toBe(1);
    });

    it('filters by device / browser / os / geo facets (ANDed)', async () => {
      const projectId = await newProjectId();
      seedSession({
        sessionId: 'match',
        projectId,
        startedAt: 2,
        deviceType: 'Mobile',
        browser: 'Safari',
        os: 'iOS',
        geoCountry: 'FR',
      });
      seedSession({
        sessionId: 'wrong-browser',
        projectId,
        startedAt: 1,
        deviceType: 'Mobile',
        browser: 'Chrome',
        os: 'iOS',
        geoCountry: 'FR',
      });

      const body = await list(projectId, {
        deviceType: 'Mobile',
        browser: 'Safari',
        os: 'iOS',
        geoCountry: 'FR',
      });
      expect(labels(body.sessions)).toEqual(['match']);
    });

    it('treats a blank facet value as no filter', async () => {
      const projectId = await newProjectId();
      seedSession({ sessionId: 'a', projectId, startedAt: 1, usrEmail: 'a@x.com' });
      seedSession({ sessionId: 'b', projectId, startedAt: 2, usrEmail: null });

      // A blank usrEmail must NOT collapse to `usr_email = ''` (which matches
      // nothing) — it's a no-op so both rows come back.
      const body = await list(projectId, { usrEmail: '   ' });
      expect(body.total).toBe(2);
    });

    it('filters by count lower bounds (errorCountMin / frustrationCountMin)', async () => {
      const projectId = await newProjectId();
      seedSession({ sessionId: 'clean', projectId, startedAt: 1, errorCount: 0 });
      seedSession({ sessionId: 'one-error', projectId, startedAt: 2, errorCount: 1 });
      seedSession({ sessionId: 'many', projectId, startedAt: 3, errorCount: 5 });

      const body = await list(projectId, { errorCountMin: 1 });
      expect(labels(body.sessions)).toEqual(['many', 'one-error']);
    });

    it('filters by a duration window (min inclusive, max inclusive)', async () => {
      const projectId = await newProjectId();
      seedSession({ sessionId: 'short', projectId, startedAt: 1, timeSpent: 1_000 });
      seedSession({ sessionId: 'lower', projectId, startedAt: 2, timeSpent: 2_000 });
      seedSession({ sessionId: 'upper', projectId, startedAt: 3, timeSpent: 5_000 });
      seedSession({ sessionId: 'long', projectId, startedAt: 4, timeSpent: 6_000 });

      const body = await list(projectId, { durationMinMs: 2_000, durationMaxMs: 5_000 });
      expect(labels(body.sessions)).toEqual(['lower', 'upper']);
    });
  });

  describe('time-range boundaries', () => {
    // Window [FROM, TO] is inclusive on both ends; a session starting one ms
    // outside either bound is excluded.
    const FROM = 1_000;
    const TO = 2_000;

    it('includes sessions exactly on the from/to bounds and excludes just-outside', async () => {
      const projectId = await newProjectId();
      seedSession({ sessionId: 'before', projectId, startedAt: FROM - 1 });
      seedSession({ sessionId: 'on-from', projectId, startedAt: FROM });
      seedSession({ sessionId: 'inside', projectId, startedAt: 1_500 });
      seedSession({ sessionId: 'on-to', projectId, startedAt: TO });
      seedSession({ sessionId: 'after', projectId, startedAt: TO + 1 });
      // A session that never got a usable timestamp is off the timeline.
      seedSession({ sessionId: 'no-ts', projectId, startedAt: null });

      const body = await list(projectId, { from: FROM, to: TO });
      expect(labels(body.sessions)).toEqual(['inside', 'on-from', 'on-to']);
    });

    it('applies only a lower bound when `to` is omitted', async () => {
      const projectId = await newProjectId();
      seedSession({ sessionId: 'before', projectId, startedAt: FROM - 1 });
      seedSession({ sessionId: 'on-from', projectId, startedAt: FROM });
      seedSession({ sessionId: 'after', projectId, startedAt: 9_999 });

      const body = await list(projectId, { from: FROM });
      expect(labels(body.sessions)).toEqual(['after', 'on-from']);
    });

    it('applies only an upper bound when `from` is omitted', async () => {
      const projectId = await newProjectId();
      seedSession({ sessionId: 'early', projectId, startedAt: 10 });
      seedSession({ sessionId: 'on-to', projectId, startedAt: TO });
      seedSession({ sessionId: 'after', projectId, startedAt: TO + 1 });

      const body = await list(projectId, { to: TO });
      expect(labels(body.sessions)).toEqual(['early', 'on-to']);
    });
  });

  describe('pagination', () => {
    it('paginates with limit/offset and reports hasMore/total', async () => {
      const projectId = await newProjectId();
      for (let i = 0; i < 5; i++) {
        seedSession({ sessionId: `s${i}`, projectId, startedAt: (i + 1) * 1_000 });
      }

      const first = await list(projectId, { limit: 2, offset: 0 });
      expect(first.total).toBe(5);
      expect(first.sessions).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      // Newest first: s4 (5000), s3 (4000).
      expect(labelsOrdered(first.sessions)).toEqual(['s4', 's3']);

      const last = await list(projectId, { limit: 2, offset: 4 });
      expect(labelsOrdered(last.sessions)).toEqual(['s0']);
      expect(last.hasMore).toBe(false);
    });
  });
});
