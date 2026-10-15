import '../test/setup.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../db.js';
import type { RouteDeps } from '../types.js';
import {
  categoriesDisabledByEnabledEvents,
  ensureUserNotificationPrefsSchema,
} from '../migrations/user-notification-prefs.js';
import { NOTIFICATION_CATEGORY_IDS } from '../../shared/utils/notificationCategories.js';
import createMeNotificationPreferencesRoutes from './me-notification-preferences.js';

const ROUTE = '/api/me/notification-preferences';

function makeApp(userId: string | null = 'user-1') {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (userId) (req as unknown as { authUserId?: string }).authUserId = userId;
    next();
  });
  app.use(createMeNotificationPreferencesRoutes({} as RouteDeps));
  return app;
}

type CatBody = {
  category: string;
  in_app: boolean;
  desktop: boolean;
  push: boolean;
  isDefault: boolean;
};
const byCat = (body: { categories: CatBody[] }) =>
  Object.fromEntries(body.categories.map((c) => [c.category, c]));

beforeEach(() => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ah-notif-prefs-'));
  initDb(dataDir);
});

describe('GET/PUT /api/me/notification-preferences', () => {
  it('returns catalog defaults for every category when nothing is stored', async () => {
    const res = await request(makeApp()).get(ROUTE).expect(200);
    expect(res.body.channels).toEqual(['in_app', 'desktop', 'push']);
    expect(res.body.categories.map((c: CatBody) => c.category)).toEqual([
      ...NOTIFICATION_CATEGORY_IDS,
    ]);
    const cats = byCat(res.body);
    expect(cats.awaiting_feedback).toMatchObject({
      in_app: true,
      desktop: true,
      push: true,
      isDefault: true,
    });
    expect(cats.session_completed).toMatchObject({ in_app: true, desktop: false, push: false });
    expect(res.body.sections.map((s: { id: string }) => s.id)).toContain('chat');
  });

  it('applies a partial update and keeps unspecified channels', async () => {
    const app = makeApp();
    const res = await request(app)
      .put(ROUTE)
      .send({ categories: { dm: { push: false }, pr_merged: { desktop: true } } })
      .expect(200);
    const cats = byCat(res.body);
    expect(cats.dm).toMatchObject({ in_app: true, desktop: true, push: false, isDefault: false });
    expect(cats.pr_merged).toMatchObject({ in_app: true, desktop: true, push: false });
    expect(cats.mention.isDefault).toBe(true);

    const again = byCat((await request(app).get(ROUTE).expect(200)).body);
    expect(again.dm.push).toBe(false);
  });

  it('scopes prefs to the caller', async () => {
    await request(makeApp('user-1'))
      .put(ROUTE)
      .send({ categories: { dm: { push: false } } })
      .expect(200);
    const other = byCat((await request(makeApp('user-2')).get(ROUTE).expect(200)).body);
    expect(other.dm.push).toBe(true);
  });

  it('rejects unknown categories, channels and non-boolean values', async () => {
    const app = makeApp();
    await request(app)
      .put(ROUTE)
      .send({ categories: { nope: { push: false } } })
      .expect(400);
    await request(app)
      .put(ROUTE)
      .send({ categories: { dm: { email: false } } })
      .expect(400);
    await request(app)
      .put(ROUTE)
      .send({ categories: { dm: { push: 'no' } } })
      .expect(400);
    await request(app).put(ROUTE).send({}).expect(400);
  });

  it('requires authentication', async () => {
    await request(makeApp(null)).get(ROUTE).expect(401);
    await request(makeApp(null)).put(ROUTE).send({ categories: {} }).expect(401);
  });
});

describe('device enabled_events migration', () => {
  /**
   * Build a pre-existing install: an agent-hub.db that already has device
   * tokens but no prefs table, then boot initDb on it.
   */
  function bootInstallWithDevices(rows: Array<[string, string | null, string | null]>) {
    const dir = mkdtempSync(path.join(tmpdir(), 'ah-notif-prefs-legacy-'));
    const raw = new Database(path.join(dir, 'agent-hub.db'));
    raw.exec(`CREATE TABLE device_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL DEFAULT 'ios', user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used TEXT,
      enabled_events TEXT DEFAULT NULL)`);
    const ins = raw.prepare(
      'INSERT INTO device_tokens (token, platform, user_id, enabled_events) VALUES (?, ?, ?, ?)',
    );
    for (const [token, userId, events] of rows) ins.run(token, 'ios', userId, events);
    raw.close();
    initDb(dir);
  }

  it('turns push off for a category disabled on any of the user devices, on re-init', async () => {
    bootInstallWithDevices([
      // Phone: everything but chat on.
      [
        'tok-a',
        'user-1',
        JSON.stringify([
          'awaiting_feedback',
          'ready_to_push',
          'pushed',
          'support_ticket_created',
          'review_assigned_to_you',
          'pr_merged',
          'infra_alert',
        ]),
      ],
      // Tablet: legacy key for awaiting_feedback, infra_alert off.
      ['tok-b', 'user-1', JSON.stringify(['session_complete', 'chat_message'])],
      // Never saved prefs: all on, contributes nothing.
      ['tok-c', 'user-2', null],
      // No owner: skipped.
      ['tok-d', null, '[]'],
    ]);

    const u1 = byCat((await request(makeApp('user-1')).get(ROUTE).expect(200)).body);
    expect(u1.dm).toMatchObject({ push: false, in_app: true, desktop: true });
    expect(u1.mention.push).toBe(false);
    expect(u1.infra_alert.push).toBe(false);
    expect(u1.ready_to_push).toMatchObject({ push: false, isDefault: false });
    // Enabled on every device (via legacy alias on tok-b).
    expect(u1.awaiting_feedback).toMatchObject({ push: true, isDefault: true });
    // No push event maps here, so the migration never touches it.
    expect(u1.session_completed.isDefault).toBe(true);

    const u2 = byCat((await request(makeApp('user-2')).get(ROUTE).expect(200)).body);
    expect(Object.values(u2).every((c) => (c as CatBody).isDefault)).toBe(true);
  });

  it('runs once: a later pass does not undo a user re-enabling push', async () => {
    bootInstallWithDevices([['tok-a', 'user-1', '[]']]);
    const app = makeApp('user-1');
    expect(byCat((await request(app).get(ROUTE)).body).dm.push).toBe(false);

    await request(app)
      .put(ROUTE)
      .send({ categories: { dm: { push: true } } })
      .expect(200);
    expect(ensureUserNotificationPrefsSchema(getDb())).toBeNull();
    expect(byCat((await request(app).get(ROUTE)).body).dm.push).toBe(true);
  });

  it('ensureUserNotificationPrefsSchema reports what it migrated and is a no-op afterwards', () => {
    const db = new Database(':memory:');
    db.exec(
      'CREATE TABLE device_tokens (token TEXT, platform TEXT, user_id TEXT, enabled_events TEXT)',
    );
    db.prepare('INSERT INTO device_tokens VALUES (?, ?, ?, ?)').run('t', 'ios', 'u', '["pushed"]');
    const first = ensureUserNotificationPrefsSchema(db);
    expect(first?.users).toBe(1);
    expect(first?.rows).toBeGreaterThan(0);
    expect(ensureUserNotificationPrefsSchema(db)).toBeNull();
  });

  it('categoriesDisabledByEnabledEvents treats null/invalid as all on', () => {
    expect(categoriesDisabledByEnabledEvents(null).size).toBe(0);
    expect(categoriesDisabledByEnabledEvents('not json').size).toBe(0);
    expect(categoriesDisabledByEnabledEvents('{}').size).toBe(0);
    const off = categoriesDisabledByEnabledEvents('["chat_message","changes_ready"]');
    expect(off.has('dm')).toBe(false);
    expect(off.has('ready_to_push')).toBe(false);
    expect(off.has('pushed')).toBe(true);
  });
});
