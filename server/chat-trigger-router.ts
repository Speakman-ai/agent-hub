/**
 * Project chat triggers: turns broadcast-bus events into chat messages.
 *
 * `websocket.ts#broadcast` hands every payload to `routeBroadcastToChatTriggers`,
 * the same tap `push.ts#handleBroadcastForPush` uses, so a feature that already
 * broadcasts needs no extra wiring to become a trigger. The flow per payload:
 *
 *   1. `mapBroadcastToTriggerOccurrence` recognises one of the v1 events
 *      (`shared/utils/chatTriggers.ts`) and resolves its project, refs and the
 *      facts filters match on. Anything else returns null cheaply.
 *   2. Every enabled trigger for that project + event whose filter matches
 *      posts one `authorKind: 'trigger'` message into its channel, with a
 *      structured card in `payload`.
 *   3. A trigger with a Google Chat space also posts the card there, as its
 *      creator, after the Agent Hub message commits (`chat-trigger-google.ts`).
 *      That post is fire-and-forget and never affects the Agent Hub one.
 *
 * Two rules keep the router honest, and both mean it never guesses:
 *
 * Identity comes from the producer. Each occurrence's key is built only from
 * ids the broadcast itself carries (message id, run id + status, move id,
 * review-request stamp, log id, …), never from state looked up when the event
 * is handled, which may already reflect a later occurrence. A broadcast missing
 * its id is not delivered. Each trigger posts a key once: the (trigger, key)
 * row is written in the same transaction as the message, so it survives
 * restarts and a failed write leaves nothing claimed.
 *
 * Privacy fails closed. Sessions belong to one user, as do private crons. An
 * event about one only posts through a trigger its owner created, into a
 * channel the owner is a member of at posting time. When the owner cannot be
 * established (session row missing, lookup error, cron without its sharing
 * flag), the event is not delivered at all. Every trigger also needs a
 * creator who can still view the project when it posts. Only the creator can
 * retarget a trigger (`routes/project-chat-triggers.ts`).
 */

import { getDb } from './db.js';
import { appendMessage, getChannel, getMember } from './hub-chat-store.js';
import { broadcastHubChatMessage } from './hub-chat-broadcast.js';
import { HUB_CHAT_MESSAGE_EVENT } from './hub-chat-events.js';
import { resolveProjectIdFromEvent, type BroadcastEvent } from './event-project-resolver.js';
import { formatCardShortId } from './kanban-short-id.js';
import { isLocalBundledServer } from './auth.js';
import { findProject } from './project-model.js';
import { canViewProject } from './project-visibility.js';
import { buildRefViewer } from './hub-chat-refs.js';
import { sendTriggerToGoogleChat, type GoogleChatTriggerSend } from './chat-trigger-google.js';
import {
  listEnabledTriggers,
  parseTriggerFilter,
  postOccurrenceOnce,
  pruneTriggerPosts,
  type ChatTriggerRow,
} from './chat-triggers-store.js';
import {
  CHAT_TRIGGER_EVENT_INFO,
  type ChatTriggerCard,
  type ChatTriggerCardRef,
  type ChatTriggerEvent,
  type ChatTriggerFilter,
  type ChatTriggerStatus,
} from '../shared/utils/chatTriggers.js';
import { escapeMarkdownText, formatHubChatRefToken } from '../shared/utils/hubChatRefTokens.js';
import type { BroadcastFn, HubChatChannelRow, HubChatMessageRow } from './types.js';

type BroadcastData = Record<string, unknown> & { type?: unknown };

/** What filters match against. */
export interface TriggerFacts {
  column?: string | null;
  epicId?: string | null;
  labels?: string[];
  outcome?: 'pass' | 'fail' | 'success' | 'error';
  agentId?: string | null;
  severity?: string | null;
}

export interface TriggerOccurrence {
  event: ChatTriggerEvent;
  projectId: string;
  /**
   * Identifies this occurrence: shared by duplicate broadcasts of it, different
   * for a later occurrence of the same kind (a re-request, a new move).
   */
  dedupeKey: string;
  title: string;
  status: ChatTriggerStatus;
  statusLabel: string;
  detail: string | null;
  refs: ChatTriggerCardRef[];
  facts: TriggerFacts;
  /**
   * Set for an owned session or a private cron. Only a trigger this user
   * created posts it, and only into a channel this user is a member of.
   */
  privateToUserId: string | null;
}

export interface TriggerLookups {
  resolveProjectId: (data: BroadcastData) => string | null;
  /**
   * A session's owner and agent, including deleted sessions: ownership must
   * not depend on whether the session is still listed. Null only when no row
   * exists; errors throw.
   */
  getSession: (
    sessionId: string,
  ) => { name: string; agentId: string; ownerUserId: string | null } | null;
  getCard: (cardId: string) => {
    title: string;
    label: string;
    epicId: string | null;
    labels: string[];
    column: string | null;
  } | null;
  getPrTitle: (projectId: string, number: number) => string | null;
  getFinalizeRun: (runId: string) => { projectId: string; sessionId: string | null } | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function oneLine(text: string | null | undefined, max = 160): string | null {
  if (!text) return null;
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export const defaultTriggerLookups: TriggerLookups = {
  resolveProjectId: (data) => resolveProjectIdFromEvent(data as BroadcastEvent),
  getSession: (sessionId) => {
    const row = getDb()
      .prepare('SELECT name, agent_id, owner_user_id FROM sessions WHERE id = ?')
      .get(sessionId) as
      | { name: string; agent_id: string; owner_user_id: string | null }
      | undefined;
    return row ? { name: row.name, agentId: row.agent_id, ownerUserId: row.owner_user_id } : null;
  },
  getCard: (cardId) => {
    const row = getDb()
      .prepare(
        `SELECT c.title, c.short_id, c.epic_id, c.labels, b.card_prefix, col.name AS column_name
         FROM kanban_cards c
         JOIN kanban_boards b ON b.id = c.board_id
         LEFT JOIN kanban_columns col ON col.id = c.column_id
         WHERE c.id = ?`,
      )
      .get(cardId) as
      | {
          title: string;
          short_id: number | null;
          epic_id: string | null;
          labels: string | null;
          card_prefix: string | null;
          column_name: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      title: row.title,
      label: formatCardShortId(row.card_prefix, row.short_id) ?? row.title,
      epicId: row.epic_id,
      labels: String(row.labels || '')
        .split(',')
        .map((l) => l.trim())
        .filter(Boolean),
      column: row.column_name,
    };
  },
  getPrTitle: (projectId, number) => {
    const row = getDb()
      .prepare('SELECT title FROM pull_requests WHERE project_id = ? AND number = ?')
      .get(projectId, number) as { title: string } | undefined;
    return row?.title ?? null;
  },
  getFinalizeRun: (runId) => {
    const row = getDb()
      .prepare('SELECT project_id, session_id FROM finalize_runs WHERE id = ?')
      .get(runId) as { project_id: string; session_id: string | null } | undefined;
    return row ? { projectId: row.project_id, sessionId: row.session_id } : null;
  },
};

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * The session's owner and agent, or null when they cannot be established (no
 * row, or the lookup failed). Callers drop the event on null.
 */
function sessionFacts(lookups: TriggerLookups, sessionId: string) {
  return safe(() => lookups.getSession(sessionId), null);
}

function sessionOccurrence(
  data: BroadcastData,
  lookups: TriggerLookups,
  sessionId: string,
): {
  projectId: string;
  session: { name: string; agentId: string; ownerUserId: string | null };
} | null {
  const session = sessionFacts(lookups, sessionId);
  if (!session) return null;
  const projectId = safe(() => lookups.resolveProjectId({ ...data, sessionId }), null);
  return projectId ? { projectId, session } : null;
}

/** Broadcast types the router reads; everything else skips it without work. */
const SOURCE_TYPES: ReadonlySet<string> = new Set([
  'awaiting_input',
  'done',
  'finalize_run_completed',
  'native_pr_update',
  'card_created',
  'card_moved',
  'support_ticket_created',
  'cron_finished',
  'infra_alert_transition',
  'infra_health_event',
]);

export function isChatTriggerSourceType(type: unknown): boolean {
  return typeof type === 'string' && SOURCE_TYPES.has(type);
}

const FINALIZE_PASS = new Set(['ready_to_push', 'pushed', 'succeeded']);
const FINALIZE_FAIL = new Set(['failed', 'timed_out', 'stalled_no_response', 'infra_error']);

/**
 * Recognises a v1 trigger event in a broadcast payload. Returns null for
 * everything else, including the chat events triggers themselves produce.
 */
export function mapBroadcastToTriggerOccurrence(
  data: BroadcastData,
  lookups: TriggerLookups = defaultTriggerLookups,
): TriggerOccurrence | null {
  if (!data || typeof data.type !== 'string') return null;
  // A SideBar lives inside its parent chat; nothing about it belongs in a channel.
  if (typeof data.sidebarParentId === 'string') return null;

  switch (data.type) {
    case 'awaiting_input': {
      const sessionId = str(data.sessionId);
      if (data.waiting !== true || !sessionId || data.suppressPush === true) return null;
      const hit = sessionOccurrence(data, lookups, sessionId);
      if (!hit) return null;
      const askIds = Array.isArray(data.askIds) ? data.askIds.map(String).sort() : [];
      if (!askIds.length) return null;
      return {
        event: 'session_awaiting_input',
        projectId: hit.projectId,
        dedupeKey: `awaiting:${sessionId}:${askIds.join(',')}`,
        title: 'Session is waiting for input',
        status: 'waiting',
        statusLabel: 'Waiting',
        detail: null,
        refs: [{ kind: 'session', targetId: sessionId, label: hit.session.name || 'Session' }],
        facts: { agentId: hit.session.agentId },
        privateToUserId: hit.session.ownerUserId,
      };
    }

    case 'done': {
      const sessionId = str(data.sessionId);
      const messageId = str(data.messageId);
      if (!sessionId || !messageId) return null;
      const hit = sessionOccurrence(data, lookups, sessionId);
      if (!hit) return null;
      const message = (data.message ?? {}) as { content?: unknown };
      return {
        event: 'session_completed',
        projectId: hit.projectId,
        dedupeKey: `done:${messageId}`,
        title: 'Session turn completed',
        status: 'success',
        statusLabel: 'Completed',
        detail: oneLine(typeof message.content === 'string' ? message.content : null),
        refs: [{ kind: 'session', targetId: sessionId, label: hit.session.name || 'Session' }],
        facts: { agentId: hit.session.agentId },
        privateToUserId: hit.session.ownerUserId,
      };
    }

    case 'finalize_run_completed': {
      const status = str(data.status);
      const runId = str(data.run_id) ?? str(data.runId);
      if (!status || !runId) return null;
      const outcome = FINALIZE_PASS.has(status)
        ? 'pass'
        : FINALIZE_FAIL.has(status)
          ? 'fail'
          : null;
      if (!outcome) return null;
      // The run row says whether it belongs to a session; without it, whether
      // the outcome is private cannot be told.
      const run = safe(() => lookups.getFinalizeRun(runId), null);
      if (!run) return null;
      const sessionId = run.sessionId ?? str(data.session_id) ?? str(data.sessionId);
      const session = sessionId ? sessionFacts(lookups, sessionId) : null;
      if (sessionId && !session) return null;
      const projectId = run.projectId;
      const failureReason = str(data.failure_reason) ?? str(data.failureReason);
      return {
        event: 'finalize_run_completed',
        projectId,
        dedupeKey: `finalize:${runId}:${status}`,
        title: outcome === 'pass' ? 'Finalize passed' : 'Finalize failed',
        status: outcome === 'pass' ? 'success' : 'failure',
        statusLabel:
          status === 'pushed'
            ? 'Pushed'
            : status === 'ready_to_push'
              ? 'Ready to push'
              : outcome === 'pass'
                ? 'Passed'
                : status.replace(/_/g, ' '),
        detail: failureReason && outcome === 'fail' ? failureReason.replace(/_/g, ' ') : null,
        refs:
          sessionId && session
            ? [{ kind: 'session', targetId: sessionId, label: session.name || 'Session' }]
            : [],
        facts: { outcome, agentId: session?.agentId ?? null },
        privateToUserId: session ? session.ownerUserId : null,
      };
    }

    case 'native_pr_update': {
      const action = str(data.action);
      const event: ChatTriggerEvent | null =
        action === 'opened'
          ? 'pr_opened'
          : action === 'review_requested'
            ? 'pr_review_requested'
            : action === 'merged'
              ? 'pr_merged'
              : null;
      const projectId = str(data.projectId);
      const number = typeof data.prNumber === 'number' ? data.prNumber : null;
      if (!event || !projectId || !number) return null;
      const target = `${projectId}#${number}`;
      // A PR opens and merges once. A review can be requested again; the
      // producer stamps each request.
      let occurrence = `pr:${target}:${action}`;
      if (event === 'pr_review_requested') {
        if (typeof data.reviewRequestedAt !== 'number') return null;
        occurrence += `:${data.reviewRequestedAt}`;
      }
      return {
        event,
        projectId,
        dedupeKey: occurrence,
        title:
          event === 'pr_opened'
            ? 'Pull request opened'
            : event === 'pr_merged'
              ? 'Pull request merged'
              : 'Review requested',
        status: event === 'pr_merged' ? 'success' : event === 'pr_opened' ? 'info' : 'waiting',
        statusLabel: event === 'pr_merged' ? 'Merged' : event === 'pr_opened' ? 'Open' : 'Review',
        detail: oneLine(safe(() => lookups.getPrTitle(projectId, number), null)),
        refs: [{ kind: 'pr', targetId: target, label: target }],
        facts: {},
        privateToUserId: null,
      };
    }

    case 'card_created':
    case 'card_moved': {
      const cardId = str(data.cardId);
      const created = data.type === 'card_created';
      // The column is the one the producer moved the card into, not wherever
      // the card is by the time this runs; each move carries its own id.
      const column = str(data.columnName);
      const moveId = str(data.moveId);
      if (!cardId || !column || (!created && !moveId)) return null;
      const card = safe(() => lookups.getCard(cardId), null);
      const projectId = str(data.projectId) ?? safe(() => lookups.resolveProjectId(data), null);
      if (!card || !projectId) return null;
      return {
        event: created ? 'card_created' : 'card_moved',
        projectId,
        dedupeKey: created ? `card_created:${cardId}` : `card_moved:${cardId}:${moveId}`,
        title: created ? 'Card created' : `Card moved to ${column ?? 'another column'}`,
        status: column?.toLowerCase() === 'done' ? 'success' : 'info',
        statusLabel: column ?? '',
        detail: oneLine(card.title),
        refs: [{ kind: 'card', targetId: cardId, label: card.label }],
        facts: { column, epicId: card.epicId, labels: card.labels },
        privateToUserId: null,
      };
    }

    case 'support_ticket_created': {
      const ticket = (data.ticket ?? {}) as {
        id?: unknown;
        subject?: unknown;
        type?: unknown;
        project_id?: unknown;
      };
      const ticketId = str(ticket.id);
      const projectId = str(data.projectId) ?? str(ticket.project_id);
      if (!ticketId || !projectId) return null;
      const subject = str(ticket.subject) ?? 'Support ticket';
      return {
        event: 'support_ticket_created',
        projectId,
        dedupeKey: `ticket:${ticketId}`,
        title: 'Support ticket created',
        status: 'info',
        statusLabel: str(ticket.type) ?? 'New',
        detail: null,
        refs: [{ kind: 'ticket', targetId: ticketId, label: subject }],
        facts: {},
        privateToUserId: null,
      };
    }

    case 'cron_finished': {
      const projectId = str(data.projectId);
      const status =
        data.status === 'success' ? 'success' : data.status === 'error' ? 'error' : null;
      const cronId = data.cronId;
      const logId = data.logId;
      if (!projectId || !status || cronId == null || logId == null) return null;
      const name = str(data.cronName) ?? 'Cron';
      // Shared only when the producer says so; a private cron needs its owner.
      const owner = str(data.ownerUserId);
      if (data.cronShared !== true && !owner) return null;
      return {
        event: 'cron_finished',
        projectId,
        dedupeKey: `cron:${String(cronId)}:${String(logId)}`,
        title: status === 'success' ? `Cron "${name}" finished` : `Cron "${name}" failed`,
        status: status === 'success' ? 'success' : 'failure',
        statusLabel: status === 'success' ? 'Success' : 'Error',
        detail: oneLine(str(data.preview)),
        refs: [],
        facts: { outcome: status },
        privateToUserId: data.cronShared === true ? null : owner,
      };
    }

    case 'infra_alert_transition': {
      const projectId = str(data.projectId);
      const toState = str(data.toState);
      if (!projectId || !toState || typeof data.at !== 'number') return null;
      const rule = str(data.ruleName) ?? 'Alert';
      const resource = str(data.resourceId) ?? 'resource';
      return {
        event: 'infra_alert',
        projectId,
        dedupeKey: `infra:${String(data.ruleId ?? '')}:${resource}:${toState}:${data.at}`,
        title: `${rule} on ${resource}`,
        status: toState === 'ALARM' ? 'failure' : toState === 'OK' ? 'success' : 'warning',
        statusLabel: toState,
        detail: oneLine(
          [toState ? `${str(data.fromState) ?? 'state'} → ${toState}` : null, str(data.reason)]
            .filter(Boolean)
            .join(' · '),
        ),
        refs: [],
        facts: { severity: str(data.severity) },
        privateToUserId: null,
      };
    }

    case 'infra_health_event': {
      const projectId = str(data.projectId);
      const healthId = str(data.healthEventId) ?? str(data.eventArn);
      if (!projectId || !healthId) return null;
      const statusCode = str(data.statusCode);
      return {
        event: 'infra_alert',
        projectId,
        dedupeKey: `health:${healthId}:${statusCode ?? ''}`,
        title: str(data.headline) ?? 'AWS Health event',
        status: statusCode === 'closed' ? 'success' : 'warning',
        statusLabel: statusCode ?? '',
        detail: oneLine(str(data.eventTypeCategory)),
        refs: [],
        facts: { severity: str(data.severity) },
        privateToUserId: null,
      };
    }

    default:
      return null;
  }
}

function lowerSet(values: string[] | undefined): Set<string> {
  return new Set((values ?? []).map((v) => v.trim().toLowerCase()).filter(Boolean));
}

/** Does a trigger's filter accept this occurrence? Fields the event does not use are ignored. */
export function triggerFilterMatches(
  event: ChatTriggerEvent,
  filter: ChatTriggerFilter,
  facts: TriggerFacts,
): boolean {
  const used = new Set(CHAT_TRIGGER_EVENT_INFO[event].filters);
  if (used.has('columns')) {
    const want = lowerSet(filter.columns);
    if (want.size && !want.has((facts.column ?? '').toLowerCase())) return false;
  }
  if (used.has('epicId') && filter.epicId && facts.epicId !== filter.epicId) return false;
  if (used.has('labels')) {
    const want = lowerSet(filter.labels);
    if (want.size && !(facts.labels ?? []).some((l) => want.has(l.toLowerCase()))) return false;
  }
  if (used.has('outcome') && filter.outcome && facts.outcome !== filter.outcome) return false;
  if (used.has('agentIds') && filter.agentIds?.length) {
    if (!facts.agentId || !filter.agentIds.includes(facts.agentId)) return false;
  }
  if (used.has('severities')) {
    const want = lowerSet(filter.severities);
    if (want.size && !want.has((facts.severity ?? '').toLowerCase())) return false;
  }
  return true;
}

/** Markdown body: title, ref chips, then the detail line. Readable without the card. */
export function buildTriggerMessageBody(occ: TriggerOccurrence): string {
  const chips = occ.refs
    .map((r) => formatHubChatRefToken(r.label, r.kind, r.targetId))
    .filter((t): t is string => !!t);
  const head = [escapeMarkdownText(occ.title, true), ...chips].join(' ');
  return occ.detail ? `${head}\n${escapeMarkdownText(occ.detail, true)}` : head;
}

export function buildTriggerCard(trigger: ChatTriggerRow, occ: TriggerOccurrence): ChatTriggerCard {
  return {
    type: 'trigger',
    event: occ.event,
    triggerId: trigger.id,
    projectId: occ.projectId,
    title: occ.title,
    status: occ.status,
    statusLabel: occ.statusLabel,
    detail: occ.detail,
    refs: occ.refs,
  };
}

/** Fails closed: an unknown project or a lookup error reads as no access. */
function defaultCreatorCanViewProject(userId: string, orgId: string, projectId: string): boolean {
  try {
    if (isLocalBundledServer()) return true;
    const project = findProject(projectId);
    if (!project) return false;
    return canViewProject(project, buildRefViewer(userId, orgId, false).visibility);
  } catch {
    return false;
  }
}

/** How long a posted occurrence is remembered. Duplicate broadcasts arrive within seconds. */
const POSTED_RETENTION_MS = 7 * 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 60 * 60_000;
let lastPruneAt = 0;

function maybePrune(now: number, log: (msg: string) => void): void {
  if (now - lastPruneAt < PRUNE_EVERY_MS) return;
  lastPruneAt = now;
  try {
    pruneTriggerPosts(POSTED_RETENTION_MS, now);
  } catch (err) {
    log(`[chat-triggers] prune failed: ${(err as Error).message}`);
  }
}

/**
 * Fire-and-forget: the Agent Hub message is already committed and announced,
 * so nothing Google does (throwing, rejecting, hanging) can affect it.
 */
function mirrorToGoogleChat(
  send: (input: GoogleChatTriggerSend) => Promise<void>,
  input: GoogleChatTriggerSend,
  triggerId: string,
  log: (msg: string) => void,
): void {
  const fail = (err: unknown) =>
    log(
      `[chat-triggers] trigger ${triggerId} Google Chat post failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  try {
    void send(input).catch(fail);
  } catch (err) {
    fail(err);
  }
}

export interface ChatTriggerRouterDeps {
  broadcast?: BroadcastFn;
  lookups?: TriggerLookups;
  listTriggers?: (projectId: string, event: ChatTriggerEvent) => ChatTriggerRow[];
  getChannel?: (channelId: string) => HubChatChannelRow | null;
  isChannelMember?: (channelId: string, userId: string) => boolean;
  /**
   * Whether the trigger's creator can still view the project. Checked when
   * posting, not only when the trigger was made: losing access stops it.
   */
  creatorCanViewProject?: (userId: string, orgId: string, projectId: string) => boolean;
  post?: typeof appendMessage;
  /**
   * Posts to a trigger's Google Chat space. Called only after the Agent Hub
   * message commits; its promise is not awaited and a rejection is logged.
   */
  sendToGoogleChat?: (send: GoogleChatTriggerSend) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * Posts a broadcast into every matching trigger's channel. Returns the posted
 * messages. Never throws: a failure is logged and skips that trigger only.
 */
export function routeBroadcastToChatTriggers(
  data: BroadcastData,
  deps: ChatTriggerRouterDeps = {},
): HubChatMessageRow[] {
  const posted: HubChatMessageRow[] = [];
  const log = deps.log ?? ((msg: string) => console.warn(msg));
  let occ: TriggerOccurrence | null;
  try {
    occ = mapBroadcastToTriggerOccurrence(data, deps.lookups ?? defaultTriggerLookups);
  } catch (err) {
    log(`[chat-triggers] could not read ${String(data?.type)}: ${(err as Error).message}`);
    return posted;
  }
  if (!occ) return posted;
  const event = occ;

  let triggers: ChatTriggerRow[];
  try {
    triggers = (deps.listTriggers ?? listEnabledTriggers)(event.projectId, event.event);
  } catch (err) {
    log(`[chat-triggers] could not list triggers: ${(err as Error).message}`);
    return posted;
  }
  maybePrune((deps.now ?? Date.now)(), log);
  const loadChannel = deps.getChannel ?? getChannel;
  const post = deps.post ?? appendMessage;
  const isMember =
    deps.isChannelMember ?? ((channelId: string, userId: string) => !!getMember(channelId, userId));
  const creatorCanView = deps.creatorCanViewProject ?? defaultCreatorCanViewProject;

  for (const trigger of triggers) {
    try {
      if (!trigger.enabled) continue;
      if (event.privateToUserId && trigger.created_by !== event.privateToUserId) continue;
      if (
        !triggerFilterMatches(event.event, parseTriggerFilter(trigger.filter_json), event.facts)
      ) {
        continue;
      }
      const channel = loadChannel(trigger.channel_id);
      if (!channel || channel.archived_at) continue;
      // No creator, or a creator who can no longer see the project: nothing
      // vouches for sending its activity anywhere.
      if (!trigger.created_by) continue;
      if (!creatorCanView(trigger.created_by, channel.org_id, event.projectId)) continue;
      // The owner of private work must be able to read the destination right
      // now: a channel they never joined, or have left, does not receive it.
      if (event.privateToUserId && !isMember(channel.id, event.privateToUserId)) continue;
      // The occurrence is recorded in the same transaction as its message:
      // a failed write records nothing, so the next broadcast retries it.
      const card = buildTriggerCard(trigger, event);
      const message = postOccurrenceOnce(trigger.id, event.dedupeKey, () =>
        post({
          channelId: channel.id,
          authorKind: 'trigger',
          body: buildTriggerMessageBody(event),
          refs: event.refs.map((r) => ({
            kind: r.kind,
            targetId: r.targetId,
            projectId: event.projectId,
          })),
          payload: card,
        }),
      );
      if (!message) continue;
      posted.push(message);
      // Only after commit: a rolled-back message is never announced.
      broadcastHubChatMessage(deps.broadcast, HUB_CHAT_MESSAGE_EVENT, channel, message);
      if (trigger.google_chat_space_id) {
        mirrorToGoogleChat(
          deps.sendToGoogleChat ?? sendTriggerToGoogleChat,
          {
            userId: trigger.created_by,
            spaceId: trigger.google_chat_space_id,
            card,
            messageId: message.id,
          },
          trigger.id,
          log,
        );
      }
    } catch (err) {
      log(`[chat-triggers] trigger ${trigger.id} failed: ${(err as Error).message}`);
    }
  }
  return posted;
}
