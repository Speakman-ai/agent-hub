/**
 * Multi-calendar helpers for the Calendar page on web and mobile.
 *
 * Each linked Google account can carry several calendars: its own primary,
 * secondary ones, calendars other people shared, and subscribed feeds. The
 * server lists them at `GET /api/google/calendar/calendars`. These helpers turn
 * that list into the set of calendars to read, decide which are shown (Google's
 * own checkbox state unless the user flipped it here), and tag every event with
 * the calendar it came from so edits go back to the right place.
 */
import type { AccountTagged, LinkedGoogleAccount } from './googleAccounts';

/** Scope the Calendar page requests to list calendars. Read-only. */
export const CALENDAR_LIST_READONLY_SCOPE =
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly';

const CALENDAR_LIST_GRANTING_SCOPES = [
  CALENDAR_LIST_READONLY_SCOPE,
  'https://www.googleapis.com/auth/calendar.calendarlist',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar',
];

/** The server's code when an account has not granted a calendar-list scope. */
export const CALENDAR_LIST_SCOPE_REQUIRED_CODE = 'google_calendar_list_scope_required';

export function hasCalendarListScope(account: { grantedScopes?: string[] | null }): boolean {
  const scopes = account.grantedScopes ?? [];
  return CALENDAR_LIST_GRANTING_SCOPES.some((s) => scopes.includes(s));
}

/** Every CalendarList accessRole Google documents. */
export const GOOGLE_CALENDAR_ACCESS_ROLES = [
  'freeBusyReader',
  'reader',
  'writerWithoutPrivateAccess',
  'writer',
  'owner',
] as const;

export type GoogleCalendarAccessRole = (typeof GOOGLE_CALENDAR_ACCESS_ROLES)[number];

function isAccessRole(value: unknown): value is GoogleCalendarAccessRole {
  return (GOOGLE_CALENDAR_ACCESS_ROLES as readonly unknown[]).includes(value);
}

export interface GoogleCalendarEntry {
  id: string;
  summary: string;
  primary: boolean;
  /** Checked in the Google Calendar UI. */
  selected: boolean;
  accessRole: GoogleCalendarAccessRole | null;
  backgroundColor: string | null;
}

/** One account's calendars, or its primary alone when they can't be listed. */
export interface AccountCalendars {
  account: LinkedGoogleAccount;
  calendars: GoogleCalendarEntry[];
  /** False when the account still needs the calendar-list scope. */
  listGranted: boolean;
  /** Set when listing failed for another reason; the primary still loads. */
  error?: string;
  /** The server stopped at its page cap; some calendars were not listed. */
  truncated?: boolean;
}

export function primaryOnlyCalendars(account: LinkedGoogleAccount): GoogleCalendarEntry[] {
  return [
    {
      id: 'primary',
      summary: account.email || 'Primary calendar',
      primary: true,
      selected: true,
      accessRole: 'owner',
      backgroundColor: null,
    },
  ];
}

function normalizeEntry(raw: Partial<GoogleCalendarEntry> | null | undefined) {
  if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
  const entry: GoogleCalendarEntry = {
    id: raw.id,
    summary: typeof raw.summary === 'string' && raw.summary ? raw.summary : raw.id,
    primary: !!raw.primary,
    selected: !!raw.selected,
    accessRole: isAccessRole(raw.accessRole) ? raw.accessRole : null,
    backgroundColor: typeof raw.backgroundColor === 'string' ? raw.backgroundColor : null,
  };
  return entry;
}

/**
 * List every account's calendars in parallel. An account without the list
 * scope, or whose list call fails, falls back to its primary calendar so the
 * page keeps working the way it did before calendars could be listed.
 */
export async function loadAccountCalendars(
  accounts: LinkedGoogleAccount[],
  listCalendars: (
    account: LinkedGoogleAccount,
  ) => Promise<
    | { calendars?: Array<Partial<GoogleCalendarEntry> | null>; truncated?: boolean }
    | null
    | undefined
  >,
): Promise<AccountCalendars[]> {
  return Promise.all(
    accounts.map(async (account): Promise<AccountCalendars> => {
      if (!hasCalendarListScope(account)) {
        return { account, calendars: primaryOnlyCalendars(account), listGranted: false };
      }
      try {
        const body = await listCalendars(account);
        const calendars = (body?.calendars ?? [])
          .map(normalizeEntry)
          .filter((c): c is GoogleCalendarEntry => !!c);
        return {
          account,
          calendars: calendars.length ? calendars : primaryOnlyCalendars(account),
          listGranted: true,
          ...(body?.truncated ? { truncated: true } : {}),
        };
      } catch (err) {
        const e = err as { code?: unknown; message?: unknown } | undefined;
        const scopeMissing = e?.code === CALENDAR_LIST_SCOPE_REQUIRED_CODE;
        return {
          account,
          calendars: primaryOnlyCalendars(account),
          listGranted: !scopeMissing,
          ...(scopeMissing
            ? {}
            : { error: typeof e?.message === 'string' ? e.message : 'Failed to list calendars' }),
        };
      }
    }),
  );
}

/** Stable id for a calendar across accounts (the same calendar can be on two). */
export function calendarKey(accountId: string, calendarId: string): string {
  return `${accountId}|${calendarId}`;
}

/** Storage key for the user's per-calendar show/hide choices. */
export const CALENDAR_VISIBILITY_KEY = 'agent-hub.calendar.calendarVisibility';

export type CalendarVisibility = Record<string, boolean>;

export function parseCalendarVisibility(raw: string | null | undefined): CalendarVisibility {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: CalendarVisibility = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Shown here if the user said so, else if it's checked in Google. The
 * primary-only fallback is built with selected=true, so it always shows.
 */
export function isCalendarVisible(
  accountId: string,
  calendar: Pick<GoogleCalendarEntry, 'id' | 'primary' | 'selected'>,
  visibility: CalendarVisibility,
): boolean {
  const choice = visibility[calendarKey(accountId, calendar.id)];
  if (typeof choice === 'boolean') return choice;
  return calendar.selected;
}

export function toggleCalendarVisibility(
  visibility: CalendarVisibility,
  accountId: string,
  calendar: Pick<GoogleCalendarEntry, 'id' | 'primary' | 'selected'>,
): CalendarVisibility {
  return {
    ...visibility,
    [calendarKey(accountId, calendar.id)]: !isCalendarVisible(accountId, calendar, visibility),
  };
}

export function canWriteCalendar(accessRole: GoogleCalendarAccessRole | null | undefined) {
  return (
    accessRole === 'owner' || accessRole === 'writer' || accessRole === 'writerWithoutPrivateAccess'
  );
}

/**
 * Can this event be edited? `writerWithoutPrivateAccess` writes to the
 * calendar but sees private events without their details, so saving one would
 * overwrite what it can't see.
 */
export function canEditCalendarEvent(
  accessRole: GoogleCalendarAccessRole | null | undefined,
  visibility: string | null | undefined,
): boolean {
  if (!canWriteCalendar(accessRole)) return false;
  if (accessRole !== 'writerWithoutPrivateAccess') return true;
  return visibility !== 'private' && visibility !== 'confidential';
}

/** Calendars across all accounts. With one in total there is nothing to toggle. */
export function calendarCount(sources: AccountCalendars[]): number {
  return sources.reduce((n, s) => n + s.calendars.length, 0);
}

/** What a fetched event records about where it came from: ids only. */
export interface CalendarRef {
  calendarId: string;
}

export type CalendarRefTagged<T> = AccountTagged<T> & CalendarRef;

/**
 * Calendar details for display. Derived from the current calendar list at
 * render time (see {@link withCalendarMeta}), never stored on fetched events,
 * so a renamed, recolored or re-permissioned calendar updates every view at
 * once without refetching events.
 */
export interface CalendarTag extends CalendarRef {
  calendarName: string;
  calendarColor: string | null;
  calendarWritable: boolean;
}

export interface CalendarFetchFailure {
  account: LinkedGoogleAccount;
  calendar: GoogleCalendarEntry;
  error: string;
}

/**
 * Read every listed calendar in parallel and tag each event with the ids of
 * its account and calendar. Hidden calendars are read too so a toggle shows
 * them without a round trip. One calendar failing never hides the rest.
 */
export async function fetchAcrossCalendars<T extends object>(
  sources: AccountCalendars[],
  fetcher: (account: LinkedGoogleAccount, calendar: GoogleCalendarEntry) => Promise<T[]>,
): Promise<{ items: CalendarRefTagged<T>[]; failures: CalendarFetchFailure[] }> {
  const jobs = sources.flatMap((s) =>
    s.calendars.map((calendar) => ({ account: s.account, calendar })),
  );
  const settled = await Promise.allSettled(jobs.map((j) => fetcher(j.account, j.calendar)));
  const items: CalendarRefTagged<T>[] = [];
  const failures: CalendarFetchFailure[] = [];
  settled.forEach((result, i) => {
    const { account, calendar } = jobs[i];
    if (result.status === 'fulfilled') {
      for (const item of result.value ?? []) {
        items.push({
          ...item,
          accountId: account.accountId,
          accountEmail: account.email,
          calendarId: calendar.id,
        });
      }
    } else {
      const reason = result.reason as { message?: unknown } | undefined;
      const message = typeof reason?.message === 'string' ? reason.message : String(reason);
      failures.push({ account, calendar, error: message || 'Request failed' });
    }
  });
  return { items, failures };
}

/**
 * Drop events from calendars the user has hidden. Toggles only render with two
 * or more calendars, so with one (or none) nothing may stay hidden: a stored
 * choice, or Google's unchecked state, must never hide the only calendar with
 * no control to bring it back.
 */
export function withoutHiddenCalendars<T extends { accountId?: string; calendarId?: string }>(
  items: T[],
  sources: AccountCalendars[],
  visibility: CalendarVisibility,
): T[] {
  if (calendarCount(sources) < 2) return items;
  const hidden = new Set<string>();
  for (const s of sources) {
    for (const c of s.calendars) {
      if (!isCalendarVisible(s.account.accountId, c, visibility)) {
        hidden.add(calendarKey(s.account.accountId, c.id));
      }
    }
  }
  if (!hidden.size) return items;
  return items.filter(
    (item) => !hidden.has(calendarKey(item.accountId ?? '', item.calendarId ?? 'primary')),
  );
}

/** Stable value that changes only when the set of calendars to read changes. */
export function calendarSourcesKey(sources: AccountCalendars[]): string {
  return sources
    .flatMap((s) => s.calendars.map((c) => calendarKey(s.account.accountId, c.id)))
    .join(',');
}

export function calendarFailureText(failures: CalendarFetchFailure[]): string {
  return failures
    .map((f) => `${f.calendar.summary || f.account.email || 'Google calendar'}: ${f.error}`)
    .join('; ');
}

/**
 * A warning for a partial load, or null when everything loaded. Covers
 * accounts whose calendar list failed or was cut short (their shared calendars
 * are missing even though the primary loaded) and calendars whose events
 * failed. A load where every calendar failed is an error, not a warning; the
 * caller reports that separately.
 */
export function calendarLoadWarning(
  sources: AccountCalendars[],
  failures: CalendarFetchFailure[],
): string | null {
  const parts: string[] = [];
  for (const s of sources) {
    const who = s.account.email || 'Google account';
    if (s.error) {
      parts.push(
        `Couldn't list calendars for ${who} (${s.error}); showing its primary calendar only.`,
      );
    } else if (s.truncated) {
      parts.push(`Only some of ${who}'s calendars could be listed.`);
    }
  }
  if (failures.length && failures.length < calendarCount(sources)) {
    parts.push(`Some calendars failed to load: ${calendarFailureText(failures)}`);
  }
  return parts.length ? parts.join(' ') : null;
}

type CalendarMetaInput = {
  accountId?: string;
  calendarId?: string;
  visibility?: string | null;
};

/**
 * Attach the calendar's current name, color and edit rights to each event,
 * looked up from `sources`. Call this at render time on whatever events a view
 * holds (agenda, month grid), so all views agree with the latest calendar list.
 * Before any list has loaded, events pass through unchanged. An event whose
 * calendar is no longer listed is shown read-only until it is refetched.
 */
export function withCalendarMeta<T extends CalendarMetaInput>(
  items: T[],
  sources: AccountCalendars[],
): Array<T & Partial<CalendarTag>> {
  if (!sources.length) return items;
  const byKey = new Map<string, GoogleCalendarEntry>();
  for (const s of sources) {
    for (const c of s.calendars) byKey.set(calendarKey(s.account.accountId, c.id), c);
  }
  return items.map((item) => {
    const calendar = byKey.get(calendarKey(item.accountId ?? '', item.calendarId ?? 'primary'));
    if (!calendar) return { ...item, calendarWritable: false };
    return {
      ...item,
      calendarName: calendar.summary,
      calendarColor: calendar.backgroundColor,
      calendarWritable: canEditCalendarEvent(calendar.accessRole, item.visibility),
    };
  });
}
