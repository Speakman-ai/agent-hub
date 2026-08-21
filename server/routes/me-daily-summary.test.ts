/**
 * GET/POST /api/me/daily-summary — stored-by-day, generate only on POST.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { RouteDeps } from '../types.js';
import type { HubDailySummaryStored } from '../user-preferences-store.js';

const { initOrgsDb, setOrgsDbPathForTests } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { initDb } = await import('../db.js');
const { default: createMeDailySummaryRoutes } = await import('./me-daily-summary.js');

const NOW = new Date('2026-08-19T18:00:00.000Z');
let userA = '';

function mount(
  authUserId: string | null,
  generate?: () => Promise<HubDailySummaryStored>,
): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (authUserId) {
      Object.assign(req, { authUserId, authUser: 'x', authRole: 'User' });
    }
    next();
  });
  app.use(
    createMeDailySummaryRoutes({} as RouteDeps, {
      now: () => NOW,
      generate: generate
        ? async () => generate()
        : async () => {
            throw new Error('generate should not run in this test');
          },
    }),
  );
  return app;
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'me-daily-summary-route-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  userA = createUser({ username: 'summary-route-a', passwordHash: 'x' }).id;
});

describe('/api/me/daily-summary', () => {
  it('requires authentication', async () => {
    await request(mount(null)).get('/api/me/daily-summary').expect(401);
    await request(mount(null)).post('/api/me/daily-summary').expect(401);
  });

  it('GET does not generate and returns report=null when nothing is stored for today', async () => {
    const generate = vi.fn(async () => {
      throw new Error('should not generate');
    });
    const res = await request(mount(userA, generate))
      .get('/api/me/daily-summary')
      .query({ tz: 'UTC' })
      .expect(200);
    expect(res.body.date).toBe('2026-08-19');
    expect(res.body.report).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it('POST generates, and GET then returns that report until the local day rolls over', async () => {
    const report: HubDailySummaryStored = {
      date: '2026-08-19',
      timeZone: 'UTC',
      markdown: '## Today\n- generated',
      engine: 'claude-code',
      model: 'claude-opus-4-6',
      generatedAt: '2026-08-19T18:00:00.000Z',
    };
    const generate = vi.fn(async () => {
      const { saveDailySummary } = await import('../hub-daily-summary.js');
      saveDailySummary(userA, report);
      return report;
    });
    const created = await request(mount(userA, generate))
      .post('/api/me/daily-summary')
      .send({ tz: 'UTC' })
      .expect(200);
    expect(created.body.report.markdown).toContain('generated');
    expect(generate).toHaveBeenCalledTimes(1);

    const again = await request(mount(userA, generate))
      .get('/api/me/daily-summary')
      .query({ tz: 'UTC' })
      .expect(200);
    expect(again.body.report.markdown).toContain('generated');
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe('/api/me/daily-summary/schedule', () => {
  it('requires authentication', async () => {
    await request(mount(null)).get('/api/me/daily-summary/schedule').expect(401);
    await request(mount(null)).put('/api/me/daily-summary/schedule').send({}).expect(401);
  });

  it('returns schedule=null before anything is set', async () => {
    const res = await request(mount(userA)).get('/api/me/daily-summary/schedule').expect(200);
    expect(res.body.schedule).toBeNull();
  });

  it('PUT normalizes (dedupes, sorts, drops invalid), persists, and GET returns it', async () => {
    const put = await request(mount(userA))
      .put('/api/me/daily-summary/schedule')
      .send({
        enabled: true,
        timeZone: 'America/New_York',
        times: ['09:00', '25:99', '09:00', '07:30'],
      })
      .expect(200);
    expect(put.body.schedule).toEqual({
      enabled: true,
      timeZone: 'America/New_York',
      times: ['07:30', '09:00'],
    });

    const get = await request(mount(userA)).get('/api/me/daily-summary/schedule').expect(200);
    expect(get.body.schedule.times).toEqual(['07:30', '09:00']);
    expect(get.body.schedule.enabled).toBe(true);
  });

  it('clears the schedule when times is empty', async () => {
    await request(mount(userA))
      .put('/api/me/daily-summary/schedule')
      .send({ enabled: true, timeZone: 'UTC', times: ['08:00'] })
      .expect(200);
    const cleared = await request(mount(userA))
      .put('/api/me/daily-summary/schedule')
      .send({ enabled: true, timeZone: 'UTC', times: [] })
      .expect(200);
    expect(cleared.body.schedule).toBeNull();
  });

  it('400s on a malformed body', async () => {
    await request(mount(userA))
      .put('/api/me/daily-summary/schedule')
      .send({ enabled: 'yes', times: ['08:00'] })
      .expect(400);
    await request(mount(userA))
      .put('/api/me/daily-summary/schedule')
      .send({ times: 'nope' })
      .expect(400);
  });
});
