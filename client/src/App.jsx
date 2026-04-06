import React, { useState, useEffect, useRef, useCallback } from 'react';
import Sidebar from './components/Sidebar.jsx';
import TopBar from './components/TopBar.jsx';
import ChatMessage from './components/ChatMessage.jsx';
import ThinkingIndicator from './components/ThinkingIndicator.jsx';
import SessionTail from './components/SessionTail.jsx';
import MessageInput from './components/MessageInput.jsx';
import AgentSwitcher from './components/AgentSwitcher.jsx';
import SettingsPage from './components/SettingsPage.jsx';
import SkillsPage from './components/SkillsPage.jsx';
import { useWebSocket } from './hooks/useWebSocket.js';
import { api } from './utils/api.js';

export default function App() {
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
  const messagesEndRef = useRef(null);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  const activeAgent = agents.find((a) => a.id === activeAgentId);

  // Auto-scroll
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, thinking, streamingContent, scrollToBottom]);

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
                content: `⚠️ Error: ${data.error}`,
                created_at: new Date().toISOString(),
              },
            ]);
          }
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
    api.getAgents().then((data) => {
      setAgents(data);
    });
  }, []);

  // Load agents on mount
  useEffect(() => {
    api.getAgents().then((data) => {
      setAgents(data);
      if (data.length > 0) setActiveAgentId(data[0].id);
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
      } else {
        setActiveSessionId(null);
        setMessages([]);
        setSessionEngine(agents.find(a => a.id === activeAgentId)?.engine || 'claude-code');
        setSessionModel('claude-opus-4-6');
      }
    });
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

  const handleNewSession = async () => {
    if (!activeAgentId) return;
    const session = await api.createSession(activeAgentId);
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    setSessionEngine(session.engine || activeAgent?.engine || 'claude-code');
    setSessionModel(session.model || 'claude-opus-4-6');
    setMessages([]);
    setCurrentView('chat');
  };

  const ENGINE_DEFAULT_MODELS = {
    'claude-code': 'claude-opus-4-6',
    'cursor-agent': 'gpt-5.3-codex-high',
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

  const handleSend = async (content) => {
    let sessionId = activeSessionId;
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
  };

  const isProcessing = thinking || !!streamingContent;

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100">
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
        />

        {currentView === 'settings' ? (
          <SettingsPage agents={agents} onAgentsChange={refreshAgents} />
        ) : currentView === 'skills' ? (
          <SkillsPage agents={agents} />
        ) : (
          <>
            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-3 md:p-6">
              <div className="max-w-4xl mx-auto">
                {messages.length === 0 && !thinking && !streamingContent && (
                  <div className="flex flex-col items-center justify-center h-full text-gray-600 py-20">
                    <span className="text-5xl mb-4">💬</span>
                    <p className="text-lg">Start a conversation</p>
                    {activeAgent && (
                      <p className="text-sm mt-1">with {activeAgent.name}</p>
                    )}
                    <p className="text-xs text-gray-700 mt-4 hidden sm:block">
                      Ctrl+K to switch agents · Esc to cancel
                    </p>
                  </div>
                )}
                {messages.map((msg) =>
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
                      message={msg}
                      agentColor={activeAgent?.color}
                    />
                  )
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
                  />
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>

            {/* Input */}
            <MessageInput
              onSend={handleSend}
              onCancel={handleCancel}
              disabled={!activeAgentId || !connected || isProcessing}
              isProcessing={isProcessing}
              agentColor={activeAgent?.color}
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
    </div>
  );
}
