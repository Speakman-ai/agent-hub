import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import Sidebar from './components/Sidebar.jsx';
import TopBar from './components/TopBar.jsx';
import ChatMessage from './components/ChatMessage.jsx';
import ThinkingIndicator from './components/ThinkingIndicator.jsx';
import SessionTail from './components/SessionTail.jsx';
import MessageInput from './components/MessageInput.jsx';
import AgentSwitcher from './components/AgentSwitcher.jsx';
import SettingsPage from './components/SettingsPage.jsx';
import SkillsPage from './components/SkillsPage.jsx';
import RoomChat from './components/RoomChat.jsx';
import DelegationPanel from './components/DelegationPanel.jsx';
import OpenProjectWizard from './components/OpenProjectWizard.jsx';
import SetupWizard from './components/SetupWizard.jsx';
import KanbanBoard from './components/KanbanBoard.jsx';
import WikiBrowser from './components/WikiBrowser.jsx';
import { useWebSocket } from './hooks/useWebSocket.js';
import { api } from './utils/api.js';
import {
  MessageCircle,
  Info,
  CheckCircle,
  AlertTriangle,
  Loader2,
  ArrowLeftRight,
} from 'lucide-react';
import { migrateFromLegacy, fetchOrgs, getActiveOrg, getOrgs } from './utils/orgs.js';
import { getApiBase, getAuthHeaders } from './utils/connection.js';

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
  const [thinking, setThinking] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingMsgId, setStreamingMsgId] = useState(null);
  const [streamingEngine, setStreamingEngine] = useState(null);
  const [sessionEngine, setSessionEngine] = useState('claude-code');
  const [sessionModel, setSessionModel] = useState('claude-opus-4-6');
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
  // Delegation state: Map of sessionId -> { parentMessageId, tasks: [{delegationId, agentId, agentName, agentColor, task, status, content, output, error}] }
  const [delegations, setDelegations] = useState({});
  // Rate-limit throttle state: Map of sessionId -> { active, retryAfterMs, clearedAt }
  const [throttle, setThrottle] = useState({});
  // Subagent tracking: Map of sessionId -> { total, running, done, errored }
  const [subagents, setSubagents] = useState({});
  // Wiki state
  const [wikiProjectId, setWikiProjectId] = useState(null);
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
  // Kanban board refresh trigger
  const [kanbanRefreshKey, setKanbanRefreshKey] = useState(0);
  const activeRoomIdRef = useRef(activeRoomId);
  activeRoomIdRef.current = activeRoomId;

  const messagesEndRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  // Track when a session was explicitly navigated to (e.g. from kanban assign)
  // so the agent-change useEffect doesn't overwrite it with a stale session ID.
  const pendingSessionIdRef = useRef(null);

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
          setMessages((prev) => [...prev, data.message]);
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
      case 'delegation_error':
        if (data.sessionId === activeSessionIdRef.current) {
          setToasts((prev) => [
            ...prev,
            {
              id: `delegation-err-${Date.now()}`,
              type: 'error',
              message: `Delegation failed: ${data.error}`,
              duration: 10000,
            },
          ]);
        }
        break;

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
            duration: 15000,
          },
        ]);
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

      case 'dispatch_failure': {
        const toast = {
          id: `dispatch-failure-${Date.now()}`,
          type: 'error',
          message: `Dispatch failed (${data.source}): ${data.cardTitle} — ${data.reason}`,
          duration: 15000,
        };
        setToasts((prev) => [...prev, toast]);
        // Also refresh kanban to show the new card comment
        setKanbanRefreshKey((k) => k + 1);
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
    }
  }, []);

  const { send, connected, reconnecting } = useWebSocket(handleWsMessage);

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

      // If we were explicitly navigated to a specific session (e.g. from kanban
      // assign), honour that session ID instead of defaulting to the first one.
      const target = targetSessionId
        ? data.find((s) => s.id === targetSessionId) || data[0]
        : data[0];

      if (target) {
        setActiveSessionId(target.id);
        setSessionEngine(target.engine || activeAgent?.engine || 'claude-code');
        setSessionModel(target.model || 'claude-opus-4-6');
        setSessionWorktree(target.use_worktree !== 0);
        setGitWorktreeDetected(
          target.git_worktree_detected != null ? target.git_worktree_detected === 1 : null,
        );
        setSessionAskMode(target.ask_mode !== 0);
      } else {
        setActiveSessionId(null);
        setMessages([]);
        setSessionEngine(agents.find((a) => a.id === activeAgentId)?.engine || 'claude-code');
        setSessionModel('claude-opus-4-6');
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

  const handleNewSession = async () => {
    if (!activeAgentId) return;
    const session = await api.createSession(activeAgentId, undefined, { askMode: sessionAskMode });
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    setSessionEngine(session.engine || activeAgent?.engine || 'claude-code');
    setSessionModel(session.model || 'claude-opus-4-6');
    setSessionWorktree(session.use_worktree !== 0);
    setGitWorktreeDetected(null); // New session, not yet detected
    setSessionAskMode(session.ask_mode !== 0);
    setMessages([]);
    setCurrentView('chat');
  };

  const ENGINE_DEFAULT_MODELS = {
    'claude-code': 'claude-opus-4-6',
  };

  const handleEngineChange = async (engine) => {
    setSessionEngine(engine);
    const defaultModel = ENGINE_DEFAULT_MODELS[engine] || 'claude-opus-4-6';
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

    // Upload media (images + videos) first, then send chat with references
    let uploadedImages = [];
    if (images.length > 0) {
      try {
        uploadedImages = await Promise.all(
          images.map((img) => {
            if (img.type === 'video' && img.file) {
              // Videos use binary upload to avoid base64 overhead
              return api.uploadFile(img.file);
            }
            // Images use the existing data-URL upload
            return api.uploadImage(img.dataUrl, img.name);
          }),
        );
      } catch (err) {
        console.error('Media upload failed:', err);
        // Still send the text message even if upload fails
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

  const isElectron = !!window.electronAPI?.isElectron;
  const isMac = window.electronAPI?.platform === 'darwin';

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
              setSidebarOpen(false);
            }}
            currentView={currentView}
            activeTaskSessionIds={activeTasks}
            subagentsBySession={subagents}
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
            activeReviews={activeReviews}
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
            />
          ) : currentView === 'wiki' && wikiProjectId ? (
            <WikiBrowser projectId={wikiProjectId} apiBase={getApiBase()} />
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
          ) : (
            <>
              {/* Messages */}
              <div
                ref={scrollContainerRef}
                onScroll={handleScrollEvent}
                className="flex-1 overflow-y-auto p-3 md:p-6 relative"
              >
                <div className="mx-auto">
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
              />
            </>
          )}
        </div>

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
  useEffect(() => {
    if (toast.duration) {
      const timer = setTimeout(onDismiss, toast.duration);
      return () => clearTimeout(timer);
    }
  }, [toast.duration, onDismiss]);

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
