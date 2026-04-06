import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { api } from '../utils/api.js';
import { relativeTime } from '../utils/time.js';

/**
 * RoomChat — conference room group chat with multiple agents.
 * Supports Slack-style @mention autocomplete.
 */
export default function RoomChat({
  room,
  agents,
  send,
  roomMessages,
  roomStreaming,
  roomThinking,
  roomProcessing,
  onRoomUpdated,
}) {
  const [input, setInput] = useState('');
  const [showAgentPanel, setShowAgentPanel] = useState(false);
  const messagesEndRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const initialScrollRef = useRef(true);
  const scrollRafRef = useRef(null);
  const isNearBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const inputRef = useRef(null);

  // Mention autocomplete state
  const [mentionQuery, setMentionQuery] = useState(null); // null = closed, string = filter
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionStart, setMentionStart] = useState(null); // cursor position of the '@'

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

  useLayoutEffect(() => {
    if (initialScrollRef.current || isNearBottomRef.current) {
      scrollToBottom(initialScrollRef.current);
    }
    initialScrollRef.current = false;
  }, [roomMessages, roomStreaming, roomThinking, scrollToBottom]);

  useLayoutEffect(() => {
    initialScrollRef.current = true;
    isNearBottomRef.current = true;
    setShowScrollBtn(false);
  }, [room.id]);

  // Filtered agents for autocomplete
  const mentionAgents = room.agents?.filter((a) =>
    mentionQuery === null
      ? false
      : a.name.toLowerCase().includes(mentionQuery.toLowerCase())
  ) || [];

  // Reset index when filtered list changes
  useEffect(() => {
    setMentionIndex(0);
  }, [mentionQuery]);

  const closeMention = useCallback(() => {
    setMentionQuery(null);
    setMentionStart(null);
    setMentionIndex(0);
  }, []);

  const insertMention = useCallback((agentName) => {
    if (mentionStart === null) return;
    const before = input.slice(0, mentionStart);
    const after = input.slice(inputRef.current?.selectionStart || input.length);
    const newInput = `${before}@${agentName} ${after}`;
    setInput(newInput);
    closeMention();
    // Restore focus and cursor position after React re-render
    requestAnimationFrame(() => {
      const pos = before.length + agentName.length + 2; // +2 for @ and space
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(pos, pos);
    });
  }, [input, mentionStart, closeMention]);

  const handleInputChange = (e) => {
    const val = e.target.value;
    const cursor = e.target.selectionStart;
    setInput(val);

    // Detect @mention trigger: find the last '@' before cursor that isn't
    // preceded by a non-space character (i.e., it's a word boundary)
    const textBeforeCursor = val.slice(0, cursor);
    const atMatch = textBeforeCursor.match(/(^|[\s])@([^\s]*)$/);
    if (atMatch) {
      const query = atMatch[2]; // text after @
      const atPos = textBeforeCursor.length - atMatch[0].length + (atMatch[1] ? 1 : 0);
      setMentionQuery(query);
      setMentionStart(atPos);
    } else {
      closeMention();
    }
  };

  const handleKeyDown = (e) => {
    if (mentionQuery !== null && mentionAgents.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionAgents.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionAgents.length) % mentionAgents.length);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        insertMention(mentionAgents[mentionIndex].name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMention();
        return;
      }
    }
  };

  const handleSend = (e) => {
    e.preventDefault();
    if (!input.trim() || roomProcessing) return;
    closeMention();
    send({
      type: 'room_chat',
      roomId: room.id,
      content: input.trim(),
    });
    setInput('');
  };

  const handleCancel = () => {
    send({ type: 'room_cancel', roomId: room.id });
  };

  const handleAddAgent = async (agentId) => {
    await api.addRoomAgent(room.id, agentId);
    onRoomUpdated?.();
  };

  const handleRemoveAgent = async (agentId) => {
    await api.removeRoomAgent(room.id, agentId);
    onRoomUpdated?.();
  };

  const handleMaxTurnsChange = async (value) => {
    const max_turns = value === 0 ? 0 : value;
    await api.updateRoom(room.id, { max_turns });
    onRoomUpdated?.();
  };

  const roomAgentIds = new Set(room.agents?.map((a) => a.id) || []);
  const availableAgents = agents.filter((a) => a.active !== false && !roomAgentIds.has(a.id));

  return (
    <div className="flex flex-col h-full">
      {/* Room header */}
      <div className="border-b border-gray-800 px-4 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-lg">🏢</span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold truncate">{room.name}</h2>
            <div className="flex items-center gap-1.5 mt-0.5">
              {room.agents?.map((a) => (
                <span
                  key={a.id}
                  title={a.name}
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: a.color }}
                />
              ))}
              <span className="text-xs text-gray-500">
                {room.agents?.length || 0} agent{(room.agents?.length || 0) !== 1 ? 's' : ''}
              </span>
            </div>
          </div>
        </div>
        <button
          onClick={() => setShowAgentPanel(!showAgentPanel)}
          className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
            showAgentPanel
              ? 'bg-blue-600 text-white'
              : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
          }`}
        >
          {showAgentPanel ? 'Close' : 'Manage Agents'}
        </button>
      </div>

      {/* Agent management panel */}
      {showAgentPanel && (
        <div className="border-b border-gray-800 bg-gray-900/50 p-4">
          <div className="max-w-4xl mx-auto">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
              Agents in Room
            </h3>
            <div className="flex flex-wrap gap-2 mb-3">
              {room.agents?.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-1.5 text-sm"
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: a.color }}
                  />
                  <span>{a.name}</span>
                  <button
                    onClick={() => handleRemoveAgent(a.id)}
                    className="text-gray-500 hover:text-red-400 text-xs ml-1"
                  >
                    ✕
                  </button>
                </div>
              ))}
              {(!room.agents || room.agents.length === 0) && (
                <span className="text-xs text-gray-600">No agents yet — add some below</span>
              )}
            </div>

            {availableAgents.length > 0 && (
              <>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                  Add Agent
                </h3>
                <div className="flex flex-wrap gap-2">
                  {availableAgents.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => handleAddAgent(a.id)}
                      className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 rounded-lg px-3 py-1.5 text-sm transition-colors"
                    >
                      <span
                        className="w-2.5 h-2.5 rounded-full"
                        style={{ backgroundColor: a.color }}
                      />
                      <span className="text-gray-300">+ {a.name}</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {/* Max turns setting */}
            <div className="mt-4 pt-3 border-t border-gray-700/50">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                Max Agent Replies (per message)
              </h3>
              <div className="flex items-center gap-1.5">
                {[10, 25, 50, 100, 0].map((value) => {
                  const label = value === 0 ? 'Unlimited' : String(value);
                  const current = room.max_turns ?? 10;
                  const isActive = current === value;
                  return (
                    <button
                      key={value}
                      onClick={() => handleMaxTurnsChange(value)}
                      className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
                        isActive
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-gray-600 mt-1.5">
                Max agent-to-agent replies before stopping. Prevents runaway conversations.
                {(room.max_turns ?? 10) === 0 && (
                  <span className="text-amber-500 ml-1">
                    Warning: unlimited may run for a long time
                  </span>
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScrollEvent}
        className="flex-1 overflow-y-auto p-3 md:p-6 relative"
      >
        <div className="max-w-4xl mx-auto">
          {roomMessages.length === 0 && !roomThinking && !roomStreaming && (
            <div className="flex flex-col items-center justify-center h-full text-gray-600 py-20">
              <span className="text-5xl mb-4">🏢</span>
              <p className="text-lg">Conference Room</p>
              <p className="text-sm mt-1">
                {room.agents?.length > 0
                  ? `${room.agents.map((a) => a.name).join(', ')} are ready`
                  : 'Add agents to start a conversation'}
              </p>
              {room.agents?.length > 0 && (
                <p className="text-xs text-gray-700 mt-3">
                  Type @ to mention a specific agent, or send a message for everyone
                </p>
              )}
            </div>
          )}

          {roomMessages.map((msg) => (
            <RoomMessage key={msg.id} message={msg} roomAgents={room.agents} />
          ))}

          {/* Thinking indicator */}
          {roomThinking && (
            <div className="flex items-start gap-3 py-3">
              <span
                className="w-3 h-3 rounded-full mt-1 flex-shrink-0 animate-pulse"
                style={{ backgroundColor: roomThinking.agentColor }}
              />
              <div className="text-sm text-gray-500">
                <span className="font-medium" style={{ color: roomThinking.agentColor }}>
                  {roomThinking.agentName}
                </span>{' '}
                is thinking...
              </div>
            </div>
          )}

          {/* Streaming response */}
          {roomStreaming && (
            <div className="flex items-start gap-3 py-3">
              <span
                className="w-3 h-3 rounded-full mt-1.5 flex-shrink-0"
                style={{ backgroundColor: roomStreaming.agentColor }}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className="text-xs font-semibold"
                    style={{ color: roomStreaming.agentColor }}
                  >
                    {roomStreaming.agentName}
                  </span>
                  <span className="text-xs text-gray-600 animate-pulse">streaming...</span>
                </div>
                <div className="text-sm text-gray-300 whitespace-pre-wrap">
                  <RenderMentions text={roomStreaming.content} roomAgents={room.agents} />
                  <span className="inline-block w-2 h-4 bg-gray-500 animate-pulse ml-0.5" />
                </div>
              </div>
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
      <div className="border-t border-gray-800 p-3 md:p-4 flex-shrink-0">
        <div className="max-w-4xl mx-auto relative">
          {/* Mention autocomplete popup */}
          {mentionQuery !== null && mentionAgents.length > 0 && (
            <div className="absolute bottom-full mb-1 left-0 w-64 bg-gray-800 border border-gray-700 rounded-lg shadow-xl overflow-hidden z-10">
              <div className="px-2 py-1.5 text-xs text-gray-500 border-b border-gray-700">
                Agents — type to filter, ↑↓ to navigate, Enter to select
              </div>
              {mentionAgents.map((a, i) => (
                <button
                  key={a.id}
                  onMouseDown={(e) => {
                    e.preventDefault(); // prevent input blur
                    insertMention(a.name);
                  }}
                  onMouseEnter={() => setMentionIndex(i)}
                  className={`w-full text-left px-3 py-2 flex items-center gap-2.5 text-sm transition-colors ${
                    i === mentionIndex
                      ? 'bg-blue-600/30 text-white'
                      : 'text-gray-300 hover:bg-gray-700/50'
                  }`}
                >
                  <span
                    className="w-3 h-3 rounded-full flex-shrink-0"
                    style={{ backgroundColor: a.color }}
                  />
                  <span className="font-medium">{a.name}</span>
                </button>
              ))}
            </div>
          )}
          <form onSubmit={handleSend} className="flex gap-2">
            <input
              ref={inputRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onBlur={() => {
                // Delay close so click on popup can fire first
                setTimeout(closeMention, 150);
              }}
              placeholder={
                roomProcessing
                  ? 'Agents are responding...'
                  : room.agents?.length > 0
                  ? 'Message the room — type @ to mention an agent'
                  : 'Add agents to start chatting'
              }
              disabled={roomProcessing || !room.agents?.length}
              className="flex-1 bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-sm text-gray-100 focus:outline-none focus:border-gray-500 disabled:opacity-50"
            />
            {roomProcessing ? (
              <button
                type="button"
                onClick={handleCancel}
                className="bg-red-600/80 hover:bg-red-600 text-white px-4 py-3 rounded-xl text-sm transition-colors"
              >
                Cancel
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim() || !room.agents?.length}
                className="bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:hover:bg-blue-600 text-white px-4 py-3 rounded-xl text-sm transition-colors"
              >
                Send
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}

/**
 * Render message content with @mentions highlighted in agent colors.
 */
function RenderMentions({ text, roomAgents }) {
  if (!roomAgents?.length || !text) return text;

  // Build a regex that matches any @AgentName (longest first to avoid partial matches)
  const sorted = [...roomAgents].sort((a, b) => b.name.length - a.name.length);
  const escaped = sorted.map((a) => a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(@(?:${escaped.join('|')}))\\b`, 'gi');

  const parts = text.split(pattern);
  if (parts.length === 1) return text;

  return parts.map((part, i) => {
    const match = part.match(/^@(.+)$/i);
    if (match) {
      const agent = roomAgents.find(
        (a) => a.name.toLowerCase() === match[1].toLowerCase()
      );
      if (agent) {
        return (
          <span
            key={i}
            className="font-semibold"
            style={{ color: agent.color }}
          >
            {part}
          </span>
        );
      }
    }
    return part;
  });
}

function RoomMessage({ message, roomAgents }) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="flex items-start gap-3 py-3">
        <span className="w-3 h-3 rounded-full mt-1.5 bg-gray-500 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-semibold text-gray-400">You</span>
            <span className="text-xs text-gray-600">
              {relativeTime(message.created_at)}
            </span>
          </div>
          <div className="text-sm text-gray-200 whitespace-pre-wrap">
            <RenderMentions text={message.content} roomAgents={roomAgents} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 py-3">
      <span
        className="w-3 h-3 rounded-full mt-1.5 flex-shrink-0"
        style={{ backgroundColor: message.agent_color || '#666' }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span
            className="text-xs font-semibold"
            style={{ color: message.agent_color || '#666' }}
          >
            {message.agent_name || 'Agent'}
          </span>
          <span className="text-xs text-gray-600">
            {relativeTime(message.created_at)}
          </span>
        </div>
        <div className="text-sm text-gray-300 whitespace-pre-wrap">
          <RenderMentions text={message.content} roomAgents={roomAgents} />
        </div>
      </div>
    </div>
  );
}
