import React, { useState } from 'react';
import { relativeTime } from '../utils/time.js';

export default function Sidebar({
  agents,
  activeAgentId,
  onSelectAgent,
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onNavigate,
  currentView,
  activeTaskSessionIds = {},
  rooms = [],
  activeRoomId,
  onSelectRoom,
  onNewRoom,
  onDeleteRoom,
}) {
  const [hoveredSession, setHoveredSession] = useState(null);
  const [hoveredRoom, setHoveredRoom] = useState(null);
  const [collapsedAgents, setCollapsedAgents] = useState({});

  const toggleCollapse = (agentId, e) => {
    e.stopPropagation();
    setCollapsedAgents((prev) => ({ ...prev, [agentId]: !prev[agentId] }));
  };

  const isRecent = (dateStr) => {
    if (!dateStr) return false;
    const d = dateStr.includes('T') ? new Date(dateStr) : new Date(dateStr + 'Z');
    return Date.now() - d.getTime() < 30 * 60 * 1000; // 30 min
  };

  return (
    <div className="sidebar-container bg-gray-900 border-r border-gray-800 flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-gray-800">
        <h1
          className="text-lg font-bold flex items-center gap-2 cursor-pointer hover:text-gray-300 transition-colors"
          onClick={() => onNavigate('chat')}
        >
          <span className="text-2xl">🤖</span>
          Agent Hub
        </h1>
      </div>

      {/* Agents */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-3">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 px-2">
            Agents
          </div>
          {agents.filter((a) => a.active !== false).map((agent) => (
            <div key={agent.id}>
              <button
                onClick={() => {
                  onSelectAgent(agent.id);
                  onNavigate('chat');
                }}
                className={`w-full text-left px-3 py-2.5 rounded-lg mb-0.5 flex items-center gap-3 transition-colors ${
                  activeAgentId === agent.id && currentView === 'chat'
                    ? 'bg-gray-800 text-white'
                    : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
                }`}
              >
                <div className="relative flex-shrink-0">
                  <span
                    className="w-3 h-3 rounded-full block"
                    style={{ backgroundColor: agent.color }}
                  />
                  {isRecent(agent.lastActivity) && (
                    <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-emerald-500 rounded-full border border-gray-900" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <span className="truncate text-sm font-medium block">
                    {agent.name}
                  </span>
                  {agent.lastMessage && (
                    <span className="text-xs text-gray-600 truncate block">
                      {agent.lastMessage.content}
                    </span>
                  )}
                </div>
                {activeAgentId === agent.id && (
                  <button
                    onClick={(e) => toggleCollapse(agent.id, e)}
                    className="text-gray-500 hover:text-gray-300 text-xs"
                  >
                    {collapsedAgents[agent.id] ? '▸' : '▾'}
                  </button>
                )}
              </button>

              {/* Sessions (collapsible, only for active agent) */}
              {activeAgentId === agent.id && !collapsedAgents[agent.id] && (
                <div className="ml-6 mb-2">
                  {sessions.map((session) => {
                    const isRunning = !!activeTaskSessionIds[session.id];
                    return (
                    <div
                      key={session.id}
                      onMouseEnter={() => setHoveredSession(session.id)}
                      onMouseLeave={() => setHoveredSession(null)}
                      className={`group flex items-center rounded-md mb-0.5 transition-colors ${
                        activeSessionId === session.id
                          ? 'bg-gray-800 text-white'
                          : 'text-gray-500 hover:bg-gray-800/50 hover:text-gray-300'
                      }`}
                    >
                      <button
                        onClick={() => {
                          onSelectSession(session.id);
                          onNavigate('chat');
                        }}
                        className="flex-1 text-left px-2 py-2 md:py-1.5 truncate text-xs flex items-center gap-1.5"
                      >
                        {isRunning && (
                          <span
                            className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0"
                            title="Task running"
                          />
                        )}
                        <span className="truncate">{session.name}</span>
                      </button>
                      {hoveredSession === session.id && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteSession(session.id);
                          }}
                          className="pr-2 text-gray-600 hover:text-red-400 text-xs"
                          title="Delete session"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    );
                  })}
                  <button
                    onClick={onNewSession}
                    className="text-xs text-gray-600 hover:text-gray-400 px-2 py-1 transition-colors"
                  >
                    + New Session
                  </button>
                </div>
              )}
            </div>
          ))}

          {/* Conference Rooms */}
          <div className="mt-4">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 px-2">
              Conference Rooms
            </div>
            {rooms.map((room) => (
              <div
                key={room.id}
                onMouseEnter={() => setHoveredRoom(room.id)}
                onMouseLeave={() => setHoveredRoom(null)}
                className={`group flex items-center rounded-lg mb-0.5 transition-colors ${
                  activeRoomId === room.id && currentView === 'room'
                    ? 'bg-gray-800 text-white'
                    : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
                }`}
              >
                <button
                  onClick={() => {
                    onSelectRoom(room.id);
                    onNavigate('room');
                  }}
                  className="flex-1 text-left px-3 py-2.5 flex items-center gap-2 min-w-0"
                >
                  <span className="text-sm flex-shrink-0">🏢</span>
                  <div className="flex-1 min-w-0">
                    <span className="truncate text-sm font-medium block">{room.name}</span>
                    <div className="flex items-center gap-1 mt-0.5">
                      {room.agents?.slice(0, 5).map((a) => (
                        <span
                          key={a.id}
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: a.color }}
                          title={a.name}
                        />
                      ))}
                      {room.agents?.length > 5 && (
                        <span className="text-xs text-gray-600">+{room.agents.length - 5}</span>
                      )}
                    </div>
                  </div>
                </button>
                {hoveredRoom === room.id && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteRoom(room.id);
                    }}
                    className="pr-2 text-gray-600 hover:text-red-400 text-xs"
                    title="Delete room"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            <button
              onClick={onNewRoom}
              className="text-xs text-gray-600 hover:text-gray-400 px-3 py-1 transition-colors"
            >
              + New Room
            </button>
          </div>
        </div>
      </div>

      {/* Bottom nav */}
      <div className="border-t border-gray-800 p-3 space-y-1">
        <button
          onClick={() => onNavigate('skills')}
          className={`w-full text-left px-3 py-3 md:py-2 rounded-lg flex items-center gap-2 text-sm transition-colors min-h-[44px] ${
            currentView === 'skills'
              ? 'bg-gray-800 text-white'
              : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
          }`}
        >
          📚 Skills
        </button>
        <button
          onClick={() => onNavigate('settings')}
          className={`w-full text-left px-3 py-3 md:py-2 rounded-lg flex items-center gap-2 text-sm transition-colors min-h-[44px] ${
            currentView === 'settings'
              ? 'bg-gray-800 text-white'
              : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
          }`}
        >
          ⚙️ Settings
        </button>
      </div>
    </div>
  );
}
