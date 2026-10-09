import { compareRfc3339 } from '@shared/utils/rfc3339';
import { chatSenderLabel, chatSpaceLabel, type ChatMessage, type ChatSpace } from './googleChat';
import { spaceIdFromName } from './googleChatPush';

/**
 * New-message notifications for the signed-in user's Google Chat.
 *
 * Scope. Every read goes through the Hub's Chat proxy, which answers with the
 * caller's own Google connection, so polled data is always the signed-in
 * user's. Push events are already delivered only to their owner
 * (broadcast-filter.ts); the notifier still drops any event stamped for a
 * different Hub user, or with no owner at all, so a filter regression can't
 * leak another account's chat into this tab. Messages the user sent
 * themselves never notify.
 *
 * Sources. With push active, `google_chat_message` events name the new
 * message and the notifier reads it back for the sender and text. Without
 * push, `poll()` lists the user's spaces and reads messages newer than the
 * last activity it saw in each space. The first poll only records where
 * every space stands, so opening the Hub never replays history. Both paths
 * share one record per space (see SpaceState), so a message is announced at
 * most once.
 */

export interface ChatNotification {
  spaceId: string;
  spaceLabel: string;
  messageName: string;
  sender: string;
  text: string;
  /** How many new messages this notice stands for (>1 = collapsed). */
  count: number;
}

export interface ChatNotifierApi {
  listGoogleChatSpaces: (opts?: { pageSize?: number; pageToken?: string }) => Promise<any>;
  listGoogleChatMessages: (
    spaceId: string,
    opts?: { pageSize?: number; pageToken?: string; order?: 'asc' | 'desc'; since?: string },
  ) => Promise<any>;
}

export interface ChatNotifierDeps {
  api: ChatNotifierApi;
  /** The signed-in Hub user's id; null in single-user local mode. */
  getMyUserId: () => string | null;
  /** True while the user is looking at this space, so a notice would be noise. */
  isViewingSpace?: (spaceId: string) => boolean;
  onNotify: (notice: ChatNotification) => void;
  now?: () => number;
}

/** Spaces whose messages are read in one poll; the rest wait for the next. */
export const MAX_SPACES_PER_POLL = 5;
const MESSAGE_PAGE = 50;
/** Message pages read per space per poll; a longer range continues next poll. */
const MAX_MESSAGE_PAGES = 4;
// Same paging as the Chat pane's space list.
const SPACE_PAGE = 1000;
const MAX_SPACE_PAGES = 20;
const PREVIEW_CHARS = 140;

export function previewText(message: Pick<ChatMessage, 'text' | 'attachmentCount'>): string {
  const text = (message.text || '').replace(/\s+/g, ' ').trim();
  if (text) return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
  return message.attachmentCount > 0 ? 'Sent an attachment' : 'New message';
}

/**
 * Whether a push event may notify this client: it must name its owner, and
 * that owner must be the signed-in user. Without a local user id (single-user
 * local mode) the server's per-owner delivery is the only gate.
 */
export function isChatEventForMe(event: any, myUserId: string | null): boolean {
  const owner = typeof event?.ownerUserId === 'string' ? event.ownerUserId : null;
  if (!owner) return false;
  return !myUserId || owner === myUserId;
}

export interface ChatNotifier {
  poll: () => Promise<void>;
  handleEvent: (event: any) => Promise<void>;
  /** Stop for good: requests still in flight never notify. */
  dispose: () => void;
  /** Spaces known so far, for labels (tests). */
  knownSpaces: () => Map<string, ChatSpace>;
}

export function createChatNotifier(deps: ChatNotifierDeps): ChatNotifier {
  const now = deps.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const spaces = new Map<string, ChatSpace>();
  /**
   * Everything the notifier knows about a space, in one record.
   *
   * Position. `cursor` is closed: every message created at or before it was
   * handled by a poll (announced, or history when it was first set). Reading
   * past it is one fixed query, `since: cursor`, paged with Google's
   * nextPageToken. When a poll stops before the last page, `resume` keeps
   * that token and the next poll continues the same query from it, so a range
   * always moves forward no matter how its timestamps are distributed. Only
   * when Google reports no further page does the cursor move, to the newest
   * time the range covered.
   *
   * Dedup. Messages past the cursor that were already announced (by push, or
   * by a poll partway through its range) are in `announced` and leave it when
   * the cursor passes them. Nothing at or before the cursor is announced.
   */
  type SpaceState = {
    cursor: string;
    /** Continuation of the `since: cursor` query a poll has not finished. */
    resume: string | null;
    /** Newest createTime read so far in the unfinished range. */
    rangeNewest: string | null;
    announced: Map<string, string>; // message name -> createTime, all after cursor
    /** Poll attempt order: the least recently attempted changed spaces go first. */
    lastAttempt: number;
  };
  const state = new Map<string, SpaceState>();
  let attemptSeq = 0;
  let primed = false;
  let selfUserName: string | null = null;
  let polling: Promise<void> | null = null;
  let disposed = false;

  const stateFor = (spaceId: string, cursor: string): SpaceState => {
    let st = state.get(spaceId);
    if (!st) {
      st = { cursor, resume: null, rangeNewest: null, announced: new Map(), lastAttempt: 0 };
      state.set(spaceId, st);
    }
    return st;
  };

  /** A space's cursor, or the start time for one never listed. */
  const cursorOf = (spaceId: string): string => state.get(spaceId)?.cursor ?? startedAt;

  const isAfter = (time: string | null | undefined, cursor: string) =>
    !!time && compareRfc3339(time, cursor) > 0;

  /** The range is finished: close the cursor at the newest time it covered. */
  const closeRange = (st: SpaceState, lastActiveTime: string | null) => {
    for (const t of [st.rangeNewest, lastActiveTime]) {
      if (t && isAfter(t, st.cursor)) st.cursor = t;
    }
    st.resume = null;
    st.rangeNewest = null;
    for (const [name, at] of st.announced) {
      if (!isAfter(at, st.cursor)) st.announced.delete(name);
    }
  };

  /** Every page of the user's spaces. Throws if any page fails, so a partial list never primes. */
  const listSpaces = async (): Promise<ChatSpace[]> => {
    const list: ChatSpace[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_SPACE_PAGES; page++) {
      const body = await deps.api.listGoogleChatSpaces({ pageSize: SPACE_PAGE, pageToken });
      if (Array.isArray(body?.spaces))
        list.push(...body.spaces.filter((s: ChatSpace) => s && s.id));
      pageToken = body?.nextPageToken || undefined;
      if (!pageToken) break;
    }
    for (const s of list) spaces.set(s.id as string, s);
    return list;
  };

  const isFromOthers = (m: ChatMessage) => {
    if (m.deleted || !m.name) return false;
    const sender = m.sender?.name ?? null;
    return !(selfUserName && sender === selfUserName);
  };

  /**
   * Continue the space's range read for up to MAX_MESSAGE_PAGES pages, then
   * announce what it read as one notice. Returns true only when Google
   * reported no further page; page sizes say nothing about that. If a page
   * fails, nothing read in this call was announced, and the caller restarts
   * the range, so those messages are read again.
   */
  const readRange = async (spaceId: string, st: SpaceState): Promise<boolean> => {
    const read: ChatMessage[] = [];
    let complete = false;
    for (let page = 0; page < MAX_MESSAGE_PAGES && !complete; page++) {
      const body = await deps.api.listGoogleChatMessages(spaceId, {
        since: st.cursor,
        order: 'asc',
        pageSize: MESSAGE_PAGE,
        pageToken: st.resume ?? undefined,
      });
      if (disposed) return false;
      if (typeof body?.selfUserName === 'string') selfUserName = body.selfUserName;
      const messages: ChatMessage[] = Array.isArray(body?.messages)
        ? body.messages.filter((m: ChatMessage) => m && isAfter(m.createTime, st.cursor))
        : [];
      read.push(...messages);
      for (const m of messages) {
        if (!st.rangeNewest || isAfter(m.createTime, st.rangeNewest)) {
          st.rangeNewest = m.createTime;
        }
      }
      st.resume = body?.nextPageToken || null;
      complete = !st.resume;
    }
    announce(spaceId, st, read);
    return complete;
  };

  /**
   * Announce the messages from others that the invariant says are new, as one
   * notice per space. Called synchronously after a read's await, so the
   * cursor and `announced` it checks are current.
   */
  const announce = (spaceId: string, st: SpaceState, messages: ChatMessage[]): void => {
    const fresh = messages.filter(
      (m) =>
        isFromOthers(m) && isAfter(m.createTime, st.cursor) && !st.announced.has(m.name as string),
    );
    for (const m of fresh) st.announced.set(m.name as string, m.createTime as string);
    if (disposed || !fresh.length || deps.isViewingSpace?.(spaceId)) return;
    const latest = fresh[fresh.length - 1];
    const space = spaces.get(spaceId);
    deps.onNotify({
      spaceId,
      spaceLabel: space ? chatSpaceLabel(space) : 'Google Chat',
      messageName: latest.name as string,
      sender: chatSenderLabel(latest.sender),
      text: previewText(latest),
      count: fresh.length,
    });
  };

  const runPoll = async () => {
    const list = await listSpaces();
    if (disposed) return;
    if (!primed) {
      for (const s of list) stateFor(s.id as string, s.lastActiveTime ?? startedAt);
      primed = true;
      return;
    }
    const changed = list
      .map((s) => ({ s, st: stateFor(s.id as string, startedAt) }))
      // An unfinished range has more waiting even if lastActiveTime has not moved.
      .filter(({ s, st }) => !!st.resume || isAfter(s.lastActiveTime, st.cursor))
      // Least recently attempted first, so busy or failing spaces can't keep
      // the others from ever being read.
      .sort((a, b) => a.st.lastAttempt - b.st.lastAttempt);
    for (const { s, st } of changed.slice(0, MAX_SPACES_PER_POLL)) {
      if (disposed) return;
      const id = s.id as string;
      st.lastAttempt = ++attemptSeq;
      try {
        if (await readRange(id, st)) closeRange(st, s.lastActiveTime);
      } catch {
        // Restart the range from the cursor: the stored token may have
        // expired, and this call's pages were not announced. Messages
        // announced earlier in the range are in `announced`, so none repeat.
        st.resume = null;
      }
    }
  };

  const poll = () => {
    polling ??= runPoll()
      .catch(() => {
        /* not connected, offline, or scope missing: try again next tick */
      })
      .finally(() => {
        polling = null;
      });
    return polling;
  };

  const handleEvent = async (event: any) => {
    if (!event || event.type !== 'google_chat_message' || event.kind !== 'created') return;
    if (event.own) return;
    if (!isChatEventForMe(event, deps.getMyUserId())) return;
    const messageName = typeof event.messageName === 'string' ? event.messageName : null;
    const spaceId = spaceIdFromName(event.spaceName);
    const createTime = typeof event.createTime === 'string' ? event.createTime : null;
    if (!messageName || !spaceId || !createTime) return;
    // At or before the cursor: history, or a poll already handled it.
    if (!isAfter(createTime, cursorOf(spaceId))) return;
    if (state.get(spaceId)?.announced.has(messageName)) return;
    try {
      if (!spaces.has(spaceId)) await listSpaces().catch(() => []);
      // One page from the message's own time: it is the first or among the
      // first. If it is not found, the next poll's range read still covers it.
      const body = await deps.api.listGoogleChatMessages(spaceId, {
        since: createTime,
        order: 'asc',
        pageSize: MESSAGE_PAGE,
      });
      if (disposed) return;
      if (typeof body?.selfUserName === 'string') selfUserName = body.selfUserName;
      const messages: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : [];
      const match = messages.find((m) => m?.name === messageName);
      if (!match) return;
      // The cursor stays put: the poll's range read still reaches earlier
      // messages whose events never arrived, and skips this one via
      // `announced`.
      announce(spaceId, stateFor(spaceId, startedAt), [match]);
    } catch {
      /* the badge still shows it */
    }
  };

  const dispose = () => {
    disposed = true;
  };

  return { poll, handleEvent, dispose, knownSpaces: () => spaces };
}

// Which conversation the Chat pane shows, and a pending "open this space"
// request from a clicked notification. Module state because the pane and the
// app shell that owns notifications don't share a React tree path.
let openSpaceId: string | null = null;
let pendingOpenSpaceId: string | null = null;
export const OPEN_CHAT_SPACE_EVENT = 'agenthub-google-chat-open-space';

export function setOpenChatSpace(spaceId: string | null): void {
  openSpaceId = spaceId;
}

export function getOpenChatSpace(): string | null {
  return openSpaceId;
}

/** Ask the Chat pane to show `spaceId`, now if mounted, else when it mounts. */
export function requestOpenChatSpace(spaceId: string): void {
  pendingOpenSpaceId = spaceId;
  globalThis.window?.dispatchEvent(new CustomEvent(OPEN_CHAT_SPACE_EVENT, { detail: { spaceId } }));
}

export function takePendingOpenChatSpace(): string | null {
  const id = pendingOpenSpaceId;
  pendingOpenSpaceId = null;
  return id;
}
