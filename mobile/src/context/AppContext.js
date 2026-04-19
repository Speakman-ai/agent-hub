import React, { createContext, useState, useCallback, useEffect, useContext, useMemo, useRef } from 'react';
import { api } from '../utils/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { extractSubmittedAskIds } from '../utils/askAnswers';
import { loadOrgs, migrateFromLegacy, getOrgs } from '../utils/orgs';
import { loadConnectionConfig, getApiBaseUrl } from '../utils/config';
import { loadAuthToken, isAuthenticated, getAuthStatus } from '../utils/auth';
import {
  loadSetupDismissed,
  saveSetupDismissed,
  shouldShowWizard,
} from '../utils/setupState';
import { hydrateChangesReady } from '../utils/changesReady';
import { resolveSessionWorktree, applyDetectedFlag } from '../utils/worktreeState';
import { selectSessionToActivate } from '../utils/sessionSelection';
import { applyEntryUnread, clearProjectUnread } from '../utils/threads';
import { registerForPushNotifications, presentLocalNotification } from '../utils/push';
import { mapBroadcastToNotification } from '../utils/ticketNotifications';
import { routeNotificationTap } from '../utils/notificationRouting';
import { uploadAttachments } from '../utils/uploadAttachments';
import { createReloadMessages } from '../utils/sessionReload';

const AppContext = createContext(null);

const ENGINE_DEFAULT_MODELS = {
  'claude-code': 'claude-opus-4-7',
  'cursor-agent': 'gpt-5.3-codex-high',
};

export function AppProvider({ children }) {
  const [agents, setAgents] = useState([]);
  const [projects, setProjects] = useState([]);
  const [activeAgentId, setActiveAgentId] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [thinking, setThinking] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingMsgId, setStreamingMsgId] = useState(null);
  const [streamingEngine, setStreamingEngine] = useState(null);
  const [sessionEngine, setSessionEngine] = useState('claude-code');
  const [sessionModel, setSessionModel] = useState('claude-opus-4-7');
  // Git-worktree isolation toggle + CLI-confirmed detection flag. Mirrors the
  // web client's `sessionWorktree` / `gitWorktreeDetected` state (App.jsx).
  const [sessionWorktree, setSessionWorktree] = useState(true);
  const [gitWorktreeDetected, setGitWorktreeDetected] = useState(null); // null = unknown
  // Ask Mode (read-only session) — when true, the server spawns the CLI with
  // `--permission-mode plan` so the agent can read files but can't make edits
  // or run destructive commands. Mirrors the web client's `sessionAskMode`.
  const [sessionAskMode, setSessionAskMode] = useState(false);
  // Map of sessionId -> running task state. Populated from server snapshot on
  // connect and kept in sync via stream events so it survives session switches.
  const [activeTasks, setActiveTasks] = useState({});
  // Skills for the active agent (for /slash-command autocomplete)
  const [skills, setSkills] = useState([]);

  // Conference rooms state
  const [rooms, setRooms] = useState([]);
  const [activeRoomId, setActiveRoomId] = useState(null);
  const [roomMessages, setRoomMessages] = useState([]);
  const [roomStreaming, setRoomStreaming] = useState(null); // { agentId, agentName, agentColor, messageId, content }
  const [roomThinking, setRoomThinking] = useState(null);  // { agentId, agentName, agentColor }
  const [roomProcessing, setRoomProcessing] = useState(false);
  // Ordered list of queued user messages for the active room: [{ id, content, position }]
  const [roomQueue, setRoomQueue] = useState([]);

  // Delegation state: { [sessionId]: { parentMessageId, tasks: [...] } }
  const [delegations, setDelegations] = useState({});
  // Message queue state: { [sessionId]: [{ id, content, position }] }
  const [messageQueues, setMessageQueues] = useState({});
  // Session events: { [messageId]: [{ seq, event }] }
  const [eventsByMessage, setEventsByMessage] = useState({});
  // Cron-linked sessions
  const [cronSessions, setCronSessions] = useState([]);
  // Threads (persistent output logs for crons & heartbeats)
  // Unread entry counts keyed by projectId
  const [unreadThreadCounts, setUnreadThreadCounts] = useState({});
  // The last raw thread event received from the server. Screens listening for
  // live updates react to this ref bump via a counter. Shape:
  //   { type, projectId, thread?, threadId?, entry?, bump }
  const [lastThreadEvent, setLastThreadEvent] = useState(null);
  // Tracks the project currently being viewed in ThreadsScreen so we can
  // suppress unread-badge increments (counts are only incremented when the
  // user isn't already looking at that project's threads list).
  const activeThreadsProjectIdRef = useRef(null);
  const activeThreadIdRef = useRef(null);
  // Kanban board refresh trigger
  const [kanbanRefreshKey, setKanbanRefreshKey] = useState(0);
  // Ad-hoc PR creation: Map of sessionId -> { agentId, branch, hasUncommitted, hasUnpushed }
  const [changesReady, setChangesReady] = useState({});
  // Tracks which agenthub:ask prompts the user has already answered in this
  // app instance, so the picker renders as "Submitted" immediately after
  // tapping. This is the optimistic, in-memory half; the authoritative source
  // is the derived set below which scans persisted message history.
  // Mirrors the web client's `askSubmittedOptimistic` in client/src/App.jsx.
  const [askSubmittedOptimistic, setAskSubmittedOptimistic] = useState(() => new Set());
  // Handoff DB rows emitted from the active session — used by HandoffCard
  // to resolve the target session id and render a tappable "Open session"
  // link plus pending/failed status pills. Best-effort; missing endpoint or
  // network failures never block the chat render.
  const [sessionHandoffs, setSessionHandoffs] = useState([]);
  // Config readiness gate — prevents data fetching before AsyncStorage loads
  const [configReady, setConfigReady] = useState(false);
  // First-run setup wizard gate. `needsSetup` is true when the active org
  // has no remoteUrl configured and the user hasn't dismissed the wizard.
  const [needsSetup, setNeedsSetup] = useState(false);
  // Authentication gate. `needsAuth` is true when the server has a user
  // configured (or no auth configured and we need setup) AND the local JWT
  // is missing/expired. Flipped to false by `completeAuth()` after a
  // successful login/setup via the LoginScreen.
  const [needsAuth, setNeedsAuth] = useState(false);
  // Mobile push state: Expo token + permission status (used by Settings).
  const [pushToken, setPushToken] = useState(null);
  const [pushPermissionStatus, setPushPermissionStatus] = useState('unknown');

  const activeAgent = agents.find((a) => a.id === activeAgentId);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const activeAgentIdRef = useRef(activeAgentId);
  activeAgentIdRef.current = activeAgentId;
  const activeRoomIdRef = useRef(activeRoomId);
  activeRoomIdRef.current = activeRoomId;
  // Track when a session was explicitly navigated to (e.g. from a handoff
  // "Open session" tap) so the agent-change sessions-load effect doesn't
  // clobber it by defaulting to `data[0].id`. Mirror of the web client's
  // `pendingSessionIdRef` in `client/src/App.jsx:187`.
  const pendingSessionIdRef = useRef(null);

  // Stack navigator bridge — populated by `App.js` via `registerNavigator`
  // once the `NavigationContainer` ref is ready. Used by the notification
  // response listener to open Kanban / Threads from a cold- or warm-start
  // tap. `null` is a no-op (pre-mount or web/test).
  const navigatorRef = useRef(null);
  // A ref — not state — so registering the navigator never triggers a
  // re-render. Wrapped in `useCallback` only for a stable identity.
  const registerNavigator = useCallback((fn) => {
    navigatorRef.current = typeof fn === 'function' ? fn : null;
  }, []);

  // Keep the latest sessions list reachable from the notification listener
  // without re-running the subscription on every sessions change.
  const sessionsRef = useRef([]);

  // Show an in-app (foreground) notification for the subset of broadcast
  // events that map to the desktop/Expo push taxonomy. Remote pushes are
  // typically suppressed while the app is foregrounded, so we mirror them
  // with a locally-scheduled notification so the user still sees a banner.
  // Dynamic require so Vitest doesn't need native mocks.
  const presentForegroundFor = useCallback((data) => {
    const mapped = mapBroadcastToNotification(data);
    if (!mapped) return;
    try {
      const Notifications = require('expo-notifications');
      presentLocalNotification(
        { Notifications },
        {
          title: mapped.title,
          body: mapped.body,
          data: { event: mapped.event, ...data },
        },
      );
    } catch {
      /* expo-notifications unavailable (e.g. web / test) — no banner */
    }
  }, []);

  // WebSocket handler
  const handleWsMessage = useCallback((data) => {
    // Fan out to the in-app banner first so every mapped type gets a
    // notification regardless of which switch-case it takes below.
    presentForegroundFor(data);

    const forActiveSession =
      data.sessionId && data.sessionId === activeSessionIdRef.current;
    const msgForActiveSession =
      data.message?.session_id === activeSessionIdRef.current;

    switch (data.type) {
      case 'active-tasks-snapshot': {
        const next = {};
        for (const t of data.tasks || []) {
          next[t.sessionId] = {
            messageId: t.messageId,
            content: t.content || '',
            engine: t.engine || null,
            model: t.model || null,
          };
        }
        setActiveTasks(next);
        const sid = activeSessionIdRef.current;
        if (sid && next[sid]) {
          const t = next[sid];
          setStreamingMsgId(t.messageId);
          setStreamingContent(t.content);
          setStreamingEngine(t.engine);
          setThinking(!t.content);
        }
        break;
      }
      case 'message':
        if (data.message.role === 'user' && msgForActiveSession) {
          setMessages((prev) => [...prev, data.message]);
        }
        break;
      case 'thinking':
        setActiveTasks((prev) => ({
          ...prev,
          [data.sessionId]: {
            messageId: data.messageId,
            content: '',
            engine: data.engine || null,
            model: data.model || null,
          },
        }));
        if (forActiveSession) {
          setThinking(true);
          setStreamingMsgId(data.messageId);
          setStreamingEngine(data.engine || null);
          setStreamingContent('');
        }
        break;
      case 'stream':
        setActiveTasks((prev) => ({
          ...prev,
          [data.sessionId]: {
            ...(prev[data.sessionId] || {}),
            messageId: data.messageId,
            content: data.content,
            engine: data.engine || null,
          },
        }));
        if (forActiveSession) {
          setThinking(false);
          setStreamingContent(data.content);
          setStreamingEngine(data.engine || null);
        }
        break;
      case 'done':
        setActiveTasks((prev) => {
          const next = { ...prev };
          delete next[data.sessionId];
          return next;
        });
        if (forActiveSession) {
          setThinking(false);
          setStreamingContent('');
          setStreamingMsgId(null);
          setStreamingEngine(null);
          setMessages((prev) => [...prev, data.message]);
        }
        break;
      case 'session-updated':
        setSessions((prev) =>
          prev.map((s) =>
            s.id === data.session.id ? { ...s, name: data.session.name } : s
          )
        );
        break;
      case 'session-worktree-detected':
        // CLI status line confirmed whether the session's cwd is a git
        // worktree. Persist the flag onto the session row so session switches
        // pick it up, and update the active-session badge immediately.
        setSessions((prev) => applyDetectedFlag(prev, data.sessionId, data.gitWorktree));
        if (forActiveSession) {
          setGitWorktreeDetected(!!data.gitWorktree);
        }
        break;
      case 'error':
        if (data.sessionId) {
          setActiveTasks((prev) => {
            const next = { ...prev };
            delete next[data.sessionId];
            return next;
          });
        }
        if (forActiveSession) {
          setThinking(false);
          setStreamingContent('');
          setStreamingMsgId(null);
          setStreamingEngine(null);
          if (data.error) {
            setMessages((prev) => [
              ...prev,
              {
                id: data.messageId || `err-${Date.now()}`,
                role: 'assistant',
                content: `Error: ${data.error}`,
                created_at: new Date().toISOString(),
              },
            ]);
          }
        }
        break;
      case 'room_message':
        if (data.roomId === activeRoomIdRef.current) {
          setRoomMessages((prev) => [...prev, data.message]);
        }
        break;
      case 'room_round_start':
        if (data.roomId === activeRoomIdRef.current) {
          setRoomProcessing(true);
        }
        break;
      case 'room_thinking':
        if (data.roomId === activeRoomIdRef.current) {
          setRoomThinking({ agentId: data.agentId, agentName: data.agentName, agentColor: data.agentColor });
          setRoomStreaming(null);
        }
        break;
      case 'room_stream':
        if (data.roomId === activeRoomIdRef.current) {
          setRoomThinking(null);
          setRoomStreaming({
            agentId: data.agentId,
            agentName: data.agentName,
            agentColor: data.agentColor,
            messageId: data.messageId,
            content: data.content,
          });
        }
        break;
      case 'room_agent_done':
        if (data.roomId === activeRoomIdRef.current) {
          setRoomThinking(null);
          setRoomStreaming(null);
          setRoomMessages((prev) => [...prev, data.message]);
        }
        break;
      case 'room_agent_error':
        if (data.roomId === activeRoomIdRef.current) {
          setRoomThinking(null);
          setRoomStreaming(null);
          setRoomMessages((prev) => [
            ...prev,
            {
              id: data.messageId || `err-${Date.now()}`,
              role: 'assistant',
              content: `Error from ${data.agentName}: ${data.error}`,
              agent_name: data.agentName,
              created_at: new Date().toISOString(),
            },
          ]);
        }
        break;
      case 'room_round_done':
        if (data.roomId === activeRoomIdRef.current) {
          setRoomProcessing(false);
          setRoomThinking(null);
          setRoomStreaming(null);
        }
        break;
      case 'room_cancelled':
        if (data.roomId === activeRoomIdRef.current) {
          setRoomProcessing(false);
          setRoomThinking(null);
          setRoomStreaming(null);
          setRoomQueue([]);
        }
        break;
      case 'room_queue_updated':
        if (data.roomId === activeRoomIdRef.current) {
          setRoomQueue(Array.isArray(data.queue) ? data.queue : []);
        }
        break;

      // Delegation events
      case 'delegation_start':
        setDelegations((prev) => ({
          ...prev,
          [data.sessionId]: {
            parentMessageId: data.parentMessageId,
            tasks: (data.tasks || []).map((t) => ({
              delegationId: null,
              agentId: t.agentId,
              agentName: t.agentId,
              agentColor: null,
              task: t.task,
              status: 'pending',
              content: '',
              output: null,
              error: null,
            })),
          },
        }));
        break;
      case 'delegation_thinking':
        setDelegations((prev) => {
          const session = prev[data.sessionId];
          if (!session) return prev;
          return {
            ...prev,
            [data.sessionId]: {
              ...session,
              tasks: session.tasks.map((t) =>
                t.agentId === data.agentId
                  ? { ...t, delegationId: data.delegationId, agentName: data.agentName, agentColor: data.agentColor, status: 'running' }
                  : t
              ),
            },
          };
        });
        break;
      case 'delegation_stream':
        setDelegations((prev) => {
          const session = prev[data.sessionId];
          if (!session) return prev;
          return {
            ...prev,
            [data.sessionId]: {
              ...session,
              tasks: session.tasks.map((t) =>
                t.agentId === data.agentId
                  ? { ...t, agentName: data.agentName, agentColor: data.agentColor, status: 'running', content: data.content }
                  : t
              ),
            },
          };
        });
        break;
      case 'delegation_agent_done':
        setDelegations((prev) => {
          const session = prev[data.sessionId];
          if (!session) return prev;
          return {
            ...prev,
            [data.sessionId]: {
              ...session,
              tasks: session.tasks.map((t) =>
                t.agentId === data.agentId
                  ? { ...t, status: 'done', output: data.output, content: '' }
                  : t
              ),
            },
          };
        });
        break;
      case 'delegation_agent_error':
        setDelegations((prev) => {
          const session = prev[data.sessionId];
          if (!session) return prev;
          return {
            ...prev,
            [data.sessionId]: {
              ...session,
              tasks: session.tasks.map((t) =>
                t.agentId === data.agentId
                  ? { ...t, status: 'error', error: data.error }
                  : t
              ),
            },
          };
        });
        break;
      case 'delegation_cancelled':
        setDelegations((prev) => {
          const session = prev[data.sessionId];
          if (!session) return prev;
          return {
            ...prev,
            [data.sessionId]: {
              ...session,
              tasks: session.tasks.map((t) =>
                t.status === 'running' || t.status === 'pending'
                  ? { ...t, status: 'cancelled' }
                  : t
              ),
            },
          };
        });
        break;
      case 'delegation_round_done':
        // No state change needed — tasks already updated individually
        break;
      case 'delegation_error':
        // System-level delegation error — just log it
        console.warn('[Delegation] Error:', data.error);
        break;

      // Session events (for timeline)
      case 'session-event':
        if (forActiveSession && data.messageId && data.event) {
          setEventsByMessage((prev) => ({
            ...prev,
            [data.messageId]: [...(prev[data.messageId] || []), { seq: data.seq, event: data.event }],
          }));
        }
        break;

      // Cron session updates
      case 'cron_session_update':
        api.getCronSessions().then(setCronSessions).catch(() => {});
        break;

      // Queue events
      case 'queue_updated':
        setMessageQueues((prev) => ({
          ...prev,
          [data.sessionId]: data.queue || [],
        }));
        break;
      case 'queue_item_processing':
        setMessageQueues((prev) => {
          const q = prev[data.sessionId];
          if (!q) return prev;
          return { ...prev, [data.sessionId]: q.filter((item) => item.id !== data.messageId) };
        });
        break;
      case 'queue_item_edited':
        if (forActiveSession) {
          setMessages((prev) =>
            prev.map((m) => (m.id === data.messageId ? { ...m, content: data.content } : m))
          );
        }
        break;

      case 'kanban_update':
        setKanbanRefreshKey((k) => (k || 0) + 1);
        break;

      case 'dispatch_failure':
        // Refresh kanban to show the failure comment on the card
        setKanbanRefreshKey((k) => (k || 0) + 1);
        break;

      case 'session_deleted':
        setSessions((prev) => prev.filter((s) => s.id !== data.sessionId));
        break;

      // A session was forwarded from another agent — if the new session
      // belongs to the currently-active agent, splice it into the sidebar
      // list so the user sees it without a manual refresh. Navigation of
      // the originating client is handled by ForwardSessionModal directly.
      case 'session_forwarded': {
        const newSession = data.session;
        if (newSession && newSession.agent_id === activeAgentIdRef.current) {
          setSessions((prev) => {
            if (prev.some((s) => s.id === newSession.id)) return prev;
            return [newSession, ...prev];
          });
        }
        break;
      }

      // Ad-hoc PR creation — agent finished a worktree session with uncommitted
      // changes and no existing kanban card. Surface the "Create PR" banner.
      case 'changes_ready':
        setChangesReady((prev) => ({
          ...prev,
          [data.sessionId]: {
            agentId: data.agentId,
            branch: data.branch,
            hasUncommitted: data.hasUncommitted,
            hasUnpushed: data.hasUnpushed,
          },
        }));
        break;

      // A PR was opened (manually or automatically) — clear the banner.
      case 'auto_pr_created':
        setChangesReady((prev) => {
          if (!prev[data.sessionId]) return prev;
          const next = { ...prev };
          delete next[data.sessionId];
          return next;
        });
        break;

      // ── Thread events (persistent output logs) ───────────────
      case 'thread_created':
        setLastThreadEvent({
          type: 'thread_created',
          projectId: data.projectId,
          thread: data.thread,
          bump: Date.now(),
        });
        break;
      case 'thread_entry_created': {
        setUnreadThreadCounts((prev) =>
          applyEntryUnread(
            prev,
            { projectId: data.projectId, threadId: data.threadId },
            activeThreadIdRef.current,
          ),
        );
        setLastThreadEvent({
          type: 'thread_entry_created',
          projectId: data.projectId,
          threadId: data.threadId,
          threadName: data.threadName,
          threadType: data.threadType,
          entry: data.entry,
          bump: Date.now(),
        });
        break;
      }
      case 'thread_deleted':
        setLastThreadEvent({
          type: 'thread_deleted',
          projectId: data.projectId,
          threadId: data.threadId,
          bump: Date.now(),
        });
        break;
    }
  }, [presentForegroundFor]);

  const { send, connected, reconnecting, reconnect } = useWebSocket(handleWsMessage);

  // Mirror `sessions` into a ref so the notification-response listener —
  // which registers once on mount — can read the latest list without being
  // torn down and re-registered on every sessions refresh.
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // Register for Expo push notifications once the connection config is
  // ready. Native modules are required lazily so this file can be imported
  // under Vitest without those dependencies being resolvable.
  useEffect(() => {
    if (!configReady || !getApiBaseUrl()) return;
    (async () => {
      try {
        const Notifications = require('expo-notifications');
        // Foreground notifications: show banner + play sound. Without this
        // Expo suppresses banners while the app is in the foreground.
        if (Notifications.setNotificationHandler) {
          Notifications.setNotificationHandler({
            handleNotification: async () => ({
              shouldShowBanner: true,
              shouldShowList: true,
              shouldPlaySound: true,
              shouldSetBadge: false,
            }),
          });
        }
        const Device = require('expo-device');
        const Constants = require('expo-constants').default;
        const { Platform } = require('react-native');
        const result = await registerForPushNotifications({
          api,
          Notifications,
          Device,
          Constants,
          Platform,
        });
        setPushToken(result.token);
        setPushPermissionStatus(result.permissionStatus);
      } catch (err) {
        // Native modules missing (dev web, Vitest) — stay silent.
        setPushPermissionStatus('unavailable');
      }
    })();
  }, [configReady]);

  // Shared dispatch for a routed notification-tap payload. Extracted so the
  // cold-start (`getLastNotificationResponseAsync`) path and the live
  // (`addNotificationResponseReceivedListener`) path share identical logic.
  //
  // The routing decision is fully pure (`routeNotificationTap`); only the
  // side-effects — state updates, `navigatorRef.current(screen, params)` —
  // live here.
  const applyNotificationRoute = useCallback((data) => {
    const route = routeNotificationTap(data, { sessions: sessionsRef.current });
    if (!route) return;

    switch (route.kind) {
      case 'chat': {
        // Stash the target session on `pendingSessionIdRef` before swapping
        // `activeAgentId` so the sessions-load effect honors it (mirror of
        // `handleOpenHandoffSession`). When `agentId` is unknown (the
        // session wasn't in the loaded list) we still stash the pending id
        // — if the user ever lands on that agent the session will activate.
        pendingSessionIdRef.current = route.sessionId;
        if (route.agentId) {
          setActiveAgentId(route.agentId);
        }
        setActiveSessionId(route.sessionId);
        break;
      }
      case 'kanban': {
        navigatorRef.current?.('Kanban', {
          projectId: route.projectId || undefined,
          cardId: route.cardId || undefined,
        });
        break;
      }
      case 'threads': {
        navigatorRef.current?.('Threads', {
          projectId: route.projectId,
          threadId: route.threadId || undefined,
        });
        break;
      }
      default:
        break;
    }
  }, []);

  // Register a notification-response listener so tapping a banner (whether
  // presented in foreground by `presentLocalNotification` or delivered as a
  // remote Expo push) navigates to the right screen. Also consume any
  // pending cold-start response so launching the app from a dismissed
  // banner still routes correctly.
  //
  // Native modules are required lazily so Vitest (which only exercises
  // pure utils in `src/utils/`) never tries to resolve them.
  useEffect(() => {
    if (!configReady) return undefined;
    let subscription = null;
    let cancelled = false;
    (async () => {
      try {
        const Notifications = require('expo-notifications');
        // Cold-start: the app was launched by tapping a notification while
        // it was backgrounded/killed. Apply once on mount.
        if (typeof Notifications.getLastNotificationResponseAsync === 'function') {
          try {
            const last = await Notifications.getLastNotificationResponseAsync();
            const data = last?.notification?.request?.content?.data;
            if (!cancelled && data) applyNotificationRoute(data);
          } catch {
            /* non-fatal — listener still covers the warm-start path */
          }
        }
        if (typeof Notifications.addNotificationResponseReceivedListener === 'function') {
          subscription = Notifications.addNotificationResponseReceivedListener((response) => {
            const data = response?.notification?.request?.content?.data;
            if (data) applyNotificationRoute(data);
          });
        }
      } catch {
        /* expo-notifications unavailable — no-op */
      }
    })();
    return () => {
      cancelled = true;
      if (subscription && typeof subscription.remove === 'function') {
        subscription.remove();
      }
    };
  }, [configReady, applyNotificationRoute]);

  const refreshAgents = useCallback(() => {
    api.getAgents().then((data) => {
      setAgents(data);
    });
  }, []);

  const refreshProjects = useCallback(() => {
    api.getProjects().then(setProjects).catch(() => setProjects([]));
  }, []);

  // Load connection config on mount, then signal readiness
  useEffect(() => {
    (async () => {
      await loadConnectionConfig();
      await migrateFromLegacy();
      // Ensure active org's connection config is synced (URL + API key)
      const { getActiveOrg } = require('../utils/orgs');
      const { saveConnectionConfig } = require('../utils/config');
      const activeOrg = getActiveOrg();
      if (activeOrg?.remoteUrl) {
        await saveConnectionConfig({
          remoteUrl: activeOrg.remoteUrl,
          apiKey: activeOrg.apiKey || '',
        });
      }
      // Warm the in-memory JWT mirror from AsyncStorage so sync callers
      // (getAuthHeaders / getWsUrl) can read it immediately. Must happen
      // before we reconnect the WebSocket below.
      await loadAuthToken();
      // Decide whether to show the first-run wizard before we signal ready.
      // `shouldShowWizard` returns true only when no org has a remoteUrl AND
      // the user hasn't previously dismissed the wizard.
      const dismissed = await loadSetupDismissed();
      setNeedsSetup(shouldShowWizard(getOrgs(), dismissed));
      // Probe the server for auth configuration. If auth is enabled and we
      // don't have a valid cached token, gate the app with the LoginScreen.
      // Failures (server unreachable, no URL configured, etc.) are
      // non-blocking — we fall through and let the normal WS reconnect
      // loop surface the error.
      const baseUrl = getApiBaseUrl();
      if (baseUrl) {
        try {
          const status = await getAuthStatus(baseUrl);
          if (status?.authConfigured && !isAuthenticated()) {
            setNeedsAuth(true);
          }
        } catch {
          /* server unreachable — skip auth gate, let WS reconnect surface it */
        }
      }
      // Signal that config is loaded — this unblocks data fetching & WebSocket
      setConfigReady(true);
      // Always reconnect WebSocket now that config is loaded from AsyncStorage
      reconnect();
    })();
  }, []);

  /**
   * Called from `SetupWizard` once the user finishes (or skips) the first-run
   * flow. Persists the "dismissed" flag so the wizard never reappears, then
   * hides it. If the user actually entered a server URL, the connection
   * config was already written by the wizard's `updateOrg`/`createOrg` call.
   */
  const completeSetup = useCallback(async () => {
    await saveSetupDismissed(true);
    setNeedsSetup(false);
    // Reconnect so the newly-configured WebSocket picks up the server URL.
    reconnect();
  }, [reconnect]);

  /**
   * Called by `LoginScreen` after a successful login or setup call. The JWT
   * is already persisted to AsyncStorage at this point; we just need to
   * flip `needsAuth` and reconnect the WebSocket so it picks up the new
   * `?token=` credential.
   */
  const completeAuth = useCallback(() => {
    setNeedsAuth(false);
    reconnect();
  }, [reconnect]);

  // Load agents and projects once config is ready
  useEffect(() => {
    if (!configReady) return;
    if (!getApiBaseUrl()) return; // No server configured yet
    (async () => {
      try {
        const [agentData, projectData, roomData, cronSessionData] = await Promise.all([
          api.getAgents(),
          api.getProjects().catch(() => []),
          api.getRooms().catch(() => []),
          api.getCronSessions().catch(() => []),
        ]);
        setAgents(agentData);
        setProjects(projectData);
        setRooms(roomData);
        setCronSessions(cronSessionData);
        if (agentData.length > 0) setActiveAgentId(agentData[0].id);
      } catch (err) {
        console.error('Failed to load initial data:', err);
      }
    })();
  }, [configReady]);

  // Load sessions when agent changes (guarded on configReady)
  useEffect(() => {
    if (!configReady || !activeAgentId || !getApiBaseUrl()) return;
    // Snapshot the pending target (if any) before the async fetch so a
    // cross-agent navigation (e.g. `handleOpenHandoffSession`) can't be
    // clobbered by the default `data[0].id` fallback when the list arrives.
    // Mirror of the web client's logic in `client/src/App.jsx:1277-1304`.
    const targetSessionId = pendingSessionIdRef.current;
    pendingSessionIdRef.current = null;
    api.getSessions(activeAgentId).then((data) => {
      setSessions(data);
      // Hydrate the changes_ready banner state from persisted session rows so
      // the "Create PR" button survives page refreshes / reconnects. Merge
      // rather than replace to preserve banners for sessions of other agents.
      setChangesReady((prev) => ({ ...prev, ...hydrateChangesReady(data) }));
      // Honor an explicitly requested target session (kanban assign, handoff
      // "Open session" tap, etc.) instead of defaulting to the newest row.
      const target = selectSessionToActivate(data, targetSessionId);
      if (target) {
        setActiveSessionId(target.id);
        const agent = agents.find((a) => a.id === activeAgentId);
        setSessionEngine(target.engine || agent?.engine || 'claude-code');
        setSessionModel(target.model || 'claude-opus-4-7');
        const wt = resolveSessionWorktree(target);
        setSessionWorktree(wt.enabled);
        setGitWorktreeDetected(wt.detected);
        setSessionAskMode(target.ask_mode !== 0 && !!target.ask_mode);
      } else {
        setActiveSessionId(null);
        setMessages([]);
        const agent = agents.find((a) => a.id === activeAgentId);
        setSessionEngine(agent?.engine || 'claude-code');
        setSessionModel('claude-opus-4-7');
        setSessionWorktree(true);
        setGitWorktreeDetected(null);
        setSessionAskMode(false);
      }
    }).catch((err) => console.error('Failed to load sessions:', err));
  }, [configReady, activeAgentId]);

  // Load skills for /slash-command autocomplete when agent changes
  useEffect(() => {
    if (!configReady || !activeAgentId || !getApiBaseUrl()) {
      setSkills([]);
      return;
    }
    api.getSkills(activeAgentId)
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [configReady, activeAgentId]);

  // Update session engine/model/worktree state when session changes
  useEffect(() => {
    if (!activeSessionId) return;
    const session = sessions.find((s) => s.id === activeSessionId);
    if (session?.engine) setSessionEngine(session.engine);
    if (session?.model) setSessionModel(session.model);
    if (session) {
      const wt = resolveSessionWorktree(session);
      setSessionWorktree(wt.enabled);
      setGitWorktreeDetected(wt.detected);
      setSessionAskMode(session.ask_mode !== 0 && !!session.ask_mode);
    }
  }, [activeSessionId, sessions]);

  // Reload messages for the currently-active session. Exposed via context so
  // screens (e.g. ChatScreen on navigation focus, DrawerContent when the user
  // re-taps the already-active session) can force a refresh without waiting
  // for `activeSessionId` to change. The race-guard logic lives in the pure
  // `createReloadMessages` factory so it can be unit-tested in isolation.
  const reloadMessages = useMemo(
    () => createReloadMessages({
      fetchMessages: (sid) => api.getMessages(sid),
      getActiveSessionId: () => activeSessionIdRef.current,
      setMessages,
    }),
    [],
  );

  // Load messages when session changes.
  // NOTE: when switching sessions via the drawer, reloadMessages may fire
  // twice — once here (activeSessionId changed) and once via ChatScreen's
  // useFocusEffect (screen regained focus). The race guard inside
  // createReloadMessages makes this safe; the duplicate fetch is harmless.
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    reloadMessages();
  }, [activeSessionId, reloadMessages]);

  // Load handoffs emitted from this session so HandoffCard can resolve
  // `to_session_id` and render a tappable "Open session" link. Best-effort —
  // a missing endpoint or offline state must never block the chat render.
  useEffect(() => {
    if (!activeSessionId) {
      setSessionHandoffs([]);
      return;
    }
    let cancelled = false;
    api
      .getSessionHandoffs(activeSessionId)
      .then((rows) => {
        if (cancelled) return;
        setSessionHandoffs(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setSessionHandoffs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  // Navigate into a handoff's target session (invoked from HandoffCard).
  // Stash the target on `pendingSessionIdRef` *before* flipping
  // `activeAgentId` so the sessions-load effect (which fires on the agent
  // change) honors it instead of clobbering it with `data[0].id`. We still
  // set `activeSessionId` optimistically so the UI swaps immediately; the
  // loader then confirms it once the session list arrives.
  const handleOpenHandoffSession = useCallback(
    (targetAgentId, targetSessionId) => {
      if (!targetAgentId || !targetSessionId) return;
      pendingSessionIdRef.current = targetSessionId;
      setActiveAgentId(targetAgentId);
      setActiveSessionId(targetSessionId);
    },
    [],
  );

  // Rehydrate streaming state from activeTasks when switching sessions.
  useEffect(() => {
    if (!activeSessionId) {
      setThinking(false);
      setStreamingContent('');
      setStreamingMsgId(null);
      setStreamingEngine(null);
      return;
    }
    const t = activeTasks[activeSessionId];
    if (t) {
      setStreamingMsgId(t.messageId);
      setStreamingContent(t.content);
      setStreamingEngine(t.engine);
      setThinking(!t.content);
    } else {
      setThinking(false);
      setStreamingContent('');
      setStreamingMsgId(null);
      setStreamingEngine(null);
    }
  }, [activeSessionId]);

  const handleSwitchOrg = useCallback(async (orgId) => {
    const { switchOrg } = require('../utils/orgs');
    await switchOrg(orgId);
    // Reset all state
    setAgents([]);
    setProjects([]);
    setSessions([]);
    setActiveAgentId(null);
    setActiveSessionId(null);
    setMessages([]);
    setThinking(false);
    setStreamingContent('');
    setActiveTasks({});
    setRooms([]);
    setActiveRoomId(null);
    setRoomMessages([]);
    setRoomThinking(null);
    setRoomStreaming(null);
    setRoomProcessing(false);
    setRoomQueue([]);
    setDelegations({});
    setMessageQueues({});
    setEventsByMessage({});
    setCronSessions([]);
    setChangesReady({});
    setSessionHandoffs([]);
    setSessionWorktree(true);
    setGitWorktreeDetected(null);
    setSessionAskMode(false);
    // Reconnect WebSocket to new org
    reconnect();
    // Reload data
    try {
      const [agentData, projectData, roomData, cronSessionData] = await Promise.all([
        api.getAgents(),
        api.getProjects().catch(() => []),
        api.getRooms().catch(() => []),
        api.getCronSessions().catch(() => []),
      ]);
      setAgents(agentData);
      setProjects(projectData);
      setRooms(roomData);
      setCronSessions(cronSessionData);
      if (agentData.length > 0) setActiveAgentId(agentData[0].id);
    } catch (err) {
      console.error('Failed to load data after org switch:', err);
    }
  }, [reconnect]);

  const handleNewSession = useCallback(async () => {
    if (!activeAgentId) return;
    // Propagate the current Ask Mode preference to the new session so a user
    // who toggled "Ask (read-only)" before tapping `+` gets a read-only
    // session. Matches the web client's behavior in App.jsx.
    const session = await api.createSession(activeAgentId, undefined, {
      askMode: sessionAskMode,
    });
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    const agent = agents.find((a) => a.id === activeAgentId);
    setSessionEngine(session.engine || agent?.engine || 'claude-code');
    setSessionModel(session.model || 'claude-opus-4-7');
    const wt = resolveSessionWorktree(session);
    setSessionWorktree(wt.enabled);
    setGitWorktreeDetected(null); // Fresh session — CLI hasn't reported yet
    setSessionAskMode(session.ask_mode !== 0 && !!session.ask_mode);
    setMessages([]);
  }, [activeAgentId, agents, sessionAskMode]);

  // Toggle git-worktree isolation for the active session. Optimistically
  // updates local state; reverts on server error. Mirrors the web client's
  // `handleWorktreeChange` in App.jsx.
  const handleWorktreeChange = useCallback(
    async (enabled) => {
      const sid = activeSessionIdRef.current;
      const prevEnabled = sessionWorktree;
      setSessionWorktree(enabled);
      if (!sid) return;
      try {
        const updated = await api.setSessionWorktree(sid, enabled);
        setSessions((prev) =>
          prev.map((s) =>
            s.id === updated.id
              ? {
                  ...s,
                  use_worktree: updated.use_worktree,
                  worktree_path: updated.worktree_path,
                  worktree_branch: updated.worktree_branch,
                  git_worktree_detected: updated.git_worktree_detected,
                }
              : s,
          ),
        );
      } catch (err) {
        console.warn('setSessionWorktree failed; reverting toggle:', err);
        setSessionWorktree(prevEnabled);
      }
    },
    [sessionWorktree],
  );

  // Toggle Ask Mode for the active session. Optimistically updates local
  // state; reverts on server error. Mirrors the web client's
  // `handleAskModeChange` in App.jsx.
  const handleAskModeChange = useCallback(
    async (enabled) => {
      const sid = activeSessionIdRef.current;
      const prevEnabled = sessionAskMode;
      setSessionAskMode(enabled);
      if (!sid) return;
      try {
        const updated = await api.setSessionAskMode(sid, enabled);
        setSessions((prev) =>
          prev.map((s) =>
            s.id === updated.id ? { ...s, ask_mode: updated.ask_mode } : s,
          ),
        );
      } catch (err) {
        console.warn('setSessionAskMode failed; reverting toggle:', err);
        setSessionAskMode(prevEnabled);
      }
    },
    [sessionAskMode],
  );

  const handleEngineChange = useCallback(async (engine) => {
    setSessionEngine(engine);
    const defaultModel = ENGINE_DEFAULT_MODELS[engine] || 'claude-opus-4-7';
    setSessionModel(defaultModel);
    const sid = activeSessionIdRef.current;
    if (sid) {
      const updated = await api.setSessionEngine(sid, engine);
      setSessions((prev) =>
        prev.map((s) => (s.id === updated.id ? { ...s, engine: updated.engine } : s))
      );
      const modelUpdated = await api.setSessionModel(sid, defaultModel);
      setSessions((prev) =>
        prev.map((s) => (s.id === modelUpdated.id ? { ...s, model: modelUpdated.model } : s))
      );
    }
  }, []);

  const handleModelChange = useCallback(async (model) => {
    setSessionModel(model);
    const sid = activeSessionIdRef.current;
    if (sid) {
      const updated = await api.setSessionModel(sid, model);
      setSessions((prev) =>
        prev.map((s) => (s.id === updated.id ? { ...s, model: updated.model } : s))
      );
    }
  }, []);

  const handleDeleteSession = useCallback(async (sessionId) => {
    await api.deleteSession(sessionId);
    setSessions((prev) => {
      const remaining = prev.filter((s) => s.id !== sessionId);
      if (activeSessionIdRef.current === sessionId) {
        setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
      }
      return remaining;
    });
  }, []);

  const handleCancel = useCallback(() => {
    const sid = activeSessionIdRef.current;
    if (sid) {
      send({ type: 'cancel', sessionId: sid });
      setThinking(false);
      setStreamingContent('');
      setStreamingMsgId(null);
    }
  }, [send]);

  // Derived from persisted message history: any user message containing an
  // `agenthub:ask:answer` block with a matching askId marks that picker as
  // submitted. Surviving reloads requires this — in-memory state is lost on
  // restart, but the user message is persisted in the DB and re-fetched.
  const askSubmittedFromHistory = useMemo(
    () => extractSubmittedAskIds(messages),
    [messages],
  );
  // Union of optimistic (just-tapped) + history-derived (persisted). Passed
  // to the picker's `submitted` prop and used to short-circuit duplicate
  // sends from <AskUserQuestion>.
  const askSubmitted = useMemo(() => {
    if (askSubmittedOptimistic.size === 0) return askSubmittedFromHistory;
    const union = new Set(askSubmittedFromHistory);
    for (const id of askSubmittedOptimistic) union.add(id);
    return union;
  }, [askSubmittedOptimistic, askSubmittedFromHistory]);

  const handleSend = useCallback(async (content, images = []) => {
    let sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      const session = await api.createSession(activeAgentId);
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
      sessionId = session.id;
    }

    // Upload attachments first, then send chat with references. Images go
    // through the base64 /api/upload route; videos and generic files stream
    // via /api/upload/file using api.uploadFile (FileSystem.uploadAsync).
    let uploadedImages = [];
    if (images.length > 0) {
      try {
        uploadedImages = await uploadAttachments(images, api);
      } catch (err) {
        console.error('Attachment upload failed:', err);
      }
    }

    send({
      type: 'chat',
      agentId: activeAgentId,
      sessionId,
      content,
      ...(uploadedImages.length > 0 ? { images: uploadedImages } : {}),
    });
  }, [activeAgentId, send]);

  // Handle submission from an <AskUserQuestion> picker. We dispatch the
  // pre-formatted chat message (which already contains the
  // agenthub:ask:answer fenced block) and mark the askId as submitted so the
  // picker flips to a disabled "Submitted" state immediately. Once the user
  // message persists to history, `askSubmittedFromHistory` picks the id up
  // from the fenced-block scan and the optimistic set becomes redundant —
  // the union in `askSubmitted` keeps the brief overlap seamless. Mirrors
  // `client/src/App.jsx:handleAskSubmit`.
  const handleAskSubmit = useCallback(
    (askId, messageText) => {
      if (!askId || !messageText) return;
      // Short-circuit duplicate submissions if the picker somehow re-fires.
      setAskSubmittedOptimistic((prev) => {
        if (prev.has(askId)) return prev;
        const next = new Set(prev);
        next.add(askId);
        return next;
      });
      handleSend(messageText);
    },
    [handleSend],
  );

  // Load room messages when active room changes
  useEffect(() => {
    if (!activeRoomId) {
      setRoomMessages([]);
      setRoomThinking(null);
      setRoomStreaming(null);
      setRoomProcessing(false);
      setRoomQueue([]);
      return;
    }
    api.getRoomMessages(activeRoomId).then(setRoomMessages).catch(() => setRoomMessages([]));
    // Reset queue until the server pushes a `room_queue_updated` snapshot.
    setRoomQueue([]);
  }, [activeRoomId]);

  const handleRoomSend = useCallback((content) => {
    if (!activeRoomId) return;
    send({ type: 'room_chat', roomId: activeRoomId, content });
  }, [activeRoomId, send]);

  const handleRoomCancel = useCallback(() => {
    if (!activeRoomId) return;
    send({ type: 'room_cancel', roomId: activeRoomId });
  }, [activeRoomId, send]);

  const handleRoomDequeue = useCallback((messageId) => {
    if (!activeRoomId) return;
    send({ type: 'room_dequeue', roomId: activeRoomId, messageId });
    setRoomQueue((prev) => prev.filter((item) => item.id !== messageId));
  }, [activeRoomId, send]);

  const refreshRooms = useCallback(() => {
    api.getRooms().then(setRooms).catch(() => setRooms([]));
  }, []);

  const handleDequeue = useCallback((messageId) => {
    const sid = activeSessionIdRef.current;
    if (sid) {
      send({ type: 'dequeue', sessionId: sid, messageId });
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
    }
  }, [send]);

  const handleEditQueuedMessage = useCallback((messageId, content) => {
    const sid = activeSessionIdRef.current;
    if (sid) {
      send({ type: 'edit_queue_item', sessionId: sid, messageId, content });
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, content } : m)));
    }
  }, [send]);

  const handleDelegationCancel = useCallback(() => {
    const sid = activeSessionIdRef.current;
    if (sid) {
      send({ type: 'delegation_cancel', sessionId: sid });
    }
  }, [send]);

  const handleEventsLoaded = useCallback((messageId, events) => {
    setEventsByMessage((prev) => ({ ...prev, [messageId]: events }));
  }, []);

  /**
   * Clear the unread-threads badge for a project. Call when the user opens
   * the threads list or a specific thread so the sidebar chip resets.
   */
  const markProjectThreadsRead = useCallback((projectId) => {
    if (!projectId) return;
    setUnreadThreadCounts((prev) => clearProjectUnread(prev, projectId));
  }, []);

  /**
   * ThreadsScreen calls this when the user enters the list view for a project,
   * so the WS handler knows which project is currently focused (used later if
   * we want to keep the list live without also pinging the badge).
   */
  const setActiveThreadsProject = useCallback((projectId) => {
    activeThreadsProjectIdRef.current = projectId;
  }, []);

  /**
   * ThreadsScreen calls this when the user opens a specific thread detail.
   * Passing `null` clears (e.g. on back / unmount). While set, incoming entry
   * events for that thread skip unread-count bumps.
   */
  const setActiveThread = useCallback((threadId) => {
    activeThreadIdRef.current = threadId;
  }, []);

  const dismissChangesReady = useCallback((sessionId) => {
    setChangesReady((prev) => {
      if (!prev[sessionId]) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  const isProcessing = thinking || !!streamingContent;

  const value = {
    configReady,
    needsSetup,
    completeSetup,
    needsAuth,
    completeAuth,
    agents,
    projects,
    activeAgentId,
    setActiveAgentId,
    activeAgent,
    sessions,
    activeSessionId,
    setActiveSessionId,
    messages,
    reloadMessages,
    thinking,
    streamingContent,
    streamingMsgId,
    streamingEngine,
    sessionEngine,
    sessionModel,
    sessionWorktree,
    gitWorktreeDetected,
    handleWorktreeChange,
    sessionAskMode,
    handleAskModeChange,
    connected,
    reconnecting,
    isProcessing,
    activeTasks,
    handleNewSession,
    handleEngineChange,
    handleModelChange,
    handleDeleteSession,
    handleCancel,
    handleSend,
    handleSwitchOrg,
    refreshAgents,
    refreshProjects,
    skills,
    rooms,
    activeRoomId,
    setActiveRoomId,
    roomMessages,
    roomStreaming,
    roomThinking,
    roomProcessing,
    roomQueue,
    roomQueueLength: roomQueue.length,
    handleRoomSend,
    handleRoomCancel,
    handleRoomDequeue,
    refreshRooms,
    delegations,
    sessionHandoffs,
    handleOpenHandoffSession,
    messageQueues,
    eventsByMessage,
    handleDequeue,
    handleEditQueuedMessage,
    handleDelegationCancel,
    handleEventsLoaded,
    cronSessions,
    kanbanRefreshKey,
    changesReady,
    dismissChangesReady,
    // Ask-prompt (`agenthub:ask`) submission state and handler
    askSubmitted,
    handleAskSubmit,
    // Threads
    unreadThreadCounts,
    lastThreadEvent,
    markProjectThreadsRead,
    setActiveThreadsProject,
    setActiveThread,
    // Push notification state (Settings screen surfaces these)
    pushToken,
    pushPermissionStatus,
    // Navigation bridge — App.js calls this once the NavigationContainer
    // ref is mounted so the notification-tap listener can open screens.
    registerNavigator,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
