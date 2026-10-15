/**
 * Hub Daily Summary schedule (`preferences_json.hubDailySummarySchedule`) and
 * the once-a-minute ticker scheduled chat work rides.
 *
 * Scheduled summaries are `my_work` digests now. Each tick first converts any
 * schedule not yet converted (`hub-chat-daily-summary-migration.ts`), then
 * runs due digests, so a schedule converted this minute posts once, through
 * the digest, never also through a separate summary path.
 */
import cron from 'node-cron';
import { wrapCronTick, defaultTickOptions } from './cron-tick.js';
import { assignedProjectIdsForUser, restrictedProjectIds } from './project-members-store.js';
import { listMembershipsForUser } from './memberships-store.js';
import type { VisibilityCaller } from './project-visibility.js';
import type { Role } from './roles.js';

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
  /**
   * Converts schedules not yet converted into my_work digests. Injected so
   * this module has no runtime edge to the chat stores (the preferences store
   * imports this module).
   */
  migrateSchedules?: () => void;
  /** Runs due channel digests. */
  onTick?: (now: Date) => Promise<void>;
  now?: () => Date;
}

export async function runDailySummaryScheduleTick(deps: DailySummaryScheduleDeps): Promise<void> {
  const now = deps.now?.() ?? new Date();
  try {
    deps.migrateSchedules?.();
  } catch (err) {
    console.error('[daily-summary-schedule] migrating schedules failed:', (err as Error).message);
  }
  try {
    await deps.onTick?.(now);
  } catch (err) {
    console.error('[daily-summary-schedule] onTick failed:', (err as Error).message);
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
