/**
 * Personal reminders: wire type plus the pure helpers web and mobile share
 * (grouping, time labels, snooze presets, datetime-local conversion).
 */

export type ReminderStatus = 'pending' | 'fired' | 'dismissed';
export type ReminderCalendarStatus =
  | 'none'
  | 'pending'
  | 'synced'
  | 'updating'
  | 'skipped'
  | 'failed'
  /** Queued for removal; Google hasn't confirmed it yet. */
  | 'removing'
  | 'cancelled';

export interface ReminderWire {
  id: string;
  userId: string;
  title: string;
  notes: string;
  remindAt: string;
  status: ReminderStatus;
  createdBy: 'user' | 'agent';
  sessionId: string | null;
  agentId: string | null;
  projectId: string | null;
  calendar: {
    status: ReminderCalendarStatus;
    calendarId: string | null;
    eventId: string | null;
    eventUrl: string | null;
    error: string | null;
  };
  firedAt: string | null;
  dismissedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Bumped by the server on every write; higher is newer. */
  revision: number;
}

export interface CreateReminderBody {
  title: string;
  notes?: string;
  remindAt?: string;
  inMinutes?: number;
  calendar?: 'auto' | 'none';
}

export interface UpdateReminderBody {
  title?: string;
  notes?: string;
  remindAt?: string;
  snoozeMinutes?: number;
  status?: ReminderStatus;
}

export const REMINDER_UPDATE_EVENT = 'reminder_update';

export interface ReminderGroups {
  /** Fired and waiting for the user to dismiss or snooze. Most recent first. */
  due: ReminderWire[];
  /** Pending, soonest first. */
  upcoming: ReminderWire[];
  /** Dismissed, most recently dismissed first. */
  dismissed: ReminderWire[];
}

function time(iso: string | null | undefined): number {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

export function groupReminders(list: readonly ReminderWire[]): ReminderGroups {
  const due = list.filter((r) => r.status === 'fired');
  const upcoming = list.filter((r) => r.status === 'pending');
  const dismissed = list.filter((r) => r.status === 'dismissed');
  due.sort((a, b) => time(b.remindAt) - time(a.remindAt));
  upcoming.sort((a, b) => time(a.remindAt) - time(b.remindAt));
  dismissed.sort((a, b) => time(b.dismissedAt ?? b.updatedAt) - time(a.dismissedAt ?? a.updatedAt));
  return { due, upcoming, dismissed };
}

/** Apply a `reminder_update` event to a local list. */
export interface ReminderUpdateEvent {
  action?: unknown;
  reminderId?: unknown;
  reminder?: unknown;
}

/**
 * Apply a `reminder_update` event (or a row from our own API response) to a
 * local list. Revision-aware: an update older than the row already held is
 * ignored, so out-of-order deliveries can't roll a reminder back.
 */
export function applyReminderUpdate(
  list: readonly ReminderWire[],
  event: ReminderUpdateEvent,
): ReminderWire[] {
  const id = typeof event.reminderId === 'string' ? event.reminderId : null;
  if (!id) return [...list];
  const rest = list.filter((r) => r.id !== id);
  if (event.action === 'deleted') return rest;
  const next = event.reminder as ReminderWire | null | undefined;
  if (!next || typeof next !== 'object') return rest;
  const held = list.find((r) => r.id === id);
  if (held && (held.revision ?? 0) > (next.revision ?? 0)) return [...list];
  return [...rest, next];
}

/**
 * Keeps a client's reminder list consistent when a list request and live
 * `reminder_update` events overlap. Without it, a list response captured
 * before an event (a reminder firing, a delete) lands after it and restores
 * the older state.
 *
 *  - Deletes are remembered for the life of the list (ids are never reused),
 *    so neither a late list response nor a late update can bring one back.
 *  - Ids touched by events while a load is in flight keep the newer of the
 *    live row and the response's row (by `revision`), and rows created by
 *    events during the load survive a response that predates them.
 *  - Only the latest load's response applies.
 */
export class ReminderListState {
  private readonly deleted = new Set<string>();
  private touched = new Set<string>();
  private seq = 0;

  /** Apply a live event or our own API response row. */
  apply(list: readonly ReminderWire[], event: ReminderUpdateEvent): ReminderWire[] {
    const id = typeof event.reminderId === 'string' ? event.reminderId : null;
    if (!id) return [...list];
    this.touched.add(id);
    if (event.action === 'deleted') {
      this.deleted.add(id);
      return list.filter((r) => r.id !== id);
    }
    if (this.deleted.has(id)) return [...list];
    return applyReminderUpdate(list, event);
  }

  /** Call when starting a list request; pass the returned token to `finishLoad`. */
  beginLoad(): number {
    this.seq += 1;
    this.touched = new Set();
    return this.seq;
  }

  /**
   * Merge a list response into the current list. Returns null when a newer
   * load has started since (`token` is stale), in which case keep `current`.
   */
  finishLoad(
    token: number,
    snapshot: readonly ReminderWire[],
    current: readonly ReminderWire[],
  ): ReminderWire[] | null {
    if (token !== this.seq) return null;
    const merged = new Map<string, ReminderWire>();
    for (const r of snapshot) if (!this.deleted.has(r.id)) merged.set(r.id, r);
    for (const id of this.touched) {
      if (this.deleted.has(id)) continue;
      const live = current.find((r) => r.id === id);
      if (!live) continue;
      const fromList = merged.get(id);
      if (!fromList || (live.revision ?? 0) > (fromList.revision ?? 0)) merged.set(id, live);
    }
    return [...merged.values()];
  }
}

const MINUTE_MS = 60 * 1000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function clock(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Short, local-time label: "in 25 min", "Today 3:00 PM", "Tomorrow 9:00 AM",
 * "Yesterday 4:30 PM", or "Fri, Oct 17, 9:00 AM".
 */
export function formatReminderTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return iso;
  const diff = at.getTime() - now.getTime();
  if (diff > 0 && diff < 60 * MINUTE_MS) {
    const mins = Math.max(1, Math.round(diff / MINUTE_MS));
    return `in ${mins} min`;
  }
  const days = Math.round((startOfDay(at) - startOfDay(now)) / (24 * 60 * MINUTE_MS));
  if (days === 0) return `Today ${clock(at)}`;
  if (days === 1) return `Tomorrow ${clock(at)}`;
  if (days === -1) return `Yesterday ${clock(at)}`;
  return at.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export interface ReminderPreset {
  /** Stable id for test ids and selection state. */
  id: '10m' | '1h' | '3h' | 'tomorrow-9am';
  label: string;
  /**
   * The absolute moment this preset means when picked at `now`. Resolve it at
   * the moment of the click and keep the result: re-deriving it later from a
   * stored minute count drifts ("Tomorrow 9 AM" turning into 9:10).
   */
  at: (now: Date) => Date;
}

const inMinutes = (minutes: number) => (now: Date) => new Date(now.getTime() + minutes * MINUTE_MS);

/** `hour`:00 local time on the day after `now`. */
export function tomorrowAt(hour: number, now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour, 0, 0, 0);
}

/** Quick picks for snoozing a reminder and for setting a new one. */
export const REMINDER_PRESETS: readonly ReminderPreset[] = [
  { id: '10m', label: '10 min', at: inMinutes(10) },
  { id: '1h', label: '1 hour', at: inMinutes(60) },
  { id: '3h', label: '3 hours', at: inMinutes(180) },
  { id: 'tomorrow-9am', label: 'Tomorrow 9 AM', at: (now) => tomorrowAt(9, now) },
];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** ISO → `YYYY-MM-DDTHH:mm` in local time, for `<input type="datetime-local">`. */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Strictly parse a local wall-clock time, `YYYY-MM-DD HH:mm` or
 * `YYYY-MM-DDTHH:mm`, to ISO UTC. Returns null for anything that isn't a real
 * moment: out-of-range parts, impossible dates (Feb 30), and times skipped by
 * a DST jump. `new Date(y, m, d, h, min)` silently rolls overflow forward
 * (25:00 becomes 01:00 the next day), so every part is range-checked and the
 * result is round-tripped against what was typed.
 */
export function parseLocalDateTime(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59) return null;
  const d = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    !Number.isFinite(d.getTime()) ||
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day ||
    d.getHours() !== hour ||
    d.getMinutes() !== minute
  ) {
    return null;
  }
  return d.toISOString();
}

/** Alias for the web `datetime-local` value, same strict rules. */
export const localInputToIso = parseLocalDateTime;

/** One-line calendar status for a reminder row, or null when there is nothing to say. */
export function reminderCalendarLabel(r: Pick<ReminderWire, 'calendar'>): string | null {
  switch (r.calendar.status) {
    case 'pending':
      return 'Adding to your calendar';
    case 'synced':
      return 'On your calendar';
    case 'updating':
      return 'Updating your calendar';
    case 'removing':
      // The event may still pop up until Google confirms the delete.
      return r.calendar.error
        ? `Removing from your calendar (will retry: ${r.calendar.error})`
        : 'Removing from your calendar';
    case 'cancelled':
      return 'Removed from your calendar';
    case 'skipped':
      return r.calendar.error ? `Not on calendar: ${r.calendar.error}` : 'Not on calendar';
    case 'failed':
      return r.calendar.error
        ? `Calendar sync failed: ${r.calendar.error}`
        : 'Calendar sync failed';
    default:
      return null;
  }
}
