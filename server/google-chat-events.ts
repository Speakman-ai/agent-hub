/**
 * Google Chat push via the Google Workspace Events API.
 *
 * Each Hub user with Chat read access gets one subscription, created with the
 * user's own OAuth token, on `//chat.googleapis.com/spaces/-` (every space the
 * user is a member of; user auth only). Google publishes message events to the
 * Hub's Pub/Sub topic, and a push subscription delivers them to
 * `POST /api/google/chat/events/push` with an OIDC token. The event's
 * `ce-source` is the Workspace subscription, which maps it to the Hub user;
 * the event is then recorded as unread and sent to that user's WebSocket
 * clients only.
 *
 * Payloads include the message resource, which caps a subscription at 4 hours
 * (https://developers.google.com/workspace/events/reference/rest/v1/subscriptions).
 * A maintenance loop renews (PATCH ttl=0s, i.e. the maximum) well before that,
 * recreates expired ones, and reactivates suspended ones. Google sends
 * expirationReminder lifecycle events too, but recommends not relying on them,
 * so they only trigger an early renewal.
 */
import { google, type workspaceevents_v1 } from 'googleapis';
import type { AppConfig, BroadcastFn } from './types.js';
import { getDb } from './db.js';
import { getActiveAccessToken, getGoogleConnectionStatus } from './google-connections-store.js';
import { hasChatMessagesReadScope } from './google-scopes.js';
import {
  clearChatEventState,
  currentChatSeq,
  getChatSubscription,
  getChatSubscriptionByName,
  getSpaceUnread,
  listChatSubscriptions,
  recordUnreadMessage,
  bufferUnroutedEvent,
  pruneDeletedMessageMarkers,
  pruneUnroutedEvents,
  pruneRetiredOwners,
  getSubscriptionOwner,
  deleteUnroutedEvent,
  listUnroutedEvents,
  recordDeletedMessage,
  upsertChatSubscription,
  type ChatEventSubscription,
  type ChatSubscriptionState,
  type SpaceUnread,
} from './google-chat-events-store.js';
import { isRfc3339 } from '../shared/utils/rfc3339.js';

export const CHAT_ALL_SPACES_TARGET = '//chat.googleapis.com/spaces/-';
export const CHAT_MESSAGE_CREATED = 'google.workspace.chat.message.v1.created';
export const CHAT_MESSAGE_BATCH_CREATED = 'google.workspace.chat.message.v1.batchCreated';
export const CHAT_MESSAGE_UPDATED = 'google.workspace.chat.message.v1.updated';
export const CHAT_MESSAGE_BATCH_UPDATED = 'google.workspace.chat.message.v1.batchUpdated';
export const CHAT_MESSAGE_DELETED = 'google.workspace.chat.message.v1.deleted';
export const CHAT_MESSAGE_BATCH_DELETED = 'google.workspace.chat.message.v1.batchDeleted';
/**
 * Everything that changes what the pane shows, so push can stand in for
 * polling: new messages, edits, and deletions. Batch variants arrive under
 * the same subscription.
 */
export const CHAT_MESSAGE_EVENT_TYPES = [
  CHAT_MESSAGE_CREATED,
  CHAT_MESSAGE_UPDATED,
  CHAT_MESSAGE_DELETED,
];

type MessageEventKind = 'created' | 'updated' | 'deleted';

const MESSAGE_EVENT_KINDS: Record<string, { kind: MessageEventKind; batch: boolean }> = {
  [CHAT_MESSAGE_CREATED]: { kind: 'created', batch: false },
  [CHAT_MESSAGE_BATCH_CREATED]: { kind: 'created', batch: true },
  [CHAT_MESSAGE_UPDATED]: { kind: 'updated', batch: false },
  [CHAT_MESSAGE_BATCH_UPDATED]: { kind: 'updated', batch: true },
  [CHAT_MESSAGE_DELETED]: { kind: 'deleted', batch: false },
  [CHAT_MESSAGE_BATCH_DELETED]: { kind: 'deleted', batch: true },
};
export const SUBSCRIPTION_EXPIRATION_REMINDER =
  'google.workspace.events.subscription.v1.expirationReminder';
export const SUBSCRIPTION_SUSPENDED = 'google.workspace.events.subscription.v1.suspended';
export const SUBSCRIPTION_EXPIRED = 'google.workspace.events.subscription.v1.expired';

/** Renew once less than this is left (subscriptions with resource data live 4h). */
export const RENEW_WINDOW_MS = 90 * 60 * 1000;
export const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;
/** Backoff while polling an unfinished operation (about 15s in total). */
const OPERATION_POLL_DELAYS_MS = [250, 500, 1000, 2000, 3000, 4000, 4000];
/**
 * How long a deletion marker outlives the delete: Pub/Sub keeps unacked
 * messages up to 7 days, so a created event can't be redelivered later.
 */
const DELETED_MARKER_TTL_MS = 8 * 24 * 60 * 60 * 1000;
/** How long a delivery for an unregistered subscription is held for replay. */
const UNROUTED_EVENT_TTL_MS = 60 * 60 * 1000;
/** Retry a suspended subscription at most this often. */
const SUSPENDED_RETRY_MS = 60 * 60 * 1000;

const SUBSCRIPTION_NAME_RE = /^subscriptions\/[A-Za-z0-9_-]{1,256}$/;
const MESSAGE_NAME_RE = /^(spaces\/[A-Za-z0-9_-]{1,128})\/messages\/[A-Za-z0-9_.-]{1,256}$/;
const THREAD_NAME_RE = /^spaces\/[A-Za-z0-9_-]{1,128}\/threads\/[A-Za-z0-9_.-]{1,256}$/;

/** WebSocket event types; delivered only to `ownerUserId` (see broadcast-filter.ts). */
export const GOOGLE_CHAT_MESSAGE_EVENT = 'google_chat_message';
export const GOOGLE_CHAT_UNREAD_EVENT = 'google_chat_unread';
export const GOOGLE_CHAT_EVENTS_STATUS_EVENT = 'google_chat_events_status';

export class ChatEventsNotConfiguredError extends Error {
  readonly code = 'google_chat_push_not_configured';
  constructor() {
    super('Google Chat push is not configured on this server');
  }
}

export class ChatEventsAccessLostError extends Error {
  readonly code = 'google_chat_scope_required';
  constructor() {
    super('Chat read access is no longer granted');
  }
}

export class ChatEventsTokenError extends Error {
  readonly code = 'google_reconnect_required';
  constructor() {
    super('Google account must be reconnected');
  }
}

export interface ChatEventsDeps {
  config: Pick<AppConfig, 'googleOAuth' | 'googleChatEvents'>;
  broadcast: BroadcastFn;
  getAccessToken?: (userId: string) => Promise<string | null>;
  /** True while the user still has a Google connection with Chat read access. */
  hasChatAccess?: (userId: string) => boolean;
  eventsClient?: (accessToken: string) => workspaceevents_v1.Workspaceevents;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PublicChatSubscription {
  state: ChatSubscriptionState;
  expireTime: string | null;
  suspensionReason: string | null;
  lastError: string | null;
}

export function publicSubscription(
  sub: ChatEventSubscription | null,
): PublicChatSubscription | null {
  if (!sub) return null;
  return {
    state: sub.state,
    expireTime: sub.expireTime,
    suspensionReason: sub.suspensionReason,
    lastError: sub.lastError,
  };
}

function defaultEventsClient(accessToken: string): workspaceevents_v1.Workspaceevents {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.workspaceevents({ version: 'v1', auth });
}

function tokenFor(deps: ChatEventsDeps, userId: string): Promise<string | null> {
  return deps.getAccessToken
    ? deps.getAccessToken(userId)
    : getActiveAccessToken(userId, deps.config.googleOAuth ?? null);
}

function hasAccess(deps: ChatEventsDeps, userId: string): boolean {
  if (deps.hasChatAccess) return deps.hasChatAccess(userId);
  const status = getGoogleConnectionStatus(userId);
  return status.connected && hasChatMessagesReadScope(status.grantedScopes);
}

function httpStatus(err: unknown): number | null {
  const e = err as { response?: { status?: number }; code?: number | string; status?: number };
  const raw = e.response?.status ?? e.status ?? e.code;
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) ? n : null;
}

export function errorMessage(err: unknown): string {
  const e = err as {
    response?: { data?: { error?: { message?: string } | string } };
    message?: string;
  };
  const dataError = e.response?.data?.error;
  const msg =
    (typeof dataError === 'object' ? dataError?.message : dataError) || e.message || String(err);
  return String(msg).split('\n')[0].slice(0, 500);
}

function mapState(state: string | null | undefined): ChatSubscriptionState {
  if (state === 'ACTIVE') return 'ACTIVE';
  if (state === 'SUSPENDED') return 'SUSPENDED';
  return 'EXPIRED';
}

/**
 * Tell the user's clients a space's unread state changed outside a message
 * event (a read, or state cleared). Every unread mutation that isn't carried
 * by a google_chat_message event goes through here.
 */
export function emitUnread(
  deps: Pick<ChatEventsDeps, 'broadcast'>,
  userId: string,
  unread: SpaceUnread,
): void {
  deps.broadcast({ type: GOOGLE_CHAT_UNREAD_EVENT, ownerUserId: userId, ...unread });
}

function emitStatus(deps: ChatEventsDeps, sub: ChatEventSubscription | null, userId: string): void {
  deps.broadcast({
    type: GOOGLE_CHAT_EVENTS_STATUS_EVENT,
    ownerUserId: userId,
    subscription: publicSubscription(sub),
    // Orders this against HTTP reads of the same state (see db.ts).
    version: sub?.version ?? currentChatSeq(userId),
  });
}

function save(
  deps: ChatEventsDeps,
  userId: string,
  sub: workspaceevents_v1.Schema$Subscription,
  lastError: string | null = null,
): ChatEventSubscription {
  const before = getChatSubscription(userId);
  const saved = upsertChatSubscription({
    userId,
    subscriptionName: sub.name ?? null,
    authority: sub.authority ?? null,
    state: mapState(sub.state),
    expireTime: sub.expireTime ?? null,
    suspensionReason: sub.state === 'SUSPENDED' ? (sub.suspensionReason ?? null) : null,
    lastError,
  });
  if (
    !before ||
    before.state !== saved.state ||
    before.expireTime !== saved.expireTime ||
    before.lastError !== saved.lastError
  ) {
    emitStatus(deps, saved, userId);
  }
  if (saved.subscriptionName) replayUnrouted(deps, saved.subscriptionName);
  return saved;
}

function recordError(deps: ChatEventsDeps, userId: string, message: string): void {
  const before = getChatSubscription(userId);
  const saved = upsertChatSubscription({
    userId,
    subscriptionName: before?.subscriptionName ?? null,
    authority: before?.authority ?? null,
    // A failed call tells us nothing new about Google's side: keep the state
    // Google last reported (ACTIVE or SUSPENDED, with its real expiry).
    state: before?.state === 'ACTIVE' || before?.state === 'SUSPENDED' ? before.state : 'ERROR',
    expireTime: before?.expireTime ?? null,
    suspensionReason: before?.suspensionReason ?? null,
    lastError: message,
  });
  if (before?.lastError !== message || before?.state !== saved.state) {
    emitStatus(deps, saved, userId);
  }
}

/**
 * Wait for a Workspace Events long-running operation. Google usually returns
 * them completed, but nothing guarantees it, and reading the subscription
 * before the operation finishes records the pre-operation state.
 */
async function awaitOperation(
  deps: ChatEventsDeps,
  client: workspaceevents_v1.Workspaceevents,
  op: workspaceevents_v1.Schema$Operation,
): Promise<workspaceevents_v1.Schema$Operation> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let current = op;
  for (let attempt = 0; !current.done; attempt++) {
    if (!current.name) {
      throw new Error('Workspace Events returned an unfinished operation without a name');
    }
    if (attempt >= OPERATION_POLL_DELAYS_MS.length) {
      throw new Error(`Workspace Events operation ${current.name} is still running`);
    }
    await sleep(OPERATION_POLL_DELAYS_MS[attempt]);
    current = (await client.operations.get({ name: current.name })).data;
  }
  if (current.error) {
    throw new Error(current.error.message || 'Workspace Events operation failed');
  }
  return current;
}

/** The finished operation's Subscription, or a fresh read when it isn't inline. */
async function operationSubscription(
  deps: ChatEventsDeps,
  client: workspaceevents_v1.Workspaceevents,
  op: workspaceevents_v1.Schema$Operation,
  fallbackName: string | null,
): Promise<workspaceevents_v1.Schema$Subscription | null> {
  const done = await awaitOperation(deps, client, op);
  const response = done.response as workspaceevents_v1.Schema$Subscription | undefined;
  if (response?.name) return response;
  if (!fallbackName) return null;
  return (await client.subscriptions.get({ name: fallbackName })).data;
}

async function findExisting(
  client: workspaceevents_v1.Workspaceevents,
): Promise<workspaceevents_v1.Schema$Subscription | null> {
  const res = await client.subscriptions.list({
    filter: `event_types:"${CHAT_MESSAGE_CREATED}" AND target_resource="${CHAT_ALL_SPACES_TARGET}"`,
  });
  return res.data.subscriptions?.[0] ?? null;
}

/**
 * Delete a subscription and wait for Google to finish. Delete returns a
 * long-running operation like create, patch, and reactivate; creating the
 * replacement before it completes would hit ALREADY_EXISTS for the same
 * user and target.
 */
async function deleteSubscription(
  deps: ChatEventsDeps,
  client: workspaceevents_v1.Workspaceevents,
  name: string,
): Promise<void> {
  const op = await client.subscriptions.delete({ name, allowMissing: true });
  await awaitOperation(deps, client, op.data ?? { done: true });
}

async function renew(
  deps: ChatEventsDeps,
  client: workspaceevents_v1.Workspaceevents,
  name: string,
): Promise<workspaceevents_v1.Schema$Subscription | null> {
  const op = await client.subscriptions.patch({
    name,
    updateMask: 'ttl',
    requestBody: { ttl: '0s' },
  });
  return operationSubscription(deps, client, op.data, name);
}

async function reactivate(
  deps: ChatEventsDeps,
  client: workspaceevents_v1.Workspaceevents,
  name: string,
): Promise<workspaceevents_v1.Schema$Subscription | null> {
  const op = await client.subscriptions.reactivate({ name, requestBody: {} });
  return operationSubscription(deps, client, op.data, name);
}

function expiresWithin(sub: { expireTime?: string | null }, ms: number, now: number): boolean {
  if (!sub.expireTime) return true;
  const at = Date.parse(sub.expireTime);
  return !Number.isFinite(at) || at - now < ms;
}

/**
 * Bring a remote subscription to ACTIVE with time to spare: renew an active
 * one close to expiry, reactivate a suspended one. Anything else (deleted,
 * wrong topic) returns null so the caller creates a fresh one.
 */
async function settle(
  deps: ChatEventsDeps,
  client: workspaceevents_v1.Workspaceevents,
  sub: workspaceevents_v1.Schema$Subscription,
  topic: string,
  forceRenew = false,
): Promise<workspaceevents_v1.Schema$Subscription | null> {
  if (!sub.name) return null;
  if (sub.notificationEndpoint?.pubsubTopic && sub.notificationEndpoint.pubsubTopic !== topic) {
    // The topic is immutable. The Hub moved to another topic, so replace it.
    console.warn(
      `[google-chat-events] Replacing ${sub.name}: it publishes to ${sub.notificationEndpoint.pubsubTopic}`,
    );
    await deleteSubscription(deps, client, sub.name);
    return null;
  }
  const missing = CHAT_MESSAGE_EVENT_TYPES.filter((t) => !(sub.eventTypes ?? []).includes(t));
  if (sub.eventTypes && missing.length) {
    // Event types are fixed at creation; one missing edits or deletions would
    // leave the pane stale with polling off. Replace it.
    console.warn(`[google-chat-events] Replacing ${sub.name}: missing ${missing.join(', ')}`);
    await deleteSubscription(deps, client, sub.name);
    return null;
  }
  const now = (deps.now ?? Date.now)();
  if (sub.state === 'ACTIVE') {
    return forceRenew || expiresWithin(sub, RENEW_WINDOW_MS, now)
      ? ((await renew(deps, client, sub.name)) ?? sub)
      : sub;
  }
  if (sub.state === 'SUSPENDED') return (await reactivate(deps, client, sub.name)) ?? sub;
  return null;
}

async function create(
  deps: ChatEventsDeps,
  client: workspaceevents_v1.Workspaceevents,
  topic: string,
  replaced = false,
): Promise<workspaceevents_v1.Schema$Subscription | null> {
  try {
    const op = await client.subscriptions.create({
      requestBody: {
        targetResource: CHAT_ALL_SPACES_TARGET,
        eventTypes: CHAT_MESSAGE_EVENT_TYPES,
        notificationEndpoint: { pubsubTopic: topic },
        payloadOptions: { includeResource: true },
        ttl: '0s',
      },
    });
    const created = await operationSubscription(deps, client, op.data, null);
    return created ?? (await findExisting(client));
  } catch (err) {
    // One subscription per user and target: adopt the one Google already has.
    if (httpStatus(err) !== 409) throw err;
    const existing = await findExisting(client);
    if (!existing) throw err;
    const settled = await settle(deps, client, existing, topic);
    if (settled) return settled;
    // settle() deleted it (wrong topic or event types) and waited for the
    // delete to finish, so the create can go ahead. Once only: a second
    // conflict means something else keeps recreating it.
    if (replaced) throw err;
    return create(deps, client, topic, true);
  }
}

export interface EnsureOptions {
  /**
   * Read Google's state instead of trusting the stored row. `true` always
   * reads; `{ maxAgeMs }` reads unless Google was checked for this user that
   * recently. Without it, a fresh ACTIVE row is returned with no Google call.
   */
  verify?: boolean | { maxAgeMs: number };
  /** Renew even when expiry isn't near (an expiration reminder arrived). */
  forceRenew?: boolean;
}

// When Google's state was last read per user (process memory; a restart just
// means the next verify reads again).
const lastRemoteCheck = new Map<string, number>();

/** Forget verify timestamps (tests). */
export function resetChatSubscriptionChecks(): void {
  lastRemoteCheck.clear();
}

/**
 * Make sure `userId` has an active subscription with time to spare.
 *
 * The stored row is a record of what Google last reported (API answers and
 * lifecycle events) and nothing else: callers never edit it to steer this
 * function. They pass options instead. Every remote read is saved before
 * acting on it, so if reactivation or renewal then fails, the row still
 * shows what Google actually said (SUSPENDED, the real expiry).
 */
// One reconcile per user at a time. The route, the maintenance loop, and
// lifecycle hints can all ask at once; interleaved, an older Google read
// could be saved after a newer one.
const userLocks = new Map<string, Promise<unknown>>();

function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  userLocks.set(userId, tail);
  void tail.then(() => {
    if (userLocks.get(userId) === tail) userLocks.delete(userId);
  });
  return run;
}

export function ensureChatSubscription(
  userId: string,
  deps: ChatEventsDeps,
  opts: EnsureOptions = {},
): Promise<ChatEventSubscription> {
  return withUserLock(userId, () => ensureChatSubscriptionNow(userId, deps, opts));
}

async function ensureChatSubscriptionNow(
  userId: string,
  deps: ChatEventsDeps,
  opts: EnsureOptions,
): Promise<ChatEventSubscription> {
  const cfg = deps.config.googleChatEvents;
  if (!cfg) throw new ChatEventsNotConfiguredError();
  const now = (deps.now ?? Date.now)();
  const existing = getChatSubscription(userId);
  const verify =
    opts.verify === true ||
    (typeof opts.verify === 'object' &&
      now - (lastRemoteCheck.get(userId) ?? -Infinity) >= opts.verify.maxAgeMs);
  if (
    !verify &&
    !opts.forceRenew &&
    existing?.state === 'ACTIVE' &&
    existing.subscriptionName &&
    !expiresWithin(existing, RENEW_WINDOW_MS, now)
  ) {
    return existing;
  }

  // Access can be revoked while this waits on Google. Check before calling
  // Google and again before saving anything it returned, so a reconcile in
  // flight can't restore what access-loss cleanup removed.
  const requireAccess = () => {
    if (!hasAccess(deps, userId)) throw new ChatEventsAccessLostError();
  };
  requireAccess();
  const token = await tokenFor(deps, userId);
  if (!token) throw new ChatEventsTokenError();
  const client = (deps.eventsClient ?? defaultEventsClient)(token);

  try {
    let sub: workspaceevents_v1.Schema$Subscription | null = null;
    if (existing?.subscriptionName) {
      let current: workspaceevents_v1.Schema$Subscription | null = null;
      try {
        current = (await client.subscriptions.get({ name: existing.subscriptionName })).data;
      } catch (err) {
        if (httpStatus(err) !== 404) throw err;
      }
      lastRemoteCheck.set(userId, now);
      if (current?.name) {
        // Record what Google says before trying to change it.
        requireAccess();
        save(deps, userId, current);
        sub = await settle(deps, client, current, cfg.pubsubTopic, opts.forceRenew);
      }
    }
    if (!sub) sub = await create(deps, client, cfg.pubsubTopic);
    if (!sub?.name) throw new Error('Google did not return the Chat subscription');
    lastRemoteCheck.set(userId, now);
    requireAccess();
    return save(deps, userId, sub);
  } catch (err) {
    // Recording the error would recreate the row cleanup just removed.
    if (err instanceof ChatEventsAccessLostError) throw err;
    recordError(deps, userId, errorMessage(err));
    throw err;
  }
}

/** One pass of the maintenance loop. Exported for tests. */
export async function runChatSubscriptionMaintenance(deps: ChatEventsDeps): Promise<void> {
  if (!deps.config.googleChatEvents) return;
  const now = (deps.now ?? Date.now)();
  pruneDeletedMessageMarkers(new Date(now - DELETED_MARKER_TTL_MS).toISOString());
  pruneUnroutedEvents(new Date(now - UNROUTED_EVENT_TTL_MS).toISOString());
  pruneRetiredOwners(new Date(now - DELETED_MARKER_TTL_MS).toISOString());
  for (const sub of listChatSubscriptions()) {
    if (!hasAccess(deps, sub.userId)) {
      // Disconnected or read scope dropped: Google stops delivering once the
      // grant is gone, and unread counts for an unreadable account are noise.
      // Under the user's reconcile lock, so a check already waiting on Google
      // finishes (and sees access gone) before the state is cleared.
      await withUserLock(sub.userId, async () => {
        if (hasAccess(deps, sub.userId)) return;
        const cleared = clearChatEventState(sub.userId);
        for (const unread of cleared) emitUnread(deps, sub.userId, unread);
        emitStatus(deps, null, sub.userId);
      });
      continue;
    }
    // ERROR is ours (a timed-out operation, a transient failure) and retries
    // every tick; a suspension usually waits on the user, so it backs off.
    if (sub.state === 'SUSPENDED') {
      const updated = Date.parse(sub.updatedAt.endsWith('Z') ? sub.updatedAt : `${sub.updatedAt}Z`);
      if (Number.isFinite(updated) && now - updated < SUSPENDED_RETRY_MS) continue;
    }
    try {
      // Read Google's state every tick: a suspension whose lifecycle event
      // never reached the Hub is found here, not just at renewal time.
      await ensureChatSubscription(sub.userId, deps, { verify: true });
    } catch (err) {
      console.warn(
        `[google-chat-events] Could not renew the Chat subscription for user ${sub.userId}: ${errorMessage(err)}`,
      );
    }
  }
}

export function startChatSubscriptionMaintenance(deps: ChatEventsDeps): () => void {
  if (!deps.config.googleChatEvents) return () => {};
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    runChatSubscriptionMaintenance(deps)
      .catch((err) => console.warn(`[google-chat-events] Maintenance failed: ${errorMessage(err)}`))
      .finally(() => {
        running = false;
      });
  };
  const first = setTimeout(tick, 30_000);
  const timer = setInterval(tick, MAINTENANCE_INTERVAL_MS);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

export interface PubSubPushEnvelope {
  message?: {
    attributes?: Record<string, string>;
    data?: string;
    messageId?: string;
  };
  subscription?: string;
}

export interface PushResult {
  /** Why nothing happened, when nothing did. */
  ignored?: 'malformed' | 'unknown_subscription' | 'retired_subscription' | 'unsupported_event';
  userId?: string;
  /** Messages newly counted as unread. */
  recorded: string[];
  /** Background work (renewal) started by a lifecycle event. */
  followUp?: Promise<void>;
}

function decodeData(data: string | undefined): Record<string, unknown> | null {
  if (!data) return {};
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface EventMessage {
  name?: string;
  createTime?: string;
  sender?: { name?: string };
  thread?: { name?: string };
}

function eventMessages(batch: boolean, data: Record<string, unknown>): EventMessage[] {
  if (!batch) {
    const m = data.message as EventMessage | undefined;
    return m ? [m] : [];
  }
  const list = Array.isArray(data.messages)
    ? (data.messages as Array<{ message?: EventMessage }>)
    : [];
  return list.map((entry) => entry?.message).filter((m): m is EventMessage => !!m);
}

/**
 * Deliver anything that arrived for this subscription before it was
 * registered. Each held delivery is applied and removed in one transaction,
 * so a crash or database error leaves it held for the next attempt (the
 * maintenance loop saves every subscription each tick, which replays again)
 * instead of losing it. Broadcasts go out only after the commit.
 */
function replayUnrouted(deps: ChatEventsDeps, subscriptionName: string): void {
  const db = getDb();
  for (const { id, envelope } of listUnroutedEvents(subscriptionName)) {
    let parsed: PubSubPushEnvelope;
    try {
      parsed = JSON.parse(envelope) as PubSubPushEnvelope;
    } catch {
      deleteUnroutedEvent(id); // can never succeed
      continue;
    }
    const outbox: Array<Record<string, unknown>> = [];
    let result: PushResult;
    try {
      result = db.transaction(() => {
        const r = handleChatPushEvent(parsed, { ...deps, broadcast: (e) => outbox.push(e) });
        deleteUnroutedEvent(id);
        return r;
      })();
    } catch (err) {
      console.warn(
        `[google-chat-events] Replaying held delivery ${id} failed; kept for retry: ${errorMessage(err)}`,
      );
      continue;
    }
    for (const event of outbox) deps.broadcast(event);
    void result.followUp;
  }
}

/**
 * Handle one Pub/Sub push delivery. The caller has already verified the
 * push token. Unknown subscriptions and malformed payloads are acknowledged
 * and dropped: retrying them can never succeed.
 */
export function handleChatPushEvent(
  envelope: PubSubPushEnvelope,
  deps: ChatEventsDeps,
): PushResult {
  const attrs = envelope.message?.attributes ?? {};
  const type = attrs['ce-type'];
  const source = attrs['ce-source'];
  if (!type || !source) return { ignored: 'malformed', recorded: [] };
  const subscriptionName = source.replace(/^\/\/workspaceevents\.googleapis\.com\//, '');
  if (!SUBSCRIPTION_NAME_RE.test(subscriptionName)) return { ignored: 'malformed', recorded: [] };
  const sub = getChatSubscriptionByName(subscriptionName);
  const messageEvent = MESSAGE_EVENT_KINDS[type];
  // Route by ownership. The current subscription handles everything. A
  // retired one (expired or replaced) still owns message events Pub/Sub
  // delivers late, but its lifecycle events say nothing about the current
  // subscription and are dropped.
  const owner = sub
    ? { userId: sub.userId, authority: sub.authority }
    : getSubscriptionOwner(subscriptionName);
  if (!owner) {
    // Not registered yet, most likely because its create is still finishing.
    // Hold it; save() replays it once the name is stored.
    bufferUnroutedEvent(subscriptionName, JSON.stringify(envelope));
    return { ignored: 'unknown_subscription', recorded: [] };
  }
  const userId = owner.userId;
  const data = decodeData(envelope.message?.data);
  if (!data) return { ignored: 'malformed', userId, recorded: [] };

  if (messageEvent) {
    const { kind } = messageEvent;
    const recorded: string[] = [];
    for (const message of eventMessages(messageEvent.batch, data)) {
      const match = message.name ? MESSAGE_NAME_RE.exec(message.name) : null;
      if (!match) continue;
      const messageName = message.name as string;
      const spaceName = match[1];
      const createTime =
        message.createTime && isRfc3339(message.createTime)
          ? message.createTime
          : kind === 'created' && attrs['ce-time'] && isRfc3339(attrs['ce-time'])
            ? attrs['ce-time']
            : null;
      const own = !!owner.authority && message.sender?.name === owner.authority;
      if (kind === 'created') {
        if (!createTime) continue;
        if (!own && recordUnreadMessage({ userId, spaceName, messageName, createTime })) {
          recorded.push(messageName);
        }
      } else if (kind === 'deleted') {
        recordDeletedMessage({ userId, spaceName, messageName });
      }
      const unread = getSpaceUnread(userId, spaceName);
      const threadName =
        message.thread?.name && THREAD_NAME_RE.test(message.thread.name)
          ? message.thread.name
          : null;
      // Names and counts only: the pane re-reads the space through the
      // proxy, so message text never rides the broadcast.
      deps.broadcast({
        type: GOOGLE_CHAT_MESSAGE_EVENT,
        ownerUserId: userId,
        kind,
        spaceName,
        messageName,
        threadName,
        createTime,
        own,
        unread,
      });
    }
    return { userId, recorded };
  }

  // Lifecycle events below concern the current subscription only.
  if (!sub) return { ignored: 'retired_subscription', userId, recorded: [] };

  // Lifecycle notifications are hints, never state. Pub/Sub delivers them
  // unordered and at least once, so a suspension can arrive after the
  // subscription was already reactivated, or an expiry after it was renewed.
  // Each one only triggers a reconcile that reads Google's current state;
  // the row records what Google says, whatever the notification claimed.
  if (type === SUBSCRIPTION_EXPIRATION_REMINDER) {
    return { userId, recorded: [], followUp: reconcileNow(userId, deps, { forceRenew: true }) };
  }
  if (type === SUBSCRIPTION_SUSPENDED || type === SUBSCRIPTION_EXPIRED) {
    return { userId, recorded: [], followUp: reconcileNow(userId, deps) };
  }

  return { ignored: 'unsupported_event', userId, recorded: [] };
}

/** Reconcile with Google after a lifecycle hint. Failures wait for the next maintenance tick. */
async function reconcileNow(
  userId: string,
  deps: ChatEventsDeps,
  opts: EnsureOptions = {},
): Promise<void> {
  try {
    await ensureChatSubscription(userId, deps, { verify: true, ...opts });
  } catch (err) {
    console.warn(
      `[google-chat-events] Reconcile after a lifecycle event failed for user ${userId}: ${errorMessage(err)}`,
    );
  }
}

export type PushTokenVerifier = (
  idToken: string,
  audience: string,
) => Promise<{ email?: string; email_verified?: boolean } | undefined>;

let defaultVerifierClient: InstanceType<typeof google.auth.OAuth2> | null = null;

const defaultVerifier: PushTokenVerifier = async (idToken, audience) => {
  // One client so Google's signing certs stay cached between pushes.
  defaultVerifierClient ??= new google.auth.OAuth2();
  const ticket = await defaultVerifierClient.verifyIdToken({ idToken, audience });
  return ticket.getPayload();
};

/**
 * Verify the OIDC token Pub/Sub attaches to an authenticated push: signed by
 * Google, issued for our audience, and minted for the configured service
 * account. https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions
 */
export async function verifyPushToken(
  authorization: string | undefined,
  cfg: { pushAudience: string; pushServiceAccountEmail: string },
  verifier: PushTokenVerifier = defaultVerifier,
): Promise<boolean> {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (!match) return false;
  try {
    const payload = await verifier(match[1], cfg.pushAudience);
    return (
      !!payload &&
      payload.email_verified === true &&
      typeof payload.email === 'string' &&
      payload.email.toLowerCase() === cfg.pushServiceAccountEmail.toLowerCase()
    );
  } catch {
    return false;
  }
}
