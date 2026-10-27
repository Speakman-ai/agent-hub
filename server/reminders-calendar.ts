/**
 * Mirror reminders onto the owner's primary Google Calendar.
 *
 * A new event goes to the owner's default Google account, and the reminder
 * records that account. Patches and deletes always target the recorded
 * account, so an event stays manageable after the default moves to another
 * account. When the recorded account is removed, its events are no longer
 * reachable: work on them stops (`skipped`) instead of retrying forever.
 *
 * Best effort and never blocking: a reminder is saved and fires through the
 * notification inbox whether or not the calendar write works. The mirror only
 * runs when the owner has connected Google with a calendar scope; otherwise
 * the reminder is marked `skipped` with the reason so the UI can say why.
 *
 * The event is a short block at `remind_at` with a popup override at 0 minutes
 * so Google's own reminder fires at the same moment ours does.
 *
 * Lifecycle: the event id is reserved on the reminder (`pending`) before any
 * Google call, so every reminder that might have an event names it. Deletes
 * queue that id for removal; inserts that finish after a delete queue it
 * again; inserts that finish after an edit patch the event; failed inserts,
 * updates and deletes are retried by `runReminderCalendarMaintenance`.
 */
import { google, type calendar_v3 } from 'googleapis';
import type { GoogleOAuthConfig } from './types.js';
import { getActiveAccessToken, getGoogleConnectionStatus } from './google-connections-store.js';
import { hasCalendarPrimaryWriteScope } from './google-scopes.js';
import { broadcastReminderUpdate } from './reminders-events.js';
import type { BroadcastFn } from './types.js';
import {
  beginCalendarInsert,
  calendarEventIdFor,
  stampDefaultCalendarAccount,
  completeCalendarCleanup,
  getReminder,
  linkCalendarEvent,
  markCalendarUpdating,
  listCalendarInsertRetries,
  listCalendarSyncRetries,
  recordCalendarInsertFailure,
  listDueCalendarCleanups,
  recordCalendarCleanupFailure,
  recordCalendarSyncFailure,
  setReminderCalendar,
  type CalendarCleanup,
  type CleanupReminderChange,
  type Reminder,
  type ReminderCalendarEffect,
} from './reminders-store.js';

export const REMINDER_EVENT_MINUTES = 15;
const PRIMARY = 'primary';

/** Narrow Calendar surface so tests can swap in a fake. */
export interface ReminderCalendarClient {
  insert(calendarId: string, event: calendar_v3.Schema$Event): Promise<calendar_v3.Schema$Event>;
  patch(
    calendarId: string,
    eventId: string,
    event: calendar_v3.Schema$Event,
  ): Promise<calendar_v3.Schema$Event>;
  remove(calendarId: string, eventId: string): Promise<void>;
}

/**
 * Why there is no client. `accountGone` means the account holding the event
 * is no longer linked, so no retry can ever reach it.
 */
export interface ReminderCalendarSkip {
  skip: string;
  accountGone?: boolean;
}

export interface ReminderCalendarDeps {
  googleOAuth: GoogleOAuthConfig | null | undefined;
  /**
   * Returns a client for `accountId`'s calendar (null: the default account),
   * or a skip reason when that calendar is unavailable.
   */
  resolveClient?: (
    userId: string,
    accountId: string | null,
  ) => Promise<ReminderCalendarClient | ReminderCalendarSkip>;
  /**
   * Owner-scoped `reminder_update` delivery. Every calendar write that
   * changes what clients show is announced from `exclusive`, whoever's work
   * it was, so no path depends on its caller remembering to broadcast.
   */
  broadcast?: BroadcastFn;
}

function googleClient(accessToken: string): ReminderCalendarClient {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  const cal = google.calendar({ version: 'v3', auth });
  return {
    async insert(calendarId, event) {
      return (await cal.events.insert({ calendarId, requestBody: event })).data;
    },
    async patch(calendarId, eventId, event) {
      return (await cal.events.patch({ calendarId, eventId, requestBody: event })).data;
    },
    async remove(calendarId, eventId) {
      await cal.events.delete({ calendarId, eventId });
    },
  };
}

/**
 * The real client resolver, exported for tests. Mirroring writes events, so
 * it requires a scope that can write the primary calendar; a read-only
 * connection is skipped up front rather than retried against a 403 forever.
 */
export async function resolveReminderCalendarClient(
  userId: string,
  googleOAuth: ReminderCalendarDeps['googleOAuth'],
  accountId: string | null = null,
): Promise<ReminderCalendarClient | ReminderCalendarSkip> {
  if (!googleOAuth?.clientId || !googleOAuth?.clientSecret) {
    return { skip: 'Google is not configured on this server' };
  }
  const account = accountId ? { accountId } : undefined;
  const status = getGoogleConnectionStatus(userId, account);
  if (!status.connected) {
    return accountId
      ? { skip: 'The Google account that holds this event is no longer linked', accountGone: true }
      : { skip: 'Google account is not connected' };
  }
  if (!hasCalendarPrimaryWriteScope(status.grantedScopes)) {
    return {
      skip: `Google Calendar write access has not been granted${status.email ? ` for ${status.email}` : ''}`,
    };
  }
  const token = await getActiveAccessToken(userId, googleOAuth, account ? { account } : {});
  if (!token) return { skip: 'Google account must be reconnected' };
  return googleClient(token);
}

function resolve(
  deps: ReminderCalendarDeps,
  userId: string,
  accountId: string | null,
): Promise<ReminderCalendarClient | ReminderCalendarSkip> {
  return deps.resolveClient
    ? deps.resolveClient(userId, accountId)
    : resolveReminderCalendarClient(userId, deps.googleOAuth, accountId);
}

/** The account can never be reached again: drop the event link for good. */
function abandonCalendarLink(
  reminder: Pick<Reminder, 'userId' | 'id'>,
  eventId: string,
  reason: string,
): Reminder | null {
  return setReminderCalendar(
    reminder.userId,
    reminder.id,
    { status: 'skipped', error: reason },
    eventId,
  );
}

export function reminderEventResource(
  reminder: Pick<Reminder, 'id' | 'title' | 'notes' | 'remindAt' | 'createdBy'>,
): calendar_v3.Schema$Event {
  const start = new Date(reminder.remindAt);
  const end = new Date(start.getTime() + REMINDER_EVENT_MINUTES * 60 * 1000);
  const footer =
    reminder.createdBy === 'agent'
      ? 'Reminder set by an agent in Agent Hub.'
      : 'Agent Hub reminder.';
  return {
    summary: reminder.title,
    description: reminder.notes ? `${reminder.notes}\n\n${footer}` : footer,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    transparency: 'transparent',
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] },
    extendedProperties: { private: { agentHubReminderId: reminder.id } },
  };
}

function errMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0].slice(0, 300);
}

/** In-flight inserts hold their reminder this long before the sweep may retry. */
export const INSERT_LEASE_MS = 5 * 60 * 1000;
const MAX_PATCH_PASSES = 3;

export { calendarEventIdFor };

function sameEventFields(a: Reminder, b: Reminder): boolean {
  return a.title === b.title && a.notes === b.notes && a.remindAt === b.remindAt;
}

/**
 * Reminders whose event content (insert or patch) is being written to Google
 * right now. At most one such operation per reminder runs at a time, so
 * requests can't reach Google out of order and leave an older version last.
 *
 * Nobody waits on this. A caller that finds the reminder busy leaves the
 * durable state (`pending` / `updating`, due now), hands the work to the
 * holder, and returns. The holder re-reads the row after every Google call,
 * runs handed-off work before releasing, and anything left over is still
 * durable for the next sweep. Event
 * deletions don't take it; they are settled by the cleanup queue, which
 * tolerates any ordering (a 404 counts as done, and a late insert re-queues).
 *
 * In-process only: the Hub is one long-lived process per database.
 */
const writingEvent = new Set<string>();
/** Reminders whose callers found them busy and handed their work to the holder. */
const handedOff = new Map<string, { userId: string; deps: ReminderCalendarDeps }>();
const MAX_HANDOFF_ROUNDS = 5;

function calendarView(r: Reminder | null): string {
  return r ? JSON.stringify(r.calendar) : 'gone';
}

/**
 * Run `fn` as the reminder's single event writer, then finish any work
 * handed to it meanwhile. Returns the reminder's row as it is *after* all of
 * that (null when deleted), never a snapshot from before the handoffs. If the
 * visible calendar state differs from when it started, the owner is told with
 * the current row, so a change made on behalf of another request (whose own
 * response already went out) still reaches open clients.
 */
async function exclusive(
  ref: Pick<Reminder, 'userId' | 'id'>,
  deps: ReminderCalendarDeps,
  fn: () => Promise<Reminder | null>,
  onBusy: () => Reminder | null,
): Promise<Reminder | null> {
  if (writingEvent.has(ref.id)) {
    handedOff.set(ref.id, { userId: ref.userId, deps });
    return onBusy();
  }
  writingEvent.add(ref.id);
  const before = getReminder(ref.userId, ref.id);
  let broadcast = deps.broadcast;
  try {
    await fn();
    // Finish whatever was handed to us while we held the lock: a new
    // reservation (`pending`) or an owed patch (`updating`) on the current row.
    for (let i = 0; i < MAX_HANDOFF_ROUNDS; i += 1) {
      const handoff = handedOff.get(ref.id);
      if (!handoff) break;
      handedOff.delete(ref.id);
      broadcast = broadcast ?? handoff.deps.broadcast;
      const row = getReminder(handoff.userId, ref.id);
      if (row?.calendar.status === 'pending') {
        // Not first-attempt: whether this id was ever sent isn't known here.
        await insertLocked(row, handoff.deps, new Date(), false);
      } else if (row?.calendar.status === 'updating' || row?.calendar.status === 'failed') {
        await syncLocked(row, handoff.deps, new Date());
      }
    }
  } finally {
    writingEvent.delete(ref.id);
  }
  const after = getReminder(ref.userId, ref.id);
  if (broadcast && after && calendarView(before) !== calendarView(after)) {
    broadcastReminderUpdate(broadcast, 'updated', after);
  }
  return after;
}

/** Busy: leave the owed patch durably due now and report the current row. */
function deferSync(reminder: Pick<Reminder, 'userId' | 'id'>, now: Date): Reminder | null {
  const current = getReminder(reminder.userId, reminder.id);
  if (current?.calendar.eventId && current.calendar.status !== 'pending') {
    markCalendarUpdating(current.userId, current.id, current.calendar.eventId, now);
  }
  return getReminder(reminder.userId, reminder.id);
}

/**
 * One insert attempt for a reminder whose event id is reserved (`pending`).
 * Call with the reminder's event lock held. Re-reads the row first: whatever
 * was decided before the lock was taken may be out of date.
 *
 * Links the event, or queues it for removal when the reminder was deleted or
 * moved off this id meanwhile, and patches it when the reminder changed
 * meanwhile. Returns the reminder's current row, or null when it no longer
 * exists; callers must not substitute a snapshot for null.
 *
 * `firstAttempt` is true only for a freshly reserved id that has never been
 * sent to Google. Only then may an unavailable calendar clear it (`skipped`);
 * on a retry an earlier attempt may have created the event, so the id is
 * kept and retried.
 */
async function insertLocked(
  ref: Pick<Reminder, 'userId' | 'id'>,
  deps: ReminderCalendarDeps,
  now: Date,
  firstAttempt: boolean,
): Promise<Reminder | null> {
  let snapshot = getReminder(ref.userId, ref.id);
  if (!snapshot || snapshot.calendar.status !== 'pending' || !snapshot.calendar.eventId) {
    return snapshot;
  }
  const eventId = snapshot.calendar.eventId;
  // Reserved while no account was linked: the event goes to today's default.
  if (!snapshot.calendar.accountId) {
    snapshot = stampDefaultCalendarAccount(snapshot.userId, snapshot.id, eventId) ?? snapshot;
  }
  const accountId = snapshot.calendar.accountId;
  const calendarId = snapshot.calendar.calendarId ?? PRIMARY;
  let htmlLink: string | null = null;
  let alreadyExisted = false;
  // Once the request is out, its outcome is unknown until Google answers.
  let requestSent = false;
  try {
    const client = await resolve(deps, snapshot.userId, accountId);
    if ('skip' in client) {
      if (client.accountGone) return abandonCalendarLink(snapshot, eventId, client.skip);
      if (firstAttempt) {
        return setReminderCalendar(
          snapshot.userId,
          snapshot.id,
          { status: 'skipped', error: client.skip },
          eventId,
        );
      }
      return recordCalendarInsertFailure(
        snapshot.userId,
        snapshot.id,
        calendarId,
        eventId,
        client.skip,
        false,
        now,
        accountId,
      );
    }
    try {
      requestSent = true;
      const event = await client.insert(calendarId, {
        ...reminderEventResource(snapshot),
        id: eventId,
      });
      htmlLink = event.htmlLink ?? null;
    } catch (err) {
      // 409: an earlier attempt already created this id (its response was lost).
      if (googleStatus(err) !== 409) throw err;
      alreadyExisted = true;
    }
  } catch (err) {
    console.warn(`[reminders] calendar insert failed for ${snapshot.id}: ${errMessage(err)}`);
    return recordCalendarInsertFailure(
      snapshot.userId,
      snapshot.id,
      calendarId,
      eventId,
      errMessage(err),
      requestSent,
      now,
      accountId,
    );
  }

  const linked = linkCalendarEvent(
    snapshot.userId,
    snapshot.id,
    calendarId,
    eventId,
    htmlLink,
    now,
    snapshot,
    alreadyExisted,
    accountId,
  );
  if (linked.kind === 'orphaned') {
    if (linked.cleanup) await processCalendarCleanup(linked.cleanup, deps, now);
    // Only a deleted reminder reports null; a cancelled one is still live.
    return linked.reminder ? getReminder(linked.reminder.userId, linked.reminder.id) : null;
  }
  // Edited while the insert ran, or the event came from an earlier attempt
  // with an older snapshot: the link recorded `updating`, so the patch is
  // owed durably; do it now, still under the lock.
  if (linked.reminder.calendar.status === 'updating') {
    return syncLocked(linked.reminder, deps, now);
  }
  return linked.reminder;
}

/**
 * Bring a linked event up to the reminder's current fields. Call with the
 * reminder's event lock held. Re-reads after every patch and patches again
 * while the row moved on; marks `synced` only once the fields Google holds
 * match the row. If edits keep landing for every pass, it stops and leaves
 * the patch owed (`updating`, due now) for the sweep instead of claiming
 * success.
 */
async function syncLocked(
  ref: Pick<Reminder, 'userId' | 'id'>,
  deps: ReminderCalendarDeps,
  now: Date,
): Promise<Reminder | null> {
  const start = getReminder(ref.userId, ref.id);
  if (!start) return null;
  const { eventId, calendarId, status, accountId } = start.calendar;
  if (!eventId || (status !== 'synced' && status !== 'failed' && status !== 'updating')) {
    return start;
  }
  try {
    const client = await resolve(deps, start.userId, accountId);
    if ('skip' in client) {
      if (client.accountGone) return abandonCalendarLink(start, eventId, client.skip);
      return recordCalendarSyncFailure(start.userId, start.id, eventId, client.skip, now);
    }
    let sent = start;
    for (let i = 0; i < MAX_PATCH_PASSES; i += 1) {
      await client.patch(calendarId ?? PRIMARY, eventId, reminderEventResource(sent));
      const current = getReminder(start.userId, start.id);
      if (!current || current.calendar.eventId !== eventId) return current;
      if (sameEventFields(sent, current)) {
        if (current.calendar.status === 'synced') return current;
        return setReminderCalendar(
          start.userId,
          start.id,
          { ...current.calendar, status: 'synced', error: null },
          eventId,
        );
      }
      sent = current;
    }
    markCalendarUpdating(start.userId, start.id, eventId, now);
    return getReminder(start.userId, start.id);
  } catch (err) {
    console.warn(`[reminders] calendar update failed for ${start.id}: ${errMessage(err)}`);
    return recordCalendarSyncFailure(start.userId, start.id, eventId, errMessage(err), now);
  }
}

export type MirrorReminderResult =
  | { kind: 'live'; reminder: Reminder }
  /** Deleted while the mirror ran; any event it created is queued for removal. */
  | { kind: 'deleted' };

/** Create the calendar event for a new reminder and record the outcome. */
export async function mirrorReminderToCalendar(
  reminder: Reminder,
  deps: ReminderCalendarDeps,
  now: Date = new Date(),
): Promise<MirrorReminderResult> {
  const eventId = calendarEventIdFor(reminder.id);
  const reserved = beginCalendarInsert(
    reminder.userId,
    reminder.id,
    PRIMARY,
    eventId,
    new Date(now.getTime() + INSERT_LEASE_MS),
  );
  if (!reserved) return { kind: 'deleted' };
  // The reservation only applies to a reminder with no event yet; if
  // something else already owns its calendar state, leave it alone.
  if (reserved.calendar.eventId !== eventId || reserved.calendar.status !== 'pending') {
    return { kind: 'live', reminder: reserved };
  }
  const after = await exclusive(
    reminder,
    deps,
    () => insertLocked(reserved, deps, now, true),
    () => getReminder(reminder.userId, reminder.id),
  );
  return after ? { kind: 'live', reminder: after } : { kind: 'deleted' };
}

/**
 * Carry out the calendar effect a reminder write committed (see
 * `applyCalendarTransition` in the store). Each effect is already durable, so
 * anything that fails or is skipped here is retried by the sweep. Returns
 * the reminder's current row, or null when it no longer exists.
 */
export async function runReminderCalendarEffect(
  reminder: Reminder,
  effect: ReminderCalendarEffect,
  deps: ReminderCalendarDeps,
  now: Date = new Date(),
): Promise<Reminder | null> {
  if (effect.cleanup) await processCalendarCleanup(effect.cleanup, deps, now);
  if (effect.insert) {
    // A freshly reserved generation id has never reached Google, so this is
    // a first attempt: an unavailable calendar may clear it (`skipped`).
    // Busy means an older insert/patch is still out; the reserved `pending`
    // row is retried by the sweep once its lease lapses.
    return exclusive(
      reminder,
      deps,
      () => insertLocked(reminder, deps, now, true),
      () => getReminder(reminder.userId, reminder.id),
    );
  }
  if (effect.sync) {
    return exclusive(
      reminder,
      deps,
      () => syncLocked(reminder, deps, now),
      () => deferSync(reminder, now),
    );
  }
  return getReminder(reminder.userId, reminder.id);
}

/**
 * Push title / notes / time edits to a mirrored event (see `syncLocked`).
 * Returns the reminder's current row, or null when it was deleted meanwhile.
 */
export async function syncReminderCalendarEvent(
  reminder: Reminder,
  deps: ReminderCalendarDeps,
  now: Date = new Date(),
): Promise<Reminder | null> {
  return exclusive(
    reminder,
    deps,
    () => syncLocked(reminder, deps, now),
    () => deferSync(reminder, now),
  );
}

function googleStatus(err: unknown): number | null {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  for (const v of [e?.response?.status, e?.status, e?.code]) {
    const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Try to remove a queued calendar event. The cleanup row is dropped only when
 * Google confirms the event is gone (a 404 / 410 counts: someone already
 * deleted it); otherwise the failure is recorded and retried with backoff.
 * Never throws. Returns true when the event is gone.
 */
export async function processCalendarCleanup(
  cleanup: CalendarCleanup,
  deps: ReminderCalendarDeps,
  now: Date = new Date(),
): Promise<boolean> {
  // Tell open clients when this step changes what they show: `removing`
  // becoming `cancelled` once Google confirms, or a new retry reason.
  const announce = (change: CleanupReminderChange) => {
    if (!change || !deps.broadcast) return;
    const current = getReminder(change.userId, change.reminderId);
    if (current) broadcastReminderUpdate(deps.broadcast, 'updated', current);
  };
  try {
    const client = await resolve(deps, cleanup.userId, cleanup.accountId);
    if ('skip' in client) {
      // Its calendar can't be reached any more, so there is nothing to retry.
      if (client.accountGone) {
        announce(completeCalendarCleanup(cleanup.id));
        return true;
      }
      announce(recordCalendarCleanupFailure(cleanup.id, client.skip, now));
      return false;
    }
    await client.remove(cleanup.calendarId, cleanup.eventId);
    announce(completeCalendarCleanup(cleanup.id));
    return true;
  } catch (err) {
    const code = googleStatus(err);
    if (code === 404 || code === 410) {
      announce(completeCalendarCleanup(cleanup.id));
      return true;
    }
    console.warn(
      `[reminders] calendar delete failed for reminder ${cleanup.reminderId}: ${errMessage(err)}`,
    );
    announce(recordCalendarCleanupFailure(cleanup.id, errMessage(err), now));
    return false;
  }
}

export interface CalendarMaintenanceResult {
  cleanedUp: number;
  resynced: number;
}

/**
 * Scheduler sweep: retry queued event deletions, pending inserts, and failed
 * or owed event updates whose backoff (or lease) has elapsed. Never throws.
 *
 * When a retry changes what a client would show (e.g. "Adding to your
 * calendar" becoming "On your calendar"), `exclusive` sends the owner a
 * `reminder_update` with the current row, so an open pane updates without a
 * reload.
 */
export async function runReminderCalendarMaintenance(
  deps: ReminderCalendarDeps,
  now: Date = new Date(),
  broadcast?: BroadcastFn,
): Promise<CalendarMaintenanceResult> {
  // Announcements come from `exclusive`, like every other event write.
  const d: ReminderCalendarDeps = { ...deps, broadcast: broadcast ?? deps.broadcast };
  const result: CalendarMaintenanceResult = { cleanedUp: 0, resynced: 0 };
  try {
    for (const cleanup of listDueCalendarCleanups(now)) {
      if (await processCalendarCleanup(cleanup, d, now)) result.cleanedUp += 1;
    }
    for (const reminder of listCalendarInsertRetries(now)) {
      // Busy: the holder is already writing this event; skip it this round.
      const after = await exclusive(
        reminder,
        d,
        () => insertLocked(reminder, d, now, false),
        () => reminder,
      );
      if (after?.calendar.status === 'synced') result.resynced += 1;
    }
    for (const reminder of listCalendarSyncRetries(now)) {
      const after = await exclusive(
        reminder,
        d,
        () => syncLocked(reminder, d, now),
        () => reminder,
      );
      if (after?.calendar.status === 'synced') result.resynced += 1;
    }
  } catch (err) {
    console.warn(`[reminders] calendar maintenance failed: ${errMessage(err)}`);
  }
  return result;
}
