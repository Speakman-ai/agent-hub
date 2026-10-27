/**
 * Unit tests for `computeDayWindow` — the calendar day-boundary math behind the
 * dashboard's "today's events" read. Locks the timezone-aware bucketing so
 * events near a user's local midnight land on the right day (reviewer note:
 * UTC-day default vs. an explicit `tz`).
 */
import { describe, it, expect, vi } from 'vitest';
import type { gmail_v1 } from 'googleapis';
import {
  computeDayWindow,
  shapeMailMessage,
  readRecentMessages,
  mergeDashboardAccountReads,
  type DashboardAccountRead,
  type DashboardGoogleAccount,
} from './me-dashboard-google.js';

/** Minimal mock of the Gmail client surface `readRecentMessages` touches. */
function mockGmail(opts: {
  list: gmail_v1.Schema$ListMessagesResponse | Error;
  get: (id: string) => gmail_v1.Schema$Message | Error;
}): { gmail: gmail_v1.Gmail; listArgs: any[] } {
  const listArgs: any[] = [];
  const gmail = {
    users: {
      messages: {
        list: vi.fn(async (args: any) => {
          listArgs.push(args);
          if (opts.list instanceof Error) throw opts.list;
          return { data: opts.list };
        }),
        get: vi.fn(async (args: any) => {
          const out = opts.get(args.id);
          if (out instanceof Error) throw out;
          return { data: out };
        }),
      },
    },
  } as unknown as gmail_v1.Gmail;
  return { gmail, listArgs };
}

describe('computeDayWindow', () => {
  it('defaults to the UTC calendar day of `now`', () => {
    const now = new Date('2026-07-07T15:30:00Z');
    const w = computeDayWindow({ now });
    expect(w).toEqual({
      date: '2026-07-07',
      timeMin: '2026-07-07T00:00:00.000Z',
      timeMax: '2026-07-08T00:00:00.000Z',
    });
  });

  it('honours an explicit UTC `date` override', () => {
    const w = computeDayWindow({ now: new Date('2026-07-07T15:30:00Z'), date: '2026-12-25' });
    expect(w.date).toBe('2026-12-25');
    expect(w.timeMin).toBe('2026-12-25T00:00:00.000Z');
    expect(w.timeMax).toBe('2026-12-26T00:00:00.000Z');
  });

  it('brackets the local day for a west-of-UTC zone (America/New_York, DST)', () => {
    // 2026-07-07 is EDT (UTC-4): local midnight = 04:00Z, next local midnight = 04:00Z+1d.
    const w = computeDayWindow({
      now: new Date('2026-07-07T12:00:00Z'),
      timeZone: 'America/New_York',
    });
    expect(w.date).toBe('2026-07-07');
    expect(w.timeMin).toBe('2026-07-07T04:00:00.000Z');
    expect(w.timeMax).toBe('2026-07-08T04:00:00.000Z');
  });

  it('resolves "today" in the target zone, not UTC, near the date line', () => {
    // 2026-07-07T22:00Z is already 2026-07-08 07:00 in Tokyo (UTC+9).
    const w = computeDayWindow({ now: new Date('2026-07-07T22:00:00Z'), timeZone: 'Asia/Tokyo' });
    expect(w.date).toBe('2026-07-08');
    // Tokyo local midnight of 07-08 = 2026-07-07T15:00Z.
    expect(w.timeMin).toBe('2026-07-07T15:00:00.000Z');
    expect(w.timeMax).toBe('2026-07-08T15:00:00.000Z');
  });

  it('spans 23h across a spring-forward DST transition', () => {
    // America/New_York springs forward 2026-03-08 (EST→EDT): the local day is 23h.
    const w = computeDayWindow({
      now: new Date('2026-03-08T12:00:00Z'),
      timeZone: 'America/New_York',
    });
    expect(w.timeMin).toBe('2026-03-08T05:00:00.000Z'); // EST midnight
    expect(w.timeMax).toBe('2026-03-09T04:00:00.000Z'); // EDT midnight
    const hours = (Date.parse(w.timeMax) - Date.parse(w.timeMin)) / 3_600_000;
    expect(hours).toBe(23);
  });

  it('falls back to the UTC day when the zone is unrecognised', () => {
    const now = new Date('2026-07-07T15:30:00Z');
    const w = computeDayWindow({ now, timeZone: 'Not/AZone' });
    expect(w).toEqual({
      date: '2026-07-07',
      timeMin: '2026-07-07T00:00:00.000Z',
      timeMax: '2026-07-08T00:00:00.000Z',
    });
  });
});

describe('shapeMailMessage', () => {
  it('trims a metadata-format Gmail message to a dashboard row', () => {
    const row = shapeMailMessage({
      id: 'm1',
      threadId: 'th1',
      snippet: 'Are you free…',
      internalDate: '1783065600000',
      labelIds: ['INBOX', 'UNREAD'],
      payload: {
        headers: [
          { name: 'From', value: 'Jane Doe <jane@example.com>' },
          { name: 'Subject', value: 'Lunch tomorrow?' },
          { name: 'Date', value: 'Tue, 07 Jul 2026 08:00:00 +0000' },
        ],
      },
    });
    expect(row).toEqual({
      accountId: '',
      accountEmail: '',
      id: 'm1',
      threadId: 'th1',
      from: 'Jane Doe <jane@example.com>',
      subject: 'Lunch tomorrow?',
      snippet: 'Are you free…',
      date: 'Tue, 07 Jul 2026 08:00:00 +0000',
      internalDate: '1783065600000',
      unread: true,
    });
  });

  it('matches header names case-insensitively and defaults missing fields', () => {
    const row = shapeMailMessage({
      id: 'm2',
      payload: { headers: [{ name: 'subject', value: 'Hi' }] },
    });
    expect(row.subject).toBe('Hi');
    expect(row.from).toBeNull();
    expect(row.threadId).toBeNull();
    expect(row.snippet).toBeNull();
    expect(row.internalDate).toBeNull();
    // No UNREAD label → read.
    expect(row.unread).toBe(false);
  });
});

describe('readRecentMessages', () => {
  const msg = (id: string, subject: string): gmail_v1.Schema$Message => ({
    id,
    threadId: `t-${id}`,
    labelIds: ['INBOX'],
    payload: { headers: [{ name: 'Subject', value: subject }] },
  });

  it('scopes the list to INBOX and preserves newest-first order', async () => {
    const { gmail, listArgs } = mockGmail({
      list: { messages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      get: (id) => msg(id, `subject-${id}`),
    });
    const rows = await readRecentMessages(gmail);
    // Only received mail: the list call must carry the INBOX label filter.
    expect(listArgs[0].labelIds).toEqual(['INBOX']);
    // Order follows messages.list (newest-first), not resolution order.
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(rows.map((r) => r.subject)).toEqual(['subject-a', 'subject-b', 'subject-c']);
  });

  it('drops only the failed message when a single get rejects', async () => {
    const { gmail } = mockGmail({
      list: { messages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      get: (id) => (id === 'b' ? new Error('rate limited') : msg(id, `subject-${id}`)),
    });
    const rows = await readRecentMessages(gmail);
    // 'b' failed but 'a' and 'c' still render — one bad get no longer wipes all.
    expect(rows.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('degrades to [] when the list call itself fails', async () => {
    const { gmail } = mockGmail({
      list: new Error('token expired'),
      get: (id) => msg(id, id),
    });
    await expect(readRecentMessages(gmail)).resolves.toEqual([]);
  });

  it('returns [] for an empty inbox', async () => {
    const { gmail } = mockGmail({ list: {}, get: (id) => msg(id, id) });
    await expect(readRecentMessages(gmail)).resolves.toEqual([]);
  });
});

describe('mergeDashboardAccountReads', () => {
  const account = (over: Partial<DashboardGoogleAccount>): DashboardGoogleAccount => ({
    accountId: 'acc',
    email: 'a@x.com',
    isDefault: false,
    reconnectRequired: false,
    calendarScopeGranted: true,
    mailScopeGranted: true,
    calendarError: null,
    mailError: null,
    unread: null,
    starred: null,
    important: null,
    ...over,
  });
  const event = (accountId: string, id: string, start: string) => ({
    accountId,
    accountEmail: `${accountId}@x.com`,
    id,
    summary: id,
    location: null,
    allDay: false,
    start,
    end: null,
    htmlLink: null,
    hangoutLink: null,
  });
  const message = (accountId: string, id: string, internalDate: string) => ({
    accountId,
    accountEmail: `${accountId}@x.com`,
    id,
    threadId: id,
    from: null,
    subject: id,
    snippet: null,
    date: null,
    internalDate,
    unread: true,
  });
  const calendar = (events: ReturnType<typeof event>[], error: string | null = null) => ({
    scopeGranted: true,
    date: '2026-07-07',
    timeZone: 'UTC',
    events,
    error,
  });
  const mail = (
    counts: [number, number, number],
    messages: ReturnType<typeof message>[],
    error: string | null = null,
  ) => ({
    scopeGranted: true,
    unread: counts[0],
    starred: counts[1],
    important: counts[2],
    messages,
    error,
  });

  it('merges events by start and sums mail counts across accounts', () => {
    const reads: DashboardAccountRead[] = [
      {
        account: account({ accountId: 'work', email: 'me@work.com', isDefault: true }),
        calendar: calendar([event('work', 'w1', '2026-07-07T15:00:00Z')]),
        mail: mail([2, 1, 0], [message('work', 'mw', '200')]),
      },
      {
        account: account({ accountId: 'home', email: 'me@home.com' }),
        calendar: calendar([event('home', 'h1', '2026-07-07T09:00:00Z')]),
        mail: mail([3, 0, 4], [message('home', 'mh', '300')]),
      },
    ];
    const out = mergeDashboardAccountReads(reads);
    expect(out.email).toBe('me@work.com');
    expect(out.calendar.events.map((e) => [e.id, e.accountId])).toEqual([
      ['h1', 'home'],
      ['w1', 'work'],
    ]);
    expect([out.mail.unread, out.mail.starred, out.mail.important]).toEqual([5, 1, 4]);
    expect(out.mail.messages.map((m) => m.id)).toEqual(['mh', 'mw']);
    expect(out.accounts).toHaveLength(2);
  });

  it('keeps the pane up when one account fails or needs reconnecting', () => {
    const out = mergeDashboardAccountReads([
      {
        account: account({ accountId: 'work', isDefault: true, reconnectRequired: true }),
        calendar: null,
        mail: null,
      },
      {
        account: account({ accountId: 'home', calendarError: 'boom' }),
        calendar: calendar([], 'boom'),
        mail: mail([1, 0, 0], []),
      },
      {
        account: account({ accountId: 'side' }),
        calendar: calendar([event('side', 's1', '2026-07-07T10:00:00Z')]),
        mail: null,
      },
    ]);
    expect(out.reconnectRequired).toBe(false);
    expect(out.calendar.error).toBeNull();
    expect(out.calendar.events.map((e) => e.id)).toEqual(['s1']);
    expect(out.mail.unread).toBe(1);
  });

  it('gates scopes per account: a reconnect-only account grants nothing', () => {
    const out = mergeDashboardAccountReads([
      {
        account: account({ accountId: 'a', isDefault: true, reconnectRequired: true }),
        calendar: null,
        mail: null,
      },
      {
        account: account({ accountId: 'b', calendarScopeGranted: false }),
        calendar: null,
        mail: mail([0, 0, 0], []),
      },
    ]);
    expect(out.calendar.scopeGranted).toBe(false);
    expect(out.mail.scopeGranted).toBe(true);
  });

  it('reports reconnect only when every account needs it, and errors only when all fail', () => {
    const out = mergeDashboardAccountReads([
      {
        account: account({ accountId: 'a', isDefault: true }),
        calendar: calendar([], 'one'),
        mail: mail([0, 0, 0], [], 'x'),
      },
    ]);
    expect(out.calendar.error).toBe('one');
    expect(out.mail.unread).toBeNull();
    const dead = mergeDashboardAccountReads([
      { account: account({ reconnectRequired: true }), calendar: null, mail: null },
    ]);
    expect(dead.reconnectRequired).toBe(true);
    expect(dead.connected).toBe(true);
  });
});
