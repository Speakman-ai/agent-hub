/**
 * Agent Hub chat state for mobile: one channel list shared by the Chat screen,
 * the Hub tab badge and the drawer badge. It follows the same rules as the web
 * client (`useHubChatUnread`), with the rule code itself in
 * `@shared/utils/hubChat`:
 *
 * - Channel list fetches are serialized; requests made during a fetch collapse
 *   into one follow-up, so the latest fetch always started after every change
 *   it must reflect.
 * - Read pointers only move forward. A snapshot requested before a read event
 *   cannot bring cleared counts back.
 * - A reset (sign-out, org switch) bumps a generation so a response for the
 *   previous account is dropped.
 */
import {
  applyMessageToChannels,
  changedGroups,
  isOwnHubMessage,
  mentionsUser,
  reconcileChannel,
  reconcileChannels,
  type ChannelFieldGroup,
  type HubChatChannel,
  type HubChatMembership,
  type HubChatMessage,
  type HubChatMessageMeta,
  parseMessageMetaEvent,
  applyAgentStateToChannels,
  applyMentionPendingToChannels,
  parseMentionNotices,
  parseMentionPending,
  type HubChatAgentState,
  type HubChatMentionNotice,
} from '@shared/utils/hubChat';
import {
  hubChatBadgeCount,
  hubChatNoticeFor,
  type HubChatMessageEvent,
  type HubChatNotice,
} from '@shared/utils/hubChatUnread';

export interface HubChatStoreApi {
  channels: () => Promise<{ channels?: HubChatChannel[]; viewerUserId?: string }>;
}

export interface HubChatSnapshot {
  channels: HubChatChannel[];
  viewerUserId: string | null;
  /** True once a fetch for the current account has landed. */
  loaded: boolean;
  /**
   * True while the store serves an account (from its reset for that account
   * until the next reset), whether or not its list has loaded yet. False only
   * before sign-in or connection, and between leaving an account and the next
   * one connecting.
   */
  active: boolean;
  /**
   * Bumped on every reset (sign-out, account, server or org switch). Views
   * holding anything fetched for an earlier account key off it to start over.
   */
  account: number;
}

export type HubChatLiveEvent =
  | { type: 'hub_chat_message' | 'hub_chat_message_update'; message: HubChatMessage }
  | { type: 'hub_chat_read'; channelId: string; lastReadSeq: number }
  | { type: 'hub_chat_channel_update'; channelId: string | null }
  /** Reactions or pin changed; `pinChanged` means the channel's pinned list did. */
  | { type: 'hub_chat_message_meta'; meta: HubChatMessageMeta; pinChanged: boolean }
  /** For the viewer only: an `@agent` mention in their post was not dispatched. */
  | { type: 'hub_chat_notice'; notice: HubChatMentionNotice }
  /** The connection came back: events may have been missed, reload what is shown. */
  | { type: 'resync' };

export const HUB_CHAT_WS_EVENTS: ReadonlySet<string> = new Set([
  'hub_chat_message',
  'hub_chat_message_update',
  'hub_chat_read',
  'hub_chat_channel_update',
  'hub_chat_message_meta',
  'hub_chat_notice',
]);

type MembershipPatch = Partial<Pick<HubChatMembership, 'notifyLevel' | 'mutedUntil'>>;

/** How a message seen live counted in the confirmed unread totals. */
export type SeenCount = 'unread' | 'mention' | 'none';

/**
 * Unread and mention counts left once everything up to `readSeq` is read.
 *
 * The confirmed totals count from the confirmed read position; a pending
 * read further on covers part of them. Messages seen live are known one by
 * one (`seen`), so those above `readSeq` count exactly. Sequences above
 * `readSeq` that were never seen (they arrived in a snapshot) are assumed
 * unread, so the result is exact when every message was seen and otherwise
 * an upper bound: a pending read never hides a message it does not cover.
 */
export function countsAboveRead(
  c: Pick<HubChatChannel, 'lastSeq' | 'unreadCount' | 'mentionCount'>,
  readSeq: number,
  seen: ReadonlyMap<number, SeenCount> | undefined,
): { unreadCount: number; mentionCount: number } {
  if (readSeq >= c.lastSeq) return { unreadCount: 0, mentionCount: 0 };
  let unread = 0;
  let mentions = 0;
  let known = 0;
  for (const [seq, kind] of seen ?? []) {
    if (seq <= readSeq || seq > c.lastSeq) continue;
    known += 1;
    if (kind !== 'none') unread += 1;
    if (kind === 'mention') mentions += 1;
  }
  const unknown = Math.max(0, c.lastSeq - readSeq - known);
  const unreadCount = Math.min(c.unreadCount, unread + unknown);
  return {
    unreadCount,
    mentionCount: Math.min(c.mentionCount, mentions + unknown, unreadCount),
  };
}

/**
 * A channel with its read position moved forward to `readSeq` and its counts
 * recounted from there (`countsAboveRead`). `exact` is false when some
 * sequences above the read were never seen live, so the counts are an upper
 * bound and the server should be asked for the real totals.
 */
export function withReadPosition(
  c: HubChatChannel,
  readSeq: number,
  seen: ReadonlyMap<number, SeenCount> | undefined,
): { channel: HubChatChannel; exact: boolean } {
  if (!c.membership) return { channel: c, exact: true };
  if (readSeq <= c.membership.lastReadSeq) {
    // Nothing new is read, but a read reaching the tail still means nothing
    // is unread; repair totals that say otherwise instead of keeping them.
    const atTail = Math.max(readSeq, c.membership.lastReadSeq) >= c.lastSeq;
    return atTail && (c.unreadCount || c.mentionCount)
      ? { channel: { ...c, unreadCount: 0, mentionCount: 0 }, exact: true }
      : { channel: c, exact: true };
  }
  let known = 0;
  for (const seq of seen?.keys() ?? []) if (seq > readSeq && seq <= c.lastSeq) known += 1;
  return {
    channel: {
      ...c,
      membership: { ...c.membership, lastReadSeq: readSeq },
      ...countsAboveRead(c, readSeq, seen),
    },
    exact: readSeq >= c.lastSeq || known >= c.lastSeq - readSeq,
  };
}

/**
 * One state model for every change to the channel list:
 *
 * - `base` is what the server confirmed: list snapshots, live events, and
 *   responses to the viewer's own writes. Confirmed changes made after a list
 *   request went out are protected from that (older) response by field group,
 *   with the same shared rules web uses.
 * - Pending intents (read positions and notify-level/mute changes whose
 *   writes are still in flight) are overlays kept beside `base`, never
 *   written into it. The published list is always `base` with the overlays on
 *   top, so a refresh, an event or another response can replace `base`
 *   freely and the pending intent still shows until its write settles.
 * - Settling removes the overlay. Success writes the server's answer into
 *   `base`; failure refetches, so the server's value comes back.
 * - Everything is tied to the account (generation) it was made for; a reset
 *   drops `base`, overlays and in-flight results together.
 */
export function createHubChatStore(chatApi: HubChatStoreApi) {
  let snapshot: HubChatSnapshot = {
    channels: [],
    viewerUserId: null,
    loaded: false,
    active: false,
    account: 0,
  };
  let generation = 0;
  let enabled = false;
  let viewingChannelId: string | null = null;
  let refreshState = { running: null as Promise<void> | null, again: false };
  let base: HubChatChannel[] = [];
  // Read positions the server confirmed (snapshots, read events, write
  // responses). Only these are asserted over a server snapshot.
  let reads = new Map<string, number>();
  // Overlays: pending read writes and pending membership patches per channel.
  let pendingReads = new Map<string, number[]>();
  let pendingMembership = new Map<string, { id: number; patch: MembershipPatch }[]>();
  // Per channel, every message seen live above the confirmed read position
  // and how it counted in the confirmed totals, so a pending read can take
  // exactly the messages it covers out of those totals.
  //
  // The ledger is a record of live events, kept current by them (new
  // messages, edits, deletes). It is therefore exact only for an unbroken
  // connection: whenever events may have been missed (every reconnect, see
  // `resync`, and every account reset) it is discarded rather than trusted.
  // Without it, recounts fall back to an upper bound and ask the server.
  let seen = new Map<string, Map<number, SeenCount>>();
  // Overlay: per channel, the newest message that arrived while it was on
  // screen. Shown as read until the view's read write settles (success
  // confirms it; failure drops it), or until the channel leaves the screen.
  let viewed = new Map<string, number>();
  const dropViewedUpTo = (channelId: string, seq: number) => {
    if ((viewed.get(channelId) ?? 0) <= seq) viewed.delete(channelId);
  };
  let patchIds = 0;
  const listeners = new Set<() => void>();
  const liveListeners = new Set<(event: HubChatLiveEvent) => void>();
  let onNotify: ((notice: HubChatNotice) => void) | null = null;

  // Confirmed local changes per channel field group, stamped with a logical
  // clock. A list response only overrides groups not changed after it was
  // requested.
  let clock = 0;
  let changes = new Map<string, Map<ChannelFieldGroup, number>>();
  // Per channel: notify-level/mute writes run in order; `latest` is the id of
  // the newest one, the only one whose failure is reported.
  let membershipWrites = new Map<string, { tail: Promise<void>; latest: number }>();
  const stamp = (channelId: string, groups: ChannelFieldGroup[]) => {
    if (groups.length === 0) return;
    clock += 1;
    const byGroup = changes.get(channelId) ?? new Map<ChannelFieldGroup, number>();
    for (const g of groups) byGroup.set(g, clock);
    changes.set(channelId, byGroup);
    // A list fetch in flight predates this change: fetch once more after it.
    if (refreshState.running) refreshState.again = true;
  };
  const changedSince = (startedAt: number) => (channelId: string, group: ChannelFieldGroup) =>
    (changes.get(channelId)?.get(group) ?? 0) > startedAt;

  const confirmedRead = (channelId: string) => reads.get(channelId) ?? 0;
  const noteRead = (channelId: string, seq: number) => {
    if (seq > confirmedRead(channelId)) reads.set(channelId, seq);
    // Messages at or below a confirmed read no longer count anywhere.
    const ledger = seen.get(channelId);
    if (ledger) {
      for (const s of ledger.keys()) if (s <= confirmedRead(channelId)) ledger.delete(s);
      if (ledger.size === 0) seen.delete(channelId);
    }
  };

  /** A channel as shown: confirmed state with pending intents on top. */
  function overlay(c: HubChatChannel): HubChatChannel {
    if (!c.membership) return c;
    let out = c;
    const patches = pendingMembership.get(c.id);
    if (patches?.length) {
      let membership = c.membership;
      for (const p of patches) membership = { ...membership, ...p.patch };
      out = { ...out, membership };
    }
    const pending = pendingReads.get(c.id) ?? [];
    const onScreen = viewed.get(c.id) ?? 0;
    if (pending.length || onScreen) {
      const seq = Math.max(onScreen, ...pending);
      if (seq > (out.membership?.lastReadSeq ?? 0)) {
        out = {
          ...out,
          membership: { ...out.membership!, lastReadSeq: seq },
          ...countsAboveRead(out, seq, seen.get(c.id)),
        };
      }
    }
    return out;
  }

  const emit = () => {
    for (const l of listeners) l();
  };
  /** Republishes the shown list from `base` and the overlays. */
  const publish = (next: Partial<Omit<HubChatSnapshot, 'channels'>> = {}) => {
    snapshot = { ...snapshot, ...next, channels: base.map(overlay) };
    emit();
  };
  const setBase = (channels: HubChatChannel[], next: Partial<HubChatSnapshot> = {}) => {
    base = channels;
    publish(next);
  };

  function refresh(): Promise<void> {
    if (!enabled) return Promise.resolve();
    const state = refreshState;
    if (state.running) {
      state.again = true;
      return state.running;
    }
    const gen = generation;
    const run = (async () => {
      let estimateRetries = 2;
      try {
        do {
          state.again = false;
          const startedAt = clock;
          try {
            const res = await chatApi.channels();
            if (gen !== generation) return;
            const fresh = res.channels ?? [];
            for (const c of fresh) if (c.membership) noteRead(c.id, c.membership.lastReadSeq);
            const { channels, exact } = reconcileChannels(
              fresh,
              base,
              changedSince(startedAt),
              confirmedRead,
            );
            setBase(channels, {
              viewerUserId: res.viewerUserId ?? snapshot.viewerUserId,
              loaded: true,
            });
            if (!exact && estimateRetries-- > 0) state.again = true;
          } catch {
            // Keep the last counts; the next event or reconnect fetches again.
          }
        } while (state.again && gen === generation);
      } finally {
        if (refreshState === state) state.running = null;
      }
    })();
    state.running = run;
    return run;
  }

  /** A channel object from a create/join/DM response for the current account. */
  function upsertChannel(channel: HubChatChannel) {
    if (channel.membership) noteRead(channel.id, channel.membership.lastReadSeq);
    const current = base.find((c) => c.id === channel.id);
    // Sequences and the read pointer still only move forward.
    const { channel: reconciled, exact } = reconcileChannel(
      channel,
      current,
      () => false,
      confirmedRead(channel.id),
    );
    const merged = reconciled ?? channel;
    stamp(channel.id, current ? changedGroups(current, merged) : ['presence']);
    setBase(current ? base.map((c) => (c.id === channel.id ? merged : c)) : [...base, merged]);
    // Counts had to be estimated against newer local state: ask the server.
    if (!exact) void refresh();
  }

  /** A membership object the server confirmed for the viewer. */
  function applyMembership(channelId: string, membership: HubChatMembership) {
    noteRead(channelId, membership.lastReadSeq);
    stamp(channelId, ['membership']);
    let exact = true;
    setBase(
      base.map((c) => {
        if (c.id !== channelId) return c;
        // Preferences from the server; the read position goes through the
        // same commit as every other confirmed read.
        const prefs = {
          ...c,
          membership: { ...membership, lastReadSeq: c.membership?.lastReadSeq ?? 0 },
        };
        const r = withReadPosition(
          prefs,
          Math.max(membership.lastReadSeq, confirmedRead(channelId)),
          seen.get(channelId),
        );
        exact = r.exact;
        return r.channel;
      }),
    );
    if (!exact) void refresh();
  }

  /**
   * Commits a confirmed read (a successful write, a read event) into `base`:
   * the read position and the counts recounted from it, before any overlay
   * that covered it is removed, so nothing it covered can count again. A
   * refetch follows only when the recount had to estimate.
   */
  function confirmRead(channelId: string, seq: number) {
    noteRead(channelId, seq);
    let exact = true;
    setBase(
      base.map((c) => {
        if (c.id !== channelId) return c;
        const r = withReadPosition(c, seq, seen.get(channelId));
        exact = r.exact;
        return r.channel;
      }),
    );
    if (!exact) void refresh();
  }

  function notify(event: HubChatMessageEvent) {
    const message = event.message;
    if (!message || !onNotify) return;
    const notice = hubChatNoticeFor(
      event,
      snapshot.channels.find((c) => c.id === message.channelId),
      {
        viewerUserId: snapshot.viewerUserId,
        viewingChannelId: viewingChannelId === message.channelId ? message.channelId : null,
      },
    );
    if (notice) onNotify(notice);
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot(): HubChatSnapshot {
      return snapshot;
    },
    /** Live message/read events, for the open channel view. */
    subscribeLive(listener: (event: HubChatLiveEvent) => void): () => void {
      liveListeners.add(listener);
      return () => liveListeners.delete(listener);
    },
    setNotifier(fn: ((notice: HubChatNotice) => void) | null) {
      onNotify = fn;
    },
    /** Starts over for a (possibly different) account; resolves after the first fetch. */
    reset(nextEnabled: boolean, viewerUserId: string | null = null): Promise<void> {
      generation += 1;
      enabled = nextEnabled;
      refreshState = { running: null, again: false };
      base = [];
      reads = new Map();
      pendingReads = new Map();
      pendingMembership = new Map();
      seen = new Map();
      viewed = new Map();
      changes = new Map();
      membershipWrites = new Map();
      snapshot = {
        channels: [],
        viewerUserId,
        loaded: false,
        active: nextEnabled,
        account: generation,
      };
      emit();
      return refresh();
    },
    refresh,
    /**
     * After a (re)connect: refetch the list and tell open views to reload
     * their loaded messages, since edits and deletes missed while
     * disconnected are not replayed and do not move the channel's tail.
     */
    resync() {
      if (!enabled) return;
      // Events may have been missed while disconnected (an edit that added a
      // mention, a delete): the live ledger can no longer be trusted.
      seen = new Map();
      void refresh();
      for (const l of liveListeners) l({ type: 'resync' });
    },
    /** The channel open on screen; its messages count as read. */
    setViewing(channelId: string | null) {
      const left = viewingChannelId;
      viewingChannelId = channelId;
      // Off screen, messages that arrived while viewing count again unless a
      // read write covers them.
      if (left && left !== channelId && viewed.delete(left)) publish();
    },
    getViewing(): string | null {
      return viewingChannelId;
    },
    /**
     * The read position the server has, or will have once writes in flight
     * land: confirmed reads and pending read writes, never the on-screen
     * overlay. A view decides whether to write a read against this; the
     * shown pointer already includes what is on screen, so it cannot tell
     * whether the server was told.
     */
    readWritten(channelId: string): number {
      const confirmed = confirmedRead(channelId);
      const serverPointer = base.find((c) => c.id === channelId)?.membership?.lastReadSeq ?? 0;
      return Math.max(confirmed, serverPointer, ...(pendingReads.get(channelId) ?? []));
    },
    /** Handles one `hub_chat_*` WebSocket broadcast. */
    handleWsEvent(data: any) {
      if (!enabled || !data || typeof data.type !== 'string') return;
      const gen = generation;
      switch (data.type) {
        case 'hub_chat_message': {
          const message = data.message as HubChatMessage | undefined;
          if (!message?.channelId) return;
          for (const l of liveListeners) l({ type: 'hub_chat_message', message });
          if (!base.some((c) => c.id === message.channelId)) {
            // A channel this client has not seen yet: the refreshed list
            // already counts the message, so only the notice is left.
            void refresh().then(() => {
              if (gen === generation) notify(data);
            });
            return;
          }
          notify(data);
          const target = base.find((c) => c.id === message.channelId);
          // Already covered by a confirmed read (its write landed before this
          // event): it only moves the tail, in base below and nowhere else.
          const covered =
            !!target?.membership &&
            message.seq <= Math.max(target.membership.lastReadSeq, confirmedRead(target.id));
          if (target?.membership && message.seq > target.lastSeq && !covered) {
            const own = isOwnHubMessage(message, snapshot.viewerUserId);
            // The ledger records how the server counts the message: only the
            // viewer's own posts never count. Being on screen is a local
            // intent, kept as the viewing overlay below, not a fact here.
            const kind: SeenCount = own
              ? 'none'
              : mentionsUser(message, snapshot.viewerUserId)
                ? 'mention'
                : 'unread';
            const ledger = seen.get(message.channelId) ?? new Map<number, SeenCount>();
            ledger.set(message.seq, kind);
            seen.set(message.channelId, ledger);
            if (!own && viewingChannelId === message.channelId) {
              viewed.set(
                message.channelId,
                Math.max(viewed.get(message.channelId) ?? 0, message.seq),
              );
            }
          }
          // Confirmed state counts the message as the server does.
          setBase(
            applyMessageToChannels(base, message, {
              viewerUserId: snapshot.viewerUserId,
              viewingChannelId: null,
            }),
          );
          return;
        }
        case 'hub_chat_message_update': {
          const message = data.message as HubChatMessage | undefined;
          if (!message?.channelId) return;
          for (const l of liveListeners) l({ type: 'hub_chat_message_update', message });
          // An edit can add or remove a mention of the viewer, and the server
          // stops counting a deleted message, so the channel's totals change.
          // When the message was seen live its old and new contribution are
          // known and applied at once; the server's totals follow either way.
          const ledger = seen.get(message.channelId);
          const before = ledger?.get(message.seq);
          if (ledger && before !== undefined && before !== 'none') {
            const after: SeenCount = message.deletedAt
              ? 'none'
              : mentionsUser(message, snapshot.viewerUserId)
                ? 'mention'
                : 'unread';
            ledger.set(message.seq, after);
            const weight = (k: SeenCount) => ({
              unread: k === 'none' ? 0 : 1,
              mention: k === 'mention' ? 1 : 0,
            });
            const dUnread = weight(after).unread - weight(before).unread;
            const dMention = weight(after).mention - weight(before).mention;
            if (dUnread !== 0 || dMention !== 0) {
              setBase(
                base.map((c) =>
                  c.id === message.channelId && message.seq > confirmedRead(c.id)
                    ? {
                        ...c,
                        unreadCount: Math.max(0, c.unreadCount + dUnread),
                        mentionCount: Math.max(0, c.mentionCount + dMention),
                      }
                    : c,
                ),
              );
            }
          }
          if (base.some((c) => c.id === message.channelId)) void refresh();
          return;
        }
        case 'hub_chat_read': {
          const { channelId, lastReadSeq } = data;
          if (typeof channelId !== 'string' || typeof lastReadSeq !== 'number') return;
          for (const l of liveListeners) l({ type: 'hub_chat_read', channelId, lastReadSeq });
          confirmRead(channelId, lastReadSeq);
          return;
        }
        case 'hub_chat_message_meta': {
          // Reactions and pins never change unread state; only views listen.
          const meta = parseMessageMetaEvent(data);
          if (!meta) return;
          const pinChanged = data.pinChanged === true;
          for (const l of liveListeners) l({ type: 'hub_chat_message_meta', meta, pinChanged });
          return;
        }
        case 'hub_chat_notice': {
          // Never stored and never counted; only the open channel shows it.
          for (const notice of parseMentionNotices(data)) {
            for (const l of liveListeners) l({ type: 'hub_chat_notice', notice });
          }
          return;
        }
        case 'hub_chat_channel_update': {
          const channelId = typeof data.channelId === 'string' ? data.channelId : null;
          for (const l of liveListeners) l({ type: 'hub_chat_channel_update', channelId });
          // Agent running state is complete in the event; nothing else changed.
          if (data.reason === 'agent_state' && channelId && data.agentState) {
            setBase(
              applyAgentStateToChannels(base, channelId, data.agentState as HubChatAgentState),
            );
            return;
          }
          // So is the list of mentioned agents still answering.
          const mentionPending =
            data.reason === 'mention_state' ? parseMentionPending(data.mentionPending) : null;
          if (channelId && mentionPending) {
            setBase(applyMentionPendingToChannels(base, channelId, mentionPending));
            return;
          }
          void refresh();
          return;
        }
        default:
      }
    },
    /**
     * The viewer read up to `seq` here. Shown at once as an overlay; call the
     * returned function with the write's outcome. Success confirms it; a
     * failure removes the overlay (the server's position shows again) and
     * refetches.
     */
    markReadLocal(channelId: string, seq: number): (ok: boolean) => void {
      const gen = generation;
      pendingReads.set(channelId, [...(pendingReads.get(channelId) ?? []), seq]);
      publish();
      let settled = false;
      return (ok: boolean) => {
        if (settled || gen !== generation) return;
        settled = true;
        // On success the read is committed into `base` first, then its
        // overlay goes; nothing it covered is ever shown as unread again.
        if (ok) confirmRead(channelId, seq);
        dropViewedUpTo(channelId, seq);
        const list = (pendingReads.get(channelId) ?? []).filter((v, i, a) => i !== a.indexOf(seq));
        if (list.length) pendingReads.set(channelId, list);
        else pendingReads.delete(channelId);
        publish();
        if (!ok) void refresh();
      };
    },
    /**
     * Creates, joins or opens a channel through `request` and adds the
     * channel it returns. If the store was reset in the meantime (sign-out,
     * account or org switch), the response is dropped and null returned, so a
     * late answer can never repopulate another account's rail. Errors for the
     * current account are rethrown.
     */
    async requestChannel(
      request: () => Promise<{ channel?: HubChatChannel } | undefined>,
    ): Promise<HubChatChannel | null> {
      // No account is served (signed out, or between accounts): nothing to add to.
      if (!enabled) return null;
      const gen = generation;
      let res: { channel?: HubChatChannel } | undefined;
      try {
        res = await request();
      } catch (err) {
        if (gen !== generation) return null;
        throw err;
      }
      if (gen !== generation || !res?.channel) return null;
      upsertChannel(res.channel);
      return res.channel;
    },
    /** A membership object the server confirmed (e.g. a membership event). */
    applyMembership,
    /**
     * Changes the viewer's notify level or mute for a channel. The change is
     * an overlay until its write settles, so no refresh or other response can
     * hide it meanwhile. Writes for one channel run one at a time, so the
     * server applies them in the order chosen and each response (a full
     * membership snapshot) reflects every write before it; it is confirmed
     * into `base` while later choices stay on top as overlays. A failed write
     * drops its overlay; if it was the latest, the list is refetched and the
     * error rethrown.
     */
    updateMembership(
      channelId: string,
      patch: MembershipPatch,
      write: () => Promise<{ membership?: HubChatMembership } | undefined>,
    ): Promise<void> {
      const gen = generation;
      const patchId = ++patchIds;
      pendingMembership.set(channelId, [
        ...(pendingMembership.get(channelId) ?? []),
        { id: patchId, patch },
      ]);
      publish();
      const dropPatch = () => {
        const left = (pendingMembership.get(channelId) ?? []).filter((p) => p.id !== patchId);
        if (left.length) pendingMembership.set(channelId, left);
        else pendingMembership.delete(channelId);
      };
      const queue = membershipWrites.get(channelId) ?? { tail: Promise.resolve(), latest: 0 };
      membershipWrites.set(channelId, queue);
      const id = ++queue.latest;
      const run = queue.tail.then(async () => {
        if (gen !== generation) return;
        let res: { membership?: HubChatMembership } | undefined;
        try {
          res = await write();
        } catch (err) {
          if (gen !== generation) return;
          dropPatch();
          if (id !== queue.latest) {
            publish();
            return;
          }
          publish();
          void refresh();
          throw err;
        }
        if (gen !== generation) return;
        dropPatch();
        if (res?.membership) applyMembership(channelId, res.membership);
        else publish();
      });
      queue.tail = run.catch(() => {});
      return run;
    },
    removeChannel(channelId: string) {
      stamp(channelId, ['presence']);
      pendingReads.delete(channelId);
      pendingMembership.delete(channelId);
      seen.delete(channelId);
      viewed.delete(channelId);
      setBase(base.filter((c) => c.id !== channelId));
    },
  };
}

export type HubChatStore = ReturnType<typeof createHubChatStore>;

/** The Agent Hub side's badge, same rule as the web rail and push. */
export function hubChatBadge(snapshot: HubChatSnapshot, now: number = Date.now()): number {
  return hubChatBadgeCount(snapshot.channels, now);
}
