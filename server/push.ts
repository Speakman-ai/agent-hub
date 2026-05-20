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
import { canViewProject } from './project-visibility.js';
import { isLocalBundledServer } from './auth.js';

// ── Event types that can trigger a push ────────────────────────────────
export const PUSH_EVENT_TYPES = [
  'session_complete',
  'changes_ready',
  'pr_creation_stale',
  'card_started',
  'card_review',
  'pr_merged',
  'thread_created',
  'thread_entry',
  'dispatch_failure',
  'cron',
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
// Keep these aligned with client/src/utils/ticketNotifications.js so
// desktop and mobile banners use the same wording.

export function sessionCompletePush(args: {
  agentName?: string;
  sessionName?: string;
  preview?: string;
}): { title: string; body: string } {
  const agent = args.agentName || 'Agent';
  const title = `${agent} — Done`;
  const parts: string[] = [];
  if (args.sessionName) parts.push(`"${args.sessionName}"`);
  if (args.preview) {
    const trimmed = args.preview.length > 120 ? '…' + args.preview.slice(-120) : args.preview;
    parts.push(trimmed);
  }
  return { title, body: parts.join(' — ') || 'Session completed' };
}

export function changesReadyPush(args: {
  agentName?: string;
  sessionName?: string;
  branch?: string;
}): { title: string; body: string } {
  const parts: string[] = [];
  if (args.agentName) parts.push(args.agentName);
  if (args.sessionName) parts.push(`"${args.sessionName}"`);
  const who = parts.join(' — ');
  const where = args.branch ? ` on \`${args.branch}\`` : '';
  const body = who
    ? `${who} has changes${where} awaiting PR creation`
    : `An agent has changes${where} awaiting PR creation`;
  return { title: 'Changes Ready — Create PR?', body };
}

/**
 * Formatter for `pr_creation_stale` — emitted by the periodic
 * `runStalePrCheck` when a session has had `changes_ready` metadata for
 * longer than the stale threshold (default 30 min) without the user having
 * created a PR. Separate from `changes_ready` so push-preference filters
 * can opt out of the reminder independently from the initial "changes ready"
 * push.
 */
export function prCreationStalePush(args: {
  agentName?: string;
  sessionName?: string;
  branch?: string;
  ageMinutes?: number;
}): { title: string; body: string } {
  const parts: string[] = [];
  if (args.sessionName) parts.push(`"${args.sessionName}"`);
  else if (args.agentName) parts.push(args.agentName);
  const where = args.branch ? ` on \`${args.branch}\`` : '';
  const age =
    typeof args.ageMinutes === 'number' && Number.isFinite(args.ageMinutes) && args.ageMinutes > 0
      ? ` for ${Math.round(args.ageMinutes)} min`
      : '';
  const subject = parts.join(' — ') || 'A session';
  return {
    title: 'Still waiting — Create PR?',
    body: `${subject}${where} has had changes awaiting PR${age}`,
  };
}

export function cardStartedPush(args: { cardTitle: string; assignee?: string }): {
  title: string;
  body: string;
} {
  return {
    title: 'Ticket Started',
    body: `"${args.cardTitle}" started${args.assignee ? ` by ${args.assignee}` : ''}`,
  };
}

export function cardReviewPush(args: { cardTitle: string; assignee?: string }): {
  title: string;
  body: string;
} {
  return {
    title: 'PR Ready for Review',
    body: `"${args.cardTitle}" moved to Review${args.assignee ? ` (${args.assignee})` : ''}`,
  };
}

export function prMergedPush(args: { cardTitle: string; prNumber: number; mergedBy?: string }): {
  title: string;
  body: string;
} {
  return {
    title: 'PR Merged',
    body: `PR #${args.prNumber} merged${args.mergedBy ? ` by ${args.mergedBy}` : ''}: "${args.cardTitle}"`,
  };
}

export function threadCreatedPush(args: { threadName: string; threadType: string }): {
  title: string;
  body: string;
} {
  const label = args.threadType === 'heartbeat' ? 'Heartbeat' : 'Cron';
  return { title: 'Thread Created', body: `New ${label} thread: "${args.threadName}"` };
}

export function threadEntryPush(args: {
  threadName: string;
  threadType: string;
  preview?: string;
  isError?: boolean;
}): { title: string; body: string } {
  const label = args.threadType === 'heartbeat' ? 'Heartbeat' : 'Cron';
  const title = args.isError ? `${label} Error` : `${label} Update`;
  const trimmed =
    args.preview && args.preview.length > 120 ? args.preview.slice(0, 120) + '…' : args.preview;
  const body = trimmed ? `${args.threadName}: ${trimmed}` : `New entry in "${args.threadName}"`;
  return { title, body };
}

export function dispatchFailurePush(args: { message: string }): {
  title: string;
  body: string;
} {
  const trimmed = args.message.length > 160 ? args.message.slice(0, 160) + '…' : args.message;
  return { title: 'Dispatch Failure', body: trimmed || 'An autonomous dispatch failed' };
}

export function cronCompletePush(args: { cronName: string; result: string }): {
  title: string;
  body: string;
} {
  const body = args.result.length > 200 ? args.result.slice(0, 200) + '...' : args.result;
  return { title: `Cron: ${args.cronName}`, body };
}

// ── Preference filtering ────────────────────────────────────────────────

/**
 * Parse the `enabled_events` column value into a set.
 *
 * - `null`/`undefined`/empty → undefined (= all events enabled, legacy default)
 * - invalid JSON → undefined (treat as legacy default rather than silently
 *   dropping)
 * - array of strings → a Set
 * - anything else → undefined
 */
export function parseEnabledEvents(raw: string | null | undefined): Set<string> | undefined {
  if (raw == null || raw === '') return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const filtered = parsed.filter((x): x is string => typeof x === 'string');
      return new Set(filtered);
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
  if (!project.ownerUserId) return tokens;
  const localBypass = isLocalBundledServer();
  return tokens.filter((t) => canViewProject(project, { userId: t.user_id ?? null, localBypass }));
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
  const tokens = filterTokensForBroadcastVisibility(d.getAllTokens(), visibilityEvent, d).filter(
    (t) => tokenAcceptsEvent(t, eventType),
  );
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
  const tokens = filterTokensForBroadcastVisibility(d.getAllTokens(), data, d).filter((t) =>
    tokenAcceptsEvent(t, mapped.event),
  );
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
    case 'done': {
      // Session complete. Enrich via data properties populated by chat.ts.
      const sessionName = typeof data.sessionName === 'string' ? data.sessionName : undefined;
      const agentName = typeof data.agentName === 'string' ? data.agentName : undefined;
      const msg = (data as { message?: { content?: string } }).message;
      const previewRaw = typeof msg?.content === 'string' ? msg.content : undefined;
      const preview = previewRaw ? previewRaw.replace(/\n+/g, ' ').trim() : undefined;
      const { title, body } = sessionCompletePush({ agentName, sessionName, preview });
      return {
        event: 'session_complete',
        payload: {
          title,
          body,
          data: {
            sessionId: data.sessionId,
            agentId: data.agentId,
            type: 'session_complete',
          },
        },
      };
    }

    case 'changes_ready': {
      const { title, body } = changesReadyPush({
        agentName: typeof data.agentName === 'string' ? data.agentName : undefined,
        sessionName: typeof data.sessionName === 'string' ? data.sessionName : undefined,
        branch: typeof data.branch === 'string' ? data.branch : undefined,
      });
      return {
        event: 'changes_ready',
        payload: {
          title,
          body,
          data: {
            sessionId: data.sessionId,
            agentId: data.agentId,
            branch: data.branch,
            type: 'changes_ready',
          },
        },
      };
    }

    case 'card_moved': {
      const col = typeof data.columnName === 'string' ? data.columnName.toLowerCase() : '';
      const cardTitle = typeof data.cardTitle === 'string' ? data.cardTitle : 'Card';
      const assignee = typeof data.assignee === 'string' ? data.assignee : undefined;
      if (col === 'in progress') {
        const { title, body } = cardStartedPush({ cardTitle, assignee });
        return {
          event: 'card_started',
          payload: {
            title,
            body,
            data: { cardId: data.cardId, type: 'card_started' },
          },
        };
      }
      if (col === 'review') {
        const { title, body } = cardReviewPush({ cardTitle, assignee });
        return {
          event: 'card_review',
          payload: {
            title,
            body,
            data: { cardId: data.cardId, type: 'card_review' },
          },
        };
      }
      return null;
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
            prNumber: data.prNumber,
            cardId: data.cardId,
            type: 'pr_merged',
          },
        },
      };
    }

    case 'thread_created': {
      const thread = (data as { thread?: { name?: string; type?: string; id?: string } }).thread;
      if (!thread) return null;
      const { title, body } = threadCreatedPush({
        threadName: thread.name || 'Thread',
        threadType: thread.type || 'cron',
      });
      return {
        event: 'thread_created',
        payload: {
          title,
          body,
          data: {
            projectId: data.projectId,
            threadId: thread.id,
            type: 'thread_created',
          },
        },
      };
    }

    case 'thread_entry_created': {
      const entry = (data as { entry?: { content?: string; id?: string } }).entry;
      const preview =
        typeof entry?.content === 'string' ? entry.content.replace(/\n+/g, ' ').trim() : undefined;
      const isError = typeof entry?.content === 'string' && entry.content.startsWith('ERROR:');
      const { title, body } = threadEntryPush({
        threadName: typeof data.threadName === 'string' ? data.threadName : 'Thread',
        threadType: typeof data.threadType === 'string' ? data.threadType : 'cron',
        preview,
        isError,
      });
      return {
        event: 'thread_entry',
        payload: {
          title,
          body,
          data: {
            projectId: data.projectId,
            threadId: data.threadId,
            entryId: entry?.id,
            type: 'thread_entry',
          },
        },
      };
    }

    case 'dispatch_failure': {
      const message =
        typeof data.message === 'string'
          ? data.message
          : typeof data.error === 'string'
            ? data.error
            : 'An autonomous dispatch failed';
      const { title, body } = dispatchFailurePush({ message });
      return {
        event: 'dispatch_failure',
        payload: {
          title,
          body,
          data: {
            cardId: data.cardId,
            type: 'dispatch_failure',
          },
        },
      };
    }

    default:
      return null;
  }
}
