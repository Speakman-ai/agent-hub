/**
 * Push notification dispatcher for mobile clients (Expo).
 *
 * Responsibilities:
 *  - Format push payloads for each broadcast event we notify on.
 *  - Filter registered device tokens by each token's `enabled_events`
 *    preference.
 *  - Chunk messages (Expo allows 100 per request) and POST to
 *    https://exp.host/--/api/v2/push/send.
 *  - Prune `DeviceNotRegistered` tokens from the database on receipt errors.
 *
 * The sole WebSocket broadcast site (`websocket.ts#broadcast`) calls
 * `handleBroadcastForPush(data)` which inspects `data.type` and dispatches
 * the relevant push payload. Keeping the dispatch in one place means new
 * broadcasts don't need bespoke wiring — only the formatters + the switch
 * below.
 *
 * All formatter helpers are pure — exported for unit tests.
 */

import { stmts } from './db.js';
import type { DeviceTokenRow } from './types.js';
import { resolveProjectIdFromEvent } from './event-project-resolver.js';
import { findProject } from './project-model.js';
import { isLocalBundledServer } from './auth.js';
import { getSessionOwner, getSessionAgentId } from './session-ownership.js';
import { shouldNotifyUserForProject } from '../shared/utils/notificationProjectScope.js';

// ── Event types that can trigger a push ────────────────────────────────
export const PUSH_EVENT_TYPES = [
  'awaiting_feedback',
  'ready_to_push',
  'pushed',
  'support_ticket_created',
  'thread_message',
  'review_assigned_to_you',
  'pr_merged',
] as const;

export type PushEventType = (typeof PUSH_EVENT_TYPES)[number];

// ── Payload shape sent to Expo ─────────────────────────────────────────
export interface ExpoPushMessage {
  to: string;
  sound: 'default' | null;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface ExpoPushReceipt {
  status: 'ok' | 'error';
  details?: { error?: string };
}

interface ExpoPushResponse {
  data?: ExpoPushReceipt[];
}

// ── Row with optional prefs column (added via ALTER TABLE migration) ──
export type DeviceTokenRowWithPrefs = DeviceTokenRow;

// ── Pure formatters (title + body) ─────────────────────────────────────
// Keep these aligned with mobile/src/utils/ticketNotifications.js so
// foreground banners and Expo push use the same wording.

export function awaitingFeedbackPush(args: { sessionName?: string }): {
  title: string;
  body: string;
} {
  const subject = args.sessionName ? `"${args.sessionName}"` : 'A session';
  return {
    title: 'Awaiting feedback',
    body: `${subject} is waiting for your input`,
  };
}

export function readyToPushPush(args: { sessionName?: string }): { title: string; body: string } {
  const subject = args.sessionName ? `"${args.sessionName}"` : 'A session';
  return {
    title: 'Ready to push',
    body: `${subject} passed review and checks — ready to push`,
  };
}

export function pushedPush(args: { sessionName?: string; prNumber?: number }): {
  title: string;
  body: string;
} {
  const subject = args.sessionName ? `"${args.sessionName}"` : 'A session';
  const pr =
    typeof args.prNumber === 'number' && args.prNumber > 0 ? ` (PR #${args.prNumber})` : '';
  return {
    title: 'Pushed',
    body: `${subject} was pushed${pr}`,
  };
}

export function supportTicketCreatedPush(args: { subject?: string; ticketType?: string }): {
  title: string;
  body: string;
} {
  const label = args.ticketType ? `${args.ticketType}: ` : '';
  return {
    title: 'Support ticket created',
    body: `${label}${args.subject || 'New ticket'}`,
  };
}

export function threadMessagePush(args: {
  threadName: string;
  threadType: string;
  preview?: string;
  isError?: boolean;
}): { title: string; body: string } {
  const label = args.threadType === 'heartbeat' ? 'Heartbeat' : 'Thread';
  const title = args.isError ? `${label} error` : `${label} message`;
  const trimmed =
    args.preview && args.preview.length > 120 ? args.preview.slice(0, 120) + '…' : args.preview;
  const body = trimmed ? `${args.threadName}: ${trimmed}` : `New message in "${args.threadName}"`;
  return { title, body };
}

export function reviewAssignedPush(args: { cardTitle?: string; prNumber?: number }): {
  title: string;
  body: string;
} {
  const title = args.cardTitle || 'Ticket';
  const pr = typeof args.prNumber === 'number' && args.prNumber > 0 ? `PR #${args.prNumber}: ` : '';
  return {
    title: 'Review assigned to you',
    body: `${pr}"${title}" needs your review`,
  };
}

export function prMergedPush(args: { cardTitle: string; prNumber: number; mergedBy?: string }): {
  title: string;
  body: string;
} {
  return {
    title: 'PR merged',
    body: `PR #${args.prNumber} merged${args.mergedBy ? ` by ${args.mergedBy}` : ''}: "${args.cardTitle}"`,
  };
}

// ── Preference filtering ────────────────────────────────────────────────

/**
 * Back-compat map from retired `enabled_events` preference keys to their
 * renamed equivalents in the current {@link PUSH_EVENT_TYPES} taxonomy.
 *
 * The push event taxonomy was renamed (see git history of this file). A device
 * row persisted under the old names still has e.g. `["session_complete",
 * "changes_ready"]` in `enabled_events`; without aliasing, `tokenAcceptsEvent`
 * would never match the new `awaiting_feedback` / `ready_to_push` events and
 * the user would silently go dark until they re-saved preferences. Keys with
 * no current equivalent (e.g. `pr_creation_stale`, `cron`) are intentionally
 * absent — those events no longer fire. `pr_merged` kept its name, so it needs
 * no alias.
 */
const LEGACY_EVENT_ALIASES: Record<string, PushEventType> = {
  session_complete: 'awaiting_feedback',
  changes_ready: 'ready_to_push',
  card_review: 'review_assigned_to_you',
  thread_entry: 'thread_message',
  thread_created: 'thread_message',
};

/**
 * Parse the `enabled_events` column value into a set.
 *
 * - `null`/`undefined`/empty → undefined (= all events enabled, legacy default)
 * - invalid JSON → undefined (treat as legacy default rather than silently
 *   dropping)
 * - array of strings → a Set (with retired keys also mapped to their current
 *   names via {@link LEGACY_EVENT_ALIASES} so existing preferences keep
 *   matching the renamed events; the original key is preserved too)
 * - anything else → undefined
 */
export function parseEnabledEvents(raw: string | null | undefined): Set<string> | undefined {
  if (raw == null || raw === '') return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const out = new Set<string>();
      for (const x of parsed) {
        if (typeof x !== 'string') continue;
        out.add(x);
        const alias = LEGACY_EVENT_ALIASES[x];
        if (alias) out.add(alias);
      }
      return out;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Should this token receive a push for `eventType`?
 * When the token has no recorded preferences, all events are allowed.
 */
export function tokenAcceptsEvent(row: DeviceTokenRowWithPrefs, eventType: PushEventType): boolean {
  const enabled = parseEnabledEvents(row.enabled_events);
  if (!enabled) return true;
  return enabled.has(eventType);
}

// ── Expo HTTP client (overridable for tests) ───────────────────────────
export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export interface PushDispatchDeps {
  /**
   * Injectable fetch — defaults to `globalThis.fetch`. Tests can pass a
   * fake to capture requests or simulate error receipts.
   */
  fetchFn?: typeof fetch;
  /** Injectable DB for tests; defaults to the shared prepared statements. */
  getAllTokens?: () => DeviceTokenRowWithPrefs[];
  removeToken?: (token: string) => void;
  /** Override for tests to silence console noise. */
  log?: (msg: string) => void;
  resolveProjectId?: (data: BroadcastData) => string | null;
  findProjectById?: (projectId: string) => ReturnType<typeof findProject>;
  /** Injectable session-owner lookup for tests; defaults to `getSessionOwner`. */
  getSessionOwnerById?: (sessionId: string) => string | null;
  /** Injectable session→agent lookup for tests; defaults to `getSessionAgentId`. */
  getSessionAgentIdById?: (sessionId: string) => string | null;
}

function resolveDeps(deps?: PushDispatchDeps): Required<PushDispatchDeps> {
  return {
    fetchFn: deps?.fetchFn ?? globalThis.fetch,
    getAllTokens:
      deps?.getAllTokens ??
      (() => {
        if (!stmts) return [];
        return stmts.getAllDeviceTokens.all() as DeviceTokenRowWithPrefs[];
      }),
    removeToken:
      deps?.removeToken ??
      ((token: string) => {
        if (stmts) stmts.removeDeviceToken.run(token);
      }),
    log: deps?.log ?? ((msg: string) => console.error(msg)),
    resolveProjectId:
      deps?.resolveProjectId ?? ((data: BroadcastData) => resolveProjectIdFromEvent(data)),
    findProjectById: deps?.findProjectById ?? ((projectId: string) => findProject(projectId)),
    getSessionOwnerById:
      deps?.getSessionOwnerById ?? ((sessionId: string) => getSessionOwner(sessionId)),
    getSessionAgentIdById:
      deps?.getSessionAgentIdById ?? ((sessionId: string) => getSessionAgentId(sessionId)),
  };
}

export function filterTokensForBroadcastVisibility(
  tokens: DeviceTokenRowWithPrefs[],
  data: BroadcastData,
  deps?: Pick<PushDispatchDeps, 'resolveProjectId' | 'findProjectById'>,
): DeviceTokenRowWithPrefs[] {
  const resolveProjectId =
    deps?.resolveProjectId ?? ((payload: BroadcastData) => resolveProjectIdFromEvent(payload));
  const findProjectById = deps?.findProjectById ?? ((projectId: string) => findProject(projectId));
  const projectId = resolveProjectId(data);
  if (!projectId) return tokens;
  const project = findProjectById(projectId);
  if (!project) return tokens;
  const localBypass = isLocalBundledServer();
  return tokens.filter((t) =>
    shouldNotifyUserForProject(project.ownerUserId ?? null, t.user_id ?? null, { localBypass }),
  );
}

/**
 * Account-based push filtering for session-scoped events.
 *
 * Sessions are strictly per-user (`sessions.owner_user_id`, see
 * `session-ownership.ts`), so a push about a specific session should only
 * land on the owner's devices — Kevin's `session_complete` must not buzz
 * Ryan's phone. Applies to any event whose payload carries a `sessionId`
 * (`awaiting_feedback`, `ready_to_push`, `pushed`, …); board/thread/support
 * events without a `sessionId` keep the shared fan-out.
 *
 * Fallbacks (deliberately permissive so nothing silently goes dark):
 *  - Unowned sessions (cron / heartbeat / autonomous spawns, pre-migration
 *    rows) → all tokens, matching today's behavior.
 *  - Local bundled server (single-tenant) → all tokens.
 *
 * Tokens with no `user_id` (registered before per-user auth, or by a
 * legacy global-apiKey caller) are excluded for owned sessions: they can't
 * be attributed to the owner, and re-registering on next app launch stamps
 * the user id.
 */
export function broadcastSessionId(data: BroadcastData): string | null {
  const sid = data.sessionId ?? data.session_id;
  return typeof sid === 'string' && sid.length > 0 ? sid : null;
}

export function filterTokensForSessionOwner(
  tokens: DeviceTokenRowWithPrefs[],
  data: BroadcastData,
  deps?: Pick<PushDispatchDeps, 'getSessionOwnerById'>,
): DeviceTokenRowWithPrefs[] {
  const sessionId = broadcastSessionId(data);
  if (!sessionId) return tokens;
  if (isLocalBundledServer()) return tokens;
  const getOwner = deps?.getSessionOwnerById ?? getSessionOwner;
  const owner = getOwner(sessionId);
  if (!owner) return tokens;
  return tokens.filter((t) => t.user_id === owner);
}

/**
 * Send push messages through Expo in chunks of 100 and prune
 * `DeviceNotRegistered` tokens from the store.
 *
 * Returns the count of messages successfully dispatched (0 when there are no
 * tokens or fetch fails — non-throwing so callers can "fire and forget").
 */
export async function sendExpoPush(
  messages: ExpoPushMessage[],
  deps?: PushDispatchDeps,
): Promise<number> {
  if (!messages.length) return 0;
  const { fetchFn, removeToken, log } = resolveDeps(deps);

  let sent = 0;
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      const resp = await fetchFn(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk),
      });
      const data = (await resp.json()) as ExpoPushResponse;
      if (data.data) {
        data.data.forEach((receipt, idx) => {
          if (receipt.status === 'ok') {
            sent += 1;
          } else if (
            receipt.status === 'error' &&
            receipt.details?.error === 'DeviceNotRegistered'
          ) {
            removeToken(chunk[idx].to);
          }
        });
      }
    } catch (err) {
      log(`[push] Failed to send: ${(err as Error).message}`);
    }
  }
  return sent;
}

/**
 * Build Expo push messages for the given set of tokens (already filtered)
 * from a single (title, body, data) triple. Platform sound defaults to
 * 'default'; pass `silent: true` to suppress.
 */
export function buildMessages(
  tokens: DeviceTokenRowWithPrefs[],
  payload: { title: string; body: string; data?: Record<string, unknown>; silent?: boolean },
): ExpoPushMessage[] {
  return tokens.map((t) => ({
    to: t.token,
    sound: payload.silent ? null : 'default',
    title: payload.title,
    body: payload.body,
    data: payload.data,
  }));
}

/**
 * Dispatch a push event to all tokens whose preferences include it.
 * Exposed so non-broadcast callers (e.g. heartbeat cron completion) can
 * reuse the same preference filtering + Expo client.
 */
export async function dispatchPushEvent(
  eventType: PushEventType,
  payload: { title: string; body: string; data?: Record<string, unknown>; silent?: boolean },
  deps?: PushDispatchDeps,
): Promise<number> {
  const d = resolveDeps(deps);
  const visibilityEvent: BroadcastData = {
    type: eventType,
    ...(payload.data ?? {}),
    projectId:
      typeof payload.data?.projectId === 'string'
        ? payload.data.projectId
        : payload.data?.projectId,
  };
  const tokens = filterTokensForSessionOwner(
    filterTokensForBroadcastVisibility(d.getAllTokens(), visibilityEvent, d),
    visibilityEvent,
    d,
  ).filter((t) => tokenAcceptsEvent(t, eventType));
  if (!tokens.length) return 0;
  const msgs = buildMessages(tokens, payload);
  return sendExpoPush(msgs, deps);
}

// ── Broadcast → push bridge ────────────────────────────────────────────

interface BroadcastData {
  type?: string;
  [key: string]: unknown;
}

/**
 * Inspect a WebSocket broadcast payload and, for the subset of types we
 * want to push, dispatch to Expo. Non-throwing and returns a promise that
 * callers can ignore (fire-and-forget).
 *
 * Unknown/ignored event types short-circuit with 0 so this is cheap to
 * call on every broadcast.
 *
 * Broadcasts may opt out of push entirely by setting `suppressPush: true`
 * on the payload. Used by e.g. cron runs where the per-cron `notify_on_run`
 * flag is off — the thread entry is still broadcast to the UI, but no
 * mobile push is dispatched.
 */
export async function handleBroadcastForPush(
  data: BroadcastData,
  deps?: PushDispatchDeps,
): Promise<number> {
  if (data && data.suppressPush === true) return 0;
  const mapped = mapBroadcastToPush(data);
  if (!mapped) return 0;
  const d = resolveDeps(deps);
  // Forward `agentId` so a cold-start tap (or a tap before the sessions list
  // loads) can open the right chat. `awaiting_input` carries it on the
  // broadcast; finalize (`ready_to_push`/`pushed`) broadcasts don't, so
  // resolve it from the session id. Only a single lookup, and only when the
  // payload exposes an unresolved `agentId` slot.
  if (mapped.payload.data && mapped.payload.data.agentId == null) {
    const sessionId = broadcastSessionId(data);
    if (sessionId) {
      const agentId = d.getSessionAgentIdById(sessionId);
      if (agentId) mapped.payload.data.agentId = agentId;
    }
  }
  const tokens = filterTokensForSessionOwner(
    filterTokensForBroadcastVisibility(d.getAllTokens(), data, d),
    data,
    d,
  ).filter((t) => tokenAcceptsEvent(t, mapped.event));
  if (!tokens.length) return 0;
  const msgs = buildMessages(tokens, mapped.payload);
  return sendExpoPush(msgs, deps);
}

/**
 * Pure mapping from broadcast payload → push event + formatted payload.
 * Exported for tests.
 */
export function mapBroadcastToPush(data: BroadcastData): {
  event: PushEventType;
  payload: { title: string; body: string; data?: Record<string, unknown> };
} | null {
  if (!data || typeof data.type !== 'string') return null;

  switch (data.type) {
    case 'awaiting_input': {
      if (data.waiting !== true) return null;
      const sessionName = typeof data.sessionName === 'string' ? data.sessionName : undefined;
      const { title, body } = awaitingFeedbackPush({ sessionName });
      const sessionId = broadcastSessionId(data);
      return {
        event: 'awaiting_feedback',
        payload: {
          title,
          body,
          data: {
            sessionId,
            agentId: data.agentId,
            type: 'awaiting_feedback',
          },
        },
      };
    }

    case 'finalize_run_completed': {
      const status = typeof data.status === 'string' ? data.status : null;
      if (status !== 'ready_to_push' && status !== 'pushed') return null;
      const sessionId = broadcastSessionId(data);
      const sessionName = typeof data.sessionName === 'string' ? data.sessionName : undefined;
      if (status === 'ready_to_push') {
        const { title, body } = readyToPushPush({ sessionName });
        return {
          event: 'ready_to_push',
          payload: {
            title,
            body,
            data: {
              sessionId,
              agentId: data.agentId,
              runId: data.run_id,
              type: 'ready_to_push',
            },
          },
        };
      }
      const prNumber = typeof data.prNumber === 'number' ? data.prNumber : undefined;
      const { title, body } = pushedPush({ sessionName, prNumber });
      return {
        event: 'pushed',
        payload: {
          title,
          body,
          data: {
            sessionId,
            agentId: data.agentId,
            runId: data.run_id,
            prNumber,
            type: 'pushed',
          },
        },
      };
    }

    case 'support_ticket_created': {
      const ticket = (data as { ticket?: { subject?: string; type?: string } }).ticket;
      const { title, body } = supportTicketCreatedPush({
        subject: ticket?.subject,
        ticketType: ticket?.type,
      });
      return {
        event: 'support_ticket_created',
        payload: {
          title,
          body,
          data: {
            projectId: data.projectId,
            ticketId: ticket && 'id' in ticket ? (ticket as { id?: string }).id : undefined,
            type: 'support_ticket_created',
          },
        },
      };
    }

    case 'thread_entry_created': {
      const entry = (data as { entry?: { content?: string; id?: string } }).entry;
      const preview =
        typeof entry?.content === 'string' ? entry.content.replace(/\n+/g, ' ').trim() : undefined;
      const isError = typeof entry?.content === 'string' && entry.content.startsWith('ERROR:');
      const { title, body } = threadMessagePush({
        threadName: typeof data.threadName === 'string' ? data.threadName : 'Thread',
        threadType: typeof data.threadType === 'string' ? data.threadType : 'cron',
        preview,
        isError,
      });
      return {
        event: 'thread_message',
        payload: {
          title,
          body,
          data: {
            projectId: data.projectId,
            threadId: data.threadId,
            entryId: entry?.id,
            type: 'thread_message',
          },
        },
      };
    }

    case 'card_moved': {
      const col = typeof data.columnName === 'string' ? data.columnName.toLowerCase() : '';
      if (col !== 'review') return null;
      const cardTitle = typeof data.cardTitle === 'string' ? data.cardTitle : 'Card';
      const { title, body } = reviewAssignedPush({ cardTitle });
      return {
        event: 'review_assigned_to_you',
        payload: {
          title,
          body,
          data: {
            projectId: data.projectId,
            cardId: data.cardId,
            type: 'review_assigned_to_you',
          },
        },
      };
    }

    case 'native_pr_update': {
      if (data.action !== 'review_requested') return null;
      const prNumber = typeof data.prNumber === 'number' ? data.prNumber : undefined;
      const { title, body } = reviewAssignedPush({ prNumber });
      return {
        event: 'review_assigned_to_you',
        payload: {
          title,
          body,
          data: {
            projectId: data.projectId,
            prNumber,
            type: 'review_assigned_to_you',
          },
        },
      };
    }

    case 'webhook_pr_merged': {
      const { title, body } = prMergedPush({
        cardTitle: typeof data.cardTitle === 'string' ? data.cardTitle : 'PR',
        prNumber: typeof data.prNumber === 'number' ? data.prNumber : 0,
        mergedBy: typeof data.mergedBy === 'string' ? data.mergedBy : undefined,
      });
      return {
        event: 'pr_merged',
        payload: {
          title,
          body,
          data: {
            projectId: data.projectId,
            prNumber: data.prNumber,
            cardId: data.cardId,
            type: 'pr_merged',
          },
        },
      };
    }

    default:
      return null;
  }
}
