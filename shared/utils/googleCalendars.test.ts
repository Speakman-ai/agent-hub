import { describe, it, expect, vi } from 'vitest';
import {
  CALENDAR_LIST_READONLY_SCOPE,
  CALENDAR_LIST_SCOPE_REQUIRED_CODE,
  calendarKey,
  calendarLoadWarning,
  canEditCalendarEvent,
  canWriteCalendar,
  fetchAcrossCalendars,
  withCalendarMeta,
  isCalendarVisible,
  loadAccountCalendars,
  parseCalendarVisibility,
  toggleCalendarVisibility,
  withoutHiddenCalendars,
  type AccountCalendars,
  type GoogleCalendarEntry,
} from './googleCalendars';
import type { LinkedGoogleAccount } from './googleAccounts';

const EVENTS = 'https://www.googleapis.com/auth/calendar.events';

function account(id: string, scopes = [EVENTS, CALENDAR_LIST_READONLY_SCOPE]): LinkedGoogleAccount {
  return {
    accountId: id,
    email: `${id}@example.com`,
    isDefault: id === 'a',
    grantedScopes: scopes,
  };
}

function cal(id: string, extra: Partial<GoogleCalendarEntry> = {}): GoogleCalendarEntry {
  return {
    id,
    summary: id,
    primary: false,
    selected: true,
    accessRole: 'reader',
    backgroundColor: null,
    ...extra,
  };
}

describe('loadAccountCalendars', () => {
  it('lists calendars for accounts with the list scope', async () => {
    const list = vi.fn().mockResolvedValue({
      calendars: [
        { id: 'me@example.com', summary: 'Me', primary: true, selected: true, accessRole: 'owner' },
        { id: 'spouse@gmail.com', summary: 'Spouse', selected: true, accessRole: 'reader' },
      ],
    });
    const [result] = await loadAccountCalendars([account('a')], list);
    expect(result.listGranted).toBe(true);
    expect(result.calendars.map((c) => c.id)).toEqual(['me@example.com', 'spouse@gmail.com']);
  });

  it('falls back to primary without calling the server when the scope is missing', async () => {
    const list = vi.fn();
    const [result] = await loadAccountCalendars([account('a', [EVENTS])], list);
    expect(list).not.toHaveBeenCalled();
    expect(result.listGranted).toBe(false);
    expect(result.calendars).toEqual([
      expect.objectContaining({ id: 'primary', primary: true, accessRole: 'owner' }),
    ]);
  });

  it('treats a scope-required error as not granted and other errors as a failure', async () => {
    const scopeErr = Object.assign(new Error('nope'), { code: CALENDAR_LIST_SCOPE_REQUIRED_CODE });
    const [scope, broken] = await loadAccountCalendars(
      [account('a'), account('b')],
      vi.fn().mockRejectedValueOnce(scopeErr).mockRejectedValueOnce(new Error('boom')),
    );
    expect(scope).toMatchObject({ listGranted: false });
    expect(scope.error).toBeUndefined();
    expect(broken).toMatchObject({ listGranted: true, error: 'boom' });
    expect(broken.calendars[0].id).toBe('primary');
  });
});

describe('visibility', () => {
  it("follows Google's checkbox until the user flips it here", () => {
    const shared = cal('spouse@gmail.com', { selected: true });
    const unchecked = cal('holidays', { selected: false });
    expect(isCalendarVisible('a', shared, {})).toBe(true);
    expect(isCalendarVisible('a', unchecked, {})).toBe(false);
    // Unchecking the primary in Google hides it here too.
    expect(isCalendarVisible('a', cal('p', { primary: true, selected: false }), {})).toBe(false);

    const hidden = toggleCalendarVisibility({}, 'a', shared);
    expect(hidden[calendarKey('a', shared.id)]).toBe(false);
    expect(isCalendarVisible('a', shared, hidden)).toBe(false);
    expect(isCalendarVisible('a', shared, toggleCalendarVisibility(hidden, 'a', shared))).toBe(
      true,
    );
  });

  it('keys choices per account so one calendar on two accounts toggles separately', () => {
    const shared = cal('family');
    const v = toggleCalendarVisibility({}, 'a', shared);
    expect(isCalendarVisible('a', shared, v)).toBe(false);
    expect(isCalendarVisible('b', shared, v)).toBe(true);
  });

  it('parses stored choices, dropping junk', () => {
    expect(parseCalendarVisibility('{"a|x":false,"a|y":"no","a|z":true}')).toEqual({
      'a|x': false,
      'a|z': true,
    });
    expect(parseCalendarVisibility('[1]')).toEqual({});
    expect(parseCalendarVisibility('not json')).toEqual({});
    expect(parseCalendarVisibility(null)).toEqual({});
  });
});

describe('fetchAcrossCalendars', () => {
  it('reads every calendar and tags events with account and calendar', async () => {
    const sources: AccountCalendars[] = [
      {
        account: account('a'),
        listGranted: true,
        calendars: [
          cal('me', { primary: true, accessRole: 'owner', backgroundColor: '#111111' }),
          cal('spouse', { accessRole: 'reader', backgroundColor: '#222222' }),
        ],
      },
    ];
    const fetcher = vi.fn(async (_acct: LinkedGoogleAccount, c: GoogleCalendarEntry) => {
      if (c.id === 'spouse') throw new Error('denied');
      return [{ id: `${c.id}-1`, summary: 'x' }];
    });
    const { items, failures } = await fetchAcrossCalendars(sources, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Fetched events carry ids only; details are looked up at render time.
    expect(items).toEqual([
      { id: 'me-1', summary: 'x', accountId: 'a', accountEmail: 'a@example.com', calendarId: 'me' },
    ]);
    expect(withCalendarMeta(items, sources)).toEqual([
      expect.objectContaining({
        calendarName: 'me',
        calendarColor: '#111111',
        calendarWritable: true,
      }),
    ]);
    expect(failures).toEqual([
      expect.objectContaining({
        calendar: expect.objectContaining({ id: 'spouse' }),
        error: 'denied',
      }),
    ]);
  });
});

describe('withoutHiddenCalendars', () => {
  it('drops events from hidden calendars only', () => {
    const sources: AccountCalendars[] = [
      {
        account: account('a'),
        listGranted: true,
        calendars: [
          cal('me', { primary: true }),
          cal('spouse'),
          cal('holidays', { selected: false }),
        ],
      },
    ];
    const items = [
      { id: '1', accountId: 'a', calendarId: 'me' },
      { id: '2', accountId: 'a', calendarId: 'spouse' },
      { id: '3', accountId: 'a', calendarId: 'holidays' },
    ];
    expect(withoutHiddenCalendars(items, sources, {}).map((i) => i.id)).toEqual(['1', '2']);
    const v = { [calendarKey('a', 'spouse')]: false, [calendarKey('a', 'holidays')]: true };
    expect(withoutHiddenCalendars(items, sources, v).map((i) => i.id)).toEqual(['1', '3']);
  });
});

describe('canWriteCalendar', () => {
  it('allows owner and writer only', () => {
    expect(canWriteCalendar('owner')).toBe(true);
    expect(canWriteCalendar('writer')).toBe(true);
    expect(canWriteCalendar('reader')).toBe(false);
    expect(canWriteCalendar('freeBusyReader')).toBe(false);
    expect(canWriteCalendar(null)).toBe(false);
  });
});

describe('withoutHiddenCalendars with a single calendar', () => {
  it('ignores a stored hide once only one calendar remains', () => {
    const two: AccountCalendars[] = [
      {
        account: account('a'),
        listGranted: true,
        calendars: [cal('me', { primary: true }), cal('other')],
      },
    ];
    const v = { [calendarKey('a', 'me')]: false };
    const items = [{ id: '1', accountId: 'a', calendarId: 'me' }];
    expect(withoutHiddenCalendars(items, two, v)).toEqual([]);

    // The other calendar was unsubscribed: no toggle renders, so the primary shows.
    const one: AccountCalendars[] = [{ ...two[0], calendars: [two[0].calendars[0]] }];
    expect(withoutHiddenCalendars(items, one, v)).toEqual(items);
  });

  it('shows a sole calendar even when it is unchecked in Google', () => {
    const one: AccountCalendars[] = [
      {
        account: account('a'),
        listGranted: true,
        calendars: [cal('me', { primary: true, selected: false })],
      },
    ];
    const items = [{ id: '1', accountId: 'a', calendarId: 'me' }];
    expect(withoutHiddenCalendars(items, one, {})).toEqual(items);
  });
});

describe('writerWithoutPrivateAccess', () => {
  it('can write the calendar but not its private events', () => {
    expect(canWriteCalendar('writerWithoutPrivateAccess')).toBe(true);
    expect(canEditCalendarEvent('writerWithoutPrivateAccess', 'default')).toBe(true);
    expect(canEditCalendarEvent('writerWithoutPrivateAccess', null)).toBe(true);
    expect(canEditCalendarEvent('writerWithoutPrivateAccess', 'private')).toBe(false);
    expect(canEditCalendarEvent('writerWithoutPrivateAccess', 'confidential')).toBe(false);
    expect(canEditCalendarEvent('writer', 'private')).toBe(true);
    expect(canEditCalendarEvent('reader', 'public')).toBe(false);
  });

  it('survives listing and tags each event by its own visibility', async () => {
    const [source] = await loadAccountCalendars([account('a')], async () => ({
      calendars: [
        { id: 'fam', summary: 'Family', selected: true, accessRole: 'writerWithoutPrivateAccess' },
        { id: 'odd', summary: 'Odd', selected: true, accessRole: 'someNewRole' as never },
      ],
    }));
    expect(source.calendars.map((c) => c.accessRole)).toEqual(['writerWithoutPrivateAccess', null]);

    const familyOnly = [{ ...source, calendars: [source.calendars[0]] }];
    const { items } = await fetchAcrossCalendars(familyOnly, async () => [
      { id: 'open', visibility: 'default' },
      { id: 'secret', visibility: 'private' },
    ]);
    expect(withCalendarMeta(items, familyOnly).map((i) => [i.id, i.calendarWritable])).toEqual([
      ['open', true],
      ['secret', false],
    ]);
  });
});

describe('calendarLoadWarning', () => {
  const ok = (id: string): AccountCalendars => ({
    account: account(id),
    listGranted: true,
    calendars: [cal(`${id}-primary`, { primary: true }), cal(`${id}-shared`)],
  });

  it('is null when everything loaded', () => {
    expect(calendarLoadWarning([ok('a')], [])).toBeNull();
  });

  it('names an account whose calendar list failed even though its primary loaded', () => {
    const failed: AccountCalendars = {
      account: account('b'),
      listGranted: true,
      error: 'Google Calendar rate limit exceeded',
      calendars: [cal('primary', { primary: true })],
    };
    expect(calendarLoadWarning([ok('a'), failed], [])).toBe(
      "Couldn't list calendars for b@example.com (Google Calendar rate limit exceeded); showing its primary calendar only.",
    );
  });

  it('reports a truncated list and partial event failures', () => {
    const truncated = { ...ok('a'), truncated: true };
    const warning = calendarLoadWarning(
      [truncated],
      [{ account: truncated.account, calendar: truncated.calendars[1], error: 'boom' }],
    );
    expect(warning).toContain("Only some of a@example.com's calendars could be listed.");
    expect(warning).toContain('Some calendars failed to load: a-shared: boom');
  });

  it('leaves a total failure to the caller', () => {
    const src = ok('a');
    const failures = src.calendars.map((c) => ({ account: src.account, calendar: c, error: 'x' }));
    expect(calendarLoadWarning([src], failures)).toBeNull();
  });

  it('carries truncated from the list response', async () => {
    const [source] = await loadAccountCalendars([account('a')], async () => ({
      calendars: [{ id: 'x', summary: 'X', primary: true, selected: true }],
      truncated: true,
    }));
    expect(source.truncated).toBe(true);
  });
});

describe('withCalendarMeta', () => {
  const source = (extra: Partial<GoogleCalendarEntry>): AccountCalendars[] => [
    {
      account: account('a'),
      listGranted: true,
      calendars: [cal('fam', { accessRole: 'reader', backgroundColor: '#111111', ...extra })],
    },
  ];
  const events = [{ id: '1', accountId: 'a', calendarId: 'fam', visibility: 'default' }];

  it('follows calendar changes without refetching, ids unchanged', () => {
    const before = withCalendarMeta(events, source({}));
    expect(before[0]).toMatchObject({
      calendarName: 'fam',
      calendarColor: '#111111',
      calendarWritable: false,
    });
    // Same ids; the calendar was renamed, recolored, and made writable.
    const after = withCalendarMeta(
      events,
      source({ summary: 'Family', backgroundColor: '#222222', accessRole: 'writer' }),
    );
    expect(after[0]).toMatchObject({
      calendarName: 'Family',
      calendarColor: '#222222',
      calendarWritable: true,
    });
  });

  it('passes events through before any list loads and locks ones whose calendar is gone', () => {
    expect(withCalendarMeta(events, [])).toEqual(events);
    const other = withCalendarMeta([{ ...events[0], calendarId: 'gone' }], source({}));
    expect(other[0].calendarWritable).toBe(false);
  });
});
