import { useCallback, useEffect, useRef, useState } from 'react';
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
  Ticket,
  X,
} from 'lucide-react';
import { api } from '../utils/api';
import type { SessionWire } from '@shared/types';
import { buildChatSessionSeed } from '@shared/utils/sessionSeed';
import { buildChatCardDraft, type CaptureCardDraft } from '@shared/utils/captureCard';
import { buildChatTodoDraft, type CaptureTodoDraft } from '@shared/utils/captureTodo';
import StartSessionModal from './StartSessionModal';
import CaptureToTicketModal from './CaptureToTicketModal';
import { formatDateTime } from '../utils/time';
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
  filterSpaces,
  reconcileRange,
  oldestCreateTime,
  uniqueMessages,
  mergeOlderPage,
  type ChatMessage,
  type ChatMessageLink,
  type ChatSpace,
  chatLinkChip,
  linksByMessage,
  applyLinksResult,
  dispatchWarningFor,
  LINKS_UNKNOWN_WARNING,
  type SpaceLinks,
  chatSetupHelpLink,
} from '../utils/googleChat';
import { isSubmitEnter } from '../utils/keyboard';
import { placeDrafts, useChatDrafts, type ChatDraft } from '../utils/googleChatDrafts';
import GoogleChatDraftCard from './GoogleChatDraftCard';
import { DraftsLoadError } from './GoogleChatDraftsPanel';

type GoogleStatus = NonNullable<GoogleStatusLike>;

// New customer messages should show up without a manual refresh while the
// pane is open. Polling is the simple path; push via the Workspace Events API
// would remove it.
const POLL_MS = 30_000;
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

/** "Send to agent" in progress: the seed plus the message it should be linked to. */
type PendingDispatch = {
  label: string;
  seed: string;
  spaceId: string;
  messageName: string;
  /** Only for spaces that keep replies in threads, matching the seed. */
  threadName: string | null;
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
  // "Add to todos" progress per message name. Kept for the life of the page so
  // a captured message keeps showing "Added" when the user switches back.
  const [todoCaptures, setTodoCaptures] = useState<Record<string, TodoCapture>>({});
  const todoCapturingRef = useRef<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement | null>(null);
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
  // Every capability gate and enable action below derives from this one value.
  const consent = chatConsent(status);
  const { canRead, canSend } = consent;

  const view = (selectedId && views[selectedId]) || EMPTY_VIEW;
  const messageLinks = linksByMessage((selectedId && links[selectedId]?.links) || []);
  const messages = view.messages;
  const chatDrafts = useChatDrafts({ spaceId: selectedId ?? undefined }, canRead);
  const placedDrafts = placeDrafts(messages, chatDrafts.drafts);
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

  const loadSpaces = useCallback(async () => {
    const seq = ++spacesSeqRef.current;
    const isCurrent = () => seq === spacesSeqRef.current;
    setError(null);
    setErrorHelp(null);
    setSpacesLoading(true);
    try {
      const nextStatus = await api.getGoogleStatus();
      if (!isCurrent()) return;
      setStatus(nextStatus);
      if (nextStatus.connected && chatConsent(nextStatus).canRead) {
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
      if (!isCurrent()) return;
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
      patchView(spaceId, { loading: true });
      try {
        if (!since) {
          const body = await api.listGoogleChatMessages(spaceId, {
            pageSize: MESSAGE_PAGE,
            order: 'desc',
          });
          if (!isCurrent()) return;
          updateView(spaceId, (v) => ({
            ...v,
            messages: uniqueMessages((body.messages || []) as ChatMessage[]),
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
                messages: reconcileRange(v.messages, fresh, since),
                loaded: true,
                loading: false,
                error: null,
              }
            : // The loaded range outgrew what a refresh re-reads: keep the
              // newest slice we did read and page back from there.
              {
                ...v,
                messages: uniqueMessages(fresh),
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
                messages: mergeOlderPage(v.messages, (body.messages || []) as ChatMessage[]),
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
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      loadMessages(selectedId);
      loadLinks(selectedId);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [selectedId, loadMessages, loadLinks]);

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
  const openSendToAgent = async (message: ChatMessage) => {
    if (!selectedId || !message.name || checkingDispatchRef.current) return;
    const spaceId = selectedId;
    const target: PendingDispatch = {
      ...buildSeedForMessage(selectedSpace, messages, message),
      spaceId,
      messageName: message.name,
      threadName: selectedSpace?.supportsThreadReplies ? message.threadName : null,
    };
    checkingDispatchRef.current = true;
    setCheckingDispatch(message.name);
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
    ? dispatchWarningFor(links[dispatch.spaceId], dispatch.messageName)
    : null;

  const linkDispatchedSession = async (target: PendingDispatch, session: SessionWire) => {
    try {
      await api.createGoogleChatMessageLink(target.spaceId, {
        messageName: target.messageName,
        threadName: target.threadName,
        sessionId: session.id,
      });
    } catch (err: any) {
      // The session already exists; say the message isn't marked rather than
      // pretending the dispatch failed.
      setLinkError(
        `Session started, but the message could not be marked as sent: ${
          err?.message || 'unknown error'
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
        startOAuth([...consent.missingRead, ...consent.missingSend, ...consent.missingNames]),
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
                {chatSpaceLabel(space)}
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
                  <ul className="space-y-3">
                    {messages.map((message) => (
                      <li
                        key={message.name || message.id}
                        className={`group rounded-lg border border-gray-800 bg-gray-900 p-3 ${
                          message.threadReply ? 'ml-6' : ''
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 text-xs text-gray-400">
                          <span className="flex min-w-0 items-center gap-1 truncate font-medium text-gray-200">
                            {message.threadReply && <CornerDownRight size={12} />}
                            {chatSenderLabel(message.sender)}
                          </span>
                          <span className="flex flex-shrink-0 items-center gap-2">
                            {(() => {
                              const chip = chatLinkChip(
                                message.name ? messageLinks.get(message.name) : undefined,
                              );
                              if (!chip) return null;
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
                            {message.createTime && (
                              <span>{formatDateTime(message.createTime)}</span>
                            )}
                          </span>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-200">
                          {message.deleted ? (
                            <span className="italic text-gray-500">Message deleted</span>
                          ) : (
                            message.text || <span className="italic text-gray-500">(no text)</span>
                          )}
                        </p>
                        {message.attachmentCount > 0 && (
                          <div className="mt-1 inline-flex items-center gap-1 text-xs text-gray-500">
                            <Paperclip size={12} />
                            {message.attachmentCount} attachment
                            {message.attachmentCount === 1 ? '' : 's'}
                          </div>
                        )}
                        {!message.deleted && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => void openSendToAgent(message)}
                              disabled={checkingDispatch !== null}
                              title="Start an agent session with this message as the task"
                              className="inline-flex items-center gap-1 rounded border border-blue-500/40 bg-blue-500/10 px-2 py-1 text-xs text-blue-200 hover:bg-blue-500/20 disabled:opacity-50"
                            >
                              {checkingDispatch === message.name ? (
                                <Loader2 size={13} className="animate-spin" />
                              ) : (
                                <MessageSquarePlus size={13} />
                              )}
                              Send to agent
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setTicketDraft(buildTicketDraftForMessage(selectedSpace, message))
                              }
                              title="Create a kanban ticket from this message"
                              className="inline-flex items-center gap-1 rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800"
                            >
                              <Ticket size={13} />
                              Ticket
                            </button>
                            {(() => {
                              const capture = message.name ? todoCaptures[message.name] : undefined;
                              const added = capture?.status === 'added';
                              const saving = capture?.status === 'saving';
                              return (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => void addMessageToTodos(message)}
                                    disabled={added || saving}
                                    title={
                                      added
                                        ? 'Added to your todos'
                                        : 'Add this message to your personal todos'
                                    }
                                    className="inline-flex items-center gap-1 rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-60"
                                  >
                                    {saving ? (
                                      <Loader2 size={13} className="animate-spin" />
                                    ) : added ? (
                                      <CheckCircle2 size={13} className="text-green-400" />
                                    ) : (
                                      <ListTodo size={13} />
                                    )}
                                    {added ? 'Added to todos' : 'Add to todos'}
                                  </button>
                                  {capture?.status === 'error' && (
                                    <span role="alert" className="self-center text-xs text-red-300">
                                      {capture.error}
                                    </span>
                                  )}
                                </>
                              );
                            })()}
                            {canSend &&
                              selectedSpace?.supportsThreadReplies &&
                              message.threadName && (
                                <button
                                  type="button"
                                  onClick={() => editComposer({ replyTo: message })}
                                  className="inline-flex items-center gap-1 rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800"
                                >
                                  <Reply size={13} />
                                  Reply in thread
                                </button>
                              )}
                          </div>
                        )}
                        {message.name &&
                          placedDrafts.byMessage.get(message.name)?.map((d) => (
                            <div key={d.id} className="mt-2">
                              {renderDraft(d, 'reply in this thread')}
                            </div>
                          ))}
                      </li>
                    ))}
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
        <CaptureToTicketModal draft={ticketDraft} onClose={() => setTicketDraft(null)} />
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
            onSessionStarted?.(session);
          }}
        />
      )}
    </div>
  );
}
