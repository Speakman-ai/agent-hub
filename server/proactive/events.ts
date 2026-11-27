/**
 * Event-driven proactive checks. Watches the broadcast stream for events that
 * usually need the user soon (a failed Finalize, a session waiting on them, a
 * card moved to Review) and runs a single-item check for the affected user
 * right away instead of waiting for the next scheduled pass.
 *
 * The check reuses the normal fact collectors and keeps only the facts about
 * the event's target, so an event can never produce an offer the scheduled
 * snapshot would not. Quiet hours, the daily cap, snoozes and suppressions all
 * apply; only facts marked urgent pass quiet hours.
 */
import { getDb } from '../db.js';
import { findProject } from '../project-model.js';
import { canViewProject } from '../project-visibility.js';
import { buildDailySummaryCaller } from '../daily-summary-schedule.js';
import { listUsersWithProactiveEnabled } from '../user-preferences-store.js';
import { SESSION_NEEDS_INPUT_EVENT } from '../session-needs-input.js';
import type { ProactiveArea } from '../../shared/utils/serverAgentProactive.js';
import type { ProactiveFact } from './facts.js';
import { proactivePrefsForUser, runProactiveCheck, type ProactiveDeps } from './check.js';

/** What an event is about: whose it is and which facts it points at. */
export interface ProactiveEventTrigger {
  userId: string;
  area: ProactiveArea;
  /** Keep facts this returns true for. */
  matches: (fact: ProactiveFact) => boolean;
  /** Coalescing key: repeated events inside the debounce window run once. */
  key: string;
  /** Facts built straight from the event (alerts), skipping the collectors. */
  facts?: ProactiveFact[];
}

const FAILED_FINALIZE = new Set(['failed', 'timed_out', 'infra_error']);

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function sessionOwner(sessionId: string): string | null {
  try {
    const row = getDb()
      .prepare('SELECT owner_user_id FROM sessions WHERE id = ? AND deleted_at IS NULL')
      .get(sessionId) as { owner_user_id: string | null } | undefined;
    return row?.owner_user_id ?? null;
  } catch {
    return null;
  }
}

function cardAssignee(cardId: string): string | null {
  try {
    const row = getDb()
      .prepare('SELECT assigned_user_id FROM kanban_cards WHERE id = ?')
      .get(cardId) as { assigned_user_id: string | null } | undefined;
    return row?.assigned_user_id ?? null;
  } catch {
    return null;
  }
}

/** Opted-in users who can see `projectId` (infra alerts have no single owner). */
function optedInViewers(projectId: string): string[] {
  const project = findProject(projectId);
  if (!project) return [];
  return listUsersWithProactiveEnabled()
    .filter((u) => u.prefs.areas.infra)
    .filter((u) => canViewProject(project, buildDailySummaryCaller(u.userId)))
    .map((u) => u.userId);
}

/** Map one broadcast to the checks it should trigger. Exported for tests. */
export function mapBroadcastToProactiveTriggers(
  data: Record<string, unknown>,
): ProactiveEventTrigger[] {
  if (!data || typeof data.type !== 'string') return [];
  const out: ProactiveEventTrigger[] = [];
  switch (data.type) {
    case 'finalize_run_completed': {
      const status = str(data.status);
      const sessionId = str(data.sessionId) ?? str(data.session_id);
      if (!status || !FAILED_FINALIZE.has(status) || !sessionId) break;
      const owner = str(data.ownerUserId) ?? sessionOwner(sessionId);
      if (!owner) break;
      out.push({
        userId: owner,
        area: 'dev',
        key: `finalize:${sessionId}`,
        matches: (f) => f.kind === 'finalize_failed' && f.target.sessionId === sessionId,
      });
      break;
    }
    case SESSION_NEEDS_INPUT_EVENT: {
      const sessionId = str(data.sessionId);
      if (!sessionId || !data.needsInput) break;
      const owner = str(data.ownerUserId) ?? sessionOwner(sessionId);
      if (!owner) break;
      out.push({
        userId: owner,
        area: 'dev',
        key: `needs_input:${sessionId}`,
        matches: (f) => f.kind === 'session_needs_input' && f.target.sessionId === sessionId,
      });
      break;
    }
    case 'card_moved': {
      const cardId = str(data.cardId);
      const column = (str(data.toColumnName) ?? str(data.columnName) ?? '').toLowerCase();
      if (!cardId || (column && column !== 'review')) break;
      const assignee = cardAssignee(cardId);
      if (!assignee) break;
      out.push({
        userId: assignee,
        area: 'dev',
        key: `card_review:${cardId}`,
        matches: (f) => f.kind === 'pr_review' && f.target.cardId === cardId,
      });
      break;
    }
    case 'infra_alert_transition': {
      const projectId = str(data.projectId);
      const alertId = str(data.alertId);
      if (!projectId || !alertId || data.toState !== 'ALARM') break;
      for (const userId of optedInViewers(projectId)) {
        out.push({
          userId,
          area: 'infra',
          key: `infra_alert:${alertId}`,
          matches: (f) => f.kind === 'infra_alert' && f.target.alertId === alertId,
        });
      }
      break;
    }
    case 'deployment_update': {
      const dep = (data.deployment ?? {}) as Record<string, unknown>;
      const id = str(dep.id);
      const triggeredBy = str(dep.triggered_by) ?? str(dep.triggeredBy);
      if (!id || dep.status !== 'error' || !triggeredBy) break;
      out.push({
        userId: triggeredBy,
        area: 'infra',
        key: `deploy:${id}`,
        matches: (f) => f.kind === 'deploy_failed' && f.target.deploymentId === id,
      });
      break;
    }
    default:
      break;
  }
  return out;
}

export const PROACTIVE_EVENT_DEBOUNCE_MS = 5_000;

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** Run one trigger now. Exported so tests can skip the debounce. */
export async function runProactiveTrigger(
  trigger: ProactiveEventTrigger,
  deps: ProactiveDeps,
): Promise<Awaited<ReturnType<typeof runProactiveCheck>> | null> {
  // Cheap early exit; the check re-reads settings once it holds the slot.
  const prefs = proactivePrefsForUser(trigger.userId);
  if (!prefs?.enabled || !prefs.areas[trigger.area]) return null;
  if (trigger.facts) {
    if (trigger.facts.length === 0) return null;
    return runProactiveCheck(trigger.userId, prefs, deps, {
      source: 'event',
      facts: trigger.facts,
    });
  }
  // Collection runs inside the serialized slot, after any check ahead of it.
  return runProactiveCheck(trigger.userId, prefs, deps, {
    source: 'event',
    scope: { area: trigger.area, matches: trigger.matches },
  });
}

/**
 * Broadcast hook. Cheap when nothing matches: the user's prefs are read only
 * once a trigger exists, and the check itself runs after a short debounce so
 * a burst of related broadcasts collapses into one check.
 */
export function noteBroadcastForProactive(
  data: Record<string, unknown>,
  deps: ProactiveDeps,
  debounceMs = PROACTIVE_EVENT_DEBOUNCE_MS,
): void {
  if (data?.type === 'server_agent_offer_update') return;
  let triggers: ProactiveEventTrigger[];
  try {
    triggers = mapBroadcastToProactiveTriggers(data);
  } catch {
    return;
  }
  for (const trigger of triggers) {
    const prefs = proactivePrefsForUser(trigger.userId);
    if (!prefs?.enabled) continue;
    const key = `${trigger.userId}\u0000${trigger.key}`;
    const existing = pending.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pending.delete(key);
      runProactiveTrigger(trigger, deps).catch((err) =>
        console.warn(`[proactive] event check failed: ${(err as Error).message}`),
      );
    }, debounceMs);
    timer.unref?.();
    pending.set(key, timer);
  }
}

export function resetProactiveEventsForTests(): void {
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
}
