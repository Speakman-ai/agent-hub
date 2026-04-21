import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import Sidebar from './components/Sidebar.jsx';
import TopBar from './components/TopBar.jsx';
import ChatMessage from './components/ChatMessage.jsx';
import ThinkingIndicator from './components/ThinkingIndicator.jsx';
import SessionTail from './components/SessionTail.jsx';
import MessageInput from './components/MessageInput.jsx';
import AgentSwitcher from './components/AgentSwitcher.jsx';
import ForwardSessionModal, { filterForwardTargets } from './components/ForwardSessionModal.jsx';
import SettingsPage from './components/SettingsPage.jsx';
import SkillsPage from './components/SkillsPage.jsx';
import RoomChat from './components/RoomChat.jsx';
import DesignsList from './components/DesignsList.jsx';
import DesignView from './components/DesignView.jsx';
import DelegationPanel from './components/DelegationPanel.jsx';
import ChangesReadyBox from './components/ChangesReadyBox.jsx';
import ProgressPanel, { mergeProgressEvent } from './components/ProgressPanel.jsx';
import OpenProjectWizard from './components/OpenProjectWizard.jsx';
import SetupWizard from './components/SetupWizard.jsx';
import KanbanBoard from './components/KanbanBoard.jsx';
import DashboardView from './components/DashboardView.jsx';
import WikiBrowser from './components/WikiBrowser.jsx';
import ThreadList from './components/ThreadList.jsx';
import ThreadView from './components/ThreadView.jsx';
import NotesEditor from './components/NotesEditor.jsx';
import CapturesPage from './components/CapturesPage.jsx';
import PullRequestsPage from './components/PullRequestsPage.jsx';
import ShortcutsHelpModal from './components/ShortcutsHelpModal.jsx';
import UpdateAvailableModal from './components/UpdateAvailableModal.jsx';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useDesktopNotifications } from './hooks/useDesktopNotifications.js';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js';
import { useVersionCheck } from './hooks/useVersionCheck.js';
import { api } from './utils/api.js';
import {
  cardStartedNotification,
  cardReviewNotification,
  prMergedNotification,
  prReadyNotification,
  sessionCompleteNotification,
  threadCreatedNotification,
  threadEntryNotification,
} from './utils/ticketNotifications.js';
import {
  MessageCircle,
  Info,
  CheckCircle,
  AlertTriangle,
  Loader2,
  ArrowLeftRight,
} from 'lucide-react';
import {
  migrateFromLegacy,
  fetchOrgs,
  getActiveOrg,
  getActiveOrgApiId,
  getOrgs,
} from './utils/orgs.js';
import { getApiBase, getAuthHeaders, getServerBase } from './utils/connection.js';
import { extractSubmittedAskIds } from './utils/askAnswers.js';

export default function App() {
  const [projects, setProjects] = useState([]);
  const [agents, setAgents] = useState([]);
  const [activeAgentId, _setActiveAgentId] = useState(() => {
    return localStorage.getItem('activeAgentId') || null;
  });
  const setActiveAgentId = useCallback((id) => {
    if (id) localStorage.setItem('activeAgentId', id);
    _setActiveAgentId(id);
  }, []);
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  // Handoffs (rows from GET /api/sessions/:id/handoffs) for the active
  // source session — used by HandoffCard to render an "Open session" link.
  const [sessionHandoffs, setSessionHandoffs] = useState([]);
  const [thinking, setThinking] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingMsgId, setStreamingMsgId] = useState(null);
  const [streamingEngine, setStreamingEngine] = useState(null);
  const [sessionEngine, setSessionEngine] = useState('claude-code');
  const [sessionModel, setSessionModel] = useState('claude-opus-4-7');
  const [sessionWorktree, setSessionWorktree] = useState(true);
  const [gitWorktreeDetected, setGitWorktreeDetected] = useState(null); // null = unknown, true/false from CLI
  const [sessionAskMode, setSessionAskMode] = useState(false);
  const [verboseMode, setVerboseMode] = useState(() => {
    return localStorage.getItem('verboseMode') === 'true';
  });
  const handleVerboseModeChange = useCallback((v) => {
    localStorage.setItem('verboseMode', v ? 'true' : 'false');
    setVerboseMode(v);
  }, []);
  const [currentView, setCurrentView] = useState('chat');
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showForward, setShowForward] = useState(false);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [deletingSessionIds, setDeletingSessionIds] = useState(new Set());
  const [deletingBulk, setDeletingBulk] = useState(null); // 'all' | 'inactive' | null
  // Map of sessionId -> running task state ({messageId, content, engine, model}).
  // Populated from the server's snapshot on connect and updated as stream events arrive.
  // Used to (a) restore streaming state when switching sessions and (b) power the
  // "running" indicator in the sidebar.
  const [activeTasks, setActiveTasks] = useState({});
  // Map of messageId -> array of { seq, event } for the SessionTail timeline.
  // Populated by 'session-event' WS messages (live) or via api.getMessageEvents
  // (historical, lazy on first SessionTail render).
  const [eventsByMessage, setEventsByMessage] = useState({});
  // Message queue state: sessionId -> [{id, content, position}]
  const [messageQueues, setMessageQueues] = useState({});
  // Conference room state
  const [rooms, setRooms] = useState([]);
  const [activeRoomId, setActiveRoomId] = useState(null);
  const [roomMessages, setRoomMessages] = useState([]);
  const [roomStreaming, setRoomStreaming] = useState(null);
  const [roomThinking, setRoomThinking] = useState(null);
  const [roomProcessing, setRoomProcessing] = useState(false);
  const [roomQueueLength, setRoomQueueLength] = useState(0);
  // Claude Design (Phase 1) — top-level, not project-scoped
  const [designs, setDesigns] = useState([]);
  const [activeDesignId, setActiveDesignId] = useState(null);
  const [designMessages, setDesignMessages] = useState([]);
  const [designStreaming, setDesignStreaming] = useState(null);
  const [designThinking, setDesignThinking] = useState(false);
  const [designProcessing, setDesignProcessing] = useState(false);
  // Cache-buster for the design iframe. Bumped on every `design_updated` WS
  // event for the active design so the iframe re-fetches the latest files.
  const [designReloadToken, setDesignReloadToken] = useState(0);
  // Delegation state: Map of sessionId -> { parentMessageId, tasks: [{delegationId, agentId, agentName, agentColor, task, status, content, output, error}] }
  const [delegations, setDelegations] = useState({});
  // Rate-limit throttle state: Map of sessionId -> { active, retryAfterMs, clearedAt }
  const [throttle, setThrottle] = useState({});
  // Subagent tracking: Map of sessionId -> { total, running, done, errored }
  const [subagents, setSubagents] = useState({});
  // Ad-hoc PR creation: Map of sessionId -> { agentId, branch, hasUncommitted, hasUnpushed }
  const [changesReady, setChangesReady] = useState({});
  // Cursor-style ProgressPanel state — keyed by sessionId.
  // Each value: Array<{ step, status, startedAt, finishedAt? }> in emit order.
  const [sessionProgress, setSessionProgress] = useState({});
  // Tracks which agenthub:ask prompts the user has already answered in this
  // tab, so the picker renders as "Submitted" immediately after click. This is
  // the optimistic, in-memory half; the authoritative source is the derived
  // set below which scans persisted message history.
  const [askSubmittedOptimistic, setAskSubmittedOptimistic] = useState(() => new Set());
  // Derived from persisted message history: any user message containing an
  // `agenthub:ask:answer` block with a matching askId marks that picker as
  // submitted. Surviving page reloads requires this — in-memory state is lost
  // on refresh, but the user message is persisted in the DB and re-fetched.
  const askSubmittedFromHistory = useMemo(() => extractSubmittedAskIds(messages), [messages]);
  // Union of optimistic (just-clicked) + history-derived (persisted). Passed to
  // the picker's `submitted` prop and used to short-circuit duplicate sends.
  const askSubmitted = useMemo(() => {
    if (askSubmittedOptimistic.size === 0) return askSubmittedFromHistory;
    const union = new Set(askSubmittedFromHistory);
    for (const id of askSubmittedOptimistic) union.add(id);
    return union;
  }, [askSubmittedOptimistic, askSubmittedFromHistory]);
  // Wiki state
  const [wikiProjectId, setWikiProjectId] = useState(null);
  // Notes state
  const [notesProjectId, setNotesProjectId] = useState(null);
  // Previews state
  const [capturesProjectId, setCapturesProjectId] = useState(null);
  // Pull Requests state
  const [pullsProjectId, setPullsProjectId] = useState(null);
  // Threads state
  const [threadsProjectId, setThreadsProjectId] = useState(null);
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [activeThread, setActiveThread] = useState(null);
  // Unread thread entry counts per project: { [projectId]: number }
  const [unreadThreadCounts, setUnreadThreadCounts] = useState({});
  // Refs to push WebSocket updates into ThreadList/ThreadView
  const threadListRef = useRef(null);
  const threadViewRef = useRef(null);
  // Cron-linked sessions (scheduled tasks)
  const [cronSessions, setCronSessions] = useState([]);
  // Skills for the active agent (for /slash-command autocomplete)
  const [skills, setSkills] = useState([]);
  // Open Project wizard
  const [showWizard, setShowWizard] = useState(false);
  // First-run setup
  const [setupStatus, setSetupStatus] = useState(null);
  const [showSetup, setShowSetup] = useState(false);
  // Loading state — true until org/switch + project load completes
  const [initializing, setInitializing] = useState(true);
  // Active lead reviews: Map of agentId -> { prUrl, cardTitle, sessionId }
  const [activeReviews, setActiveReviews] = useState({});
  // Toast notifications
  const [toasts, setToasts] = useState([]);
  const showToast = (message, type = 'info', duration = 5000) => {
    setToasts((prev) => [...prev, { id: `toast-${Date.now()}`, type, message, duration }]);
  };
  // Desktop notifications (Electron native / Web Notifications API)
  const { notify } = useDesktopNotifications();
  // Kanban board refresh trigger
  const [kanbanRefreshKey, setKanbanRefreshKey] = useState(0);
  const activeRoomIdRef = useRef(activeRoomId);
  activeRoomIdRef.current = activeRoomId;
  const activeDesignIdRef = useRef(activeDesignId);
  activeDesignIdRef.current = activeDesignId;

  const messagesEndRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const activeAgentIdRef = useRef(activeAgentId);
  activeAgentIdRef.current = activeAgentId;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  // Mirror of `changesReady` accessible inside WebSocket callbacks (used to
  // detect whether a `changes_ready` event is a fresh prompt vs a replay).
  const changesReadyRef = useRef(changesReady);
  changesReadyRef.current = changesReady;

  // Track when a session was explicitly navigated to (e.g. from kanban assign)
  // so the agent-change useEffect doesn't overwrite it with a stale session ID.
  const pendingSessionIdRef = useRef(null);

  // Refs for thread state (accessible inside WebSocket callback)
  const threadsProjectIdRef = useRef(threadsProjectId);
  threadsProjectIdRef.current = threadsProjectId;
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  const currentViewRef = useRef(currentView);
  currentViewRef.current = currentView;

  const activeAgent = agents.find((a) => a.id === activeAgentId);

  // Auto-scroll — instant on initial load, smooth for live updates.
  // Only auto-scrolls if user is already near the bottom (within threshold).
  const initialScrollRef = useRef(true);
  const scrollRafRef = useRef(null);
  const isNearBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  // Tracks whether a programmatic scroll is in progress so we don't
  // interpret the resulting scroll events as the user scrolling away.
  const programmaticScrollRef = useRef(false);

  const checkNearBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return true;
    const threshold = 150;
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  const handleScrollEvent = useCallback(() => {
    // Ignore scroll events caused by our own programmatic scrolling —
    // these would otherwise flip isNearBottomRef to false mid-animation
    // and break auto-follow.
    if (programmaticScrollRef.current) return;
    const nearBottom = checkNearBottom();
    isNearBottomRef.current = nearBottom;
    setShowScrollBtn(!nearBottom);
  }, [checkNearBottom]);

  const scrollToBottom = useCallback((instant) => {
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    const el = scrollContainerRef.current;
    if (instant && el) {
      // For initial/instant scrolls, set scrollTop directly — more
      // reliable than scrollIntoView when the DOM is still laying out.
      programmaticScrollRef.current = true;
      el.scrollTop = el.scrollHeight;
      // Clear the flag after the browser has finished processing the scroll,
      // and mark us as "at the bottom" so auto-follow resumes.
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
        isNearBottomRef.current = true;
        setShowScrollBtn(false);
      });
      return;
    }
    // For smooth scrolls (live streaming), use scrollIntoView with the
    // programmatic guard so the animation doesn't break isNearBottomRef.
    programmaticScrollRef.current = true;
    scrollRafRef.current = requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      // Smooth scroll takes time; clear after a generous window and
      // restore near-bottom state so auto-follow continues.
      setTimeout(() => {
        programmaticScrollRef.current = false;
        isNearBottomRef.current = true;
        setShowScrollBtn(false);
      }, 200);
    });
  }, []);

  // Auto-scroll on new content, but only if user is near the bottom or it's initial load.
  useLayoutEffect(() => {
    if (initialScrollRef.current || isNearBottomRef.current) {
      scrollToBottom(initialScrollRef.current);
    }
    if (initialScrollRef.current) {
      // Schedule a second scroll for content that renders late (images, code
      // blocks, lazy-loaded components). This catches cases where the first
      // scroll fires before the full height is known.
      const timer = setTimeout(() => {
        const el = scrollContainerRef.current;
        if (el) {
          programmaticScrollRef.current = true;
          el.scrollTop = el.scrollHeight;
          requestAnimationFrame(() => {
            programmaticScrollRef.current = false;
            isNearBottomRef.current = true;
            setShowScrollBtn(false);
          });
        }
      }, 100);
      initialScrollRef.current = false;
      return () => clearTimeout(timer);
    }
    initialScrollRef.current = false;
  }, [messages, thinking, streamingContent, scrollToBottom]);

  // Reset to instant scroll when switching sessions
  useLayoutEffect(() => {
    initialScrollRef.current = true;
    isNearBottomRef.current = true;
    setShowScrollBtn(false);
  }, [activeSessionId]);

  // WebSocket handler
  const handleWsMessage = useCallback((data) => {
    // Is this event for the session the user is currently viewing?
    const forActiveSession = data.sessionId && data.sessionId === activeSessionIdRef.current;
    // 'message' events use message.session_id rather than top-level sessionId.
    const msgForActiveSession = data.message?.session_id === activeSessionIdRef.current;

    switch (data.type) {
      case 'active-tasks-snapshot': {
        // Rebuild active-task map from server snapshot.
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
        // If the currently viewed session has an in-flight task, restore streaming state.
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
        // Always track the task; only update the visible indicator if it's our session.
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
      case 'session-event': {
        // Append a single event to the message's timeline. Dedup by seq in case
        // a reconnect causes the server to replay something we already have.
        // The common case is strictly increasing seq, so fast-path the append.
        const { messageId, seq, event } = data;
        if (!messageId) break;
        setEventsByMessage((prev) => {
          const existing = prev[messageId] || [];
          const last = existing[existing.length - 1];
          if (!last || last.seq < seq) {
            return { ...prev, [messageId]: [...existing, { seq, event }] };
          }
          if (existing.some((e) => e.seq === seq)) return prev;
          const next = [...existing, { seq, event }].sort((a, b) => a.seq - b.seq);
          return { ...prev, [messageId]: next };
        });

        // Track subagent spawns and completions per session
        if (event?.type === 'tool_use' && (event.tool === 'Task' || event.tool === 'Agent')) {
          const sid = data.sessionId;
          setSubagents((prev) => {
            const entry = prev[sid] || {
              total: 0,
              running: 0,
              done: 0,
              errored: 0,
              ids: new Set(),
            };
            if (entry.ids.has(event.id)) return prev; // dedup
            const next = {
              ...entry,
              total: entry.total + 1,
              running: entry.running + 1,
              ids: new Set(entry.ids),
            };
            next.ids.add(event.id);
            return { ...prev, [sid]: next };
          });
        }
        if (event?.type === 'tool_result') {
          const sid = data.sessionId;
          setSubagents((prev) => {
            const entry = prev[sid];
            if (!entry || !entry.ids.has(event.toolUseId)) return prev;
            return {
              ...prev,
              [sid]: {
                ...entry,
                running: entry.running - 1,
                ...(event.isError ? { errored: entry.errored + 1 } : { done: entry.done + 1 }),
              },
            };
          });
        }

        // Track rate-limit throttle state per session
        if (event?.type === 'rate_limit') {
          const sid = data.sessionId;
          const retryMs = event.retryAfterMs || 5000;
          setThrottle((prev) => ({
            ...prev,
            [sid]: { active: true, retryAfterMs: retryMs, ts: Date.now() },
          }));
          // Auto-clear throttle indicator after retry period elapses
          setTimeout(() => {
            setThrottle((prev) => {
              const entry = prev[sid];
              if (!entry || !entry.active) return prev;
              return { ...prev, [sid]: { ...entry, active: false } };
            });
          }, retryMs + 1000);
        }
        break;
      }
      case 'session-progress': {
        // Drives the in-Hub ProgressPanel for this session. The server sends
        // one message per progress_step event; we reduce it into the ordered
        // list keyed by sessionId.
        const sid = data.sessionId;
        if (!sid) break;
        setSessionProgress((prev) => ({
          ...prev,
          [sid]: mergeProgressEvent(prev[sid] || [], {
            step: data.step,
            status: data.status,
            startedAt: data.startedAt,
            finishedAt: data.finishedAt ?? undefined,
          }),
        }));
        break;
      }
      case 'done':
        setActiveTasks((prev) => {
          const next = { ...prev };
          delete next[data.sessionId];
          return next;
        });
        // Clear throttle state for completed session
        setThrottle((prev) => {
          if (!prev[data.sessionId]) return prev;
          const next = { ...prev };
          delete next[data.sessionId];
          return next;
        });
        // Clear subagent tracking for completed session
        setSubagents((prev) => {
          if (!prev[data.sessionId]) return prev;
          const next = { ...prev };
          delete next[data.sessionId];
          return next;
        });
        if (forActiveSession) {
          setThinking(false);
          setStreamingContent('');
          setStreamingMsgId(null);
          setStreamingEngine(null);
          if (data.message) {
            setMessages((prev) => [...prev, data.message]);
          }
        }
        // Desktop notification + toast for completed background sessions
        if (!forActiveSession && data.message) {
          const session = sessionsRef.current.find((s) => s.id === data.sessionId);
          const agent = session ? agentsRef.current.find((a) => a.id === session.agent_id) : null;
          const agentName = agent?.name || 'Agent';
          const preview =
            typeof data.message.content === 'string'
              ? data.message.content.replace(/\n+/g, ' ').trim()
              : undefined;
          const { title, body } = sessionCompleteNotification({
            agentName,
            sessionName: session?.name,
            preview,
          });
          setToasts((prev) => [
            ...prev,
            {
              id: `session-done-${data.sessionId}-${Date.now()}`,
              type: 'success',
              message: session?.name || 'Session completed',
              duration: 10000,
              onClick: () => {
                setActiveSessionId(data.sessionId);
                setCurrentView('chat');
              },
            },
          ]);
          notify({ title, body, type: 'success' });
        }
        break;
      case 'changes_ready': {
        const alreadyPrompted = !!changesReadyRef.current[data.sessionId];
        setChangesReady((prev) => ({
          ...prev,
          [data.sessionId]: {
            agentId: data.agentId,
            branch: data.branch,
            hasUncommitted: data.hasUncommitted,
            hasUnpushed: data.hasUnpushed,
          },
        }));
        // Only notify on a fresh prompt — avoids re-firing on reconnect/replay.
        if (!alreadyPrompted) {
          const session = sessionsRef.current.find((s) => s.id === data.sessionId);
          const agent = agentsRef.current.find((a) => a.id === data.agentId);
          const { title, body } = prReadyNotification({
            agentName: agent?.name,
            sessionName: session?.name,
            branch: data.branch,
          });
          setToasts((prev) => [
            ...prev,
            {
              id: `pr-ready-${data.sessionId}-${Date.now()}`,
              type: 'info',
              message: session?.name || 'Changes ready for PR',
              duration: 10000,
              onClick: () => {
                setActiveSessionId(data.sessionId);
                setCurrentView('chat');
              },
            },
          ]);
          notify({ title, body, type: 'info' });
        }
        break;
      }
      case 'auto_pr_created':
        // Clear changes_ready state when a PR is created (manually or automatically)
        setChangesReady((prev) => {
          if (!prev[data.sessionId]) return prev;
          const next = { ...prev };
          delete next[data.sessionId];
          return next;
        });
        break;
      case 'message_added':
        // A new message (e.g. the system 'PR created' marker persisted by the
        // server) was inserted on the backend. If it belongs to the active
        // session, append it to the timeline — guarded by an id-dedup check
        // so a double broadcast can never duplicate-render.
        if (forActiveSession && data.message?.id) {
          setMessages((prev) => {
            if (prev.some((m) => m.id === data.message.id)) return prev;
            return [...prev, data.message];
          });
        }
        break;
      case 'session-updated':
        setSessions((prev) =>
          prev.map((s) => (s.id === data.session.id ? { ...s, name: data.session.name } : s)),
        );
        break;
      case 'session-worktree-detected':
        // Update the session's git_worktree_detected flag from CLI status line
        setSessions((prev) =>
          prev.map((s) =>
            s.id === data.sessionId ? { ...s, git_worktree_detected: data.gitWorktree ? 1 : 0 } : s,
          ),
        );
        if (forActiveSession) {
          setGitWorktreeDetected(data.gitWorktree);
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
      case 'interrupted':
        if (forActiveSession) {
          setThinking(false);
          setStreamingContent('');
          setStreamingMsgId(null);
          setStreamingEngine(null);
        }
        break;

      // ─── Conference Room events ─────────────────────────────
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
          setRoomStreaming(null);
          setRoomThinking({
            agentId: data.agentId,
            agentName: data.agentName,
            agentColor: data.agentColor,
          });
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
              room_id: data.roomId,
              role: 'assistant',
              agent_id: data.agentId,
              agent_name: data.agentName,
              agent_color: null,
              content: `Error: ${data.error}`,
              created_at: new Date().toISOString(),
            },
          ]);
        }
        break;
      case 'room_queue_updated':
        if (data.roomId === activeRoomIdRef.current) {
          setRoomQueueLength(data.queue?.length || data.queueLength || 0);
        }
        break;
      case 'room_round_done':
      case 'room_cancelled':
        if (data.roomId === activeRoomIdRef.current) {
          // Don't reset roomProcessing if there are queued messages about to drain —
          // prevents UI flicker between queued message rounds (Bugbot fix)
          if (!data.queueLength) {
            setRoomProcessing(false);
          }
          setRoomThinking(null);
          setRoomStreaming(null);
        }
        break;

      // ─── Claude Design events ────────────────────────────────
      case 'design_created':
        // Broadcast from any client creating a design — refresh list
        if (data.design) {
          setDesigns((prev) => {
            if (prev.some((d) => d.id === data.design.id)) return prev;
            return [data.design, ...prev];
          });
        }
        break;
      case 'design_deleted':
        setDesigns((prev) => prev.filter((d) => d.id !== data.designId));
        if (activeDesignIdRef.current === data.designId) {
          setActiveDesignId(null);
          setDesignMessages([]);
          setDesignStreaming(null);
          setDesignThinking(false);
          setDesignProcessing(false);
          setCurrentView('designs');
        }
        break;
      case 'design_updated':
        // Fires once per assistant turn — bump the iframe reload token for
        // the active design so the canvas re-fetches the new files.
        if (data.designId === activeDesignIdRef.current) {
          setDesignReloadToken((t) => t + 1);
          setDesignStreaming(null);
          setDesignThinking(false);
          setDesignProcessing(false);
        }
        // Also refresh design row metadata (updated_at) in the list.
        setDesigns((prev) =>
          prev.map((d) =>
            d.id === data.designId ? { ...d, updated_at: new Date().toISOString() } : d,
          ),
        );
        break;
      case 'design_message_added':
        if (data.designId === activeDesignIdRef.current && data.message) {
          // Streaming token deltas arrive as the same messageId with growing content;
          // the final message also arrives as 'design_message_added'. Treat assistant
          // deltas by keeping a separate streaming slot and flushing on role=='assistant'
          // with a final flag (or when the message already exists in the list).
          const msg = data.message;
          if (msg.role === 'assistant' && msg.streaming) {
            setDesignThinking(false);
            setDesignStreaming({ messageId: msg.id, content: msg.content || '' });
            setDesignProcessing(true);
            break;
          }
          setDesignStreaming(null);
          setDesignThinking(false);
          setDesignMessages((prev) => {
            if (prev.some((m) => m.id === msg.id)) {
              return prev.map((m) => (m.id === msg.id ? msg : m));
            }
            return [...prev, msg];
          });
          // Keep processing=true until design_updated closes the turn; a user
          // message shouldn't flip processing off.
          if (msg.role === 'assistant') {
            setDesignProcessing(false);
          }
        }
        break;

      case 'design_cancelled':
        if (data.designId === activeDesignIdRef.current) {
          setDesignStreaming(null);
          setDesignThinking(false);
          setDesignProcessing(false);
        }
        break;
      case 'design_thinking':
        if (data.designId === activeDesignIdRef.current) {
          setDesignThinking(true);
          setDesignProcessing(true);
        }
        break;
      case 'design_stream':
        // Server emits cumulative stdout on every chunk. As soon as any
        // partial text arrives, we flip from the "thinking…" dot to the
        // streaming view so the user sees progress. Ignored when the event
        // is for a design the user has since navigated away from.
        if (data.designId === activeDesignIdRef.current) {
          setDesignThinking(false);
          setDesignProcessing(true);
          setDesignStreaming({ content: data.content || '' });
        }
        break;

      // ─── Delegation events ────────────────────────────────
      case 'delegation_start':
        if (data.sessionId === activeSessionIdRef.current) {
          setDelegations((prev) => ({
            ...prev,
            [data.sessionId]: {
              parentMessageId: data.parentMessageId,
              tasks: data.tasks.map((t) => ({
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
        }
        break;
      case 'delegation_thinking':
        if (data.sessionId === activeSessionIdRef.current) {
          setDelegations((prev) => {
            const existing = prev[data.sessionId];
            if (!existing) return prev;
            return {
              ...prev,
              [data.sessionId]: {
                ...existing,
                tasks: existing.tasks.map((t) =>
                  t.agentId === data.agentId
                    ? {
                        ...t,
                        delegationId: data.delegationId,
                        agentName: data.agentName,
                        agentColor: data.agentColor,
                        status: 'running',
                      }
                    : t,
                ),
              },
            };
          });
        }
        break;
      case 'delegation_stream':
        if (data.sessionId === activeSessionIdRef.current) {
          setDelegations((prev) => {
            const existing = prev[data.sessionId];
            if (!existing) return prev;
            return {
              ...prev,
              [data.sessionId]: {
                ...existing,
                tasks: existing.tasks.map((t) =>
                  t.agentId === data.agentId
                    ? {
                        ...t,
                        agentName: data.agentName,
                        agentColor: data.agentColor,
                        content: data.content,
                        status: 'running',
                      }
                    : t,
                ),
              },
            };
          });
        }
        break;
      case 'delegation_agent_done':
        if (data.sessionId === activeSessionIdRef.current) {
          setDelegations((prev) => {
            const existing = prev[data.sessionId];
            if (!existing) return prev;
            return {
              ...prev,
              [data.sessionId]: {
                ...existing,
                tasks: existing.tasks.map((t) =>
                  t.agentId === data.agentId
                    ? { ...t, status: 'done', output: data.output, content: '' }
                    : t,
                ),
              },
            };
          });
        }
        break;
      case 'delegation_agent_error':
        if (data.sessionId === activeSessionIdRef.current) {
          setDelegations((prev) => {
            const existing = prev[data.sessionId];
            if (!existing) return prev;
            return {
              ...prev,
              [data.sessionId]: {
                ...existing,
                tasks: existing.tasks.map((t) =>
                  t.agentId === data.agentId ? { ...t, status: 'error', error: data.error } : t,
                ),
              },
            };
          });
        }
        break;
      case 'delegation_round_done':
        // Delegation complete — keep the data for display but mark as done
        break;
      case 'delegation_cancelled':
        if (data.sessionId === activeSessionIdRef.current) {
          setDelegations((prev) => {
            const existing = prev[data.sessionId];
            if (!existing) return prev;
            return {
              ...prev,
              [data.sessionId]: {
                ...existing,
                tasks: existing.tasks.map((t) =>
                  t.status === 'running' || t.status === 'pending'
                    ? { ...t, status: 'cancelled' }
                    : t,
                ),
              },
            };
          });
        }
        break;
      case 'delegation_error': {
        const delegationMsg = `Delegation failed: ${data.error}`;
        if (data.sessionId === activeSessionIdRef.current) {
          setToasts((prev) => [
            ...prev,
            {
              id: `delegation-err-${Date.now()}`,
              type: 'error',
              message: delegationMsg,
              duration: 10000,
            },
          ]);
        }
        notify({ title: 'Delegation Error', body: delegationMsg, type: 'error' });
        break;
      }

      case 'sessions_resuming': {
        const count = data.count || 0;
        const toast = {
          id: `sessions-resuming-${Date.now()}`,
          type: 'info',
          message: `Resuming ${count} interrupted session${count !== 1 ? 's' : ''} after server restart…`,
          duration: 10000,
        };
        setToasts((prev) => [...prev, toast]);
        break;
      }
      case 'analyze-progress':
      case 'analyze-complete':
      case 'analyze-error':
        window.dispatchEvent(new CustomEvent('analyze-ws', { detail: data }));
        break;
      case 'clone-progress':
      case 'clone-complete':
      case 'clone-error':
        window.dispatchEvent(new CustomEvent('clone-ws', { detail: data }));
        break;
      case 'task_complete': {
        const taskStatus = data.status === 'done' ? 'success' : 'error';
        const taskMsg =
          data.status === 'done'
            ? `Background task completed${data.preview ? ': ' + data.preview.substring(0, 80) + '...' : ''}`
            : 'Background task failed';
        setToasts((prev) => [
          ...prev,
          {
            id: `task-${data.taskId}-${Date.now()}`,
            type: taskStatus,
            message: taskMsg,
            duration: 10000,
            onClick: data.sessionId
              ? () => {
                  setActiveSessionId(data.sessionId);
                  setCurrentView('chat');
                }
              : undefined,
          },
        ]);
        notify({
          title: data.status === 'done' ? 'Task Complete' : 'Task Failed',
          body: taskMsg,
          type: taskStatus,
        });
        window.dispatchEvent(new CustomEvent('task-complete', { detail: data }));
        break;
      }
      // ── Message queue events ────────────────────────────────────
      case 'queue_updated':
        setMessageQueues((prev) => ({
          ...prev,
          [data.sessionId]: data.queue,
        }));
        break;

      case 'queue_item_processing':
        // Mark the queued message as no longer queued (it's being processed now).
        // The 'thinking' event that follows will handle the processing indicator.
        setMessageQueues((prev) => {
          const q = (prev[data.sessionId] || []).filter((m) => m.id !== data.messageId);
          return { ...prev, [data.sessionId]: q };
        });
        break;

      case 'queue_item_edited':
        // Update the message content in local state to reflect the edit
        setMessages((prev) =>
          prev.map((m) => (m.id === data.messageId ? { ...m, content: data.content } : m)),
        );
        break;

      case 'cron_session_update':
        api
          .getCronSessions()
          .then(setCronSessions)
          .catch(() => {});
        break;

      case 'kanban_update':
        setKanbanRefreshKey((k) => k + 1);
        break;

      case 'projects_updated':
        // Server added/changed an agent or project (e.g. GitHub App auto-setup
        // seeded a Reviewer agent). Re-fetch so the sidebar reflects it
        // without requiring a page refresh.
        refreshAgents();
        break;

      case 'dispatch_failure': {
        const dispatchMsg = `Dispatch failed (${data.source}): ${data.cardTitle} — ${data.reason}`;
        const toast = {
          id: `dispatch-failure-${Date.now()}`,
          type: 'error',
          message: dispatchMsg,
          duration: 10000,
        };
        setToasts((prev) => [...prev, toast]);
        notify({ title: 'Dispatch Failure', body: dispatchMsg, type: 'error' });
        // Also refresh kanban to show the new card comment
        setKanbanRefreshKey((k) => k + 1);
        break;
      }

      // ── Ticket lifecycle notifications ─────────────────────────
      case 'card_moved': {
        const colLower = (data.columnName || '').toLowerCase();
        if (colLower === 'in progress') {
          const { title, body } = cardStartedNotification(data);
          setToasts((prev) => [
            ...prev,
            {
              id: `card-started-${data.cardId}-${Date.now()}`,
              type: 'info',
              message: body,
              duration: 8000,
            },
          ]);
          notify({ title, body, type: 'info' });
        } else if (colLower === 'review') {
          const { title, body } = cardReviewNotification(data);
          setToasts((prev) => [
            ...prev,
            {
              id: `card-review-${data.cardId}-${Date.now()}`,
              type: 'info',
              message: body,
              duration: 8000,
            },
          ]);
          notify({ title, body, type: 'info' });
        }
        break;
      }

      case 'webhook_pr_merged': {
        const { title, body } = prMergedNotification(data);
        setToasts((prev) => [
          ...prev,
          {
            id: `pr-merged-${data.prNumber}-${Date.now()}`,
            type: 'success',
            message: body,
            duration: 10000,
          },
        ]);
        notify({ title, body, type: 'success' });
        setKanbanRefreshKey((k) => k + 1);
        break;
      }

      // ── Thread notifications ─────────────────────────────────
      case 'thread_created': {
        // Live-update ThreadList if viewing threads for this project
        if (threadListRef.current && threadsProjectIdRef.current === data.projectId) {
          threadListRef.current.addThread(data.thread);
        }
        const { title, body } = threadCreatedNotification({
          threadName: data.thread.name,
          threadType: data.thread.type,
        });
        setToasts((prev) => [
          ...prev,
          {
            id: `thread-created-${data.thread.id}-${Date.now()}`,
            type: 'info',
            message: body,
            duration: 6000,
          },
        ]);
        notify({ title, body, type: 'info' });
        break;
      }

      case 'thread_entry_created': {
        const isError = data.entry?.content?.startsWith('ERROR:');
        // Live-update ThreadView if viewing this thread
        if (threadViewRef.current && activeThreadIdRef.current === data.threadId) {
          threadViewRef.current.addEntry(data.entry);
        } else {
          // Increment unread count for the project (we need to find it from data)
          // The broadcast includes threadId — look up the project via thread cache
          // For simplicity, increment for all projects that have threads view open or track globally
          setUnreadThreadCounts((prev) => {
            const pid = data.projectId;
            if (!pid) return prev;
            return { ...prev, [pid]: (prev[pid] || 0) + 1 };
          });
        }
        // Build notification — need thread name which the server should include
        const threadName = data.threadName || 'Thread';
        const threadType = data.threadType || 'cron';
        const preview = data.entry?.content?.replace(/\n+/g, ' ').trim();
        const { title, body } = threadEntryNotification({
          threadName,
          threadType,
          preview,
          isError,
        });
        // Only toast for errors or when not actively viewing the thread
        if (
          isError ||
          activeThreadIdRef.current !== data.threadId ||
          currentViewRef.current !== 'threads'
        ) {
          setToasts((prev) => [
            ...prev,
            {
              id: `thread-entry-${data.entry.id}-${Date.now()}`,
              type: isError ? 'error' : 'info',
              message: body,
              duration: isError ? 10000 : 6000,
            },
          ]);
        }
        notify({ title, body, type: isError ? 'error' : 'info' });
        break;
      }

      case 'thread_deleted': {
        // Live-update ThreadList
        if (threadListRef.current && threadsProjectIdRef.current === data.projectId) {
          threadListRef.current.removeThread(data.threadId);
        }
        // If viewing the deleted thread, go back to list
        if (activeThreadIdRef.current === data.threadId) {
          setActiveThreadId(null);
          setActiveThread(null);
        }
        break;
      }

      case 'wiki_update':
        window.dispatchEvent(new CustomEvent('wiki_update', { detail: data }));
        break;

      case 'wiki_delete':
        window.dispatchEvent(new CustomEvent('wiki_delete', { detail: data }));
        break;

      case 'lead_review':
        setActiveReviews((prev) => ({
          ...prev,
          [data.reviewerAgent]: {
            prUrl: data.prUrl,
            cardTitle: data.cardTitle,
            sessionId: data.sessionId,
          },
        }));
        break;

      case 'lead_review_complete':
        setActiveReviews((prev) => {
          const next = { ...prev };
          // Remove by matching agentId — the lead_review event uses agent name as key, but we also check by agentId
          for (const [key, val] of Object.entries(next)) {
            if (val.sessionId === data.sessionId) delete next[key];
          }
          return next;
        });
        break;

      case 'session_deleted':
        setSessions((prev) => prev.filter((s) => s.id !== data.sessionId));
        if (activeSessionIdRef.current === data.sessionId) {
          setActiveSessionId(null);
        }
        break;

      case 'handoff_start': {
        // Append the just-created handoff row to the source session's list
        // so the HandoffCard "Open session" link appears without needing a
        // refresh. Only relevant when the source session is currently open.
        if (data.sessionId === activeSessionIdRef.current) {
          setSessionHandoffs((prev) => {
            if (prev.some((h) => h.id === data.handoffId)) return prev;
            return [
              ...prev,
              {
                id: data.handoffId,
                from_session_id: data.sessionId,
                to_session_id: data.toSessionId,
                from_agent_id: data.fromAgentId,
                to_agent_id: data.toAgentId,
                note: null,
                status: 'delivered',
                error: null,
              },
            ];
          });
        }
        break;
      }

      case 'session_forwarded': {
        // A session was forwarded somewhere — if the new session belongs to
        // the currently-active agent, splice it into the sidebar list so the
        // user sees it without a refresh. The initiating client also calls
        // onForwarded directly for optimistic navigation.
        const newSession = data.session;
        if (newSession && newSession.agent_id === activeAgentIdRef.current) {
          setSessions((prev) => {
            if (prev.some((s) => s.id === newSession.id)) return prev;
            return [newSession, ...prev];
          });
        }
        break;
      }

      case 'handoff_error': {
        // Surface the failure on the source session's handoff list so the
        // UI can render a "Failed — <reason>" chip on the card instead of
        // the usual "Delivering…" placeholder.
        if (data.sessionId === activeSessionIdRef.current && data.handoffId) {
          setSessionHandoffs((prev) => {
            const existing = prev.find((h) => h.id === data.handoffId);
            if (existing) {
              return prev.map((h) =>
                h.id === data.handoffId
                  ? { ...h, status: 'failed', error: data.error || 'Handoff failed' }
                  : h,
              );
            }
            return [
              ...prev,
              {
                id: data.handoffId,
                from_session_id: data.sessionId,
                to_session_id: null,
                from_agent_id: null,
                to_agent_id: null,
                note: null,
                status: 'failed',
                error: data.error || 'Handoff failed',
              },
            ];
          });
        }
        break;
      }
    }
  }, []);

  const { send, connected, reconnecting, wsRef } = useWebSocket(handleWsMessage);

  // Called by SessionTail after it lazy-fetches historical events for a
  // legacy message. Hoists them into the shared map so subsequent renders
  // don't refetch.
  const handleEventsLoaded = useCallback((messageId, events) => {
    setEventsByMessage((prev) => {
      if (prev[messageId]) return prev; // already populated by live stream
      return { ...prev, [messageId]: events };
    });
  }, []);

  const refreshAgents = useCallback(() => {
    api.getProjects().then((data) => {
      setProjects(data);
      const flat = data.flatMap((p) =>
        p.agents.map((a) => ({
          ...a,
          projectId: p.id,
          projectName: p.name,
          cwd: p.cwd,
          ahw: p.ahw,
        })),
      );
      setAgents(flat);
    });
  }, []);

  // Migrate legacy connection config, ensure the server is pointed at the
  // active org's data directory, THEN load projects/setup status.
  // Sequential: org/switch must complete before we fetch data, otherwise
  // the server might still be pointed at the previous org.
  useEffect(() => {
    const init = async () => {
      // Step 0: Migrate legacy localStorage orgs to server, then fetch org list
      await migrateFromLegacy();
      await fetchOrgs();

      // Step 1: For local orgs, tell the local server which org's data to serve.
      const activeOrg = getActiveOrg();
      if (activeOrg && activeOrg.mode !== 'remote') {
        try {
          await fetch(`${getApiBase()}/orgs/${activeOrg.id}/switch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          });
        } catch {} // server may not support it yet
      }

      // Step 2: Check setup status
      try {
        const statusRes = await fetch(`${getApiBase()}/setup/status`, {
          headers: getAuthHeaders(),
          signal: AbortSignal.timeout(10000),
        });
        const status = await statusRes.json();
        setSetupStatus(status);
        if (status.firstRun) {
          if (!getOrgs()) {
            setShowSetup(true);
          } else {
            setShowWizard(true);
          }
        }
      } catch {} // server may not have endpoint yet

      // Step 3: Load projects (after org switch is confirmed)
      try {
        const data = await api.getProjects();
        setProjects(data);
        const flat = data.flatMap((p) =>
          p.agents.map((a) => ({
            ...a,
            projectId: p.id,
            projectName: p.name,
            cwd: p.cwd,
            ahw: p.ahw,
          })),
        );
        setAgents(flat);
        const storedId = localStorage.getItem('activeAgentId');
        const storedAgentExists = storedId && flat.some((a) => a.id === storedId);
        if (storedAgentExists) {
          setActiveAgentId(storedId);
        } else if (flat.length > 0) {
          setActiveAgentId(flat[0].id);
        }
      } catch (err) {
        console.error('[Init] Failed to load projects:', err);
      } finally {
        setInitializing(false);
      }
    };

    init();
  }, []);

  // Load sessions when agent changes
  useEffect(() => {
    if (!activeAgentId) return;
    const targetSessionId = pendingSessionIdRef.current;
    pendingSessionIdRef.current = null;

    api.getSessions(activeAgentId).then((data) => {
      setSessions(data);

      // Hydrate changesReady from persisted session data so the PR button
      // survives page refreshes and WebSocket reconnects.
      const persisted = {};
      for (const s of data) {
        if (s.changes_ready) {
          try {
            persisted[s.id] =
              typeof s.changes_ready === 'string' ? JSON.parse(s.changes_ready) : s.changes_ready;
          } catch {
            /* ignore malformed JSON */
          }
        }
      }
      if (Object.keys(persisted).length > 0) {
        setChangesReady((prev) => ({ ...prev, ...persisted }));
      }

      // If we were explicitly navigated to a specific session (e.g. from kanban
      // assign), honour that session ID instead of defaulting to the first one.
      const target = targetSessionId
        ? data.find((s) => s.id === targetSessionId) || data[0]
        : data[0];

      if (target) {
        setActiveSessionId(target.id);
        setSessionEngine(target.engine || activeAgent?.engine || 'claude-code');
        setSessionModel(target.model || 'claude-opus-4-7');
        setSessionWorktree(target.use_worktree !== 0);
        setGitWorktreeDetected(
          target.git_worktree_detected != null ? target.git_worktree_detected === 1 : null,
        );
        setSessionAskMode(target.ask_mode !== 0);
      } else {
        setActiveSessionId(null);
        setMessages([]);
        setSessionEngine(agents.find((a) => a.id === activeAgentId)?.engine || 'claude-code');
        setSessionModel('claude-opus-4-7');
        setSessionWorktree(true);
        setGitWorktreeDetected(null);
        setSessionAskMode(false);
      }
    });
  }, [activeAgentId]);

  // Load skills for slash-command autocomplete when agent changes
  useEffect(() => {
    if (!activeAgentId) {
      setSkills([]);
      return;
    }
    api
      .getSkills(activeAgentId)
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [activeAgentId]);

  // Update session engine/model when session changes
  useEffect(() => {
    if (!activeSessionId) return;
    const session = sessions.find((s) => s.id === activeSessionId);
    if (session?.engine) {
      setSessionEngine(session.engine);
    }
    if (session?.model) {
      setSessionModel(session.model);
    }
    setSessionWorktree(session?.use_worktree !== 0);
    setGitWorktreeDetected(
      session?.git_worktree_detected != null ? session.git_worktree_detected === 1 : null,
    );
    setSessionAskMode(session?.ask_mode !== 0);
  }, [activeSessionId, sessions]);

  // Load messages when session changes
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    api.getMessages(activeSessionId).then(setMessages);
  }, [activeSessionId]);

  // Load any handoffs emitted from this session so HandoffCard can resolve
  // `toSessionId` and render a clickable "Open session" link. Best-effort —
  // missing endpoint / offline must never block the chat render.
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

  // Navigate into a handoff's target session (called from HandoffCard).
  const handleOpenHandoffSession = useCallback(
    (targetAgentId, targetSessionId) => {
      if (!targetAgentId || !targetSessionId) return;
      pendingSessionIdRef.current = targetSessionId;
      setActiveAgentId(targetAgentId);
      setActiveSessionId(targetSessionId);
      setCurrentView('chat');
    },
    [setActiveAgentId],
  );

  // Rehydrate the in-Hub ProgressPanel for the active session whenever the
  // session changes. Skip if we already have live steps in memory (avoid
  // clobbering in-flight state on a quick tab-toggle).
  useEffect(() => {
    if (!activeSessionId) return;
    if ((sessionProgress[activeSessionId] || []).length > 0) return;
    let cancelled = false;
    api
      .getSessionProgress(activeSessionId)
      .then((res) => {
        if (cancelled || !res || !Array.isArray(res.steps)) return;
        if (res.steps.length === 0) return;
        setSessionProgress((prev) => ({ ...prev, [activeSessionId]: res.steps }));
      })
      .catch(() => {
        /* best-effort — missing endpoint / offline should not break chat */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  // When the user switches sessions, rehydrate streaming state from the
  // in-memory active-tasks map so an in-flight task on another session becomes
  // visible as soon as you click into it.
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

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ctrl+K: agent switcher
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setShowSwitcher((prev) => !prev);
      }
      // Escape: cancel generation or close switcher
      if (e.key === 'Escape') {
        if (showSwitcher) {
          setShowSwitcher(false);
        } else if (thinking || streamingContent) {
          handleCancel();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showSwitcher, thinking, streamingContent]);

  // ─── Room data loading ───────────────────────────────────
  const refreshRooms = useCallback(() => {
    api.getRooms().then(setRooms).catch(console.error);
  }, []);

  // Load rooms on mount
  useEffect(() => {
    refreshRooms();
  }, [refreshRooms]);

  // ─── Cron sessions (scheduled tasks) ───────────────────
  const refreshCronSessions = useCallback(() => {
    api
      .getCronSessions()
      .then(setCronSessions)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshCronSessions();
  }, [refreshCronSessions]);

  // Load room messages when active room changes
  useEffect(() => {
    if (!activeRoomId) {
      setRoomMessages([]);
      setRoomQueueLength(0);
      setRoomProcessing(false);
      return;
    }
    api.getRoomMessages(activeRoomId).then(setRoomMessages).catch(console.error);
  }, [activeRoomId]);

  const handleNewRoom = async (name) => {
    if (!name?.trim()) return;
    const room = await api.createRoom(name.trim());
    setRooms((prev) => [room, ...prev]);
    setActiveRoomId(room.id);
    setCurrentView('room');
  };

  const handleDeleteRoom = async (roomId) => {
    await api.deleteRoom(roomId);
    setRooms((prev) => prev.filter((r) => r.id !== roomId));
    if (activeRoomId === roomId) {
      setActiveRoomId(null);
      setCurrentView('chat');
    }
  };

  const handleRoomUpdated = useCallback(() => {
    refreshRooms();
    // Also refresh the active room's detail
    if (activeRoomIdRef.current) {
      api.getRoom(activeRoomIdRef.current).then((room) => {
        setRooms((prev) => prev.map((r) => (r.id === room.id ? room : r)));
      });
    }
  }, [refreshRooms]);

  const activeRoom = rooms.find((r) => r.id === activeRoomId);

  // ─── Designs data loading ───────────────────────────────────
  const refreshDesigns = useCallback(() => {
    api.getDesigns().then(setDesigns).catch(console.error);
  }, []);

  useEffect(() => {
    refreshDesigns();
  }, [refreshDesigns]);

  // Load full design detail + messages when the active design changes.
  useEffect(() => {
    if (!activeDesignId) {
      setDesignMessages([]);
      setDesignStreaming(null);
      setDesignThinking(false);
      setDesignProcessing(false);
      return;
    }
    // Reset streaming UI state optimistically — the status probe below will
    // restore it if a turn is actually in flight for this design.
    setDesignStreaming(null);
    setDesignThinking(false);
    setDesignProcessing(false);
    // Reset the iframe cache-buster for a fresh design — ensures we don't
    // reuse a stale frame from the previous design.
    setDesignReloadToken((t) => t + 1);
    const designId = activeDesignId;
    api
      .getDesign(designId)
      .then((detail) => {
        if (!detail) return;
        setDesigns((prev) => {
          const existing = prev.find((d) => d.id === detail.id);
          return existing ? prev.map((d) => (d.id === detail.id ? { ...d, ...detail } : d)) : prev;
        });
      })
      .catch(console.error);
    api.getDesignMessages(designId).then(setDesignMessages).catch(console.error);
    // Probe the server for an in-flight turn. If one is running, restore the
    // thinking/streaming indicators so re-entering a design mid-turn doesn't
    // show a silent UI. Guard against races: if the user switched designs
    // again before the probe resolved, drop the result.
    api
      .getDesignStatus(designId)
      .then((status) => {
        if (!status || activeDesignIdRef.current !== designId) return;
        if (!status.inFlight) return;
        setDesignProcessing(true);
        if (status.streaming) {
          setDesignThinking(false);
          setDesignStreaming({ content: status.streaming });
        } else {
          setDesignThinking(true);
        }
      })
      .catch(console.error);
  }, [activeDesignId]);

  const activeDesign = designs.find((d) => d.id === activeDesignId);

  const handleNewSession = async () => {
    if (!activeAgentId) return;
    const session = await api.createSession(activeAgentId, undefined, { askMode: sessionAskMode });
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    setSessionEngine(session.engine || activeAgent?.engine || 'claude-code');
    setSessionModel(session.model || 'claude-opus-4-7');
    setSessionWorktree(session.use_worktree !== 0);
    setGitWorktreeDetected(null); // New session, not yet detected
    setSessionAskMode(session.ask_mode !== 0);
    setMessages([]);
    setCurrentView('chat');
  };

  const ENGINE_DEFAULT_MODELS = {
    'claude-code': 'claude-opus-4-7',
    'gemini-cli': 'gemini-2.5-pro',
  };

  const handleEngineChange = async (engine) => {
    setSessionEngine(engine);
    const defaultModel = ENGINE_DEFAULT_MODELS[engine] || 'claude-opus-4-7';
    setSessionModel(defaultModel);
    if (activeSessionId) {
      const updated = await api.setSessionEngine(activeSessionId, engine);
      setSessions((prev) =>
        prev.map((s) => (s.id === updated.id ? { ...s, engine: updated.engine } : s)),
      );
      const modelUpdated = await api.setSessionModel(activeSessionId, defaultModel);
      setSessions((prev) =>
        prev.map((s) => (s.id === modelUpdated.id ? { ...s, model: modelUpdated.model } : s)),
      );
    }
  };

  const handleModelChange = async (model) => {
    setSessionModel(model);
    if (activeSessionId) {
      const updated = await api.setSessionModel(activeSessionId, model);
      setSessions((prev) =>
        prev.map((s) => (s.id === updated.id ? { ...s, model: updated.model } : s)),
      );
    }
  };

  const handleWorktreeChange = async (enabled) => {
    setSessionWorktree(enabled);
    if (activeSessionId) {
      const updated = await api.setSessionWorktree(activeSessionId, enabled);
      setSessions((prev) =>
        prev.map((s) => (s.id === updated.id ? { ...s, use_worktree: updated.use_worktree } : s)),
      );
    }
  };

  const handleAskModeChange = async (enabled) => {
    setSessionAskMode(enabled);
    if (activeSessionId) {
      const updated = await api.setSessionAskMode(activeSessionId, enabled);
      setSessions((prev) =>
        prev.map((s) => (s.id === updated.id ? { ...s, ask_mode: updated.ask_mode } : s)),
      );
    }
  };

  const handleDeleteSession = async (sessionId) => {
    setDeletingSessionIds((prev) => new Set(prev).add(sessionId));
    try {
      await api.deleteSession(sessionId);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (activeSessionId === sessionId) {
        const remaining = sessions.filter((s) => s.id !== sessionId);
        setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
      }
    } finally {
      setDeletingSessionIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  };

  const handleClearAllSessions = async () => {
    if (!activeAgentId) return;
    setDeletingBulk('all');
    try {
      const result = await api.clearAllSessions(activeAgentId);
      if (result.ok) {
        setSessions([]);
        setActiveSessionId(null);
      }
    } finally {
      setDeletingBulk(null);
    }
  };

  const handleClearInactiveSessions = async () => {
    if (!activeAgentId) return;
    setDeletingBulk('inactive');
    try {
      const activeIds = new Set(Object.keys(activeTasks));
      const result = await api.clearInactiveSessions(activeAgentId);
      if (result.ok) {
        // Keep only sessions that had active tasks (server skipped them)
        setSessions((prev) => prev.filter((s) => activeIds.has(s.id)));
        if (activeSessionId && !activeIds.has(activeSessionId)) {
          const remaining = sessions.filter((s) => activeIds.has(s.id));
          setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
        }
      }
    } finally {
      setDeletingBulk(null);
    }
  };

  const handleRenameSession = async (sessionId, newName) => {
    await api.renameSession(sessionId, newName);
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, name: newName } : s)));
  };

  const handleCancel = () => {
    if (activeSessionId) {
      send({ type: 'cancel', sessionId: activeSessionId });
      setThinking(false);
      setStreamingContent('');
      setStreamingMsgId(null);
    }
  };

  const handleDequeue = (messageId) => {
    if (activeSessionId) {
      send({ type: 'dequeue', sessionId: activeSessionId, messageId });
      // Optimistically remove from local messages
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
    }
  };

  const handleEditQueuedMessage = (messageId, content) => {
    if (activeSessionId) {
      send({ type: 'edit_queue_item', sessionId: activeSessionId, messageId, content });
      // Optimistically update local message content
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, content } : m)));
    }
  };

  // Handle submission from an <AskUserQuestion> picker. We dispatch the
  // pre-formatted chat message (which already contains the agenthub:ask:answer
  // fenced block) and mark the askId as submitted so the picker flips to a
  // disabled "Submitted" state immediately. Once the user message persists to
  // history, `askSubmittedFromHistory` below picks the id up from the
  // fenced-block scan and the optimistic set becomes redundant — but the
  // union in `askSubmitted` makes the brief overlap seamless.
  const handleAskSubmit = (askId, messageText) => {
    if (askSubmitted.has(askId)) return;
    setAskSubmittedOptimistic((prev) => {
      const next = new Set(prev);
      next.add(askId);
      return next;
    });
    handleSend(messageText);
  };

  const handleSend = async (content, images = [], { interrupt = false } = {}) => {
    let sessionId = activeSessionId;
    if (!sessionId) {
      const session = await api.createSession(activeAgentId, undefined, {
        askMode: sessionAskMode,
      });
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
      sessionId = session.id;
    }

    // Upload media (images + videos) first, then send chat with references.
    //
    // If any upload fails (e.g. a video over the 100 MB server limit, or a
    // transient network error), surface the reason to the user via toast and
    // abort the send — previously we swallowed the error and sent the text
    // alone, which is exactly how users reported "videos don't go through in
    // chat" (the text arrives, the video doesn't, the user has no idea why).
    let uploadedImages = [];
    if (images.length > 0) {
      try {
        uploadedImages = await Promise.all(
          images.map((img) => {
            if ((img.type === 'video' || img.type === 'file') && img.file) {
              return api.uploadFile(img.file);
            }
            return api.uploadImage(img.dataUrl, img.name);
          }),
        );
      } catch (err) {
        console.error('Media upload failed:', err);
        const reason = err?.message || 'Unknown error';
        showToast(
          `Attachment upload failed: ${reason}. Your message was not sent — please retry or remove the attachment.`,
          'error',
          8000,
        );
        return;
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
  };

  const isProcessing = thinking || !!streamingContent;

  // ─── Global keyboard shortcut actions ───────────────────────
  // Resolve the "current project" for navigation shortcuts: prefer the
  // project currently displayed (kanban/wiki/etc.) and fall back to the
  // project owning the active agent, then the first project.
  const currentProjectId = useMemo(() => {
    if (currentView.startsWith('kanban:')) return currentView.split(':')[1];
    if (currentView === 'wiki' && wikiProjectId) return wikiProjectId;
    if (currentView === 'notes' && notesProjectId) return notesProjectId;
    if (currentView === 'captures' && capturesProjectId) return capturesProjectId;
    if (currentView === 'pulls' && pullsProjectId) return pullsProjectId;
    if (currentView === 'threads' && threadsProjectId) return threadsProjectId;
    const byAgent = projects.find((p) => p.agents?.some((a) => a.id === activeAgentId));
    return byAgent?.id || projects[0]?.id || null;
  }, [
    currentView,
    wikiProjectId,
    notesProjectId,
    capturesProjectId,
    pullsProjectId,
    threadsProjectId,
    projects,
    activeAgentId,
  ]);

  // Build the handler map inline — useKeyboardShortcuts reads the latest map
  // via a ref, so rebuilding on every render is cheap and avoids stale closures.
  const goToNextProject = () => {
    if (!projects.length) return;
    const idx = Math.max(
      projects.findIndex((p) => p.id === currentProjectId),
      0,
    );
    const next = projects[(idx + 1) % projects.length];
    if (!next) return;
    const firstAgent = next.agents?.[0];
    if (firstAgent) setActiveAgentId(firstAgent.id);
    setCurrentView(`kanban:${next.id}`);
  };
  const goToBoard = () => {
    if (currentProjectId) setCurrentView(`kanban:${currentProjectId}`);
  };
  const goToWiki = () => {
    if (!currentProjectId) return;
    setWikiProjectId(currentProjectId);
    setCurrentView('wiki');
  };
  const newConferenceRoom = () => {
    // MVP: prompt for name. A richer inline picker is tracked separately.
    const name =
      typeof window !== 'undefined' && typeof window.prompt === 'function'
        ? window.prompt('Conference room name')
        : null;
    if (name && name.trim()) handleNewRoom(name.trim());
  };

  useKeyboardShortcuts({
    handlers: {
      'new-session': () => handleNewSession(),
      'new-ticket-chat': () => {
        // MVP: open the board for the current project + start a fresh session.
        // Future: prefill the session with a link to the selected ticket.
        handleNewSession();
        if (currentProjectId) setCurrentView(`kanban:${currentProjectId}`);
      },
      'new-doc-chat': () => {
        handleNewSession();
        goToWiki();
      },
      'new-conference-room': newConferenceRoom,
      'go-to-board': goToBoard,
      'go-to-wiki': goToWiki,
      'go-to-skills': () => setCurrentView('skills'),
      'go-to-settings': () => setCurrentView('settings'),
      'go-to-next-project': goToNextProject,
      'show-help': () => setShowShortcutsHelp(true),
    },
    enabled: !showShortcutsHelp,
  });

  const isElectron = !!window.electronAPI?.isElectron;
  const isMac = window.electronAPI?.platform === 'darwin';

  // Version-check for the "update available" modal. We fetch /api/health once
  // on mount to learn the server's version, then compare against the client
  // bundle's VITE_APP_VERSION inside useVersionCheck. Electron-only; a no-op
  // in the web client (the hook gates itself on window.electronAPI.isElectron).
  const [healthServerVersion, setHealthServerVersion] = useState(null);
  useEffect(() => {
    if (!isElectron) return; // skip the fetch entirely in the browser
    const base = getServerBase();
    fetch(`${base}/api/health`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.version) setHealthServerVersion(data.version);
      })
      .catch(() => {
        /* offline / unreachable — no prompt, no error */
      });
  }, [isElectron]);
  const versionCheck = useVersionCheck({ serverVersion: healthServerVersion });

  // Show loading spinner while connecting to the server and loading org data.
  // Includes an org switcher so users can escape a dead remote org.
  if (initializing) {
    const activeOrg = getActiveOrg();
    const allOrgState = getOrgs();
    const allOrgsList = allOrgState?.orgs || [];
    return (
      <div className="flex flex-col h-screen bg-gray-950 text-gray-100 items-center justify-center gap-4">
        <Loader2 size={32} className="animate-spin text-indigo-400" />
        <div className="text-center">
          <p className="text-sm text-gray-400">Connecting to server...</p>
          {activeOrg && (
            <p className="text-xs text-gray-600 mt-1">
              {activeOrg.name}
              {activeOrg.mode === 'remote' ? ' (remote)' : ''}
            </p>
          )}
        </div>
        {allOrgsList.length > 1 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {allOrgsList
              .filter((o) => o.id !== activeOrg?.id)
              .map((org) => (
                <button
                  key={org.id}
                  onClick={async () => {
                    const { switchOrg } = await import('./utils/orgs.js');
                    const { reloadForOrgSwitch } = await import('./utils/connection.js');
                    await switchOrg(org.id);
                    reloadForOrgSwitch();
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-400 bg-gray-800/50 hover:bg-gray-800 rounded-lg border border-gray-700/50 transition-colors"
                >
                  <ArrowLeftRight size={12} />
                  {org.name}
                </button>
              ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100">
      {/* "Update available" modal — rendered at the top level so it floats
          above the sidebar and main content. Only shows when the Electron
          client is older than the server it's connected to. */}
      {versionCheck.updateAvailable && (
        <UpdateAvailableModal
          serverVersion={versionCheck.serverVersion}
          clientVersion={versionCheck.clientVersion}
          downloadUrl={versionCheck.downloadUrl}
          onDismiss={versionCheck.dismiss}
        />
      )}

      {/* Electron title bar — draggable region for window movement */}
      {isElectron && (
        <div
          className="electron-drag flex-shrink-0 bg-gray-900 border-b border-gray-800 flex items-center justify-center relative"
          style={{ height: isMac ? 38 : 32 }}
        >
          {/* Spacer for macOS traffic lights (left side) */}
          {isMac && <div style={{ width: 78 }} />}
          <span className="text-xs text-gray-500 font-medium select-none flex-1 text-center">
            Agent Hub
          </span>
          {isMac && <div style={{ width: 78 }} />}
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* Mobile sidebar overlay */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 bg-black/50 z-40 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar */}
        <div
          className={`fixed md:relative z-50 md:z-auto transition-transform duration-200 ${
            sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
          }`}
        >
          <Sidebar
            projects={projects}
            agents={agents}
            activeAgentId={activeAgentId}
            onSelectAgent={(id) => {
              setActiveAgentId(id);
              setSidebarOpen(false);
            }}
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelectSession={(id) => {
              setActiveSessionId(id);
              setActiveRoomId(null);
              setSidebarOpen(false);
            }}
            onNewSession={handleNewSession}
            onDeleteSession={handleDeleteSession}
            onClearAllSessions={handleClearAllSessions}
            onClearInactiveSessions={handleClearInactiveSessions}
            deletingSessionIds={deletingSessionIds}
            deletingBulk={deletingBulk}
            onRenameSession={handleRenameSession}
            onNavigate={(view, extra) => {
              setCurrentView(view);
              if (view === 'wiki' && extra) setWikiProjectId(extra);
              if (view === 'notes' && extra) setNotesProjectId(extra);
              if (view === 'captures' && extra) setCapturesProjectId(extra);
              if (view === 'pulls' && extra) setPullsProjectId(extra);
              if (view === 'design' && extra) setActiveDesignId(extra);
              if (view === 'designs') {
                // Opening the list view shouldn't clobber the last-opened design
                // context, but we do clear any in-progress transient state.
                setDesignStreaming(null);
                setDesignThinking(false);
              }
              if (view === 'threads' && extra) {
                setThreadsProjectId(extra);
                setActiveThreadId(null);
                setActiveThread(null);
                // Clear unread count when opening threads view
                setUnreadThreadCounts((prev) => {
                  if (!prev[extra]) return prev;
                  const next = { ...prev };
                  delete next[extra];
                  return next;
                });
              }
              setSidebarOpen(false);
            }}
            currentView={currentView}
            activeTaskSessionIds={activeTasks}
            subagentsBySession={subagents}
            changesReadyBySession={changesReady}
            rooms={rooms}
            activeRoomId={activeRoomId}
            onSelectRoom={(id) => {
              setActiveRoomId(id);
              setActiveSessionId(null);
              setSidebarOpen(false);
            }}
            onNewRoom={handleNewRoom}
            onDeleteRoom={handleDeleteRoom}
            onOpenProject={() => setShowWizard(true)}
            cronSessions={cronSessions}
            wikiProjectId={wikiProjectId}
            notesProjectId={notesProjectId}
            threadsProjectId={threadsProjectId}
            capturesProjectId={capturesProjectId}
            pullsProjectId={pullsProjectId}
            unreadThreadCounts={unreadThreadCounts}
            activeReviews={activeReviews}
            designs={designs}
            activeDesignId={activeDesignId}
            onSelectDesign={(id) => {
              setActiveDesignId(id);
              setActiveSessionId(null);
              setActiveRoomId(null);
              setSidebarOpen(false);
            }}
          />
        </div>

        <div className="flex-1 flex flex-col min-w-0">
          {/* Top bar */}
          <TopBar
            agent={activeAgent}
            connected={connected}
            reconnecting={reconnecting}
            onNewSession={handleNewSession}
            onNavigate={setCurrentView}
            onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
            sessionEngine={sessionEngine}
            onEngineChange={handleEngineChange}
            sessionModel={sessionModel}
            onModelChange={handleModelChange}
            messages={messages}
            activeSessionId={activeSessionId}
            sessionWorktree={sessionWorktree}
            gitWorktreeDetected={gitWorktreeDetected}
            onWorktreeChange={handleWorktreeChange}
            sessionAskMode={sessionAskMode}
            onAskModeChange={handleAskModeChange}
            verboseMode={verboseMode}
            onVerboseModeChange={handleVerboseModeChange}
            projectId={
              currentView.startsWith('kanban:')
                ? currentView.split(':')[1]
                : projects.find((p) => p.agents?.some((a) => a.id === activeAgentId))?.id
            }
            showToast={showToast}
            onOpenForward={() => setShowForward(true)}
            canForward={!!activeSessionId && filterForwardTargets(agents, activeAgent).length > 0}
          />

          {currentView.startsWith('kanban:') ? (
            <KanbanBoard
              projectId={currentView.split(':')[1]}
              project={projects.find((p) => p.id === currentView.split(':')[1])}
              agents={agents}
              refreshKey={kanbanRefreshKey}
              onNavigateToSession={(agentId, sessionId) => {
                pendingSessionIdRef.current = sessionId;
                setActiveAgentId(agentId);
                setActiveSessionId(sessionId);
                setCurrentView('chat');
              }}
            />
          ) : currentView.startsWith('settings') ? (
            <SettingsPage
              projects={projects}
              agents={agents}
              onAgentsChange={refreshAgents}
              initialTab={currentView.includes(':') ? currentView.split(':')[1] : undefined}
              onNavigate={(view, extra) => {
                setCurrentView(view);
                if (view === 'threads' && extra) {
                  setThreadsProjectId(extra.projectId);
                  if (extra.threadId) {
                    setActiveThreadId(extra.threadId);
                    setActiveThread(extra.thread || null);
                  } else {
                    setActiveThreadId(null);
                    setActiveThread(null);
                  }
                }
              }}
              showToast={showToast}
              wsRef={wsRef}
            />
          ) : currentView === 'wiki' && wikiProjectId ? (
            <WikiBrowser projectId={wikiProjectId} apiBase={getApiBase()} />
          ) : currentView === 'notes' && notesProjectId ? (
            <NotesEditor projectId={notesProjectId} />
          ) : currentView === 'threads' && threadsProjectId ? (
            activeThreadId ? (
              <ThreadView
                ref={threadViewRef}
                key={activeThreadId}
                threadId={activeThreadId}
                thread={activeThread}
                onBack={() => {
                  setActiveThreadId(null);
                  setActiveThread(null);
                }}
              />
            ) : (
              <ThreadList
                ref={threadListRef}
                projectId={threadsProjectId}
                onSelectThread={(thread) => {
                  setActiveThreadId(thread.id);
                  setActiveThread(thread);
                }}
              />
            )
          ) : currentView === 'captures' && capturesProjectId ? (
            <CapturesPage projectId={capturesProjectId} />
          ) : currentView === 'pulls' && pullsProjectId ? (
            <PullRequestsPage
              projectId={pullsProjectId}
              project={projects.find((p) => p.id === pullsProjectId)}
              onOpenSession={handleOpenHandoffSession}
              onToast={showToast}
            />
          ) : currentView === 'dashboard' ? (
            <DashboardView orgId={getActiveOrgApiId()} />
          ) : currentView === 'skills' ? (
            <SkillsPage agents={agents} projects={projects} />
          ) : currentView === 'room' && activeRoom ? (
            <RoomChat
              room={activeRoom}
              agents={agents}
              send={send}
              roomMessages={roomMessages}
              roomStreaming={roomStreaming}
              roomThinking={roomThinking}
              roomProcessing={roomProcessing}
              roomQueueLength={roomQueueLength}
              onRoomUpdated={handleRoomUpdated}
            />
          ) : currentView === 'designs' ? (
            <DesignsList
              designs={designs}
              projects={projects}
              onNavigate={(view, extra) => {
                setCurrentView(view);
                if (view === 'design' && extra) setActiveDesignId(extra);
              }}
              onChanged={refreshDesigns}
            />
          ) : currentView === 'design' && activeDesign ? (
            <DesignView
              design={activeDesign}
              messages={designMessages}
              streaming={designStreaming}
              thinking={designThinking}
              processing={designProcessing}
              reloadToken={designReloadToken}
              send={send}
              onBack={() => setCurrentView('designs')}
              onManualReload={() => setDesignReloadToken((t) => t + 1)}
            />
          ) : (
            <>
              {/* Messages */}
              <div
                ref={scrollContainerRef}
                onScroll={handleScrollEvent}
                className="flex-1 overflow-y-auto p-3 md:p-6 relative"
              >
                <div className="mx-auto">
                  {/* Cursor-style timed checklist — rendered at top of chat
                      whenever the session has emitted `[[STEP:...]]` markers.
                      Collapses automatically once all steps resolve. */}
                  {(sessionProgress[activeSessionId] || []).length > 0 && (
                    <div className="px-3 md:px-0 mb-3 max-w-[95%] sm:max-w-[90%] mx-auto">
                      <ProgressPanel
                        steps={sessionProgress[activeSessionId]}
                        sessionRunning={Boolean(streamingMsgId || activeTasks[activeSessionId])}
                      />
                    </div>
                  )}
                  {messages.length === 0 && !thinking && !streamingContent && (
                    <div className="flex flex-col items-center justify-center h-full text-gray-600 py-20">
                      <MessageCircle size={48} className="mb-4 text-gray-600" />
                      <p className="text-lg">Start a conversation</p>
                      {activeAgent && <p className="text-sm mt-1">with {activeAgent.name}</p>}
                      <p className="text-xs text-gray-700 mt-4 hidden sm:block">
                        Ctrl+K to switch agents · Esc to cancel
                      </p>
                    </div>
                  )}
                  {(() => {
                    const queuedIds = new Set(
                      (messageQueues[activeSessionId] || []).map((q) => q.id),
                    );
                    // Render non-queued messages inline, queued messages stick to bottom
                    const nonQueued = messages.filter((msg) => !queuedIds.has(msg.id));
                    const queued = messages.filter((msg) => queuedIds.has(msg.id));
                    return (
                      <>
                        {nonQueued.map((msg) =>
                          msg.role === 'assistant' ? (
                            <SessionTail
                              key={msg.id}
                              message={msg}
                              events={eventsByMessage[msg.id]}
                              agentColor={activeAgent?.color}
                              onEventsLoaded={handleEventsLoaded}
                              verboseMode={verboseMode}
                              onAskSubmit={handleAskSubmit}
                              askSubmittedIds={askSubmitted}
                              fromAgent={activeAgent}
                              agents={agents}
                              sessionHandoffs={sessionHandoffs}
                              sessionDelegations={delegations[activeSessionId]}
                              onOpenSession={handleOpenHandoffSession}
                            />
                          ) : (
                            <ChatMessage
                              key={msg.id}
                              message={msg}
                              agentColor={activeAgent?.color}
                            />
                          ),
                        )}
                        {thinking && !streamingMsgId && (
                          <ThinkingIndicator agentColor={activeAgent?.color} />
                        )}
                        {streamingMsgId && (
                          <SessionTail
                            key={streamingMsgId}
                            message={{
                              id: streamingMsgId,
                              role: 'assistant',
                              engine: streamingEngine,
                              model: sessionModel,
                              content: streamingContent,
                            }}
                            events={eventsByMessage[streamingMsgId]}
                            agentColor={activeAgent?.color}
                            streaming
                            verboseMode={verboseMode}
                            onAskSubmit={handleAskSubmit}
                            askSubmittedIds={askSubmitted}
                            fromAgent={activeAgent}
                            agents={agents}
                            sessionHandoffs={sessionHandoffs}
                            sessionDelegations={delegations[activeSessionId]}
                            onOpenSession={handleOpenHandoffSession}
                          />
                        )}
                        {/* Delegation panel — shows when a lead agent delegates to sub-agents */}
                        {delegations[activeSessionId] &&
                          delegations[activeSessionId].tasks.length > 0 && (
                            <div className="px-4 max-w-[95%] sm:max-w-[90%]">
                              <DelegationPanel
                                delegations={delegations[activeSessionId].tasks}
                                sessionId={activeSessionId}
                                throttled={throttle[activeSessionId]?.active}
                                onCancel={(sid) =>
                                  send({ type: 'delegation_cancel', sessionId: sid })
                                }
                              />
                            </div>
                          )}
                        {/* Ad-hoc PR creation prompt — shown when agent finishes work with uncommitted changes */}
                        {changesReady[activeSessionId] && !streamingMsgId && (
                          <ChangesReadyBox
                            sessionId={activeSessionId}
                            changes={changesReady[activeSessionId]}
                            defaultAutoMerge={
                              projects.find((p) => p.id === activeAgent?.projectId)?.githubWorkflow
                                ?.autoMerge ?? false
                            }
                            onCreated={(sessionId, result) => {
                              setChangesReady((prev) => {
                                const next = { ...prev };
                                delete next[sessionId];
                                return next;
                              });
                              setToasts((prev) => [
                                ...prev,
                                {
                                  id: `pr-created-${Date.now()}`,
                                  type: 'success',
                                  message: `PR created: ${result.prUrl}`,
                                  duration: 8000,
                                },
                              ]);
                            }}
                            onDismiss={(sessionId) => {
                              setChangesReady((prev) => {
                                const next = { ...prev };
                                delete next[sessionId];
                                return next;
                              });
                            }}
                          />
                        )}
                        {/* Queued messages always render at the very bottom */}
                        {queued.map((msg) => (
                          <ChatMessage
                            key={msg.id}
                            message={{ ...msg, queued: true }}
                            agentColor={activeAgent?.color}
                            onDequeue={handleDequeue}
                            onEditQueued={handleEditQueuedMessage}
                          />
                        ))}
                      </>
                    );
                  })()}
                  <div ref={messagesEndRef} />
                </div>

                {/* Scroll to bottom button */}
                {showScrollBtn && (
                  <button
                    onClick={() => scrollToBottom(false)}
                    className="sticky bottom-4 left-1/2 -translate-x-1/2 mx-auto flex items-center gap-1.5 bg-gray-800/90 hover:bg-gray-700 border border-gray-600/50 text-gray-300 text-xs px-3 py-2 rounded-full shadow-lg backdrop-blur-sm transition-all hover:text-white z-10"
                    style={{ width: 'fit-content', display: 'flex' }}
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M19 14l-7 7m0 0l-7-7m7 7V3"
                      />
                    </svg>
                    Scroll to bottom
                  </button>
                )}
              </div>

              {/* Input */}
              <MessageInput
                onSend={handleSend}
                onCancel={handleCancel}
                disabled={!activeAgentId || !connected}
                isProcessing={isProcessing}
                queueLength={(messageQueues[activeSessionId] || []).length}
                agentColor={activeAgent?.color}
                skills={skills}
                askMode={sessionAskMode}
                draftKey={activeSessionId || activeAgentId || 'none'}
                onFileError={(msg) => showToast(msg, 'error', 6000)}
              />
            </>
          )}
        </div>

        {/* Keyboard shortcuts help */}
        <ShortcutsHelpModal
          isOpen={showShortcutsHelp}
          onClose={() => setShowShortcutsHelp(false)}
        />

        {/* Agent Switcher Modal */}
        {showSwitcher && (
          <AgentSwitcher
            agents={agents}
            onSelect={(id) => {
              setActiveAgentId(id);
              setCurrentView('chat');
            }}
            onClose={() => setShowSwitcher(false)}
          />
        )}

        {/* Forward Session Modal */}
        {showForward && activeSessionId && activeAgent && (
          <ForwardSessionModal
            sourceAgent={activeAgent}
            agents={agents}
            sessionId={activeSessionId}
            onClose={() => setShowForward(false)}
            onForward={({ targetAgentId, prompt, autoStart }) =>
              api.forwardSession(activeSessionId, { targetAgentId, prompt, autoStart })
            }
            onForwarded={(result) => {
              const session = result?.session;
              if (!session) return;
              // Optimistically navigate into the new session (mirrors the
              // handoff open-target pattern in `handleOpenHandoffSession`).
              pendingSessionIdRef.current = session.id;
              setActiveAgentId(session.agent_id);
              setActiveSessionId(session.id);
              setCurrentView('chat');
              showToast(`Forwarded to ${session.name || 'new session'}`, 'success', 4000);
            }}
            onError={(msg) => showToast(`Forward failed: ${msg}`, 'error', 6000)}
          />
        )}

        {/* First-run setup wizard */}
        {showSetup && setupStatus && (
          <SetupWizard
            setupStatus={setupStatus}
            onComplete={() => {
              setShowSetup(false);
              setShowWizard(true); // immediately open the Open Project wizard
            }}
          />
        )}

        {/* Open Project wizard */}
        {showWizard && (
          <OpenProjectWizard
            onClose={() => setShowWizard(false)}
            onProjectCreated={() => {
              setShowWizard(false);
              refreshAgents();
            }}
          />
        )}

        {/* Toast notifications */}
        {toasts.length > 0 && (
          <div className="fixed top-4 right-4 z-[60] flex flex-col gap-2 max-w-sm">
            {toasts.map((toast) => (
              <Toast
                key={toast.id}
                toast={toast}
                onDismiss={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
              />
            ))}
          </div>
        )}
      </div>
      {/* close flex row wrapper */}
    </div>
  );
}

function Toast({ toast, onDismiss }) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (toast.duration) {
      const timer = setTimeout(() => onDismissRef.current(), toast.duration);
      return () => clearTimeout(timer);
    }
  }, [toast.duration]);

  const colors = {
    info: 'bg-blue-900/90 border-blue-700 text-blue-100',
    success: 'bg-emerald-900/90 border-emerald-700 text-emerald-100',
    error: 'bg-red-900/90 border-red-700 text-red-100',
  };
  const icons = {
    info: <Info size={18} />,
    success: <CheckCircle size={18} />,
    error: <AlertTriangle size={18} />,
  };

  return (
    <div
      className={`${colors[toast.type] || colors.info} border rounded-lg px-4 py-3 shadow-lg backdrop-blur-sm flex items-start gap-2.5 animate-slide-in`}
    >
      <span className="flex-shrink-0">{icons[toast.type] || <Info size={18} />}</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{toast.message}</p>
        {toast.onClick && (
          <button
            onClick={() => {
              toast.onClick();
              onDismiss();
            }}
            className="text-xs underline opacity-75 hover:opacity-100 mt-0.5"
          >
            View session →
          </button>
        )}
      </div>
      <button
        onClick={onDismiss}
        className="text-current opacity-50 hover:opacity-100 flex-shrink-0 text-lg leading-none"
      >
        &times;
      </button>
    </div>
  );
}
