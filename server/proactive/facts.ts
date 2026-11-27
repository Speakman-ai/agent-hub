/**
 * Fact snapshot for a proactive check: plain SQL / store reads, no model call.
 *
 * Each fact is one thing the Server Agent might offer to help with. Its `id`
 * doubles as the offer dedupe key, and its `kind` decides the offer kind, so
 * the model only ever picks among facts we built and can never invent a
 * target. `fingerprint` is the part of a fact whose change should make the
 * model look again at a fact it already declined (e.g. a new Finalize run id is a new fact; a card that has
 * been stale one more day is not).
 */
import { createHash } from 'crypto';
import { HUB_ASSISTANT_AGENT_ID, HUB_SESSION_MODE } from '../../shared/utils/hub.js';
import {
  PROACTIVE_OFFER_KINDS,
  type ProactiveArea,
  type ProactiveOfferKind,
  type ProactiveOfferTarget,
} from '../../shared/utils/serverAgentProactive.js';
import { getDb } from '../db.js';
import { buildMyWork } from '../me-dashboard.js';
import { canViewProject, type VisibilityCaller } from '../project-visibility.js';
import {
  computeSessionNeedsInput,
  needsInputGeneration,
  type NeedsInputKind,
} from '../session-needs-input.js';
import type { Project, Stmts } from '../types.js';

export interface ProactiveFact {
  /**
   * Identity of one *occurrence*; also the offer dedupe key, so blocks,
   * snoozes and declines attach to it. Build it from the subject plus a
   * monotonic marker that never repeats once it changes: a unique request or
   * run id, a row's last-update time, a revision counter. Never a state value
   * (a status, a planned date): states can come back (pending → changes →
   * pending), and a recurring id would let an old accept or snooze hide new
   * work.
   */
  id: string;
  kind: ProactiveOfferKind;
  /** One line for the model. */
  summary: string;
  /** Extra structured context for the model and the "Do it" prompt. */
  detail?: Record<string, string | number | boolean | null>;
  target: ProactiveOfferTarget;
  /**
   * The fact's content that matters for a decision, excluding anything that
   * drifts on its own (ages, counters). Required: a collector must say what
   * makes a changed fact worth showing the model again. Use
   * {@link fingerprintOf} over the stable fields.
   */
  fingerprint: string;
  /** Contains third-party text (email, chat). The prompt fences it as data. */
  untrusted?: boolean;
  /** Bypasses quiet hours (event-driven alerts marked urgent). */
  urgent?: boolean;
}

/** Stable fingerprint over the given fields (order-sensitive, JSON-encoded). */
export function fingerprintOf(
  ...parts: Array<string | number | boolean | null | undefined>
): string {
  return createHash('sha256')
    .update(JSON.stringify(parts.map((p) => (p === undefined ? null : p))))
    .digest('hex')
    .slice(0, 32);
}

/** Kinds whose subject lives in a project the user must still be able to view. */
const PROJECT_SCOPED_KINDS = new Set<ProactiveOfferKind>([
  'finalize_failed',
  'session_needs_input',
  'session_stuck',
  'pr_review',
  'stale_card',
  'idle_epic',
  'infra_alert',
  'deploy_failed',
]);

/**
 * Every access condition a fact depends on, derived from the fact itself.
 * Collectors enforce these when they read; the check's live gate enforces
 * them again before each model call and each insert, so access lost while a
 * check is running (a Google account disconnected, a scope revoked, a
 * project made private) stops the fact at the next step.
 */
export interface FactRequirements {
  /** Linked Google accounts that must still grant `need`. */
  google?: { need: 'calendar' | 'gmail'; accountIds: string[] };
  /** Project the user must still be able to view. */
  projectId?: string;
}

export function factRequirements(fact: ProactiveFact): FactRequirements {
  const t = fact.target;
  const out: FactRequirements = {};
  if (fact.kind === 'email_reply' && t.accountId) {
    out.google = { need: 'gmail', accountIds: [t.accountId] };
  } else if (fact.kind === 'meeting_prep' && t.accountId) {
    out.google = { need: 'calendar', accountIds: [t.accountId] };
  } else if (fact.kind === 'calendar_conflict') {
    const ids = [t.accountId, t.secondAccountId].filter((x): x is string => Boolean(x));
    out.google = { need: 'calendar', accountIds: [...new Set(ids)] };
  }
  if (PROJECT_SCOPED_KINDS.has(fact.kind) && t.projectId) out.projectId = t.projectId;
  return out;
}

export function factArea(fact: ProactiveFact): ProactiveArea {
  return PROACTIVE_OFFER_KINDS[fact.kind].area;
}

const DAY_MS = 24 * 60 * 60_000;
export const STALE_CARD_MS = 3 * DAY_MS;
export const STUCK_SESSION_MS = 90 * 60_000;
export const FINALIZE_LOOKBACK_MS = 3 * DAY_MS;
export const NEEDS_INPUT_LOOKBACK_MS = 7 * DAY_MS;
export const IDLE_EPIC_MS = DAY_MS;
const MAX_PER_KIND = 10;
const MAX_SESSIONS_SCANNED = 40;

/**
 * Bounded scan size for a filtered collection. Collectors cap how many facts
 * of a kind they return; with a filter, those caps count only facts that pass
 * it, and the underlying query scans this far so ineligible rows at the head
 * of a list can't hide eligible ones behind them.
 */
export const SCOPED_SCAN_CAP = 500;

/**
 * How a collection is filtered. `match` is applied to every candidate before
 * any cap. Snapshots pass the check's eligibility (not blocked, not
 * suppressed, not already declined unchanged, quiet-hours urgency); event
 * checks pass eligibility plus the event's subject and set `scoped`, which
 * also lifts the per-kind output cap since only one subject can match.
 */
export interface FactScope {
  match?: (fact: ProactiveFact) => boolean;
  scoped?: boolean;
}

export function factCaps(
  scope: FactScope,
  normal: { perKind: number; scan?: number },
): { perKind: number; scan: number; keep: (fact: ProactiveFact) => boolean } {
  const match = scope.match;
  return {
    perKind: scope.scoped ? SCOPED_SCAN_CAP : normal.perKind,
    scan: match ? SCOPED_SCAN_CAP : (normal.scan ?? normal.perKind),
    keep: match ?? (() => true),
  };
}

function sqliteToMs(raw: string | null | undefined): number {
  if (!raw) return NaN;
  const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  return Date.parse(normalized);
}

function oneLine(text: string | null | undefined, max = 140): string {
  const compact = (text ?? '').replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

export interface DevFactDeps {
  userId: string;
  caller: VisibilityCaller;
  getProjects: () => Project[];
  stmts: Stmts;
  /** Project of an agent, for session targets. */
  projectIdForAgent?: (agentId: string) => string | null;
  now: Date;
  /** See {@link FactScope}. */
  match?: (fact: ProactiveFact) => boolean;
  scoped?: boolean;
}

function isProjectSessionRow(row: { agent_id: string; session_mode: string | null }): boolean {
  return row.agent_id !== HUB_ASSISTANT_AGENT_ID && row.session_mode !== HUB_SESSION_MODE;
}

function finalizeFacts(deps: DevFactDeps): ProactiveFact[] {
  const caps = factCaps(deps, { perKind: MAX_PER_KIND });
  const since = deps.now.getTime() - FINALIZE_LOOKBACK_MS;
  const rows = getDb()
    .prepare(
      `SELECT fr.id, fr.session_id, fr.project_id, fr.card_id, fr.status, fr.failure_reason,
              fr.failed_step_name, fr.started_at, s.name AS session_name
       FROM finalize_runs fr
       JOIN sessions s ON s.id = fr.session_id
       WHERE s.owner_user_id = ? AND s.deleted_at IS NULL
         AND fr.status IN ('failed', 'timed_out', 'infra_error')
         AND fr.started_at >= ?
         AND NOT EXISTS (
           SELECT 1 FROM finalize_runs newer
           WHERE newer.session_id = fr.session_id AND newer.started_at > fr.started_at
         )
       ORDER BY fr.started_at DESC
       LIMIT ?`,
    )
    .all(deps.userId, since, caps.scan) as Array<{
    id: string;
    session_id: string;
    project_id: string;
    card_id: string;
    status: string;
    failure_reason: string | null;
    failed_step_name: string | null;
    session_name: string;
  }>;
  const projects = new Map(deps.getProjects().map((p) => [p.id, p]));
  return rows
    .filter((r) => {
      const p = projects.get(r.project_id);
      return !p || canViewProject(p, deps.caller);
    })
    .map((r) => ({
      id: `finalize_failed:${r.id}`,
      kind: 'finalize_failed' as const,
      fingerprint: fingerprintOf(r.status, r.failure_reason, r.failed_step_name, r.session_name),
      summary: `Finalize ${r.status.replace(/_/g, ' ')} on session "${oneLine(r.session_name, 80)}"${
        r.failed_step_name ? ` at step "${oneLine(r.failed_step_name, 60)}"` : ''
      }${r.failure_reason ? ` (${r.failure_reason.replace(/_/g, ' ')})` : ''}`,
      detail: {
        finalizeRunId: r.id,
        status: r.status,
        project: projects.get(r.project_id)?.name ?? r.project_id,
      },
      target: {
        sessionId: r.session_id,
        projectId: r.project_id,
        cardId: r.card_id || undefined,
        finalizeRunId: r.id,
      },
    }))
    .filter(caps.keep)
    .slice(0, caps.perKind);
}

function sessionFacts(deps: DevFactDeps): ProactiveFact[] {
  const caps = factCaps(deps, { perKind: MAX_PER_KIND, scan: MAX_SESSIONS_SCANNED });
  const nowMs = deps.now.getTime();
  const since = new Date(nowMs - NEEDS_INPUT_LOOKBACK_MS).toISOString();
  const sessions = getDb()
    .prepare(
      `SELECT id, name, agent_id, session_mode, updated_at FROM sessions
       WHERE owner_user_id = ? AND deleted_at IS NULL AND datetime(updated_at) >= datetime(?)
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(deps.userId, since, caps.scan) as Array<{
    id: string;
    name: string;
    agent_id: string;
    session_mode: string | null;
    updated_at: string;
  }>;
  const out: ProactiveFact[] = [];
  for (const s of sessions) {
    if (!isProjectSessionRow(s)) continue;
    let needs: string | null = null;
    try {
      needs = computeSessionNeedsInput(deps.stmts, s.id);
    } catch {
      needs = null;
    }
    if (!needs) continue;
    const fact: ProactiveFact = {
      // The specific request (approval/sign-in id, asking message, disputed
      // run), so a later request in the same session is a new occurrence.
      id: `session_needs_input:${s.id}:${needs}:${
        needsInputGeneration(deps.stmts, s.id, needs as NeedsInputKind) ?? s.updated_at
      }`,
      kind: 'session_needs_input',
      fingerprint: fingerprintOf(needs, s.name),
      summary: `Session "${oneLine(s.name, 80)}" is waiting on you (${needs.replace(/_/g, ' ')})`,
      detail: { needs },
      target: {
        sessionId: s.id,
        projectId: deps.projectIdForAgent?.(s.agent_id) ?? undefined,
      },
    };
    if (!caps.keep(fact)) continue;
    out.push(fact);
    if (out.length >= caps.perKind) break;
  }

  const stuckBefore = new Date(nowMs - STUCK_SESSION_MS).toISOString();
  const running = getDb()
    .prepare(
      `SELECT at.session_id, at.started_at, s.name, s.agent_id, s.session_mode
       FROM active_tasks at JOIN sessions s ON s.id = at.session_id
       WHERE at.status = 'running' AND s.owner_user_id = ? AND s.deleted_at IS NULL
         AND datetime(at.started_at) <= datetime(?)
       ORDER BY at.started_at ASC LIMIT ?`,
    )
    .all(deps.userId, stuckBefore, caps.scan) as Array<{
    session_id: string;
    started_at: string;
    name: string;
    agent_id: string;
    session_mode: string | null;
  }>;
  const stuck: ProactiveFact[] = [];
  for (const r of running) {
    if (!isProjectSessionRow(r)) continue;
    const minutes = Math.round((nowMs - sqliteToMs(r.started_at)) / 60_000);
    const fact: ProactiveFact = {
      id: `session_stuck:${r.session_id}:${r.started_at}`,
      kind: 'session_stuck',
      fingerprint: fingerprintOf(r.name),
      summary: `Session "${oneLine(r.name, 80)}" has been running one turn for ${minutes} minutes`,
      detail: { runningMinutes: minutes },
      target: {
        sessionId: r.session_id,
        projectId: deps.projectIdForAgent?.(r.agent_id) ?? undefined,
      },
    };
    if (caps.keep(fact)) stuck.push(fact);
    if (stuck.length >= caps.perKind) break;
  }
  return [...out, ...stuck];
}

function cardFacts(deps: DevFactDeps): ProactiveFact[] {
  const nowMs = deps.now.getTime();
  const work = buildMyWork({ getProjects: deps.getProjects }, deps.userId, deps.caller);
  const caps = factCaps(deps, { perKind: MAX_PER_KIND });
  const out: ProactiveFact[] = [];
  let reviews = 0;
  let stale = 0;
  for (const c of work.cards) {
    if (c.isDone) continue;
    const column = c.columnName.trim().toLowerCase();
    if (column === 'review' && c.prUrl) {
      if (reviews >= caps.perKind) continue;
      const fact: ProactiveFact = {
        // The card's last update (bumped by every review-status change), not
        // the status itself: pending → changes_requested → pending is a new
        // review request, and a status value can repeat where a time can't.
        id: `pr_review:${c.id}:${c.prUrl}:${c.updatedAt}`,
        kind: 'pr_review',
        fingerprint: fingerprintOf(c.reviewStatus, c.title, c.priority, c.sessionId),
        summary: `Card "${oneLine(c.title, 100)}" in ${c.projectName} has a PR in Review`,
        detail: { prUrl: c.prUrl, reviewStatus: c.reviewStatus, project: c.projectName },
        target: {
          cardId: c.id,
          projectId: c.projectId,
          url: c.prUrl,
          sessionId: c.sessionId ?? undefined,
        },
      };
      if (caps.keep(fact)) {
        reviews += 1;
        out.push(fact);
      }
      continue;
    }
    if (column === 'in progress' && stale < caps.perKind) {
      const age = nowMs - sqliteToMs(c.updatedAt);
      if (!(age >= STALE_CARD_MS)) continue;
      const fact: ProactiveFact = {
        // One staleness episode per last update: a card touched and left
        // stale again is a new occurrence.
        id: `stale_card:${c.id}:${c.updatedAt}`,
        kind: 'stale_card',
        fingerprint: fingerprintOf(c.updatedAt, c.title, c.priority),
        summary: `Card "${oneLine(c.title, 100)}" in ${c.projectName} has sat In Progress for ${Math.floor(
          age / DAY_MS,
        )} days`,
        detail: { priority: c.priority, project: c.projectName, shortId: c.shortId },
        target: { cardId: c.id, projectId: c.projectId, sessionId: c.sessionId ?? undefined },
      };
      if (caps.keep(fact)) {
        stale += 1;
        out.push(fact);
      }
    }
  }
  return out;
}

function epicFacts(deps: DevFactDeps): ProactiveFact[] {
  const caps = factCaps(deps, { perKind: MAX_PER_KIND, scan: MAX_PER_KIND * 3 });
  const visible = deps.getProjects().filter((p) => canViewProject(p, deps.caller));
  if (visible.length === 0) return [];
  const names = new Map(visible.map((p) => [p.id, p.name]));
  const placeholders = visible.map(() => '?').join(',');
  const idleBefore = new Date(deps.now.getTime() - IDLE_EPIC_MS).toISOString();
  const rows = getDb()
    .prepare(
      `SELECT e.id, e.name, b.project_id,
              (SELECT MAX(k.updated_at) FROM kanban_cards k WHERE k.epic_id = e.id) AS last_card_at,
              (SELECT COUNT(*) FROM kanban_cards k JOIN kanban_columns c ON c.id = k.column_id
                 WHERE k.epic_id = e.id AND lower(c.name) NOT IN ('done')) AS open_cards
       FROM kanban_epics e JOIN kanban_boards b ON b.id = e.board_id
       WHERE e.autonomous = 1 AND (e.state IS NULL OR e.state != 'done')
         AND (e.autonomous_enabled_by = ? OR e.assigned_user_id = ?)
         AND b.project_id IN (${placeholders})
       LIMIT ?`,
    )
    .all(deps.userId, deps.userId, ...visible.map((p) => p.id), caps.scan) as Array<{
    id: string;
    name: string;
    project_id: string;
    last_card_at: string | null;
    open_cards: number;
  }>;
  const out: ProactiveFact[] = [];
  for (const r of rows) {
    if (r.open_cards <= 0) continue;
    if (r.last_card_at && datetimeAfter(r.last_card_at, idleBefore)) continue;
    const fact: ProactiveFact = {
      id: `idle_epic:${r.id}:${r.last_card_at ?? ''}`,
      kind: 'idle_epic',
      fingerprint: fingerprintOf(r.name, r.open_cards),
      summary: `Autonomous epic "${oneLine(r.name, 80)}" in ${names.get(r.project_id)} has ${r.open_cards} open cards and no card activity for a day`,
      detail: { openCards: r.open_cards, project: names.get(r.project_id) ?? r.project_id },
      target: { epicId: r.id, projectId: r.project_id },
    };
    if (!caps.keep(fact)) continue;
    out.push(fact);
    if (out.length >= caps.perKind) break;
  }
  return out;
}

function datetimeAfter(a: string, bIso: string): boolean {
  return sqliteToMs(a) > Date.parse(bIso);
}

/** Every dev-work fact for the user. Each source fails soft. */
export function collectDevFacts(deps: DevFactDeps): ProactiveFact[] {
  const out: ProactiveFact[] = [];
  for (const source of [finalizeFacts, sessionFacts, cardFacts, epicFacts]) {
    try {
      out.push(...source(deps));
    } catch (err) {
      console.warn(`[proactive] dev fact source ${source.name} failed: ${(err as Error).message}`);
    }
  }
  return out;
}
