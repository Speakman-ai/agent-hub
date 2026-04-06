import React, { createContext, useState, useCallback, useEffect, useContext, useRef } from 'react';
import { api } from '../utils/api';
import { useWebSocket } from '../hooks/useWebSocket';

const AppContext = createContext(null);

const ENGINE_DEFAULT_MODELS = {
  'claude-code': 'claude-opus-4-6',
  'cursor-agent': 'gpt-5.3-codex-high',
};

export function AppProvider({ children }) {
  const [agents, setAgents] = useState([]);
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

  const activeAgent = agents.find((a) => a.id === activeAgentId);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

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
    }
  }, []);

  const { send, connected, reconnecting } = useWebSocket(handleWsMessage);

  const refreshAgents = useCallback(() => {
    api.getAgents().then((data) => {
      setAgents(data);
    });
  }, []);

  // Load agents on mount
  useEffect(() => {
    api.getAgents().then((data) => {
      setAgents(data);
      if (data.length > 0) setActiveAgentId(data[0].id);
    }).catch((err) => console.error('Failed to load agents:', err));
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

  const handleSend = useCallback(async (content) => {
    let sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      const session = await api.createSession(activeAgentId);
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
      sessionId = session.id;
    }
    send({
      type: 'chat',
      agentId: activeAgentId,
      sessionId,
      content,
    });
  }, [activeAgentId, send]);

  const isProcessing = thinking || !!streamingContent;

  const value = {
    agents,
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
    refreshAgents,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
