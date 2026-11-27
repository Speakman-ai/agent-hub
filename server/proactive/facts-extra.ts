/**
 * Proactive fact sources beyond dev work: Gmail + Calendar, infra + deploys,
 * and todos. Same contract as `facts.ts`: store reads only (plus the Google
 * calendar read the dashboard already makes), no model call, every source
 * fails soft.
 *
 * Email subjects, senders and event titles are third-party text. Facts built
 * from them are marked `untrusted`, clipped to one short line, and never carry
 * message bodies.
 */
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { canViewProject, type VisibilityCaller } from '../project-visibility.js';
import { getDb } from '../db.js';
import { listTodos } from '../user-todos-store.js';
import { listGoogleConnections } from '../google-connections-store.js';
import { hasCalendarReadScope, hasGmailReadScope } from '../google-scopes.js';
import { listImportantGmailThreads } from '../gmail-importance-store.js';
import { readGoogleForDashboard, type GoogleReader } from '../me-dashboard-google.js';
import { listReminders } from '../reminders-store.js';
import {
  calendarCacheTimeZone,
  calendarRefreshedAt,
  listCachedCalendarEvents,
  listSsoExpiry,
  pruneCalendarCache,
  replaceCalendarCache,
  replaceSsoExpiry,
  type CachedCalendarEvent,
  type SsoExpiryRow,
} from './offers-store.js';
import { listInfraAlerts, getInfraAlertRule } from '../infra/alert-store.js';
import { MAX_INFRA_ALERT_LIST_LIMIT } from '../infra/infra-schema.js';
import { perUserHomePath } from '../per-user-home.js';
import type { AppConfig, Project } from '../types.js';
import { factCaps, fingerprintOf, type FactScope, type ProactiveFact } from './facts.js';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_PER_KIND = 8;

export const EMAIL_LOOKBACK_MS = 3 * DAY_MS;
export const EMAIL_MIN_SCORE = 70;
export const MEETING_PREP_WINDOW_MS = 3 * HOUR_MS;
export const DEPLOY_LOOKBACK_MS = DAY_MS;
export const SSO_EXPIRY_WINDOW_MS = 2 * HOUR_MS;
export const FOLLOW_UP_QUIET_MS = 7 * DAY_MS;

function clip(text: string | null | undefined, max = 100): string {
  const compact = (text ?? '').replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

/** `YYYY-MM-DD` for `now` in `timeZone`. */
export function localDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return parts;
}

// Todos

export function collectTodoFacts(
  input: {
    userId: string;
    timeZone: string;
    now: Date;
  } & FactScope,
): ProactiveFact[] {
  const caps = factCaps(input, { perKind: MAX_PER_KIND });
  const today = localDate(input.now, input.timeZone);
  const out: ProactiveFact[] = [];
  let overdue = 0;
  let quiet = 0;
  for (const t of listTodos(input.userId, { status: 'open' })) {
    const doDate = t.doDate ?? (t.dueAt ? t.dueAt.slice(0, 10) : null);
    if (doDate && doDate < today) {
      if (overdue >= caps.perKind) continue;
      const fact: ProactiveFact = {
        // The todo's last update, not its planned day: a date can be moved
        // away and back, an update time never repeats.
        id: `todo_overdue:${t.id}:${t.updatedAt}`,
        kind: 'todo_overdue',
        fingerprint: fingerprintOf(t.title, t.priority, t.notes),
        summary: `Todo "${clip(t.title)}" was planned for ${doDate} and is still open`,
        detail: { priority: t.priority, doDate },
        target: { todoId: t.id, ...(t.linkedProjectId ? { projectId: t.linkedProjectId } : {}) },
      };
      if (caps.keep(fact)) {
        overdue += 1;
        out.push(fact);
      }
      continue;
    }
    const updated = Date.parse(
      t.updatedAt.includes('T') ? t.updatedAt : `${t.updatedAt.replace(' ', 'T')}Z`,
    );
    if (
      !doDate &&
      Number.isFinite(updated) &&
      input.now.getTime() - updated >= FOLLOW_UP_QUIET_MS
    ) {
      if (quiet >= caps.perKind) continue;
      const days = Math.floor((input.now.getTime() - updated) / DAY_MS);
      const fact: ProactiveFact = {
        id: `follow_up:${t.id}:${t.updatedAt}`,
        kind: 'follow_up',
        fingerprint: fingerprintOf(t.title, t.priority),
        summary: `Todo "${clip(t.title)}" has had no activity for ${days} days`,
        detail: { priority: t.priority, quietDays: days },
        target: { todoId: t.id, ...(t.linkedProjectId ? { projectId: t.linkedProjectId } : {}) },
      };
      if (caps.keep(fact)) {
        quiet += 1;
        out.push(fact);
      }
    }
  }
  return out;
}

/** A fired reminder nobody dismissed is still waiting this long before it counts. */
export const REMINDER_UNHANDLED_MS = 2 * HOUR_MS;
/** A pending reminder whose time passed this long ago never fired. */
export const REMINDER_MISSED_MS = 15 * 60_000;

/**
 * Reminders that went off and were never handled: fired but not dismissed for
 * a couple of hours, or pending well past their time (missed while the Hub
 * was down). Both are offered as follow-ups.
 */
export function collectReminderFacts(
  input: { userId: string; now: Date } & FactScope,
): ProactiveFact[] {
  const caps = factCaps(input, { perKind: MAX_PER_KIND });
  const nowMs = input.now.getTime();
  const out: ProactiveFact[] = [];
  for (const r of listReminders(input.userId, { status: ['fired', 'pending'] })) {
    const at = Date.parse(r.status === 'fired' ? (r.firedAt ?? r.remindAt) : r.remindAt);
    if (!Number.isFinite(at)) continue;
    const waited = nowMs - at;
    const due =
      r.status === 'fired' ? waited >= REMINDER_UNHANDLED_MS : waited >= REMINDER_MISSED_MS;
    if (!due) continue;
    const hours = Math.max(1, Math.round(waited / HOUR_MS));
    const fact: ProactiveFact = {
      // `revision` is bumped on every write, so a snooze back to the same
      // time is still a new occurrence.
      id: `follow_up:reminder:${r.id}:${r.revision}`,
      kind: 'follow_up',
      fingerprint: fingerprintOf(r.status, r.title, r.notes),
      summary:
        r.status === 'fired'
          ? `Reminder "${clip(r.title)}" went off ${hours}h ago and is still open`
          : `Reminder "${clip(r.title)}" was due ${hours}h ago and never fired`,
      detail: { remindAt: r.remindAt, status: r.status, createdBy: r.createdBy },
      target: {
        reminderId: r.id,
        ...(r.projectId ? { projectId: r.projectId } : {}),
        ...(r.sessionId ? { sessionId: r.sessionId } : {}),
      },
    };
    if (!caps.keep(fact)) continue;
    out.push(fact);
    if (out.length >= caps.perKind) break;
  }
  return out;
}

// Gmail + Calendar

/**
 * Linked Google accounts that may be read right now for `need`: still
 * connected and still granting the scope. Every fact built from a stored
 * per-account copy (importance verdicts, the calendar cache) is gated on
 * this at collection time, so disconnecting an account or revoking a scope
 * stops its data reaching the model on the very next check, whatever the
 * cache still holds.
 */
export type GoogleAccessCheck = (userId: string, need: 'calendar' | 'gmail') => Set<string>;

export const googleAccountsWithAccess: GoogleAccessCheck = (userId, need) => {
  const has = need === 'calendar' ? hasCalendarReadScope : hasGmailReadScope;
  return new Set(
    listGoogleConnections(userId)
      .filter((c) => has(c.grantedScopes))
      .map((c) => c.accountId),
  );
};

export function collectEmailFacts(
  input: { userId: string; now: Date; access?: GoogleAccessCheck } & FactScope,
): ProactiveFact[] {
  const caps = factCaps(input, { perKind: MAX_PER_KIND });
  const since = new Date(input.now.getTime() - EMAIL_LOOKBACK_MS).toISOString();
  const allowed = (input.access ?? googleAccountsWithAccess)(input.userId, 'gmail');
  const out: ProactiveFact[] = [];
  for (const conn of listGoogleConnections(input.userId)) {
    if (!allowed.has(conn.accountId)) continue;
    const threads = listImportantGmailThreads(
      { userId: input.userId, accountId: conn.accountId },
      since,
      caps.scan,
    );
    for (const t of threads) {
      if (t.score < EMAIL_MIN_SCORE) continue;
      const fact: ProactiveFact = {
        id: `email_reply:${conn.accountId}:${t.threadId}:${t.lastMessageAt ?? ''}`,
        kind: 'email_reply',
        fingerprint: fingerprintOf(t.subject, t.from, t.score >= 90),
        summary: `Email from ${clip(t.from, 60)} "${clip(t.subject, 90)}" looks like it needs a reply`,
        detail: {
          account: conn.googleEmail,
          importance: t.score,
          lastMessageAt: t.lastMessageAt,
          threadId: t.threadId,
        },
        target: {
          threadId: t.threadId,
          accountId: conn.accountId,
          url: `https://mail.google.com/mail/u/${encodeURIComponent(conn.googleEmail)}/#all/${t.threadId}`,
        },
        untrusted: true,
      };
      if (!caps.keep(fact)) continue;
      out.push(fact);
      if (out.length >= caps.perKind) return out;
    }
  }
  return out;
}

function eventMs(value: string | null): number {
  return value ? Date.parse(value) : NaN;
}

/** Meeting prep for events starting soon, and overlapping timed events today. */
export function calendarFactsFromEvents(
  events: readonly CachedCalendarEvent[],
  now: Date,
  scope: FactScope = {},
): ProactiveFact[] {
  const caps = factCaps(scope, { perKind: MAX_PER_KIND });
  const nowMs = now.getTime();
  const timed = events
    .filter(
      (e) =>
        !e.allDay && e.id && Number.isFinite(eventMs(e.start)) && Number.isFinite(eventMs(e.end)),
    )
    .sort((a, b) => eventMs(a.start) - eventMs(b.start));
  const out: ProactiveFact[] = [];
  for (const e of timed) {
    const start = eventMs(e.start);
    if (start > nowMs && start - nowMs <= MEETING_PREP_WINDOW_MS) {
      const fact: ProactiveFact = {
        id: `meeting_prep:${e.accountId}:${e.id}:${e.start}:${e.updated ?? ''}`,
        kind: 'meeting_prep',
        fingerprint: fingerprintOf(e.summary, e.end, e.location),
        summary: `"${clip(e.summary, 90)}" starts at ${e.start}`,
        detail: {
          account: e.accountEmail,
          start: e.start,
          end: e.end,
          location: clip(e.location, 80) || null,
        },
        target: {
          eventId: e.id,
          accountId: e.accountId,
          ...(e.htmlLink ? { url: e.htmlLink } : {}),
        },
        untrusted: true,
      };
      if (caps.keep(fact)) out.push(fact);
    }
  }
  let conflicts = 0;
  for (let i = 0; i < timed.length && conflicts < caps.perKind; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i];
      const b = timed[j];
      if (eventMs(b.start) >= eventMs(a.end)) break;
      // The overlap ends when the earlier of the two ends; one already over
      // is no longer a conflict, even if the longer event is still running.
      if (Math.min(eventMs(a.end), eventMs(b.end)) <= nowMs) continue;
      // One meeting on two linked calendars is not a conflict with itself.
      if (a.id === b.id && a.start === b.start && a.end === b.end) continue;
      const fact: ProactiveFact = {
        // Each event's Google last-modified time is part of the occurrence:
        // editing either event (moving it into a new overlap, even back to an
        // old time) makes a new conflict. Start time is the fallback.
        id: `calendar_conflict:${a.accountId}:${a.id}:${b.accountId}:${b.id}:${a.updated ?? a.start}:${b.updated ?? b.start}`,
        kind: 'calendar_conflict',
        fingerprint: fingerprintOf(a.summary, a.start, a.end, b.summary, b.start, b.end),
        summary: `"${clip(a.summary, 60)}" overlaps "${clip(b.summary, 60)}"`,
        detail: {
          firstAccount: a.accountEmail,
          firstStart: a.start,
          firstEnd: a.end,
          secondAccount: b.accountEmail,
          secondStart: b.start,
          secondEnd: b.end,
        },
        target: {
          eventId: a.id,
          secondEventId: b.id,
          accountId: a.accountId,
          secondAccountId: b.accountId,
          ...(a.htmlLink ? { url: a.htmlLink } : {}),
        },
        untrusted: true,
      };
      if (!caps.keep(fact)) continue;
      conflicts += 1;
      out.push(fact);
      if (conflicts >= caps.perKind) break;
    }
  }
  return out;
}

/**
 * Gmail + Calendar facts for the snapshot. Store reads only: email verdicts
 * come from the importance scan's table, events from the proactive calendar
 * cache that {@link refreshProactiveCalendarCache} fills outside the snapshot.
 */
export function collectGoogleFacts(
  input: { userId: string; now: Date; access?: GoogleAccessCheck } & FactScope,
): ProactiveFact[] {
  const out: ProactiveFact[] = [];
  try {
    out.push(...collectEmailFacts(input));
  } catch (err) {
    console.warn(`[proactive] email facts failed: ${(err as Error).message}`);
  }
  try {
    const allowed = (input.access ?? googleAccountsWithAccess)(input.userId, 'calendar');
    const events = listCachedCalendarEvents(input.userId).filter((e) => allowed.has(e.accountId));
    out.push(...calendarFactsFromEvents(events, input.now, input));
  } catch (err) {
    console.warn(`[proactive] calendar facts failed: ${(err as Error).message}`);
  }
  return out;
}

/** Calendar refresh is skipped while the cached copy is younger than this. */
export const CALENDAR_REFRESH_MS = 30 * 60_000;

/**
 * Network step, run before a scheduled or manual check and never inside the
 * snapshot: read today's events and persist them for the collector. Leaves
 * the cache alone when the read fails or Google is not linked.
 */
export async function refreshProactiveCalendarCache(input: {
  userId: string;
  config: AppConfig;
  timeZone: string;
  now: Date;
  force?: boolean;
  readGoogle?: GoogleReader;
  access?: GoogleAccessCheck;
}): Promise<boolean> {
  // Accounts gone or without calendar scope lose their cached events now,
  // before any freshness shortcut; a transient read failure below keeps the
  // rest of the cache.
  const allowed = (input.access ?? googleAccountsWithAccess)(input.userId, 'calendar');
  pruneCalendarCache(input.userId, allowed);
  if (allowed.size === 0) return false;
  const last = calendarRefreshedAt(input.userId);
  // The cache holds "today" in the zone it was read for; a zone change makes
  // it a different day, so it is stale regardless of age.
  const sameZone = calendarCacheTimeZone(input.userId) === input.timeZone;
  if (
    !input.force &&
    sameZone &&
    last &&
    input.now.getTime() - Date.parse(last) < CALENDAR_REFRESH_MS
  ) {
    return false;
  }
  try {
    const google = await (input.readGoogle ?? readGoogleForDashboard)(input.userId, input.config, {
      now: input.now,
      date: localDate(input.now, input.timeZone),
      timeZone: input.timeZone,
    });
    if (!google.connected) return false;
    const events: CachedCalendarEvent[] = google.calendar.events
      .filter((e) => e.id && allowed.has(e.accountId))
      .map((e) => ({
        id: e.id as string,
        accountId: e.accountId,
        accountEmail: e.accountEmail,
        summary: e.summary,
        location: e.location,
        allDay: e.allDay,
        start: e.start,
        end: e.end,
        htmlLink: e.htmlLink,
        updated: e.updated ?? null,
      }));
    replaceCalendarCache(input.userId, events, input.now, input.timeZone);
    return true;
  } catch (err) {
    console.warn(`[proactive] calendar refresh failed: ${(err as Error).message}`);
    return false;
  }
}

// Infra + deploys

export function collectInfraAlertFacts(
  input: {
    caller: VisibilityCaller;
    getProjects: () => Project[];
  } & FactScope,
): ProactiveFact[] {
  // Scoped (event) checks scan every open alarm the store will list per
  // project, so the triggering alert is found however many others fire.
  const caps = factCaps(input, { perKind: MAX_PER_KIND, scan: 10 });
  const perProject = input.match ? MAX_INFRA_ALERT_LIST_LIMIT : caps.scan;
  const out: ProactiveFact[] = [];
  for (const project of input.getProjects()) {
    if (!canViewProject(project, input.caller)) continue;
    let alerts;
    try {
      alerts = listInfraAlerts({
        projectId: project.id,
        state: 'ALARM',
        status: 'open',
        limit: perProject,
      }).alerts;
    } catch {
      continue;
    }
    for (const a of alerts) {
      const rule = getInfraAlertRule(project.id, a.rule_id);
      const severity = rule?.severity ?? 'warning';
      if (severity === 'info') continue;
      const fact: ProactiveFact = {
        id: `infra_alert:${a.id}:${a.state_updated_at}`,
        kind: 'infra_alert',
        fingerprint: fingerprintOf(severity, a.status, rule?.name),
        summary: `Infra alert "${clip(rule?.name ?? a.rule_id, 80)}" is firing in ${project.name} (${severity})`,
        detail: {
          severity,
          occurrences: a.occurrence_count,
          lastValue: a.last_value,
          project: project.name,
        },
        target: { projectId: project.id, alertId: a.id },
        urgent: severity === 'critical',
      };
      if (!caps.keep(fact)) continue;
      out.push(fact);
      if (out.length >= caps.perKind) return out;
    }
  }
  return out;
}

export function collectDeployFacts(
  input: {
    userId: string;
    caller: VisibilityCaller;
    getProjects: () => Project[];
    now: Date;
  } & FactScope,
): ProactiveFact[] {
  const caps = factCaps(input, { perKind: MAX_PER_KIND });
  const visible = input.getProjects().filter((p) => canViewProject(p, input.caller));
  if (visible.length === 0) return [];
  const names = new Map(visible.map((p) => [p.id, p.name]));
  const since = new Date(input.now.getTime() - DEPLOY_LOOKBACK_MS)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
  const placeholders = visible.map(() => '?').join(',');
  // The latest deployment per environment, failed, and triggered by this user
  // (or by the system, for push-driven runs nobody owns).
  const rows = getDb()
    .prepare(
      `SELECT d.id, d.project_id, d.environment, d.ref, d.error, d.triggered_by
       FROM deployments d
       WHERE d.project_id IN (${placeholders})
         AND d.status = 'error'
         AND d.created_at >= ?
         AND (d.triggered_by = ? OR d.triggered_by IS NULL)
         AND NOT EXISTS (
           SELECT 1 FROM deployments newer
           WHERE newer.project_id = d.project_id AND newer.environment = d.environment
             AND newer.created_at > d.created_at
         )
       ORDER BY d.created_at DESC LIMIT ?`,
    )
    .all(...visible.map((p) => p.id), since, input.userId, caps.scan) as Array<{
    id: string;
    project_id: string;
    environment: string;
    ref: string;
    error: string | null;
  }>;
  return rows
    .map(
      (r): ProactiveFact => ({
        id: `deploy_failed:${r.id}`,
        kind: 'deploy_failed',
        fingerprint: fingerprintOf(r.error, r.ref),
        summary: `Deploy to ${r.environment} in ${names.get(r.project_id)} failed${r.error ? `: ${clip(r.error, 120)}` : ''}`,
        detail: {
          environment: r.environment,
          ref: r.ref.slice(0, 12),
          project: names.get(r.project_id) ?? r.project_id,
        },
        target: { projectId: r.project_id, deploymentId: r.id },
      }),
    )
    .filter(caps.keep)
    .slice(0, caps.perKind);
}

/**
 * Refresh step, run before a check and never inside the snapshot: copy the
 * non-secret expiry metadata (file name, start URL, `expiresAt`) of token
 * files in the user's own Hub HOME (`~/.aws/sso/cache`) into
 * `server_agent_sso_expiry`. Never the AWS CLI, never the token itself.
 */
export function refreshAwsSsoExpiry(input: {
  userId: string;
  dataDir: string;
  now: Date;
  homeFor?: (userId: string, dataDir: string) => string;
}): number {
  const home = (input.homeFor ?? perUserHomePath)(input.userId, input.dataDir);
  const dir = path.join(home, '.aws', 'sso', 'cache');
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    replaceSsoExpiry(input.userId, [], input.now);
    return 0;
  }
  const rows: SsoExpiryRow[] = [];
  for (const file of files) {
    let parsed: { expiresAt?: unknown; startUrl?: unknown; accessToken?: unknown };
    try {
      parsed = JSON.parse(readFileSync(path.join(dir, file), 'utf-8'));
    } catch {
      continue;
    }
    // Only token files carry an accessToken; client registrations don't.
    if (typeof parsed.accessToken !== 'string' || typeof parsed.expiresAt !== 'string') continue;
    rows.push({
      cacheFile: file,
      startUrl: typeof parsed.startUrl === 'string' ? parsed.startUrl : null,
      expiresAt: parsed.expiresAt,
    });
  }
  replaceSsoExpiry(input.userId, rows, input.now);
  return rows.length;
}

/** AWS SSO sign-ins about to lapse, from the persisted expiry rows only. */
export function collectAwsSsoFacts(
  input: { userId: string; now: Date } & FactScope,
): ProactiveFact[] {
  const caps = factCaps(input, { perKind: Number.MAX_SAFE_INTEGER });
  const out: ProactiveFact[] = [];
  const nowMs = input.now.getTime();
  for (const row of listSsoExpiry(input.userId)) {
    const expires = Date.parse(row.expiresAt);
    if (!Number.isFinite(expires) || expires <= nowMs || expires - nowMs > SSO_EXPIRY_WINDOW_MS) {
      continue;
    }
    const minutes = Math.round((expires - nowMs) / 60_000);
    const fact: ProactiveFact = {
      id: `aws_sso_expiring:${row.cacheFile}:${row.expiresAt}`,
      kind: 'aws_sso_expiring',
      fingerprint: fingerprintOf(row.startUrl),
      summary: `Your AWS SSO sign-in for ${clip(row.startUrl ?? 'AWS SSO', 80)} expires in ${minutes} minutes`,
      detail: { expiresAt: row.expiresAt },
      target: {},
    };
    if (caps.keep(fact)) out.push(fact);
  }
  return out;
}
