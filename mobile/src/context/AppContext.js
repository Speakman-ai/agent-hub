import React, { createContext, useState, useCallback, useEffect, useContext, useMemo, useRef } from 'react';
import { Alert } from 'react-native';
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
import { applyDetectedFlag } from '../utils/worktreeState';
import { isWorkflowProject } from '../utils/project-mode';
import { selectSessionToActivate } from '../utils/sessionSelection';
import { applyEntryUnread, clearProjectUnread } from '../utils/threads';
import { registerForPushNotifications, presentLocalNotification } from '../utils/push';
import { mapBroadcastToNotification } from '../utils/ticketNotifications';
import { routeNotificationTap } from '../utils/notificationRouting';
import { uploadAttachments } from '../utils/uploadAttachments';
import { coalescePromiseByKey } from '../utils/coalesceInFlight';
import { createReloadMessages } from '../utils/sessionReload';
import {
  firstEngineWithAuthenticatedModels,
  defaultModelForAuthenticatedEngine,
} from '../utils/authModelEngines';
import { mergeBrowserActivityScreenshot } from '../../../shared/utils/browserScreensBySessionMerge.js';
import {
  buildInterruptQueuedMessageDispatch,
  isPersistedUploadAttachment,
} from '../../../shared/utils/queuedMessageAttachments.js';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [agents, setAgents] = useState([]);
  const [projects, setProjects] = useState([]);
  const [activeAgentId, setActiveAgentId] = useState(null);
  const [sessions, setSessions] = useState([]);
  // Soft-deleted sessions within the 7-day recovery window for the active
  // agent. Shape: Array<SessionRow & { message_count:number, deleted_at:string }>.
  // Mirrors App.jsx (web) so the drawer can render an "Archived" section.
  const [archivedSessions, setArchivedSessions] = useState([]);
  const [restoringSessionIds, setRestoringSessionIds] = useState(new Set());
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [thinking, setThinking] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingMsgId, setStreamingMsgId] = useState(null);
  const streamingMsgIdRef = useRef(null);
  const [chatScrollNonce, setChatScrollNonce] = useState(0);
  const [streamingEngine, setStreamingEngine] = useState(null);
  const [sessionEngine, setSessionEngine] = useState('claude-code');
  const [sessionModel, setSessionModel] = useState('claude-opus-4-8');
  const [modelConfig, setModelConfig] = useState(null);
  // The legacy worktree toggle (`sessionWorktree`) and CLI-detection
  // signal (`gitWorktreeDetected`) were removed when Agent Hub locked to
  // worktree-only sessions. All user-facing session creation now uses a
  // per-session worktree unconditionally.
  // Ask Mode (read-only session) — when true, the server spawns the CLI with
  // `--permission-mode plan` so the agent can read files but can't make edits
  // or run destructive commands. Mirrors the web client's `sessionAskMode`.
  const [sessionAskMode, setSessionAskMode] = useState(false);
  // Map of sessionId -> running task state. Populated from server snapshot on
  // connect and kept in sync via stream events so it survives session switches.
  const [activeTasks, setActiveTasks] = useState({});
  // Skills for the active agent (for /slash-command autocomplete)
  const [skills, setSkills] = useState([]);

  // Multi-agent session roster for the active chat session.
  const [sessionAgents, setSessionAgents] = useState([]);
  const [sessionRoundProcessing, setSessionRoundProcessing] = useState(false);
  const [streamingAgent, setStreamingAgent] = useState(null);

  // Delegation state: { [sessionId]: { parentMessageId, tasks: [...] } }
  const [delegations, setDelegations] = useState({});
  // Message queue state: { [sessionId]: [{ id, content, position }] }
  const [messageQueues, setMessageQueues] = useState({});
  // Session events: { [messageId]: [{ seq, event }] }
  const [eventsByMessage, setEventsByMessage] = useState({});
  // Live browser screenshot previews: { [messageId]: { [actionId]: dataUrl } }
  const [browserScreensBySession, setBrowserScreensBySession] = useState({});
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
  const [shipFailureAt, setShipFailureAt] = useState(null);
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
  const defaultModelForEngine = (engine) => {
    const fromConfig = modelConfig?.engineDefaultModels?.[engine];
    if (fromConfig) return fromConfig;
    if (engine === 'cursor-agent') return 'composer-2.5';
    if (engine === 'codex-cli') return 'gpt-5.3-codex';
    return 'claude-opus-4-8';
  };
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  /** One in-flight implicit `createSession` per agent + ask-mode (send with no session). */
  const implicitSessionCreateByKeyRef = useRef(new Map());
  const activeAgentIdRef = useRef(activeAgentId);
  activeAgentIdRef.current = activeAgentId;
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
  const agentsRef = useRef([]);
  const projectsRef = useRef([]);

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
        if (msgForActiveSession && data.message?.id) {
          if (data.message.role === 'user') {
            setMessages((prev) => {
              if (prev.some((m) => m.id === data.message.id)) return prev;
              return [...prev, data.message];
            });
          } else if (data.message.role === 'assistant' && data.message.agent_id) {
            setMessages((prev) => {
              if (prev.some((m) => m.id === data.message.id)) return prev;
              return [...prev, data.message];
            });
            setThinking(false);
            setStreamingContent('');
            setStreamingMsgId(null);
            setStreamingEngine(null);
            setStreamingAgent(null);
          }
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
          if (data.agentId) {
            setStreamingAgent({
              agentId: data.agentId,
              agentName: data.agentName,
              agentColor: data.agentColor,
            });
          } else {
            setStreamingAgent(null);
          }
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
          if (data.agentId) {
            setStreamingAgent({
              agentId: data.agentId,
              agentName: data.agentName,
              agentColor: data.agentColor,
            });
          }
        }
        break;
      case 'interrupted':
        if (forActiveSession) {
          setThinking(false);
          setStreamingContent('');
          setStreamingMsgId(null);
          setStreamingEngine(null);
          setChatScrollNonce((n) => n + 1);
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
          setStreamingAgent(null);
          if (data.message) {
            setMessages((prev) => {
              if (prev.some((m) => m.id === data.message.id)) return prev;
              return [...prev, data.message];
            });
          }
        }
        break;
      case 'session-updated':
        // Matches web: server sends a full session row; spread keeps fields fresh.
        setSessions((prev) =>
          prev.map((s) => (s.id === data.session.id ? { ...s, ...data.session } : s)),
        );
        if (data.session?.id === activeSessionIdRef.current && Array.isArray(data.session.agents)) {
          setSessionAgents(data.session.agents);
        }
        break;
      case 'session-worktree-detected':
        // Keep the per-session row flag in sync for debugging / future
        // tooling. The user-facing badge was removed when Agent Hub
        // locked to worktree-only sessions.
        setSessions((prev) => applyDetectedFlag(prev, data.sessionId, data.gitWorktree));
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
      case 'session_round_start':
        if (forActiveSession) setSessionRoundProcessing(true);
        break;
      case 'session_round_done':
        if (forActiveSession) setSessionRoundProcessing(false);
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
      case 'browser_activity_screenshot': {
        const sid = data.sessionId;
        const mid = data.messageId;
        const aid = data.actionId;
        const shot = data.screenshotDataUrl;
        if (!sid || !mid || !aid || typeof shot !== 'string') break;
        setBrowserScreensBySession((prev) =>
          mergeBrowserActivityScreenshot(prev, sid, mid, aid, shot),
        );
        break;
      }

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

      case 'session_created': {
        const row = data.session;
        if (row && data.agentId === activeAgentIdRef.current) {
          setSessions((prev) => {
            if (prev.some((s) => s.id === row.id)) return prev;
            return [row, ...prev];
          });
        }
        break;
      }

      case 'session_restored': {
        // Server broadcast after POST /api/sessions/:id/restore. Re-home
        // the row in the live list without a full refetch and drop it
        // from the Archived drawer section. Tolerant of either id shape.
        const restoredId = data.sessionId || data.session?.id;
        if (!restoredId) break;
        setArchivedSessions((prev) => prev.filter((s) => s.id !== restoredId));
        if (data.session && data.session.agent_id === activeAgentIdRef.current) {
          setSessions((prev) => {
            if (prev.some((s) => s.id === restoredId)) return prev;
            return [data.session, ...prev];
          });
        }
        break;
      }

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
      case 'changes_ready': {
        const aid = data.agentId;
        const agentRow = agentsRef.current.find((a) => a.id === aid);
        const proj = projectsRef.current.find((p) => p.id === agentRow?.projectId);
        if (isWorkflowProject(proj)) break;
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
      }

      // A PR was opened (manually or automatically) — clear the banner.
      case 'auto_pr_created':
        setChangesReady((prev) => {
          if (!prev[data.sessionId]) return prev;
          const next = { ...prev };
          delete next[data.sessionId];
          return next;
        });
        break;

      case 'auto_pr_failed':
        if (data.sessionId === activeSessionIdRef.current) {
          setShipFailureAt(Date.now());
        }
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

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

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
        const [agentData, projectData, cronSessionData] = await Promise.all([
          api.getAgents(),
          api.getProjects().catch(() => []),
          api.getCronSessions().catch(() => []),
        ]);
        setAgents(agentData);
        setProjects(projectData);
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
    // Fetch archived (soft-deleted) sessions in parallel so the drawer's
    // Archived section is populated at the same moment the live list lands.
    api
      .getArchivedSessions(activeAgentId)
      .then((rows) => setArchivedSessions(Array.isArray(rows) ? rows : []))
      .catch(() => setArchivedSessions([]));

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
        setSessionModel(target.model || defaultModelForEngine(target.engine || agent?.engine || 'claude-code'));
        setSessionAskMode(target.ask_mode !== 0 && !!target.ask_mode);
      } else {
        setActiveSessionId(null);
        setMessages([]);
        const agent = agents.find((a) => a.id === activeAgentId);
        setSessionEngine(agent?.engine || 'claude-code');
        setSessionModel(defaultModelForEngine(agent?.engine || 'claude-code'));
        setSessionAskMode(false);
      }
    }).catch((err) => console.error('Failed to load sessions:', err));
  }, [configReady, activeAgentId, modelConfig]);

  useEffect(() => {
    if (!configReady || !getApiBaseUrl()) return;
    let cancelled = false;
    api
      .getModelConfig()
      .then((cfg) => {
        if (!cancelled) setModelConfig(cfg);
      })
      .catch((err) => {
        console.warn('[modelConfig] GET /api/config/models failed:', err?.message || err);
      });
    return () => {
      cancelled = true;
    };
  }, [configReady]);

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
      setSessionAskMode(session.ask_mode !== 0 && !!session.ask_mode);
    }
  }, [activeSessionId, sessions]);

  // Mirror web App.jsx: if the session engine has no authenticated models,
  // migrate to the first engine that does so TopBar state matches the server.
  useEffect(() => {
    if (!modelConfig || !activeSessionId) return;
    const allowed = modelConfig.engineValidModels?.[sessionEngine];
    if (Array.isArray(allowed) && allowed.length > 0) return;

    const nextEngine = firstEngineWithAuthenticatedModels(modelConfig);
    if (!nextEngine || nextEngine === sessionEngine) return;
    const defaultModel = defaultModelForAuthenticatedEngine(modelConfig, nextEngine);
    if (!defaultModel) return;

    let cancelled = false;
    const sid = activeSessionIdRef.current;
    void (async () => {
      try {
        setSessionEngine(nextEngine);
        setSessionModel(defaultModel);
        const updatedEngine = await api.setSessionEngine(sid, nextEngine);
        if (cancelled || activeSessionIdRef.current !== sid) return;
        setSessions((prev) =>
          prev.map((s) => (s.id === updatedEngine.id ? { ...s, engine: updatedEngine.engine } : s)),
        );
        const modelUpdated = await api.setSessionModel(sid, defaultModel);
        if (cancelled || activeSessionIdRef.current !== sid) return;
        setSessions((prev) =>
          prev.map((s) => (s.id === modelUpdated.id ? { ...s, model: modelUpdated.model } : s)),
        );
      } catch (err) {
        console.warn('[modelConfig] Failed to migrate session off unauthenticated engine:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modelConfig, activeSessionId, sessionEngine, sessions]);

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
    setSessionAgents([]);
    setSessionRoundProcessing(false);
    setDelegations({});
    setMessageQueues({});
    setEventsByMessage({});
    setCronSessions([]);
    setChangesReady({});
    setSessionHandoffs([]);
    setSessionAskMode(false);
    // Reconnect WebSocket to new org
    reconnect();
    // Reload data
    try {
      const [agentData, projectData, cronSessionData] = await Promise.all([
        api.getAgents(),
        api.getProjects().catch(() => []),
        api.getCronSessions().catch(() => []),
      ]);
      setAgents(agentData);
      setProjects(projectData);
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
    setSessions((prev) =>
      prev.some((s) => s.id === session.id) ? prev : [session, ...prev],
    );
    setActiveSessionId(session.id);
    const agent = agents.find((a) => a.id === activeAgentId);
    setSessionEngine(session.engine || agent?.engine || 'claude-code');
    setSessionModel(session.model || defaultModelForEngine(session.engine || agent?.engine || 'claude-code'));
    setSessionAskMode(session.ask_mode !== 0 && !!session.ask_mode);
    setMessages([]);
  }, [activeAgentId, agents, sessionAskMode]);

  // `handleWorktreeChange` was removed when Agent Hub locked to
  // worktree-only sessions. The legacy `PUT /sessions/:id/worktree`
  // endpoint no longer exists.

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
    const defaultModel = defaultModelForEngine(engine);
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
  }, [modelConfig]);

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
    // Mirror of the web client's pattern (client/src/App.jsx) — await the
    // DELETE first, then mutate state only on success. Previously we removed
    // the row from `sessions` *before* the await, so a failed DELETE (network
    // drop, 5xx, auth) would leave the session invisible without adding it
    // to `archivedSessions` — the exact data-loss surface this feature is
    // meant to prevent. We also snapshot the row up-front so the archived
    // list can carry the real message_count rather than a placeholder.
    const deletedRow = sessionsRef.current?.find((s) => s.id === sessionId) || null;
    try {
      await api.deleteSession(sessionId);
      setBrowserScreensBySession((prev) => {
        if (!prev[sessionId]) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      setSessions((prev) => {
        const remaining = prev.filter((s) => s.id !== sessionId);
        if (activeSessionIdRef.current === sessionId) {
          setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
        }
        return remaining;
      });
      if (deletedRow) {
        setArchivedSessions((prev) => {
          if (prev.some((s) => s.id === sessionId)) return prev;
          return [
            {
              ...deletedRow,
              // Client clock — may drift from server's UTC datetime('now')
              // used by the purge cron. The next fetch reconciles.
              deleted_at: new Date().toISOString(),
              message_count: deletedRow.message_count ?? 0,
            },
            ...prev,
          ];
        });
      }
    } catch (err) {
      // Surface the failure so the user knows the row is still live. No
      // rollback needed because we never removed it optimistically.
      Alert.alert(
        'Delete failed',
        err?.message || 'Could not archive this session. Please try again.',
      );
      throw err;
    }
  }, []);

  const handleRestoreSession = useCallback(async (sessionId) => {
    setRestoringSessionIds((prev) => {
      const next = new Set(prev);
      next.add(sessionId);
      return next;
    });
    try {
      const restored = await api.restoreSession(sessionId);
      // Drop from archived; the WS `session_restored` event is the canonical
      // path for re-inserting into `sessions`, but we mirror here to cover
      // the initiating device on a slow WS.
      setArchivedSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (restored && restored.id) {
        setSessions((prev) => {
          if (prev.some((s) => s.id === restored.id)) return prev;
          return [restored, ...prev];
        });
      }
    } catch (err) {
      Alert.alert(
        'Restore failed',
        err?.message || 'Could not restore this session. Please try again.',
      );
    } finally {
      setRestoringSessionIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  }, []);

  useEffect(() => {
    streamingMsgIdRef.current = streamingMsgId;
  }, [streamingMsgId]);

  const handleCancel = useCallback(() => {
    const sid = activeSessionIdRef.current;
    if (sid) {
      setChatScrollNonce((n) => n + 1);
      send({ type: 'cancel', sessionId: sid });
      setThinking(false);
      setStreamingContent('');
      setStreamingMsgId(null);
      setStreamingEngine(null);
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

  const handleSend = useCallback(async (content, images = [], { interrupt = false } = {}) => {
    let sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      const coalesceKey = `${activeAgentId}:${sessionAskMode ? 'ask' : 'run'}`;
      const session = await coalescePromiseByKey(
        implicitSessionCreateByKeyRef,
        coalesceKey,
        () =>
          api
            .createSession(activeAgentId, undefined, { askMode: sessionAskMode })
            .then((s) => {
              setSessions((prev) => (prev.some((x) => x.id === s.id) ? prev : [s, ...prev]));
              setActiveSessionId(s.id);
              activeSessionIdRef.current = s.id;
              return s;
            }),
      );
      sessionId = session.id;
    }

    // Upload attachments first, then send chat with references. Images go
    // through the base64 /api/upload route; videos and generic files stream
    // via /api/upload/file using api.uploadFile (FileSystem.uploadAsync).
    let uploadedImages = [];
    if (images.length > 0) {
      const persisted = images.filter(isPersistedUploadAttachment);
      const pending = images.filter((img) => !isPersistedUploadAttachment(img));
      try {
        const uploaded = pending.length > 0 ? await uploadAttachments(pending, api) : [];
        uploadedImages = [...persisted, ...uploaded];
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
      ...(interrupt ? { interrupt: true } : {}),
    });
  }, [activeAgentId, sessionAskMode, send]);

  const handleInterruptQueuedMessage = useCallback(
    (message) => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId || !message?.id) return;
      const { chat } = buildInterruptQueuedMessageDispatch({
        message,
        agentId: activeAgentId,
        sessionId,
      });
      send(chat);
    },
    [send, activeAgentId],
  );

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

  // Load session agents when active session changes.
  useEffect(() => {
    if (!activeSessionId) {
      setSessionAgents([]);
      setSessionRoundProcessing(false);
      return;
    }
    let cancelled = false;
    api
      .getSessionDetail(activeSessionId)
      .then((detail) => {
        if (!cancelled) setSessionAgents(detail.agents || []);
      })
      .catch(() => {
        if (!cancelled) setSessionAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  const handleSessionAgentsUpdated = useCallback((detail) => {
    if (!detail?.id) return;
    setSessionAgents(detail.agents || []);
    setSessions((prev) => prev.map((s) => (s.id === detail.id ? { ...s, ...detail } : s)));
  }, []);

  const handleDequeue = useCallback(
    (messageId, { cancelStream = false } = {}) => {
      const sid = activeSessionIdRef.current;
      if (sid) {
        send({ type: 'dequeue', sessionId: sid, messageId });
        setMessages((prev) => prev.filter((m) => m.id !== messageId));
        if (cancelStream && (thinking || streamingContent)) {
          handleCancel();
        }
      }
    },
    [send, thinking, streamingContent, handleCancel],
  );

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
    setEventsByMessage((prev) => {
      const existing = prev[messageId];
      if (Array.isArray(existing) && existing.length > 0) return prev;
      return { ...prev, [messageId]: events };
    });
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

  const triggerCreateTicketAndPr = useCallback(async () => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    try {
      await api.shipSession(sessionId);
    } catch (err) {
      Alert.alert('Create ticket & PR', (err && err.message) || 'Failed to start shipping');
    }
  }, []);

  const isProcessing = thinking || !!streamingContent || sessionRoundProcessing;

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
    modelConfig,
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
    archivedSessions,
    handleRestoreSession,
    restoringSessionIds,
    handleCancel,
    chatScrollNonce,
    handleSend,
    handleSwitchOrg,
    refreshAgents,
    refreshProjects,
    skills,
    sessionAgents,
    sessionRoundProcessing,
    handleSessionAgentsUpdated,
    delegations,
    sessionHandoffs,
    handleOpenHandoffSession,
    messageQueues,
    eventsByMessage,
    browserScreensBySession,
    handleDequeue,
    handleInterruptQueuedMessage,
    handleEditQueuedMessage,
    handleDelegationCancel,
    handleEventsLoaded,
    cronSessions,
    kanbanRefreshKey,
    changesReady,
    shipFailureAt,
    dismissChangesReady,
    triggerCreateTicketAndPr,
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
