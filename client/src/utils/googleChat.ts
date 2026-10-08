import { compareRfc3339, isRfc3339 } from '@shared/utils/rfc3339';

/**
 * Pure helpers for the Google Chat pane. Shapes mirror the server proxy's Zod
 * responses in server/routes/google-chat.ts.
 */

export type ChatSpace = {
  name: string | null;
  id: string | null;
  displayName: string | null;
  spaceType: string | null;
  singleUserBotDm: boolean;
  spaceThreadingState: string | null;
  /** Named space that keeps replies in threads; see the server's supportsThreadReplies. */
  supportsThreadReplies: boolean;
  lastActiveTime: string | null;
  spaceUri: string | null;
  /** Other members of an unnamed DM / group chat; null when unresolved. */
  participants: string[] | null;
};

export type ChatUser = {
  name: string | null;
  displayName: string | null;
  type: string | null;
};

export type ChatMessage = {
  name: string | null;
  id: string | null;
  spaceName: string | null;
  threadName: string | null;
  threadReply: boolean;
  text: string | null;
  createTime: string | null;
  lastUpdateTime: string | null;
  deleted: boolean;
  attachmentCount: number;
  sender: ChatUser | null;
};

/** Named spaces show their name; DMs and unnamed group chats get a type label. */
type SpaceLabelInput = Pick<ChatSpace, 'displayName' | 'spaceType' | 'id'> &
  Partial<Pick<ChatSpace, 'participants' | 'singleUserBotDm'>>;

const MAX_LABEL_NAMES = 3;

/**
 * The name an operator sees for a conversation in the list, header, and
 * composer, so it must tell conversations apart. Named spaces use their name.
 * DMs and group chats have none: they use the other participants, and when
 * those are unknown, the type plus the space id, which is stable and unique.
 */
export function chatSpaceLabel(space: SpaceLabelInput): string {
  const name = (space.displayName || '').trim();
  if (name) return name;
  const people = (space.participants || []).filter(Boolean);
  if (people.length) {
    const shown = people.slice(0, MAX_LABEL_NAMES).join(', ');
    const more = people.length - MAX_LABEL_NAMES;
    return more > 0 ? `${shown} +${more}` : shown;
  }
  const id = space.id ? ` · ${space.id}` : '';
  if (space.singleUserBotDm) return `Chat app DM${id}`;
  switch (space.spaceType) {
    case 'DIRECT_MESSAGE':
      return `Direct message${id}`;
    case 'GROUP_CHAT':
      return `Group chat${id}`;
    default:
      return `Space${id}`;
  }
}

/**
 * Under user auth the Chat API returns a sender's display name only when they
 * are a space member or share a DM with the caller (e.g. not after they leave
 * the space). Fall back to a stable short id in that case.
 */
export function chatSenderLabel(sender: ChatUser | null | undefined): string {
  if (!sender) return 'Unknown sender';
  const name = (sender.displayName || '').trim();
  if (name) return name;
  if (sender.type === 'BOT') return 'Chat app';
  const id = (sender.name || '').replace(/^users\//, '');
  return id ? `User ${id.length > 6 ? id.slice(-6) : id}` : 'Unknown sender';
}

const SAFE_CHAT_LINK = /^https:\/\/(chat|mail)\.google\.com\//i;

/** The space's own reopen URL when it is a safe Google URL, else a built one. */
export function chatSpaceDeepLink(
  space: Pick<ChatSpace, 'spaceUri' | 'id'> | null | undefined,
): string | null {
  if (!space) return null;
  const uri = (space.spaceUri || '').trim();
  if (uri && SAFE_CHAT_LINK.test(uri)) return uri;
  return space.id ? `https://chat.google.com/room/${encodeURIComponent(space.id)}` : null;
}

// createTime values carry sub-millisecond precision; every comparison below
// goes through the exact RFC 3339 helpers, never Date.
/** Oldest first, so the newest message sits next to the composer. */
export function sortChatMessages<T extends Pick<ChatMessage, 'createTime'>>(messages: T[]): T[] {
  return [...messages].sort((a, b) => compareRfc3339(a.createTime, b.createTime));
}

/**
 * Messages that precede `target` in the same thread, oldest first. Used as
 * context in a session seed so the agent sees the conversation, not one line.
 */
export function chatThreadContext(messages: ChatMessage[], target: ChatMessage): ChatMessage[] {
  if (!target.threadName) return [];
  return sortChatMessages(
    messages.filter(
      (m) =>
        m.threadName === target.threadName &&
        m.name !== target.name &&
        !m.deleted &&
        compareRfc3339(m.createTime, target.createTime) <= 0,
    ),
  );
}

/** Space id from a `spaces/{id}/threads/{t}` thread name, for reply routing. */
export function spaceIdFromThreadName(threadName: string | null | undefined): string | null {
  const match = /^spaces\/([^/]+)\/threads\/[^/]+$/.exec(threadName || '');
  return match ? match[1] : null;
}

/** Most recently active first; spaces with no activity sink to the bottom. */
export function sortSpacesByActivity<T extends Pick<ChatSpace, 'lastActiveTime'>>(
  spaces: T[],
): T[] {
  return [...spaces].sort((a, b) => compareRfc3339(b.lastActiveTime, a.lastActiveTime));
}

function byName(messages: ChatMessage[]): Map<string, ChatMessage> {
  const map = new Map<string, ChatMessage>();
  for (const m of messages) map.set(m.name || `${m.createTime}:${m.text}`, m);
  return map;
}

/** createTime of the oldest message with one, or null for an empty history. */
export function oldestCreateTime(messages: ChatMessage[]): string | null {
  let oldest: string | null = null;
  for (const m of messages) {
    if (!m.createTime || !isRfc3339(m.createTime)) continue;
    if (oldest === null || compareRfc3339(m.createTime, oldest) < 0) oldest = m.createTime;
  }
  return oldest;
}

/**
 * Replace everything created at or after `since` with a fresh, complete read
 * of that range. Messages edited, deleted (tombstones), or gone from the range
 * are reconciled because the fresh read is authoritative; anything older than
 * `since` (an older page loaded while the read was in flight) is kept.
 */
export function reconcileRange(
  existing: ChatMessage[],
  fresh: ChatMessage[],
  since: string,
): ChatMessage[] {
  const kept = existing.filter(
    (m) => !!m.createTime && isRfc3339(m.createTime) && compareRfc3339(m.createTime, since) < 0,
  );
  const merged = byName(kept);
  for (const [key, m] of byName(fresh)) merged.set(key, m);
  return sortChatMessages([...merged.values()]);
}

/** Add an older page to the loaded history without replacing newer copies. */
export function mergeOlderPage(existing: ChatMessage[], older: ChatMessage[]): ChatMessage[] {
  const merged = byName(older);
  for (const [key, m] of byName(existing)) merged.set(key, m);
  return sortChatMessages([...merged.values()]);
}

/** Case-insensitive match on the visible label; an empty query keeps every space. */
export function filterSpaces<T extends SpaceLabelInput>(spaces: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return spaces;
  return spaces.filter((s) =>
    [chatSpaceLabel(s), ...(s.participants || []), s.id || ''].some((v) =>
      v.toLowerCase().includes(q),
    ),
  );
}

/** One copy per message name (last wins), oldest first. */
export function uniqueMessages(messages: ChatMessage[]): ChatMessage[] {
  return sortChatMessages([...byName(messages).values()]);
}

/**
 * Context for a seed: the thread in spaces that keep replies in threads,
 * otherwise the messages just before the target in the flat conversation
 * (DMs, group chats, unthreaded spaces).
 */
export function chatSeedContext(
  messages: ChatMessage[],
  target: ChatMessage,
  threaded: boolean,
  limit = 10,
): ChatMessage[] {
  if (threaded) return chatThreadContext(messages, target);
  return sortChatMessages(
    messages.filter(
      (m) =>
        m.name !== target.name &&
        !m.deleted &&
        compareRfc3339(m.createTime, target.createTime) <= 0,
    ),
  ).slice(-limit);
}

/** Proxy error codes for Google-side setup problems the operator can't fix in the pane. */
const CHAT_SETUP_HELP: Record<string, string> = {
  google_chat_workspace_required: 'About Google Workspace accounts',
  google_chat_api_disabled: 'Enable the Chat API in Google Cloud',
  google_chat_app_not_configured: 'Open the Chat API configuration page',
};

const SAFE_HELP_LINK = /^https:\/\/(console\.cloud|console\.developers|support)\.google\.com\//i;

/**
 * The fix-it link for a Chat setup error (personal account, Chat API off, no
 * Chat app configured), or null for any other error or an unexpected URL.
 */
export function chatSetupHelpLink(
  err: { code?: string; helpUrl?: string } | null | undefined,
): { label: string; url: string } | null {
  const label = err?.code ? CHAT_SETUP_HELP[err.code] : undefined;
  const url = (err?.helpUrl || '').trim();
  if (!label || !SAFE_HELP_LINK.test(url)) return null;
  return { label, url };
}
