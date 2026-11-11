/**
 * `agenthub:poller` blocks: an agent proposes a recurring check ("every 30 min
 * check dev for new tickets until 9am") and the user confirms the schedule on
 * a card before the server starts waking the session.
 *
 * Shared by web, mobile and the server so all three accept the same shapes.
 */

const POLLER_FENCE_RE = /```agenthub:poller\s*\n?([\s\S]*?)\n?```/g;
const POLLER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export const POLLER_TASK_MAX_LEN = 2_000;
/** One week: pollers are for throwaway checks, not standing schedules. */
export const POLLER_MAX_DURATION_MINUTES = 7 * 24 * 60;
export const POLLER_MAX_INTERVAL_MINUTES = POLLER_MAX_DURATION_MINUTES;

export interface PollerProposal {
  pollerId: string;
  task: string;
  intervalMinutes: number | null;
  durationMinutes: number | null;
  /**
   * End time the user named ("until tomorrow at 9am"), e.g. `tomorrow 09:00`.
   * Resolved in the viewer's timezone, which the agent cannot know but the
   * card can. See {@link parsePollerUntil}.
   */
  until: string | null;
  notifyEachRun: boolean;
  notifyOnComplete: boolean;
}

export interface PollerExtraction {
  strippedText: string;
  pollers: PollerProposal[];
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** A whole number of minutes in range, or null. Accepts numeric strings. */
export function parsePollerMinutes(value: unknown, max: number): number | null {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const whole = Math.round(n);
  if (whole <= 0 || whole > max) return null;
  return whole;
}

export function parsePollerEnvelope(raw: string): PollerProposal | null {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const task = typeof parsed.task === 'string' ? parsed.task.trim() : '';
  if (!task) return null;
  const idRaw = typeof parsed.pollerId === 'string' ? parsed.pollerId.trim() : '';
  const until =
    typeof parsed.until === 'string' && parsed.until.trim() ? parsed.until.trim() : null;
  return {
    pollerId: POLLER_ID_RE.test(idRaw) ? idRaw : `poller-${simpleHash(raw)}`,
    task: task.slice(0, POLLER_TASK_MAX_LEN),
    intervalMinutes: parsePollerMinutes(parsed.intervalMinutes, POLLER_MAX_INTERVAL_MINUTES),
    durationMinutes: parsePollerMinutes(parsed.durationMinutes, POLLER_MAX_DURATION_MINUTES),
    until: until && parsePollerUntil(until, new Date()) ? until : null,
    notifyEachRun: parsed.notifyEachRun === true,
    notifyOnComplete: parsed.notifyOnComplete !== false,
  };
}

const NAIVE_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const RELATIVE_TIME_RE = /^(?:(today|tomorrow)\s*(?:at\s*)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i;

function relativeUntil(match: RegExpExecArray, now: Date): Date | null {
  const [, day, hRaw, mRaw, meridiem] = match;
  // A bare number ("9") is too ambiguous to schedule against.
  if (mRaw === undefined && !meridiem) return null;
  let hour = Number(hRaw);
  const minute = mRaw === undefined ? 0 : Number(mRaw);
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  const dayWord = day?.toLowerCase();
  // No day named: the next time the clock reads that time.
  if (dayWord === 'tomorrow' || (!dayWord && at.getTime() <= now.getTime())) {
    at.setDate(at.getDate() + 1);
  }
  return at;
}

/**
 * Resolve an `until` value to a Date, in the runtime's local timezone (the
 * viewer's, on web and mobile):
 * - `tomorrow 09:00`, `today 5pm`, `09:00` (next occurrence)
 * - `YYYY-MM-DDTHH:mm` without an offset: local wall-clock time
 * - ISO with an offset or `Z`: absolute
 */
export function parsePollerUntil(until: string, now: Date): Date | null {
  const text = until.trim();
  const relative = RELATIVE_TIME_RE.exec(text);
  if (relative) return relativeUntil(relative, now);
  const naive = NAIVE_LOCAL_RE.exec(text);
  if (naive) {
    const [, y, mo, d, h, mi, s] = naive;
    const date = new Date(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      s ? Number(s) : 0,
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text)) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * When the proposal was made: its message's `created_at`. Hub rows store
 * SQLite `YYYY-MM-DD HH:MM:SS` in UTC with no zone marker, which `new Date`
 * would read as local time, so that shape is pinned to UTC here.
 */
export function parsePollerAnchor(createdAt: unknown): Date | null {
  if (typeof createdAt === 'number' && Number.isFinite(createdAt)) return new Date(createdAt);
  if (typeof createdAt !== 'string' || !createdAt.trim()) return null;
  const text = createdAt.trim();
  const sqlite = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(text);
  const date = new Date(sqlite ? `${sqlite[1]}T${sqlite[2]}Z` : text);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface PollerSchedulePlan {
  /** Absolute end the user named, or null when they gave a duration instead. */
  deadline: Date | null;
  /** The named end time was already behind us when the card was shown. */
  deadlinePassed: boolean;
  /** Pre-fill for the duration field; null leaves it for the user. */
  initialDurationMinutes: number | null;
}

/**
 * Work out the schedule a proposal describes. Relative end times ("tomorrow
 * 09:00", "17:00") are resolved against `anchor`, the moment the proposal was
 * made, so reopening the session later still targets the day the user meant
 * instead of re-reading "tomorrow" from whenever the card happens to render.
 * Resolution happens in the runtime's local timezone (the viewer's).
 */
export function planPollerSchedule(
  proposal: PollerProposal,
  opts: { anchor: Date; now: Date },
): PollerSchedulePlan {
  const deadline = proposal.until ? parsePollerUntil(proposal.until, opts.anchor) : null;
  if (!deadline) {
    return {
      deadline: null,
      deadlinePassed: false,
      initialDurationMinutes: proposal.durationMinutes,
    };
  }
  const minutes = Math.ceil((deadline.getTime() - opts.now.getTime()) / 60_000);
  const initialDurationMinutes = parsePollerMinutes(minutes, POLLER_MAX_DURATION_MINUTES);
  return { deadline, deadlinePassed: minutes <= 0, initialDurationMinutes };
}

/** How often a card re-reads poller state while it is not finished. */
export const SESSION_POLLER_REFRESH_MS = 30_000;

/**
 * Whether a card should keep reconciling with the server. True until the
 * poller is finished, including before one is known: it may be started from
 * another device, and push updates can be missed while a socket is down.
 */
export function shouldReconcilePoller(poller: SessionPoller | null): boolean {
  return poller === null || poller.status === 'active';
}

/**
 * Minutes to submit when the user clicks Start. A deadline the user named
 * ("until 9am") keeps meaning 9am however long the card sat open, so the
 * remaining time is recomputed now; once the user edits the duration, their
 * number wins. Null when the deadline has already passed.
 */
export function pollerStartDurationMinutes(input: {
  deadline: Date | null;
  durationEdited: boolean;
  formMinutes: number | null;
  now: Date;
}): number | null {
  if (!input.deadline || input.durationEdited) return input.formMinutes;
  const minutes = Math.ceil((input.deadline.getTime() - input.now.getTime()) / 60_000);
  return parsePollerMinutes(minutes, POLLER_MAX_DURATION_MINUTES);
}

export function extractPollerBlocks(text: string): PollerExtraction {
  if (!text || !text.includes('agenthub:poller')) return { strippedText: text, pollers: [] };
  const pollers: PollerProposal[] = [];
  const ranges: Array<{ start: number; end: number }> = [];
  POLLER_FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = POLLER_FENCE_RE.exec(text)) !== null) {
    const proposal = parsePollerEnvelope(match[1]?.trim() ?? '');
    if (!proposal) continue;
    pollers.push(proposal);
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  let strippedText = text;
  for (let i = ranges.length - 1; i >= 0; i--) {
    strippedText = strippedText.slice(0, ranges[i].start) + strippedText.slice(ranges[i].end);
  }
  return { strippedText: strippedText.replace(/\n{3,}/g, '\n\n').trim(), pollers };
}

export type SessionPollerStatus = 'active' | 'completed' | 'cancelled';

/** The poller as the REST API returns it. */
export interface SessionPoller {
  id: string;
  sessionId: string;
  pollerId: string;
  task: string;
  intervalMinutes: number;
  durationMinutes: number;
  notifyEachRun: boolean;
  notifyOnComplete: boolean;
  status: SessionPollerStatus;
  runCount: number;
  startedAt: string;
  endsAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  finishedAt: string | null;
}

/**
 * Runs that fit in the window when none are deferred: one right away, then
 * one per interval that starts before the window closes.
 */
export function expectedPollerRuns(intervalMinutes: number, durationMinutes: number): number {
  if (intervalMinutes <= 0 || durationMinutes <= 0) return 0;
  return Math.ceil(durationMinutes / intervalMinutes);
}

export function formatPollerMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 24 || m !== 0) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

export interface PollerFormValues {
  task: string;
  interval: string;
  duration: string;
}

export interface PollerFormCheck {
  intervalMinutes: number | null;
  durationMinutes: number | null;
  errors: Partial<Record<keyof PollerFormValues, string>>;
}

/** Whole-number check for what the user typed; the card only enables Start when clean. */
export function checkPollerForm(values: PollerFormValues): PollerFormCheck {
  const errors: PollerFormCheck['errors'] = {};
  const whole = (raw: string) => (/^\s*\d+\s*$/.test(raw) ? Number(raw) : Number.NaN);
  const intervalMinutes = parsePollerMinutes(whole(values.interval), POLLER_MAX_INTERVAL_MINUTES);
  const durationMinutes = parsePollerMinutes(whole(values.duration), POLLER_MAX_DURATION_MINUTES);
  if (!values.task.trim()) errors.task = 'Describe what to check';
  if (intervalMinutes === null) errors.interval = 'Whole minutes, more than 0';
  if (durationMinutes === null) {
    errors.duration =
      whole(values.duration) > POLLER_MAX_DURATION_MINUTES
        ? 'At most 7 days'
        : 'Whole minutes, more than 0';
  }
  return { intervalMinutes, durationMinutes, errors };
}

/** "3:30 PM", or "Wed 9:00 AM" when it isn't today. */
export function formatPollerClock(date: Date, now: Date = new Date()): string {
  const sameDay = date.toDateString() === now.toDateString();
  return date.toLocaleString(undefined, {
    ...(sameDay ? {} : { weekday: 'short' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * The running pollers for one session, soonest next check first. A pushed
 * update replaces the matching row, so the banner never shows a poller after
 * it finishes or is cancelled elsewhere.
 */
export function activeSessionPollers(pollers: SessionPoller[]): SessionPoller[] {
  return pollers
    .filter((p) => p.status === 'active')
    .sort((a, b) => (a.nextRunAt ?? a.endsAt).localeCompare(b.nextRunAt ?? b.endsAt));
}

/** Merge one pushed poller update into the list the banner holds. */
export function mergeSessionPoller(
  pollers: SessionPoller[],
  update: SessionPoller,
): SessionPoller[] {
  const rest = pollers.filter((p) => p.id !== update.id);
  return [...rest, update];
}

/**
 * Banner state for one session. Three sources write it: list refreshes, WS
 * pushes, and the result of a Cancel. Every write is stamped from one counter
 * so a list that was requested before a write can't undo it.
 */
export interface PollerBannerState {
  sessionId: string | null;
  pollers: SessionPoller[];
  /** Stamp of the last row write (push or cancel) applied to each poller id. */
  writtenAt: Record<string, number>;
  /** Request stamp of the newest list applied; older lists are dropped. */
  listedAt: number;
}

export type PollerBannerAction =
  | { type: 'write'; sessionId: string; poller: SessionPoller; stamp: number }
  | { type: 'list'; sessionId: string; pollers: SessionPoller[]; stamp: number };

export const EMPTY_POLLER_BANNER: PollerBannerState = {
  sessionId: null,
  pollers: [],
  writtenAt: {},
  listedAt: -1,
};

/**
 * `stamp` comes from one counter the component bumps for every row write and
 * reads when it sends a list request. A list keeps any row written after it
 * was requested and drops out-of-order responses; a failed request dispatches
 * nothing, so the last good state stays.
 */
export function pollerBannerReducer(
  state: PollerBannerState,
  action: PollerBannerAction,
): PollerBannerState {
  const base = state.sessionId === action.sessionId ? state : EMPTY_POLLER_BANNER;
  if (action.type === 'write') {
    return {
      ...base,
      sessionId: action.sessionId,
      pollers: mergeSessionPoller(base.pollers, action.poller),
      writtenAt: { ...base.writtenAt, [action.poller.id]: action.stamp },
    };
  }
  if (action.stamp < base.listedAt) return base;
  const newer = base.pollers.filter((p) => (base.writtenAt[p.id] ?? -1) >= action.stamp);
  const keepIds = new Set(newer.map((p) => p.id));
  const writtenAt: Record<string, number> = {};
  for (const id of keepIds) writtenAt[id] = base.writtenAt[id];
  return {
    sessionId: action.sessionId,
    pollers: [...action.pollers.filter((p) => !keepIds.has(p.id)), ...newer],
    writtenAt,
    listedAt: action.stamp,
  };
}

/** One-line banner summary: "Every 30 min · 2 runs so far · next check 3:37 PM · ends 5:13 PM". */
export function pollerBannerSummary(poller: SessionPoller, now: Date = new Date()): string {
  const parts = [`Every ${formatPollerMinutes(poller.intervalMinutes)}`];
  parts.push(`${poller.runCount} run${poller.runCount === 1 ? '' : 's'} so far`);
  if (poller.nextRunAt)
    parts.push(`next check ${formatPollerClock(new Date(poller.nextRunAt), now)}`);
  parts.push(`ends ${formatPollerClock(new Date(poller.endsAt), now)}`);
  return parts.join(' · ');
}
