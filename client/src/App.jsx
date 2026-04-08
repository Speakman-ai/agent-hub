import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
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
import { useWebSocket } from './hooks/useWebSocket.js';
import { api } from './utils/api.js';
import { MessageCircle, Info, CheckCircle, AlertTriangle } from 'lucide-react';
import { migrateFromLegacy, getActiveOrg } from './utils/orgs.js';
import { getApiBase } from './utils/connection.js';

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
  const [currentView, setCurrentView] = useState('chat');
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
  // Delegation state: Map of sessionId -> { parentMessageId, tasks: [{delegationId, agentId, agentName, agentColor, task, status, content, output, error}] }
  const [delegations, setDelegations] = useState({});
  // Skills for the active agent (for /slash-command autocomplete)
  const [skills, setSkills] = useState([]);
  // Open Project wizard
  const [showWizard, setShowWizard] = useState(false);
  // First-run setup
  const [setupStatus, setSetupStatus] = useState(null);
  const [showSetup, setShowSetup] = useState(false);
  // Toast notifications (e.g., babysit events)
  const [toasts, setToasts] = useState([]);
  const activeRoomIdRef = useRef(activeRoomId);
  activeRoomIdRef.current = activeRoomId;

  const messagesEndRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  const activeAgent = agents.find((a) => a.id === activeAgentId);

  // Auto-scroll — instant on initial load, smooth for live updates.
  // Only auto-scrolls if user is already near the bottom (within threshold).
  const initialScrollRef = useRef(true);
  const scrollRafRef = useRef(null);
  const isNearBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const checkNearBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return true;
    const threshold = 150;
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  const handleScrollEvent = useCallback(() => {
    const nearBottom = checkNearBottom();
    isNearBottomRef.current = nearBottom;
    setShowScrollBtn(!nearBottom);
  }, [checkNearBottom]);

  const scrollToBottom = useCallback((instant) => {
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({
        behavior: instant ? 'instant' : 'smooth',
      });
    });
  }, []);

  // Auto-scroll on new content, but only if user is near the bottom or it's initial load.
  useLayoutEffect(() => {
    if (initialScrollRef.current || isNearBottomRef.current) {
      scrollToBottom(initialScrollRef.current);
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
    const forActiveSession =
      data.sessionId && data.sessionId === activeSessionIdRef.current;
    // 'message' events use message.session_id rather than top-level sessionId.
    const msgForActiveSession =
      data.message?.session_id === activeSessionIdRef.current;

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
        break;
      }
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
      case 'room_round_done':
      case 'room_cancelled':
        if (data.roomId === activeRoomIdRef.current) {
          setRoomProcessing(false);
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
                    ? { ...t, delegationId: data.delegationId, agentName: data.agentName, agentColor: data.agentColor, status: 'running' }
                    : t
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
                    ? { ...t, agentName: data.agentName, agentColor: data.agentColor, content: data.content, status: 'running' }
                    : t
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
                    : t
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
                  t.agentId === data.agentId
                    ? { ...t, status: 'error', error: data.error }
                    : t
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
                    : t
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

      // ─── Babysit notifications ─────────────────────────────
      case 'babysit_started': {
        const toast = {
          id: `babysit-start-${Date.now()}`,
          type: 'info',
          message: `Babysitting ${data.repoSlug}#${data.prNumber} — watching until green`,
          duration: 8000,
        };
        setToasts((prev) => [...prev, toast]);
        break;
      }
      case 'analyze-progress':
      case 'analyze-complete':
      case 'analyze-error':
        window.dispatchEvent(new CustomEvent('analyze-ws', { detail: data }));
        break;
      case 'babysit_complete': {
        const toast = {
          id: `babysit-done-${Date.now()}`,
          type: 'success',
          message: `${data.repoSlug}#${data.prNumber} is green and ready to merge!`,
          duration: 15000,
        };
        setToasts((prev) => [...prev, toast]);
        // Babysit cron has been deleted server-side — notify settings page
        // by dispatching a custom event that SettingsPage can listen for.
        window.dispatchEvent(new CustomEvent('babysit-cleaned', { detail: { cronId: data.cronId } }));
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
          prev.map((m) => m.id === data.messageId ? { ...m, content: data.content } : m)
        );
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
        p.agents.map((a) => ({ ...a, projectId: p.id, projectName: p.name, cwd: p.cwd, ahw: p.ahw }))
      );
      setAgents(flat);
    });
  }, []);

  // Migrate legacy connection config to org system on first load,
  // then ensure the server is pointed at the active org's data directory
  useEffect(() => {
    migrateFromLegacy();
    const activeOrg = getActiveOrg();
    if (activeOrg && activeOrg.mode !== 'remote') {
      fetch(`${getApiBase()}/org/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: activeOrg.id }),
      }).catch(() => {}); // server may not support it yet
    }
  }, []);

  // Check setup status + load projects on mount
  useEffect(() => {
    // Check first-run status
    fetch(`${getApiBase()}/setup/status`)
      .then((r) => r.json())
      .then((status) => {
        setSetupStatus(status);
        if (status.firstRun) setShowSetup(true);
      })
      .catch(() => {}); // server may not have endpoint yet — ignore

    api.getProjects().then((data) => {
      setProjects(data);
      const flat = data.flatMap((p) =>
        p.agents.map((a) => ({ ...a, projectId: p.id, projectName: p.name, cwd: p.cwd, ahw: p.ahw }))
      );
      setAgents(flat);
      const storedId = localStorage.getItem('activeAgentId');
      const storedAgentExists = storedId && flat.some((a) => a.id === storedId);
      if (storedAgentExists) {
        setActiveAgentId(storedId);
      } else if (flat.length > 0) {
        setActiveAgentId(flat[0].id);
      }
    });
  }, []);

  // Load sessions when agent changes
  useEffect(() => {
    if (!activeAgentId) return;
    api.getSessions(activeAgentId).then((data) => {
      setSessions(data);
      if (data.length > 0) {
        setActiveSessionId(data[0].id);
        setSessionEngine(data[0].engine || activeAgent?.engine || 'claude-code');
        setSessionModel(data[0].model || 'claude-opus-4-6');
        setSessionWorktree(data[0].use_worktree !== 0);
      } else {
        setActiveSessionId(null);
        setMessages([]);
        setSessionEngine(agents.find(a => a.id === activeAgentId)?.engine || 'claude-code');
        setSessionModel('claude-opus-4-6');
        setSessionWorktree(true);
      }
    });
  }, [activeAgentId]);

  // Load skills for slash-command autocomplete when agent changes
  useEffect(() => {
    if (!activeAgentId) {
      setSkills([]);
      return;
    }
    api.getSkills(activeAgentId)
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

  // Load room messages when active room changes
  useEffect(() => {
    if (!activeRoomId) {
      setRoomMessages([]);
      return;
    }
    api.getRoomMessages(activeRoomId).then(setRoomMessages).catch(console.error);
  }, [activeRoomId]);

  const handleNewRoom = async () => {
    const name = prompt('Room name:');
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
    const session = await api.createSession(activeAgentId);
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    setSessionEngine(session.engine || activeAgent?.engine || 'claude-code');
    setSessionModel(session.model || 'claude-opus-4-6');
    setSessionWorktree(session.use_worktree !== 0);
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
        prev.map((s) => (s.id === updated.id ? { ...s, engine: updated.engine } : s))
      );
      const modelUpdated = await api.setSessionModel(activeSessionId, defaultModel);
      setSessions((prev) =>
        prev.map((s) => (s.id === modelUpdated.id ? { ...s, model: modelUpdated.model } : s))
      );
    }
  };

  const handleModelChange = async (model) => {
    setSessionModel(model);
    if (activeSessionId) {
      const updated = await api.setSessionModel(activeSessionId, model);
      setSessions((prev) =>
        prev.map((s) => (s.id === updated.id ? { ...s, model: updated.model } : s))
      );
    }
  };

  const handleWorktreeChange = async (enabled) => {
    setSessionWorktree(enabled);
    if (activeSessionId) {
      const updated = await api.setSessionWorktree(activeSessionId, enabled);
      setSessions((prev) =>
        prev.map((s) => (s.id === updated.id ? { ...s, use_worktree: updated.use_worktree } : s))
      );
    }
  };

  const handleDeleteSession = async (sessionId) => {
    await api.deleteSession(sessionId);
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    if (activeSessionId === sessionId) {
      const remaining = sessions.filter((s) => s.id !== sessionId);
      setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
    }
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
      setMessages((prev) =>
        prev.map((m) => m.id === messageId ? { ...m, content } : m)
      );
    }
  };

  const handleSend = async (content, images = []) => {
    let sessionId = activeSessionId;
    if (!sessionId) {
      const session = await api.createSession(activeAgentId);
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
      sessionId = session.id;
    }

    // Upload images first, then send chat with references
    let uploadedImages = [];
    if (images.length > 0) {
      try {
        uploadedImages = await Promise.all(
          images.map((img) => api.uploadImage(img.dataUrl, img.name))
        );
      } catch (err) {
        console.error('Image upload failed:', err);
        // Still send the text message even if upload fails
      }
    }

    send({
      type: 'chat',
      agentId: activeAgentId,
      sessionId,
      content,
      ...(uploadedImages.length > 0 ? { images: uploadedImages } : {}),
    });
  };

  const isProcessing = thinking || !!streamingContent;

  const isElectron = !!window.electronAPI?.isElectron;
  const isMac = window.electronAPI?.platform === 'darwin';

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
          onNavigate={(view) => {
            setCurrentView(view);
            setSidebarOpen(false);
          }}
          currentView={currentView}
          activeTaskSessionIds={activeTasks}
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
          onWorktreeChange={handleWorktreeChange}
        />

        {currentView.startsWith('settings') ? (
          <SettingsPage projects={projects} agents={agents} onAgentsChange={refreshAgents} initialTab={currentView.includes(':') ? currentView.split(':')[1] : undefined} />
        ) : currentView === 'skills' ? (
          <SkillsPage agents={agents} />
        ) : currentView === 'room' && activeRoom ? (
          <RoomChat
            room={activeRoom}
            agents={agents}
            send={send}
            roomMessages={roomMessages}
            roomStreaming={roomStreaming}
            roomThinking={roomThinking}
            roomProcessing={roomProcessing}
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
                    {activeAgent && (
                      <p className="text-sm mt-1">with {activeAgent.name}</p>
                    )}
                    <p className="text-xs text-gray-700 mt-4 hidden sm:block">
                      Ctrl+K to switch agents · Esc to cancel
                    </p>
                  </div>
                )}
                {(() => {
                  const queuedIds = new Set((messageQueues[activeSessionId] || []).map((q) => q.id));
                  return messages.map((msg) =>
                    msg.role === 'assistant' ? (
                      <SessionTail
                        key={msg.id}
                        message={msg}
                        events={eventsByMessage[msg.id]}
                        agentColor={activeAgent?.color}
                        onEventsLoaded={handleEventsLoaded}
                      />
                    ) : (
                      <ChatMessage
                        key={msg.id}
                        message={{ ...msg, queued: queuedIds.has(msg.id) }}
                        agentColor={activeAgent?.color}
                        onDequeue={queuedIds.has(msg.id) ? handleDequeue : undefined}
                        onEditQueued={queuedIds.has(msg.id) ? handleEditQueuedMessage : undefined}
                      />
                    )
                  );
                })()}
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
                  />
                )}
                {/* Delegation panel — shows when a lead agent delegates to sub-agents */}
                {delegations[activeSessionId] && delegations[activeSessionId].tasks.length > 0 && (
                  <div className="px-4 max-w-[95%] sm:max-w-[90%]">
                    <DelegationPanel
                      delegations={delegations[activeSessionId].tasks}
                      sessionId={activeSessionId}
                      onCancel={(sid) => send({ type: 'delegation_cancel', sessionId: sid })}
                    />
                  </div>
                )}
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
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
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

      {/* Toast notifications (babysit events, etc.) */}
      {toasts.length > 0 && (
        <div className="fixed top-4 right-4 z-[60] flex flex-col gap-2 max-w-sm">
          {toasts.map((toast) => (
            <Toast
              key={toast.id}
              toast={toast}
              onDismiss={() =>
                setToasts((prev) => prev.filter((t) => t.id !== toast.id))
              }
            />
          ))}
        </div>
      )}
      </div>{/* close flex row wrapper */}
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
