/**
 * Personal reminders: REST surface, agent attribution, calendar mirror,
 * scheduler firing, and the notification fan-out that delivers them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { RouteDeps } from '../types.js';
import type { ReminderCalendarClient } from '../reminders-calendar.js';

const { initOrgsDb, setOrgsDbPathForTests } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { initDb, getStmts, getDb } = await import('../db.js');
const { default: createMeRemindersRoutes } = await import('./me-reminders.js');
const {
  getReminder,
  createReminder,
  listDueCalendarCleanups,
  updateReminder,
  wakeReminderCalendarWork,
  pruneDismissedReminders,
  claimDueReminder,
  beginCalendarInsert,
  linkCalendarEvent,
  enqueueCalendarCleanup,
  completeCalendarCleanup,
  setReminderCalendar,
} = await import('../reminders-store.js');
const { reminderCalendarLabel } = await import('../../shared/utils/reminders.js');
const { runReminderCalendarMaintenance, calendarEventIdFor } =
  await import('../reminders-calendar.js');
const { fireDueReminders, deliverReminderNotification } = await import('../reminders-scheduler.js');
const { REMINDER_DUE_EVENT } = await import('../reminders-events.js');
const { listNotifications } = await import('../notifications-store.js');
const { handleBroadcastForNotifications, mapBroadcastToNotification } =
  await import('../notification-fanout.js');
const { shouldDeliverBroadcast } = await import('../broadcast-filter.js');

const NOW = new Date('2026-10-16T12:00:00.000Z');
const broadcast = vi.fn();
const tickDeps = { broadcast, deliver: async () => true };

let userA = '';
let userB = '';

function fakeCalendar() {
  const calls = { insert: vi.fn(), patch: vi.fn(), remove: vi.fn() };
  const client: ReminderCalendarClient = {
    insert: async (calendarId, event) => {
      calls.insert(calendarId, event);
      return { id: event.id ?? 'missing-id', htmlLink: 'https://calendar.google.com/event?eid=1' };
    },
    patch: async (calendarId, eventId, event) => {
      calls.patch(calendarId, eventId, event);
      return { id: eventId };
    },
    remove: async (calendarId, eventId) => {
      calls.remove(calendarId, eventId);
    },
  };
  return { calls, client };
}

function mount(
  authUserId: string | null,
  calendar: { resolveClient: (uid: string) => Promise<ReminderCalendarClient | { skip: string }> },
  extra: Record<string, unknown> = {},
): Express {
  const deps = {
    broadcast,
    stmts: getStmts(),
    config: { googleOAuth: null },
    findAgent: (id: string) =>
      id === 'agent-1' ? { project: { id: 'proj-1' }, agent: { id: 'agent-1' } } : null,
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (authUserId) Object.assign(req, { authUserId, ...extra });
    next();
  });
  app.use(createMeRemindersRoutes(deps, { calendar, now: () => NOW }));
  return app;
}

const noCalendar = { resolveClient: async () => ({ skip: 'Google account is not connected' }) };

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'me-reminders-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  userA = createUser({ username: 'rem-a', passwordHash: 'x' }).id;
  userB = createUser({ username: 'rem-b', passwordHash: 'x' }).id;
  broadcast.mockClear();
});

describe('/api/me/reminders', () => {
  it('creates a reminder, mirrors it to the calendar, and broadcasts to the owner', async () => {
    const cal = fakeCalendar();
    const res = await request(mount(userA, { resolveClient: async () => cal.client }))
      .post('/api/me/reminders')
      .send({
        title: 'Call the bank',
        notes: 'Ask about the wire',
        remindAt: '2026-10-17T09:00:00-07:00',
      });
    expect(res.status).toBe(201);
    const r = res.body.reminder;
    expect(r.remindAt).toBe('2026-10-17T16:00:00.000Z');
    expect(r.status).toBe('pending');
    expect(r.createdBy).toBe('user');
    expect(r.calendar).toMatchObject({
      status: 'synced',
      calendarId: 'primary',
      eventId: calendarEventIdFor(r.id),
    });
    const [calendarId, event] = cal.calls.insert.mock.calls[0];
    expect(calendarId).toBe('primary');
    expect(event.summary).toBe('Call the bank');
    expect(event.start.dateTime).toBe('2026-10-17T16:00:00.000Z');
    expect(event.reminders).toEqual({
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 0 }],
    });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reminder_update', ownerUserId: userA, action: 'created' }),
    );
  });

  it('records why the calendar was skipped and still saves the reminder', async () => {
    const res = await request(mount(userA, noCalendar))
      .post('/api/me/reminders')
      .send({ title: 'Stretch', inMinutes: 30 });
    expect(res.status).toBe(201);
    expect(res.body.reminder.remindAt).toBe('2026-10-16T12:30:00.000Z');
    expect(res.body.reminder.calendar).toMatchObject({
      status: 'skipped',
      error: 'Google account is not connected',
    });
  });

  it('honors calendar: none and a failing Google write', async () => {
    const cal = fakeCalendar();
    const none = await request(mount(userA, { resolveClient: async () => cal.client }))
      .post('/api/me/reminders')
      .send({ title: 'Local only', inMinutes: 5, calendar: 'none' });
    expect(none.body.reminder.calendar.status).toBe('none');
    expect(cal.calls.insert).not.toHaveBeenCalled();

    const failing: ReminderCalendarClient = {
      ...cal.client,
      insert: async () => {
        throw new Error('quota exceeded');
      },
    };
    const failed = await request(mount(userA, { resolveClient: async () => failing }))
      .post('/api/me/reminders')
      .send({ title: 'Still saved', inMinutes: 5 });
    expect(failed.status).toBe(201);
    // Insert failures stay pending (event id reserved) and are retried.
    expect(failed.body.reminder.calendar).toMatchObject({
      status: 'pending',
      eventId: calendarEventIdFor(failed.body.reminder.id),
      error: 'quota exceeded',
    });
  });

  it('rejects past times, bad dates, and both/neither time fields', async () => {
    const app = mount(userA, noCalendar);
    expect(
      (
        await request(app)
          .post('/api/me/reminders')
          .send({ title: 'x', remindAt: '2026-10-15T00:00:00Z' })
      ).status,
    ).toBe(400);
    expect(
      (await request(app).post('/api/me/reminders').send({ title: 'x', remindAt: 'tomorrow-ish' }))
        .status,
    ).toBe(400);
    expect((await request(app).post('/api/me/reminders').send({ title: 'x' })).status).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/me/reminders')
          .send({ title: 'x', inMinutes: 5, remindAt: '2026-10-17T00:00:00Z' })
      ).status,
    ).toBe(400);
  });

  it('rejects remindAt values Date.parse would silently reinterpret', async () => {
    const app = mount(userA, noCalendar);
    const bad = [
      '2027-02-30T09:00:00Z', // Date.parse rolls this to March 2
      '2026-10-17T24:00:00Z',
      '2026-10-17T09:00:00', // no offset: would be read in the server's zone
      '2026-10-17',
      'Oct 17 2026 9:00',
    ];
    for (const remindAt of bad) {
      const res = await request(app).post('/api/me/reminders').send({ title: 'x', remindAt });
      expect(res.status, remindAt).toBe(400);
      expect(res.body.error).toMatch(/RFC 3339/);
    }
    const ok = await request(app)
      .post('/api/me/reminders')
      .send({ title: 'x', remindAt: '2026-10-17T09:00:00.5+05:30' });
    expect(ok.status).toBe(201);
    expect(ok.body.reminder.remindAt).toBe('2026-10-17T03:30:00.500Z');
    for (const remindAt of bad) {
      const res = await request(app)
        .patch(`/api/me/reminders/${ok.body.reminder.id}`)
        .send({ remindAt });
      expect(res.status, remindAt).toBe(400);
    }
  });

  it('attributes an agent-created reminder to the session owner and links the session', async () => {
    getDb()
      .prepare(
        'INSERT INTO sessions (id, agent_id, name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('sess-1', 'agent-1', 'Work', userA, NOW.toISOString(), NOW.toISOString());
    // Break-glass key: no authUserId, session id via header.
    const res = await request(mount(null, noCalendar))
      .post('/api/me/reminders')
      .set('X-Agent-Hub-Session-Id', 'sess-1')
      .send({ title: 'Check the deploy', inMinutes: 60 });
    expect(res.status).toBe(201);
    expect(res.body.reminder).toMatchObject({
      userId: userA,
      createdBy: 'agent',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      projectId: 'proj-1',
    });
  });

  it('ignores a session the caller does not own', async () => {
    getDb()
      .prepare(
        'INSERT INTO sessions (id, agent_id, name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('sess-b', 'agent-1', 'Theirs', userB, NOW.toISOString(), NOW.toISOString());
    const res = await request(mount(userA, noCalendar))
      .post('/api/me/reminders')
      .send({ title: 'Mine', inMinutes: 5, sessionId: 'sess-b' });
    expect(res.body.reminder).toMatchObject({ userId: userA, sessionId: null, createdBy: 'user' });
  });

  it('scopes list, update, and delete to the owner', async () => {
    const mine = createReminder({
      userId: userA,
      title: 'A',
      remindAt: '2026-10-17T00:00:00.000Z',
    });
    createReminder({ userId: userB, title: 'B', remindAt: '2026-10-17T00:00:00.000Z' });
    const list = await request(mount(userA, noCalendar)).get('/api/me/reminders');
    expect(list.body.reminders.map((r: { title: string }) => r.title)).toEqual(['A']);

    const asB = mount(userB, noCalendar);
    expect(
      (await request(asB).patch(`/api/me/reminders/${mine.id}`).send({ title: 'x' })).status,
    ).toBe(404);
    expect((await request(asB).delete(`/api/me/reminders/${mine.id}`)).status).toBe(404);
    expect(getReminder(userA, mine.id)?.title).toBe('A');
  });

  it('snoozes a fired reminder back to pending and syncs the calendar event', async () => {
    const cal = fakeCalendar();
    const app = mount(userA, { resolveClient: async () => cal.client });
    const created = await request(app)
      .post('/api/me/reminders')
      .send({ title: 'Lunch', inMinutes: 1 });
    const id = created.body.reminder.id;
    await fireDueReminders(tickDeps, new Date(NOW.getTime() + 2 * 60 * 1000));
    expect(getReminder(userA, id)?.status).toBe('fired');

    const res = await request(app).patch(`/api/me/reminders/${id}`).send({ snoozeMinutes: 10 });
    expect(res.body.reminder).toMatchObject({
      status: 'pending',
      remindAt: '2026-10-16T12:10:00.000Z',
      firedAt: null,
    });
    expect(cal.calls.patch).toHaveBeenCalledWith(
      'primary',
      calendarEventIdFor(id),
      expect.any(Object),
    );

    const dismissed = await request(app)
      .patch(`/api/me/reminders/${id}`)
      .send({ status: 'dismissed' });
    expect(dismissed.body.reminder.status).toBe('dismissed');
    expect(dismissed.body.reminder.dismissedAt).toBeTruthy();
  });

  it('deletes the calendar event with the reminder', async () => {
    const cal = fakeCalendar();
    const app = mount(userA, { resolveClient: async () => cal.client });
    const created = await request(app)
      .post('/api/me/reminders')
      .send({ title: 'Gone', inMinutes: 5 });
    const res = await request(app).delete(`/api/me/reminders/${created.body.reminder.id}`);
    expect(res.status).toBe(200);
    expect(res.body.calendarCleanup).toBe('done');
    expect(cal.calls.remove).toHaveBeenCalledWith(
      'primary',
      calendarEventIdFor(created.body.reminder.id),
    );
    expect(getReminder(userA, created.body.reminder.id)).toBeNull();
    expect(listDueCalendarCleanups(new Date('2030-01-01T00:00:00Z'))).toEqual([]);
  });

  it('keeps a failed calendar delete queued and removes the event once Google recovers', async () => {
    const cal = fakeCalendar();
    let down = true;
    const flaky: ReminderCalendarClient = {
      ...cal.client,
      remove: async (calendarId, eventId) => {
        if (down) throw new Error('backend error');
        await cal.client.remove(calendarId, eventId);
      },
    };
    const calendar = { googleOAuth: null, resolveClient: async () => flaky };
    const app = mount(userA, calendar);
    const created = await request(app)
      .post('/api/me/reminders')
      .send({ title: 'Gone later', inMinutes: 5 });
    const res = await request(app).delete(`/api/me/reminders/${created.body.reminder.id}`);
    expect(res.status).toBe(200);
    expect(res.body.calendarCleanup).toBe('pending');
    expect(getReminder(userA, created.body.reminder.id)).toBeNull();

    // Queued with backoff: not due right away, due after the first delay.
    expect(listDueCalendarCleanups(NOW)).toEqual([]);
    const later = new Date(NOW.getTime() + 2 * 60 * 1000);
    const [queued] = listDueCalendarCleanups(later);
    expect(queued).toMatchObject({
      eventId: calendarEventIdFor(created.body.reminder.id),
      attempts: 1,
      lastError: 'backend error',
    });

    // Still failing: the row stays and backs off further.
    await runReminderCalendarMaintenance(calendar, later);
    expect(listDueCalendarCleanups(later)).toEqual([]);

    down = false;
    const muchLater = new Date(NOW.getTime() + 60 * 60 * 1000);
    expect(await runReminderCalendarMaintenance(calendar, muchLater)).toMatchObject({
      cleanedUp: 1,
    });
    expect(cal.calls.remove).toHaveBeenCalledWith(
      'primary',
      calendarEventIdFor(created.body.reminder.id),
    );
    expect(listDueCalendarCleanups(new Date('2030-01-01T00:00:00Z'))).toEqual([]);
  });

  it('never gives up on calendar work, and reconnecting Google retries it at once', async () => {
    const cal = fakeCalendar();
    let connected = true;
    let googleUp = false;
    const client: ReminderCalendarClient = {
      insert: async (calendarId, event) => {
        if (!googleUp) throw new Error('backend error');
        return cal.client.insert(calendarId, event);
      },
      patch: async (calendarId, eventId, event) => {
        if (!googleUp) throw new Error('backend error');
        return cal.client.patch(calendarId, eventId, event);
      },
      remove: async (calendarId, eventId) => {
        if (!googleUp) throw new Error('backend error');
        return cal.client.remove(calendarId, eventId);
      },
    };
    const calendar = {
      googleOAuth: null,
      resolveClient: async () => (connected ? client : { skip: 'Google account is not connected' }),
    };
    const app = mount(userA, calendar);

    // One reminder per kind of unfinished work: a delete, an insert, an update.
    googleUp = true;
    const toDelete = (
      await request(app).post('/api/me/reminders').send({ title: 'Delete me', inMinutes: 600 })
    ).body.reminder;
    const toUpdate = (
      await request(app).post('/api/me/reminders').send({ title: 'Update me', inMinutes: 600 })
    ).body.reminder;
    googleUp = false;
    const toInsert = (
      await request(app).post('/api/me/reminders').send({ title: 'Insert me', inMinutes: 600 })
    ).body.reminder;
    await request(app).delete(`/api/me/reminders/${toDelete.id}`);
    await request(app).patch(`/api/me/reminders/${toUpdate.id}`).send({ title: 'Updated' });

    // Run well past the old 20-attempt budget, partly while disconnected.
    let t = NOW.getTime();
    for (let i = 0; i < 30; i += 1) {
      t += 7 * 60 * 60 * 1000; // past the 6-hour cap each time
      connected = i % 2 === 0;
      await runReminderCalendarMaintenance(calendar, new Date(t));
    }
    const far = new Date(t + 7 * 60 * 60 * 1000);
    expect(listDueCalendarCleanups(far)).toHaveLength(1);
    expect(getReminder(userA, toInsert.id)?.calendar).toMatchObject({
      status: 'pending',
      eventId: calendarEventIdFor(toInsert.id),
    });
    expect(getReminder(userA, toUpdate.id)?.calendar).toMatchObject({
      status: 'failed',
      eventId: calendarEventIdFor(toUpdate.id),
    });

    // Google recovers and the user reconnects: everything is due right away.
    connected = true;
    googleUp = true;
    const at = new Date(t + 60 * 1000);
    wakeReminderCalendarWork(userA, at);
    const result = await runReminderCalendarMaintenance(calendar, at);
    expect(result).toEqual({ cleanedUp: 1, resynced: 2 });
    expect(cal.calls.remove).toHaveBeenCalledWith('primary', calendarEventIdFor(toDelete.id));
    expect(getReminder(userA, toInsert.id)?.calendar.status).toBe('synced');
    expect(getReminder(userA, toUpdate.id)?.calendar.status).toBe('synced');
    expect(listDueCalendarCleanups(far)).toEqual([]);
  });

  it('retention prune hands unsettled events to the cleanup queue', async () => {
    const cal = fakeCalendar();
    let googleUp = false;
    const client: ReminderCalendarClient = {
      ...cal.client,
      insert: async (calendarId, event) => {
        cal.calls.insert(calendarId, event);
        // The request reaches Google but the response is lost.
        throw new Error('socket hang up');
      },
      remove: async (calendarId, eventId) => {
        if (!googleUp) throw new Error('backend error');
        return cal.client.remove(calendarId, eventId);
      },
    };
    const calendar = { googleOAuth: null, resolveClient: async () => client };
    const app = mount(userA, calendar);
    const lost = (
      await request(app).post('/api/me/reminders').send({ title: 'Lost', inMinutes: 1 })
    ).body.reminder;
    expect(lost.calendar.status).toBe('pending');
    // It fires, then gets dismissed, so dismissal keeps its (possible) event.
    await fireDueReminders(tickDeps, new Date(NOW.getTime() + 2 * 60 * 1000));
    updateReminder(userA, lost.id, { status: 'dismissed', now: NOW });
    expect(getReminder(userA, lost.id)?.calendar.status).toBe('pending');

    const pruneAt = new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000);
    expect(pruneDismissedReminders(pruneAt)).toEqual([{ userId: userA, id: lost.id }]);
    expect(getReminder(userA, lost.id)).toBeNull();
    const [queued] = listDueCalendarCleanups(pruneAt);
    expect(queued).toMatchObject({ eventId: calendarEventIdFor(lost.id) });

    googleUp = true;
    wakeReminderCalendarWork(userA, pruneAt);
    await runReminderCalendarMaintenance(calendar, pruneAt);
    expect(cal.calls.remove).toHaveBeenCalledWith('primary', calendarEventIdFor(lost.id));
    expect(listDueCalendarCleanups(new Date('2031-01-01T00:00:00Z'))).toEqual([]);
  });

  it('treats an already-deleted calendar event as cleaned up', async () => {
    const cal = fakeCalendar();
    const gone: ReminderCalendarClient = {
      ...cal.client,
      remove: async () => {
        throw Object.assign(new Error('Not Found'), { code: 404 });
      },
    };
    const app = mount(userA, { resolveClient: async () => gone });
    const created = await request(app).post('/api/me/reminders').send({ title: 'x', inMinutes: 5 });
    const res = await request(app).delete(`/api/me/reminders/${created.body.reminder.id}`);
    expect(res.body.calendarCleanup).toBe('done');
    expect(listDueCalendarCleanups(new Date('2030-01-01T00:00:00Z'))).toEqual([]);
  });

  it('retries a failed event update and restores synced once the patch works', async () => {
    const cal = fakeCalendar();
    let down = true;
    const flaky: ReminderCalendarClient = {
      ...cal.client,
      patch: async (calendarId, eventId, event) => {
        if (down) throw new Error('rate limited');
        return cal.client.patch(calendarId, eventId, event);
      },
    };
    const calendar = { googleOAuth: null, resolveClient: async () => flaky };
    const app = mount(userA, calendar);
    const created = await request(app)
      .post('/api/me/reminders')
      .send({ title: 'Move me', inMinutes: 5 });
    const id = created.body.reminder.id;

    const failed = await request(app).patch(`/api/me/reminders/${id}`).send({ snoozeMinutes: 30 });
    expect(failed.body.reminder.calendar).toMatchObject({
      status: 'failed',
      eventId: calendarEventIdFor(id),
      error: 'rate limited',
    });

    // The next edit still reaches Google once it recovers.
    down = false;
    const ok = await request(app).patch(`/api/me/reminders/${id}`).send({ snoozeMinutes: 45 });
    expect(ok.body.reminder.calendar).toMatchObject({
      status: 'synced',
      eventId: calendarEventIdFor(id),
      error: null,
    });
    const [, , event] = cal.calls.patch.mock.calls.at(-1) as [string, string, any];
    expect(event.start.dateTime).toBe('2026-10-16T12:45:00.000Z');
  });

  it('resyncs a failed event from the scheduler without another edit', async () => {
    const cal = fakeCalendar();
    let down = true;
    const flaky: ReminderCalendarClient = {
      ...cal.client,
      patch: async (calendarId, eventId, event) => {
        if (down) throw new Error('rate limited');
        return cal.client.patch(calendarId, eventId, event);
      },
    };
    const calendar = { googleOAuth: null, resolveClient: async () => flaky };
    const app = mount(userA, calendar);
    const created = await request(app)
      .post('/api/me/reminders')
      .send({ title: 'Move me', inMinutes: 5 });
    const id = created.body.reminder.id;
    await request(app).patch(`/api/me/reminders/${id}`).send({ snoozeMinutes: 30 });
    down = false;
    const result = await runReminderCalendarMaintenance(
      calendar,
      new Date(NOW.getTime() + 5 * 60 * 1000),
    );
    expect(result.resynced).toBe(1);
    expect(getReminder(userA, id)?.calendar.status).toBe('synced');
    const [, , event] = cal.calls.patch.mock.calls.at(-1) as [string, string, any];
    expect(event.start.dateTime).toBe('2026-10-16T12:30:00.000Z');
  });

  describe('calendar insert lifecycle', () => {
    /** A fake Google that holds each insert until released and tracks real events. */
    function deferredCalendar() {
      const events = new Map<string, any>();
      const removed: string[] = [];
      const patched: Array<{ id: string; event: any }> = [];
      let release: () => void = () => {};
      let inserted: () => void = () => {};
      const insertStarted = new Promise<void>((r) => (inserted = r));
      const gate = new Promise<void>((r) => (release = r));
      const client: ReminderCalendarClient = {
        insert: async (_calendarId, event) => {
          inserted();
          await gate;
          events.set(event.id as string, event);
          return { id: event.id, htmlLink: 'https://calendar.google.com/e' };
        },
        patch: async (_calendarId, eventId, event) => {
          if (!events.has(eventId)) throw Object.assign(new Error('Not Found'), { code: 404 });
          patched.push({ id: eventId, event });
          events.set(eventId, { ...events.get(eventId), ...event });
          return { id: eventId };
        },
        remove: async (_calendarId, eventId) => {
          if (!events.has(eventId)) throw Object.assign(new Error('Not Found'), { code: 404 });
          events.delete(eventId);
          removed.push(eventId);
        },
      };
      return { client, events, removed, patched, release, insertStarted };
    }

    it('removes an event whose insert lands after the reminder was deleted', async () => {
      const cal = deferredCalendar();
      const app = mount(userA, { resolveClient: async () => cal.client });
      const post = request(app)
        .post('/api/me/reminders')
        .send({ title: 'Racing', inMinutes: 30 })
        .then((r) => r);
      await cal.insertStarted;

      const [listed] = (await request(app).get('/api/me/reminders')).body.reminders;
      expect(listed.calendar).toMatchObject({
        status: 'pending',
        eventId: calendarEventIdFor(listed.id),
      });
      broadcast.mockClear();
      const del = await request(app).delete(`/api/me/reminders/${listed.id}`);
      expect(del.status).toBe(200);
      // Google has no event yet, so this delete is a 404 and the cleanup completes.
      expect(del.body.calendarCleanup).toBe('done');

      cal.release();
      // The create reports that its reminder is gone instead of returning it
      // as live, and never broadcasts `created` after the `deleted`.
      const created = await post;
      expect(created.status).toBe(410);
      expect(created.body.reminder).toBeUndefined();
      const actions = broadcast.mock.calls
        .map(([e]) => e)
        .filter((e) => e.type === 'reminder_update')
        .map((e) => e.action);
      expect(actions).toEqual(['deleted']);
      expect((await request(app).get('/api/me/reminders')).body.reminders).toEqual([]);
      // The late insert re-queued and removed its own event.
      expect(cal.events.size).toBe(0);
      expect(cal.removed).toEqual([calendarEventIdFor(listed.id)]);
      expect(listDueCalendarCleanups(new Date('2030-01-01T00:00:00Z'))).toEqual([]);
    });

    it('patches the event when the reminder was edited during the insert', async () => {
      const cal = deferredCalendar();
      const app = mount(userA, { resolveClient: async () => cal.client });
      const post = request(app)
        .post('/api/me/reminders')
        .send({ title: 'Old title', inMinutes: 30 })
        .then((r) => r);
      await cal.insertStarted;
      const [listed] = (await request(app).get('/api/me/reminders')).body.reminders;
      const edit = await request(app)
        .patch(`/api/me/reminders/${listed.id}`)
        .send({ title: 'New title', snoozeMinutes: 90 });
      expect(edit.body.reminder.calendar.status).toBe('pending');

      cal.release();
      const created = await post;
      expect(created.body.reminder.calendar.status).toBe('synced');
      const event = cal.events.get(calendarEventIdFor(listed.id));
      expect(event.summary).toBe('New title');
      expect(event.start.dateTime).toBe('2026-10-16T13:30:00.000Z');
    });

    it('retries a failed insert with the same id and treats 409 as created', async () => {
      const cal = fakeCalendar();
      let mode: 'fail' | 'conflict' = 'fail';
      const flaky: ReminderCalendarClient = {
        ...cal.client,
        insert: async (calendarId, event) => {
          cal.calls.insert(calendarId, event);
          if (mode === 'fail') throw new Error('timeout');
          throw Object.assign(new Error('Already exists'), { code: 409 });
        },
      };
      const calendar = { googleOAuth: null, resolveClient: async () => flaky };
      const app = mount(userA, calendar);
      const created = await request(app)
        .post('/api/me/reminders')
        .send({ title: 'Eventually', inMinutes: 30 });
      const id = created.body.reminder.id;
      expect(created.body.reminder.calendar.status).toBe('pending');

      mode = 'conflict';
      const result = await runReminderCalendarMaintenance(
        calendar,
        new Date(NOW.getTime() + 2 * 60 * 1000),
      );
      expect(result.resynced).toBe(1);
      expect(getReminder(userA, id)?.calendar).toMatchObject({
        status: 'synced',
        eventId: calendarEventIdFor(id),
      });
      const ids = cal.calls.insert.mock.calls.map(([, e]) => e.id);
      expect(ids).toEqual([calendarEventIdFor(id), calendarEventIdFor(id)]);
    });

    it('patches an event found via 409 so an older attempt cannot leave stale fields', async () => {
      const cal = fakeCalendar();
      let first = true;
      const flaky: ReminderCalendarClient = {
        ...cal.client,
        insert: async (calendarId, event) => {
          cal.calls.insert(calendarId, event);
          // The first insert reached Google but its response was lost.
          if (first) {
            first = false;
            throw new Error('socket hang up');
          }
          throw Object.assign(new Error('Already exists'), { code: 409 });
        },
      };
      const calendar = { googleOAuth: null, resolveClient: async () => flaky };
      const app = mount(userA, calendar);
      const created = await request(app)
        .post('/api/me/reminders')
        .send({ title: 'Original', inMinutes: 30 });
      const id = created.body.reminder.id;
      await request(app).patch(`/api/me/reminders/${id}`).send({ title: 'Renamed' });
      await runReminderCalendarMaintenance(calendar, new Date(NOW.getTime() + 2 * 60 * 1000));
      expect(getReminder(userA, id)?.calendar.status).toBe('synced');
      const [, eventId, event] = cal.calls.patch.mock.calls.at(-1) as [string, string, any];
      expect(eventId).toBe(calendarEventIdFor(id));
      expect(event.summary).toBe('Renamed');
    });

    it('re-patches when another edit lands while a patch is in flight', async () => {
      const cal = fakeCalendar();
      let raced = false;
      const racing: ReminderCalendarClient = {
        ...cal.client,
        patch: async (calendarId, eventId, event) => {
          cal.calls.patch(calendarId, eventId, event);
          if (!raced) {
            raced = true;
            // A second edit commits to the DB while this patch is at Google.
            updateReminder(userA, idRef.id, { title: 'Second edit', now: NOW });
          }
          return { id: eventId };
        },
      };
      const idRef = { id: '' };
      const app = mount(userA, { resolveClient: async () => racing });
      const created = await request(app)
        .post('/api/me/reminders')
        .send({ title: 'Start', inMinutes: 30 });
      idRef.id = created.body.reminder.id;
      await request(app).patch(`/api/me/reminders/${idRef.id}`).send({ title: 'First edit' });
      const summaries = cal.calls.patch.mock.calls.map(([, , e]) => e.summary);
      expect(summaries).toEqual(['First edit', 'Second edit']);
    });

    it('returns 404 and broadcasts nothing when the reminder is deleted during an edit', async () => {
      const cal = fakeCalendar();
      let gate: () => void = () => {};
      let started: () => void = () => {};
      const patchStarted = new Promise<void>((r) => (started = r));
      const slow: ReminderCalendarClient = {
        ...cal.client,
        patch: async (_c, eventId) => {
          started();
          await new Promise<void>((r) => (gate = r));
          return { id: eventId };
        },
      };
      const app = mount(userA, { resolveClient: async () => slow });
      const created = await request(app)
        .post('/api/me/reminders')
        .send({ title: 'Edit me', inMinutes: 30 });
      const id = created.body.reminder.id;
      const edit = request(app)
        .patch(`/api/me/reminders/${id}`)
        .send({ title: 'Edited' })
        .then((r) => r);
      await patchStarted;
      await request(app).delete(`/api/me/reminders/${id}`);
      broadcast.mockClear();
      gate();
      const res = await edit;
      expect(res.status).toBe(404);
      expect(broadcast).not.toHaveBeenCalled();
    });

    it('keeps a reserved event id when a retry finds Google unavailable', async () => {
      const cal = fakeCalendar();
      let mode: 'fail' | 'skip' | 'ok' = 'fail';
      const client: ReminderCalendarClient = {
        ...cal.client,
        insert: async (calendarId, event) => {
          if (mode === 'fail') throw new Error('socket hang up');
          return cal.client.insert(calendarId, event);
        },
      };
      const calendar = {
        googleOAuth: null,
        resolveClient: async () =>
          mode === 'skip' ? { skip: 'Google account is not connected' } : client,
      };
      const app = mount(userA, calendar);
      const created = await request(app)
        .post('/api/me/reminders')
        .send({ title: 'Keep id', inMinutes: 30 });
      const id = created.body.reminder.id;

      // The first attempt may have reached Google, so a later "not connected"
      // must not drop the id.
      mode = 'skip';
      await runReminderCalendarMaintenance(calendar, new Date(NOW.getTime() + 2 * 60 * 1000));
      expect(getReminder(userA, id)?.calendar).toMatchObject({
        status: 'pending',
        eventId: calendarEventIdFor(id),
        error: 'Google account is not connected',
      });
      mode = 'ok';
      wakeReminderCalendarWork(userA, new Date(NOW.getTime() + 3 * 60 * 1000));
      await runReminderCalendarMaintenance(calendar, new Date(NOW.getTime() + 3 * 60 * 1000));
      expect(getReminder(userA, id)?.calendar.status).toBe('synced');
    });

    it('removes the calendar event when a future reminder is dismissed', async () => {
      const cal = deferredCalendar();
      cal.release();
      const app = mount(userA, { resolveClient: async () => cal.client });
      const created = await request(app)
        .post('/api/me/reminders')
        .send({ title: 'Tomorrow', inMinutes: 24 * 60 });
      const id = created.body.reminder.id;
      expect(cal.events.has(calendarEventIdFor(id))).toBe(true);

      const res = await request(app).patch(`/api/me/reminders/${id}`).send({ status: 'dismissed' });
      expect(res.status).toBe(200);
      expect(res.body.reminder).toMatchObject({
        status: 'dismissed',
        calendar: { status: 'cancelled', eventId: null },
      });
      // Nothing left on Google that could still pop up.
      expect(cal.events.size).toBe(0);
      expect(listDueCalendarCleanups(new Date('2030-01-01T00:00:00Z'))).toEqual([]);
    });

    it('removes the event when a reminder is dismissed during its insert', async () => {
      const cal = deferredCalendar();
      const app = mount(userA, { resolveClient: async () => cal.client });
      const post = request(app)
        .post('/api/me/reminders')
        .send({ title: 'Dismiss early', inMinutes: 60 })
        .then((r) => r);
      await cal.insertStarted;
      const [listed] = (await request(app).get('/api/me/reminders')).body.reminders;
      const res = await request(app)
        .patch(`/api/me/reminders/${listed.id}`)
        .send({ status: 'dismissed' });
      expect(res.body.reminder.calendar.status).toBe('cancelled');

      cal.release();
      const created = await post;
      expect(created.status).toBe(201);
      expect(created.body.reminder.calendar).toMatchObject({ status: 'cancelled', eventId: null });
      expect(cal.events.size).toBe(0);
      expect(listDueCalendarCleanups(new Date('2030-01-01T00:00:00Z'))).toEqual([]);
    });

    it('queues the removal when Google is down at dismissal and finishes it later', async () => {
      const cal = deferredCalendar();
      cal.release();
      let up = true;
      const client: ReminderCalendarClient = {
        ...cal.client,
        remove: async (c, e) => {
          if (!up) throw new Error('backend error');
          return cal.client.remove(c, e);
        },
      };
      const calendar = { googleOAuth: null, resolveClient: async () => client };
      const app = mount(userA, calendar);
      const created = await request(app)
        .post('/api/me/reminders')
        .send({ title: 'Later', inMinutes: 600 });
      up = false;
      const dismissed = await request(app)
        .patch(`/api/me/reminders/${created.body.reminder.id}`)
        .send({ status: 'dismissed' });
      expect(cal.events.size).toBe(1);
      // The event is still there and can still pop up: don't say "removed".
      expect(dismissed.body.reminder.calendar).toMatchObject({
        status: 'removing',
        error: 'backend error',
      });
      expect(reminderCalendarLabel(dismissed.body.reminder)).toBe(
        'Removing from your calendar (will retry: backend error)',
      );

      up = true;
      const sweep = vi.fn();
      await runReminderCalendarMaintenance(
        calendar,
        new Date(NOW.getTime() + 2 * 60 * 1000),
        sweep,
      );
      expect(cal.events.size).toBe(0);
      const after = getReminder(userA, created.body.reminder.id)!;
      expect(after.calendar).toMatchObject({ status: 'cancelled', error: null });
      expect(reminderCalendarLabel(after)).toBe('Removed from your calendar');
      // Open clients learn about the confirmed removal.
      expect(sweep).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'reminder_update',
          reminderId: created.body.reminder.id,
          reminder: expect.objectContaining({
            calendar: expect.objectContaining({ status: 'cancelled' }),
          }),
        }),
      );
    });

    it('stays removing until every queued removal for the reminder is confirmed', async () => {
      const r = createReminder({
        userId: userA,
        title: 'Two',
        remindAt: '2026-10-17T00:00:00.000Z',
      });
      const a = enqueueCalendarCleanup(userA, r.id, 'primary', 'ahrA', NOW)!;
      const b = enqueueCalendarCleanup(userA, r.id, 'primary', 'ahrB', NOW)!;
      updateReminder(userA, r.id, { status: 'dismissed', now: NOW });
      setReminderCalendar(userA, r.id, { status: 'removing' });
      expect(completeCalendarCleanup(a.id)).toBeNull();
      expect(getReminder(userA, r.id)?.calendar.status).toBe('removing');
      expect(completeCalendarCleanup(b.id)).toEqual({ userId: userA, reminderId: r.id });
      expect(getReminder(userA, r.id)?.calendar.status).toBe('cancelled');
    });

    it('reports removed when Google says the event is already gone', async () => {
      for (const code of [404, 410]) {
        const cal = deferredCalendar();
        cal.release();
        const client: ReminderCalendarClient = {
          ...cal.client,
          remove: async () => {
            throw Object.assign(new Error('Gone'), { code });
          },
        };
        const app = mount(userA, { resolveClient: async () => client });
        const created = await request(app)
          .post('/api/me/reminders')
          .send({ title: `Gone ${code}`, inMinutes: 600 });
        const res = await request(app)
          .patch(`/api/me/reminders/${created.body.reminder.id}`)
          .send({ status: 'dismissed' });
        expect(res.body.reminder.calendar).toMatchObject({ status: 'cancelled', error: null });
      }
    });

    it('an old removal confirming after a re-arm does not mark the new event removed', async () => {
      const cal = deferredCalendar();
      cal.release();
      let up = false;
      const client: ReminderCalendarClient = {
        ...cal.client,
        remove: async (c, e) => {
          if (!up) throw new Error('backend error');
          return cal.client.remove(c, e);
        },
      };
      const calendar = { googleOAuth: null, resolveClient: async () => client };
      const app = mount(userA, calendar);
      const created = await request(app)
        .post('/api/me/reminders')
        .send({ title: 'Back again', inMinutes: 600 });
      const id = created.body.reminder.id;
      // Dismissal's removal fails and stays queued; then the reminder is re-armed.
      await request(app).patch(`/api/me/reminders/${id}`).send({ status: 'dismissed' });
      const rearmed = await request(app)
        .patch(`/api/me/reminders/${id}`)
        .send({ snoozeMinutes: 120 });
      expect(rearmed.body.reminder.calendar).toMatchObject({
        status: 'synced',
        eventId: calendarEventIdFor(id, 1),
      });

      // The old generation's removal finally succeeds.
      up = true;
      await runReminderCalendarMaintenance(calendar, new Date(NOW.getTime() + 2 * 60 * 1000));
      expect(cal.events.has(calendarEventIdFor(id))).toBe(false);
      expect(getReminder(userA, id)?.calendar).toMatchObject({
        status: 'synced',
        eventId: calendarEventIdFor(id, 1),
      });
      expect(cal.events.has(calendarEventIdFor(id, 1))).toBe(true);
    });

    it('puts a re-armed reminder back on the calendar under a new event id', async () => {
      const cal = deferredCalendar();
      cal.release();
      const app = mount(userA, { resolveClient: async () => cal.client });
      const created = await request(app)
        .post('/api/me/reminders')
        .send({ title: 'Again', inMinutes: 60 });
      const id = created.body.reminder.id;
      await request(app).patch(`/api/me/reminders/${id}`).send({ status: 'dismissed' });
      const res = await request(app).patch(`/api/me/reminders/${id}`).send({ snoozeMinutes: 120 });
      expect(res.body.reminder).toMatchObject({
        status: 'pending',
        calendar: { status: 'synced', eventId: calendarEventIdFor(id, 1) },
      });
      expect([...cal.events.keys()]).toEqual([calendarEventIdFor(id, 1)]);
      expect(cal.events.get(calendarEventIdFor(id, 1)).start.dateTime).toBe(
        '2026-10-16T14:00:00.000Z',
      );
    });

    it('a stale calendar result cannot overwrite a newer reservation', async () => {
      const cal = deferredCalendar();
      cal.release();
      let calls = 0;
      let releaseFirst: () => void = () => {};
      let firstStarted: () => void = () => {};
      const started = new Promise<void>((r) => (firstStarted = r));
      const resolveClient = async () => {
        calls += 1;
        if (calls === 1) {
          // The create-time attempt hangs, then finds Google unavailable.
          firstStarted();
          await new Promise<void>((r) => (releaseFirst = r));
          return { skip: 'Google account is not connected' };
        }
        return cal.client;
      };
      const app = mount(userA, { resolveClient });
      const post = request(app)
        .post('/api/me/reminders')
        .send({ title: 'Raced', inMinutes: 60 })
        .then((r) => r);
      await started;
      const [listed] = (await request(app).get('/api/me/reminders')).body.reminders;
      await request(app).patch(`/api/me/reminders/${listed.id}`).send({ status: 'dismissed' });
      const rearmed = await request(app)
        .patch(`/api/me/reminders/${listed.id}`)
        .send({ snoozeMinutes: 30 });
      // The old attempt still holds the event lock, so the re-arm hands its
      // insert to it instead of racing it.
      expect(rearmed.body.reminder.calendar).toMatchObject({
        status: 'pending',
        eventId: calendarEventIdFor(listed.id, 1),
      });

      broadcast.mockClear();
      releaseFirst();
      const created = await post;
      // The POST answers with the row as it is after the handed-off insert,
      // not the pending snapshot from before it.
      expect(created.status).toBe(201);
      expect(created.body.reminder.calendar).toMatchObject({
        status: 'synced',
        eventId: calendarEventIdFor(listed.id, 1),
      });
      // And the last thing open clients heard about it says synced too.
      const updates = broadcast.mock.calls
        .map(([e]) => e)
        .filter((e) => e.type === 'reminder_update' && e.reminderId === listed.id);
      expect(updates.length).toBeGreaterThan(0);
      expect(updates.at(-1).reminder.calendar).toMatchObject({
        status: 'synced',
        eventId: calendarEventIdFor(listed.id, 1),
      });
      // The old attempt's "skipped" applied to the old id only.
      expect(getReminder(userA, listed.id)?.calendar).toMatchObject({
        status: 'synced',
        eventId: calendarEventIdFor(listed.id, 1),
      });
      expect([...cal.events.keys()]).toEqual([calendarEventIdFor(listed.id, 1)]);
    });

    it('keeps the event of a reminder dismissed after it fired', async () => {
      const cal = deferredCalendar();
      cal.release();
      const app = mount(userA, { resolveClient: async () => cal.client });
      const created = await request(app)
        .post('/api/me/reminders')
        .send({ title: 'Done', inMinutes: 1 });
      const id = created.body.reminder.id;
      await fireDueReminders(tickDeps, new Date(NOW.getTime() + 2 * 60 * 1000));
      const res = await request(app).patch(`/api/me/reminders/${id}`).send({ status: 'dismissed' });
      expect(res.body.reminder.calendar.status).toBe('synced');
      expect(cal.events.size).toBe(1);
    });

    it('finishes the calendar patch of an edit after a crash before the patch ran', async () => {
      const cal = deferredCalendar();
      cal.release();
      const calendar = { googleOAuth: null, resolveClient: async () => cal.client };
      const app = mount(userA, calendar);
      const created = await request(app)
        .post('/api/me/reminders')
        .send({ title: 'Before', inMinutes: 60 });
      const id = created.body.reminder.id;

      // Commit the edit but never run its returned effect (the process died).
      const result = updateReminder(userA, id, {
        title: 'After',
        remindAt: '2026-10-16T15:00:00.000Z',
        now: NOW,
      });
      expect(result?.calendar.sync).toBe(true);
      expect(getReminder(userA, id)?.calendar.status).toBe('updating');
      expect(cal.patched).toEqual([]);

      // The sweep leaves it alone while the editor's lease holds, then fixes it.
      await runReminderCalendarMaintenance(calendar, new Date(NOW.getTime() + 60 * 1000));
      expect(cal.patched).toEqual([]);
      await runReminderCalendarMaintenance(calendar, new Date(NOW.getTime() + 6 * 60 * 1000));
      const event = cal.events.get(calendarEventIdFor(id));
      expect(event.summary).toBe('After');
      expect(event.start.dateTime).toBe('2026-10-16T15:00:00.000Z');
      expect(getReminder(userA, id)?.calendar.status).toBe('synced');
    });

    it('owes the patch durably when an insert lands after an edit', async () => {
      const r = createReminder({
        userId: userA,
        title: 'Sent',
        remindAt: '2026-10-16T13:00:00.000Z',
      });
      beginCalendarInsert(userA, r.id, 'primary', calendarEventIdFor(r.id), NOW);
      updateReminder(userA, r.id, { title: 'Edited meanwhile', now: NOW });
      // The insert's link records `updating` because the fields it sent are stale.
      const linked = linkCalendarEvent(
        userA,
        r.id,
        'primary',
        calendarEventIdFor(r.id),
        null,
        NOW,
        { title: 'Sent', notes: '', remindAt: '2026-10-16T13:00:00.000Z' },
      );
      expect(linked.kind === 'linked' && linked.reminder.calendar.status).toBe('updating');
      // Process dies here; the sweep patches it.
      const cal = deferredCalendar();
      cal.release();
      cal.events.set(calendarEventIdFor(r.id), { summary: 'Sent' });
      await runReminderCalendarMaintenance(
        { googleOAuth: null, resolveClient: async () => cal.client },
        NOW,
      );
      expect(cal.events.get(calendarEventIdFor(r.id)).summary).toBe('Edited meanwhile');
      expect(getReminder(userA, r.id)?.calendar.status).toBe('synced');
    });

    /** Google creates the event but the response never arrives. */
    function lostResponseCalendar() {
      const cal = deferredCalendar();
      let gate: () => void = () => {};
      let started: () => void = () => {};
      const insertStarted = new Promise<void>((r) => (started = r));
      const client: ReminderCalendarClient = {
        ...cal.client,
        insert: async (_c, event) => {
          started();
          await new Promise<void>((r) => (gate = r));
          cal.events.set(event.id as string, event);
          throw new Error('socket hang up');
        },
      };
      return { cal, client, insertStarted, release: () => gate() };
    }

    it('removes an event created by an insert whose response was lost after a delete', async () => {
      const lost = lostResponseCalendar();
      const calendar = { googleOAuth: null, resolveClient: async () => lost.client };
      const app = mount(userA, calendar);
      const post = request(app)
        .post('/api/me/reminders')
        .send({ title: 'Lost and deleted', inMinutes: 60 })
        .then((r) => r);
      await lost.insertStarted;
      const [listed] = (await request(app).get('/api/me/reminders')).body.reminders;
      // Cleanup runs first and gets a 404: nothing exists at Google yet.
      expect(
        (await request(app).delete(`/api/me/reminders/${listed.id}`)).body.calendarCleanup,
      ).toBe('done');
      lost.release();
      expect((await post).status).toBe(410);
      // Google did create it. Responsibility moved back to the cleanup queue.
      const eventId = calendarEventIdFor(listed.id);
      expect(lost.cal.events.has(eventId)).toBe(true);
      expect(listDueCalendarCleanups(NOW)).toMatchObject([{ eventId }]);
      await runReminderCalendarMaintenance(calendar, NOW);
      expect(lost.cal.events.size).toBe(0);
      expect(listDueCalendarCleanups(new Date('2030-01-01T00:00:00Z'))).toEqual([]);
    });

    it('removes an event created by a lost-response insert after a dismissal', async () => {
      const lost = lostResponseCalendar();
      const calendar = { googleOAuth: null, resolveClient: async () => lost.client };
      const app = mount(userA, calendar);
      const post = request(app)
        .post('/api/me/reminders')
        .send({ title: 'Lost and dismissed', inMinutes: 60 })
        .then((r) => r);
      await lost.insertStarted;
      const [listed] = (await request(app).get('/api/me/reminders')).body.reminders;
      await request(app).patch(`/api/me/reminders/${listed.id}`).send({ status: 'dismissed' });
      lost.release();
      const created = await post;
      expect(created.status).toBe(201);
      // Google may have created it, so it is not "removed" until confirmed.
      expect(created.body.reminder.calendar.status).toBe('removing');
      await runReminderCalendarMaintenance(calendar, NOW);
      expect(lost.cal.events.size).toBe(0);
      expect(getReminder(userA, listed.id)?.calendar.status).toBe('cancelled');
    });

    it('tells open clients when maintenance changes calendar state', async () => {
      const cal = fakeCalendar();
      let up = false;
      const client: ReminderCalendarClient = {
        ...cal.client,
        insert: async (c, e) => {
          if (!up) throw new Error('backend error');
          return cal.client.insert(c, e);
        },
      };
      const calendar = { googleOAuth: null, resolveClient: async () => client };
      const app = mount(userA, calendar);
      const created = await request(app)
        .post('/api/me/reminders')
        .send({ title: 'Recovering', inMinutes: 60 });
      expect(created.body.reminder.calendar.status).toBe('pending');

      const sweep = vi.fn();
      const t = new Date(NOW.getTime() + 2 * 60 * 1000);
      // A retry that changes nothing visible stays quiet... (error text is unchanged)
      await runReminderCalendarMaintenance(calendar, t, sweep);
      expect(sweep).not.toHaveBeenCalled();
      // ...and the one that recovers announces the current row.
      up = true;
      await runReminderCalendarMaintenance(calendar, new Date(t.getTime() + 5 * 60 * 1000), sweep);
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(sweep.mock.calls[0][0]).toMatchObject({
        type: 'reminder_update',
        ownerUserId: userA,
        action: 'updated',
        reminderId: created.body.reminder.id,
        reminder: { calendar: { status: 'synced' } },
      });
    });

    it('leaves the patch owed when edits land on every pass', async () => {
      const cal = deferredCalendar();
      cal.release();
      let editing = true;
      let n = 0;
      const client: ReminderCalendarClient = {
        ...cal.client,
        patch: async (c, eventId, event) => {
          const out = await cal.client.patch(c, eventId, event);
          // Another editor commits newer fields while each patch is out.
          if (editing) updateReminder(userA, idRef.id, { title: `Edit ${++n}`, now: NOW });
          return out;
        },
      };
      const idRef = { id: '' };
      const calendar = { googleOAuth: null, resolveClient: async () => client };
      const app = mount(userA, calendar);
      const created = await request(app)
        .post('/api/me/reminders')
        .send({ title: 'Start', inMinutes: 60 });
      idRef.id = created.body.reminder.id;
      await request(app).patch(`/api/me/reminders/${idRef.id}`).send({ title: 'Edit 0' });

      // Passes ran out with Google behind the row: still owed, due now.
      const owed = getReminder(userA, idRef.id)!;
      expect(owed.title).toBe('Edit 3');
      expect(owed.calendar.status).toBe('updating');
      expect(cal.events.get(calendarEventIdFor(idRef.id)).summary).toBe('Edit 2');

      editing = false;
      await runReminderCalendarMaintenance(calendar, NOW);
      expect(getReminder(userA, idRef.id)?.calendar.status).toBe('synced');
      expect(cal.events.get(calendarEventIdFor(idRef.id)).summary).toBe('Edit 3');
    });

    it('never has two patches for one event out at Google at once', async () => {
      const cal = deferredCalendar();
      cal.release();
      let inFlight = 0;
      let maxInFlight = 0;
      let first = true;
      const client: ReminderCalendarClient = {
        ...cal.client,
        patch: async (c, eventId, event) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          // The first editor's request is slow; without serialization the
          // second editor's newer patch would land first and be overwritten.
          if (first) {
            first = false;
            await new Promise((r) => setTimeout(r, 30));
          }
          const out = await cal.client.patch(c, eventId, event);
          inFlight -= 1;
          return out;
        },
      };
      const app = mount(userA, { resolveClient: async () => client });
      const created = await request(app)
        .post('/api/me/reminders')
        .send({ title: 'Start', inMinutes: 60 });
      const id = created.body.reminder.id;
      await Promise.all([
        request(app).patch(`/api/me/reminders/${id}`).send({ title: 'Older' }),
        new Promise((r) => setTimeout(r, 5)).then(() =>
          request(app).patch(`/api/me/reminders/${id}`).send({ title: 'Newer' }),
        ),
      ]);
      expect(maxInFlight).toBe(1);
      expect(cal.events.get(calendarEventIdFor(id)).summary).toBe('Newer');
      expect(getReminder(userA, id)?.calendar.status).toBe('synced');
    });

    it('does not retry an insert that is still in flight', async () => {
      const cal = deferredCalendar();
      const app = mount(userA, { resolveClient: async () => cal.client });
      const post = request(app)
        .post('/api/me/reminders')
        .send({ title: 'Leased', inMinutes: 30 })
        .then((r) => r);
      await cal.insertStarted;
      const spy = vi.fn();
      await runReminderCalendarMaintenance(
        { googleOAuth: null, resolveClient: async () => ({ ...cal.client, insert: spy }) },
        new Date(NOW.getTime() + 60 * 1000),
      );
      expect(spy).not.toHaveBeenCalled();
      cal.release();
      await post;
    });
  });

  it('401s with no identity', async () => {
    expect((await request(mount(null, noCalendar)).get('/api/me/reminders')).status).toBe(401);
  });
});

describe('reminder scheduler and notifications', () => {
  it('fires each due reminder exactly once', async () => {
    const due = createReminder({
      userId: userA,
      title: 'Due',
      remindAt: '2026-10-16T11:59:00.000Z',
    });
    createReminder({ userId: userA, title: 'Later', remindAt: '2026-10-16T13:00:00.000Z' });
    const deliver = vi.fn().mockResolvedValue(true);
    const first = await fireDueReminders({ broadcast, deliver }, NOW);
    expect(first.fired.map((r) => r.id)).toEqual([due.id]);
    expect(first.delivered).toBe(1);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ id: due.id }), broadcast);
    const later = new Date(NOW.getTime() + 10 * 60 * 1000);
    expect(await fireDueReminders({ broadcast, deliver }, later)).toEqual({
      fired: [],
      delivered: 0,
    });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('still delivers a reminder whose delivery was interrupted after the claim', async () => {
    const due = createReminder({
      userId: userA,
      title: 'Owed',
      remindAt: '2026-10-16T11:59:00.000Z',
    });
    // The process dies right after the claim committed: nothing delivered.
    expect(claimDueReminder(due.id, NOW)?.status).toBe('fired');

    const deliver = vi.fn().mockResolvedValue(true);
    // Within the claiming tick's lease another tick leaves it alone...
    await fireDueReminders({ broadcast, deliver }, new Date(NOW.getTime() + 30 * 1000));
    expect(deliver).not.toHaveBeenCalled();
    // ...after it lapses, a later tick delivers it.
    const later = new Date(NOW.getTime() + 3 * 60 * 1000);
    expect((await fireDueReminders({ broadcast, deliver }, later)).delivered).toBe(1);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ id: due.id }), broadcast);
    await fireDueReminders({ broadcast, deliver }, new Date(later.getTime() + 10 * 60 * 1000));
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  for (const change of ['dismissed', 'snoozed'] as const) {
    it(`does not send a queued delivery for a reminder ${change} while an earlier one stalls`, async () => {
      const a = createReminder({ userId: userA, title: 'A', remindAt: '2026-10-16T11:58:00.000Z' });
      const b = createReminder({ userId: userA, title: 'B', remindAt: '2026-10-16T11:59:00.000Z' });
      // Both fired earlier and their deliveries were interrupted (leases lapse).
      claimDueReminder(a.id, new Date('2026-10-16T11:58:30.000Z'));
      claimDueReminder(b.id, new Date('2026-10-16T11:59:30.000Z'));

      let releaseA: () => void = () => {};
      let aStarted: () => void = () => {};
      const started = new Promise<void>((r) => (aStarted = r));
      const deliver = vi.fn(async (reminder: { id: string }) => {
        if (reminder.id === a.id) {
          aStarted();
          await new Promise<void>((r) => (releaseA = r));
        }
        return true;
      });
      const tick = fireDueReminders({ broadcast, deliver }, new Date('2026-10-16T12:05:00.000Z'));
      await started;
      // While A's delivery is stuck, the user acts on B.
      if (change === 'dismissed') {
        updateReminder(userA, b.id, { status: 'dismissed', now: NOW });
      } else {
        updateReminder(userA, b.id, { remindAt: '2026-10-16T13:00:00.000Z', now: NOW });
      }
      releaseA();
      const result = await tick;
      expect(deliver.mock.calls.map(([r]) => r.id)).toEqual([a.id]);
      expect(result.delivered).toBe(1);
    });
  }

  it('delivers only the stalled reminder to the inbox when others change meanwhile', async () => {
    const mk = (title: string, at: string) =>
      createReminder({ userId: userA, title, remindAt: at });
    const a = mk('Stall A', '2026-10-16T11:57:00.000Z');
    const b = mk('Dismiss B', '2026-10-16T11:58:00.000Z');
    const c = mk('Snooze C', '2026-10-16T11:59:00.000Z');
    for (const r of [a, b, c]) claimDueReminder(r.id, new Date(Date.parse(r.remindAt) + 1000));

    let releaseA: () => void = () => {};
    let aStarted: () => void = () => {};
    const started = new Promise<void>((r) => (aStarted = r));
    const deliver = vi.fn(async (reminder: any, bc: any) => {
      if (reminder.id === a.id) {
        aStarted();
        await new Promise<void>((r) => (releaseA = r));
      }
      return deliverReminderNotification(reminder, bc);
    });
    const at = new Date('2026-10-16T12:05:00.000Z');
    const tick = fireDueReminders({ broadcast, deliver }, at);
    await started;
    updateReminder(userA, b.id, { status: 'dismissed', now: at });
    updateReminder(userA, c.id, { remindAt: '2026-10-16T13:00:00.000Z', now: at });
    releaseA();
    expect((await tick).delivered).toBe(1);

    const titles = listNotifications(userA)
      .items.filter((n) => n.category === 'reminder')
      .map((n) => n.title);
    expect(titles).toEqual(['Reminder: Stall A']);
    // A is marked delivered: a later tick sends nothing more.
    deliver.mockClear();
    await fireDueReminders({ broadcast, deliver }, new Date(at.getTime() + 10 * 60 * 1000));
    expect(deliver).not.toHaveBeenCalled();
  });

  it('retries a failed delivery and writes the inbox row once', async () => {
    const due = createReminder({
      userId: userA,
      title: 'Flaky',
      remindAt: '2026-10-16T11:59:00.000Z',
    });
    let failNext = true;
    const deliver = vi.fn(async (reminder, b) => {
      if (failNext) {
        failNext = false;
        throw new Error('db busy');
      }
      return deliverReminderNotification(reminder, b);
    });
    const tick = (t: Date) => fireDueReminders({ broadcast, deliver }, t);
    expect((await tick(NOW)).delivered).toBe(0);
    const t2 = new Date(NOW.getTime() + 3 * 60 * 1000);
    expect((await tick(t2)).delivered).toBe(1);
    // A duplicate attempt (e.g. a crash after the insert) can't double the inbox row.
    await deliverReminderNotification(getReminder(userA, due.id)!, broadcast);
    const { items } = listNotifications(userA);
    expect(items.filter((n) => n.category === 'reminder')).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: 'Reminder: Flaky' });
  });

  it('owes a fresh delivery when a re-armed reminder fires again', async () => {
    const due = createReminder({
      userId: userA,
      title: 'Twice',
      remindAt: '2026-10-16T11:59:00.000Z',
    });
    const deliver = vi.fn().mockResolvedValue(true);
    await fireDueReminders({ broadcast, deliver }, NOW);
    updateReminder(userA, due.id, { remindAt: '2026-10-16T12:05:00.000Z', now: NOW });
    await fireDueReminders({ broadcast, deliver }, new Date('2026-10-16T12:06:00.000Z'));
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('maps reminder_due to a reminder notification for the owner only', async () => {
    const reminder = createReminder({
      userId: userA,
      title: 'Pay invoice',
      notes: 'Acme, net 30',
      remindAt: '2026-10-16T11:00:00.000Z',
    });
    const data = { type: REMINDER_DUE_EVENT, ownerUserId: userA, reminder };
    const intent = mapBroadcastToNotification(data);
    expect(intent).toMatchObject({
      category: 'reminder',
      title: 'Reminder: Pay invoice',
      body: 'Acme, net 30',
      recipients: { kind: 'self', userId: userA },
      sourceKey: `reminder:${reminder.id}:2026-10-16T11:00:00.000Z`,
    });

    const insert = vi.fn().mockReturnValue({ notification: { id: 'n1' }, created: true });
    const sent = vi.fn();
    const result = await handleBroadcastForNotifications(data, {
      broadcast: sent,
      insert,
      countUnread: () => 1,
      getPrefs: () => ({ in_app: true, desktop: true, push: false, isDefault: true }),
      getAllTokens: () => [],
    } as never);
    expect(result.recipients).toEqual([userA]);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: userA,
        category: 'reminder',
        title: 'Reminder: Pay invoice',
      }),
    );
    expect(sent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'notification_created', ownerUserId: userA, desktop: true }),
    );
  });

  it('delivers reminder WS events only to the owner', () => {
    const deps = {
      resolveProjectId: () => null,
      findProject: () => null,
      getSessionOwner: () => null,
    };
    const evt = { type: 'reminder_update', ownerUserId: userA };
    expect(shouldDeliverBroadcast(evt, { userId: userA } as never, deps)).toBe(true);
    expect(shouldDeliverBroadcast(evt, { userId: userB } as never, deps)).toBe(false);
    expect(shouldDeliverBroadcast({ type: 'reminder_due' }, { userId: userA } as never, deps)).toBe(
      false,
    );
  });
});
