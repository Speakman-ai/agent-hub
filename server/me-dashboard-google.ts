/**
 * me-dashboard-google.ts — resilient, in-process Google reads for the personal
 * dashboard aggregation (`GET /api/me/dashboard`).
 *
 * The dashboard must render for users who have not linked Google at all, so
 * every read here degrades softly: a missing OAuth app, an unlinked account, a
 * missing surface scope, or a transient Google failure returns a shaped
 * `connected/scopeGranted:false` (or `error`) block instead of throwing. The
 * caller folds this straight into the payload — it never fails the whole
 * dashboard (spec NAV-PLACEMENT: "Todos and My Work work without Google
 * linked").
 *
 * Tokens never leave the server (spec CAPTURE-PROVENANCE / the Google Workspace
 * proxy): we resolve a fresh access token via `getActiveAccessToken` and call
 * Google in-process, returning only counts and lightly-shaped event summaries.
 */
import { google } from 'googleapis';
import { getActiveAccessToken, getGoogleConnectionStatus } from './google-connections-store.js';
import { hasCalendarReadScope, hasGmailReadScope } from './google-scopes.js';
import type { AppConfig } from './types.js';

/** A single calendar event, trimmed to what a dashboard row needs. */
export interface DashboardCalendarEvent {
  id: string | null;
  summary: string | null;
  location: string | null;
  allDay: boolean;
  start: string | null;
  end: string | null;
  htmlLink: string | null;
  hangoutLink: string | null;
}

export interface DashboardCalendar {
  scopeGranted: boolean;
  date: string | null;
  timeZone: string | null;
  events: DashboardCalendarEvent[];
  error: string | null;
}

export interface DashboardMail {
  scopeGranted: boolean;
  unread: number | null;
  starred: number | null;
  important: number | null;
  error: string | null;
}

export interface DashboardGoogle {
  /** The server has a Google OAuth app configured at all. */
  configured: boolean;
  /** This user has linked their Google account. */
  connected: boolean;
  /** The linked Google email, or null when not connected. */
  email: string | null;
  /** True when we had a live connection but could not mint an access token. */
  reconnectRequired: boolean;
  calendar: DashboardCalendar;
  mail: DashboardMail;
}

export interface GoogleReaderOptions {
  /** Overridable clock so tests can pin "today". Defaults to `new Date()`. */
  now?: Date;
  /** Explicit YYYY-MM-DD day to fetch; defaults to the UTC day of `now`. */
  date?: string;
  /** IANA zone passed through to Google for event display / ordering. */
  timeZone?: string;
}

export type GoogleReader = (
  userId: string,
  config: AppConfig,
  opts?: GoogleReaderOptions,
) => Promise<DashboardGoogle>;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function emptyCalendar(scopeGranted: boolean): DashboardCalendar {
  return { scopeGranted, date: null, timeZone: null, events: [], error: null };
}

function emptyMail(scopeGranted: boolean): DashboardMail {
  return { scopeGranted, unread: null, starred: null, important: null, error: null };
}

function notConnected(configured: boolean, reconnectRequired = false): DashboardGoogle {
  return {
    configured,
    connected: false,
    email: null,
    reconnectRequired,
    calendar: emptyCalendar(false),
    mail: emptyMail(false),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** True if `timeZone` is a valid IANA zone the runtime's Intl accepts. */
function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The YYYY-MM-DD calendar date of `instant` as seen in `timeZone`. */
function localDateInZone(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which is exactly the shape we want.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** Offset (wall-clock − UTC, in ms) of `timeZone` at the given UTC instant. */
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const f: Record<string, string> = {};
  for (const p of parts) if (p.type !== 'literal') f[p.type] = p.value;
  const asUtc = Date.UTC(+f.year, +f.month - 1, +f.day, +f.hour, +f.minute, +f.second);
  return asUtc - utcMs;
}

/** UTC instant of local midnight starting `dateStr` (YYYY-MM-DD) in `timeZone`. */
function zonedMidnightUtcMs(dateStr: string, timeZone: string): number {
  // The date numerals interpreted as if they were UTC, then shifted by the
  // zone's offset back to the real UTC instant. Re-derive the offset at the
  // candidate instant so a DST transition between the two doesn't skew it.
  const guess = new Date(`${dateStr}T00:00:00Z`).getTime();
  const offset = tzOffsetMs(guess, timeZone);
  let utc = guess - offset;
  const refined = tzOffsetMs(utc, timeZone);
  if (refined !== offset) utc = guess - refined;
  return utc;
}

function nextDate(dateStr: string): string {
  return new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + DAY_MS).toISOString().slice(0, 10);
}

/**
 * The `[timeMin, timeMax)` window bounding a single calendar day.
 *
 * When a valid IANA `timeZone` is supplied, the day is the caller's *local*
 * calendar day (midnight-to-midnight in that zone, DST-correct) — so events
 * near local midnight bucket on the right day. Without a zone (or with an
 * unrecognised one) the window is the UTC calendar day, matching the endpoint's
 * documented default. `date` (YYYY-MM-DD) overrides which day; otherwise it's
 * "today" resolved in the same frame (local zone, else UTC).
 */
export function computeDayWindow(opts: GoogleReaderOptions): {
  date: string;
  timeMin: string;
  timeMax: string;
} {
  const now = opts.now ?? new Date();
  const tz = opts.timeZone && isValidTimeZone(opts.timeZone) ? opts.timeZone : null;

  const explicitDate = opts.date && DATE_ONLY_RE.test(opts.date) ? opts.date : null;

  if (!tz) {
    const date = explicitDate ?? now.toISOString().slice(0, 10);
    const start = new Date(`${date}T00:00:00.000Z`);
    return {
      date,
      timeMin: start.toISOString(),
      timeMax: new Date(start.getTime() + DAY_MS).toISOString(),
    };
  }

  const date = explicitDate ?? localDateInZone(now, tz);
  const startMs = zonedMidnightUtcMs(date, tz);
  const endMs = zonedMidnightUtcMs(nextDate(date), tz);
  return {
    date,
    timeMin: new Date(startMs).toISOString(),
    timeMax: new Date(endMs).toISOString(),
  };
}

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0].slice(0, 200);
}

async function readCalendar(
  accessToken: string,
  opts: GoogleReaderOptions,
): Promise<DashboardCalendar> {
  const { date, timeMin, timeMax } = computeDayWindow(opts);
  try {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    const calendar = google.calendar({ version: 'v3', auth });
    const result = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      timeZone: opts.timeZone,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });
    const events: DashboardCalendarEvent[] = (result.data.items ?? []).map((e) => ({
      id: e.id ?? null,
      summary: e.summary ?? null,
      location: e.location ?? null,
      // All-day events carry `start.date` (no time); timed events carry
      // `start.dateTime`. Surface whichever is present.
      allDay: Boolean(e.start?.date && !e.start?.dateTime),
      start: e.start?.dateTime ?? e.start?.date ?? null,
      end: e.end?.dateTime ?? e.end?.date ?? null,
      htmlLink: e.htmlLink ?? null,
      hangoutLink: e.hangoutLink ?? null,
    }));
    return {
      scopeGranted: true,
      date,
      timeZone: result.data.timeZone ?? opts.timeZone ?? null,
      events,
      error: null,
    };
  } catch (err) {
    return {
      scopeGranted: true,
      date,
      timeZone: opts.timeZone ?? null,
      events: [],
      error: shortError(err),
    };
  }
}

async function readMail(accessToken: string): Promise<DashboardMail> {
  try {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    const gmail = google.gmail({ version: 'v1', auth });
    // System-label counts are a single cheap read each (no message bodies).
    // UNREAD = unread across the mailbox, STARRED / IMPORTANT = flagged buckets.
    const [unread, starred, important] = await Promise.all([
      gmail.users.labels.get({ userId: 'me', id: 'UNREAD' }),
      gmail.users.labels.get({ userId: 'me', id: 'STARRED' }),
      gmail.users.labels.get({ userId: 'me', id: 'IMPORTANT' }),
    ]);
    return {
      scopeGranted: true,
      unread: unread.data.messagesUnread ?? unread.data.messagesTotal ?? 0,
      starred: starred.data.messagesTotal ?? 0,
      important: important.data.messagesTotal ?? 0,
      error: null,
    };
  } catch (err) {
    return {
      scopeGranted: true,
      unread: null,
      starred: null,
      important: null,
      error: shortError(err),
    };
  }
}

/**
 * Read the user's Google dashboard slice (today's calendar + flagged-mail
 * counts). Never throws: every failure mode collapses to a shaped block the
 * caller can render as "connect Google" / "reconnect" / "scope required".
 */
export const readGoogleForDashboard: GoogleReader = async (userId, config, opts = {}) => {
  const oauth = config.googleOAuth ?? null;
  if (!oauth?.clientId || !oauth?.clientSecret) {
    return notConnected(false);
  }

  const status = getGoogleConnectionStatus(userId);
  if (!status.connected) {
    return notConnected(true);
  }

  const calScope = hasCalendarReadScope(status.grantedScopes);
  const mailScope = hasGmailReadScope(status.grantedScopes);

  let token: string | null;
  try {
    token = await getActiveAccessToken(userId, oauth);
  } catch {
    token = null;
  }
  if (!token) {
    // Connection row exists but no usable token (revoked / refresh failed).
    return {
      configured: true,
      connected: true,
      email: status.email,
      reconnectRequired: true,
      calendar: emptyCalendar(calScope),
      mail: emptyMail(mailScope),
    };
  }

  const [calendar, mail] = await Promise.all([
    calScope ? readCalendar(token, opts) : Promise.resolve(emptyCalendar(false)),
    mailScope ? readMail(token) : Promise.resolve(emptyMail(false)),
  ]);

  return {
    configured: true,
    connected: true,
    email: status.email,
    reconnectRequired: false,
    calendar,
    mail,
  };
};
