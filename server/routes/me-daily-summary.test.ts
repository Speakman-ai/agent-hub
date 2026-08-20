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
