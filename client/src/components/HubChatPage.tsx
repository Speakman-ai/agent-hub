import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  BellOff,
  Bot,
  Check,
  Compass,
  Link2,
  Loader2,
  MessageSquarePlus,
  Lock,
  Pencil,
  Plus,
  Send,
  Settings,
  Ticket,
  Trash2,
} from 'lucide-react';
import type { SessionWire } from '@shared/types';
import type { CaptureCardDraft } from '@shared/utils/captureCard';
import {
  buildHubChatCardDraft,
  buildHubChatSessionSeed,
  hubChatMessageHash,
  type HubChatCaptureInput,
} from '@shared/utils/hubChatCapture';
import StartSessionModal from './StartSessionModal';
import HubChatTriggerCard from './HubChatTriggerCard';
import HubChatSearch from './HubChatSearch';
import { readChatTriggerCard } from '@shared/utils/chatTriggers';
import CaptureToTicketModal from './CaptureToTicketModal';
import { api } from '../utils/api';
import { isSubmitEnter } from '../utils/keyboard';
import { formatDateTime, formatTime } from '../utils/time';
import { avatarInitials } from '../utils/googleChatLayout';
import { HubChatMentionInput, HubChatMessageBody, type HubChatRefOpenHandler } from './HubChatRefs';
import {
  decodeToComposer,
  encodeComposerMentions,
  refsToPlainText,
} from '@shared/utils/hubChatRefs';
import { locateChatMarkdownCode } from '../utils/hubChatMarkdown';
import {
  clearSentDraft,
  setPendingSend,
  updateHubChatSession,
  useHubChatSession,
  nextAttempt,
  getHubChatSession,
  focusHubChatMessage,
  type HubChatEditState,
} from '../utils/hubChatSession';
import {
  HUB_ASSISTANT_CHANNEL_ID,
  selectHubAssistantDm,
  useHubAssistantUnread,
} from '../utils/hubAssistantChat';
import {
  BrowseChannelsDialog,
  ChannelSettingsDialog,
  NewChannelDialog,
  NewDmDialog,
} from './HubChatDialogs';
import {
  RAIL_SECTIONS,
  applyMessageToChannels,
  applyReadToChannels,
  authorLabel,
  channelLabel,
  isChannelMuted,
  layoutHubChatMessages,
  mergeIntoWindow,
  railUnread,
  changedGroups,
  reconcileChannel,
  reconcileMembership,
  reconcileChannels,
  sectionChannels,
  agentChannelStatus,
  applyAgentStateToChannels,
  type HubChatAgentState,
  type HubChatChannel,
  type HubChatMessage,
  type HubChatOrgMember,
  type HubChatMembership,
  type MessageWindow,
  type ChannelFieldGroup,
} from '../utils/hubChat';
import { formatHubChatRefToken } from '@shared/utils/hubChatRefTokens';

const PAGE = 50;
const TOOL_BUTTON =
  'inline-flex h-7 w-7 items-center justify-center rounded-full text-gray-400 hover:bg-gray-700 hover:text-white';
/** Page size when loading history back to a linked message (the server's max). */
const SEEK_PAGE = 100;
/**
 * Pages one step of a link may load before asking the user to continue, so a
 * link thousands of messages back cannot silently fetch the whole history.
 */
const SEEK_PAGES_PER_STEP = 10;
const LINK_GONE = 'The linked message is no longer in this conversation.';

/** Absolute URL that reopens a message in the Hub Chat pane. */
export function hubChatMessageUrl(channelId: string, messageId: string): string | null {
  const hash = hubChatMessageHash(channelId, messageId);
  if (!hash || typeof window === 'undefined') return hash;
  return `${window.location.origin}${window.location.pathname}${hash}`;
}

/** What Send to agent / Create ticket need from the picked messages. Exported for tests. */
export function hubChatCaptureInput(
  channelId: string,
  channelName: string | null,
  picked: HubChatMessage[],
  usernames: ReadonlyMap<string, string>,
): HubChatCaptureInput {
  const first = picked[0];
  return {
    channelId,
    channelLabel: channelName,
    link: first ? hubChatMessageUrl(channelId, first.id) : null,
    messages: picked.map((m) => ({
      id: m.id,
      sender: authorLabel(m, usernames),
      createdAt: formatDateTime(m.createdAt),
      body: m.body,
      plainText: refsToPlainText(m.body, locateChatMarkdownCode),
    })),
  };
}
/** Reconnect catch-up pages forward this many times, then reloads the latest page. */
const CATCHUP_PAGE = 100;
const MAX_CATCHUP_PAGES = 10;

// Literal class names so Tailwind keeps them in the build.
const AVATAR_COLORS = [
  'bg-rose-600',
  'bg-orange-600',
  'bg-amber-600',
  'bg-lime-700',
  'bg-emerald-600',
  'bg-teal-600',
  'bg-cyan-700',
  'bg-sky-600',
  'bg-indigo-600',
  'bg-violet-600',
];

function avatarColorFor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? 'Request failed');
}

function isPageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

interface View extends MessageWindow {
  channelId: string;
  /**
   * Which opening of the channel this is. A channel can be left and reopened,
   * so responses are matched to the opening that asked, never by channel id.
   */
  generation: number;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  /** Read position when the channel was opened; keeps the Unread line still while reading. */
  dividerSeq: number | null;
}

function emptyView(channelId: string, dividerSeq: number | null, generation: number): View {
  return {
    channelId,
    generation,
    messages: [],
    revisions: {},
    loading: true,
    loaded: false,
    error: null,
    hasOlder: false,
    loadingOlder: false,
    dividerSeq,
  };
}

type DialogKind = 'channel' | 'dm' | 'browse' | 'settings' | null;

/** Agent channel header: running state plus a chip for the linked session. */
function AgentChannelHeaderState({
  state,
  onOpenRef,
}: {
  state: HubChatAgentState | null | undefined;
  onOpenRef?: HubChatRefOpenHandler;
}) {
  const chip =
    state?.sessionId &&
    formatHubChatRefToken(state.sessionName || 'Session', 'session', state.sessionId);
  return (
    <div
      className="flex shrink-0 items-center gap-2 text-xs text-gray-400"
      data-testid="hub-chat-agent-state"
      data-running={state?.running ? 'true' : 'false'}
    >
      <span className="inline-flex items-center gap-1" role="status">
        {state?.running ? (
          <Loader2 size={12} className="animate-spin text-blue-400" aria-hidden />
        ) : (
          <Bot size={12} aria-hidden />
        )}
        {agentChannelStatus(state)}
      </span>
      {chip && (
        <span className="max-w-[12rem] truncate">
          <HubChatMessageBody body={chip} onOpenRef={onOpenRef} />
        </span>
      )}
    </div>
  );
}

export default function HubChatPage({
  onOpenRef,
  onSessionStarted,
  assistantEnabled = false,
  assistant = null,
}: {
  onOpenRef?: HubChatRefOpenHandler;
  /** Called with the session Send to agent started, so the app can open it. */
  onSessionStarted?: (session: SessionWire) => void;
  /** Shows the pinned Agent Hub DM at the top of the rail. */
  assistantEnabled?: boolean;
  /**
   * The Hub assistant transcript and composer, rendered when the pinned DM is
   * open. Null while the same transcript is mounted elsewhere (the assistant
   * column), since it can only be on screen once.
   */
  assistant?: ReactNode;
} = {}) {
  // Channel list, open view and viewer id each live in a ref that every
  // write updates synchronously; React state only mirrors the ref for
  // rendering. Writes are applied to the latest value, never to a snapshot
  // from the last render, so several writes before a render all land, and
  // any decision made between writes sees the ones before it.
  const channelsRef = useRef<HubChatChannel[]>([]);
  const [channels, setChannelsState] = useState<HubChatChannel[]>([]);
  const setChannels = useCallback(
    (next: HubChatChannel[] | ((prev: HubChatChannel[]) => HubChatChannel[])) => {
      const value = typeof next === 'function' ? next(channelsRef.current) : next;
      if (value === channelsRef.current) return;
      channelsRef.current = value;
      setChannelsState(value);
    },
    [],
  );
  const viewerRef = useRef<string | null>(null);
  const [viewerUserId, setViewerUserIdState] = useState<string | null>(null);
  const setViewerUserId = useCallback((id: string | null) => {
    viewerRef.current = id;
    setViewerUserIdState(id);
  }, []);
  const [orgMembers, setOrgMembers] = useState<HubChatOrgMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const viewRef = useRef<View | null>(null);
  const [view, setViewState] = useState<View | null>(null);
  const setView = useCallback((next: View | null | ((prev: View | null) => View | null)) => {
    const value = typeof next === 'function' ? next(viewRef.current) : next;
    if (value === viewRef.current) return;
    viewRef.current = value;
    setViewState(value);
  }, []);
  // Per-channel drafts, sends and the open edit outlive this page (see
  // hubChatSession.ts), so late responses and remounts never lose user input.
  const { selectedId, drafts, draftMentions, pendingSends, sendErrors, editing, focus } =
    useHubChatSession();
  const setSelectedId = (id: string | null) =>
    updateHubChatSession((s) => (s.selectedId === id ? s : { ...s, selectedId: id }));
  const setEditing = (
    next: HubChatEditState | null | ((cur: HubChatEditState | null) => HubChatEditState | null),
  ) =>
    updateHubChatSession((s) => ({
      ...s,
      editing: typeof next === 'function' ? next(s.editing) : next,
    }));
  const setSendError = (channelId: string, error: string | null) =>
    updateHubChatSession((s) => {
      const { [channelId]: _old, ...rest } = s.sendErrors;
      return { ...s, sendErrors: error ? { ...rest, [channelId]: error } : rest };
    });
  const [dialog, setDialog] = useState<DialogKind>(null);
  // Messages ticked for a bulk Send to agent / Create ticket, by id. Scoped to
  // the open channel so one dispatch never mixes channels.
  const [picked, setPicked] = useState<{ channelId: string; ids: ReadonlySet<string> } | null>(
    null,
  );
  const [ticketDraft, setTicketDraft] = useState<CaptureCardDraft | null>(null);
  const [dispatch, setDispatch] = useState<{ label: string; seed: string } | null>(null);
  const [copied, setCopied] = useState<{ id: string; ok: boolean } | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // Work that outlives the page (a history load, reconnect catch-up) must
  // not act on a view nobody sees. Unmounting drops the current view from the
  // ref, so every generation check fails and late responses are ignored.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      viewRef.current = null;
    };
  }, []);

  // The session store updates synchronously, so it is read directly.
  const currentSelectedId = () => getHubChatSession().selectedId;
  const listEndRef = useRef<HTMLDivElement | null>(null);

  const usernames = useMemo(
    () => new Map(orgMembers.map((m) => [m.userId, m.username])),
    [orgMembers],
  );
  const sections = useMemo(
    () => sectionChannels(channels, usernames, viewerUserId),
    [channels, usernames, viewerUserId],
  );
  const selected = channels.find((c) => c.id === selectedId) ?? null;
  const assistantSelected = assistantEnabled && selectedId === HUB_ASSISTANT_CHANNEL_ID;
  const assistantUnread = useHubAssistantUnread();

  // The channel list is a server snapshot, while live events and the
  // user's own actions change channels in between. Local changes stamp the
  // field group they touch; reconcileChannels keeps those groups and merges
  // the rest, and asks for one more fetch when a count had to be estimated.
  // Fetches run one at a time, and any request made meanwhile becomes one
  // follow-up, so the latest fetch always started after every change it
  // must account for.
  const channelClockRef = useRef({
    now: 0,
    touched: new Map<string, number>(),
  });
  const stampChannel = useCallback((channelId: string, groups: ChannelFieldGroup[]) => {
    const clock = channelClockRef.current;
    clock.now += 1;
    for (const g of groups) clock.touched.set(`${channelId}:${g}`, clock.now);
  }, []);
  /**
   * Server state the client applies is newer than every request issued
   * before it. Stamp each field group a refresh or response actually changed
   * (including a channel appearing or disappearing), so a delayed response
   * to an older request cannot overwrite it, whatever its source.
   */
  const stampApplied = useCallback(
    (before: HubChatChannel[], after: HubChatChannel[]) => {
      const prevById = new Map(before.map((c) => [c.id, c]));
      const nextById = new Map(after.map((c) => [c.id, c]));
      for (const id of new Set([...prevById.keys(), ...nextById.keys()])) {
        const groups = changedGroups(prevById.get(id), nextById.get(id));
        if (groups.length) stampChannel(id, groups);
      }
    },
    [stampChannel],
  );
  const changeChannels = useCallback(
    (
      channelId: string,
      groups: ChannelFieldGroup[],
      fn: (prev: HubChatChannel[]) => HubChatChannel[],
    ) => {
      if (groups.length) stampChannel(channelId, groups);
      setChannels(fn);
    },
    [stampChannel, setChannels],
  );
  // Server-confirmed read pointers, and the one write in flight per channel.
  // Snapshots merge against these, not the optimistic pointer the rail shows.
  const readRef = useRef({
    confirmed: new Map<string, number>(),
    pending: new Map<string, number>(),
  });
  const localRead = useCallback((channelId: string) => {
    const { confirmed, pending } = readRef.current;
    return Math.max(confirmed.get(channelId) ?? 0, pending.get(channelId) ?? 0);
  }, []);
  const confirmRead = useCallback((channelId: string, seq: number) => {
    const { confirmed } = readRef.current;
    if (seq > (confirmed.get(channelId) ?? 0)) confirmed.set(channelId, seq);
  }, []);
  /** Records the read pointer of a channel object that came from the server. */
  const confirmChannel = useCallback(
    (c: HubChatChannel) => {
      if (c.membership) confirmRead(c.id, c.membership.lastReadSeq);
    },
    [confirmRead],
  );

  const clockNow = useCallback(() => channelClockRef.current.now, []);

  const refreshStateRef = useRef({ running: false, again: false });
  const refreshChannels = useCallback(async () => {
    const state = refreshStateRef.current;
    if (state.running) {
      state.again = true;
      return;
    }
    state.running = true;
    // Estimates converge in a follow-up; bound it so steady traffic cannot
    // keep the loop busy.
    let estimateRetries = 2;
    try {
      do {
        state.again = false;
        const issuedAt = channelClockRef.current.now;
        try {
          const res = await api.hubChat.channels();
          const { touched } = channelClockRef.current;
          const changedSince = (id: string, g: ChannelFieldGroup) =>
            (touched.get(`${id}:${g}`) ?? 0) > issuedAt;
          const fresh: HubChatChannel[] = res.channels ?? [];
          fresh.forEach(confirmChannel);
          const { channels: merged, exact } = reconcileChannels(
            fresh,
            channelsRef.current,
            changedSince,
            localRead,
          );
          stampApplied(channelsRef.current, merged);
          setChannels(merged);
          if (!exact && estimateRetries-- > 0) state.again = true;
          if (res.viewerUserId) setViewerUserId(res.viewerUserId);
          setLoadError(null);
        } catch (err) {
          setLoadError(errorText(err));
        }
      } while (state.again);
    } finally {
      state.running = false;
      setLoading(false);
    }
  }, [confirmChannel, localRead, setChannels, setViewerUserId, stampApplied]);

  /**
   * The one way a single server channel object enters the rail (settings,
   * join, create and DM responses). It reconciles like a list refresh: the
   * response wins except for field groups changed locally after `issuedAt`,
   * sequences only move forward, and an estimated count triggers a refresh.
   * `own` are the groups this response is the result of; stamping them keeps
   * an older refresh still in flight from undoing it.
   */
  const ingestChannel = useCallback(
    (fresh: HubChatChannel, issuedAt: number, own: ChannelFieldGroup[]) => {
      confirmChannel(fresh);
      // Decide which groups changed locally since the request before this
      // response stamps its own groups, or it would count itself as newer.
      const { touched } = channelClockRef.current;
      const changedBefore: Record<ChannelFieldGroup, boolean> = {
        presence: (touched.get(`${fresh.id}:presence`) ?? 0) > issuedAt,
        meta: (touched.get(`${fresh.id}:meta`) ?? 0) > issuedAt,
        membership: (touched.get(`${fresh.id}:membership`) ?? 0) > issuedAt,
      };
      const changed = (g: ChannelFieldGroup) => changedBefore[g];
      // A response superseded by a local removal is dropped whole: nothing is
      // stamped, inserted or opened.
      const r = reconcileChannel(
        fresh,
        channelsRef.current.find((c) => c.id === fresh.id),
        changed,
        localRead(fresh.id),
      );
      const channel = r.channel;
      if (!channel) return null;
      stampApplied(
        channelsRef.current.filter((c) => c.id === fresh.id),
        [channel],
      );
      changeChannels(fresh.id, own, (prev) =>
        prev.some((c) => c.id === fresh.id)
          ? prev.map((c) => (c.id === fresh.id ? channel : c))
          : [...prev, channel],
      );
      if (!r.exact) void refreshChannels();
      return channel;
    },
    [changeChannels, confirmChannel, localRead, refreshChannels, stampApplied],
  );

  /** The same, for a membership object (settings response or live event). */
  const ingestMembership = useCallback(
    (channelId: string, membership: HubChatMembership, issuedAt: number) => {
      confirmRead(channelId, membership.lastReadSeq);
      const changedSince =
        (channelClockRef.current.touched.get(`${channelId}:membership`) ?? 0) > issuedAt;
      changeChannels(channelId, ['membership'], (prev) =>
        prev.map((c) =>
          c.id === channelId
            ? reconcileMembership(c, membership, changedSince, localRead(channelId))
            : c,
        ),
      );
    },
    [changeChannels, confirmRead, localRead],
  );

  const membersRequestRef = useRef(0);
  const refreshMembers = useCallback(async () => {
    // Only the latest request may set the list; an earlier one can resolve last.
    const request = ++membersRequestRef.current;
    try {
      const res = await api.hubChat.members();
      if (request !== membersRequestRef.current) return;
      setOrgMembers(res.members ?? []);
    } catch {
      // Names fall back to "Unknown user"; the rail still works.
    }
  }, []);

  useEffect(() => {
    void refreshChannels();
    void refreshMembers();
  }, [refreshChannels, refreshMembers]);

  /** Moves the read pointer to `seq` when the viewer is looking at the channel. */
  /**
   * Moves the read pointer when the viewer is looking at the channel. The
   * rail shows it at once, but it counts as read progress only once the
   * server confirms (see readRef). A rejected write is dropped, the refresh
   * restores the server's pointer, and the next view of the channel (open,
   * new message, focus, reconnect) writes it again.
   */
  const markRead = useCallback(
    (channelId: string, seq: number) => {
      // Only a mounted page is showing anything; never mark read otherwise.
      if (!mountedRef.current) return;
      const channel = channelsRef.current.find((c) => c.id === channelId);
      if (!channel?.membership || seq <= localRead(channelId)) return;
      const { pending } = readRef.current;
      pending.set(channelId, seq);
      changeChannels(channelId, [], (prev) => applyReadToChannels(prev, channelId, seq) ?? prev);
      api.hubChat
        .markRead(channelId, seq)
        .then((res: { lastReadSeq?: number }) => {
          confirmRead(channelId, typeof res?.lastReadSeq === 'number' ? res.lastReadSeq : seq);
          if (pending.get(channelId) === seq) pending.delete(channelId);
        })
        .catch(() => {
          if (pending.get(channelId) === seq) pending.delete(channelId);
          void refreshChannels();
        });
    },
    [changeChannels, confirmRead, localRead, refreshChannels],
  );

  // Every response that writes into the view (history pages, reconcile,
  // send) goes through updateView with the generation it was requested for,
  // so a reply meant for an earlier opening is dropped. Live events describe
  // the channel as it is now and stay keyed by channel id.
  const generationRef = useRef(0);
  const isCurrentView = useCallback(
    (generation: number) => viewRef.current?.generation === generation,
    [],
  );
  const updateView = useCallback(
    (generation: number, fn: (v: View) => View) => {
      setView((v) => (v && v.generation === generation ? fn(v) : v));
    },
    [setView],
  );

  const loadMessages = useCallback(
    async (channelId: string, generation: number) => {
      try {
        const res = await api.hubChat.messages(channelId, { limit: PAGE });
        if (!isCurrentView(generation)) return;
        const messages: HubChatMessage[] = res.messages ?? [];
        updateView(generation, (v) => ({
          ...v,
          ...mergeIntoWindow(v, messages, true),
          loading: false,
          loaded: true,
          error: null,
          hasOlder: !!res.hasMore,
        }));
        const tail = messages[messages.length - 1];
        if (tail && isPageVisible()) markRead(channelId, tail.seq);
      } catch (err) {
        updateView(generation, (v) => ({ ...v, loading: false, error: errorText(err) }));
      }
    },
    [isCurrentView, markRead, updateView],
  );

  const openChannel = useCallback(
    (channelId: string, known?: HubChatChannel) => {
      const channel = known ?? channelsRef.current.find((c) => c.id === channelId);
      setSelectedId(channelId);
      generationRef.current += 1;
      const generation = generationRef.current;
      const next = emptyView(channelId, channel?.membership?.lastReadSeq ?? null, generation);
      setView(next);
      void loadMessages(channelId, generation);
    },
    [loadMessages, setView],
  );

  // The open conversation is always one in the channel list. When the list
  // arrives, reopen the channel the user had (it survives a remount), else
  // the first. When the open channel leaves the list (left, removed, gone
  // from a refresh), move to the first remaining one.
  useEffect(() => {
    if (loading) return;
    if (assistantSelected) return;
    const open = viewRef.current;
    if (open && channels.some((c) => c.id === open.channelId)) return;
    const kept = !open && selectedId ? channels.find((c) => c.id === selectedId) : undefined;
    const pick = kept ?? RAIL_SECTIONS.map((s) => sections[s.id][0]).find(Boolean);
    if (pick) {
      openChannel(pick.id, pick);
    } else if (open) {
      setView(null);
      setSelectedId(null);
    }
  }, [loading, view, selectedId, channels, sections, openChannel, setView, assistantSelected]);

  const openAssistant = () => {
    // Retire the open channel's view so its in-flight loads are dropped.
    generationRef.current += 1;
    setView(null);
    selectHubAssistantDm();
  };

  /**
   * Brings the open conversation back in line with the server after the
   * socket was down. Re-reads the whole loaded window from its first seq, not
   * just what came after the tail, so edits and deletions missed while
   * offline are picked up along with new messages. Past MAX_CATCHUP_PAGES it
   * reloads the latest page instead, which keeps the list contiguous and
   * leaves the rest to Load older.
   */
  const reconcileView = useCallback(async () => {
    const open = viewRef.current;
    if (!open) return;
    const { channelId, generation } = open;
    const stillOpen = () => isCurrentView(generation);
    try {
      if (!open.messages.length) {
        await loadMessages(channelId, generation);
        return;
      }
      let cursor = open.messages[0].seq - 1;
      const fetched: HubChatMessage[] = [];
      for (let page = 0; page < MAX_CATCHUP_PAGES; page++) {
        const res = await api.hubChat.messages(channelId, {
          after: cursor,
          limit: CATCHUP_PAGE,
        });
        if (!stillOpen()) return;
        const batch: HubChatMessage[] = res.messages ?? [];
        fetched.push(...batch);
        const tail = batch[batch.length - 1];
        if (!res.hasMore || !tail) {
          updateView(generation, (cur) => ({ ...cur, ...mergeIntoWindow(cur, fetched, true) }));
          const newest = fetched[fetched.length - 1];
          if (newest && isPageVisible()) markRead(channelId, newest.seq);
          return;
        }
        cursor = tail.seq;
      }
      const res = await api.hubChat.messages(channelId, { limit: PAGE });
      if (!stillOpen()) return;
      const latest: HubChatMessage[] = res.messages ?? [];
      updateView(generation, (cur) => ({
        ...cur,
        // Drop the stale head; revisions keep live edits that landed during
        // the request.
        ...mergeIntoWindow(
          {
            messages: cur.messages.filter((m) => latest.length > 0 && m.seq >= latest[0].seq),
            revisions: cur.revisions,
          },
          latest,
          true,
        ),
        hasOlder: !!res.hasMore,
      }));
      const newest = latest[latest.length - 1];
      if (newest && isPageVisible()) markRead(channelId, newest.seq);
    } catch {
      // The next reconnect or channel open retries.
    }
  }, [isCurrentView, loadMessages, markRead, updateView]);

  const loadOlder = async () => {
    const v = viewRef.current;
    if (!v || v.loadingOlder || !v.messages.length) return;
    const { channelId, generation } = v;
    updateView(generation, (cur) => ({ ...cur, loadingOlder: true }));
    try {
      const res = await api.hubChat.messages(channelId, {
        before: v.messages[0].seq,
        limit: PAGE,
      });
      updateView(generation, (cur) => ({
        ...cur,
        ...mergeIntoWindow(cur, res.messages ?? [], true),
        hasOlder: !!res.hasMore,
        loadingOlder: false,
      }));
    } catch (err) {
      updateView(generation, (cur) => ({ ...cur, loadingOlder: false, error: errorText(err) }));
    }
  };

  // Live updates. App.tsx re-dispatches the membership-filtered WS events on
  // window, so this pane never holds its own socket.
  useEffect(() => {
    const onMessage = (e: Event) => {
      const data = (e as CustomEvent).detail ?? {};
      const message = data.message as HubChatMessage | undefined;
      if (!message?.channelId) return;
      const viewing = currentSelectedId() === message.channelId && isPageVisible();
      if (!channelsRef.current.some((c) => c.id === message.channelId)) {
        void refreshChannels();
        return;
      }
      changeChannels(message.channelId, [], (prev) =>
        applyMessageToChannels(prev, message, {
          viewerUserId: viewerRef.current,
          viewingChannelId: viewing ? message.channelId : null,
        }),
      );
      if (currentSelectedId() === message.channelId) {
        setView((v) =>
          v && v.channelId === message.channelId
            ? { ...v, ...mergeIntoWindow(v, [message], true) }
            : v,
        );
        if (viewing) markRead(message.channelId, message.seq);
      }
    };
    const onMessageUpdate = (e: Event) => {
      const message = (e as CustomEvent).detail?.message as HubChatMessage | undefined;
      if (!message?.channelId) return;
      setView((v) =>
        // Recorded even when the message is not loaded yet, so a history page
        // still in flight cannot show the old body when it lands.
        v && v.channelId === message.channelId
          ? { ...v, ...mergeIntoWindow(v, [message], false) }
          : v,
      );
    };
    const onRead = (e: Event) => {
      const { channelId, lastReadSeq } = (e as CustomEvent).detail ?? {};
      if (typeof channelId !== 'string' || typeof lastReadSeq !== 'number') return;
      confirmRead(channelId, lastReadSeq);
      // A read short of the tail needs the server for the remaining count.
      const reachesTail = applyReadToChannels(channelsRef.current, channelId, lastReadSeq);
      if (!reachesTail) {
        void refreshChannels();
        return;
      }
      changeChannels(
        channelId,
        [],
        (prev) => applyReadToChannels(prev, channelId, lastReadSeq) ?? prev,
      );
    };
    const onChannelUpdate = (e: Event) => {
      const data = (e as CustomEvent).detail ?? {};
      const removedMe =
        data.reason === 'member_removed' &&
        Array.isArray(data.userIds) &&
        data.userIds.includes(viewerRef.current);
      // Drop it from the rail now, stamped so a refresh already in flight
      // cannot bring it back; the selection effect then moves the view.
      if (removedMe && data.channelId) {
        changeChannels(data.channelId, ['presence'], (prev) =>
          prev.filter((c) => c.id !== data.channelId),
        );
      }
      if (data.reason === 'agent_state' && data.agentState && data.channelId) {
        const state = data.agentState as HubChatAgentState;
        changeChannels(data.channelId, [], (prev) =>
          applyAgentStateToChannels(prev, data.channelId, state),
        );
        return;
      }
      if (data.reason === 'membership' && data.membership && data.channelId) {
        // A live event is the server's current value, newer than any change
        // stamped so far.
        ingestMembership(data.channelId, data.membership, clockNow());
        return;
      }
      void refreshChannels();
      if (data.reason === 'member_added' || data.reason === 'created') void refreshMembers();
    };
    const onReconnect = () => {
      void refreshChannels();
      const v = viewRef.current;
      if (v) void reconcileView();
    };
    const onVisible = () => {
      if (!isPageVisible()) return;
      const v = viewRef.current;
      const last = v?.messages[v.messages.length - 1];
      if (v && last) markRead(v.channelId, last.seq);
    };
    window.addEventListener('hub_chat_message', onMessage);
    window.addEventListener('hub_chat_message_update', onMessageUpdate);
    window.addEventListener('hub_chat_read', onRead);
    window.addEventListener('hub_chat_channel_update', onChannelUpdate);
    window.addEventListener('agenthub:ws_reconnected', onReconnect);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('hub_chat_message', onMessage);
      window.removeEventListener('hub_chat_message_update', onMessageUpdate);
      window.removeEventListener('hub_chat_read', onRead);
      window.removeEventListener('hub_chat_channel_update', onChannelUpdate);
      window.removeEventListener('agenthub:ws_reconnected', onReconnect);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [
    changeChannels,
    clockNow,
    ingestMembership,
    confirmRead,
    reconcileView,
    markRead,
    refreshChannels,
    refreshMembers,
    setView,
  ]);

  const messageCount = view?.messages.length ?? 0;
  const lastMessageId = view?.messages[messageCount - 1]?.id;
  useEffect(() => {
    listEndRef.current?.scrollIntoView?.({ block: 'end' });
  }, [lastMessageId, selectedId]);

  const send = async () => {
    const channelId = selectedId;
    if (!channelId) return;
    const draftText = drafts[channelId] ?? '';
    if (!draftText.trim() || pendingSends.has(channelId)) return;
    const body = encodeComposerMentions(
      draftText,
      draftMentions[channelId] ?? [],
      locateChatMarkdownCode,
    );
    setPendingSend(channelId, true);
    setSendError(channelId, null);
    // The opening this was sent from; if the channel was reopened since, the
    // new opening's load or the live echo shows the post instead.
    const sentFrom = viewRef.current?.channelId === channelId ? viewRef.current.generation : -1;
    try {
      const res = await api.hubChat.post(channelId, body);
      const message = res.message as HubChatMessage;
      // Keep anything typed while the request was in flight.
      clearSentDraft(channelId, draftText);
      updateView(sentFrom, (v) => ({ ...v, ...mergeIntoWindow(v, [message], true) }));
      changeChannels(channelId, [], (prev) =>
        applyMessageToChannels(prev, message, {
          viewerUserId: viewerRef.current,
          viewingChannelId: channelId,
        }),
      );
    } catch (err) {
      setSendError(channelId, errorText(err));
    } finally {
      setPendingSend(channelId, false);
    }
  };

  /** Merges a message into the view only if that view is still its channel. */
  const mergeIntoOwnChannel = (message: HubChatMessage) =>
    setView((v) =>
      v && v.channelId === message.channelId
        ? { ...v, ...mergeIntoWindow(v, [message], false) }
        : v,
    );

  const saveEdit = async () => {
    if (!editing || !editing.text.trim()) return;
    const { id, text, mentions } = editing;
    const attempt = nextAttempt();
    setEditing({ ...editing, saving: true, error: null, attempt });
    try {
      const res = await api.hubChat.edit(
        id,
        encodeComposerMentions(text, mentions, locateChatMarkdownCode),
      );
      // The saved revision applies whatever editor is open now.
      mergeIntoOwnChannel(res.message as HubChatMessage);
      setEditing((cur) => (cur?.attempt === attempt ? null : cur));
    } catch (err) {
      setEditing((cur) =>
        cur?.attempt === attempt ? { ...cur, saving: false, error: errorText(err) } : cur,
      );
    }
  };

  const deleteMessage = async (message: HubChatMessage) => {
    if (typeof window !== 'undefined' && !window.confirm('Delete this message?')) return;
    const generation = viewRef.current?.generation ?? -1;
    try {
      const res = await api.hubChat.remove(message.id);
      mergeIntoOwnChannel(res.message as HubChatMessage);
    } catch (err) {
      updateView(generation, (v) => ({ ...v, error: errorText(err) }));
    }
  };

  const joinSelected = async () => {
    if (!selectedId) return;
    const issuedAt = clockNow();
    try {
      const res = await api.hubChat.join(selectedId);
      ingestChannel(res.channel, issuedAt, ['presence']);
    } catch (err) {
      setSendError(selectedId, errorText(err));
    }
  };

  const adoptChannel = (channel: HubChatChannel, issuedAt: number) => {
    setDialog(null);
    const adopted = ingestChannel(channel, issuedAt, ['presence']);
    if (adopted) openChannel(adopted.id, adopted);
  };

  const rows = useMemo(
    () =>
      view
        ? layoutHubChatMessages(view.messages, {
            viewerUserId,
            lastReadSeq: view.dividerSeq,
          })
        : [],
    [view, viewerUserId],
  );

  // A message link (Copy link, a card's origin) asked to show a message. The
  // effect opens its channel; once that is loaded, seekMessage looks the
  // message up to learn its seq, then loads exactly the history between the
  // loaded window and that seq. A missing message is reported as such, never
  // inferred from how far back the search went.
  //
  // Each link gets a token. Its async work (lookup, history pages, Keep
  // loading) acts only while the token is current and the view is the one it
  // started on; a newer link, Stop, or opening another channel supersedes it,
  // so the latest navigation always wins.
  const focusFetchRef = useRef<string | null>(null);
  const linkRef = useRef<{ token: number; focus: unknown }>({ token: 0, focus: null });
  /** A link whose message is further back than one step loads; offers Keep loading. */
  const [seekPending, setSeekPending] = useState<{
    token: number;
    generation: number;
    messageId: string;
    seq: number;
  } | null>(null);
  const clearFocus = () => updateHubChatSession((st) => (st.focus ? { ...st, focus: null } : st));
  const supersedeLink = () => {
    linkRef.current = { token: linkRef.current.token + 1, focus: linkRef.current.focus };
    setSeekPending(null);
    return linkRef.current.token;
  };
  const linkLive = (token: number, generation: number) =>
    linkRef.current.token === token && viewRef.current?.generation === generation;

  /**
   * Loads older pages until the window reaches `seq` or the step's page
   * allowance is used. Returns whether the message is now loaded, or null if
   * the link was superseded or a page failed.
   */
  const loadBackTo = async (
    token: number,
    generation: number,
    seq: number,
  ): Promise<boolean | null> => {
    for (let page = 0; page < SEEK_PAGES_PER_STEP; page++) {
      if (!linkLive(token, generation)) return null;
      const v = viewRef.current as View;
      const head = v.messages[0]?.seq;
      if (head === undefined || head <= seq || !v.hasOlder) return true;
      updateView(generation, (cur) => ({ ...cur, loadingOlder: true }));
      try {
        const res = await api.hubChat.messages(v.channelId, { before: head, limit: SEEK_PAGE });
        // The page is contiguous history, so it is kept even when the link
        // was superseded meanwhile; only the link's own follow-up stops.
        updateView(generation, (cur) => ({
          ...cur,
          ...mergeIntoWindow(cur, res.messages ?? [], true),
          hasOlder: !!res.hasMore,
          loadingOlder: false,
        }));
      } catch (err) {
        updateView(generation, (cur) => ({
          ...cur,
          loadingOlder: false,
          ...(linkLive(token, generation) ? { error: errorText(err) } : {}),
        }));
        return null;
      }
    }
    if (!linkLive(token, generation)) return null;
    const v = viewRef.current as View;
    const head = v.messages[0]?.seq;
    return head === undefined || head <= seq || !v.hasOlder;
  };

  const finishSeek = async (token: number, generation: number, messageId: string, seq: number) => {
    const done = await loadBackTo(token, generation, seq);
    if (done === null || !linkLive(token, generation)) return;
    if (!done) {
      setSeekPending({ token, generation, messageId, seq });
      return;
    }
    if ((viewRef.current as View).messages.some((m) => m.id === messageId)) {
      setHighlightId(messageId);
    } else {
      updateView(generation, (cur) => ({ ...cur, error: LINK_GONE }));
    }
  };

  const seekMessage = async (
    token: number,
    channelId: string,
    generation: number,
    messageId: string,
  ) => {
    let found: HubChatMessage | undefined;
    try {
      const res = await api.hubChat.message(messageId);
      found = res?.message as HubChatMessage | undefined;
    } catch (err) {
      if (!linkLive(token, generation)) return;
      const status = (err as { status?: number })?.status;
      updateView(generation, (cur) => ({
        ...cur,
        error: status === 404 ? LINK_GONE : `Could not load the linked message: ${errorText(err)}`,
      }));
      return;
    }
    if (!linkLive(token, generation)) return;
    if (!found) {
      updateView(generation, (cur) => ({ ...cur, error: LINK_GONE }));
      return;
    }
    if (found.channelId !== channelId) {
      // The link named the wrong channel; follow the message.
      focusHubChatMessage(found.channelId, messageId);
      return;
    }
    await finishSeek(token, generation, messageId, found.seq);
  };

  const keepSeeking = () => {
    const pending = seekPending;
    if (!pending || !linkLive(pending.token, pending.generation)) return;
    setSeekPending(null);
    void finishSeek(pending.token, pending.generation, pending.messageId, pending.seq);
  };

  useEffect(() => {
    if (!focus || loading) return;
    // A new link supersedes whatever an earlier one is still doing, even
    // before its own channel has loaded.
    if (linkRef.current.focus !== focus) {
      supersedeLink();
      linkRef.current = { ...linkRef.current, focus };
    }
    const { channelId, messageId } = focus;
    const v = viewRef.current;
    if (!v || v.channelId !== channelId) {
      const known = channelsRef.current.find((c) => c.id === channelId);
      if (known) {
        openChannel(channelId, known);
        return;
      }
      // Not in the rail: a public channel the viewer has not joined, or one
      // they cannot see (the server answers 404 and the link does nothing).
      if (focusFetchRef.current === channelId) return;
      focusFetchRef.current = channelId;
      const issuedAt = clockNow();
      const isThisLink = () => getHubChatSession().focus === focus;
      api.hubChat
        .channel(channelId)
        .then((res: { channel?: HubChatChannel }) => {
          if (!isThisLink()) return;
          const adopted = res?.channel ? ingestChannel(res.channel, issuedAt, ['presence']) : null;
          if (!adopted) {
            clearFocus();
            return;
          }
          openChannel(adopted.id, adopted);
        })
        .catch((err: unknown) => {
          if (!isThisLink()) return;
          clearFocus();
          setLoadError(`Could not open the linked conversation: ${errorText(err)}`);
        })
        .finally(() => {
          if (focusFetchRef.current === channelId) focusFetchRef.current = null;
        });
      return;
    }
    if (!v.loaded) return;
    // Handled once; clearing the store lets the same link be opened again.
    const token = linkRef.current.token;
    clearFocus();
    if (!messageId) return;
    if (v.messages.some((m) => m.id === messageId)) {
      setHighlightId(messageId);
      return;
    }
    void seekMessage(token, channelId, v.generation, messageId);
    // seekMessage is recreated every render and reads the view through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, loading, view, channels, openChannel, ingestChannel, clockNow]);

  useEffect(() => {
    if (!highlightId) return;
    const el =
      typeof document === 'undefined'
        ? null
        : document.querySelector(`[data-message-id="${CSS.escape(highlightId)}"]`);
    el?.scrollIntoView?.({ block: 'center' });
    const timer = setTimeout(() => setHighlightId(null), 4000);
    return () => clearTimeout(timer);
  }, [highlightId]);

  const pickedIds: ReadonlySet<string> =
    picked && picked.channelId === selectedId ? picked.ids : new Set<string>();
  const pickedMessages = (view?.messages ?? []).filter((m) => pickedIds.has(m.id) && !m.deletedAt);
  const togglePicked = (messageId: string) => {
    if (!selectedId) return;
    const next = new Set(pickedIds);
    if (next.has(messageId)) next.delete(messageId);
    else next.add(messageId);
    setPicked(next.size ? { channelId: selectedId, ids: next } : null);
  };
  const captureFor = (chosen: HubChatMessage[]) =>
    selected
      ? hubChatCaptureInput(
          selected.id,
          channelLabel(selected, usernames, viewerUserId),
          chosen,
          usernames,
        )
      : null;
  const openSendToAgent = (chosen: HubChatMessage[]) => {
    const input = captureFor(chosen);
    if (!input || !chosen.length) return;
    const firstLine = refsToPlainText(chosen[0].body, locateChatMarkdownCode).split('\n')[0].trim();
    const short = firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
    setDispatch({
      label:
        chosen.length === 1
          ? `Chat: ${short || input.channelLabel || 'message'}`
          : `Chat: ${chosen.length} messages${input.channelLabel ? ` in ${input.channelLabel}` : ''}`,
      seed: buildHubChatSessionSeed(input),
    });
  };
  const openCreateTicket = (chosen: HubChatMessage[]) => {
    const input = captureFor(chosen);
    if (input && chosen.length) setTicketDraft(buildHubChatCardDraft(input));
  };
  const copyLink = async (message: HubChatMessage) => {
    const url = hubChatMessageUrl(message.channelId, message.id);
    let ok = false;
    try {
      if (url && navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch {
      ok = false;
    }
    setCopied({ id: message.id, ok });
    setTimeout(() => setCopied((cur) => (cur?.id === message.id ? null : cur)), 2000);
  };

  const renderChannelRow = (c: HubChatChannel) => {
    const { count, bold } = railUnread(c);
    const muted = isChannelMuted(c);
    const active = c.id === selectedId;
    return (
      <button
        key={c.id}
        type="button"
        onClick={() => openChannel(c.id)}
        data-testid={`hub-chat-channel-${c.id}`}
        className={`flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm ${
          active ? 'bg-gray-800 text-white' : 'text-gray-300 hover:bg-gray-800/50'
        }`}
      >
        <span
          className={`min-w-0 flex-1 truncate ${bold && !active ? 'font-semibold text-white' : ''}`}
        >
          {channelLabel(c, usernames, viewerUserId)}
        </span>
        {c.isPrivate && c.kind === 'channel' && (
          <Lock size={11} aria-label="Private" className="shrink-0 text-gray-500" />
        )}
        {muted && (
          <BellOff
            size={12}
            aria-label="Muted"
            data-testid={`hub-chat-channel-muted-${c.id}`}
            className="shrink-0 text-gray-500"
          />
        )}
        {count > 0 && !active && (
          <span
            data-testid={`hub-chat-unread-${c.id}`}
            aria-label={`${count} unread`}
            className="shrink-0 rounded-full bg-blue-600 px-1.5 text-[10px] font-semibold leading-4 text-white"
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>
    );
  };

  const sectionAction: Partial<Record<string, { label: string; onClick: () => void }>> = {
    dms: { label: 'New direct message', onClick: () => setDialog('dm') },
    channels: { label: 'New channel', onClick: () => setDialog('channel') },
  };

  if (loading) {
    return (
      <div className="m-4 flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm text-gray-400">
        <Loader2 size={16} className="animate-spin" />
        Loading chat...
      </div>
    );
  }

  const canPost = !!selected?.membership && !selected.archivedAt;
  const draft = selectedId ? (drafts[selectedId] ?? '') : '';
  const sending = !!selectedId && pendingSends.has(selectedId);
  const sendError = selectedId ? (sendErrors[selectedId] ?? null) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row" data-testid="hub-chat-page">
      <nav
        aria-label="Chat channels"
        className="max-h-56 shrink-0 overflow-y-auto border-b border-gray-800 py-2 md:max-h-none md:w-64 md:border-b-0 md:border-r"
      >
        {loadError && (
          <div className="mx-2 mb-2 flex items-center gap-2 text-xs text-amber-300">
            <AlertCircle size={12} className="shrink-0" />
            {loadError}
          </div>
        )}
        <HubChatSearch
          usernames={usernames}
          viewerUserId={viewerUserId}
          onPick={(r) => focusHubChatMessage(r.channel.id, r.message.id)}
        >
          {assistantEnabled && (
            <>
              <div className="px-4 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                Agent Hub
              </div>
              <button
                type="button"
                onClick={openAssistant}
                data-testid="hub-chat-assistant"
                aria-current={assistantSelected ? 'page' : undefined}
                className={`flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm ${
                  assistantSelected
                    ? 'bg-gray-800 text-white'
                    : 'text-gray-300 hover:bg-gray-800/50'
                }`}
              >
                <Bot size={13} className="shrink-0 text-cyan-400" />
                <span
                  className={`min-w-0 flex-1 truncate ${
                    assistantUnread > 0 && !assistantSelected ? 'font-semibold text-white' : ''
                  }`}
                >
                  Agent Hub
                </span>
                {assistantUnread > 0 && !assistantSelected && (
                  <span
                    data-testid="hub-chat-assistant-unread"
                    aria-label={`${assistantUnread} unread`}
                    className="shrink-0 rounded-full bg-blue-600 px-1.5 text-[10px] font-semibold leading-4 text-white"
                  >
                    {assistantUnread > 99 ? '99+' : assistantUnread}
                  </span>
                )}
              </button>
            </>
          )}
          {RAIL_SECTIONS.map((section) => {
            const items = sections[section.id];
            const action = sectionAction[section.id];
            // Triggers and summaries are created elsewhere; hide them until they exist.
            if (!items.length && !action) return null;
            return (
              <div key={section.id} className="mt-3" data-testid={`hub-chat-section-${section.id}`}>
                <div className="flex items-center justify-between px-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  {section.label}
                  <span className="flex items-center gap-1">
                    {section.id === 'channels' && (
                      <button
                        type="button"
                        onClick={() => setDialog('browse')}
                        title="Browse channels"
                        aria-label="Browse channels"
                        className="rounded p-0.5 text-gray-500 hover:bg-gray-800 hover:text-white"
                      >
                        <Compass size={13} />
                      </button>
                    )}
                    {action && (
                      <button
                        type="button"
                        onClick={action.onClick}
                        title={action.label}
                        aria-label={action.label}
                        className="rounded p-0.5 text-gray-500 hover:bg-gray-800 hover:text-white"
                      >
                        <Plus size={13} />
                      </button>
                    )}
                  </span>
                </div>
                {items.map(renderChannelRow)}
                {!items.length && (
                  <p className="px-4 py-1 text-xs text-gray-600">
                    {section.id === 'dms' ? 'No conversations yet.' : 'No channels yet.'}
                  </p>
                )}
              </div>
            );
          })}
        </HubChatSearch>
      </nav>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {assistantSelected ? (
          <div className="flex min-h-0 flex-1 flex-col" data-testid="hub-chat-assistant-view">
            <div className="flex shrink-0 items-center gap-2 border-b border-gray-800 px-4 py-2">
              <Bot size={14} className="text-cyan-400" />
              <div className="truncate text-sm font-medium text-gray-200">Agent Hub</div>
            </div>
            {assistant ?? (
              <p className="m-4 text-sm text-gray-400" data-testid="hub-chat-assistant-elsewhere">
                The assistant conversation is open in the Assistant tab.
              </p>
            )}
          </div>
        ) : !selected ? (
          <div className="m-4 rounded-lg border border-gray-800 bg-gray-900 p-6">
            <h3 className="text-lg font-semibold text-white">Agent Hub chat</h3>
            <p className="mt-2 max-w-xl text-sm text-gray-400">
              Message people in your organization directly or in shared channels.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setDialog('dm')}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
              >
                New direct message
              </button>
              <button
                type="button"
                onClick={() => setDialog('channel')}
                className="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-800"
              >
                New channel
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-gray-800 px-4 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-gray-200">
                  {channelLabel(selected, usernames, viewerUserId)}
                </div>
                {selected.topic && (
                  <div className="truncate text-xs text-gray-500" data-testid="hub-chat-topic">
                    {selected.topic}
                  </div>
                )}
              </div>
              {selected.kind === 'agent' && (
                <AgentChannelHeaderState state={selected.agentState} onOpenRef={onOpenRef} />
              )}
              <button
                type="button"
                onClick={() => setDialog('settings')}
                aria-label="Channel settings"
                title="Channel settings"
                data-testid="hub-chat-settings-button"
                className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-white"
              >
                <Settings size={14} />
              </button>
            </div>

            {pickedMessages.length > 0 && (
              <div
                className="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-800 bg-gray-900 px-4 py-2 text-xs text-gray-300"
                data-testid="hub-chat-selection-bar"
              >
                <span className="font-medium text-gray-200">{pickedMessages.length} selected</span>
                <button
                  type="button"
                  onClick={() => openSendToAgent(pickedMessages)}
                  title="Start one agent session with all selected messages"
                  className="inline-flex items-center gap-1 rounded border border-blue-500/40 bg-blue-500/10 px-2 py-1 text-blue-200 hover:bg-blue-500/20"
                >
                  <MessageSquarePlus size={13} />
                  Send selected to agent
                </button>
                <button
                  type="button"
                  onClick={() => openCreateTicket(pickedMessages)}
                  title="Create one kanban ticket from all selected messages"
                  className="inline-flex items-center gap-1 rounded border border-gray-700 px-2 py-1 hover:bg-gray-800"
                >
                  <Ticket size={13} />
                  Ticket from selected
                </button>
                <button
                  type="button"
                  onClick={() => setPicked(null)}
                  className="ml-auto rounded px-2 py-1 text-gray-400 hover:bg-gray-800 hover:text-white"
                >
                  Clear selection
                </button>
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {seekPending && view && seekPending.generation === view.generation && (
                <div
                  data-testid="hub-chat-seek-pending"
                  className="mb-3 flex items-center gap-2 rounded border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-300"
                >
                  <span className="flex-1">
                    The linked message is{' '}
                    {Math.max(1, (view.messages[0]?.seq ?? seekPending.seq) - seekPending.seq)}{' '}
                    messages further back.
                  </span>
                  <button
                    type="button"
                    onClick={keepSeeking}
                    disabled={view.loadingOlder}
                    className="rounded bg-blue-600 px-2 py-1 font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                  >
                    Keep loading
                  </button>
                  <button
                    type="button"
                    onClick={() => supersedeLink()}
                    className="rounded px-2 py-1 text-gray-400 hover:bg-gray-800 hover:text-white"
                  >
                    Stop
                  </button>
                </div>
              )}
              {view?.error && view.loaded && (
                <div className="mb-3 flex items-center gap-2 text-xs text-amber-300">
                  <AlertCircle size={14} className="shrink-0" />
                  {view.error}
                </div>
              )}
              {!view || (view.loading && !view.loaded) ? (
                <div className="flex items-center gap-2 text-sm text-gray-400">
                  <Loader2 size={16} className="animate-spin" />
                  Loading messages...
                </div>
              ) : view.error && !view.loaded ? (
                <div className="flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" />
                  {view.error}
                </div>
              ) : !view.messages.length ? (
                <p className="text-sm text-gray-500">No messages yet. Say hello.</p>
              ) : (
                <>
                  {view.hasOlder ? (
                    <div className="mb-3 flex justify-center">
                      <button
                        type="button"
                        onClick={() => void loadOlder()}
                        disabled={view.loadingOlder}
                        className="inline-flex items-center gap-2 rounded border border-gray-700 px-3 py-1 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50"
                      >
                        {view.loadingOlder && <Loader2 size={12} className="animate-spin" />}
                        Load older messages
                      </button>
                    </div>
                  ) : (
                    <p className="mb-3 text-center text-xs text-gray-600">Start of conversation</p>
                  )}
                  <ul className="pb-2">
                    {rows.map(({ message, own, showHeader, dayLabel, unreadDivider }) => {
                      const label = authorLabel(message, usernames);
                      const deleted = !!message.deletedAt;
                      const isEditing = editing?.id === message.id;
                      const bot = message.authorKind !== 'user';
                      const triggerCard =
                        message.authorKind === 'trigger' && !deleted
                          ? readChatTriggerCard(message.payload)
                          : null;
                      const isPicked = pickedIds.has(message.id);
                      const copyState = copied?.id === message.id ? copied : null;
                      return (
                        <Fragment key={message.id}>
                          {dayLabel && (
                            <li
                              role="separator"
                              data-testid="hub-chat-day-divider"
                              className="my-4 flex items-center gap-3 text-xs font-medium text-gray-400"
                            >
                              <span className="h-px flex-1 bg-gray-800" />
                              {dayLabel}
                              <span className="h-px flex-1 bg-gray-800" />
                            </li>
                          )}
                          {unreadDivider && (
                            <li
                              role="separator"
                              data-testid="hub-chat-unread-divider"
                              className="my-3 flex items-center gap-3 text-xs font-medium text-red-400"
                            >
                              <span className="h-px flex-1 bg-red-500/50" />
                              Unread
                              <span className="h-px flex-1 bg-red-500/50" />
                            </li>
                          )}
                          <li
                            data-testid="hub-chat-message"
                            data-message-id={message.id}
                            data-own={own ? 'true' : undefined}
                            data-header={showHeader ? 'true' : undefined}
                            data-highlighted={highlightId === message.id ? 'true' : undefined}
                            className={`group relative flex gap-2 rounded-lg px-1 py-0.5 ${
                              highlightId === message.id
                                ? 'bg-amber-500/15 ring-1 ring-amber-500/40'
                                : isPicked
                                  ? 'bg-blue-500/10'
                                  : 'hover:bg-white/[0.02]'
                            } ${own ? 'flex-row-reverse' : ''} ${showHeader ? 'mt-3' : ''}`}
                          >
                            <div className="flex w-4 shrink-0 items-start pt-2">
                              {!deleted && (
                                <input
                                  type="checkbox"
                                  checked={isPicked}
                                  onChange={() => togglePicked(message.id)}
                                  aria-label={`Select message from ${own ? 'you' : label}`}
                                  data-testid="hub-chat-message-select"
                                  className={`h-3.5 w-3.5 cursor-pointer accent-blue-500 focus:opacity-100 group-hover:opacity-100 ${
                                    isPicked || pickedIds.size > 0
                                      ? ''
                                      : '[@media(hover:hover)]:opacity-0'
                                  }`}
                                />
                              )}
                            </div>
                            {!own && (
                              <div className="w-8 shrink-0" aria-hidden="true">
                                {showHeader &&
                                  (bot ? (
                                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-700 text-gray-200">
                                      <Bot size={16} />
                                    </div>
                                  ) : (
                                    <div
                                      className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold text-white ${avatarColorFor(
                                        message.authorUserId ?? label,
                                      )}`}
                                    >
                                      {avatarInitials(label)}
                                    </div>
                                  ))}
                              </div>
                            )}
                            <div
                              className={`flex min-w-0 max-w-[80%] flex-col ${
                                own ? 'items-end' : 'items-start'
                              }`}
                            >
                              {showHeader && (
                                <div className="mb-1 flex items-baseline gap-2 px-1 text-xs">
                                  {!own && (
                                    <span className="font-semibold text-gray-100">{label}</span>
                                  )}
                                  <span
                                    className="text-gray-500"
                                    title={formatDateTime(message.createdAt)}
                                  >
                                    {formatTime(message.createdAt, {
                                      hour: 'numeric',
                                      minute: '2-digit',
                                    })}
                                  </span>
                                </div>
                              )}
                              {isEditing && editing ? (
                                <form
                                  className="flex w-full min-w-[16rem] flex-col gap-1"
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    void saveEdit();
                                  }}
                                >
                                  <HubChatMentionInput
                                    aria-label="Edit message"
                                    autoFocus
                                    rows={Math.min(8, Math.max(2, editing.text.split('\n').length))}
                                    value={editing.text}
                                    disabled={editing.saving}
                                    mentions={editing.mentions}
                                    onChange={(text, mentions) =>
                                      setEditing((cur) =>
                                        cur ? { ...cur, text, mentions, error: null } : cur,
                                      )
                                    }
                                    onKeyDown={(e) => {
                                      if (e.key === 'Escape') {
                                        e.preventDefault();
                                        setEditing(null);
                                      } else if (isSubmitEnter(e)) {
                                        e.preventDefault();
                                        e.currentTarget.form?.requestSubmit();
                                      }
                                    }}
                                    className="w-full resize-y rounded-xl border border-blue-500/60 bg-gray-900 px-3 py-2 text-sm text-gray-100 focus:outline-none"
                                  />
                                  <div className="flex items-center justify-end gap-2 text-xs">
                                    {editing.error && (
                                      <span role="alert" className="mr-auto text-red-300">
                                        {editing.error}
                                      </span>
                                    )}
                                    <span className="text-gray-500">Esc to cancel</span>
                                    <button
                                      type="button"
                                      onClick={() => setEditing(null)}
                                      className="rounded px-2 py-1 text-gray-300 hover:bg-gray-800"
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      type="submit"
                                      disabled={editing.saving || !editing.text.trim()}
                                      className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-1 font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                                    >
                                      {editing.saving && (
                                        <Loader2 size={12} className="animate-spin" />
                                      )}
                                      Save
                                    </button>
                                  </div>
                                </form>
                              ) : (
                                <div
                                  title={showHeader ? undefined : formatDateTime(message.createdAt)}
                                  className={
                                    triggerCard
                                      ? 'w-full'
                                      : `break-words rounded-2xl px-3 py-2 text-sm ${
                                          own
                                            ? 'bg-blue-600/30 text-blue-50'
                                            : 'bg-gray-800 text-gray-100'
                                        } ${showHeader ? (own ? 'rounded-tr-md' : 'rounded-tl-md') : ''}`
                                  }
                                >
                                  {deleted ? (
                                    <span className="italic text-gray-500">Message deleted</span>
                                  ) : triggerCard ? (
                                    <HubChatTriggerCard card={triggerCard} onOpenRef={onOpenRef} />
                                  ) : (
                                    <div className="markdown-content" data-testid="hub-chat-body">
                                      <HubChatMessageBody
                                        body={message.body}
                                        onOpenRef={onOpenRef}
                                      />
                                    </div>
                                  )}
                                </div>
                              )}
                              {!deleted && message.editedAt && !isEditing && (
                                <span
                                  className="px-1 text-[11px] text-gray-500"
                                  title={`Edited ${formatDateTime(message.editedAt)}`}
                                >
                                  Edited
                                </span>
                              )}
                            </div>
                            {!deleted && !isEditing && (
                              <div
                                data-testid="hub-chat-message-actions"
                                className={`flex items-start gap-0.5 pt-1 focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100 ${
                                  copyState ? '' : '[@media(hover:hover)]:opacity-0'
                                }`}
                              >
                                <button
                                  type="button"
                                  onClick={() => openSendToAgent([message])}
                                  aria-label="Send to agent"
                                  title="Send to agent: start a session with this message as the task"
                                  className={`${TOOL_BUTTON} text-blue-300`}
                                >
                                  <MessageSquarePlus size={13} />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => openCreateTicket([message])}
                                  aria-label="Create ticket"
                                  title="Create a kanban ticket from this message"
                                  className={TOOL_BUTTON}
                                >
                                  <Ticket size={13} />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void copyLink(message)}
                                  aria-label={
                                    copyState
                                      ? copyState.ok
                                        ? 'Link copied'
                                        : 'Could not copy link'
                                      : 'Copy link'
                                  }
                                  title={
                                    copyState
                                      ? copyState.ok
                                        ? 'Link copied'
                                        : 'Could not copy link'
                                      : 'Copy link to this message'
                                  }
                                  className={TOOL_BUTTON}
                                >
                                  {copyState?.ok ? (
                                    <Check size={13} className="text-green-400" />
                                  ) : copyState ? (
                                    <AlertCircle size={13} className="text-red-300" />
                                  ) : (
                                    <Link2 size={13} />
                                  )}
                                </button>
                                {own && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const decoded = decodeToComposer(
                                          message.body,
                                          locateChatMarkdownCode,
                                        );
                                        setEditing({
                                          id: message.id,
                                          channelId: message.channelId,
                                          text: decoded.text,
                                          mentions: decoded.mentions,
                                          saving: false,
                                          error: null,
                                          attempt: 0,
                                        });
                                      }}
                                      aria-label="Edit message"
                                      title="Edit"
                                      className={TOOL_BUTTON}
                                    >
                                      <Pencil size={13} />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => void deleteMessage(message)}
                                      aria-label="Delete message"
                                      title="Delete"
                                      className={`${TOOL_BUTTON} hover:text-red-300`}
                                    >
                                      <Trash2 size={13} />
                                    </button>
                                  </>
                                )}
                              </div>
                            )}
                          </li>
                        </Fragment>
                      );
                    })}
                  </ul>
                  <div ref={listEndRef} />
                </>
              )}
            </div>

            <div className="shrink-0 border-t border-gray-800 p-3">
              {sendError && (
                <p role="alert" className="mb-2 text-xs text-red-300">
                  {sendError}
                </p>
              )}
              {!selected.membership ? (
                <div className="flex items-center justify-between gap-2 text-sm text-gray-400">
                  You are viewing this channel.
                  <button
                    type="button"
                    onClick={() => void joinSelected()}
                    className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
                  >
                    Join channel
                  </button>
                </div>
              ) : (
                <form
                  className="flex items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                  }}
                >
                  <HubChatMentionInput
                    wrapperClassName="flex flex-1"
                    value={draft}
                    mentions={selectedId ? (draftMentions[selectedId] ?? []) : []}
                    onChange={(value, mentions) => {
                      if (selectedId)
                        updateHubChatSession((st) => ({
                          ...st,
                          drafts: { ...st.drafts, [selectedId]: value },
                          draftMentions: { ...st.draftMentions, [selectedId]: mentions },
                        }));
                    }}
                    onKeyDown={(e) => {
                      if (isSubmitEnter(e)) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                    disabled={!canPost}
                    rows={Math.min(8, Math.max(1, draft.split('\n').length))}
                    placeholder={
                      canPost
                        ? `Message ${channelLabel(selected, usernames, viewerUserId)} (Markdown)`
                        : 'This channel is archived'
                    }
                    aria-label="Message"
                    data-testid="hub-chat-composer"
                    className="min-h-[2.5rem] flex-1 resize-none rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-blue-500 disabled:opacity-50"
                  />
                  <button
                    type="submit"
                    disabled={!canPost || sending || !draft.trim()}
                    aria-label="Send"
                    data-testid="hub-chat-send"
                    className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
                  >
                    {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                  </button>
                </form>
              )}
            </div>
          </>
        )}
      </section>

      {ticketDraft && (
        <CaptureToTicketModal
          draft={ticketDraft}
          onClose={() => setTicketDraft(null)}
          onCreated={() => setPicked(null)}
        />
      )}
      {dispatch && (
        <StartSessionModal
          contextLabel={dispatch.label}
          seedMessage={dispatch.seed}
          defaultName={dispatch.label}
          onClose={() => setDispatch(null)}
          onStarted={(session) => {
            setPicked(null);
            onSessionStarted?.(session);
          }}
        />
      )}
      {dialog === 'channel' && (
        <NewChannelDialog
          members={orgMembers}
          viewerUserId={viewerUserId}
          clock={clockNow}
          onClose={() => setDialog(null)}
          onCreated={adoptChannel}
        />
      )}
      {dialog === 'dm' && (
        <NewDmDialog
          members={orgMembers}
          clock={clockNow}
          onClose={() => setDialog(null)}
          onOpened={adoptChannel}
        />
      )}
      {dialog === 'browse' && (
        <BrowseChannelsDialog
          clock={clockNow}
          onClose={() => setDialog(null)}
          onJoined={adoptChannel}
        />
      )}
      {dialog === 'settings' && selected && (
        <ChannelSettingsDialog
          key={selected.id}
          channel={selected}
          usernames={usernames}
          orgMembers={orgMembers}
          viewerUserId={viewerUserId}
          onClose={() => setDialog(null)}
          clock={clockNow}
          onChanged={(channel, issuedAt) => ingestChannel(channel, issuedAt, ['meta'])}
          onMembershipChanged={ingestMembership}
          onLeft={(channelId) => {
            setDialog(null);
            changeChannels(channelId, ['presence'], (prev) =>
              prev.filter((c) => c.id !== channelId),
            );
            setSelectedId(null);
            setView(null);
          }}
        />
      )}
    </div>
  );
}
