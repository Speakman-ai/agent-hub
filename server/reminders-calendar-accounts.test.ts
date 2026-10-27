/**
 * Reminder calendar mirror across several linked Google accounts: new events
 * go to the default account, and later patches and deletes follow the
 * account that holds the event, even after the default moves. Removing an
 * account stops work on its events without touching the other account's.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { ReminderCalendarClient } from './reminders-calendar.js';

let TMP_DIR = '';
vi.mock('./config.js', () => ({
  default: {
    apiKey: null,
    get dataDir() {
      return TMP_DIR;
    },
  },
}));

const { initOrgsDb, setOrgsDbPathForTests } = await import('./orgs.js');
const { createUser } = await import('./users-store.js');
const { __resetSecretCryptoForTests } = await import('./secret-crypto.js');
const { upsertGoogleConnection, setDefaultGoogleConnection, deleteGoogleConnection } =
  await import('./google-connections-store.js');
const { createReminder, deleteReminder, getReminder, updateReminder, listDueCalendarCleanups } =
  await import('./reminders-store.js');
const {
  mirrorReminderToCalendar,
  processCalendarCleanup,
  runReminderCalendarEffect,
  resolveReminderCalendarClient,
} = await import('./reminders-calendar.js');

const NOW = new Date('2026-10-16T12:00:00.000Z');
const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

function link(userId: string, sub: string, email: string): string {
  return upsertGoogleConnection({
    userId,
    googleSub: sub,
    googleEmail: email,
    accessToken: 'at',
    tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken: 'rt',
    grantedScopes: [CAL_SCOPE],
  });
}

/** One fake calendar per account; calls are recorded by account id. */
function calendars() {
  const calls: Array<{ op: string; accountId: string | null; eventId: string }> = [];
  const clientFor = (accountId: string | null): ReminderCalendarClient => ({
    insert: async (_cal, event) => {
      calls.push({ op: 'insert', accountId, eventId: event.id as string });
      return { id: event.id, htmlLink: 'https://calendar.google.com/x' };
    },
    patch: async (_cal, eventId) => {
      calls.push({ op: 'patch', accountId, eventId });
      return { id: eventId };
    },
    remove: async (_cal, eventId) => {
      calls.push({ op: 'remove', accountId, eventId });
    },
  });
  return { calls, clientFor };
}

let userId = '';
let accountA = '';
let accountB = '';

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'reminder-accounts-'));
  __resetSecretCryptoForTests();
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  userId = createUser({ username: 'rem-multi', passwordHash: 'x' }).id;
  accountA = link(userId, 'sub-a', 'a@work.example');
  accountB = link(userId, 'sub-b', 'b@home.example');
});

async function mirrored(title: string, cal: ReturnType<typeof calendars>) {
  const reminder = createReminder({
    userId,
    title,
    remindAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    now: NOW,
  });
  const resolveClient = async (_uid: string, accountId: string | null) => cal.clientFor(accountId);
  const result = await mirrorReminderToCalendar(
    reminder,
    { googleOAuth: null, resolveClient },
    NOW,
  );
  if (result.kind !== 'live') throw new Error('reminder vanished');
  return { reminder: result.reminder, resolveClient };
}

describe('reminder calendar across accounts', () => {
  it('writes to the default account and records it on the reminder', async () => {
    const cal = calendars();
    const { reminder } = await mirrored('Standup', cal);
    expect(reminder.calendar).toMatchObject({ status: 'synced', accountId: accountA });
    expect(cal.calls).toEqual([{ op: 'insert', accountId: accountA, eventId: expect.any(String) }]);
  });

  it('patches and deletes on the original account after the default changes', async () => {
    const cal = calendars();
    const { reminder, resolveClient } = await mirrored('Dentist', cal);
    const deps = { googleOAuth: null, resolveClient };

    setDefaultGoogleConnection(userId, accountB);

    const edit = updateReminder(userId, reminder.id, { title: 'Dentist (moved)', now: NOW })!;
    await runReminderCalendarEffect(edit.reminder, edit.calendar, deps, NOW);
    expect(cal.calls.at(-1)).toMatchObject({ op: 'patch', accountId: accountA });

    const removed = deleteReminder(userId, reminder.id, NOW);
    expect(removed.cleanup?.accountId).toBe(accountA);
    expect(await processCalendarCleanup(removed.cleanup!, deps, NOW)).toBe(true);
    expect(cal.calls.at(-1)).toMatchObject({ op: 'remove', accountId: accountA });

    // A reminder created after the switch lands on the new default.
    const next = await mirrored('Gym', cal);
    expect(next.reminder.calendar.accountId).toBe(accountB);
    expect(cal.calls.at(-1)).toMatchObject({ op: 'insert', accountId: accountB });
  });

  it('removing an account stops work on its events and leaves the other account alone', async () => {
    const cal = calendars();
    const onA = await mirrored('On A', cal);
    const dismissedOnA = await mirrored('Dismissed on A', cal);
    setDefaultGoogleConnection(userId, accountB);
    const onB = await mirrored('On B', cal);
    // Queue a deletion on A's calendar that has not run yet.
    deleteReminder(userId, dismissedOnA.reminder.id, NOW);
    expect(listDueCalendarCleanups(NOW).map((c) => c.accountId)).toEqual([accountA]);

    deleteGoogleConnection(userId, { accountId: accountA });

    expect(getReminder(userId, onA.reminder.id)!.calendar).toMatchObject({
      status: 'skipped',
      eventId: null,
      error: 'Google account a@work.example was disconnected',
    });
    expect(listDueCalendarCleanups(NOW)).toEqual([]);
    expect(getReminder(userId, onB.reminder.id)!.calendar).toMatchObject({
      status: 'synced',
      accountId: accountB,
    });
  });

  it('the real resolver reports a removed account as gone, so no retry is queued', async () => {
    const oauth = { clientId: 'id', clientSecret: 'secret' } as never;
    deleteGoogleConnection(userId, { accountId: accountA });
    expect(await resolveReminderCalendarClient(userId, oauth, accountA)).toEqual({
      skip: 'The Google account that holds this event is no longer linked',
      accountGone: true,
    });
    const client = await resolveReminderCalendarClient(userId, oauth, accountB);
    expect('skip' in client).toBe(false);
  });
});
