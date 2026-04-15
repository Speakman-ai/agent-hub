import { useState, useEffect, useRef } from 'react';
import {
  Building2,
  BookOpen,
  Settings,
  Clock,
  LayoutGrid,
  FileText,
  StickyNote,
  Trash2,
  GitFork,
  List,
  AlertTriangle,
} from 'lucide-react';
import { getServerBase } from '../utils/connection.js';
import OrgSwitcher from './OrgSwitcher.jsx';
import humanCron from '../../../shared/utils/humanCron.js';

export default function Sidebar({
  projects = [],
  agents: _agents,
  activeAgentId,
  onSelectAgent,
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onClearAllSessions,
  onClearInactiveSessions,
  onRenameSession,
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
  notesProjectId,
  threadsProjectId,
  unreadThreadCounts = {},
  activeReviews = {},
  subagentsBySession = {},
  deletingSessionIds = new Set(),
  deletingBulk = null,
}) {
  const [hoveredSession, setHoveredSession] = useState(null);
  const [hoveredRoom, setHoveredRoom] = useState(null);
  const [newRoomName, setNewRoomName] = useState('');
  const [showNewRoomInput, setShowNewRoomInput] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState({});
  const [collapsedAgents, setCollapsedAgents] = useState({});
  const [editingSessionId, setEditingSessionId] = useState(null);
  const [editingSessionName, setEditingSessionName] = useState('');
  const [confirmAction, setConfirmAction] = useState(null); // 'clear-all' | 'clear-inactive' | null
  const [serverVersion, setServerVersion] = useState(null);
  const renameSavedRef = useRef(false);

  const clientVersion = import.meta.env.VITE_APP_VERSION || 'unknown';

  useEffect(() => {
    const base = getServerBase();
    fetch(`${base}/api/health`)
      .then((r) => r.json())
      .then((data) => setServerVersion(data.version || null))
      .catch(() => setServerVersion(null));
  }, []);

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

  // humanCron imported from utils/humanCron.js

  // Find which project the active agent belongs to
  const activeProject = projects.find((p) => p.agents.some((a) => a.id === activeAgentId));

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
                    <span className="text-xs text-gray-600 flex-shrink-0">
                      {humanCron(cs.cron_schedule)}
                    </span>
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
                      <span className="text-gray-500 text-2xl leading-none flex items-center">
                        {isCollapsed ? '▸' : '▾'}
                      </span>
                    )}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onNavigate('kanban:' + project.id);
                    }}
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
                        const isTopLevel =
                          agent.role === 'lead' ||
                          agent.role === 'docs' ||
                          agent.role === 'intake' ||
                          subs.length > 0;
                        const isLead = agent.role === 'lead' || subs.length > 0;

                        return (
                          <div
                            key={agent.id}
                            style={indent > 0 ? { marginLeft: `${indent * 12}px` } : {}}
                          >
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
                                  <img
                                    src={agent.avatar}
                                    alt=""
                                    className="w-5 h-5 rounded-full object-cover"
                                  />
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
                                {activeReviews[agent.name] && (
                                  <span
                                    className="ml-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/20 text-amber-400 animate-pulse"
                                    title={`Reviewing: ${activeReviews[agent.name].cardTitle}`}
                                  >
                                    reviewing PR
                                  </span>
                                )}
                              </span>
                              {isActive && (
                                <button
                                  onClick={(e) => toggleAgentCollapse(agent.id, e)}
                                  className="text-gray-500 hover:text-gray-300 text-2xl leading-none flex items-center"
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
                                  const isEditing = editingSessionId === session.id;
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
                                      {isEditing ? (
                                        <input
                                          autoFocus
                                          value={editingSessionName}
                                          onChange={(e) => setEditingSessionName(e.target.value)}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter' && editingSessionName.trim()) {
                                              renameSavedRef.current = true;
                                              onRenameSession(
                                                session.id,
                                                editingSessionName.trim(),
                                              );
                                              setEditingSessionId(null);
                                            } else if (e.key === 'Escape') {
                                              renameSavedRef.current = true;
                                              setEditingSessionId(null);
                                            }
                                          }}
                                          onBlur={() => {
                                            if (renameSavedRef.current) {
                                              renameSavedRef.current = false;
                                              return;
                                            }
                                            if (
                                              editingSessionName.trim() &&
                                              editingSessionName.trim() !== session.name
                                            ) {
                                              onRenameSession(
                                                session.id,
                                                editingSessionName.trim(),
                                              );
                                            }
                                            setEditingSessionId(null);
                                          }}
                                          className="flex-1 text-xs bg-gray-700 text-gray-200 px-2 py-1.5 md:py-1 rounded outline-none focus:ring-1 focus:ring-indigo-500 mx-1"
                                        />
                                      ) : (
                                        <button
                                          onClick={() => {
                                            onSelectSession(session.id);
                                            onNavigate('chat');
                                          }}
                                          onDoubleClick={(e) => {
                                            e.stopPropagation();
                                            setEditingSessionId(session.id);
                                            setEditingSessionName(session.name);
                                          }}
                                          className="flex-1 text-left px-2 py-2 md:py-1.5 truncate text-xs flex items-center gap-1.5"
                                        >
                                          {isRunning && (
                                            <span
                                              className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0"
                                              title="Task running"
                                            />
                                          )}
                                          {subagentsBySession[session.id]?.running > 0 && (
                                            <span
                                              className="flex items-center gap-0.5 text-[9px] text-indigo-400 flex-shrink-0"
                                              title={`${subagentsBySession[session.id].running} subagent${subagentsBySession[session.id].running === 1 ? '' : 's'} running`}
                                            >
                                              <GitFork size={10} />
                                              {subagentsBySession[session.id].running}
                                            </span>
                                          )}
                                          <span className="truncate">{session.name}</span>
                                        </button>
                                      )}
                                      {deletingSessionIds.has(session.id) ? (
                                        <span className="pr-2 text-gray-500 text-xs animate-spin">
                                          ⟳
                                        </span>
                                      ) : hoveredSession === session.id && !isEditing ? (
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
                                      ) : null}
                                    </div>
                                  );
                                })}
                                <div className="flex items-center gap-1 mt-1">
                                  <button
                                    onClick={onNewSession}
                                    className="text-xs text-gray-600 hover:text-gray-400 px-2 py-1 transition-colors"
                                  >
                                    + New Session
                                  </button>
                                  {sessions.length > 0 && (
                                    <div className="ml-auto flex items-center gap-0.5 pr-1">
                                      <button
                                        onClick={() => setConfirmAction('clear-inactive')}
                                        disabled={!!deletingBulk}
                                        className="text-[10px] text-gray-600 hover:text-amber-400 px-1.5 py-0.5 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                        title="Clear inactive sessions"
                                      >
                                        {deletingBulk === 'inactive' ? '...' : 'Clear idle'}
                                      </button>
                                      <button
                                        onClick={() => setConfirmAction('clear-all')}
                                        disabled={!!deletingBulk}
                                        className="text-gray-600 hover:text-red-400 p-0.5 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                        title="Clear all sessions"
                                      >
                                        {deletingBulk === 'all' ? (
                                          <span className="text-xs animate-spin inline-block">
                                            ⟳
                                          </span>
                                        ) : (
                                          <Trash2 size={12} />
                                        )}
                                      </button>
                                    </div>
                                  )}
                                </div>
                                {/* Confirmation dialog */}
                                {confirmAction && (
                                  <div className="mx-1 mt-1 p-2 bg-gray-800 border border-gray-700 rounded-lg">
                                    <p className="text-xs text-gray-300 mb-2">
                                      {confirmAction === 'clear-all'
                                        ? `Delete all ${sessions.length} session${sessions.length !== 1 ? 's' : ''}? This cannot be undone.`
                                        : `Delete all idle sessions? Active sessions will be kept.`}
                                    </p>
                                    <div className="flex gap-2 justify-end">
                                      <button
                                        onClick={() => setConfirmAction(null)}
                                        className="text-xs px-2 py-1 text-gray-400 hover:text-gray-200 transition-colors"
                                      >
                                        Cancel
                                      </button>
                                      <button
                                        onClick={async () => {
                                          if (confirmAction === 'clear-all') {
                                            await onClearAllSessions();
                                          } else {
                                            await onClearInactiveSessions();
                                          }
                                          setConfirmAction(null);
                                        }}
                                        disabled={!!deletingBulk}
                                        className={`text-xs px-2 py-1 rounded transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
                                          confirmAction === 'clear-all'
                                            ? 'bg-red-600 hover:bg-red-500 text-white'
                                            : 'bg-amber-600 hover:bg-amber-500 text-white'
                                        }`}
                                      >
                                        {deletingBulk
                                          ? 'Deleting...'
                                          : confirmAction === 'clear-all'
                                            ? 'Delete All'
                                            : 'Delete Idle'}
                                      </button>
                                    </div>
                                  </div>
                                )}
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
                          <span className="text-gray-600 text-xs ml-auto">
                            {projectRoom.agents?.length || 0}
                          </span>
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

                    {/* Project notes */}
                    <button
                      onClick={() => onNavigate('notes', project.id)}
                      className={`w-full text-left px-3 py-1.5 rounded-lg mb-0.5 flex items-center gap-2 transition-colors text-xs ${
                        currentView === 'notes' && notesProjectId === project.id
                          ? 'bg-gray-800 text-white'
                          : 'text-gray-500 hover:bg-gray-800/50 hover:text-gray-300'
                      }`}
                    >
                      <StickyNote size={14} className="flex-shrink-0" />
                      <span className="truncate">Notes</span>
                    </button>

                    {/* Project threads */}
                    <button
                      onClick={() => onNavigate('threads', project.id)}
                      className={`w-full text-left px-3 py-1.5 rounded-lg mb-0.5 flex items-center gap-2 transition-colors text-xs ${
                        currentView.startsWith('threads') && threadsProjectId === project.id
                          ? 'bg-gray-800 text-white'
                          : 'text-gray-500 hover:bg-gray-800/50 hover:text-gray-300'
                      }`}
                    >
                      <List size={14} className="flex-shrink-0" />
                      <span className="truncate">Threads</span>
                      {unreadThreadCounts[project.id] > 0 && (
                        <span className="ml-auto flex-shrink-0 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-blue-500 text-[10px] font-bold text-white px-1">
                          {unreadThreadCounts[project.id] > 99
                            ? '99+'
                            : unreadThreadCounts[project.id]}
                        </span>
                      )}
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
          <span className="flex items-center gap-2">
            <BookOpen size={16} />
            <span>Skills</span>
          </span>
        </button>
        <button
          onClick={() => onNavigate('settings')}
          className={`w-full text-left px-3 py-3 md:py-2 rounded-lg flex items-center gap-2 text-sm transition-colors min-h-[44px] ${
            currentView === 'settings'
              ? 'bg-gray-800 text-white'
              : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
          }`}
        >
          <span className="flex items-center gap-2">
            <Settings size={16} />
            <span>Settings</span>
          </span>
        </button>
        {/* Version display */}
        <div className="px-3 pt-2 text-xs text-gray-500 flex items-center gap-1.5">
          <span>v{clientVersion}</span>
          {serverVersion && serverVersion !== clientVersion && (
            <span
              className="inline-flex items-center gap-1 text-amber-400"
              title={`Client v${clientVersion} · Server v${serverVersion}`}
            >
              <AlertTriangle size={12} />
              <span>server v{serverVersion}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
