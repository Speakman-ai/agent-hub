/**
 * Unified notification fan-out (spec STORAGE).
 *
 * `websocket.ts#broadcast` hands every broadcast to
 * `handleBroadcastForNotifications`. For the events we notify on it:
 *
 *  1. maps the broadcast to one notification (category, copy, source key),
 *  2. resolves the user-id list once (session owner, assignee, deploy
 *     trigger, or the users who can view the project),
 *  3. per user, reads `user_notification_prefs` and
 *     - inserts an inbox row when `in_app` is on, emitting a
 *       `notification_created` WS event targeted to that user (carrying the
 *       `desktop` flag so desktop clients know whether to raise an OS notice),
 *     - with `in_app` off but `desktop` on, emits the same event with
 *       `inbox: false` and no row, so desktop clients still raise the OS
 *       notice while the bell ignores it,
 *     - sends Expo push to that user's devices when push is on.
 *
 * Push for events that pushed before this module existed keeps its device
 * filtering (`filterTokensForBroadcastVisibility` + `filterTokensForSessionOwner`)
 * and, for a category the user never saved, the device `enabled_events`
 * check. A user who stored a choice for the category gets that choice.
 * Outside local mode every pushed device is authorized with the same
 * `canViewProject` check as users: an attributed device must belong to an
 * authorized recipient, and a device registered without a user id is checked
 * as an anonymous org member (so it keeps getting pushes for projects open to
 * the whole org, and never for private or restricted ones).
 *
 * Hub Chat goes through the same per-user step. Recipients are the users
 * `chatPushRecipients` would notify (respects notify_level and mutes). DMs
 * and @mentions use the `dm` / `mention` categories, so their prefs gate the
 * inbox row and push. Other channel traffic (notify_level=all) never creates
 * an inbox row and keeps the device-level `chat_message` push check.
 */
import { v4 as uuidv4 } from 'uuid';
import {
  buildMessages,
  broadcastSessionId,
  filterTokensForBroadcastVisibility,
  filterTokensForSessionOwner,
  mapBroadcastToPush,
  resolveDeps,
  sendExpoPush,
  tokenAcceptsEvent,
  type BroadcastData,
  type DeviceTokenRowWithPrefs,
  type PushDispatchDeps,
} from './push.js';
import { HUB_CHAT_MESSAGE_EVENT, mentionedUserIds } from './hub-chat-events.js';
import { REMINDER_DUE_EVENT } from './reminders-events.js';
import { pushCategoryIdFor } from '../shared/utils/approvals.js';
import { isLocalBundledServer } from './auth.js';
import { getActiveOrgId } from './orgs.js';
import { listMembersForOrg } from './memberships-store.js';
import { assignedProjectIdsForUser, restrictedProjectIds } from './project-members-store.js';
import { canViewProject } from './project-visibility.js';
import { getUserNotificationPrefs } from './notification-prefs-store.js';
import {
  countUnreadNotifications,
  insertNotification,
  type InsertNotificationInput,
  type InsertNotificationResult,
} from './notifications-store.js';
import {
  categoryChannelDefault,
  type ChannelDefaults,
  type NotificationCategoryId,
  type PushEventType,
} from '../shared/utils/notificationCategories.js';
import type { BroadcastFn } from './types.js';

export const NOTIFICATION_CREATED_EVENT = 'notification_created';

/**
 * Desktop-only notices have no inbox row, so the unique (user_id, source_key)
 * index can't dedupe repeated broadcasts. Remember recent keys in memory.
 */
const DESKTOP_ONLY_DEDUPE_TTL_MS = 10 * 60 * 1000;
const DESKTOP_ONLY_DEDUPE_MAX = 5000;
const desktopOnlySeen = new Map<string, number>();

/** True the first time `userId`/`sourceKey` is seen within the TTL. */
export function claimDesktopOnlyNotice(
  userId: string,
  sourceKey: string,
  now: number = Date.now(),
): boolean {
  const key = `${userId}\u0000${sourceKey}`;
  const seenAt = desktopOnlySeen.get(key);
  if (seenAt !== undefined && now - seenAt < DESKTOP_ONLY_DEDUPE_TTL_MS) return false;
  desktopOnlySeen.delete(key);
  desktopOnlySeen.set(key, now);
  // Map iterates in insertion order, so the oldest keys come first.
  for (const [k, at] of desktopOnlySeen) {
    if (desktopOnlySeen.size <= DESKTOP_ONLY_DEDUPE_MAX && now - at < DESKTOP_ONLY_DEDUPE_TTL_MS) {
      break;
    }
    desktopOnlySeen.delete(k);
  }
  return true;
}

export function resetDesktopOnlyDedupeForTests(): void {
  desktopOnlySeen.clear();
}

/** Who a notification is addressed to, before preferences apply. */
export type RecipientSpec =
  | { kind: 'session'; sessionId: string }
  | { kind: 'users'; userIds: string[] }
  | { kind: 'project' }
  /** Hub Chat members who would be notified (`getChatPushUserIds`). */
  | { kind: 'chat' }
  /**
   * A user's own personal item (a reminder). Authorized by ownership, not by
   * project visibility: the event carries nothing beyond what the user wrote
   * or asked an agent to write for them.
   */
  | { kind: 'self'; userId: string };

export interface NotificationIntent {
  category: NotificationCategoryId;
  /**
   * Push event key the event used before user prefs existed. Drives the
   * legacy device filters and the `enabled_events` fallback. Null for
   * categories that never pushed.
   */
  pushEvent: PushEventType | null;
  title: string;
  body: string;
  data: Record<string, unknown>;
  projectId: string | null;
  /** Dedupes repeated broadcasts of the same event per user. */
  sourceKey: string;
  recipients: RecipientSpec;
  /**
   * Per-user category override. Returning null means the user gets no inbox
   * row and push falls back to the device check for `pushEvent`.
   */
  categoryForUser?: (userId: string) => NotificationCategoryId | null;
  /**
   * `legacy`: push targets the project/session device filters (events that
   * pushed before user prefs). `recipients`: push targets only the resolved
   * users' own devices.
   */
  deviceScope: 'legacy' | 'recipients';
}

export interface FanoutDeps extends PushDispatchDeps {
  broadcast?: BroadcastFn;
  getPrefs?: (userId: string, category: NotificationCategoryId) => StoredPrefs;
  insert?: (input: InsertNotificationInput) => InsertNotificationResult;
  countUnread?: (userId: string) => number;
  /** Users who can currently view the project; must throw when that cannot be determined. */
  listProjectUserIds?: (projectId: string) => string[];
  /**
   * Whether an anonymous org member may view the project: the authorization
   * for devices registered without a user id. Must throw when unknown.
   */
  isProjectOpenToOrg?: (projectId: string) => boolean;
  isLocalBundled?: () => boolean;
}

/** Channel switches plus whether they came from a stored row. */
export interface StoredPrefs extends ChannelDefaults {
  isDefault: boolean;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

export function defaultGetPrefs(userId: string, category: NotificationCategoryId): StoredPrefs {
  const row = getUserNotificationPrefs(userId).find((p) => p.category === category);
  if (row) return row;
  return {
    in_app: categoryChannelDefault(category, 'in_app'),
    desktop: categoryChannelDefault(category, 'desktop'),
    push: categoryChannelDefault(category, 'push'),
    isDefault: true,
  };
}

/**
 * Users in the active org who can view `projectId`. No project id, or one
 * the model no longer knows, yields no one: we cannot prove who may see the
 * event's content.
 *
 * Throws when membership or the project ACL cannot be read. Callers must
 * treat that as "notify no one" rather than guessing, because an empty
 * restriction set would open restricted projects to the whole org.
 */
export function listProjectViewerUserIds(
  projectId: string | null,
  findProjectById: Required<PushDispatchDeps>['findProjectById'],
): string[] {
  if (!projectId) return [];
  const project = findProjectById(projectId);
  if (!project) return [];
  const members = listMembersForOrg(getActiveOrgId());
  const restricted = restrictedProjectIds();
  return members
    .filter((m) =>
      canViewProject(project, {
        userId: m.userId,
        role: m.role,
        assignedProjectIds: assignedProjectIdsForUser(m.userId),
        restrictedProjectIds: restricted,
      }),
    )
    .map((m) => m.userId);
}

/**
 * May an org member with no particular role or assignment view the project?
 * Shared, unrestricted projects only. Throws when the ACL can't be read.
 */
export function isProjectOpenToOrg(
  projectId: string,
  findProjectById: Required<PushDispatchDeps>['findProjectById'],
): boolean {
  const project = findProjectById(projectId);
  if (!project) return false;
  return canViewProject(project, {
    userId: null,
    assignedProjectIds: new Set<string>(),
    restrictedProjectIds: restrictedProjectIds(),
  });
}

// Broadcast → intent

const FINALIZE_FAILED_STATUSES = new Set(['failed', 'timed_out', 'infra_error']);
const DEPLOY_TERMINAL_STATUSES = new Set(['success', 'error']);

function fromLegacyPush(data: BroadcastData): NotificationIntent | null {
  const mapped = mapBroadcastToPush(data);
  if (!mapped) return null;
  const { event, payload } = mapped;
  const d = payload.data ?? {};
  const sessionId = broadcastSessionId(data);
  const projectId = str(data.projectId) ?? null;
  const recipients: RecipientSpec = sessionId
    ? { kind: 'session', sessionId }
    : { kind: 'project' };
  let sourceKey: string;
  switch (data.type) {
    case 'awaiting_input':
      sourceKey = `awaiting_feedback:${sessionId}:${(Array.isArray(data.askIds) ? data.askIds : []).join(',')}`;
      break;
    case 'finalize_run_completed':
      sourceKey = `finalize:${String(data.run_id)}:${String(data.failure_reason ?? data.status)}`;
      break;
    case 'support_ticket_created':
      sourceKey = `support_ticket:${String(d.ticketId ?? uuidv4())}`;
      break;
    case 'card_moved':
      sourceKey = `card_review:${String(data.cardId)}:${String(data.moveId ?? uuidv4())}`;
      break;
    case 'native_pr_update':
      sourceKey = `pr_review:${projectId}:${String(data.prNumber)}:${String(data.at ?? data.updatedAt ?? uuidv4())}`;
      break;
    case 'webhook_pr_merged':
      sourceKey = `pr_merged:${projectId}:${String(data.prNumber)}`;
      break;
    case 'infra_alert_transition':
      sourceKey = `infra_alert:${String(data.alertId)}:${String(data.toState)}:${String(data.at ?? uuidv4())}`;
      break;
    case 'infra_health_event':
      sourceKey = `infra_health:${String(data.healthEventId)}:${String(data.statusCode ?? '')}`;
      break;
    default:
      sourceKey = `${event}:${uuidv4()}`;
  }
  return {
    category: event === 'chat_message' ? 'dm' : event,
    pushEvent: event,
    deviceScope: 'legacy',
    title: payload.title,
    body: payload.body,
    data: { ...d },
    projectId,
    sourceKey,
    recipients,
  };
}

/**
 * Map a broadcast to the notification it should produce, or null. Exported
 * for tests. Hub Chat is handled separately (push-only).
 */
export function mapBroadcastToNotification(data: BroadcastData): NotificationIntent | null {
  if (!data || typeof data.type !== 'string') return null;
  if (data.suppressPush === true) return null;

  switch (data.type) {
    case HUB_CHAT_MESSAGE_EVENT: {
      const mapped = mapBroadcastToPush(data);
      if (!mapped) return null;
      const message = (data.message ?? {}) as { id?: unknown; refs?: unknown };
      const messageId = str(message.id);
      if (!messageId) return null;
      const isDm = data.channelKind === 'dm';
      const mentioned = mentionedUserIds(message.refs);
      return {
        category: isDm ? 'dm' : 'mention',
        pushEvent: 'chat_message',
        title: mapped.payload.title,
        body: mapped.payload.body,
        data: { ...(mapped.payload.data ?? {}) },
        projectId: null,
        sourceKey: `hub_chat:${messageId}`,
        recipients: { kind: 'chat' },
        categoryForUser: (userId) => (isDm ? 'dm' : mentioned.has(userId) ? 'mention' : null),
        deviceScope: 'recipients',
      };
    }

    case 'done': {
      // Only chat turn ends carry the assistant message; reviewer and
      // process-termination `done`s are not a finished turn for a person.
      const sessionId = broadcastSessionId(data);
      const message = (data.message ?? {}) as { id?: unknown };
      const messageId = str(data.messageId) ?? str(message.id);
      const owner = str(data.ownerUserId);
      if (!sessionId || !messageId || !owner) return null;
      const name = str(data.sessionName);
      return {
        category: 'session_completed',
        pushEvent: null,
        deviceScope: 'recipients',
        title: 'Session completed',
        body: `${name ? `"${name}"` : 'A session'} finished its turn`,
        data: { sessionId, agentId: data.agentId, type: 'session_completed' },
        projectId: str(data.projectId) ?? null,
        sourceKey: `session_completed:${messageId}`,
        recipients: { kind: 'users', userIds: [owner] },
      };
    }

    case 'routine_run_finished': {
      // `sessionId` is null when the run failed before it got a session; the
      // row then links to the project's cron jobs, where the log lives.
      const sessionId = broadcastSessionId(data) ?? null;
      const cronId = data.cronId;
      const logId = data.logId;
      if (cronId == null || logId == null) return null;
      const owner = str(data.ownerUserId);
      const projectId = str(data.projectId) ?? null;
      const name = str(data.cronName) ?? 'Routine';
      const ok = data.status === 'success';
      const preview = str(data.preview);
      return {
        category: 'routine_run',
        pushEvent: null,
        deviceScope: 'recipients',
        title: ok ? `Routine finished: ${name}` : `Routine failed: ${name}`,
        body: preview ?? (ok ? 'Finished with no report' : 'The run failed'),
        data: {
          ...(sessionId ? { sessionId, agentId: data.agentId } : {}),
          projectId,
          cronId,
          logId,
          status: ok ? 'success' : 'error',
          type: 'routine_run',
        },
        projectId,
        sourceKey: `routine_run:${String(cronId)}:${String(logId)}`,
        recipients: owner
          ? { kind: 'users', userIds: [owner] }
          : sessionId
            ? { kind: 'session', sessionId }
            : { kind: 'project' },
      };
    }

    case 'browser_login_requested': {
      const sessionId = broadcastSessionId(data);
      const request = (data.request ?? {}) as { requestId?: unknown; domain?: unknown };
      const requestId = str(request.requestId);
      if (!sessionId || !requestId) return null;
      const owner = str(data.ownerUserId);
      const domain = str(request.domain) ?? 'a site';
      const who = str(data.agentName) ?? 'An agent';
      return {
        category: 'browser_sign_in',
        pushEvent: null,
        deviceScope: 'recipients',
        title: `Sign in to ${domain}`,
        body: `${who} is waiting for you to sign in to ${domain} in its browser`,
        data: {
          sessionId,
          agentId: data.agentId,
          domain,
          requestId,
          pane: 'browser',
          type: 'browser_sign_in',
        },
        projectId: str(data.projectId) ?? null,
        sourceKey: `browser_sign_in:${requestId}`,
        recipients: owner ? { kind: 'users', userIds: [owner] } : { kind: 'session', sessionId },
      };
    }

    case 'approval_requested': {
      const sessionId = broadcastSessionId(data);
      const approval = (data.approval ?? {}) as {
        id?: unknown;
        action?: unknown;
        target?: unknown;
        domain?: unknown;
        canRemember?: unknown;
        expiresAt?: unknown;
      };
      const approvalId = str(approval.id);
      if (!sessionId || !approvalId) return null;
      const owner = str(data.ownerUserId);
      const action = str(approval.action) ?? 'act';
      const target = str(approval.target) ?? 'something';
      const who = str(data.agentName) ?? 'An agent';
      return {
        category: 'approval_requested',
        pushEvent: null,
        deviceScope: 'recipients',
        title: `Approve: ${action}`,
        body: `${who} wants to ${action} ${target.length > 120 ? `${target.slice(0, 117)}...` : target}`,
        data: {
          sessionId,
          agentId: data.agentId,
          approvalId,
          action,
          domain: str(approval.domain),
          canRemember: approval.canRemember === true,
          expiresAt: typeof approval.expiresAt === 'number' ? approval.expiresAt : undefined,
          type: 'approval_requested',
        },
        projectId: str(data.projectId) ?? null,
        sourceKey: `approval_requested:${approvalId}`,
        recipients: owner ? { kind: 'users', userIds: [owner] } : { kind: 'session', sessionId },
      };
    }

    case REMINDER_DUE_EVENT: {
      const reminder = (data.reminder ?? {}) as Record<string, unknown>;
      const id = str(reminder.id);
      const owner = str(reminder.userId) ?? str(data.ownerUserId);
      if (!id || !owner) return null;
      const title = str(reminder.title) ?? 'Reminder';
      const notes = str(reminder.notes);
      const remindAt = str(reminder.remindAt);
      return {
        category: 'reminder',
        pushEvent: null,
        deviceScope: 'recipients',
        title: `Reminder: ${title.length > 120 ? `${title.slice(0, 117)}...` : title}`,
        body: notes ? (notes.length > 200 ? `${notes.slice(0, 197)}...` : notes) : 'Due now',
        data: {
          reminderId: id,
          sessionId: str(reminder.sessionId),
          agentId: str(reminder.agentId),
          projectId: str(reminder.projectId),
          type: 'reminder',
        },
        projectId: str(reminder.projectId) ?? null,
        // remindAt is part of the key so a snoozed reminder notifies again.
        sourceKey: `reminder:${id}:${remindAt ?? ''}`,
        recipients: { kind: 'self', userId: owner },
      };
    }

    case 'finalize_run_completed': {
      const legacy = fromLegacyPush(data);
      if (legacy) return legacy;
      const status = str(data.status);
      if (!status || !FINALIZE_FAILED_STATUSES.has(status)) return null;
      const sessionId = broadcastSessionId(data);
      if (!sessionId) return null;
      const name = str(data.sessionName);
      const reason = str(data.failure_reason);
      return {
        category: 'finalize_failed',
        pushEvent: null,
        deviceScope: 'recipients',
        title: 'Finalize failed',
        body: `${name ? `"${name}"` : 'A session'} failed Finalize${reason ? ` (${reason.replace(/_/g, ' ')})` : ''}`,
        data: {
          sessionId,
          agentId: data.agentId,
          runId: data.run_id,
          failureReason: reason,
          type: 'finalize_failed',
        },
        projectId: str(data.projectId) ?? null,
        sourceKey: `finalize:${String(data.run_id)}:${status}`,
        recipients: { kind: 'session', sessionId },
      };
    }

    case 'card_assigned': {
      const userId = str(data.assignedUserId);
      const cardId = str(data.cardId);
      if (!userId || !cardId) return null;
      const title = str(data.cardTitle) ?? 'A card';
      const by = str(data.assignedByName);
      return {
        category: 'card_assigned_to_you',
        pushEvent: null,
        deviceScope: 'recipients',
        title: 'Card assigned to you',
        body: `"${title}"${by ? ` was assigned to you by ${by}` : ' was assigned to you'}`,
        data: { projectId: data.projectId, cardId, type: 'card_assigned_to_you' },
        projectId: str(data.projectId) ?? null,
        sourceKey: `card_assigned:${cardId}:${userId}:${str(data.assignmentId) ?? uuidv4()}`,
        recipients: { kind: 'users', userIds: [userId] },
      };
    }

    case 'escalation_created': {
      const esc = (data.escalation ?? {}) as {
        id?: unknown;
        project_id?: unknown;
        type?: unknown;
        title?: unknown;
        card_id?: unknown;
        pr_number?: unknown;
      };
      const id = str(esc.id);
      if (!id) return null;
      const projectId = str(esc.project_id) ?? null;
      const kind = str(esc.type)?.replace(/_/g, ' ');
      return {
        category: 'escalation',
        pushEvent: null,
        deviceScope: 'recipients',
        title: kind ? `Escalation: ${kind}` : 'Escalation',
        body: str(esc.title) ?? 'Needs human attention',
        data: {
          projectId,
          escalationId: id,
          cardId: esc.card_id ?? undefined,
          prNumber: esc.pr_number ?? undefined,
          type: 'escalation',
        },
        projectId,
        sourceKey: `escalation:${id}`,
        recipients: { kind: 'project' },
      };
    }

    case 'deployment_update': {
      const dep = (data.deployment ?? {}) as Record<string, unknown>;
      const id = str(dep.id);
      const status = str(dep.status);
      if (!id || !status || !DEPLOY_TERMINAL_STATUSES.has(status)) return null;
      const projectId = str(data.projectId) ?? str(dep.project_id) ?? str(dep.projectId) ?? null;
      const env = str(dep.environment) ?? 'deployment';
      const triggeredBy = str(dep.triggered_by) ?? str(dep.triggeredBy);
      const ok = status === 'success';
      return {
        category: 'deploy_outcome',
        pushEvent: null,
        deviceScope: 'recipients',
        title: ok ? 'Deploy succeeded' : 'Deploy failed',
        body: `${env}${str(dep.ref) ? ` @ ${String(dep.ref).slice(0, 12)}` : ''}${!ok && str(dep.error) ? `: ${String(dep.error).slice(0, 120)}` : ''}`,
        data: { projectId, deploymentId: id, environment: env, status, type: 'deploy_outcome' },
        projectId,
        sourceKey: `deploy:${id}:${status}`,
        recipients: triggeredBy ? { kind: 'users', userIds: [triggeredBy] } : { kind: 'project' },
      };
    }

    default:
      return fromLegacyPush(data);
  }
}

// Fan-out

/**
 * Who receives this notification. Two separate steps, applied to every
 * routing kind:
 *
 *  1. who the event is addressed to (assignee, session owner, deploy
 *     trigger, or everyone on the project), then
 *  2. authorization: keep only users who can currently view the event's
 *     project. Being addressed never grants access; an assignee or session
 *     owner whose project access was revoked gets nothing.
 *
 * Hub Chat is authorized by current channel membership instead, which
 * `getChatPushUserIds` already reads. Every other event needs a resolvable
 * project, otherwise there is nobody we can prove may see it. Lookup errors
 * propagate so the caller aborts the fan-out.
 */
export function resolveRecipientUserIds(
  data: BroadcastData,
  intent: NotificationIntent,
  projectId: string | null,
  d: Pick<Required<PushDispatchDeps>, 'getChatPushUserIds' | 'getSessionOwnerById'>,
  listProjectUserIds: (projectId: string) => string[],
): string[] {
  if (intent.recipients.kind === 'chat') {
    return [...new Set(d.getChatPushUserIds({ ...intent.data, ...data }))];
  }
  if (intent.recipients.kind === 'self') return [intent.recipients.userId];
  if (!projectId) return [];
  const viewers = listProjectUserIds(projectId);
  let addressed: string[];
  switch (intent.recipients.kind) {
    case 'users':
      addressed = intent.recipients.userIds;
      break;
    case 'session': {
      const owner = d.getSessionOwnerById(intent.recipients.sessionId);
      addressed = owner ? [owner] : viewers;
      break;
    }
    case 'project':
      addressed = viewers;
      break;
  }
  const authorized = new Set(viewers);
  return [...new Set(addressed.filter((u) => !!u && authorized.has(u)))];
}

/** Should this device get the push, given its owner's prefs? */
export function tokenWantsPush(
  token: DeviceTokenRowWithPrefs,
  intent: Pick<NotificationIntent, 'category' | 'pushEvent'>,
  prefs: StoredPrefs | null,
): boolean {
  if (prefs && !prefs.isDefault) return prefs.push;
  if (intent.pushEvent) return tokenAcceptsEvent(token, intent.pushEvent);
  return prefs ? prefs.push : false;
}

export interface FanoutResult {
  recipients: string[];
  inserted: number;
  pushed: number;
}

export async function handleBroadcastForNotifications(
  data: BroadcastData,
  deps: FanoutDeps = {},
): Promise<FanoutResult> {
  const empty: FanoutResult = { recipients: [], inserted: 0, pushed: 0 };
  if (!data || data.suppressPush === true) return empty;
  const intent = mapBroadcastToNotification(data);
  if (!intent) return empty;

  const d = resolveDeps(deps);
  const getPrefs = deps.getPrefs ?? defaultGetPrefs;
  const insert = deps.insert ?? insertNotification;
  const countUnread = deps.countUnread ?? countUnreadNotifications;
  const localBundled = (deps.isLocalBundled ?? isLocalBundledServer)();
  const listProjectUserIds =
    deps.listProjectUserIds ??
    ((projectId: string) => listProjectViewerUserIds(projectId, d.findProjectById));

  // Forward agentId so a push tap can open the right chat (see push.ts).
  if (intent.data.agentId == null) {
    const sessionId = str(intent.data.sessionId);
    if (sessionId) {
      const agentId = d.getSessionAgentIdById(sessionId);
      if (agentId) intent.data.agentId = agentId;
    }
  }

  // Any failure while working out who may see this event aborts the whole
  // fan-out (inbox, live event and push). Falling back to a default here
  // would widen the audience, e.g. to every org member.
  let projectId = intent.projectId;
  let userIds: string[];
  try {
    if (!projectId && intent.recipients.kind !== 'chat' && intent.recipients.kind !== 'self') {
      projectId = d.resolveProjectId({ type: data.type, ...intent.data });
    }
    userIds = resolveRecipientUserIds(data, intent, projectId, d, listProjectUserIds);
  } catch (err) {
    d.log(
      `[notifications] recipient resolution failed for ${String(data.type)}; notifying no one: ${
        (err as Error).message
      }`,
    );
    return empty;
  }
  const categoryByUser = new Map<string, NotificationCategoryId>();
  const prefsByUser = new Map<string, StoredPrefs>();
  // A user whose prefs can't be read gets nothing: guessing defaults could
  // push to someone who turned this category off.
  const prefsFailed = new Set<string>();
  for (const userId of userIds) {
    const category = intent.categoryForUser ? intent.categoryForUser(userId) : intent.category;
    if (!category) continue;
    categoryByUser.set(userId, category);
    try {
      prefsByUser.set(userId, getPrefs(userId, category));
    } catch (err) {
      prefsFailed.add(userId);
      d.log(`[notifications] prefs lookup failed for ${userId}: ${(err as Error).message}`);
    }
  }

  let inserted = 0;
  for (const [userId, prefs] of prefsByUser) {
    if (!prefs.in_app) {
      if (!prefs.desktop || !claimDesktopOnlyNotice(userId, intent.sourceKey)) continue;
      deps.broadcast?.({
        type: NOTIFICATION_CREATED_EVENT,
        ownerUserId: userId,
        inbox: false,
        desktop: true,
        notification: {
          category: categoryByUser.get(userId) ?? intent.category,
          title: intent.title,
          body: intent.body,
          data: intent.data,
          projectId,
          sourceKey: intent.sourceKey,
        },
      });
      continue;
    }
    try {
      const { notification, created } = insert({
        userId,
        projectId,
        category: categoryByUser.get(userId) ?? intent.category,
        title: intent.title,
        body: intent.body,
        data: intent.data,
        sourceKey: intent.sourceKey,
      });
      if (!created) continue;
      inserted += 1;
      deps.broadcast?.({
        type: NOTIFICATION_CREATED_EVENT,
        ownerUserId: userId,
        inbox: true,
        notification,
        desktop: prefs.desktop,
        unreadCount: countUnread(userId),
      });
    } catch (err) {
      d.log(`[notifications] inbox insert failed for ${userId}: ${(err as Error).message}`);
    }
  }

  // Push: legacy-scoped events keep their device filters; everything else
  // goes to the recipients' own devices only.
  let candidates: DeviceTokenRowWithPrefs[];
  if (intent.deviceScope === 'legacy' && intent.pushEvent) {
    candidates = filterTokensForSessionOwner(
      filterTokensForBroadcastVisibility(d.getAllTokens(), data, d),
      data,
      d,
    );
    // Outside single-tenant local mode every device needs authorization: an
    // attributed device through its user, an unattributed one as an
    // anonymous org member. A failed ACL read drops the unattributed ones.
    if (!localBundled) {
      const allowed = new Set(userIds);
      let anonymousAllowed = false;
      if (projectId && candidates.some((t) => !t.user_id)) {
        try {
          anonymousAllowed = (
            deps.isProjectOpenToOrg ?? ((id: string) => isProjectOpenToOrg(id, d.findProjectById))
          )(projectId);
        } catch (err) {
          d.log(`[notifications] project ACL read failed: ${(err as Error).message}`);
        }
      }
      candidates = candidates.filter((t) =>
        t.user_id ? allowed.has(t.user_id) : anonymousAllowed,
      );
    }
  } else {
    const allowed = new Set(userIds);
    candidates = d.getAllTokens().filter((t) => !!t.user_id && allowed.has(t.user_id));
  }
  const tokens = candidates.filter(
    (t) =>
      !(t.user_id && prefsFailed.has(t.user_id)) &&
      tokenWantsPush(t, intent, t.user_id ? (prefsByUser.get(t.user_id) ?? null) : null),
  );
  let pushed = 0;
  if (tokens.length) {
    pushed = await sendExpoPush(
      buildMessages(tokens, {
        title: intent.title,
        body: intent.body,
        // The category lets mobile gate foreground banners on the right pref.
        data: { ...intent.data, category: intent.category },
        categoryId: pushCategoryIdFor(intent.category),
      }),
      deps,
    );
  }
  return { recipients: userIds, inserted, pushed };
}
