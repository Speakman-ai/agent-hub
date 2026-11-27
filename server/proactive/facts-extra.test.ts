/**
 * Gmail/Calendar, infra/deploy and todo fact sources. No network: the
 * calendar reader is injected and the SSO cache is a temp directory.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import type { AppConfig, Project } from '../types.js';
import type { DashboardCalendarEvent, GoogleReader } from '../me-dashboard-google.js';

const { initOrgsDb, setOrgsDbPathForTests, getOrgsDb } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { initDb, getDb } = await import('../db.js');
const { createTodo } = await import('../user-todos-store.js');
const extra = await import('./facts-extra.js');
const events = await import('./events.js');

let userId = '';
const now = new Date('2026-11-27T12:00:00Z');
/** Stand-in for a connected account `acct` with calendar and Gmail scope. */
const linked = () => new Set(['acct']);

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'proactive-extra-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  userId = createUser({
    username: `x-${Math.random().toString(36).slice(2)}`,
    passwordHash: 'x',
  }).id;
});

function event(
  id: string,
  start: string,
  end: string,
  extraFields: Partial<Omit<DashboardCalendarEvent, 'id'>> = {},
): DashboardCalendarEvent & { id: string } {
  return {
    id,
    summary: `Event ${id}`,
    location: null,
    allDay: false,
    start,
    end,
    htmlLink: `https://calendar.example/${id}`,
    hangoutLink: null,
    accountId: 'acct',
    accountEmail: 'me@example.com',
    ...extraFields,
  };
}

describe('todo facts', () => {
  it('flags overdue planned todos and long-quiet unplanned ones', () => {
    const overdue = createTodo({ userId, title: 'File taxes', doDate: '2026-11-20' });
    createTodo({ userId, title: 'Due today', doDate: '2026-11-27' });
    const quiet = createTodo({ userId, title: 'Call the vendor' });
    getOrgsDb()
      .prepare('UPDATE user_todos SET updated_at = ? WHERE id = ?')
      .run('2026-11-10T00:00:00.000Z', quiet.id);
    const facts = extra.collectTodoFacts({ userId, timeZone: 'UTC', now });
    expect(facts.map((f) => [f.kind, f.id.split(':')[1]])).toEqual([
      ['todo_overdue', overdue.id],
      ['follow_up', quiet.id],
    ]);
  });

  it('uses the user time zone for "today"', () => {
    createTodo({ userId, title: 'Late night', doDate: '2026-11-26' });
    // 03:00 UTC on the 27th is still the 26th in Los Angeles.
    const facts = extra.collectTodoFacts({
      userId,
      timeZone: 'America/Los_Angeles',
      now: new Date('2026-11-27T03:00:00Z'),
    });
    expect(facts.filter((f) => f.kind === 'todo_overdue')).toEqual([]);
  });
});

describe('calendar facts', () => {
  it('offers prep for a meeting starting soon and spots overlaps', () => {
    const facts = extra.calendarFactsFromEvents(
      [
        event('a', '2026-11-27T13:00:00Z', '2026-11-27T14:00:00Z'),
        event('b', '2026-11-27T13:30:00Z', '2026-11-27T14:30:00Z'),
        event('c', '2026-11-27T18:00:00Z', '2026-11-27T19:00:00Z'),
        event('d', '2026-11-27T00:00:00Z', '2026-11-28T00:00:00Z', { allDay: true }),
      ],
      now,
    );
    expect(facts.filter((f) => f.kind === 'meeting_prep').map((f) => f.target.url)).toEqual([
      'https://calendar.example/a',
      'https://calendar.example/b',
    ]);
    expect(facts.filter((f) => f.kind === 'calendar_conflict').map((f) => f.id)).toEqual([
      'calendar_conflict:acct:a:acct:b:2026-11-27T13:00:00Z:2026-11-27T13:30:00Z',
    ]);
    expect(facts.every((f) => f.untrusted)).toBe(true);
  });

  it('snapshot reads only the persisted cache; the refresh step does the network read', async () => {
    const read = vi.fn(async () => ({
      connected: true,
      calendar: { events: [event('a', '2026-11-27T12:30:00Z', '2026-11-27T13:00:00Z')] },
    })) as unknown as GoogleReader;
    // Nothing cached yet: the snapshot finds no calendar facts and reads nothing.
    expect(extra.collectGoogleFacts({ userId, now, access: linked })).toEqual([]);
    expect(read).not.toHaveBeenCalled();

    const cfg = {} as AppConfig;
    expect(
      await extra.refreshProactiveCalendarCache({
        userId,
        access: linked,
        config: cfg,
        timeZone: 'UTC',
        now,
        readGoogle: read,
      }),
    ).toBe(true);
    expect(extra.collectGoogleFacts({ userId, now, access: linked }).map((f) => f.kind)).toEqual([
      'meeting_prep',
    ]);

    // Fresh cache: a second refresh inside the window skips the read.
    expect(
      await extra.refreshProactiveCalendarCache({
        userId,
        access: linked,
        config: cfg,
        timeZone: 'UTC',
        now,
        readGoogle: read,
      }),
    ).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('refreshes a fresh cache again when the time zone changed', async () => {
    const read = vi.fn(async () => ({
      connected: true,
      calendar: { events: [event('a', '2026-11-27T12:30:00Z', '2026-11-27T13:00:00Z')] },
    })) as unknown as GoogleReader;
    const cfg = {} as AppConfig;
    await extra.refreshProactiveCalendarCache({
      userId,
      access: linked,
      config: cfg,
      timeZone: 'UTC',
      now,
      readGoogle: read,
    });
    expect(
      await extra.refreshProactiveCalendarCache({
        userId,
        access: linked,
        config: cfg,
        timeZone: 'UTC',
        now,
        readGoogle: read,
      }),
    ).toBe(false);
    expect(
      await extra.refreshProactiveCalendarCache({
        userId,
        access: linked,
        config: cfg,
        timeZone: 'Pacific/Auckland',
        now,
        readGoogle: read,
      }),
    ).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps the cached events when a refresh fails', async () => {
    const ok = (async () => ({
      connected: true,
      calendar: { events: [event('a', '2026-11-27T12:30:00Z', '2026-11-27T13:00:00Z')] },
    })) as unknown as GoogleReader;
    await extra.refreshProactiveCalendarCache({
      userId,
      access: linked,
      config: {} as AppConfig,
      timeZone: 'UTC',
      now,
      readGoogle: ok,
    });
    const failed = await extra.refreshProactiveCalendarCache({
      userId,
      access: linked,
      config: {} as AppConfig,
      timeZone: 'UTC',
      now,
      force: true,
      readGoogle: async () => {
        throw new Error('offline');
      },
    });
    expect(failed).toBe(false);
    expect(extra.collectGoogleFacts({ userId, now, access: linked })).toHaveLength(1);
  });
});

describe('reminder facts', () => {
  function reminder(id: string, status: string, remindAt: string, firedAt: string | null) {
    getOrgsDb()
      .prepare(
        `INSERT INTO reminders (id, user_id, title, notes, remind_at, status, created_by, fired_at,
           created_at, updated_at)
         VALUES (?, ?, ?, '', ?, ?, 'user', ?, ?, ?)`,
      )
      .run(id, userId, `Reminder ${id}`, remindAt, status, firedAt, remindAt, remindAt);
  }

  it('offers follow-ups for unhandled fired reminders and missed pending ones', () => {
    reminder('fired-old', 'fired', '2026-11-27T08:00:00.000Z', '2026-11-27T08:00:00.000Z');
    reminder('fired-new', 'fired', '2026-11-27T11:30:00.000Z', '2026-11-27T11:30:00.000Z');
    reminder('missed', 'pending', '2026-11-27T10:00:00.000Z', null);
    reminder('future', 'pending', '2026-11-27T18:00:00.000Z', null);
    reminder('done', 'dismissed', '2026-11-27T07:00:00.000Z', '2026-11-27T07:00:00.000Z');
    const facts = extra.collectReminderFacts({ userId, now });
    expect(facts.map((f) => f.id.split(':')[2]).sort()).toEqual(['fired-old', 'missed']);
    expect(facts.every((f) => f.kind === 'follow_up')).toBe(true);
  });
});

describe('Google data of disconnected accounts', () => {
  const okRead = (async () => ({
    connected: true,
    calendar: {
      events: [
        event('w', '2026-11-27T12:30:00Z', '2026-11-27T13:00:00Z', { accountId: 'work' }),
        event('p', '2026-11-27T12:40:00Z', '2026-11-27T13:10:00Z', { accountId: 'personal' }),
      ],
    },
  })) as unknown as GoogleReader;
  const cfg = {} as AppConfig;

  it('stops collecting cached events as soon as the account is disconnected', async () => {
    let connected = new Set(['work', 'personal']);
    const access = () => connected;
    await extra.refreshProactiveCalendarCache({
      userId,
      config: cfg,
      timeZone: 'UTC',
      now,
      readGoogle: okRead,
      access,
    });
    expect(
      extra.collectGoogleFacts({ userId, now, access }).filter((f) => f.kind === 'meeting_prep'),
    ).toHaveLength(2);

    // Disconnect "personal": the very next collection ignores its cached rows,
    // even before any refresh runs.
    connected = new Set(['work']);
    const facts = extra.collectGoogleFacts({ userId, now, access });
    expect(facts.map((f) => f.target.accountId)).toEqual(['work']);
    expect(facts.some((f) => f.kind === 'calendar_conflict')).toBe(false);
  });

  it('a refresh removes rows of disconnected accounts even when the read fails', async () => {
    let connected = new Set(['work', 'personal']);
    const access = () => connected;
    await extra.refreshProactiveCalendarCache({
      userId,
      config: cfg,
      timeZone: 'UTC',
      now,
      readGoogle: okRead,
      access,
    });
    connected = new Set(['work']);
    const failed = await extra.refreshProactiveCalendarCache({
      userId,
      config: cfg,
      timeZone: 'UTC',
      now,
      force: true,
      access,
      readGoogle: async () => {
        throw new Error('offline');
      },
    });
    expect(failed).toBe(false);
    // The transient failure keeps "work"; "personal" is gone from the cache itself.
    const all = extra.collectGoogleFacts({
      userId,
      now,
      access: () => new Set(['work', 'personal']),
    });
    expect(all.map((f) => f.target.accountId)).toEqual(['work']);
  });

  it('with no linked account left, refresh clears the cache without reading', async () => {
    let connected = new Set(['work']);
    const access = () => connected;
    await extra.refreshProactiveCalendarCache({
      userId,
      config: cfg,
      timeZone: 'UTC',
      now,
      readGoogle: okRead,
      access,
    });
    connected = new Set();
    const read = vi.fn(okRead);
    expect(
      await extra.refreshProactiveCalendarCache({
        userId,
        config: cfg,
        timeZone: 'UTC',
        now,
        readGoogle: read,
        access,
      }),
    ).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(extra.collectGoogleFacts({ userId, now, access: () => new Set(['work']) })).toEqual([]);
  });

  it('the default access check reads real connections and their scopes', () => {
    // No linked accounts for this user: nothing may be read.
    expect(extra.googleAccountsWithAccess(userId, 'calendar').size).toBe(0);
    expect(extra.googleAccountsWithAccess(userId, 'gmail').size).toBe(0);
  });
});

describe('occurrence markers never repeat', () => {
  it('a conflict edited back to its old times is a new occurrence', () => {
    const pair = (updated: string) =>
      extra
        .calendarFactsFromEvents(
          [
            event('x', '2026-11-27T15:00:00Z', '2026-11-27T16:00:00Z', { updated }),
            event('y', '2026-11-27T15:30:00Z', '2026-11-27T16:30:00Z', { updated }),
          ],
          now,
        )
        .find((f) => f.kind === 'calendar_conflict')!;
    // Same times both times; only Google's last-modified differs.
    expect(pair('2026-11-27T09:00:00.000Z').id).not.toBe(pair('2026-11-27T11:00:00.000Z').id);
  });

  it('a reminder snoozed back to the same time is a new occurrence', () => {
    getOrgsDb()
      .prepare(
        `INSERT INTO reminders (id, user_id, title, notes, remind_at, status, created_by, fired_at, created_at, updated_at)
         VALUES ('r1', ?, 'Pay rent', '', '2026-11-27T08:00:00.000Z', 'fired', 'user',
                 '2026-11-27T08:00:00.000Z', '2026-11-27T08:00:00.000Z', '2026-11-27T08:00:00.000Z')`,
      )
      .run(userId);
    const [before] = extra.collectReminderFacts({ userId, now });
    // Any write (a snooze and a snooze back) bumps the row's revision.
    getOrgsDb().prepare(`UPDATE reminders SET notes = 'x' WHERE id = 'r1'`).run();
    getOrgsDb().prepare(`UPDATE reminders SET notes = '' WHERE id = 'r1'`).run();
    const [after] = extra.collectReminderFacts({ userId, now });
    expect(after.target.reminderId).toBe('r1');
    expect(after.id).not.toBe(before.id);
  });
});

describe('calendar conflicts that already ended', () => {
  it('skips an overlap that finished while the longer event is still running', () => {
    const facts = extra.calendarFactsFromEvents(
      [
        event('long', '2026-11-27T10:00:00Z', '2026-11-27T16:00:00Z'),
        event('short', '2026-11-27T10:30:00Z', '2026-11-27T11:00:00Z'),
      ],
      now, // 12:00, an hour after the overlap ended
    );
    expect(facts.filter((f) => f.kind === 'calendar_conflict')).toEqual([]);
  });

  it('still reports an overlap that is in progress or upcoming', () => {
    const facts = extra.calendarFactsFromEvents(
      [
        event('long', '2026-11-27T10:00:00Z', '2026-11-27T16:00:00Z'),
        event('now', '2026-11-27T11:30:00Z', '2026-11-27T12:30:00Z'),
        event('later', '2026-11-27T14:00:00Z', '2026-11-27T15:00:00Z'),
      ],
      now,
    );
    expect(
      facts.filter((f) => f.kind === 'calendar_conflict').map((f) => f.target.secondEventId),
    ).toEqual(['now', 'later']);
  });
});

describe('calendar conflicts across accounts', () => {
  it('keeps both accounts in the target, detail and dedupe key', () => {
    const [conflict] = extra
      .calendarFactsFromEvents(
        [
          event('w1', '2026-11-27T15:00:00Z', '2026-11-27T16:00:00Z', {
            accountId: 'work',
            accountEmail: 'me@work.example',
          }),
          event('p1', '2026-11-27T15:30:00Z', '2026-11-27T16:30:00Z', {
            accountId: 'personal',
            accountEmail: 'me@home.example',
          }),
        ],
        now,
      )
      .filter((f) => f.kind === 'calendar_conflict');
    expect(conflict.id).toBe(
      'calendar_conflict:work:w1:personal:p1:2026-11-27T15:00:00Z:2026-11-27T15:30:00Z',
    );
    expect(conflict.target).toMatchObject({
      eventId: 'w1',
      accountId: 'work',
      secondEventId: 'p1',
      secondAccountId: 'personal',
    });
    expect(conflict.detail).toMatchObject({
      firstAccount: 'me@work.example',
      secondAccount: 'me@home.example',
    });
  });

  it('does not report one meeting shown on two linked calendars as a conflict', () => {
    const facts = extra.calendarFactsFromEvents(
      [
        event('m1', '2026-11-27T15:00:00Z', '2026-11-27T16:00:00Z', { accountId: 'work' }),
        event('m1', '2026-11-27T15:00:00Z', '2026-11-27T16:00:00Z', { accountId: 'personal' }),
      ],
      now,
    );
    expect(facts.filter((f) => f.kind === 'calendar_conflict')).toEqual([]);
  });
});

describe('deploy facts', () => {
  const project = { id: 'p1', name: 'Shop' } as Project;

  function deploy(id: string, env: string, status: string, createdAt: string, by: string | null) {
    getDb()
      .prepare(
        `INSERT INTO deployments (id, project_id, environment, ref, status, triggered_by, error, created_at)
         VALUES (?, 'p1', ?, 'abcdef123456789', ?, ?, 'boom', ?)`,
      )
      .run(id, env, status, by, createdAt);
  }

  it('reports the latest failed deploy per environment the user triggered', () => {
    deploy('d1', 'prod', 'error', '2026-11-27 10:00:00', userId);
    deploy('d2', 'dev', 'error', '2026-11-27 09:00:00', userId);
    deploy('d3', 'dev', 'success', '2026-11-27 11:00:00', userId);
    deploy('d4', 'stage', 'error', '2026-11-27 11:00:00', 'someone-else');
    const facts = extra.collectDeployFacts({
      userId,
      caller: { userId, localBypass: true },
      getProjects: () => [project],
      now,
    });
    expect(facts.map((f) => f.id)).toEqual(['deploy_failed:d1']);
    expect(facts[0].summary).toContain('prod');
  });
});

describe('AWS SSO facts', () => {
  it('refresh copies expiry metadata; the snapshot reads only the stored rows', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'proactive-home-'));
    const cache = path.join(home, '.aws', 'sso', 'cache');
    mkdirSync(cache, { recursive: true });
    writeFileSync(
      path.join(cache, 'soon.json'),
      JSON.stringify({
        accessToken: 't',
        expiresAt: '2026-11-27T13:00:00Z',
        startUrl: 'https://acme.awsapps.com/start',
      }),
    );
    writeFileSync(
      path.join(cache, 'later.json'),
      JSON.stringify({ accessToken: 't', expiresAt: '2026-11-28T13:00:00Z' }),
    );
    writeFileSync(
      path.join(cache, 'client.json'),
      JSON.stringify({ clientId: 'x', expiresAt: '2026-11-27T12:30:00Z' }),
    );
    // Before a refresh the snapshot has nothing; it never reads the files.
    expect(extra.collectAwsSsoFacts({ userId, now })).toEqual([]);
    expect(
      extra.refreshAwsSsoExpiry({ userId, dataDir: '/unused', now, homeFor: () => home }),
    ).toBe(2);
    rmSync(home, { recursive: true, force: true });
    const facts = extra.collectAwsSsoFacts({ userId, now });
    expect(facts).toHaveLength(1);
    expect(facts[0].summary).toContain('60 minutes');
    expect(JSON.stringify(facts)).not.toContain('accessToken');
  });
});

describe('infra and deploy event triggers', () => {
  it('maps a failed deployment to a check for whoever triggered it', () => {
    const triggers = events.mapBroadcastToProactiveTriggers({
      type: 'deployment_update',
      deployment: { id: 'd1', status: 'error', triggered_by: userId },
    });
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({ userId, area: 'infra' });
    expect(
      triggers[0].matches({
        id: 'deploy_failed:d1',
        kind: 'deploy_failed',
        fingerprint: '',
        summary: '',
        target: { deploymentId: 'd1' },
      }),
    ).toBe(true);
    expect(
      events.mapBroadcastToProactiveTriggers({
        type: 'deployment_update',
        deployment: { id: 'd1', status: 'success', triggered_by: userId },
      }),
    ).toEqual([]);
  });

  it('ignores infra transitions back to OK', () => {
    expect(
      events.mapBroadcastToProactiveTriggers({
        type: 'infra_alert_transition',
        projectId: 'p1',
        alertId: 'a1',
        toState: 'OK',
      }),
    ).toEqual([]);
  });
});
