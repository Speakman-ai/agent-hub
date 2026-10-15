/**
 * Agent Hub chat state rules shared by web and mobile: channel types, rail
 * sections, unread/badge rules, snapshot reconciliation, message windows and
 * the Google-Chat-style message layout.
 */

/** Server timestamps: ISO strings, or SQLite `YYYY-MM-DD HH:MM:SS` in UTC. */
function parseDate(val: unknown): Date | null {
  if (!val) return null;
  if (typeof val === 'number') return new Date(val);
  const str = String(val);
  if (str.includes('T')) return new Date(str);
  return new Date(str + 'Z');
}

/** "Today", "Yesterday", or a date, the way Chat labels its day separators. */
export function chatDayLabel(d: Date, now: Date): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: diffDays < 7 ? 'long' : undefined,
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

export type HubChatChannelKind = 'dm' | 'group' | 'channel' | 'trigger' | 'agent' | 'summary';
export type HubChatNotifyLevel = 'all' | 'mentions' | 'none';

export interface HubChatMembership {
  role: 'owner' | 'member';
  lastReadSeq: number;
  notifyLevel: HubChatNotifyLevel;
  mutedUntil: string | null;
}

/** Agent channels: the linked session and whether the agent is answering. */
export interface HubChatAgentState {
  sessionId: string | null;
  sessionName: string | null;
  running: boolean;
}

/** An agent an `@` mention asked that has not answered yet. */
export interface HubChatMentionPending {
  agentId: string;
  agentName: string;
  sessionId: string | null;
}

export interface HubChatChannel {
  id: string;
  orgId: string;
  kind: HubChatChannelKind;
  name: string;
  topic: string | null;
  isPrivate: boolean;
  projectId: string | null;
  agentId: string | null;
  dmPeerUserId: string | null;
  createdByUserId: string | null;
  archivedAt: string | null;
  createdAt: string;
  lastSeq: number;
  membership: HubChatMembership | null;
  unreadCount: number;
  mentionCount: number;
  /** Set for agent channels only. */
  agentState?: HubChatAgentState | null;
  /** Channels, groups and DMs: mentioned agents still answering. */
  mentionPending?: HubChatMentionPending[] | null;
}

export interface HubChatRef {
  kind: string;
  targetId: string;
  projectId?: string | null;
}

export interface HubChatMessage {
  id: string;
  channelId: string;
  seq: number;
  authorKind: 'user' | 'agent' | 'system' | 'trigger';
  authorUserId: string | null;
  authorAgentId: string | null;
  /** Display name of the posting agent, for agent-authored messages. */
  authorAgentName?: string | null;
  body: string;
  refs: HubChatRef[];
  payload: unknown;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  /** Revision of `reactions` and `pinned`; bumped by the server on every change. */
  metaRev?: number;
  reactions?: HubChatReaction[];
  pinned?: HubChatPinInfo | null;
}

export interface HubChatReaction {
  emoji: string;
  count: number;
  userIds: string[];
}

export interface HubChatPinInfo {
  byUserId: string | null;
  at: string;
}

/** Reaction and pin state of one message, as carried by `hub_chat_message_meta`. */
export interface HubChatMessageMeta {
  messageId: string;
  channelId: string;
  metaRev: number;
  reactions: HubChatReaction[];
  pinned: HubChatPinInfo | null;
}

/** A pinned message as listed in a channel's pinned list. */
export interface HubChatPinnedMessage {
  message: HubChatMessage;
  pinnedByUserId: string | null;
  pinnedAt: string;
}

/** Quick-pick reactions offered on every message. */
export const HUB_CHAT_QUICK_REACTIONS: readonly string[] = ['👍', '❤️', '😂', '🎉', '👀', '✅'];

/** True when the viewer is among a reaction's users. */
export function reactedByViewer(reaction: HubChatReaction, viewerUserId: string | null): boolean {
  return !!viewerUserId && reaction.userIds.includes(viewerUserId);
}

/**
 * Reactions after the viewer toggles `emoji`, for an optimistic update. The
 * server's next meta event replaces it either way.
 */
export function toggleReaction(
  reactions: HubChatReaction[] | undefined,
  emoji: string,
  viewerUserId: string,
): HubChatReaction[] {
  const list = reactions ?? [];
  const hit = list.find((r) => r.emoji === emoji);
  if (!hit) return [...list, { emoji, count: 1, userIds: [viewerUserId] }];
  if (hit.userIds.includes(viewerUserId)) {
    const userIds = hit.userIds.filter((u) => u !== viewerUserId);
    return userIds.length
      ? list.map((r) => (r === hit ? { ...r, count: userIds.length, userIds } : r))
      : list.filter((r) => r !== hit);
  }
  const userIds = [...hit.userIds, viewerUserId];
  return list.map((r) => (r === hit ? { ...r, count: userIds.length, userIds } : r));
}

/** Entities that list where they were discussed in chat. */
export type HubChatBacklinkKind = 'card' | 'pr' | 'session' | 'ticket';

/** A chat message that references an entity (`GET /api/chat/backlinks`). */
export interface HubChatBacklink {
  messageId: string;
  channelId: string;
  channelKind: HubChatChannelKind;
  /** `# name` for channels, the peer for a DM. */
  channelLabel: string;
  authorKind: HubChatMessage['authorKind'];
  authorName: string | null;
  excerpt: string;
  createdAt: string;
}

/**
 * True when a live message event (new or edited) touches the entity's
 * backlinks: it references the entity now, or it is a deletion (which may
 * have removed one).
 */
export function messageAffectsBacklinks(
  message: Pick<HubChatMessage, 'refs' | 'deletedAt'> | null | undefined,
  kind: HubChatBacklinkKind,
  targetId: string,
): boolean {
  if (!message) return false;
  if (message.deletedAt) return true;
  return (message.refs ?? []).some((r) => r.kind === kind && r.targetId === targetId);
}

export interface HubChatMember {
  userId: string;
  username: string | null;
  role: 'owner' | 'member';
  joinedAt: string;
}

export interface HubChatOrgMember {
  userId: string;
  username: string;
  role: string;
}

export type RailSectionId = 'dms' | 'channels' | 'triggers' | 'summaries';

export const RAIL_SECTIONS: { id: RailSectionId; label: string }[] = [
  { id: 'dms', label: 'Direct messages' },
  { id: 'channels', label: 'Channels' },
  { id: 'triggers', label: 'Triggers' },
  { id: 'summaries', label: 'Summaries' },
];

const SECTION_OF: Record<HubChatChannelKind, RailSectionId> = {
  dm: 'dms',
  group: 'dms',
  channel: 'channels',
  agent: 'channels',
  trigger: 'triggers',
  summary: 'summaries',
};

/** Display name for a channel: the peer for a DM, member names for an unnamed group. */
export function channelLabel(
  channel: Pick<HubChatChannel, 'kind' | 'name' | 'dmPeerUserId'>,
  usernames: ReadonlyMap<string, string>,
  viewerUserId: string | null = null,
): string {
  if (channel.kind === 'dm') {
    const peer = channel.dmPeerUserId;
    if (!peer) return 'Direct message';
    const name = usernames.get(peer) ?? 'Unknown user';
    return peer === viewerUserId ? `${name} (you)` : name;
  }
  if (channel.name) return channel.kind === 'channel' ? `# ${channel.name}` : channel.name;
  return channel.kind === 'group' ? 'Group' : 'Untitled';
}

/** Rail sections in display order, each sorted by label. */
export function sectionChannels(
  channels: HubChatChannel[],
  usernames: ReadonlyMap<string, string>,
  viewerUserId: string | null = null,
): Record<RailSectionId, HubChatChannel[]> {
  const out: Record<RailSectionId, HubChatChannel[]> = {
    dms: [],
    channels: [],
    triggers: [],
    summaries: [],
  };
  for (const c of channels) {
    if (c.archivedAt) continue;
    out[SECTION_OF[c.kind]].push(c);
  }
  for (const id of Object.keys(out) as RailSectionId[]) {
    out[id].sort((a, b) =>
      channelLabel(a, usernames, viewerUserId).localeCompare(
        channelLabel(b, usernames, viewerUserId),
      ),
    );
  }
  return out;
}

export function isChannelMuted(channel: HubChatChannel, now: number = Date.now()): boolean {
  const until = channel.membership?.mutedUntil;
  if (!until) return false;
  const t = Date.parse(until);
  return Number.isFinite(t) && t > now;
}

/**
 * What the rail shows for a channel: a count badge for the messages that call
 * for attention, and bold text whenever anything is unread. Muted channels and
 * channels at notify level `none` never badge; `mentions` channels badge only
 * for mentions; DMs, groups, the Summaries channel and `all` channels badge
 * every unread message.
 */
export function railUnread(
  channel: HubChatChannel,
  now: number = Date.now(),
): { count: number; bold: boolean } {
  const unread = channel.unreadCount;
  if (!channel.membership || isChannelMuted(channel, now)) return { count: 0, bold: false };
  const level = channel.membership.notifyLevel;
  let count = 0;
  if (
    level === 'all' ||
    channel.kind === 'dm' ||
    channel.kind === 'group' ||
    channel.kind === 'summary'
  ) {
    count = level === 'none' ? 0 : unread;
  } else if (level === 'mentions') {
    count = channel.mentionCount;
  }
  return { count, bold: unread > 0 };
}

export function mentionsUser(
  message: Pick<HubChatMessage, 'refs'>,
  userId: string | null,
): boolean {
  if (!userId) return false;
  return message.refs.some((r) => r.kind === 'user' && r.targetId === userId);
}

export function isOwnHubMessage(message: HubChatMessage, viewerUserId: string | null): boolean {
  return !!viewerUserId && message.authorKind === 'user' && message.authorUserId === viewerUserId;
}

/**
 * Applies a live `hub_chat_message` to the rail. The open channel (when the
 * viewer is looking at it), the viewer's own posts and messages at or below
 * the read position never count as unread.
 */
export function applyMessageToChannels(
  channels: HubChatChannel[],
  message: HubChatMessage,
  opts: { viewerUserId: string | null; viewingChannelId: string | null },
): HubChatChannel[] {
  return channels.map((c) => {
    if (c.id !== message.channelId) return c;
    if (message.seq <= c.lastSeq) return c;
    const own = isOwnHubMessage(message, opts.viewerUserId);
    const viewing = opts.viewingChannelId === c.id;
    // A message the read position already covers (its read was written
    // before its event arrived) moves the tail but is not unread.
    const covered = !!c.membership && message.seq <= c.membership.lastReadSeq;
    if (own || viewing || covered || !c.membership) return { ...c, lastSeq: message.seq };
    return {
      ...c,
      lastSeq: message.seq,
      unreadCount: c.unreadCount + 1,
      mentionCount: c.mentionCount + (mentionsUser(message, opts.viewerUserId) ? 1 : 0),
    };
  });
}

/**
 * Applies a `hub_chat_read` for the viewer. Returns null when the read stops
 * short of the tail, since the remaining count needs the server.
 */
export function applyReadToChannels(
  channels: HubChatChannel[],
  channelId: string,
  lastReadSeq: number,
): HubChatChannel[] | null {
  let needsRefetch = false;
  const next = channels.map((c) => {
    if (c.id !== channelId || !c.membership) return c;
    if (lastReadSeq < c.lastSeq) needsRefetch = true;
    return {
      ...c,
      membership: { ...c.membership, lastReadSeq: Math.max(c.membership.lastReadSeq, lastReadSeq) },
      unreadCount: lastReadSeq >= c.lastSeq ? 0 : c.unreadCount,
      mentionCount: lastReadSeq >= c.lastSeq ? 0 : c.mentionCount,
    };
  });
  return needsRefetch ? null : next;
}

/**
 * Field groups a client can change locally. Message and read sequences are
 * not listed: they only move forward, so the larger value always wins.
 */
export type ChannelFieldGroup = 'presence' | 'meta' | 'membership';

/** True when the client changed `group` of a channel after the request went out. */
export type ChangedSince = (channelId: string, group: ChannelFieldGroup) => boolean;

function mergeChannel(
  fresh: HubChatChannel,
  current: HubChatChannel,
  changed: (group: ChannelFieldGroup) => boolean,
  localRead: number,
): { channel: HubChatChannel; exact: boolean } {
  const next: HubChatChannel = { ...fresh };
  if (changed('meta')) {
    next.name = current.name;
    next.topic = current.topic;
    next.isPrivate = current.isPrivate;
    next.archivedAt = current.archivedAt;
  }
  if (changed('membership') && current.membership) {
    next.membership = current.membership;
  }
  next.lastSeq = Math.max(fresh.lastSeq, current.lastSeq);
  if (next.membership) {
    const lastReadSeq = Math.max(fresh.membership?.lastReadSeq ?? 0, localRead);
    next.membership = { ...next.membership, lastReadSeq };
  }
  // Counts come from the server. They are exact when the server saw the same
  // tail and read position the client now holds, or when everything is read.
  const read = next.membership?.lastReadSeq ?? 0;
  if (read >= next.lastSeq)
    return { channel: { ...next, unreadCount: 0, mentionCount: 0 }, exact: true };
  if (fresh.lastSeq === next.lastSeq && (fresh.membership?.lastReadSeq ?? 0) === read) {
    return { channel: next, exact: true };
  }
  // A live event raced the request: estimate within what is possible and let
  // the caller fetch again for the exact numbers.
  const ceiling = next.lastSeq - read;
  const unreadCount = Math.min(ceiling, Math.max(fresh.unreadCount, current.unreadCount));
  const mentionCount = Math.min(unreadCount, Math.max(fresh.mentionCount, current.mentionCount));
  return { channel: { ...next, unreadCount, mentionCount }, exact: false };
}

/**
 * The field groups that differ between two versions of a channel (either may
 * be absent). The read pointer is left out: it only moves forward, so it
 * never needs protecting from older data.
 */
export function changedGroups(
  before: HubChatChannel | undefined,
  after: HubChatChannel | undefined,
): ChannelFieldGroup[] {
  if (!before || !after) return before === after ? [] : ['presence'];
  const groups: ChannelFieldGroup[] = [];
  if (
    before.name !== after.name ||
    before.topic !== after.topic ||
    before.isPrivate !== after.isPrivate ||
    before.archivedAt !== after.archivedAt
  ) {
    groups.push('meta');
  }
  const a = before.membership;
  const b = after.membership;
  if (
    !a !== !b ||
    (a &&
      b &&
      (a.role !== b.role || a.notifyLevel !== b.notifyLevel || a.mutedUntil !== b.mutedUntil))
  ) {
    groups.push('membership');
  }
  return groups;
}

/**
 * Applies one channel object from a server response (settings, join, create,
 * DM) with the same per-field rules as a list refresh. `changed` names the
 * field groups the client changed after the request went out.
 */
export function reconcileChannel(
  fresh: HubChatChannel,
  current: HubChatChannel | undefined,
  changed: (group: ChannelFieldGroup) => boolean,
  localRead: number,
): { channel: HubChatChannel | null; exact: boolean } {
  if (!current) {
    // Left or removed locally after the request: the response is stale, the
    // channel stays gone. This is the only presence rule; the list
    // reconcile below goes through here too.
    if (changed('presence')) return { channel: null, exact: true };
    if (!fresh.membership || localRead <= fresh.membership.lastReadSeq) {
      return { channel: fresh, exact: true };
    }
    return mergeChannel(fresh, fresh, () => false, localRead);
  }
  return mergeChannel(fresh, current, changed, localRead);
}

/**
 * Applies a membership object from the server (a settings response or a
 * membership event). Prefs come from the server unless the client changed
 * them after the request; the read pointer only moves forward.
 */
export function reconcileMembership(
  current: HubChatChannel,
  membership: HubChatMembership,
  changedSince: boolean,
  localRead: number,
): HubChatChannel {
  const base = changedSince && current.membership ? current.membership : membership;
  const lastReadSeq = Math.max(membership.lastReadSeq, localRead);
  const next = { ...current, membership: { ...base, lastReadSeq } };
  return lastReadSeq >= current.lastSeq ? { ...next, unreadCount: 0, mentionCount: 0 } : next;
}

/**
 * Applies a fresh channel list from the server against what the client holds
 * now, field by field: the server wins except for field groups the client
 * changed after the request went out, sequences only move forward, and
 * `exact` is false when an unread count had to be estimated (fetch again).
 */
export function reconcileChannels(
  fresh: HubChatChannel[],
  current: HubChatChannel[],
  changedSince: ChangedSince,
  /**
   * Read progress the client may assert over the snapshot: what the server
   * confirmed after the request, plus a write still in flight. Never a
   * failed optimistic read, so a rejected write rolls back here. Defaults to
   * the client's displayed pointer.
   */
  localRead: (channelId: string) => number = (id) =>
    current.find((c) => c.id === id)?.membership?.lastReadSeq ?? 0,
): { channels: HubChatChannel[]; exact: boolean } {
  const currentById = new Map(current.map((c) => [c.id, c]));
  const freshIds = new Set(fresh.map((c) => c.id));
  let exact = true;
  const out: HubChatChannel[] = [];
  for (const f of fresh) {
    const r = reconcileChannel(
      f,
      currentById.get(f.id),
      (g) => changedSince(f.id, g),
      localRead(f.id),
    );
    if (!r.exact) exact = false;
    if (r.channel) out.push(r.channel);
  }
  // Joined or created locally since the request: keep it.
  for (const c of current) {
    if (!freshIds.has(c.id) && changedSince(c.id, 'presence')) out.push(c);
  }
  return { channels: out, exact };
}

/**
 * True when `incoming` is at least as new as `current` (the same message).
 * Deletion is final, and otherwise the later edit wins, so a history page
 * fetched before a live edit or delete cannot bring the old body back.
 */
export function isSameOrNewerRevision(incoming: HubChatMessage, current: HubChatMessage): boolean {
  if (current.deletedAt) return !!incoming.deletedAt;
  if (incoming.deletedAt) return true;
  if (!current.editedAt) return true;
  if (!incoming.editedAt) return false;
  return Date.parse(incoming.editedAt) >= Date.parse(current.editedAt);
}

/**
 * The messages a view shows plus the newest revision seen of every message
 * id, including ones not loaded yet. An edit or delete that arrives before
 * the page holding its message is kept here and wins when that page lands.
 */
export interface MessageWindow {
  messages: HubChatMessage[];
  revisions: Readonly<Record<string, HubChatMessage>>;
  /**
   * Newest reaction/pin state seen per message id, including messages not
   * loaded yet, so a history page fetched before a live reaction cannot
   * bring the old reactions back.
   */
  metas?: Readonly<Record<string, MetaFields>>;
}

export type MetaFields = Pick<HubChatMessageMeta, 'metaRev' | 'reactions' | 'pinned'>;

export function metaOf(m: HubChatMessage): MetaFields {
  return { metaRev: m.metaRev ?? 0, reactions: m.reactions ?? [], pinned: m.pinned ?? null };
}

function newerMeta(a: MetaFields, b: MetaFields | undefined): MetaFields {
  return !b || a.metaRev >= b.metaRev ? a : b;
}

/** `m` with `meta` applied when `meta` is the newer reaction/pin revision. */
export function withMeta(m: HubChatMessage, meta: MetaFields | undefined): HubChatMessage {
  if (!meta || meta.metaRev <= (m.metaRev ?? 0)) return m;
  return { ...m, metaRev: meta.metaRev, reactions: meta.reactions, pinned: meta.pinned };
}

/** The newer of two copies of one message, field group by field group. */
export function newestRevision(a: HubChatMessage, b: HubChatMessage | undefined): HubChatMessage {
  // Body and deletion follow the edit revision; reactions and pins follow
  // their own revision, so neither can roll the other back.
  const body = !b || isSameOrNewerRevision(a, b) ? a : b;
  return withMeta(body, b ? newerMeta(metaOf(a), metaOf(b)) : undefined);
}

/**
 * The one way messages enter a view. `insert` adds messages not shown yet
 * (history pages, new posts); without it, only shown messages are updated
 * (live edits and deletes), so an update never opens a gap in history.
 */
export function mergeIntoWindow(
  w: MessageWindow,
  incoming: HubChatMessage[],
  insert: boolean,
): MessageWindow {
  if (!incoming.length) return w;
  const revisions: Record<string, HubChatMessage> = { ...w.revisions };
  const metas: Record<string, MetaFields> = { ...w.metas };
  for (const m of incoming) {
    revisions[m.id] = withMeta(newestRevision(m, revisions[m.id]), metas[m.id]);
    metas[m.id] = metaOf(revisions[m.id]);
  }
  const shown = new Map(w.messages.map((m) => [m.id, m]));
  for (const m of incoming) {
    if (insert || shown.has(m.id)) shown.set(m.id, revisions[m.id]);
  }
  return { messages: [...shown.values()].sort((a, b) => a.seq - b.seq), revisions, metas };
}

/**
 * Applies a live reaction/pin change. Updates the message when shown and
 * remembers the state otherwise; an older revision changes nothing.
 */
export function applyMetaToWindow(w: MessageWindow, meta: HubChatMessageMeta): MessageWindow {
  const known = w.metas?.[meta.messageId];
  if (known && known.metaRev >= meta.metaRev) return w;
  const fields: MetaFields = {
    metaRev: meta.metaRev,
    reactions: meta.reactions,
    pinned: meta.pinned,
  };
  const metas = { ...w.metas, [meta.messageId]: fields };
  const rev = w.revisions[meta.messageId];
  const revisions = rev ? { ...w.revisions, [meta.messageId]: withMeta(rev, fields) } : w.revisions;
  const messages = w.messages.map((m) => (m.id === meta.messageId ? withMeta(m, fields) : m));
  return { messages, revisions, metas };
}

/** Parses a `hub_chat_message_meta` event body, or null when malformed. */
export function parseMessageMetaEvent(data: unknown): HubChatMessageMeta | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (
    typeof d.messageId !== 'string' ||
    typeof d.channelId !== 'string' ||
    typeof d.metaRev !== 'number' ||
    !Array.isArray(d.reactions)
  ) {
    return null;
  }
  return {
    messageId: d.messageId,
    channelId: d.channelId,
    metaRev: d.metaRev,
    reactions: d.reactions as HubChatReaction[],
    pinned: (d.pinned as HubChatPinInfo | null | undefined) ?? null,
  };
}

/** Consecutive messages from one sender closer together than this share a header. */
const GROUP_GAP_MS = 5 * 60_000;

function senderKey(m: HubChatMessage): string {
  const who = m.authorKind === 'agent' ? (m.authorAgentId ?? m.authorUserId) : m.authorUserId;
  return `${m.authorKind}:${who ?? m.authorAgentId ?? ''}`;
}

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export interface HubChatRow {
  message: HubChatMessage;
  own: boolean;
  showHeader: boolean;
  dayLabel: string | null;
  unreadDivider: boolean;
}

/**
 * Lays out an oldest-first message list with the Google Chat pane's rules:
 * day separators, an Unread line before the first message from someone else
 * past the read position, and runs from one sender under a single header.
 */
export function layoutHubChatMessages(
  messages: HubChatMessage[],
  opts: { viewerUserId: string | null; lastReadSeq: number | null; now?: Date },
): HubChatRow[] {
  const now = opts.now ?? new Date();
  const rows: HubChatRow[] = [];
  let unreadPlaced = false;
  let prev: HubChatMessage | null = null;
  let prevDate: Date | null = null;
  for (const message of messages) {
    const parsed = parseDate(message.createdAt);
    const date = parsed && !isNaN(parsed.getTime()) ? parsed : null;
    const own = isOwnHubMessage(message, opts.viewerUserId);
    const newDay = !!date && (!prevDate || localDayKey(date) !== localDayKey(prevDate));
    let unreadDivider = false;
    if (
      !unreadPlaced &&
      opts.lastReadSeq !== null &&
      !own &&
      !message.deletedAt &&
      message.seq > opts.lastReadSeq
    ) {
      unreadDivider = true;
      unreadPlaced = true;
    }
    const sameRun =
      !!prev &&
      !newDay &&
      !unreadDivider &&
      senderKey(prev) === senderKey(message) &&
      !!date &&
      !!prevDate &&
      date.getTime() - prevDate.getTime() < GROUP_GAP_MS;
    rows.push({
      message,
      own,
      showHeader: !sameRun,
      dayLabel: newDay && date ? chatDayLabel(date, now) : null,
      unreadDivider,
    });
    prev = message;
    if (date) prevDate = date;
  }
  return rows;
}

export function authorLabel(
  message: HubChatMessage,
  usernames: ReadonlyMap<string, string>,
): string {
  if (message.authorKind === 'user') {
    return (message.authorUserId && usernames.get(message.authorUserId)) || 'Unknown user';
  }
  if (message.authorKind === 'agent') {
    return message.authorAgentName || message.authorAgentId || 'Agent';
  }
  if (message.authorKind === 'trigger') return 'Trigger';
  return 'Agent Hub';
}

/** Mute presets offered in channel settings, in hours (null = until unmuted). */
export const MUTE_PRESETS: { label: string; hours: number | null }[] = [
  { label: '1 hour', hours: 1 },
  { label: '8 hours', hours: 8 },
  { label: '24 hours', hours: 24 },
  { label: '1 week', hours: 24 * 7 },
  { label: 'Until I unmute', hours: null },
];

/** "Until I unmute" is a far-future expiry, since the API stores a timestamp. */
export function muteUntilIso(hours: number | null, now: number = Date.now()): string {
  const ms = hours === null ? 100 * 365 * 24 * 3_600_000 : hours * 3_600_000;
  return new Date(now + ms).toISOString();
}

/** Applies a live `agent_state` channel update. */
export function applyAgentStateToChannels(
  channels: HubChatChannel[],
  channelId: string,
  agentState: HubChatAgentState,
): HubChatChannel[] {
  return channels.map((c) => (c.id === channelId ? { ...c, agentState } : c));
}

/** Applies a live `mention_state` channel update. */
export function applyMentionPendingToChannels(
  channels: HubChatChannel[],
  channelId: string,
  mentionPending: HubChatMentionPending[],
): HubChatChannel[] {
  return channels.map((c) => (c.id === channelId ? { ...c, mentionPending } : c));
}

/** Reads a `mention_state` update's list, dropping malformed rows. */
export function parseMentionPending(value: unknown): HubChatMentionPending[] | null {
  if (!Array.isArray(value)) return null;
  const out: HubChatMentionPending[] = [];
  for (const v of value) {
    if (!v || typeof v !== 'object') continue;
    const row = v as Record<string, unknown>;
    if (typeof row.agentId !== 'string' || !row.agentId) continue;
    out.push({
      agentId: row.agentId,
      agentName: typeof row.agentName === 'string' && row.agentName ? row.agentName : row.agentId,
      sessionId: typeof row.sessionId === 'string' ? row.sessionId : null,
    });
  }
  return out;
}

/** "Web Dev is working…", "Web Dev and API Dev are working…". */
export function mentionPendingText(pending: readonly HubChatMentionPending[]): string | null {
  const names = pending.map((p) => p.agentName);
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is working…`;
  const list = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list} are working…`;
}

/** A mention the server did not dispatch, shown to the poster only. */
export interface HubChatMentionNotice {
  /** `<messageId>:<agentId>`, so the POST response and the live event dedupe. */
  key: string;
  channelId: string;
  agentId: string;
  code: string;
  message: string;
}

/**
 * Reads mention notices from a post response (`mentionNotices`, with the
 * message's channel and id given) or a live `hub_chat_notice` event.
 */
export function parseMentionNotices(
  value: unknown,
  context: { channelId?: string; messageId?: string } = {},
): HubChatMentionNotice[] {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  const out: HubChatMentionNotice[] = [];
  for (const v of rows) {
    if (!v || typeof v !== 'object') continue;
    const row = v as Record<string, unknown>;
    const channelId = typeof row.channelId === 'string' ? row.channelId : context.channelId;
    const messageId = typeof row.messageId === 'string' ? row.messageId : context.messageId;
    if (!channelId || typeof row.agentId !== 'string' || typeof row.message !== 'string') continue;
    out.push({
      key: `${messageId ?? ''}:${row.agentId}`,
      channelId,
      agentId: row.agentId,
      code: typeof row.code === 'string' ? row.code : 'mention_forbidden',
      message: row.message,
    });
  }
  return out;
}

/** Agent roles that never answer a chat channel (mirrors the server rule). */
const NON_CHAT_AGENT_ROLES = new Set(['reviewer', 'docs', 'hub-assistant', 'skill-builder']);

/** Agents of a project that can be bound to an agent channel. */
export function agentChannelAgentOptions(
  agents: unknown,
  projectId: string,
): { id: string; name: string }[] {
  if (!Array.isArray(agents) || !projectId) return [];
  const out: { id: string; name: string }[] = [];
  for (const a of agents) {
    if (!a || typeof a !== 'object') continue;
    const row = a as Record<string, unknown>;
    if (row.projectId == null || String(row.projectId) !== projectId) continue;
    if (typeof row.id !== 'string' || !row.id) continue;
    const role = typeof row.role === 'string' ? row.role.trim().toLowerCase() : '';
    if (NON_CHAT_AGENT_ROLES.has(role)) continue;
    out.push({ id: row.id, name: typeof row.name === 'string' && row.name ? row.name : row.id });
  }
  return out;
}

/** One-line header status for an agent channel. */
export function agentChannelStatus(state: HubChatAgentState | null | undefined): string {
  if (!state) return '';
  if (state.running) return 'Working…';
  return state.sessionId ? 'Idle' : 'Post to start a session';
}
