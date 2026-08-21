/**
 * Hub Daily Summary — auto-refresh schedule.
 *
 * The on-demand path (`POST /api/me/daily-summary`) regenerates the report only
 * when the user asks. This module lets a user pin one or more times of day at
 * which the Hub regenerates the summary for them automatically, reusing the same
 * per-user engine credentials the on-demand path uses.
 *
 * Design: a single once-a-minute node-cron ticker scans every user with an
 * enabled schedule and fires the ones whose configured local `HH:MM` matches the
 * current minute in their own timezone. This is the "single minute ticker"
 * variant of the crons pattern — there are no per-user node-cron rows to
 * register/re-register, and adding a schedule takes effect on the next tick.
 *
 * Pure selection (`selectDueDailySummaries`) is separated from the side-effecting
 * ticker so the due-time logic is unit-testable without spawning anything.
 */
import cron from 'node-cron';
import { wrapCronTick, defaultTickOptions } from './cron-tick.js';
import { assignedProjectIdsForUser, restrictedProjectIds } from './project-members-store.js';
import { listMembershipsForUser } from './memberships-store.js';
import type { RouteDeps } from './types.js';
import type { VisibilityCaller } from './project-visibility.js';
import type { Role } from './roles.js';
// Type-only imports: erased at compile time, so they add no runtime module edge
// (hub-daily-summary imports the preferences store, which imports this module).
import type { GenerateDailySummaryInput } from './hub-daily-summary.js';
import type { HubDailySummaryStored } from './user-preferences-store.js';

/** The generation function, injected so this module never value-imports it. */
export type GenerateDailySummaryFn = (
  input: GenerateDailySummaryInput,
) => Promise<HubDailySummaryStored>;

/** Per-user auto-refresh schedule for the Hub Daily Summary. */
export interface HubDailySummarySchedule {
  /** When false the times are kept but the ticker skips this user. */
  enabled: boolean;
  /** IANA timezone the `times` are interpreted in. */
  timeZone: string;
  /** 24h local times of day (`HH:MM`), de-duplicated and sorted ascending. */
  times: string[];
}

/** Hard cap on how many refresh times we persist / fire per user per day. */
export const MAX_DAILY_SUMMARY_TIMES = 12;

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** True when `tz` is an IANA zone Node's Intl accepts. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize an arbitrary times input into valid `HH:MM` strings: drop anything
 * that isn't a 24h time, de-duplicate, sort ascending, cap the count. Returns
 * an empty array when nothing survives.
 */
export function normalizeDailySummaryTimes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const t = entry.trim();
    if (!HHMM_RE.test(t) || seen.has(t)) continue;
    seen.add(t);
  }
  return Array.from(seen).sort().slice(0, MAX_DAILY_SUMMARY_TIMES);
}

/**
 * Normalize a stored/submitted schedule. Returns `undefined` when there is
 * nothing to schedule (no valid times) so the preferences key can be dropped.
 */
export function normalizeDailySummarySchedule(raw: unknown): HubDailySummarySchedule | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const times = normalizeDailySummaryTimes(obj.times);
  if (times.length === 0) return undefined;
  const timeZone = isValidTimeZone(obj.timeZone) ? (obj.timeZone as string).trim() : 'UTC';
  return { enabled: obj.enabled === true, timeZone, times };
}

function partsInZone(now: Date, timeZone: string): { date: string; hm: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hm: `${hour}:${get('minute')}`,
  };
}

export interface DueDailySummary {
  userId: string;
  time: string;
  localDate: string;
  timeZone: string;
}

/**
 * Pure: given "now" and every user's schedule, return the (userId, time) pairs
 * whose configured local `HH:MM` matches the current minute in the user's zone.
 * Disabled schedules and unparseable zones are skipped.
 */
export function selectDueDailySummaries(
  now: Date,
  entries: ReadonlyArray<{ userId: string; schedule: HubDailySummarySchedule }>,
): DueDailySummary[] {
  const due: DueDailySummary[] = [];
  for (const { userId, schedule } of entries) {
    if (!schedule?.enabled || !schedule.times?.length) continue;
    const timeZone = isValidTimeZone(schedule.timeZone) ? schedule.timeZone : 'UTC';
    let stamp: { date: string; hm: string };
    try {
      stamp = partsInZone(now, timeZone);
    } catch {
      continue;
    }
    if (schedule.times.includes(stamp.hm)) {
      due.push({ userId, time: stamp.hm, localDate: stamp.date, timeZone });
    }
  }
  return due;
}

/**
 * Build the visibility context a scheduled run should act under — the user
 * viewing their own Hub. Mirrors `resolveVisibilityCaller` for a real request
 * (role from the user's memberships, assignment ACLs from orgs.db) but without
 * an HTTP request in hand. Fails closed on a store error, same as the request
 * path, so a scheduled run never sees more than the user themselves would.
 */
export function buildDailySummaryCaller(userId: string): VisibilityCaller {
  let role: Role | undefined;
  try {
    for (const m of listMembershipsForUser(userId)) {
      if (m.role === 'Owner') {
        role = 'Owner';
        break;
      }
      if (m.role === 'Admin') role = 'Admin';
      else if (!role) role = 'User';
    }
  } catch {
    /* role stays undefined → treated as a plain member below */
  }
  let assignedProjectIds: ReadonlySet<string> | undefined;
  let restricted: ReadonlySet<string> | undefined;
  let assignmentAclUnavailable = false;
  try {
    restricted = restrictedProjectIds();
    assignedProjectIds = assignedProjectIdsForUser(userId);
  } catch {
    assignedProjectIds = new Set<string>();
    restricted = new Set<string>();
    assignmentAclUnavailable = true;
  }
  return {
    userId,
    role,
    localBypass: false,
    assignedProjectIds,
    restrictedProjectIds: restricted,
    assignmentAclUnavailable,
  };
}

export interface DailySummaryScheduleDeps {
  routeDeps: RouteDeps;
  listSchedules: () => Array<{ userId: string; schedule: HubDailySummarySchedule }>;
  generate: GenerateDailySummaryFn;
  now?: () => Date;
}

// De-dupe guard so a single configured minute fires at most one generation per
// user, even if the tick callback is nudged across the minute boundary by
// node-cron jitter. Keyed `${userId}:${localDate}:${time}`. Cleared when the
// UTC calendar day rolls over so it can't grow without bound.
const firedThisDay = new Set<string>();
let firedDayKey = '';

/** Exposed for tests: reset the in-memory de-dupe guard. */
export function resetDailySummaryFiredGuard(): void {
  firedThisDay.clear();
  firedDayKey = '';
}

export async function runDailySummaryScheduleTick(deps: DailySummaryScheduleDeps): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const utcDay = now.toISOString().slice(0, 10);
  if (utcDay !== firedDayKey) {
    firedThisDay.clear();
    firedDayKey = utcDay;
  }
  let entries: Array<{ userId: string; schedule: HubDailySummarySchedule }>;
  try {
    entries = deps.listSchedules();
  } catch (err) {
    console.error('[daily-summary-schedule] listSchedules failed:', (err as Error).message);
    return;
  }
  const due = selectDueDailySummaries(now, entries);
  const generate = deps.generate;
  for (const item of due) {
    const key = `${item.userId}:${item.localDate}:${item.time}`;
    if (firedThisDay.has(key)) continue;
    firedThisDay.add(key);
    try {
      await generate({
        userId: item.userId,
        timeZone: item.timeZone,
        deps: deps.routeDeps,
        caller: buildDailySummaryCaller(item.userId),
        now,
      });
    } catch (err) {
      // Best-effort: one user's engine/auth failure must not stop the others.
      console.error(
        `[daily-summary-schedule] generate failed for ${item.userId}:`,
        (err as Error).message,
      );
    }
  }
}

/**
 * Register the once-a-minute ticker. No-op under test so unit suites never wire
 * a live cron or spawn a model.
 */
export function initDailySummarySchedules(deps: DailySummaryScheduleDeps): void {
  if (process.env.NODE_ENV === 'test') return;
  cron.schedule(
    '* * * * *',
    wrapCronTick(() => runDailySummaryScheduleTick(deps), 'daily-summary-schedule'),
    defaultTickOptions({ intervalSeconds: 60, name: 'daily-summary-schedule' }),
  );
}
