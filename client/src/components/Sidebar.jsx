import React, { useState } from 'react';
import { Building2, BookOpen, Settings, Clock, LayoutGrid, FileText } from 'lucide-react';
import OrgSwitcher from './OrgSwitcher.jsx';

export default function Sidebar({
  projects = [],
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
  onOpenProject,
  cronSessions = [],
  wikiProjectId,
}) {
  const [hoveredSession, setHoveredSession] = useState(null);
  const [hoveredRoom, setHoveredRoom] = useState(null);
  const [newRoomName, setNewRoomName] = useState('');
  const [showNewRoomInput, setShowNewRoomInput] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState({});
  const [collapsedAgents, setCollapsedAgents] = useState({});

  const toggleProjectCollapse = (projectId, e) => {
    e.stopPropagation();
    setCollapsedProjects((prev) => ({ ...prev, [projectId]: !prev[projectId] }));
  };

  const toggleAgentCollapse = (agentId, e) => {
    e.stopPropagation();
    setCollapsedAgents((prev) => ({ ...prev, [agentId]: !prev[agentId] }));
  };

  const isRecent = (dateStr) => {
    if (!dateStr) return false;
    const d = dateStr.includes('T') ? new Date(dateStr) : new Date(dateStr + 'Z');
    return Date.now() - d.getTime() < 30 * 60 * 1000;
  };

  function humanSchedule(cron) {
    if (!cron) return '';
    const p = cron.split(' ');
    if (p[0].startsWith('*/') && p[1] === '*') return `every ${p[0].slice(2)}m`;
    if (p[0] === '0' && p[1].startsWith('*/')) return `every ${p[1].slice(2)}h`;
    if (p[0] === '0' && /^\d+$/.test(p[1]) && p[2] === '*') {
      const h = parseInt(p[1]);
      return `daily ${h > 12 ? h - 12 : h}${h >= 12 ? 'pm' : 'am'}`;
    }
    return cron;
  }

  // Find which project the active agent belongs to
  const activeProject = projects.find((p) =>
    p.agents.some((a) => a.id === activeAgentId)
  );

  return (
    <div className="sidebar-container bg-gray-900 border-r border-gray-800 flex flex-col h-full electron-no-drag">
      {/* Header — Org Switcher */}
      <div className="p-4 border-b border-gray-800">
        <OrgSwitcher onNavigateSettings={() => onNavigate('settings:orgs')} />
      </div>

      {/* Projects & Agents */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-3">
          {cronSessions.length > 0 && (
            <div className="mb-4">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 px-2 flex items-center gap-1.5">
                <Clock size={12} />
                Scheduled Tasks
              </div>
              {cronSessions.map((cs) => {
                const isRunning = !!activeTaskSessionIds[cs.id];
                return (
                  <button
                    key={cs.id}
                    onClick={() => {
                      onSelectSession(cs.id);
                      onNavigate('chat');
                    }}
                    className={`w-full text-left px-3 py-2 rounded-lg mb-0.5 flex items-center gap-2 transition-colors ${
                      activeSessionId === cs.id && currentView === 'chat'
                        ? 'bg-gray-800 text-white'
                        : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
                    }`}
                  >
                    {isRunning && (
                      <span
                        className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0"
                        title="Task running"
                      />
                    )}
                    <span className="flex-1 truncate text-sm">{cs.cron_name}</span>
                    <span className="text-xs text-gray-600 flex-shrink-0">{humanSchedule(cs.cron_schedule)}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 px-2">
            Projects
          </div>

          {onOpenProject && (
            <button
              onClick={onOpenProject}
              className="w-full text-left px-2 py-2 mb-2 rounded-lg flex items-center gap-2 text-gray-400 hover:bg-gray-800/50 hover:text-gray-200 transition-colors border border-dashed border-gray-700 hover:border-gray-500"
            >
              <span className="text-sm">+</span>
              <span className="text-sm font-medium">Open Project</span>
            </button>
          )}

          {projects.map((project, index) => {
            const activeAgents = project.agents.filter((a) => a.active !== false);
            if (activeAgents.length === 0) return null;

            const isActiveProject = activeProject?.id === project.id;
            const isCollapsed = collapsedProjects[project.id];

            return (
              <div key={project.id} className="mb-1">
                {index > 0 && <div className="border-t border-gray-800/50 my-2 mx-2" />}
                {/* Project header */}
                <div className="group flex items-center">
                  <button
                    onClick={(e) => {
                      // If project only has one agent, select it directly
                      if (activeAgents.length === 1) {
                        onSelectAgent(activeAgents[0].id);
                        onNavigate('chat');
                      } else {
                        toggleProjectCollapse(project.id, e);
                      }
                    }}
                    className={`flex-1 text-left px-2 py-2 rounded-lg flex items-center gap-2 transition-colors ${
                      isActiveProject && currentView === 'chat'
                        ? 'text-white'
                        : 'text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-sm block flex-shrink-0"
                      style={{ backgroundColor: project.color }}
                    />
                    <span className="flex-1 truncate text-sm font-medium">{project.name}</span>
                    {activeAgents.length > 1 && (
                      <span className="text-gray-500 text-2xl leading-none">
                        {isCollapsed ? '▸' : '▾'}
                      </span>
                    )}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onNavigate('kanban:' + project.id); }}
                    className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-gray-300 transition-opacity p-0.5"
                    title="Board"
                  >
                    <LayoutGrid size={14} />
                  </button>
                </div>

                {/* Agents within project (auto-expand if single agent) */}
                {(!isCollapsed || activeAgents.length === 1) && (
                  <div className={activeAgents.length > 1 ? 'ml-3' : ''}>
                    {(() => {
                      // Separate top-level agents from sub-agents
                      const topLevel = activeAgents.filter((a) => !a.parentAgentId);
                      const subAgentMap = {};
                      activeAgents.forEach((a) => {
                        if (a.parentAgentId) {
                          if (!subAgentMap[a.parentAgentId]) subAgentMap[a.parentAgentId] = [];
                          subAgentMap[a.parentAgentId].push(a);
                        }
                      });

                      const renderAgent = (agent, indent = 0) => {
                        const isActive = activeAgentId === agent.id;
                        const subs = subAgentMap[agent.id] || [];
                        const isTopLevel = agent.role === 'lead' || agent.role === 'docs' || agent.role === 'intake' || subs.length > 0;
                        const isLead = agent.role === 'lead' || subs.length > 0;

                        return (
                          <div key={agent.id} style={indent > 0 ? { marginLeft: `${indent * 12}px` } : {}}>
                            <button
                              onClick={() => {
                                onSelectAgent(agent.id);
                                onNavigate('chat');
                              }}
                              className={`w-full text-left px-3 py-2 rounded-lg mb-0.5 flex items-center gap-2.5 transition-colors ${
                                isActive && currentView === 'chat'
                                  ? 'bg-gray-800 text-white'
                                  : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
                              }`}
                            >
                              <div className="relative flex-shrink-0">
                                {indent > 0 && (
                                  <span className="absolute -left-3 top-1/2 w-2 border-t border-gray-700" />
                                )}
                                {agent.avatar ? (
                                  <img src={agent.avatar} alt="" className="w-5 h-5 rounded-full object-cover" />
                                ) : (
                                  <span
                                    className={`block ${isTopLevel ? 'w-2.5 h-2.5 rounded-sm' : 'w-2.5 h-2.5 rounded-full'}`}
                                    style={{ backgroundColor: agent.color }}
                                  />
                                )}
                                {isRecent(agent.lastActivity) && (
                                  <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-emerald-500 rounded-full border border-gray-900" />
                                )}
                              </div>
                              <span className="flex-1 truncate text-sm">
                                {agent.name}
                                {isLead && <span className="text-xs text-gray-600 ml-1">lead</span>}
                              </span>
                              {isActive && (
                                <button
                                  onClick={(e) => toggleAgentCollapse(agent.id, e)}
                                  className="text-gray-500 hover:text-gray-300 text-2xl leading-none"
                                >
                                  {collapsedAgents[agent.id] ? '▸' : '▾'}
                                </button>
                              )}
                            </button>

                            {/* Sessions for active agent */}
                            {isActive && !collapsedAgents[agent.id] && (
                              <div className="ml-5 mb-2">
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

                            {/* Render sub-agents nested under lead */}
                            {subs.length > 0 && (!collapsedAgents[agent.id] || isActive) && (
                              <div className="border-l border-gray-700/50 ml-3">
                                {subs.map((sub) => renderAgent(sub, indent + 1))}
                              </div>
                            )}
                          </div>
                        );
                      };

                      return topLevel.map((agent) => renderAgent(agent, 0));
                    })()}

                    {/* Project conference room */}
                    {(() => {
                      const projectRoom = rooms.find((r) => r.project_id === project.id);
                      if (!projectRoom) return null;
                      return (
                        <button
                          onClick={() => {
                            onSelectRoom(projectRoom.id);
                            onNavigate('room');
                          }}
                          className={`w-full text-left px-3 py-1.5 rounded-lg mb-0.5 flex items-center gap-2 transition-colors text-xs ${
                            activeRoomId === projectRoom.id && currentView === 'room'
                              ? 'bg-gray-800 text-white'
                              : 'text-gray-500 hover:bg-gray-800/50 hover:text-gray-300'
                          }`}
                        >
                          <Building2 size={14} className="flex-shrink-0" />
                          <span className="truncate">Conference Room</span>
                          <span className="text-gray-600 text-xs ml-auto">{projectRoom.agents?.length || 0}</span>
                        </button>
                      );
                    })()}

                    {/* Project wiki */}
                    <button
                      onClick={() => onNavigate('wiki', project.id)}
                      className={`w-full text-left px-3 py-1.5 rounded-lg mb-0.5 flex items-center gap-2 transition-colors text-xs ${
                        currentView === 'wiki' && wikiProjectId === project.id
                          ? 'bg-gray-800 text-white'
                          : 'text-gray-500 hover:bg-gray-800/50 hover:text-gray-300'
                      }`}
                    >
                      <FileText size={14} className="flex-shrink-0" />
                      <span className="truncate">Wiki</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {/* Ad-hoc Conference Rooms (not tied to a project) */}
          {(() => {
            const adHocRooms = rooms.filter((r) => !r.project_id);
            if (adHocRooms.length === 0 && !onNewRoom) return null;
            return (
          <div className="mt-4">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 px-2">
              Conference Rooms
            </div>
            {adHocRooms.map((room) => (
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
                  <Building2 size={14} className="flex-shrink-0" />
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
            {showNewRoomInput ? (
              <input
                autoFocus
                value={newRoomName}
                onChange={(e) => setNewRoomName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newRoomName.trim()) {
                    onNewRoom(newRoomName.trim());
                    setNewRoomName('');
                    setShowNewRoomInput(false);
                  } else if (e.key === 'Escape') {
                    setNewRoomName('');
                    setShowNewRoomInput(false);
                  }
                }}
                onBlur={() => {
                  setNewRoomName('');
                  setShowNewRoomInput(false);
                }}
                placeholder="Room name..."
                className="w-full text-xs bg-gray-800 text-gray-200 px-3 py-1 rounded outline-none focus:ring-1 focus:ring-indigo-500"
              />
            ) : (
              <button
                onClick={() => setShowNewRoomInput(true)}
                className="text-xs text-gray-600 hover:text-gray-400 px-3 py-1 transition-colors"
              >
                + New Room
              </button>
            )}
          </div>
            );
          })()}
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
          <span className="flex items-center gap-2"><BookOpen size={16} /><span>Skills</span></span>
        </button>
        <button
          onClick={() => onNavigate('settings')}
          className={`w-full text-left px-3 py-3 md:py-2 rounded-lg flex items-center gap-2 text-sm transition-colors min-h-[44px] ${
            currentView === 'settings'
              ? 'bg-gray-800 text-white'
              : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
          }`}
        >
          <span className="flex items-center gap-2"><Settings size={16} /><span>Settings</span></span>
        </button>
      </div>
    </div>
  );
}
