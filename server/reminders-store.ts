/**
 * Per-user reminders (orgs.db, see `reminders-schema.ts`).
 *
 * Lifecycle: `pending` until `remind_at` passes, then the scheduler claims the
 * row (`fired`) and raises a notification. The user then dismisses it
 * (`dismissed`) or snoozes it, which moves `remind_at` forward and puts it back
 * to `pending`. Every read and write is scoped to the owning user id; there is
 * no admin override, same stance as personal todos.
 */
import { v4 as uuidv4 } from 'uuid';
import { getOrgsDb } from './orgs.js';
import { rfc3339ToNanos } from '../shared/utils/rfc3339.js';

export const REMINDER_STATUSES = ['pending', 'fired', 'dismissed'] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];
export type ReminderCreatedBy = 'user' | 'agent';
/**
 * `pending`: the event id is reserved and the insert is in flight or queued
 * for retry. `synced`: Google confirmed the event. `failed`: a linked event's
 * update failed and is retried. `cancelled`: the reminder was dismissed
 * before it fired, so its event was handed to the cleanup queue; re-arming it
 * reserves a fresh event.
 */
export type ReminderCalendarStatus =
  | 'none'
  | 'pending'
  | 'synced'
  /** The linked event's fields are behind the reminder; a patch is owed. */
  | 'updating'
  | 'skipped'
  | 'failed'
  /**
   * The event is queued for removal but Google hasn't confirmed it yet; it
   * may still pop up. `calendar.error` carries the last failed attempt.
   */
  | 'removing'
  /** Google confirmed every queued removal for this reminder. */
  | 'cancelled';

/** Dismissed reminders older than this are pruned. */
export const DISMISSED_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const MAX_TITLE_LENGTH = 200;
export const MAX_NOTES_LENGTH = 4000;

export interface Reminder {
  id: string;
  userId: string;
  title: string;
  notes: string;
  remindAt: string;
  status: ReminderStatus;
  createdBy: ReminderCreatedBy;
  sessionId: string | null;
  agentId: string | null;
  projectId: string | null;
  calendar: {
    status: ReminderCalendarStatus;
    calendarId: string | null;
    /**
     * Linked Google account whose calendar holds the event. Null only for an
     * event recorded before accounts were tracked (treated as the default).
     */
    accountId: string | null;
    eventId: string | null;
    eventUrl: string | null;
    error: string | null;
  };
  firedAt: string | null;
  dismissedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Bumped by the database on every write; higher is newer. */
  revision: number;
}

interface ReminderRow {
  id: string;
  user_id: string;
  title: string;
  notes: string;
  remind_at: string;
  status: ReminderStatus;
  created_by: ReminderCreatedBy;
  session_id: string | null;
  agent_id: string | null;
  project_id: string | null;
  calendar_status: ReminderCalendarStatus;
  calendar_id: string | null;
  calendar_account_id: string | null;
  calendar_event_id: string | null;
  calendar_event_url: string | null;
  calendar_error: string | null;
  calendar_attempts: number;
  calendar_retry_at: string | null;
  calendar_generation: number;
  delivered_at: string | null;
  delivery_lease_until: string | null;
  fired_at: string | null;
  dismissed_at: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

function rowToReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    notes: row.notes,
    remindAt: row.remind_at,
    status: row.status,
    createdBy: row.created_by,
    sessionId: row.session_id,
    agentId: row.agent_id,
    projectId: row.project_id,
    calendar: {
      status: row.calendar_status,
      calendarId: row.calendar_id,
      accountId: row.calendar_account_id ?? null,
      eventId: row.calendar_event_id,
      eventUrl: row.calendar_event_url,
      error: row.calendar_error,
    },
    firedAt: row.fired_at,
    dismissedAt: row.dismissed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

/**
 * Normalize an RFC 3339 date-time with an explicit offset (or `Z`) to ISO UTC,
 * or null. Strict on purpose: `Date.parse` rolls impossible dates into real
 * ones (Feb 30 becomes Mar 2), reads offset-less strings in the server's own
 * zone, and accepts free-form text, each of which would fire a reminder at a
 * time nobody asked for.
 */
export function normalizeRemindAt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const nanos = rfc3339ToNanos(value.trim());
  if (nanos === null) return null;
  return new Date(Number(nanos / 1_000_000n)).toISOString();
}

export interface CreateReminderInput {
  userId: string;
  title: string;
  notes?: string;
  /** ISO-8601; callers normalize with `normalizeRemindAt`. */
  remindAt: string;
  createdBy?: ReminderCreatedBy;
  sessionId?: string | null;
  agentId?: string | null;
  projectId?: string | null;
  now?: Date;
}

export function createReminder(input: CreateReminderInput): Reminder {
  const id = uuidv4();
  const at = (input.now ?? new Date()).toISOString();
  getOrgsDb()
    .prepare(
      `INSERT INTO reminders
         (id, user_id, title, notes, remind_at, status, created_by, session_id, agent_id,
          project_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.userId,
      input.title,
      input.notes ?? '',
      input.remindAt,
      input.createdBy ?? 'user',
      input.sessionId ?? null,
      input.agentId ?? null,
      input.projectId ?? null,
      at,
      at,
    );
  return getReminder(input.userId, id) as Reminder;
}

export function getReminder(userId: string, id: string): Reminder | null {
  const row = getOrgsDb()
    .prepare('SELECT * FROM reminders WHERE user_id = ? AND id = ?')
    .get(userId, id) as ReminderRow | undefined;
  return row ? rowToReminder(row) : null;
}

export interface ListRemindersOptions {
  status?: ReminderStatus[];
  sessionId?: string;
}

/**
 * Soonest first. Fired (awaiting dismissal) and pending reminders are what
 * the pane shows by default; dismissed ones only when asked for.
 */
export function listReminders(userId: string, opts: ListRemindersOptions = {}): Reminder[] {
  const where = ['user_id = ?'];
  const params: unknown[] = [userId];
  if (opts.status?.length) {
    where.push(`status IN (${opts.status.map(() => '?').join(', ')})`);
    params.push(...opts.status);
  }
  if (opts.sessionId) {
    where.push('session_id = ?');
    params.push(opts.sessionId);
  }
  const rows = getOrgsDb()
    .prepare(
      `SELECT * FROM reminders WHERE ${where.join(' AND ')} ORDER BY remind_at ASC, created_at ASC`,
    )
    .all(...params) as ReminderRow[];
  return rows.map(rowToReminder);
}

export interface UpdateReminderInput {
  title?: string;
  notes?: string;
  remindAt?: string;
  status?: ReminderStatus;
  now?: Date;
  /** How long the caller holds a fresh insert reservation before the sweep may retry it. */
  insertLeaseMs?: number;
}

/**
 * Calendar side effects a reminder write left for the caller to run. The
 * durable state for each is already committed with the write, so if the
 * caller never runs them the scheduler sweep does.
 */
export interface ReminderCalendarEffect {
  /** The event was moved to the cleanup queue; try removing it now. */
  cleanup: CalendarCleanup | null;
  /** A new event id was reserved (`pending`); try inserting it now. */
  insert: boolean;
  /** The linked event's fields are stale; patch it now. */
  sync: boolean;
}

export interface UpdateReminderResult {
  reminder: Reminder;
  calendar: ReminderCalendarEffect;
}

const NO_CALENDAR_EFFECT: ReminderCalendarEffect = { cleanup: null, insert: false, sync: false };

/**
 * The owner's default Google account at the moment of the write (one `?`
 * parameter: the user id). New events always go to the current default.
 */
const DEFAULT_ACCOUNT_SQL =
  '(SELECT id FROM google_connections WHERE user_id = ? AND is_default = 1)';

/**
 * The Google event id for a reminder. Deterministic, so it can be stored
 * before the insert runs and a retried insert can't create a duplicate
 * (Google answers 409). `generation` advances each time a cancelled
 * reminder is re-armed, because Google keeps deleted ids reserved. Event ids
 * must be base32hex (`0-9a-v`), 5-1024 chars; a uuid's hex digits qualify.
 */
export function calendarEventIdFor(reminderId: string, generation = 0): string {
  const base = `ahr${reminderId.replace(/[^0-9a-f]/gi, '').toLowerCase()}`;
  return generation > 0 ? `${base}g${generation}` : base;
}

/**
 * The one place a reminder's state change decides what its calendar event
 * should be. Runs inside the write's transaction, so the event id is never
 * forgotten without being queued for cleanup.
 *
 *  - Dismissed before it fired: the event would still pop up, so it is
 *    queued for removal and the reminder becomes `cancelled`. An insert still
 *    in flight finds its id gone when it lands and removes its own event.
 *  - Re-armed from `cancelled`: reserve the next generation's id (`pending`).
 *  - Otherwise, a linked event whose title, notes or time changed is stale.
 *
 * A reminder dismissed after it fired keeps its event as history: the popup
 * already happened.
 */
function applyCalendarTransition(
  before: Reminder,
  after: Reminder,
  now: Date,
  insertLeaseMs: number,
): ReminderCalendarEffect {
  const db = getOrgsDb();
  const cal = after.calendar;
  if (after.status === 'dismissed' && !after.firedAt && cal.eventId) {
    const cleanup = enqueueCalendarCleanup(
      after.userId,
      after.id,
      cal.calendarId ?? 'primary',
      cal.eventId,
      now,
      cal.accountId,
    );
    // `removing` until Google confirms the delete (see completeCalendarCleanup);
    // claiming "removed" now would be wrong while the popup can still fire.
    db.prepare(
      `UPDATE reminders SET calendar_status = ?, calendar_event_id = NULL,
         calendar_event_url = NULL, calendar_error = NULL, calendar_attempts = 0,
         calendar_retry_at = NULL
       WHERE user_id = ? AND id = ?`,
    ).run(cleanup ? 'removing' : 'cancelled', after.userId, after.id);
    return { cleanup, insert: false, sync: false };
  }
  if (after.status !== 'dismissed' && (cal.status === 'cancelled' || cal.status === 'removing')) {
    const row = db
      .prepare('SELECT calendar_generation FROM reminders WHERE user_id = ? AND id = ?')
      .get(after.userId, after.id) as { calendar_generation: number };
    const generation = row.calendar_generation + 1;
    db.prepare(
      `UPDATE reminders SET calendar_status = 'pending', calendar_id = 'primary',
         calendar_account_id = ${DEFAULT_ACCOUNT_SQL},
         calendar_event_id = ?, calendar_event_url = NULL, calendar_error = NULL,
         calendar_attempts = 0, calendar_retry_at = ?, calendar_generation = ?
       WHERE user_id = ? AND id = ?`,
    ).run(
      after.userId,
      calendarEventIdFor(after.id, generation),
      new Date(now.getTime() + insertLeaseMs).toISOString(),
      generation,
      after.userId,
      after.id,
    );
    return { cleanup: null, insert: true, sync: false };
  }
  const fieldsChanged =
    before.title !== after.title ||
    before.notes !== after.notes ||
    before.remindAt !== after.remindAt;
  if (!fieldsChanged || !cal.eventId) return NO_CALENDAR_EFFECT;
  // A `pending` insert reconciles fields itself when it links. A linked event
  // is marked `updating` in this transaction, so the owed patch survives a
  // crash before the caller runs it; the lease keeps the sweep off it while
  // the caller does.
  if (cal.status === 'synced' || cal.status === 'failed' || cal.status === 'updating') {
    markCalendarUpdating(
      after.userId,
      after.id,
      cal.eventId,
      new Date(now.getTime() + insertLeaseMs),
    );
  }
  return { cleanup: null, insert: false, sync: true };
}

/**
 * Partial update. Moving `remindAt` into the future re-arms a fired or
 * dismissed reminder (that is what snooze does) unless the caller also sets a
 * status explicitly. The calendar transition commits in the same transaction.
 */
export function updateReminder(
  userId: string,
  id: string,
  input: UpdateReminderInput,
): UpdateReminderResult | null {
  const db = getOrgsDb();
  const now = input.now ?? new Date();
  const at = now.toISOString();
  return db.transaction((): UpdateReminderResult | null => {
    const existing = getReminder(userId, id);
    if (!existing) return null;
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.title !== undefined) {
      sets.push('title = ?');
      params.push(input.title);
    }
    if (input.notes !== undefined) {
      sets.push('notes = ?');
      params.push(input.notes);
    }
    let status = input.status;
    if (input.remindAt !== undefined) {
      sets.push('remind_at = ?');
      params.push(input.remindAt);
      if (status === undefined && Date.parse(input.remindAt) > now.getTime()) status = 'pending';
    }
    if (status !== undefined && status !== existing.status) {
      sets.push('status = ?');
      params.push(status);
      if (status === 'pending') {
        // Re-armed: the next firing owes a fresh delivery.
        sets.push(
          'fired_at = NULL',
          'dismissed_at = NULL',
          'delivered_at = NULL',
          'delivery_lease_until = NULL',
        );
      }
      if (status === 'dismissed') {
        sets.push('dismissed_at = ?');
        params.push(at);
      }
      if (status === 'fired') {
        sets.push('fired_at = ?');
        params.push(at);
      }
    }
    if (!sets.length) return { reminder: existing, calendar: NO_CALENDAR_EFFECT };
    sets.push('updated_at = ?');
    params.push(at);
    db.prepare(`UPDATE reminders SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`).run(
      ...params,
      userId,
      id,
    );
    const updated = getReminder(userId, id) as Reminder;
    const calendar = applyCalendarTransition(
      existing,
      updated,
      now,
      input.insertLeaseMs ?? 5 * 60 * 1000,
    );
    return { reminder: getReminder(userId, id) as Reminder, calendar };
  })();
}

export interface CalendarLinkUpdate {
  status: ReminderCalendarStatus;
  calendarId?: string | null;
  /** Account holding the event. Omit to keep the recorded one. */
  accountId?: string | null;
  eventId?: string | null;
  eventUrl?: string | null;
  error?: string | null;
}

/**
 * Overwrite the calendar link. Writes made after awaiting Google must pass
 * `expectEventId`, the id they acted on: the write then applies only if the
 * reminder still holds that id, so a stale result can't clobber a dismissal,
 * a re-arm, or a newer reservation that happened during the await.
 */
export function setReminderCalendar(
  userId: string,
  id: string,
  link: CalendarLinkUpdate,
  expectEventId?: string | null,
): Reminder | null {
  const guard = expectEventId === undefined ? '' : ' AND calendar_event_id IS ?';
  getOrgsDb()
    .prepare(
      `UPDATE reminders SET calendar_status = ?, calendar_id = ?,
         calendar_account_id = CASE WHEN ? THEN ? ELSE calendar_account_id END,
         calendar_event_id = ?, calendar_event_url = ?, calendar_error = ?,
         calendar_attempts = 0, calendar_retry_at = NULL
       WHERE user_id = ? AND id = ?${guard}`,
    )
    .run(
      link.status,
      link.calendarId ?? null,
      link.accountId !== undefined ? 1 : 0,
      link.accountId ?? null,
      link.eventId ?? null,
      link.eventUrl ?? null,
      link.error ?? null,
      userId,
      id,
      ...(expectEventId === undefined ? [] : [expectEventId]),
    );
  return getReminder(userId, id);
}

/**
 * Exponential backoff for calendar retries: 1, 2, 4 … minutes, capped at 6
 * hours. There is deliberately no attempt limit. Every pending calendar side
 * effect (insert, update, delete) is the only record that the work is
 * unfinished, so giving up would silently strand an event on the user's
 * calendar. At the cap a stuck item costs one cheap check every 6 hours, and
 * reconnecting Google (`wakeReminderCalendarWork`) retries everything at once.
 */
export function calendarRetryDelayMs(attempts: number): number {
  return Math.min(6 * 60, 2 ** Math.min(16, Math.max(0, attempts - 1))) * 60 * 1000;
}

/**
 * A linked event's update failed. Keep the event id so the next edit or the
 * retry sweep can patch it, and schedule the next attempt.
 */
export function recordCalendarSyncFailure(
  userId: string,
  id: string,
  eventId: string,
  error: string,
  now: Date = new Date(),
): Reminder | null {
  const row = getOrgsDb()
    .prepare('SELECT calendar_attempts FROM reminders WHERE user_id = ? AND id = ?')
    .get(userId, id) as { calendar_attempts: number } | undefined;
  if (!row) return null;
  const attempts = row.calendar_attempts + 1;
  const retryAt = new Date(now.getTime() + calendarRetryDelayMs(attempts)).toISOString();
  getOrgsDb()
    .prepare(
      `UPDATE reminders SET calendar_status = 'failed', calendar_error = ?,
         calendar_attempts = ?, calendar_retry_at = ?
       WHERE user_id = ? AND id = ? AND calendar_event_id = ?`,
    )
    .run(error, attempts, retryAt, userId, id, eventId);
  return getReminder(userId, id);
}

/** Linked events whose last update failed and whose retry time has come. */
export function listCalendarSyncRetries(now: Date = new Date(), limit = 50): Reminder[] {
  const rows = getOrgsDb()
    .prepare(
      `SELECT * FROM reminders
       WHERE calendar_status IN ('failed', 'updating') AND calendar_event_id IS NOT NULL
         AND calendar_retry_at IS NOT NULL AND calendar_retry_at <= ?
       ORDER BY calendar_retry_at ASC LIMIT ?`,
    )
    .all(now.toISOString(), limit) as ReminderRow[];
  return rows.map(rowToReminder);
}

export interface CalendarCleanup {
  id: string;
  userId: string;
  reminderId: string;
  calendarId: string;
  /** Account whose calendar holds the event; null means the default (legacy rows). */
  accountId: string | null;
  eventId: string;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
}

interface CalendarCleanupRow {
  id: string;
  user_id: string;
  reminder_id: string;
  calendar_id: string;
  account_id: string | null;
  event_id: string;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
}

function rowToCleanup(row: CalendarCleanupRow): CalendarCleanup {
  return {
    id: row.id,
    userId: row.user_id,
    reminderId: row.reminder_id,
    calendarId: row.calendar_id,
    accountId: row.account_id ?? null,
    eventId: row.event_id,
    attempts: row.attempts,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
  };
}

export interface DeleteReminderResult {
  deleted: boolean;
  /** Queued removal of the mirrored calendar event, when there was one. */
  cleanup: CalendarCleanup | null;
}

/**
 * Delete a reminder. When it has a calendar event, a cleanup row is written in
 * the same transaction, so the event id survives until the calendar delete
 * succeeds even if that call fails or the process dies mid-request.
 */
export function deleteReminder(
  userId: string,
  id: string,
  now: Date = new Date(),
): DeleteReminderResult {
  const db = getOrgsDb();
  return db.transaction((): DeleteReminderResult => {
    const existing = getReminder(userId, id);
    if (!existing) return { deleted: false, cleanup: null };
    // Any reserved event id is queued, including a `pending` insert that may
    // land after this delete; the insert path re-queues it if so.
    const cleanup = existing.calendar.eventId
      ? enqueueCalendarCleanup(
          userId,
          id,
          existing.calendar.calendarId ?? 'primary',
          existing.calendar.eventId,
          now,
          existing.calendar.accountId,
        )
      : null;
    db.prepare('DELETE FROM reminders WHERE user_id = ? AND id = ?').run(userId, id);
    return { deleted: true, cleanup };
  })();
}

/**
 * Queue a calendar event for removal on `accountId`'s calendar (null: the
 * default account, for events recorded before accounts were tracked).
 * Returns null if the user is gone.
 */
export function enqueueCalendarCleanup(
  userId: string,
  reminderId: string,
  calendarId: string,
  eventId: string,
  now: Date,
  accountId: string | null,
): CalendarCleanup | null {
  const db = getOrgsDb();
  const user = db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  const at = now.toISOString();
  const cleanupId = uuidv4();
  db.prepare(
    `INSERT INTO reminder_calendar_cleanups
       (id, user_id, reminder_id, calendar_id, account_id, event_id, next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(cleanupId, userId, reminderId, calendarId, accountId, eventId, at, at);
  // A reminder already shown as removed has an event to remove again (a late
  // or lost-response insert landed after its dismissal): back to `removing`.
  db.prepare(
    `UPDATE reminders SET calendar_status = 'removing'
     WHERE user_id = ? AND id = ? AND calendar_status = 'cancelled'`,
  ).run(userId, reminderId);
  return getCalendarCleanup(cleanupId);
}

/**
 * Reserve the event id before calling Google. The reminder then always names
 * its event, so a delete racing the insert still queues cleanup. `leaseUntil`
 * keeps the retry sweep off an insert that is still in flight.
 */
export function beginCalendarInsert(
  userId: string,
  id: string,
  calendarId: string,
  eventId: string,
  leaseUntil: Date,
): Reminder | null {
  getOrgsDb()
    .prepare(
      `UPDATE reminders SET calendar_status = 'pending', calendar_id = ?,
         calendar_account_id = ${DEFAULT_ACCOUNT_SQL}, calendar_event_id = ?,
         calendar_event_url = NULL, calendar_error = NULL, calendar_retry_at = ?
       WHERE user_id = ? AND id = ? AND calendar_event_id IS NULL`,
    )
    .run(calendarId, userId, eventId, leaseUntil.toISOString(), userId, id);
  return getReminder(userId, id);
}

/**
 * Record the owner's current default account on a reservation that has none
 * (reserved while no account was linked, or before accounts were tracked).
 * Applies only while the reminder still holds `eventId`.
 */
export function stampDefaultCalendarAccount(
  userId: string,
  id: string,
  eventId: string,
): Reminder | null {
  getOrgsDb()
    .prepare(
      `UPDATE reminders SET calendar_account_id = ${DEFAULT_ACCOUNT_SQL}
       WHERE user_id = ? AND id = ? AND calendar_event_id = ? AND calendar_account_id IS NULL`,
    )
    .run(userId, userId, id, eventId);
  return getReminder(userId, id);
}

export type LinkCalendarEventResult =
  | { kind: 'linked'; reminder: Reminder }
  /**
   * The event is no longer wanted and was queued for removal: the reminder
   * was deleted (`reminder` null), or dismissed / re-armed under a newer
   * event id while the insert ran (`reminder` is its current row).
   */
  | { kind: 'orphaned'; cleanup: CalendarCleanup | null; reminder: Reminder | null };

/**
 * Google confirmed the event. Link it if the reminder still exists, otherwise
 * queue the event for removal, atomically with the existence check.
 */
/**
 * Record that a linked event needs a patch: `updating`, due at `dueAt`.
 * Cleared only by a sync that confirmed the current fields at Google.
 */
export function markCalendarUpdating(
  userId: string,
  id: string,
  eventId: string,
  dueAt: Date,
): void {
  getOrgsDb()
    .prepare(
      `UPDATE reminders SET calendar_status = 'updating', calendar_error = NULL,
         calendar_retry_at = ?
       WHERE user_id = ? AND id = ? AND calendar_event_id = ?`,
    )
    .run(dueAt.toISOString(), userId, id, eventId);
}

/**
 * Google confirmed the event. Link it if the reminder still holds this id,
 * otherwise queue the event for removal, atomically with the check.
 *
 * `sentFields` is what the event was created with. When it no longer matches
 * the reminder (edited during the insert), or `mayBeStale` is set (the event
 * came from an earlier attempt, seen as a 409), the link is recorded as
 * `updating` rather than `synced`, so the patch is owed durably.
 */
export function linkCalendarEvent(
  userId: string,
  id: string,
  calendarId: string,
  eventId: string,
  eventUrl: string | null,
  now: Date = new Date(),
  sentFields?: Pick<Reminder, 'title' | 'notes' | 'remindAt'>,
  mayBeStale = false,
  accountId: string | null = null,
): LinkCalendarEventResult {
  const db = getOrgsDb();
  return db.transaction((): LinkCalendarEventResult => {
    const existing = getReminder(userId, id);
    if (!existing || existing.calendar.eventId !== eventId) {
      return {
        kind: 'orphaned',
        cleanup: enqueueCalendarCleanup(userId, id, calendarId, eventId, now, accountId),
        reminder: existing,
      };
    }
    const stale =
      mayBeStale ||
      (!!sentFields &&
        (sentFields.title !== existing.title ||
          sentFields.notes !== existing.notes ||
          sentFields.remindAt !== existing.remindAt));
    setReminderCalendar(userId, id, {
      status: 'synced',
      calendarId,
      eventId,
      eventUrl,
      ...(accountId ? { accountId } : {}),
    });
    if (stale) markCalendarUpdating(userId, id, eventId, now);
    return { kind: 'linked', reminder: getReminder(userId, id) as Reminder };
  })();
}

/**
 * An insert attempt failed. While the reminder still holds this id it stays
 * `pending` and is retried with backoff; the id is never dropped, since an
 * earlier attempt may have created the event even though its response was
 * lost.
 *
 * If the reservation is no longer owned (the reminder was deleted, or
 * dismissed / re-armed onto another id while the request was out) and
 * `requestSent` is true, Google may still have created the event after the
 * owner's cleanup already ran. Responsibility for it moves to the cleanup
 * queue, in the same transaction, exactly as a successful late insert does;
 * a 404 there settles it if nothing was created.
 */
export function recordCalendarInsertFailure(
  userId: string,
  id: string,
  calendarId: string,
  eventId: string,
  error: string,
  requestSent: boolean,
  now: Date = new Date(),
  accountId: string | null = null,
): Reminder | null {
  const db = getOrgsDb();
  return db.transaction((): Reminder | null => {
    const existing = getReminder(userId, id);
    if (!existing || existing.calendar.eventId !== eventId) {
      if (requestSent) enqueueCalendarCleanup(userId, id, calendarId, eventId, now, accountId);
      return existing;
    }
    const row = db
      .prepare('SELECT calendar_attempts FROM reminders WHERE user_id = ? AND id = ?')
      .get(userId, id) as { calendar_attempts: number };
    const attempts = row.calendar_attempts + 1;
    db.prepare(
      `UPDATE reminders SET calendar_error = ?, calendar_attempts = ?, calendar_retry_at = ?
       WHERE user_id = ? AND id = ? AND calendar_status = 'pending' AND calendar_event_id = ?`,
    ).run(
      error,
      attempts,
      new Date(now.getTime() + calendarRetryDelayMs(attempts)).toISOString(),
      userId,
      id,
      eventId,
    );
    return getReminder(userId, id);
  })();
}

/** Pending inserts whose lease or backoff has elapsed. */
export function listCalendarInsertRetries(now: Date = new Date(), limit = 50): Reminder[] {
  const rows = getOrgsDb()
    .prepare(
      `SELECT * FROM reminders
       WHERE calendar_status = 'pending' AND calendar_event_id IS NOT NULL
         AND (calendar_retry_at IS NULL OR calendar_retry_at <= ?)
       ORDER BY calendar_retry_at ASC LIMIT ?`,
    )
    .all(now.toISOString(), limit) as ReminderRow[];
  return rows.map(rowToReminder);
}

export function getCalendarCleanup(id: string): CalendarCleanup | null {
  const row = getOrgsDb()
    .prepare('SELECT * FROM reminder_calendar_cleanups WHERE id = ?')
    .get(id) as CalendarCleanupRow | undefined;
  return row ? rowToCleanup(row) : null;
}

export function listDueCalendarCleanups(now: Date = new Date(), limit = 50): CalendarCleanup[] {
  const rows = getOrgsDb()
    .prepare(
      `SELECT * FROM reminder_calendar_cleanups WHERE next_attempt_at <= ?
       ORDER BY next_attempt_at ASC LIMIT ?`,
    )
    .all(now.toISOString(), limit) as CalendarCleanupRow[];
  return rows.map(rowToCleanup);
}

/** The reminder whose visible calendar state a cleanup step changed, if any. */
export type CleanupReminderChange = { userId: string; reminderId: string } | null;

/**
 * Google confirmed the event is gone. Once no removal is left queued for the
 * reminder, a `removing` reminder becomes `cancelled`: only then is "removed
 * from your calendar" true.
 */
export function completeCalendarCleanup(id: string): CleanupReminderChange {
  const db = getOrgsDb();
  return db.transaction((): CleanupReminderChange => {
    const row = getCalendarCleanup(id);
    db.prepare('DELETE FROM reminder_calendar_cleanups WHERE id = ?').run(id);
    if (!row) return null;
    const changed = db
      .prepare(
        `UPDATE reminders SET calendar_status = 'cancelled', calendar_error = NULL
         WHERE user_id = ? AND id = ? AND calendar_status = 'removing'
           AND NOT EXISTS (SELECT 1 FROM reminder_calendar_cleanups WHERE reminder_id = ?)`,
      )
      .run(row.userId, row.reminderId, row.reminderId).changes;
    return changed ? { userId: row.userId, reminderId: row.reminderId } : null;
  })();
}

/**
 * Record a failed calendar delete and schedule the next attempt. The row is
 * kept until Google confirms the event is gone: once the reminder is deleted
 * it is the only reference to the event.
 */
export function recordCalendarCleanupFailure(
  id: string,
  error: string,
  now: Date = new Date(),
): CleanupReminderChange {
  const row = getCalendarCleanup(id);
  if (!row) return null;
  const attempts = row.attempts + 1;
  getOrgsDb()
    .prepare(
      `UPDATE reminder_calendar_cleanups SET attempts = ?, last_error = ?, next_attempt_at = ?
       WHERE id = ?`,
    )
    .run(
      attempts,
      error,
      new Date(now.getTime() + calendarRetryDelayMs(attempts)).toISOString(),
      id,
    );
  // A reminder still waiting on this removal shows why it hasn't happened.
  const changed = getOrgsDb()
    .prepare(
      `UPDATE reminders SET calendar_error = ?
       WHERE user_id = ? AND id = ? AND calendar_status = 'removing'
         AND calendar_error IS NOT ?`,
    )
    .run(error, row.userId, row.reminderId, error).changes;
  return changed ? { userId: row.userId, reminderId: row.reminderId } : null;
}

/**
 * Make all of a user's unfinished calendar work due now and restart its
 * backoff. Called when the user (re)connects Google, the usual fix for work
 * that kept failing with "not connected" or an auth error.
 */
export function wakeReminderCalendarWork(userId: string, now: Date = new Date()): void {
  const db = getOrgsDb();
  const at = now.toISOString();
  db.transaction(() => {
    db.prepare(
      `UPDATE reminders SET calendar_retry_at = ?, calendar_attempts = 0
       WHERE user_id = ? AND calendar_event_id IS NOT NULL
         AND calendar_status IN ('pending', 'updating', 'failed')`,
    ).run(at, userId);
    db.prepare(
      `UPDATE reminder_calendar_cleanups SET next_attempt_at = ?, attempts = 0 WHERE user_id = ?`,
    ).run(at, userId);
  })();
}

/** Pending reminders whose time has come, oldest first, across all users. */
export function listDueReminders(now: Date = new Date(), limit = 200): Reminder[] {
  const rows = getOrgsDb()
    .prepare(
      `SELECT * FROM reminders WHERE status = 'pending' AND remind_at <= ?
       ORDER BY remind_at ASC LIMIT ?`,
    )
    .all(now.toISOString(), limit) as ReminderRow[];
  return rows.map(rowToReminder);
}

/**
 * Atomically flip a pending reminder to fired. Only one caller wins, so a
 * second scheduler tick (or a second Hub on the same DB) can't notify twice.
 */
export function claimDueReminder(
  id: string,
  now: Date = new Date(),
  deliveryLeaseMs = DELIVERY_LEASE_MS,
): Reminder | null {
  const at = now.toISOString();
  // The claim and the owed delivery are one write: `delivered_at` stays NULL
  // until the inbox fan-out succeeds, and the lease gives this tick the first
  // try. If the process dies before delivering, a later tick picks it up.
  const info = getOrgsDb()
    .prepare(
      `UPDATE reminders SET status = 'fired', fired_at = ?, updated_at = ?,
         delivered_at = NULL, delivery_lease_until = ?
       WHERE id = ? AND status = 'pending' AND remind_at <= ?`,
    )
    .run(at, at, new Date(now.getTime() + deliveryLeaseMs).toISOString(), id, at);
  if (!info.changes) return null;
  const row = getOrgsDb().prepare('SELECT * FROM reminders WHERE id = ?').get(id) as
    | ReminderRow
    | undefined;
  return row ? rowToReminder(row) : null;
}

/** How long a tick owns a delivery attempt before another tick may retry it. */
export const DELIVERY_LEASE_MS = 2 * 60 * 1000;

/**
 * Fired reminders whose notification is still owed and whose delivery lease
 * has lapsed, as `{ id, firedAt }` candidates. Nothing is claimed here: a
 * batch claimed up front goes stale while earlier deliveries are awaited, so
 * each candidate is claimed with `claimReminderDelivery` right before its
 * own delivery.
 */
export function listUndeliveredReminders(
  now: Date = new Date(),
  limit = 100,
): Array<{ id: string; firedAt: string }> {
  const rows = getOrgsDb()
    .prepare(
      `SELECT id, fired_at FROM reminders
       WHERE status = 'fired' AND fired_at IS NOT NULL AND delivered_at IS NULL
         AND (delivery_lease_until IS NULL OR delivery_lease_until <= ?)
       ORDER BY fired_at ASC LIMIT ?`,
    )
    .all(now.toISOString(), limit) as Array<{ id: string; fired_at: string }>;
  return rows.map((r) => ({ id: r.id, firedAt: r.fired_at }));
}

/**
 * Atomically claim the delivery of one firing, immediately before sending it.
 * Succeeds only while the reminder still owes exactly that notification: it
 * is still `fired` for the same firing (`firedAt`; a snooze or re-arm clears
 * it, a re-fire changes it), not dismissed, not yet delivered, and no other
 * tick holds an unexpired lease. Returns the current row to deliver, or null
 * when nothing is owed any more.
 */
export function claimReminderDelivery(
  id: string,
  firedAt: string,
  now: Date = new Date(),
  leaseMs = DELIVERY_LEASE_MS,
): Reminder | null {
  const at = now.toISOString();
  const info = getOrgsDb()
    .prepare(
      `UPDATE reminders SET delivery_lease_until = ?
       WHERE id = ? AND status = 'fired' AND fired_at = ? AND delivered_at IS NULL
         AND (delivery_lease_until IS NULL OR delivery_lease_until <= ?)`,
    )
    .run(new Date(now.getTime() + leaseMs).toISOString(), id, firedAt, at);
  if (!info.changes) return null;
  const row = getOrgsDb().prepare('SELECT * FROM reminders WHERE id = ?').get(id) as
    | ReminderRow
    | undefined;
  return row ? rowToReminder(row) : null;
}

/** The notification for this firing (`firedAt`) reached the inbox fan-out. */
export function markReminderDelivered(id: string, firedAt: string, now: Date = new Date()): void {
  getOrgsDb()
    .prepare(
      `UPDATE reminders SET delivered_at = ?, delivery_lease_until = NULL
       WHERE id = ? AND fired_at = ?`,
    )
    .run(now.toISOString(), id, firedAt);
}

/**
 * Retention: delete dismissed reminders older than DISMISSED_RETENTION_DAYS.
 * Like every other delete, an event whose state isn't settled (`pending`
 * insert, `failed` update) is moved to the cleanup queue in the same
 * transaction instead of being forgotten. A `synced` event of a reminder that
 * fired stays on the calendar as history, as it did before the prune.
 */
export function pruneDismissedReminders(
  now: Date = new Date(),
): Array<{ userId: string; id: string }> {
  const db = getOrgsDb();
  const cutoff = new Date(now.getTime() - DISMISSED_RETENTION_DAYS * DAY_MS).toISOString();
  return db.transaction((): Array<{ userId: string; id: string }> => {
    const rows = db
      .prepare(`SELECT * FROM reminders WHERE status = 'dismissed' AND updated_at < ?`)
      .all(cutoff) as ReminderRow[];
    const del = db.prepare('DELETE FROM reminders WHERE user_id = ? AND id = ?');
    for (const r of rows) {
      if (
        r.calendar_event_id &&
        (r.calendar_status === 'pending' ||
          r.calendar_status === 'updating' ||
          r.calendar_status === 'failed')
      ) {
        enqueueCalendarCleanup(
          r.user_id,
          r.id,
          r.calendar_id ?? 'primary',
          r.calendar_event_id,
          now,
          r.calendar_account_id ?? null,
        );
      }
      del.run(r.user_id, r.id);
    }
    return rows.map((r) => ({ userId: r.user_id, id: r.id }));
  })();
}
