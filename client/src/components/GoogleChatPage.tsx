import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ListTodo,
  CornerDownRight,
  ExternalLink,
  Loader2,
  MessageSquarePlus,
  MessagesSquare,
  Paperclip,
  RefreshCw,
  Reply,
  Send,
  SmilePlus,
  Ticket,
  X,
} from 'lucide-react';
import { compareRfc3339 } from '@shared/utils/rfc3339';
import { api } from '../utils/api';
import type { SessionWire } from '@shared/types';
import { buildChatMultiSessionSeed, buildChatSessionSeed } from '@shared/utils/sessionSeed';
import {
  buildChatCardDraft,
  buildChatMultiCardDraft,
  type CaptureCardDraft,
} from '@shared/utils/captureCard';
import { buildChatTodoDraft, type CaptureTodoDraft } from '@shared/utils/captureTodo';
import StartSessionModal from './StartSessionModal';
import CaptureToTicketModal from './CaptureToTicketModal';
import { formatDateTime, formatTime } from '../utils/time';
import {
  CHAT_READ_SCOPE_ERROR,
  CHAT_SEND_SCOPE_ERROR,
  CHAT_SURFACE_SCOPES,
  chatConsent,
  type GoogleStatusLike,
} from '../utils/googleSurface';
import {
  chatSenderLabel,
  chatSpaceDeepLink,
  chatSpaceLabel,
  chatSeedContext,
  sortSpacesByActivity,
  bumpSpaceActivity,
  filterSpaces,
  reconcileRange,
  oldestCreateTime,
  newestCreateTime,
  uniqueMessages,
  mergeOlderPage,
  type ChatMessage,
  type ChatMessageLink,
  type ChatSpace,
  type ChatReaction,
  chatLinkChip,
  linksByMessage,
  applyLinksResult,
  dispatchWarningForMany,
  sharedThreadName,
  LINKS_UNKNOWN_WARNING,
  type SpaceLinks,
  chatSetupHelpLink,
} from '../utils/googleChat';
import { isSubmitEnter } from '../utils/keyboard';
import { createKeyedQueue } from '../utils/keyedQueue';
import {
  QUICK_REACTIONS,
  keepNewerReactions,
  avatarColor,
  avatarInitials,
  layoutChatMessages,
  newestTopLevelTime,
} from '../utils/googleChatLayout';
import { placeDrafts, useChatDrafts, type ChatDraft } from '../utils/googleChatDrafts';
import GoogleChatDraftCard from './GoogleChatDraftCard';
import GoogleChatAttachments from './GoogleChatAttachments';
import { DraftsLoadError } from './GoogleChatDraftsPanel';
import {
  chatPushStore,
  formatUnreadCount,
  spaceIdFromName,
  useGoogleChatPush,
} from '../utils/googleChatPush';

type GoogleStatus = NonNullable<GoogleStatusLike>;

// With Chat push active (Workspace Events API), the open space refreshes when
// the server relays a created, updated, or deleted message. Polling is the
// fallback for Hubs without push, or while push is down (socket closed,
// subscription suspended or expired). Push still keeps a slow re-read: Pub/Sub
// can drop a delivery, and nothing else would ever correct the view.
// Without push, the conversation list is polled too so new DMs and activity
// reordering show up without a manual Refresh. Each open tab costs about 16
// Chat API reads a minute against the per-project quota of 3,000.
export const POLL_MS = 5_000;
export const SPACES_POLL_MS = 15_000;
const PUSH_RECONCILE_MS = 5 * 60_000;
// Bursts of events (a busy thread) collapse into one re-read.
const PUSH_REFRESH_DEBOUNCE_MS = 300;
const MESSAGE_PAGE = 50;
const SPACE_PAGE = 1000;
// Google caps a page at 1000 spaces; 20 pages is far past any real account and
// keeps a misbehaving token from looping forever.
const MAX_SPACE_PAGES = 20;
// A refresh re-reads the whole loaded range; past 5 x 1000 messages it keeps
// the newest slice instead.
const REFRESH_PAGE = 1000;
const MAX_REFRESH_PAGES = 5;

type SpaceView = {
  /**
   * Loaded history, oldest first. It always covers one contiguous time range
   * from its oldest message to now, and every refresh re-reads that whole
   * range, so edits and deletions anywhere in it are picked up.
   */
  messages: ChatMessage[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** False once the start of the space has been reached. */
  hasOlder: boolean;
  /**
   * The in-progress older-history query. It is anchored once at the oldest
   * loaded message (inclusive) and then continued with Google's page token,
   * parameters unchanged, so messages sharing the boundary timestamp are all
   * returned instead of being skipped by a fresh strict-before query per page.
   */
  older: { until: string; pageToken: string | null } | null;
  /**
   * Bumped every time the history is replaced wholesale (first load, capped
   * refresh). Older-page responses are tied to the generation they were
   * requested in and dropped if it changed, however many replacements
   * happened in between.
   */
  generation: number;
  loadingOlder: boolean;
  olderError: string | null;
};

type Composer = {
  text: string;
  replyTo: ChatMessage | null;
  /** Bumped on every user edit and on submit; see `send`. */
  rev: number;
  sending: boolean;
  error: string | null;
};

const EMPTY_VIEW: SpaceView = {
  messages: [],
  loaded: false,
  loading: false,
  error: null,
  hasOlder: false,
  older: null,
  generation: 0,
  loadingOlder: false,
  olderError: null,
};
const EMPTY_COMPOSER: Composer = {
  text: '',
  replyTo: null,
  rev: 0,
  sending: false,
  error: null,
};

type TodoCapture = { status: 'saving' | 'added' } | { status: 'error'; error: string };

/** Build the "Ticket" card draft for one message. Exported for unit tests. */
export function buildTicketDraftForMessage(
  space: ChatSpace | null,
  target: ChatMessage,
): CaptureCardDraft {
  return buildChatCardDraft({
    messageName: target.name,
    spaceName: target.spaceName || space?.name || null,
    threadName: target.threadName,
    spaceLabel: space ? chatSpaceLabel(space) : null,
    sender: chatSenderLabel(target.sender),
    text: target.text,
    deepLink: chatSpaceDeepLink(space),
  });
}

/** Build the "Add to todos" draft for one message. Exported for unit tests. */
export function buildTodoDraftForMessage(
  space: ChatSpace | null,
  target: ChatMessage,
): CaptureTodoDraft {
  return buildChatTodoDraft({
    messageName: target.name,
    spaceName: target.spaceName || space?.name || null,
    threadName: target.threadName,
    spaceLabel: space ? chatSpaceLabel(space) : null,
    sender: chatSenderLabel(target.sender),
    text: target.text,
    deepLink: chatSpaceDeepLink(space),
  });
}

/** Build the "Start session" seed for one message. Exported for unit tests. */
export function buildSeedForMessage(
  space: ChatSpace | null,
  messages: ChatMessage[],
  target: ChatMessage,
): { label: string; seed: string } {
  const spaceLabel = space ? chatSpaceLabel(space) : null;
  const threaded = !!space?.supportsThreadReplies;
  const firstLine = (target.text || '').split('\n')[0].trim();
  const short = firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
  return {
    label: `Chat: ${short || spaceLabel || 'message'}`,
    seed: buildChatSessionSeed({
      spaceLabel,
      spaceName: target.spaceName || space?.name || null,
      // Only spaces that keep replies in threads get a thread reference; a
      // DM or group chat reply goes to the conversation.
      threadName: threaded ? target.threadName : null,
      sender: chatSenderLabel(target.sender),
      createTime: target.createTime ? formatDateTime(target.createTime) : null,
      text: target.text,
      context: chatSeedContext(messages, target, threaded).map((m) => ({
        sender: chatSenderLabel(m.sender),
        text: m.text,
      })),
      deepLink: chatSpaceDeepLink(space),
    }),
  };
}

/** Build the "Ticket" card draft for several picked messages. Exported for unit tests. */
export function buildTicketDraftForMessages(
  space: ChatSpace | null,
  picked: ChatMessage[],
): CaptureCardDraft {
  if (picked.length === 1) return buildTicketDraftForMessage(space, picked[0]);
  return buildChatMultiCardDraft({
    spaceName: picked[0]?.spaceName || space?.name || null,
    threadName: sharedThreadName(picked, true),
    spaceLabel: space ? chatSpaceLabel(space) : null,
    deepLink: chatSpaceDeepLink(space),
    messages: picked.map((m) => ({
      messageName: m.name,
      sender: chatSenderLabel(m.sender),
      createTime: m.createTime ? formatDateTime(m.createTime) : null,
      text: m.text,
    })),
  });
}

/** Build the "Start session" seed for several picked messages. Exported for unit tests. */
export function buildSeedForMessages(
  space: ChatSpace | null,
  messages: ChatMessage[],
  picked: ChatMessage[],
): { label: string; seed: string } {
  if (picked.length === 1) return buildSeedForMessage(space, messages, picked[0]);
  const spaceLabel = space ? chatSpaceLabel(space) : null;
  return {
    label: `Chat: ${picked.length} messages${spaceLabel ? ` in ${spaceLabel}` : ''}`,
    seed: buildChatMultiSessionSeed({
      spaceLabel,
      spaceName: picked[0]?.spaceName || space?.name || null,
      threadName: sharedThreadName(picked, !!space?.supportsThreadReplies),
      deepLink: chatSpaceDeepLink(space),
      messages: picked.map((m) => ({
        sender: chatSenderLabel(m.sender),
        createTime: m.createTime ? formatDateTime(m.createTime) : null,
        text: m.text,
      })),
    }),
  };
}

/** "Send to agent" in progress: the seed plus the messages it should be linked to. */
type PendingDispatch = {
  label: string;
  seed: string;
  spaceId: string;
  targets: Array<{
    messageName: string;
    /** Only for spaces that keep replies in threads, matching the seed. */
    threadName: string | null;
  }>;
};

export { LINKS_UNKNOWN_WARNING };

export default function GoogleChatPage({
  onOpenAccountSettings,
  onSessionStarted,
  onOpenSession,
}: {
  onOpenAccountSettings?: () => void;
  onSessionStarted?: (session: SessionWire) => void;
  onOpenSession?: (target: { sessionId: string; agentId: string }) => void;
}) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorHelp, setErrorHelp] = useState<{ label: string; url: string } | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [spaces, setSpaces] = useState<ChatSpace[]>([]);
  const [spacesLoading, setSpacesLoading] = useState(false);
  const [spaceFilter, setSpaceFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [views, setViews] = useState<Record<string, SpaceView>>({});
  // Loaders read the range bounds from here at call time, not from a stale
  // render closure.
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const [composers, setComposers] = useState<Record<string, Composer>>({});
  const [dispatch, setDispatch] = useState<PendingDispatch | null>(null);
  // Message → session links per space, shared across operators. A space
  // missing from the map has never been read, which is "unknown", not "none".
  const [links, setLinks] = useState<Record<string, SpaceLinks>>({});
  // Link reads are numbered per space when issued so responses apply in
  // issue order (see applyLinksResult), like the message loads below.
  const linksSeqRef = useRef<Record<string, number>>({});
  // The message whose links are being re-read before Send to agent opens.
  const [checkingDispatch, setCheckingDispatch] = useState<string | null>(null);
  const checkingDispatchRef = useRef(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [ticketDraft, setTicketDraft] = useState<CaptureCardDraft | null>(null);
  // Messages ticked for a bulk Send to agent / Ticket, by message name. Scoped
  // to the open space: switching conversations clears it.
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  // "Add to todos" progress per message name. Kept for the life of the page so
  // a captured message keeps showing "Added" when the user switches back.
  const [todoCaptures, setTodoCaptures] = useState<Record<string, TodoCapture>>({});
  const todoCapturingRef = useRef<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // The caller's Chat user, so their own messages render on the right.
  const [selfUserName, setSelfUserName] = useState<string | null>(null);
  // Google read position per open space, read once when the space is opened so
  // the Unread line stays put while the user reads. A missing key means the
  // read is still in flight. `fetched: false` means it failed: the position is
  // unknown, so nothing is written to Google for that space.
  const [readMarks, setReadMarks] = useState<
    Record<string, { lastReadTime: string | null; fetched: boolean; dividerHidden: boolean }>
  >({});
  // The newest time already reported to Google per space.
  const googleReadWrittenRef = useRef<Record<string, string>>({});
  const [reactionMenuFor, setReactionMenuFor] = useState<string | null>(null);
  const reactingRef = useRef<Set<string>>(new Set());
  // Each applied toggle result bumps the epoch and stamps its message. Message
  // loads note the epoch when issued and leave newer-stamped reactions alone,
  // so a read started before the toggle answered cannot restore old counts.
  const reactionEpochRef = useRef(0);
  const reactionTouchedRef = useRef<Map<string, number>>(new Map());
  // Toggles on one message run one after another (the server serializes them
  // too), so a summary read back earlier can never be applied after a later one.
  const reactionQueueRef = useRef(createKeyedQueue());
  const [reactionError, setReactionError] = useState<{ name: string; error: string } | null>(null);
  // Every async result below is written to the space (or spaces list) that
  // issued it, never to "whatever is selected now". Message loads and sends
  // for space A therefore cannot touch B's list, spinner, or composer, no
  // matter how switching, polling, and post-send refreshes interleave.
  const messageSeqRef = useRef<Record<string, number>>({});
  const spacesSeqRef = useRef(0);
  // Enter submits via requestSubmit(), which bypasses the disabled Send
  // button, so in-flight sends are tracked synchronously, per space.
  const sendingRef = useRef<Set<string>>(new Set());
  // Same reason for older-page loads: a double click lands before re-render.
  const loadingOlderRef = useRef<Set<string>>(new Set());

  const selectedSpace = spaces.find((s) => s.id === selectedId) ?? null;
  const push = useGoogleChatPush();
  // Derived in the store from connectivity, subscription state, and expiry.
  const pushActive = push.pushActive;
  // Every capability gate and enable action below derives from this one value.
  const consent = chatConsent(status);
  const { canRead, canSend } = consent;

  const view = (selectedId && views[selectedId]) || EMPTY_VIEW;
  const messageLinks = linksByMessage((selectedId && links[selectedId]?.links) || []);
  const messages = view.messages;
  const chatDrafts = useChatDrafts({ spaceId: selectedId ?? undefined }, canRead);
  const placedDrafts = placeDrafts(messages, chatDrafts.drafts);
  // Oldest first, like the list. A ticked message that was deleted or dropped
  // from the loaded range falls out here.
  const pickedMessages = messages.filter((m) => !!m.name && !m.deleted && picked.has(m.name));
  const togglePicked = (name: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  useEffect(() => {
    setPicked(new Set());
  }, [selectedId]);
  const [autoSend, setAutoSend] = useState<boolean | null>(null);
  const [autoSendError, setAutoSendError] = useState<string | null>(null);
  // One settings write at a time, so the server always ends on the user's last
  // choice. The checkbox is disabled while a write is in flight; the ref also
  // blocks a second change that lands before the re-render.
  const [autoSendSaving, setAutoSendSaving] = useState(false);
  const autoSendWriteRef = useRef(false);
  const composer = (selectedId && composers[selectedId]) || EMPTY_COMPOSER;
  const { text: draft, replyTo, sending, error: sendError } = composer;

  const addMessageToTodos = async (message: ChatMessage) => {
    const key = message.name;
    if (!key || todoCapturingRef.current.has(key)) return;
    todoCapturingRef.current.add(key);
    setTodoCaptures((prev) => ({ ...prev, [key]: { status: 'saving' } }));
    try {
      await api.createTodo(buildTodoDraftForMessage(selectedSpace, message));
      setTodoCaptures((prev) => ({ ...prev, [key]: { status: 'added' } }));
    } catch (err: any) {
      setTodoCaptures((prev) => ({
        ...prev,
        [key]: { status: 'error', error: err?.message || 'Failed to add to todos' },
      }));
    } finally {
      todoCapturingRef.current.delete(key);
    }
  };

  const updateView = useCallback((spaceId: string, fn: (v: SpaceView) => SpaceView) => {
    setViews((all) => ({ ...all, [spaceId]: fn(all[spaceId] || EMPTY_VIEW) }));
  }, []);

  const patchView = useCallback(
    (spaceId: string, patch: Partial<SpaceView>) =>
      updateView(spaceId, (v) => ({ ...v, ...patch })),
    [updateView],
  );

  const updateComposer = useCallback((spaceId: string, fn: (c: Composer) => Composer) => {
    setComposers((all) => ({ ...all, [spaceId]: fn(all[spaceId] || EMPTY_COMPOSER) }));
  }, []);

  /** User edits bump `rev` so async send completions can tell they happened. */
  const editComposer = (patch: Partial<Composer>) => {
    if (!selectedId) return;
    updateComposer(selectedId, (c) => ({ ...c, ...patch, rev: c.rev + 1 }));
  };

  // The proxy's scope gate reads the same stored grant as /google/status, so a
  // `*_scope_required` response means the grant changed since we loaded (for
  // example, consent was edited in another tab). Re-read it and let `consent`
  // re-derive the enable actions instead of showing a dead-end error.
  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.getGoogleStatus());
    } catch {
      /* keep the current status; the original error is already shown */
    }
  }, []);

  /**
   * `background`: a poll. It shows no spinner and, on failure, keeps the list
   * and any error already shown rather than blanking the pane over a blip.
   */
  const loadSpaces = useCallback(async ({ background = false } = {}) => {
    const seq = ++spacesSeqRef.current;
    const isCurrent = () => seq === spacesSeqRef.current;
    if (!background) {
      setError(null);
      setErrorHelp(null);
      setSpacesLoading(true);
    }
    try {
      const nextStatus = await api.getGoogleStatus();
      if (!isCurrent()) return;
      setStatus(nextStatus);
      if (nextStatus.connected && chatConsent(nextStatus).canRead) {
        // Access may have been granted after the app started; subscribe now
        // rather than waiting for a reload. No-op once subscribed.
        void chatPushStore().start();
        const list: ChatSpace[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < MAX_SPACE_PAGES; page++) {
          const body = await api.listGoogleChatSpaces({ pageSize: SPACE_PAGE, pageToken });
          if (!isCurrent()) return;
          list.push(...(body.spaces || []).filter((s: ChatSpace) => s.id));
          pageToken = body.nextPageToken || undefined;
          if (!pageToken) break;
        }
        const sorted = sortSpacesByActivity(list);
        setSpaces(sorted);
        setSelectedId((current) =>
          current && sorted.some((s) => s.id === current) ? current : (sorted[0]?.id ?? null),
        );
      } else {
        setSpaces([]);
      }
    } catch (err: any) {
      if (!isCurrent() || background) return;
      setError(err.message || 'Failed to load Google Chat');
      setErrorHelp(chatSetupHelpLink(err));
      setSpaces([]);
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setSpacesLoading(false);
      }
    }
  }, []);

  /**
   * First load: the newest page. Later loads (poll, Refresh, after a send)
   * re-read everything created since the oldest loaded message. The proxy
   * returns deletions as tombstones, so the response is authoritative for that
   * range and replaces it; nothing loaded can silently go stale.
   */
  const loadMessages = useCallback(
    async (spaceId: string) => {
      const seq = (messageSeqRef.current[spaceId] || 0) + 1;
      messageSeqRef.current[spaceId] = seq;
      const isCurrent = () => messageSeqRef.current[spaceId] === seq;
      const since = oldestCreateTime(viewsRef.current[spaceId]?.messages ?? []);
      const reactionEpoch = reactionEpochRef.current;
      const keepReactions = (fresh: ChatMessage[], current: ChatMessage[]) =>
        keepNewerReactions(fresh, current, reactionTouchedRef.current, reactionEpoch);
      patchView(spaceId, { loading: true });
      try {
        if (!since) {
          const body = await api.listGoogleChatMessages(spaceId, {
            pageSize: MESSAGE_PAGE,
            order: 'desc',
          });
          if (!isCurrent()) return;
          if (body.selfUserName) setSelfUserName(body.selfUserName);
          updateView(spaceId, (v) => ({
            ...v,
            messages: uniqueMessages(
              keepReactions((body.messages || []) as ChatMessage[], v.messages),
            ),
            hasOlder: !!body.nextPageToken,
            older: null,
            generation: v.generation + 1,
            loaded: true,
            loading: false,
            error: null,
          }));
          return;
        }

        const fresh: ChatMessage[] = [];
        let pageToken: string | undefined;
        let complete = false;
        for (let page = 0; page < MAX_REFRESH_PAGES; page++) {
          const body = await api.listGoogleChatMessages(spaceId, {
            pageSize: REFRESH_PAGE,
            order: 'desc',
            since,
            ...(pageToken ? { pageToken } : {}),
          });
          if (!isCurrent()) return;
          if (body.selfUserName) setSelfUserName(body.selfUserName);
          fresh.push(...((body.messages || []) as ChatMessage[]));
          pageToken = body.nextPageToken || undefined;
          if (!pageToken) {
            complete = true;
            break;
          }
        }
        updateView(spaceId, (v) =>
          complete
            ? {
                ...v,
                messages: reconcileRange(v.messages, keepReactions(fresh, v.messages), since),
                loaded: true,
                loading: false,
                error: null,
              }
            : // The loaded range outgrew what a refresh re-reads: keep the
              // newest slice we did read and page back from there.
              {
                ...v,
                messages: uniqueMessages(keepReactions(fresh, v.messages)),
                hasOlder: true,
                older: null,
                generation: v.generation + 1,
                loaded: true,
                loading: false,
                error: null,
              },
        );
      } catch (err: any) {
        if (!isCurrent()) return;
        patchView(spaceId, { loading: false, error: err.message || 'Failed to load messages' });
        if (err?.code === CHAT_READ_SCOPE_ERROR) refreshStatus();
      }
    },
    [patchView, updateView, refreshStatus],
  );

  /**
   * Page back through history with one anchored query: `until` is fixed at the
   * oldest loaded message the first time (inclusive), and later pages continue
   * it with Google's page token. Boundary ties overlap loaded messages and are
   * de-duplicated by name.
   */
  const loadOlder = useCallback(
    async (spaceId: string) => {
      const current = viewsRef.current[spaceId];
      if (!current?.hasOlder || loadingOlderRef.current.has(spaceId)) return;
      const anchor = oldestCreateTime(current.messages);
      const cursor = current.older ?? (anchor ? { until: anchor, pageToken: null } : null);
      if (!cursor) return;
      const generation = current.generation;
      const reactionEpoch = reactionEpochRef.current;
      loadingOlderRef.current.add(spaceId);
      patchView(spaceId, { loadingOlder: true, olderError: null });
      try {
        const body = await api.listGoogleChatMessages(spaceId, {
          pageSize: MESSAGE_PAGE,
          order: 'desc',
          until: cursor.until,
          ...(cursor.pageToken ? { pageToken: cursor.pageToken } : {}),
        });
        const next: string | null = body.nextPageToken || null;
        updateView(spaceId, (v) =>
          // The history was replaced while this page was in flight; it belongs
          // to the old history, so drop it.
          v.generation !== generation
            ? { ...v, loadingOlder: false }
            : {
                ...v,
                messages: mergeOlderPage(
                  v.messages,
                  keepNewerReactions(
                    (body.messages || []) as ChatMessage[],
                    v.messages,
                    reactionTouchedRef.current,
                    reactionEpoch,
                  ),
                ),
                hasOlder: !!next,
                older: next ? { until: cursor.until, pageToken: next } : null,
                loadingOlder: false,
              },
        );
      } catch (err: any) {
        updateView(spaceId, (v) =>
          v.generation !== generation
            ? { ...v, loadingOlder: false }
            : {
                ...v,
                loadingOlder: false,
                olderError: err.message || 'Failed to load older messages',
              },
        );
        if (err?.code === CHAT_READ_SCOPE_ERROR) refreshStatus();
      } finally {
        loadingOlderRef.current.delete(spaceId);
      }
    },
    [patchView, updateView, refreshStatus],
  );

  /**
   * Read the space's links. Failures are recorded too: the chips keep the
   * last good links, but Send to agent treats them as unverified.
   */
  const loadLinks = useCallback(async (spaceId: string): Promise<void> => {
    const seq = (linksSeqRef.current[spaceId] || 0) + 1;
    linksSeqRef.current[spaceId] = seq;
    let result: ChatMessageLink[] | null = null;
    try {
      const body = await api.listGoogleChatMessageLinks(spaceId);
      if (Array.isArray(body?.links)) result = body.links as ChatMessageLink[];
    } catch {
      result = null;
    }
    setLinks((all) => {
      const next = applyLinksResult(all[spaceId], seq, result);
      return next === all[spaceId] ? all : { ...all, [spaceId]: next };
    });
  }, []);

  useEffect(() => {
    loadSpaces();
  }, [loadSpaces]);

  // Push reloads the list itself when a message lands in an unlisted space.
  useEffect(() => {
    if (pushActive) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadSpaces({ background: true });
    }, SPACES_POLL_MS);
    return () => window.clearInterval(timer);
  }, [pushActive, loadSpaces]);

  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    api
      .getGoogleChatSettings()
      .then((body: { autoSendAgentReplies?: boolean }) => {
        // A write the user started meanwhile is newer than this read.
        if (!cancelled && !autoSendWriteRef.current) setAutoSend(!!body?.autoSendAgentReplies);
      })
      .catch(() => {
        if (!cancelled && !autoSendWriteRef.current) setAutoSend(null);
      });
    return () => {
      cancelled = true;
    };
  }, [canRead]);

  const toggleAutoSend = async (next: boolean) => {
    if (autoSendWriteRef.current) return;
    autoSendWriteRef.current = true;
    setAutoSendSaving(true);
    setAutoSendError(null);
    const previous = autoSend;
    setAutoSend(next);
    try {
      const body = await api.setGoogleChatSettings({ autoSendAgentReplies: next });
      setAutoSend(!!body?.autoSendAgentReplies);
    } catch (err: any) {
      setAutoSend(previous);
      setAutoSendError(err?.message || 'Could not save the setting');
    } finally {
      autoSendWriteRef.current = false;
      setAutoSendSaving(false);
    }
  };

  const renderDraft = (draft: ChatDraft, context: string | null) => (
    <GoogleChatDraftCard
      key={draft.id}
      draft={draft}
      context={context}
      onChanged={(updated) => {
        if (updated) chatDrafts.applyLocal(updated);
        else chatDrafts.reload();
        if (updated?.status === 'sent' && selectedId) {
          loadMessages(selectedId);
          // The approved reply flips its message's chip to "Agent replied".
          void loadLinks(selectedId);
        }
      }}
    />
  );

  useEffect(() => {
    if (!selectedId) return;
    loadMessages(selectedId);
    loadLinks(selectedId);
  }, [selectedId, loadMessages, loadLinks]);

  useEffect(() => {
    if (!selectedId) return;
    const timer = window.setInterval(
      () => {
        if (document.visibilityState !== 'visible') return;
        loadMessages(selectedId);
        loadLinks(selectedId);
      },
      pushActive ? PUSH_RECONCILE_MS : POLL_MS,
    );
    return () => window.clearInterval(timer);
  }, [selectedId, pushActive, loadMessages, loadLinks]);

  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const spacesRef = useRef(spaces);
  spacesRef.current = spaces;

  // Push: any message change (new, edited, deleted) re-reads the open space.
  // A new message also moves its conversation up the list, and one in a space
  // we haven't listed (a new DM) reloads the list.
  useEffect(() => {
    let refreshTimer: number | null = null;
    let reloadTimer: number | null = null;
    const refreshOpen = () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        const open = selectedIdRef.current;
        if (!open) return;
        loadMessages(open);
        loadLinks(open);
      }, PUSH_REFRESH_DEBOUNCE_MS);
    };
    const onMessage = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const spaceId = spaceIdFromName(detail?.spaceName);
      if (!spaceId) return;
      if (spaceId === selectedIdRef.current) refreshOpen();
      if ((detail?.kind ?? 'created') !== 'created') return;
      // Membership decides whether to reload the list; the ref is enough for
      // that (a reload is cheap and debounced).
      if (!spacesRef.current.some((sp) => sp.id === spaceId)) {
        if (reloadTimer === null) {
          reloadTimer = window.setTimeout(() => {
            reloadTimer = null;
            loadSpaces();
          }, PUSH_REFRESH_DEBOUNCE_MS);
        }
        return;
      }
      // The bump itself must compose: several events can land before React
      // renders, so each applies to the latest list, not the rendered one.
      const createTime = detail?.createTime;
      setSpaces((prev) => bumpSpaceActivity(prev, spaceId, createTime).spaces);
    };
    window.addEventListener('google_chat_message', onMessage);
    // Events sent while the socket was down are not replayed.
    window.addEventListener('agenthub:ws_reconnected', refreshOpen);
    return () => {
      window.removeEventListener('google_chat_message', onMessage);
      window.removeEventListener('agenthub:ws_reconnected', refreshOpen);
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      if (reloadTimer !== null) window.clearTimeout(reloadTimer);
    };
  }, [loadMessages, loadLinks, loadSpaces]);

  // Reading the open space clears its unread count, up to the newest message
  // actually loaded (a message that arrived after the last read stays unread
  // until the refresh shows it).
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );
  useEffect(() => {
    const onVisibility = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  // Report what the user has seen whenever the newest loaded message moves
  // forward, badge or not: a message shown before its push event arrives
  // must not count as unread when the event lands. The store sends a
  // boundary once and owns retries.
  const newestLoadedTime = newestCreateTime(view.messages);
  useEffect(() => {
    if (!selectedId || !view.loaded || !pageVisible || !newestLoadedTime) return;
    void chatPushStore().markRead(selectedId, newestLoadedTime);
  }, [selectedId, newestLoadedTime, view.loaded, pageVisible]);

  // Fetch where the user had read up to in Google Chat each time a space is
  // opened. Leaving the space drops it, so coming back starts fresh.
  const { canReadState, canWriteReadState, canReact } = consent;
  useEffect(() => {
    if (!selectedId || !canReadState) return;
    const spaceId = selectedId;
    let cancelled = false;
    api
      .getGoogleChatReadState(spaceId)
      .then((body: { lastReadTime?: string | null }) => {
        if (!cancelled) {
          setReadMarks((all) => ({
            ...all,
            [spaceId]: {
              lastReadTime: body?.lastReadTime ?? null,
              fetched: true,
              dividerHidden: false,
            },
          }));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setReadMarks((all) => ({
            ...all,
            [spaceId]: { lastReadTime: null, fetched: false, dividerHidden: true },
          }));
        }
      });
    return () => {
      cancelled = true;
      setReadMarks((all) => {
        const { [spaceId]: _dropped, ...rest } = all;
        return rest;
      });
    };
  }, [selectedId, canReadState]);

  // Mark the open space read in Google Chat too, but only once its read
  // position was fetched successfully: writing first would erase the Unread
  // line, and writing blind could move it backwards. The server also refuses
  // to move it backwards. Google's space read state covers top-level messages
  // only (thread replies have their own), so only those count.
  const openMark = selectedId ? readMarks[selectedId] : undefined;
  const readMarkFetched = !!openMark?.fetched;
  const readMark = openMark?.lastReadTime ?? null;
  const dividerReadTime = openMark && !openMark.dividerHidden ? openMark.lastReadTime : null;
  const newestTopLevel = newestTopLevelTime(view.messages);
  useEffect(() => {
    if (!selectedId || !canWriteReadState || !readMarkFetched) return;
    if (!view.loaded || !pageVisible || !newestTopLevel) return;
    const spaceId = selectedId;
    // The user may have read further in Google Chat since this pane last
    // wrote, so never move the position back past either one.
    const written = googleReadWrittenRef.current[spaceId] ?? null;
    const known =
      written && readMark
        ? compareRfc3339(written, readMark) >= 0
          ? written
          : readMark
        : (written ?? readMark);
    if (known && compareRfc3339(newestTopLevel, known) <= 0) return;
    googleReadWrittenRef.current[spaceId] = newestTopLevel;
    api.setGoogleChatReadState(spaceId, newestTopLevel).catch(() => {
      if (googleReadWrittenRef.current[spaceId] === newestTopLevel) {
        delete googleReadWrittenRef.current[spaceId];
      }
    });
  }, [
    selectedId,
    canWriteReadState,
    readMarkFetched,
    readMark,
    view.loaded,
    pageVisible,
    newestTopLevel,
  ]);

  useEffect(() => {
    setReactionMenuFor(null);
    setReactionError(null);
  }, [selectedId]);

  const toggleReaction = async (message: ChatMessage, emoji: string) => {
    setReactionMenuFor(null);
    if (!selectedId || !message.name || !message.id) return;
    const spaceId = selectedId;
    const name = message.name;
    const key = `${name}|${emoji}`;
    if (reactingRef.current.has(key)) return;
    reactingRef.current.add(key);
    setReactionError(null);
    const messageId = message.id;
    try {
      // The request and applying its result both run inside the queue, so
      // results are applied in the order Google made the changes.
      await reactionQueueRef.current(name, async () => {
        const body = await api.toggleGoogleChatReaction(spaceId, messageId, emoji);
        if (Array.isArray(body?.reactions)) {
          // Google's summary read back after the change: replace, never add a
          // delta, since a refresh may already include this change.
          const reactions = body.reactions as ChatReaction[];
          reactionTouchedRef.current.set(name, ++reactionEpochRef.current);
          updateView(spaceId, (v) => ({
            ...v,
            messages: v.messages.map((m) => (m.name === name ? { ...m, reactions } : m)),
          }));
        } else {
          // The change applied but the summary didn't come back: re-read.
          loadMessages(spaceId);
        }
      });
    } catch (err: any) {
      setReactionError({ name, error: err?.message || 'Could not update the reaction' });
      if (err?.code === 'google_chat_reactions_scope_required') refreshStatus();
    } finally {
      reactingRef.current.delete(key);
    }
  };

  // Follow the newest message, not the list length: prepending an older page
  // must not yank the view to the bottom.
  const newestName = messages.length ? messages[messages.length - 1].name : null;
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: 'end' });
  }, [newestName, selectedId]);

  const startOAuth = async (scopes: string[]) => {
    setOauthBusy(true);
    setError(null);
    setErrorHelp(null);
    try {
      const returnTo = window.location.pathname + window.location.search + window.location.hash;
      const body = await api.startGoogleOAuth({ returnTo, scopes });
      window.location.href = body.authorizeUrl;
    } catch (err: any) {
      setError(err.message || 'Failed to start Google consent');
      setOauthBusy(false);
    }
  };

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    const spaceId = selectedId;
    const submitted = composer;
    const text = submitted.text.trim();
    if (!spaceId || !text || sendingRef.current.has(spaceId)) return;
    sendingRef.current.add(spaceId);
    // Clear on submit so anything typed while the request is pending is a new
    // message, not text the completion handler would wipe.
    const clearedRev = submitted.rev + 1;
    updateComposer(spaceId, (c) => ({
      ...c,
      text: '',
      replyTo: null,
      rev: clearedRev,
      sending: true,
      error: null,
    }));
    try {
      await api.sendGoogleChatMessage(spaceId, {
        text,
        // The reply target only exists in spaces that support thread replies
        // (the button is gated on it); the proxy re-checks the space anyway.
        ...(submitted.replyTo?.threadName && selectedSpace?.supportsThreadReplies
          ? { threadName: submitted.replyTo.threadName }
          : {}),
      });
      updateComposer(spaceId, (c) => ({ ...c, sending: false }));
      // Replying means you've caught up, as in Google Chat.
      setReadMarks((all) =>
        all[spaceId] ? { ...all, [spaceId]: { ...all[spaceId], dividerHidden: true } } : all,
      );
      loadMessages(spaceId);
    } catch (err: any) {
      const reason = err.message || 'Failed to send message';
      if (err?.code === CHAT_SEND_SCOPE_ERROR) refreshStatus();
      updateComposer(spaceId, (c) =>
        c.rev === clearedRev
          ? // Untouched since submit: put the message back so it can be retried.
            {
              ...c,
              text: submitted.text,
              replyTo: submitted.replyTo,
              sending: false,
              error: reason,
            }
          : // The user started a new message; keep it and keep the failed text visible.
            { ...c, sending: false, error: `${reason}. Not sent: "${text}"` },
      );
    } finally {
      sendingRef.current.delete(spaceId);
    }
  };

  /**
   * Re-read the space's links before opening the dialog, so a duplicate
   * dispatch is warned about even when the pane's own link load hasn't
   * finished (or failed). The warning itself is derived at render time from
   * the latest links, so a poll landing while the dialog is open updates it.
   */
  const openSendToAgent = async (chosen: ChatMessage[], checkingKey: string) => {
    const named = chosen.filter((m): m is ChatMessage & { name: string } => !!m.name);
    if (!selectedId || !named.length || checkingDispatchRef.current) return;
    const spaceId = selectedId;
    const threaded = !!selectedSpace?.supportsThreadReplies;
    const target: PendingDispatch = {
      ...buildSeedForMessages(selectedSpace, messages, named),
      spaceId,
      targets: named.map((m) => ({
        messageName: m.name,
        threadName: threaded ? m.threadName : null,
      })),
    };
    checkingDispatchRef.current = true;
    setCheckingDispatch(checkingKey);
    setLinkError(null);
    try {
      await loadLinks(spaceId);
    } finally {
      checkingDispatchRef.current = false;
      setCheckingDispatch(null);
    }
    setDispatch(target);
  };

  const dispatchWarning = dispatch
    ? dispatchWarningForMany(
        links[dispatch.spaceId],
        dispatch.targets.map((t) => t.messageName),
      )
    : null;

  const linkDispatchedSession = async (target: PendingDispatch, session: SessionWire) => {
    const results = await Promise.allSettled(
      target.targets.map((t) =>
        api.createGoogleChatMessageLink(target.spaceId, {
          messageName: t.messageName,
          threadName: t.threadName,
          sessionId: session.id,
        }),
      ),
    );
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length) {
      // The session already exists; say the message isn't marked rather than
      // pretending the dispatch failed.
      const what =
        target.targets.length === 1
          ? 'the message'
          : `${failures.length} of ${target.targets.length} messages`;
      setLinkError(
        `Session started, but ${what} could not be marked as sent: ${
          failures[0].reason?.message || 'unknown error'
        }`,
      );
    }
    loadLinks(target.spaceId);
  };

  const connected = !!status?.connected;
  const configured = status?.serverConfigured !== false;

  let emptyState: {
    title: string;
    body: string;
    action: string | null;
    onAction?: () => void;
  } | null = null;
  if (!configured && !connected) {
    emptyState = {
      title: 'Google is not configured',
      body: 'An Admin needs to add the Google OAuth app before Google Chat can connect.',
      action: onOpenAccountSettings ? 'Open Account settings' : null,
      onAction: onOpenAccountSettings,
    };
  } else if (!connected) {
    emptyState = {
      title: 'Connect Google to use Chat',
      body: 'Messages stay server-side through the Google proxy. Connect your account to continue.',
      action: 'Connect Google',
      onAction: () => startOAuth(CHAT_SURFACE_SCOPES),
    };
  } else if (!canRead) {
    emptyState = {
      title: 'Enable Google Chat access',
      body: `Connected as ${status?.email || 'Google account'}, but Chat access has not been granted yet. Google Chat requires a Google Workspace account.`,
      action: 'Enable Chat',
      // Request sending in the same round-trip so one consent unlocks the pane.
      onAction: () =>
        startOAuth([
          ...consent.missingRead,
          ...consent.missingSend,
          ...consent.missingNames,
          ...consent.missingExtras,
        ]),
    };
  } else if (!spaces.length && !spacesLoading && !error) {
    emptyState = {
      title: 'No conversations',
      body: 'Spaces, group chats, and direct messages you belong to will appear here.',
      action: null,
    };
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col bg-gray-950" data-testid="google-chat-page">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <MessagesSquare size={16} className="text-blue-300" />
          <h2 className="text-lg font-semibold text-white">Google Chat</h2>
        </div>
        <div className="flex items-center gap-3">
          {canRead && consent.missingExtras.length > 0 && (
            <button
              type="button"
              data-testid="chat-enable-extras"
              onClick={() => startOAuth(consent.missingExtras)}
              disabled={oauthBusy}
              title="Lets Agent Hub add your reactions, show where you stopped reading, and mark conversations read in Google Chat."
              className="inline-flex items-center gap-1 text-xs text-blue-300 hover:text-blue-200 disabled:opacity-50"
            >
              <SmilePlus size={13} />
              Turn on reactions and read status
            </button>
          )}
          {autoSend !== null && (
            <label
              className="inline-flex items-center gap-2 text-xs text-gray-400"
              title="When off, replies an agent posts from a session wait here and in the session for your approval. They go out under your name."
            >
              <input
                type="checkbox"
                checked={autoSend}
                disabled={autoSendSaving}
                onChange={(e) => toggleAutoSend(e.target.checked)}
                data-testid="chat-auto-send-toggle"
              />
              Auto-send agent replies
              {autoSendError && <span className="text-red-300">{autoSendError}</span>}
            </label>
          )}
          <button
            type="button"
            onClick={() => {
              loadSpaces();
              if (selectedId) {
                loadMessages(selectedId);
                void loadLinks(selectedId);
              }
              chatDrafts.reload();
            }}
            disabled={spacesLoading}
            className="inline-flex items-center gap-2 rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-50"
          >
            <RefreshCw size={14} className={spacesLoading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="m-4 flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
          <div className="min-w-0">
            <div>{error}</div>
            {errorHelp && (
              <a
                href={errorHelp.url}
                target="_blank"
                rel="noreferrer"
                data-testid="google-chat-setup-help"
                className="mt-1 inline-flex items-center gap-1 text-red-100 underline hover:text-white"
              >
                <ExternalLink size={12} />
                {errorHelp.label}
              </a>
            )}
          </div>
        </div>
      )}

      {loading ? (
        <div className="m-4 flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm text-gray-400">
          <Loader2 size={16} className="animate-spin" />
          Loading Google Chat...
        </div>
      ) : emptyState ? (
        <div className="m-4 rounded-lg border border-gray-800 bg-gray-900 p-6">
          <h3 className="text-lg font-semibold text-white">{emptyState.title}</h3>
          <p className="mt-2 max-w-2xl text-sm text-gray-400">{emptyState.body}</p>
          {emptyState.action && (
            <button
              type="button"
              onClick={emptyState.onAction}
              disabled={oauthBusy}
              className="mt-4 inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {oauthBusy ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <ExternalLink size={14} />
              )}
              {emptyState.action}
            </button>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav
            aria-label="Chat spaces"
            className="max-h-48 shrink-0 overflow-y-auto border-b border-gray-800 md:max-h-none md:w-64 md:border-b-0 md:border-r"
          >
            {consent.missingNames.length > 0 &&
              spaces.some(
                (sp) =>
                  !sp.displayName &&
                  (sp.spaceType === 'DIRECT_MESSAGE' || sp.spaceType === 'GROUP_CHAT'),
              ) && (
                <div
                  className="m-2 rounded border border-gray-800 bg-gray-900 p-2 text-xs text-gray-400"
                  data-testid="chat-enable-names"
                >
                  Direct messages and group chats show an id until Agent Hub can see who is in them.
                  <button
                    type="button"
                    onClick={() => startOAuth(consent.missingNames)}
                    disabled={oauthBusy}
                    className="mt-1 block text-blue-300 hover:text-blue-200 disabled:opacity-50"
                  >
                    Show participant names
                  </button>
                </div>
              )}
            {spaces.length > 8 && (
              <input
                type="search"
                value={spaceFilter}
                onChange={(e) => setSpaceFilter(e.target.value)}
                placeholder="Filter conversations"
                aria-label="Filter conversations"
                className="m-2 w-[calc(100%-1rem)] rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-white outline-none focus:border-blue-500"
              />
            )}
            {filterSpaces(spaces, spaceFilter).map((space) => (
              <button
                key={space.id}
                type="button"
                onClick={() => setSelectedId(space.id)}
                data-testid={`chat-space-${space.id}`}
                className={`block w-full truncate px-4 py-2 text-left text-sm ${
                  space.id === selectedId
                    ? 'bg-gray-800 text-white'
                    : 'text-gray-300 hover:bg-gray-800/50'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={`min-w-0 flex-1 truncate ${
                      push.unread[`spaces/${space.id}`] ? 'font-semibold text-white' : ''
                    }`}
                  >
                    {chatSpaceLabel(space)}
                  </span>
                  {!!push.unread[`spaces/${space.id}`] && (
                    <span
                      data-testid={`chat-space-unread-${space.id}`}
                      aria-label={`${push.unread[`spaces/${space.id}`].count} unread`}
                      className="shrink-0 rounded-full bg-blue-600 px-1.5 text-[10px] font-semibold leading-4 text-white"
                    >
                      {formatUnreadCount(push.unread[`spaces/${space.id}`].count)}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </nav>

          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            {selectedSpace && (
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-gray-800 px-4 py-2">
                <span className="truncate text-sm font-medium text-gray-200">
                  {chatSpaceLabel(selectedSpace)}
                </span>
                {chatSpaceDeepLink(selectedSpace) && (
                  <a
                    href={chatSpaceDeepLink(selectedSpace) as string}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-white"
                  >
                    <ExternalLink size={12} />
                    Open in Google Chat
                  </a>
                )}
              </div>
            )}

            {pickedMessages.length > 0 && (
              <div
                className="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-800 bg-gray-900 px-4 py-2 text-xs text-gray-300"
                data-testid="chat-selection-bar"
              >
                <span className="font-medium text-gray-200">{pickedMessages.length} selected</span>
                <button
                  type="button"
                  onClick={() => void openSendToAgent(pickedMessages, 'selection')}
                  disabled={checkingDispatch !== null}
                  title="Start one agent session with all selected messages"
                  className="inline-flex items-center gap-1 rounded border border-blue-500/40 bg-blue-500/10 px-2 py-1 text-blue-200 hover:bg-blue-500/20 disabled:opacity-50"
                >
                  {checkingDispatch === 'selection' ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <MessageSquarePlus size={13} />
                  )}
                  Send selected to agent
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setTicketDraft(buildTicketDraftForMessages(selectedSpace, pickedMessages))
                  }
                  title="Create one kanban ticket from all selected messages"
                  className="inline-flex items-center gap-1 rounded border border-gray-700 px-2 py-1 hover:bg-gray-800"
                >
                  <Ticket size={13} />
                  Ticket from selected
                </button>
                <button
                  type="button"
                  onClick={() => setPicked(new Set())}
                  className="ml-auto rounded px-2 py-1 text-gray-400 hover:bg-gray-800 hover:text-white"
                >
                  Clear selection
                </button>
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {linkError && (
                <div className="mb-3 flex items-center gap-2 text-xs text-amber-300">
                  <AlertCircle size={14} className="flex-shrink-0" />
                  {linkError}
                </div>
              )}
              {view.error && view.loaded && (
                <div className="mb-3 flex items-center gap-2 text-xs text-amber-300">
                  <AlertCircle size={14} className="flex-shrink-0" />
                  Could not refresh: {view.error}
                </div>
              )}
              {view.loading && !view.loaded ? (
                <div className="flex items-center gap-2 text-sm text-gray-400">
                  <Loader2 size={16} className="animate-spin" />
                  Loading messages...
                </div>
              ) : view.error && !view.loaded ? (
                <div className="flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
                  <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
                  {view.error}
                </div>
              ) : !messages.length ? (
                <p className="text-sm text-gray-500">No messages yet.</p>
              ) : (
                <>
                  {view.hasOlder ? (
                    <div className="mb-3 flex flex-col items-center gap-1">
                      <button
                        type="button"
                        onClick={() => selectedId && loadOlder(selectedId)}
                        disabled={view.loadingOlder}
                        className="inline-flex items-center gap-2 rounded border border-gray-700 px-3 py-1 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50"
                      >
                        {view.loadingOlder && <Loader2 size={12} className="animate-spin" />}
                        Load older messages
                      </button>
                      {view.olderError && (
                        <span className="text-xs text-red-300">{view.olderError}</span>
                      )}
                    </div>
                  ) : (
                    <p className="mb-3 text-center text-xs text-gray-600">Start of conversation</p>
                  )}
                  <ul className="pb-2">
                    {layoutChatMessages(messages, {
                      selfUserName,
                      lastReadTime: dividerReadTime,
                    }).map(({ message, own, showHeader, dayLabel, unreadDivider }) => {
                      const key = message.name || message.id;
                      const senderLabel = chatSenderLabel(message.sender);
                      const capture = message.name ? todoCaptures[message.name] : undefined;
                      const added = capture?.status === 'added';
                      const saving = capture?.status === 'saving';
                      const chip = chatLinkChip(
                        message.name ? messageLinks.get(message.name) : undefined,
                      );
                      const reactions = message.reactions ?? [];
                      const menuOpen = reactionMenuFor === message.name;
                      const isPicked = !!message.name && picked.has(message.name);
                      const canReply =
                        canSend && !!selectedSpace?.supportsThreadReplies && !!message.threadName;
                      const toolButton =
                        'inline-flex h-7 w-7 items-center justify-center rounded-full text-gray-300 hover:bg-gray-700 hover:text-white disabled:opacity-50';
                      return (
                        <Fragment key={key}>
                          {dayLabel && (
                            <li
                              role="separator"
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
                              data-testid="chat-unread-divider"
                              className="my-3 flex items-center gap-3 text-xs font-medium text-red-400"
                            >
                              <span className="h-px flex-1 bg-red-500/50" />
                              Unread
                              <span className="h-px flex-1 bg-red-500/50" />
                            </li>
                          )}
                          <li
                            data-testid="chat-message"
                            data-own={own ? 'true' : undefined}
                            className={`group relative flex gap-2 rounded-lg px-1 py-0.5 ${
                              isPicked ? 'bg-blue-500/10' : 'hover:bg-white/[0.02]'
                            } ${own ? 'flex-row-reverse' : ''} ${showHeader ? 'mt-3' : ''} ${
                              message.threadReply ? (own ? 'mr-8' : 'ml-8') : ''
                            }`}
                          >
                            <div className="flex w-4 shrink-0 items-start pt-2">
                              {message.name && !message.deleted && (
                                <input
                                  type="checkbox"
                                  checked={isPicked}
                                  onChange={() => message.name && togglePicked(message.name)}
                                  aria-label={`Select message from ${own ? 'you' : senderLabel}`}
                                  data-testid="chat-message-select"
                                  className={`h-3.5 w-3.5 cursor-pointer accent-blue-500 focus:opacity-100 group-hover:opacity-100 ${
                                    isPicked || pickedMessages.length > 0
                                      ? ''
                                      : '[@media(hover:hover)]:opacity-0'
                                  }`}
                                />
                              )}
                            </div>
                            {!own && (
                              <div className="w-8 shrink-0" aria-hidden="true">
                                {showHeader &&
                                  (message.sender?.type === 'BOT' ? (
                                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-700 text-gray-200">
                                      <Bot size={16} />
                                    </div>
                                  ) : (
                                    <div
                                      className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold text-white ${avatarColor(
                                        message.sender,
                                      )}`}
                                    >
                                      {avatarInitials(senderLabel)}
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
                                  {message.threadReply && (
                                    <CornerDownRight
                                      size={12}
                                      className="self-center text-gray-500"
                                      aria-label="Thread reply"
                                    />
                                  )}
                                  {!own && (
                                    <span className="font-semibold text-gray-100">
                                      {senderLabel}
                                    </span>
                                  )}
                                  {message.createTime && (
                                    <span
                                      className="text-gray-500"
                                      title={formatDateTime(message.createTime)}
                                    >
                                      {formatTime(message.createTime, {
                                        hour: 'numeric',
                                        minute: '2-digit',
                                      })}
                                    </span>
                                  )}
                                </div>
                              )}
                              <div
                                title={showHeader ? undefined : formatDateTime(message.createTime)}
                                className={`whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${
                                  own ? 'bg-blue-600/30 text-blue-50' : 'bg-gray-800 text-gray-100'
                                } ${showHeader ? (own ? 'rounded-tr-md' : 'rounded-tl-md') : ''}`}
                              >
                                {message.deleted ? (
                                  <span className="italic text-gray-500">Message deleted</span>
                                ) : (
                                  message.text || (
                                    <span className="italic text-gray-500">(no text)</span>
                                  )
                                )}
                                {!message.deleted &&
                                message.attachments?.length &&
                                selectedId &&
                                message.id ? (
                                  <GoogleChatAttachments
                                    spaceId={selectedId}
                                    messageId={message.id}
                                    attachments={message.attachments}
                                  />
                                ) : (
                                  message.attachmentCount > 0 && (
                                    <div className="mt-1 flex items-center gap-1 text-xs text-gray-400">
                                      <Paperclip size={12} />
                                      {message.attachmentCount} attachment
                                      {message.attachmentCount === 1 ? '' : 's'}
                                    </div>
                                  )
                                )}
                              </div>
                              {(reactions.length > 0 || chip) && (
                                <div
                                  className={`mt-1 flex flex-wrap items-center gap-1 ${
                                    own ? 'justify-end' : ''
                                  }`}
                                >
                                  {reactions.map((r) => {
                                    const custom = !!r.customEmojiUrl || r.emoji.startsWith(':');
                                    return (
                                      <button
                                        key={r.emoji}
                                        type="button"
                                        data-testid="chat-reaction"
                                        disabled={!canReact || custom || message.deleted}
                                        onClick={() => void toggleReaction(message, r.emoji)}
                                        title={
                                          canReact
                                            ? `${r.count} reacted with ${r.emoji}`
                                            : `${r.count} reacted with ${r.emoji}. Turn on reactions to react.`
                                        }
                                        className="inline-flex items-center gap-1 rounded-full border border-gray-700 bg-gray-900 px-2 py-0.5 text-xs text-gray-200 hover:border-blue-500/60 hover:bg-blue-500/10 disabled:cursor-default disabled:hover:border-gray-700 disabled:hover:bg-gray-900"
                                      >
                                        {r.customEmojiUrl ? (
                                          <img
                                            src={r.customEmojiUrl}
                                            alt={r.emoji}
                                            className="h-4 w-4"
                                          />
                                        ) : (
                                          <span>{r.emoji}</span>
                                        )}
                                        <span>{r.count}</span>
                                      </button>
                                    );
                                  })}
                                  {chip &&
                                    (() => {
                                      const replied = chip.label === 'Agent replied';
                                      const session = chip.link.sessionName || 'Untitled session';
                                      const extra = chip.count > 1 ? ` (+${chip.count - 1})` : '';
                                      return (
                                        <button
                                          type="button"
                                          data-testid="chat-link-chip"
                                          disabled={!onOpenSession || !chip.link.agentId}
                                          onClick={() =>
                                            chip.link.agentId &&
                                            onOpenSession?.({
                                              sessionId: chip.link.sessionId,
                                              agentId: chip.link.agentId,
                                            })
                                          }
                                          title={`Open session: ${session}`}
                                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium disabled:cursor-default ${
                                            replied
                                              ? 'border-green-500/40 bg-green-500/10 text-green-300 hover:bg-green-500/20'
                                              : 'border-blue-500/40 bg-blue-500/10 text-blue-200 hover:bg-blue-500/20'
                                          }`}
                                        >
                                          {replied ? <CheckCircle2 size={11} /> : <Bot size={11} />}
                                          {chip.label}
                                          {extra}
                                        </button>
                                      );
                                    })()}
                                </div>
                              )}
                              {capture?.status === 'error' && (
                                <span role="alert" className="mt-1 px-1 text-xs text-red-300">
                                  {capture.error}
                                </span>
                              )}
                              {reactionError?.name === message.name && (
                                <span className="mt-1 px-1 text-xs text-red-300">
                                  {reactionError.error}
                                </span>
                              )}
                              {message.name &&
                                placedDrafts.byMessage.get(message.name)?.map((d) => (
                                  <div key={d.id} className="mt-2 w-full">
                                    {renderDraft(d, 'reply in this thread')}
                                  </div>
                                ))}
                            </div>
                            {!message.deleted && (
                              <div
                                data-testid="chat-message-actions"
                                className={`absolute -top-3 z-10 flex items-center gap-0.5 rounded-full border border-gray-700 bg-gray-900 p-0.5 shadow-lg transition-opacity focus-within:opacity-100 group-hover:opacity-100 ${
                                  own ? 'left-2' : 'right-2'
                                } ${menuOpen ? 'opacity-100' : '[@media(hover:hover)]:opacity-0'}`}
                              >
                                {canReact && (
                                  <button
                                    type="button"
                                    aria-label="Add reaction"
                                    title="Add reaction"
                                    aria-expanded={menuOpen}
                                    onClick={() =>
                                      setReactionMenuFor(menuOpen ? null : message.name)
                                    }
                                    className={toolButton}
                                  >
                                    <SmilePlus size={15} />
                                  </button>
                                )}
                                {canReply && (
                                  <button
                                    type="button"
                                    aria-label="Reply in thread"
                                    title="Reply in thread"
                                    onClick={() => editComposer({ replyTo: message })}
                                    className={toolButton}
                                  >
                                    <Reply size={15} />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  aria-label="Send to agent"
                                  title="Send to agent: start a session with this message as the task"
                                  onClick={() =>
                                    message.name && void openSendToAgent([message], message.name)
                                  }
                                  disabled={checkingDispatch !== null}
                                  className={`${toolButton} text-blue-300`}
                                >
                                  {checkingDispatch === message.name ? (
                                    <Loader2 size={15} className="animate-spin" />
                                  ) : (
                                    <MessageSquarePlus size={15} />
                                  )}
                                </button>
                                <button
                                  type="button"
                                  aria-label="Ticket"
                                  title="Create a kanban ticket from this message"
                                  onClick={() =>
                                    setTicketDraft(
                                      buildTicketDraftForMessage(selectedSpace, message),
                                    )
                                  }
                                  className={toolButton}
                                >
                                  <Ticket size={15} />
                                </button>
                                <button
                                  type="button"
                                  aria-label={added ? 'Added to todos' : 'Add to todos'}
                                  title={
                                    added
                                      ? 'Added to your todos'
                                      : 'Add this message to your personal todos'
                                  }
                                  onClick={() => void addMessageToTodos(message)}
                                  disabled={added || saving}
                                  className={toolButton}
                                >
                                  {saving ? (
                                    <Loader2 size={15} className="animate-spin" />
                                  ) : added ? (
                                    <CheckCircle2 size={15} className="text-green-400" />
                                  ) : (
                                    <ListTodo size={15} />
                                  )}
                                </button>
                                {menuOpen && (
                                  <div
                                    role="menu"
                                    aria-label="Reactions"
                                    className={`absolute top-full mt-1 flex gap-0.5 rounded-full border border-gray-700 bg-gray-900 p-1 shadow-lg ${
                                      own ? 'left-0' : 'right-0'
                                    }`}
                                  >
                                    {QUICK_REACTIONS.map((emoji) => (
                                      <button
                                        key={emoji}
                                        type="button"
                                        role="menuitem"
                                        aria-label={`React with ${emoji}`}
                                        onClick={() => void toggleReaction(message, emoji)}
                                        className="flex h-8 w-8 items-center justify-center rounded-full text-lg hover:bg-gray-700"
                                      >
                                        {emoji}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </li>
                        </Fragment>
                      );
                    })}
                  </ul>
                </>
              )}
              {chatDrafts.error && (
                <div className="mt-3">
                  <DraftsLoadError error={chatDrafts.error} onRetry={chatDrafts.reload} />
                </div>
              )}
              {placedDrafts.unplaced.length > 0 && (
                <div className="mt-3 space-y-2" data-testid="chat-unplaced-drafts">
                  {placedDrafts.unplaced.map((d) =>
                    renderDraft(d, d.threadName ? 'thread reply' : null),
                  )}
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {selectedSpace && !canSend && (
              <div
                className="flex shrink-0 items-center justify-between gap-3 border-t border-gray-800 px-4 py-3 text-sm text-gray-400"
                data-testid="chat-enable-sending"
              >
                <span>Replying from Agent Hub needs permission to send Chat messages.</span>
                <button
                  type="button"
                  onClick={() => startOAuth(consent.missingSend)}
                  disabled={oauthBusy}
                  className="inline-flex flex-shrink-0 items-center gap-2 rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  {oauthBusy ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <ExternalLink size={14} />
                  )}
                  Enable sending
                </button>
              </div>
            )}
            {selectedSpace && canSend && (
              <form onSubmit={send} className="shrink-0 border-t border-gray-800 p-3">
                {replyTo && (
                  <div className="mb-2 flex items-center justify-between gap-2 rounded bg-gray-900 px-2 py-1 text-xs text-gray-400">
                    <span className="truncate">
                      Replying to {chatSenderLabel(replyTo.sender)}:{' '}
                      {(replyTo.text || '').split('\n')[0]}
                    </span>
                    <button
                      type="button"
                      onClick={() => editComposer({ replyTo: null })}
                      aria-label="Cancel reply"
                      className="rounded p-1 hover:bg-gray-800 hover:text-white"
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}
                {sendError && <div className="mb-2 text-xs text-red-300">{sendError}</div>}
                <div className="flex items-end gap-2">
                  <textarea
                    value={draft}
                    onChange={(e) => editComposer({ text: e.target.value })}
                    onKeyDown={(e) => {
                      if (isSubmitEnter(e)) {
                        e.preventDefault();
                        e.currentTarget.form?.requestSubmit();
                      }
                    }}
                    rows={2}
                    placeholder={`Message ${chatSpaceLabel(selectedSpace)}`}
                    className="min-w-0 flex-1 resize-none rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
                  />
                  <button
                    type="submit"
                    disabled={!draft.trim() || sending}
                    aria-label="Send"
                    className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                    Send
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}

      {ticketDraft && (
        <CaptureToTicketModal
          draft={ticketDraft}
          onClose={() => setTicketDraft(null)}
          onCreated={() => setPicked(new Set())}
        />
      )}
      {dispatch && (
        <StartSessionModal
          contextLabel={dispatch.label}
          seedMessage={dispatch.seed}
          defaultName={dispatch.label}
          warning={dispatchWarning}
          onClose={() => setDispatch(null)}
          onStarted={(session) => {
            void linkDispatchedSession(dispatch, session);
            if (dispatch.targets.length > 1) setPicked(new Set());
            onSessionStarted?.(session);
          }}
        />
      )}
    </div>
  );
}
