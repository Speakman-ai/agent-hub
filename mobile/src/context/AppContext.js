import React, { createContext, useState, useCallback, useEffect, useContext, useRef } from 'react';
import { api } from '../utils/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { loadOrgs, migrateFromLegacy } from '../utils/orgs';
import { loadConnectionConfig } from '../utils/config';

const AppContext = createContext(null);

const ENGINE_DEFAULT_MODELS = {
  'claude-code': 'claude-opus-4-6',
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
  const [sessionModel, setSessionModel] = useState('claude-opus-4-6');
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

  // Delegation state: { [sessionId]: { parentMessageId, tasks: [...] } }
  const [delegations, setDelegations] = useState({});
  // Message queue state: { [sessionId]: [{ id, content, position }] }
  const [messageQueues, setMessageQueues] = useState({});
  // Session events: { [messageId]: [{ seq, event }] }
  const [eventsByMessage, setEventsByMessage] = useState({});

  const activeAgent = agents.find((a) => a.id === activeAgentId);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const activeRoomIdRef = useRef(activeRoomId);
  activeRoomIdRef.current = activeRoomId;

  // WebSocket handler
  const handleWsMessage = useCallback((data) => {
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
    }
  }, []);

  const { send, connected, reconnecting, reconnect } = useWebSocket(handleWsMessage);

  const refreshAgents = useCallback(() => {
    api.getAgents().then((data) => {
      setAgents(data);
    });
  }, []);

  const refreshProjects = useCallback(() => {
    api.getProjects().then(setProjects).catch(() => setProjects([]));
  }, []);

  // Load agents and projects on mount (after org migration)
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
        // Reconnect WebSocket now that config is loaded
        reconnect();
      }
      try {
        const [agentData, projectData, roomData] = await Promise.all([
          api.getAgents(),
          api.getProjects().catch(() => []),
          api.getRooms().catch(() => []),
        ]);
        setAgents(agentData);
        setProjects(projectData);
        setRooms(roomData);
        if (agentData.length > 0) setActiveAgentId(agentData[0].id);
      } catch (err) {
        console.error('Failed to load initial data:', err);
      }
    })();
  }, []);

  // Load sessions when agent changes
  useEffect(() => {
    if (!activeAgentId) return;
    api.getSessions(activeAgentId).then((data) => {
      setSessions(data);
      if (data.length > 0) {
        setActiveSessionId(data[0].id);
        const agent = agents.find((a) => a.id === activeAgentId);
        setSessionEngine(data[0].engine || agent?.engine || 'claude-code');
        setSessionModel(data[0].model || 'claude-opus-4-6');
      } else {
        setActiveSessionId(null);
        setMessages([]);
        const agent = agents.find((a) => a.id === activeAgentId);
        setSessionEngine(agent?.engine || 'claude-code');
        setSessionModel('claude-opus-4-6');
      }
    }).catch((err) => console.error('Failed to load sessions:', err));
  }, [activeAgentId]);

  // Load skills for /slash-command autocomplete when agent changes
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
    if (session?.engine) setSessionEngine(session.engine);
    if (session?.model) setSessionModel(session.model);
  }, [activeSessionId, sessions]);

  // Load messages when session changes
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    api.getMessages(activeSessionId).then(setMessages).catch(() => setMessages([]));
  }, [activeSessionId]);

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
    setDelegations({});
    setMessageQueues({});
    setEventsByMessage({});
    // Reconnect WebSocket to new org
    reconnect();
    // Reload data
    try {
      const [agentData, projectData, roomData] = await Promise.all([
        api.getAgents(),
        api.getProjects().catch(() => []),
        api.getRooms().catch(() => []),
      ]);
      setAgents(agentData);
      setProjects(projectData);
      setRooms(roomData);
      if (agentData.length > 0) setActiveAgentId(agentData[0].id);
    } catch (err) {
      console.error('Failed to load data after org switch:', err);
    }
  }, [reconnect]);

  const handleNewSession = useCallback(async () => {
    if (!activeAgentId) return;
    const session = await api.createSession(activeAgentId);
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    const agent = agents.find((a) => a.id === activeAgentId);
    setSessionEngine(session.engine || agent?.engine || 'claude-code');
    setSessionModel(session.model || 'claude-opus-4-6');
    setMessages([]);
  }, [activeAgentId, agents]);

  const handleEngineChange = useCallback(async (engine) => {
    setSessionEngine(engine);
    const defaultModel = ENGINE_DEFAULT_MODELS[engine] || 'claude-opus-4-6';
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

  const handleSend = useCallback(async (content, images = []) => {
    let sessionId = activeSessionIdRef.current;
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

  // Load room messages when active room changes
  useEffect(() => {
    if (!activeRoomId) {
      setRoomMessages([]);
      setRoomThinking(null);
      setRoomStreaming(null);
      setRoomProcessing(false);
      return;
    }
    api.getRoomMessages(activeRoomId).then(setRoomMessages).catch(() => setRoomMessages([]));
  }, [activeRoomId]);

  const handleRoomSend = useCallback((content) => {
    if (!activeRoomId) return;
    send({ type: 'room_chat', roomId: activeRoomId, content });
  }, [activeRoomId, send]);

  const handleRoomCancel = useCallback(() => {
    if (!activeRoomId) return;
    send({ type: 'room_cancel', roomId: activeRoomId });
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

  const isProcessing = thinking || !!streamingContent;

  const value = {
    agents,
    projects,
    activeAgentId,
    setActiveAgentId,
    activeAgent,
    sessions,
    activeSessionId,
    setActiveSessionId,
    messages,
    thinking,
    streamingContent,
    streamingMsgId,
    streamingEngine,
    sessionEngine,
    sessionModel,
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
    handleRoomSend,
    handleRoomCancel,
    refreshRooms,
    delegations,
    messageQueues,
    eventsByMessage,
    handleDequeue,
    handleEditQueuedMessage,
    handleDelegationCancel,
    handleEventsLoaded,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
