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
  GitPullRequest,
  ExternalLink,
  List,
  ListOrdered,
  AlertTriangle,
  BarChart3,
  Plus,
  Palette,
  Archive,
  RotateCcw,
  Loader2,
  Lock,
  GripVertical,
} from 'lucide-react';
import { getServerBase } from '../utils/connection.js';
import { useClientBuildVersion } from '../hooks/useClientBuildVersion.js';
import OrgSwitcher from './OrgSwitcher.jsx';
import { isElectron } from '../utils/isElectron.js';
import humanCron from '../../../shared/utils/humanCron.js';
import {
  inferPrUrlFromSessionTitle,
  isResolvePrSessionTitle,
} from '../../../shared/utils/sessionTitlePr.js';
import AgentAvatar from './AgentAvatar.jsx';
import { daysUntilPurge } from '../utils/time.js';
import SidebarSessionOrchestration from './SidebarSessionOrchestration.jsx';

export default function Sidebar({
  /** When true, shows a loading overlay on the nav body (org switcher stays usable). */
  isLoading = false,
  projects = [],
  agents: _agents,
  activeAgentId,
  onSelectAgent,
  sessions,
  activeSessionId,
  onSelectSession,
  /** When set (from App), switches to the session's agent then opens chat. */
  onFocusSession,
  onNewSession,
  onDeleteSession,
  onClearAllSessions,
  onClearInactiveSessions,
  onRenameSession,
  onNavigate,
  currentView,
  activeTaskSessionIds = {},
  /**
   * Map of sessionId → { askIds, agentId, sessionName } for sessions that
   * have paused on an `agenthub:ask` picker (or otherwise stopped waiting for
   * user input). Drives the green "needs you" dot in the sidebar — distinct
   * from `activeTaskSessionIds` (which is "working", rendered subdued).
   */
  awaitingInputBySession = {},
  rooms = [],
  activeRoomId,
  onSelectRoom,
  onNewRoom,
  onDeleteRoom,
  onOpenProject,
  onImportProject,
  /**
   * Persist a new sidebar project order. Called with the full `projects`
   * id list in the desired order (the parent is responsible for the
   * optimistic local-state update + API call). When omitted, drag-and-drop
   * is disabled and project headers render without the grip handle.
   */
  onReorderProjects,
  cronSessions = [],
  wikiProjectId,
  notesProjectId,
  threadsProjectId,
  pullsProjectId,
  workflowBadgeByProject = {},
  unreadThreadCounts = {},
  activeReviews = {},
  designs = [],
  activeDesignId,
  onSelectDesign,
  subagentsBySession = {},
  changesReadyBySession = {},
  deletingSessionIds = new Set(),
  deletingBulk = null,
  archivedSessions = [],
  onRestoreSession,
  restoringSessionIds = new Set(),
  /** Optional PAV controls for the active chat session (left sidebar). */
  onOrchestrationSave,
  showToast,
  /** Electron: parent provides canonical /api/health so footer matches update prompt. */
  electronSuppressHealthFetch = false,
  electronHealthSnapshot = null,
}) {
  const [hoveredSession, setHoveredSession] = useState(null);
  const [hoveredRoom, setHoveredRoom] = useState(null);
  const [newRoomName, setNewRoomName] = useState('');
  const [showNewRoomInput, setShowNewRoomInput] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState({});
  const [collapsedAgents, setCollapsedAgents] = useState({});
  // Project drag-and-drop state. `draggedProjectId` is the row the user
  // is currently dragging; `dragOverProjectId` is whichever other row has
  // a pending drop indicator. Both reset on dragend / drop / cancel.
  const [draggedProjectId, setDraggedProjectId] = useState(null);
  const [dragOverProjectId, setDragOverProjectId] = useState(null);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState(null);
  const [editingSessionName, setEditingSessionName] = useState('');
  const [confirmAction, setConfirmAction] = useState(null); // 'clear-all' | 'clear-inactive' | null
  const [serverVersion, setServerVersion] = useState(null);
  const [serverGitHash, setServerGitHash] = useState(null);
  const renameSavedRef = useRef(false);

  const focusSession = (agentId, sessionId) => {
    if (onFocusSession) {
      onFocusSession(agentId, sessionId);
    } else {
      onSelectSession(sessionId);
      onNavigate('chat');
    }
  };

  const clientVersion = useClientBuildVersion() || 'unknown';
  const clientGitHash = import.meta.env.VITE_GIT_HASH || '';

  useEffect(() => {
    if (electronSuppressHealthFetch) return;
    const base = getServerBase();
    fetch(`${base}/api/health`)
      .then((r) => r.json())
      .then((data) => {
        setServerVersion(data.version || null);
        setServerGitHash(data.gitHash || null);
      })
      .catch(() => {
        setServerVersion(null);
        setServerGitHash(null);
      });
  }, [electronSuppressHealthFetch]);

  const footerServerVersion = electronSuppressHealthFetch
    ? (electronHealthSnapshot?.version ?? null)
    : serverVersion;
  const footerServerGitHash = electronSuppressHealthFetch
    ? (electronHealthSnapshot?.gitHash ?? null)
    : serverGitHash;

  const toggleProjectCollapse = (projectId, e) => {
    e.stopPropagation();
    setCollapsedProjects((prev) => ({ ...prev, [projectId]: !prev[projectId] }));
  };

  const toggleAgentCollapse = (agentId, e) => {
    e.stopPropagation();
    setCollapsedAgents((prev) => ({ ...prev, [agentId]: !prev[agentId] }));
  };

  // Move `sourceId` into the slot currently occupied by `targetId`,
  // preserving the order of every other project. Hands the resulting
  // full id list (every project the sidebar received, not just the
  // rendered subset) back to the parent so the server reorder payload
  // matches the caller-visible set.
  const handleReorderDrop = (sourceId, targetId) => {
    if (!onReorderProjects) return;
    if (!sourceId || !targetId || sourceId === targetId) return;
    const ids = projects.map((p) => p.id);
    const srcIdx = ids.indexOf(sourceId);
    const tgtIdx = ids.indexOf(targetId);
    if (srcIdx === -1 || tgtIdx === -1) return;
    ids.splice(srcIdx, 1);
    const insertIdx = srcIdx < tgtIdx ? tgtIdx - 1 : tgtIdx;
    ids.splice(insertIdx, 0, sourceId);
    onReorderProjects(ids);
  };

  const isRecent = (dateStr) => {
    if (!dateStr) return false;
    const d = dateStr.includes('T') ? new Date(dateStr) : new Date(dateStr + 'Z');
    return Date.now() - d.getTime() < 30 * 60 * 1000;
  };

  // humanCron imported from utils/humanCron.js

  // Find which project the active agent belongs to
  const activeProject = projects.find((p) => p.agents.some((a) => a.id === activeAgentId));

  // A session is "actionable" when it must remain visible regardless of collapse state:
  // - it's currently running (tracked via activeTaskSessionIds)
  // - it has a pending PR/changes ready (tracked via changesReadyBySession), including
  //   `[Resolve PR #N]` sessions — so users can reopen them from the collapsed sidebar.
  //   The misleading "create PR" purple glyph is suppressed for those titles separately
  //   (see `showCreatePrReadyGlyph`); an external-link affordance (`resolvePrHref`) carries
  //   the "existing PR" semantics instead.
  // - it's blocked on an `agenthub:ask` picker awaiting user input
  //   (tracked via awaitingInputBySession). Stays visible behind ▸ so users
  //   never miss a session that needs their reply.
  const isSessionActionable = (session) =>
    !!activeTaskSessionIds[session.id] ||
    !!changesReadyBySession[session.id] ||
    !!awaitingInputBySession[session.id];

  const orchestrationSession =
    currentView === 'chat' && activeSessionId
      ? (sessions.find((s) => s.id === activeSessionId) ?? null)
      : null;

  return (
    <div className="sidebar-container bg-gray-900 border-r border-gray-800 flex flex-col h-full electron-no-drag">
      {/* Header — Org Switcher (Electron-only).
          The web app is locked to a single Hub server, so the
          multi-org / server-switcher concept is meaningless in a
          browser context. Only Electron — which can hop between
          Hub servers via its file-backed remote-orgs store — needs
          the switcher. */}
      {isElectron() && (
        <div className="p-4 border-b border-gray-800">
          <OrgSwitcher onNavigateSettings={() => onNavigate('settings:orgs')} />
        </div>
      )}

      {/* Projects & Agents */}
      <div className="flex-1 overflow-y-auto min-h-0 relative">
        {isLoading && (
          <div
            className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-gray-900/85 backdrop-blur-[1px] pointer-events-none"
            data-testid="sidebar-loading"
            aria-busy="true"
            aria-label="Loading sidebar"
          >
            <Loader2 className="animate-spin text-indigo-400" size={22} />
            <span className="text-xs text-gray-500">Loading workspace…</span>
          </div>
        )}
        <div className="p-3">
          {/* Org-scoped dashboard — sits above the project list because it's
              not tied to any single project. */}
          <button
            onClick={() => onNavigate('dashboard')}
            className={`w-full text-left px-3 py-2 rounded-lg mb-3 flex items-center gap-2 transition-colors ${
              currentView === 'dashboard'
                ? 'bg-gray-800 text-white'
                : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
            }`}
          >
            <BarChart3 size={14} className="flex-shrink-0" />
            <span className="flex-1 truncate text-sm font-medium">Dashboard</span>
          </button>

          {cronSessions.length > 0 && (
            <div className="mb-4">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 px-2 flex items-center gap-1.5">
                <Clock size={12} />
                Scheduled Tasks
              </div>
              {cronSessions.map((cs) => {
                const isRunning = !!activeTaskSessionIds[cs.id];
                const isAwaitingInput = !isRunning && !!awaitingInputBySession[cs.id];
                return (
                  <button
                    type="button"
                    key={cs.id}
                    onClick={() => focusSession(cs.agent_id || activeAgentId, cs.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg mb-0.5 flex items-center gap-2 transition-colors cursor-pointer ${
                      activeSessionId === cs.id && currentView === 'chat'
                        ? 'bg-gray-800 text-white'
                        : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
                    }`}
                  >
                    {isAwaitingInput ? (
                      <span
                        data-testid={`awaiting-input-indicator-${cs.id}`}
                        className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse flex-shrink-0 ring-2 ring-emerald-400/30"
                        title="Waiting for your input"
                      />
                    ) : isRunning ? (
                      <Loader2
                        size={10}
                        className="text-gray-500 animate-spin flex-shrink-0"
                        aria-label="Task running"
                      />
                    ) : null}
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
              type="button"
              data-testid="sidebar-new-project-cta"
              onClick={onOpenProject}
              className="w-full text-left px-3 py-2.5 mb-2 rounded-xl flex items-center gap-2 bg-emerald-600/90 hover:bg-emerald-500 text-white shadow-md shadow-emerald-900/20 transition-colors font-medium text-sm"
            >
              <Plus size={18} strokeWidth={2.5} className="shrink-0" aria-hidden />
              <span>New Project</span>
            </button>
          )}

          {onImportProject && (
            <button
              type="button"
              data-testid="sidebar-import-project-cta"
              onClick={onImportProject}
              className="w-full text-left px-2.5 py-1.5 mb-2 rounded-lg flex items-center gap-2 text-gray-400 hover:text-gray-200 hover:bg-gray-800/60 transition-colors text-xs"
            >
              <Plus size={14} strokeWidth={2} className="shrink-0" aria-hidden />
              <span>Import existing project</span>
            </button>
          )}

          {projects.map((project, index) => {
            const activeAgents = project.agents.filter((a) => a.active !== false);
            if (activeAgents.length === 0) return null;

            const isActiveProject = activeProject?.id === project.id;
            const isCollapsed = collapsedProjects[project.id];

            const isBeingDragged = draggedProjectId === project.id;
            const isDropTarget =
              dragOverProjectId === project.id &&
              draggedProjectId &&
              draggedProjectId !== project.id;
            const dragEnabled = !!onReorderProjects;

            return (
              <div
                key={project.id}
                className={`mb-1 ${isBeingDragged ? 'opacity-40' : ''} ${
                  isDropTarget ? 'border-t-2 border-emerald-500' : 'border-t-2 border-transparent'
                }`}
                data-testid={`sidebar-project-row-${project.id}`}
                onDragOver={
                  dragEnabled
                    ? (e) => {
                        if (!draggedProjectId || draggedProjectId === project.id) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        if (dragOverProjectId !== project.id) setDragOverProjectId(project.id);
                      }
                    : undefined
                }
                onDragLeave={
                  dragEnabled
                    ? (e) => {
                        // dragleave fires when the pointer crosses into a
                        // child element too — guard against the indicator
                        // flickering as the cursor moves over agent rows
                        // inside the same project block.
                        if (e.currentTarget.contains(e.relatedTarget)) return;
                        if (dragOverProjectId === project.id) setDragOverProjectId(null);
                      }
                    : undefined
                }
                onDrop={
                  dragEnabled
                    ? (e) => {
                        e.preventDefault();
                        const sourceId = e.dataTransfer.getData('text/plain') || draggedProjectId;
                        handleReorderDrop(sourceId, project.id);
                        setDraggedProjectId(null);
                        setDragOverProjectId(null);
                      }
                    : undefined
                }
              >
                {index > 0 && !isDropTarget && (
                  <div className="border-t border-gray-800/50 my-2 mx-2" />
                )}
                {/* Project header */}
                <div className="group flex items-center">
                  {dragEnabled && (
                    // Grip is the only drag source — making the entire row
                    // `draggable` would steal the gesture from agent clicks
                    // and the collapse chevron, which feel like buttons.
                    // The row keeps its drop-target handlers above.
                    <span
                      draggable
                      data-drag-handle
                      data-testid={`sidebar-project-drag-handle-${project.id}`}
                      role="button"
                      tabIndex={-1}
                      aria-label="Drag to reorder project"
                      onDragStart={(e) => {
                        e.stopPropagation();
                        e.dataTransfer.effectAllowed = 'move';
                        try {
                          e.dataTransfer.setData('text/plain', project.id);
                        } catch {
                          /* some browsers block setData under certain conditions */
                        }
                        // Use the surrounding row as the drag preview so the
                        // ghost matches what the user is actually moving,
                        // not a 12px icon.
                        const row = e.currentTarget.closest(
                          `[data-testid="sidebar-project-row-${project.id}"]`,
                        );
                        if (row) {
                          try {
                            e.dataTransfer.setDragImage(row, 0, 0);
                          } catch {
                            /* setDragImage can throw in some embedded contexts */
                          }
                        }
                        setDraggedProjectId(project.id);
                      }}
                      onDragEnd={() => {
                        setDraggedProjectId(null);
                        setDragOverProjectId(null);
                      }}
                      className="flex-shrink-0 cursor-grab active:cursor-grabbing px-0.5 py-1 text-gray-700 group-hover:text-gray-500"
                    >
                      <GripVertical size={12} />
                    </span>
                  )}
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
                    {project.visibility === 'private' && (
                      <Lock
                        size={11}
                        className="text-gray-500 flex-shrink-0"
                        aria-label="Private project"
                        data-testid={`project-private-icon-${project.id}`}
                      />
                    )}
                    {project.mode === 'workflow' && (
                      <span className="text-[10px] font-medium text-violet-400/90 uppercase tracking-wide flex-shrink-0">
                        Wf
                      </span>
                    )}
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
                            <div
                              className={`w-full flex items-center gap-1 rounded-lg mb-0.5 transition-colors ${
                                isActive && currentView === 'chat'
                                  ? 'bg-gray-800 text-white'
                                  : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
                              }`}
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  onSelectAgent(agent.id);
                                  onNavigate('chat');
                                }}
                                className={`flex-1 min-w-0 text-left px-3 py-2 rounded-lg flex items-center gap-2.5 transition-colors cursor-pointer ${
                                  isActive && currentView === 'chat'
                                    ? 'text-white'
                                    : 'text-gray-400 hover:text-gray-200'
                                }`}
                              >
                                <div className="relative flex-shrink-0">
                                  {indent > 0 && (
                                    <span className="absolute -left-3 top-1/2 w-2 border-t border-gray-700" />
                                  )}
                                  {agent.avatar ? (
                                    <AgentAvatar
                                      avatar={agent.avatar}
                                      color={agent.color}
                                      size={20}
                                      apiBase={getServerBase()}
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
                                  {isLead && (
                                    <span className="text-xs text-gray-600 ml-1">lead</span>
                                  )}
                                </span>
                              </button>
                              {project.mode !== 'workflow' && activeReviews[agent.name] && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    const sid = activeReviews[agent.name]?.sessionId;
                                    if (sid) focusSession(agent.id, sid);
                                  }}
                                  className="flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-1 mr-1 rounded text-[10px] font-medium bg-amber-500/20 text-amber-400 animate-pulse cursor-pointer hover:bg-amber-500/30"
                                  title={`Reviewing: ${activeReviews[agent.name].cardTitle}`}
                                >
                                  reviewing PR
                                </button>
                              )}
                              {isActive && (
                                <button
                                  type="button"
                                  onClick={(e) => toggleAgentCollapse(agent.id, e)}
                                  className="flex-shrink-0 pr-2 text-gray-500 hover:text-gray-300 text-2xl leading-none flex items-center cursor-pointer"
                                >
                                  {collapsedAgents[agent.id] ? '▸' : '▾'}
                                </button>
                              )}
                            </div>

                            {/* Sessions for active agent.
                                When the agent row is collapsed we still render
                                "actionable" sessions (running / PR-ready) so users
                                don't miss them behind the ▸ toggle. */}
                            {isActive &&
                              (() => {
                                const agentCollapsed = !!collapsedAgents[agent.id];
                                const visibleSessions = agentCollapsed
                                  ? sessions.filter(isSessionActionable)
                                  : sessions;
                                if (agentCollapsed && visibleSessions.length === 0) return null;
                                return (
                                  <div className="ml-5 mb-2" data-testid="agent-sessions-list">
                                    {visibleSessions.map((session) => {
                                      const isRunning = !!activeTaskSessionIds[session.id];
                                      const isAwaitingInput =
                                        !isRunning && !!awaitingInputBySession[session.id];
                                      const isEditing = editingSessionId === session.id;
                                      const prReady = changesReadyBySession[session.id];
                                      const resolvePrHref =
                                        prReady && isResolvePrSessionTitle(session.name)
                                          ? inferPrUrlFromSessionTitle(
                                              session.name,
                                              project.githubRepo,
                                            )
                                          : null;
                                      const showCreatePrReadyGlyph =
                                        !!prReady &&
                                        !resolvePrHref &&
                                        !isResolvePrSessionTitle(session.name);
                                      return (
                                        <div
                                          key={session.id}
                                          onMouseEnter={() => setHoveredSession(session.id)}
                                          onMouseLeave={() => setHoveredSession(null)}
                                          className={`group relative flex items-center rounded-md mb-0.5 transition-colors ${
                                            activeSessionId === session.id
                                              ? 'bg-gray-800 text-white'
                                              : 'text-gray-500 hover:bg-gray-800/50 hover:text-gray-300'
                                          }`}
                                        >
                                          {isEditing ? (
                                            <input
                                              autoFocus
                                              value={editingSessionName}
                                              onChange={(e) =>
                                                setEditingSessionName(e.target.value)
                                              }
                                              onKeyDown={(e) => {
                                                if (
                                                  e.key === 'Enter' &&
                                                  editingSessionName.trim()
                                                ) {
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
                                            <>
                                              {resolvePrHref && (
                                                <button
                                                  type="button"
                                                  data-testid="resolve-pr-external-link"
                                                  className="flex-shrink-0 p-1 mr-0.5 rounded text-sky-400 hover:text-sky-300 hover:bg-gray-700/50"
                                                  title="Open existing PR on GitHub"
                                                  onClick={(e) => {
                                                    e.stopPropagation();
                                                    window.open(
                                                      resolvePrHref,
                                                      '_blank',
                                                      'noopener,noreferrer',
                                                    );
                                                  }}
                                                >
                                                  <ExternalLink size={11} />
                                                </button>
                                              )}
                                              <button
                                                type="button"
                                                onClick={() => focusSession(agent.id, session.id)}
                                                onDoubleClick={(e) => {
                                                  e.stopPropagation();
                                                  setEditingSessionId(session.id);
                                                  setEditingSessionName(session.name);
                                                }}
                                                className="flex-1 min-w-0 text-left px-2 py-2 md:py-1.5 pr-7 truncate text-xs flex items-center gap-1.5 cursor-pointer"
                                              >
                                                {isAwaitingInput ? (
                                                  <span
                                                    data-testid={`awaiting-input-indicator-${session.id}`}
                                                    className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse flex-shrink-0 ring-2 ring-emerald-400/30"
                                                    title="Waiting for your input"
                                                  />
                                                ) : isRunning ? (
                                                  <Loader2
                                                    size={10}
                                                    data-testid={`session-running-indicator-${session.id}`}
                                                    className="text-gray-500 animate-spin flex-shrink-0"
                                                    aria-label="Task running"
                                                  />
                                                ) : null}
                                                {subagentsBySession[session.id]?.running > 0 && (
                                                  <span
                                                    className="flex items-center gap-0.5 text-[9px] text-indigo-400 flex-shrink-0"
                                                    title={`${subagentsBySession[session.id].running} subagent${subagentsBySession[session.id].running === 1 ? '' : 's'} running`}
                                                  >
                                                    <GitFork size={10} />
                                                    {subagentsBySession[session.id].running}
                                                  </span>
                                                )}
                                                {showCreatePrReadyGlyph && (
                                                  <span
                                                    data-testid="pr-ready-indicator"
                                                    className="flex items-center text-purple-400 flex-shrink-0 animate-pulse"
                                                    title={`PR ready to create${prReady.branch ? ` (${prReady.branch})` : ''}`}
                                                  >
                                                    <GitPullRequest size={11} />
                                                  </span>
                                                )}
                                                <span className="truncate">{session.name}</span>
                                              </button>
                                            </>
                                          )}
                                          {deletingSessionIds.has(session.id) ? (
                                            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 text-xs animate-spin pointer-events-none">
                                              ⟳
                                            </span>
                                          ) : hoveredSession === session.id && !isEditing ? (
                                            <button
                                              type="button"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                onDeleteSession(session.id);
                                              }}
                                              className="absolute right-1 top-1/2 -translate-y-1/2 z-10 p-1.5 text-gray-600 hover:text-red-400 text-xs rounded hover:bg-gray-700/80"
                                              title="Delete session"
                                            >
                                              ✕
                                            </button>
                                          ) : null}
                                        </div>
                                      );
                                    })}
                                    {!agentCollapsed && (
                                      <>
                                        <div className="flex items-center gap-1 mt-1">
                                          {/* Reviewer agents are spawned exclusively by the
                                              GitHub PR webhook. The server rejects manual
                                              POST /api/agents/:id/sessions with role=reviewer,
                                              so we hide the affordance instead of letting it
                                              error out. */}
                                          {agent.role !== 'reviewer' && (
                                            <button
                                              onClick={onNewSession}
                                              className="text-xs text-gray-600 hover:text-gray-400 px-2 py-1 transition-colors"
                                            >
                                              + New Session
                                            </button>
                                          )}
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
                                        {/* Archived (soft-deleted) sessions —
                                            recovery window is 24 hours, server
                                            enforces the cut-off. Collapsed by
                                            default to keep the sidebar quiet
                                            when nothing is pending recovery. */}
                                        {archivedSessions.length > 0 && (
                                          <div
                                            className="mt-2 border-t border-gray-800/50 pt-1"
                                            data-testid="archived-sessions-section"
                                          >
                                            <button
                                              onClick={() => setArchivedExpanded((v) => !v)}
                                              className="w-full text-left px-2 py-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-gray-600 hover:text-gray-400 transition-colors"
                                            >
                                              <Archive size={10} />
                                              <span className="flex-1">
                                                Archived ({archivedSessions.length})
                                              </span>
                                              <span className="text-gray-600">
                                                {archivedExpanded ? '▾' : '▸'}
                                              </span>
                                            </button>
                                            {archivedExpanded && (
                                              <div data-testid="archived-sessions-list">
                                                {archivedSessions.map((a) => {
                                                  const purge = daysUntilPurge(a.deleted_at);
                                                  // App.jsx always passes a Set; optional chaining
                                                  // tolerates a stale consumer that forgot the prop.
                                                  const isRestoring = restoringSessionIds.has(a.id);
                                                  const urgent = purge && purge.daysLeft <= 1;
                                                  return (
                                                    <div
                                                      key={a.id}
                                                      className="group flex items-center rounded-md mb-0.5 px-2 py-1 text-xs text-gray-500 hover:bg-gray-800/40"
                                                    >
                                                      <div className="flex-1 min-w-0">
                                                        <div className="truncate">{a.name}</div>
                                                        {purge && (
                                                          <div
                                                            className={`text-[10px] ${
                                                              urgent
                                                                ? 'text-amber-400'
                                                                : 'text-gray-600'
                                                            }`}
                                                          >
                                                            {purge.label}
                                                          </div>
                                                        )}
                                                      </div>
                                                      <button
                                                        onClick={() =>
                                                          onRestoreSession && onRestoreSession(a.id)
                                                        }
                                                        disabled={isRestoring}
                                                        className="ml-2 flex items-center gap-1 text-[10px] text-gray-500 hover:text-emerald-400 px-1.5 py-0.5 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                                        title="Restore session"
                                                      >
                                                        {isRestoring ? (
                                                          <span className="animate-spin inline-block">
                                                            ⟳
                                                          </span>
                                                        ) : (
                                                          <RotateCcw size={11} />
                                                        )}
                                                        Restore
                                                      </button>
                                                    </div>
                                                  );
                                                })}
                                              </div>
                                            )}
                                          </div>
                                        )}
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
                                      </>
                                    )}
                                  </div>
                                );
                              })()}

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

                    <button
                      onClick={() => onNavigate(`workflows:${project.id}`)}
                      className={`w-full text-left px-3 py-1.5 rounded-lg mb-0.5 flex items-center gap-2 transition-colors text-xs ${
                        currentView === `workflows:${project.id}` ||
                        (typeof currentView === 'string' &&
                          currentView.startsWith('workflow-edit:') &&
                          currentView.startsWith(`workflow-edit:${project.id}/`))
                          ? 'bg-gray-800 text-white'
                          : 'text-gray-500 hover:bg-gray-800/50 hover:text-gray-300'
                      }`}
                    >
                      <ListOrdered size={14} className="flex-shrink-0" />
                      <span className="truncate">Workflows</span>
                      {workflowBadgeByProject[project.id] && (
                        <span
                          className="ml-auto flex-shrink-0 w-2 h-2 rounded-full bg-violet-500"
                          title="Workflow activity"
                        />
                      )}
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

                    {/* Pull Requests — hidden in workflow mode (no PR tracking UI) */}
                    {project.mode !== 'workflow' && (
                      <button
                        onClick={() => onNavigate('pulls', project.id)}
                        className={`w-full text-left px-3 py-1.5 rounded-lg mb-0.5 flex items-center gap-2 transition-colors text-xs ${
                          currentView === 'pulls' && pullsProjectId === project.id
                            ? 'bg-gray-800 text-white'
                            : 'text-gray-500 hover:bg-gray-800/50 hover:text-gray-300'
                        }`}
                      >
                        <GitPullRequest size={14} className="flex-shrink-0" />
                        <span className="truncate">Pulls</span>
                      </button>
                    )}
                  </div>
                )}

                {/* When the project is collapsed we still surface any actionable
                    sessions (running / PR-ready) belonging to the active agent in
                    this project, so users never miss a running task or a PR that's
                    ready for review behind the project chevron. */}
                {isCollapsed &&
                  activeAgents.length > 1 &&
                  isActiveProject &&
                  (() => {
                    const actionableSessions = (sessions || []).filter(isSessionActionable);
                    if (actionableSessions.length === 0) return null;
                    return (
                      <div
                        className="ml-3 mt-0.5 mb-1 pl-2 border-l border-gray-800/60"
                        data-testid="project-collapsed-actionable"
                      >
                        {actionableSessions.map((session) => {
                          const isRunning = !!activeTaskSessionIds[session.id];
                          const isAwaitingInput =
                            !isRunning && !!awaitingInputBySession[session.id];
                          const prReady = changesReadyBySession[session.id];
                          const resolvePrHref =
                            prReady && isResolvePrSessionTitle(session.name)
                              ? inferPrUrlFromSessionTitle(session.name, project.githubRepo)
                              : null;
                          const showCreatePrReadyGlyph =
                            !!prReady && !resolvePrHref && !isResolvePrSessionTitle(session.name);
                          return (
                            <button
                              type="button"
                              key={session.id}
                              onClick={() => focusSession(activeAgentId, session.id)}
                              className={`w-full text-left px-2 py-1 rounded-md mb-0.5 flex items-center gap-1.5 text-xs transition-colors cursor-pointer ${
                                activeSessionId === session.id
                                  ? 'bg-gray-800 text-white'
                                  : 'text-gray-500 hover:bg-gray-800/50 hover:text-gray-300'
                              }`}
                              title={session.name}
                            >
                              {isAwaitingInput ? (
                                <span
                                  data-testid={`awaiting-input-indicator-${session.id}`}
                                  className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse flex-shrink-0 ring-2 ring-emerald-400/30"
                                  title="Waiting for your input"
                                />
                              ) : isRunning ? (
                                <Loader2
                                  size={10}
                                  className="text-gray-500 animate-spin flex-shrink-0"
                                  aria-label="Task running"
                                />
                              ) : null}
                              {showCreatePrReadyGlyph && (
                                <span
                                  data-testid="pr-ready-indicator"
                                  className="flex items-center text-purple-400 flex-shrink-0 animate-pulse"
                                  title={`PR ready to create${prReady.branch ? ` (${prReady.branch})` : ''}`}
                                >
                                  <GitPullRequest size={11} />
                                </span>
                              )}
                              {resolvePrHref && (
                                <span
                                  className="flex items-center text-sky-400 flex-shrink-0"
                                  title="Existing PR — open session for GitHub link"
                                  aria-hidden
                                >
                                  <ExternalLink size={11} />
                                </span>
                              )}
                              <span className="truncate">{session.name}</span>
                            </button>
                          );
                        })}
                      </div>
                    );
                  })()}
              </div>
            );
          })}

          {/* End-of-list drop zone — gives users a target for "move to the
              bottom." Insert-before semantics on the project rows above
              mean dropping on the last row puts the dragged project at
              second-to-last, never last. This sentinel closes that gap.
              Rendered only mid-drag so it doesn't take up sidebar real
              estate the rest of the time. */}
          {onReorderProjects && draggedProjectId && (
            <div
              data-testid="sidebar-project-drop-zone-end"
              className={`h-3 mx-2 mt-1 rounded-sm transition-colors ${
                dragOverProjectId === '__end__'
                  ? 'border-t-2 border-emerald-500 bg-emerald-500/10'
                  : 'border-t-2 border-transparent'
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (dragOverProjectId !== '__end__') setDragOverProjectId('__end__');
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget)) return;
                if (dragOverProjectId === '__end__') setDragOverProjectId(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const sourceId = e.dataTransfer.getData('text/plain') || draggedProjectId;
                if (sourceId) {
                  const ids = projects.map((p) => p.id).filter((id) => id !== sourceId);
                  ids.push(sourceId);
                  onReorderProjects(ids);
                }
                setDraggedProjectId(null);
                setDragOverProjectId(null);
              }}
            />
          )}

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

          {/* Designs — top-level nav section (not project-scoped).
              Entry point for the Claude Design canvas; clicking opens the
              designs list where the user can create/open a design. */}
          <div className="mt-4">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 px-2">
              Design
            </div>
            <button
              onClick={() => onNavigate('designs')}
              className={`w-full text-left px-3 py-2.5 rounded-lg mb-0.5 flex items-center gap-2 text-sm transition-colors ${
                currentView === 'designs' || currentView === 'design'
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
              }`}
            >
              <Palette size={14} className="flex-shrink-0 text-purple-400" />
              <span className="truncate">Designs</span>
              {designs.length > 0 && (
                <span className="text-gray-600 text-xs ml-auto">{designs.length}</span>
              )}
            </button>
            {designs.slice(0, 5).map((d) => (
              <button
                key={d.id}
                onClick={() => {
                  onSelectDesign?.(d.id);
                  onNavigate('design', d.id);
                }}
                className={`w-full text-left px-3 py-1.5 rounded-lg mb-0.5 flex items-center gap-2 transition-colors text-xs ${
                  activeDesignId === d.id && currentView === 'design'
                    ? 'bg-gray-800 text-white'
                    : 'text-gray-500 hover:bg-gray-800/50 hover:text-gray-300'
                }`}
              >
                <Palette size={12} className="flex-shrink-0" />
                <span className="truncate">{d.name}</span>
              </button>
            ))}
          </div>

          {orchestrationSession && onOrchestrationSave ? (
            <SidebarSessionOrchestration
              session={orchestrationSession}
              onOrchestrationSave={onOrchestrationSave}
              showToast={showToast}
            />
          ) : null}
        </div>
      </div>

      {/* Bottom nav */}
      <div className="border-t border-gray-800 p-3 space-y-1">
        <button
          onClick={() => onNavigate('skills')}
          className={`w-full text-left px-3 py-3 md:py-2 rounded-lg flex items-center gap-2 text-sm transition-colors min-h-[44px] ${
            currentView === 'skills' || currentView.startsWith('skills:')
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
        {/* Version display.
            In a browser, the React bundle is served by the same Hub that
            answers /api/health — client and server versions are always
            identical, so showing both is noise. Render ONLY the server
            version there. In Electron, the desktop binary version can
            drift from the server it's connected to, so we keep the
            client-primary line plus a mismatch warning chip. */}
        {isElectron() ? (
          <div className="px-3 pt-2 text-xs text-gray-500 flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onNavigate('releases')}
                className="hover:text-gray-300 transition-colors underline-offset-2 hover:underline"
                title="What's new in Agent Hub"
              >
                v{clientVersion}
              </button>
              {footerServerVersion && footerServerVersion !== clientVersion && (
                <span
                  className="inline-flex items-center gap-1 text-amber-400"
                  title={`Client v${clientVersion} · Server v${footerServerVersion}`}
                >
                  <AlertTriangle size={12} />
                  <span>server v{footerServerVersion}</span>
                </span>
              )}
            </div>
            {(clientGitHash || footerServerGitHash) && (
              <div
                className="flex items-center gap-1.5 text-[10px] text-gray-600 font-mono"
                title={
                  footerServerGitHash && clientGitHash && footerServerGitHash !== clientGitHash
                    ? `Client ${clientGitHash} · Server ${footerServerGitHash} (mismatch — rebuild/redeploy)`
                    : `Build ${clientGitHash || footerServerGitHash}`
                }
              >
                <span>{clientGitHash || '—'}</span>
                {footerServerGitHash && clientGitHash && footerServerGitHash !== clientGitHash && (
                  <span className="inline-flex items-center gap-1 text-amber-400">
                    <AlertTriangle size={10} />
                    <span>server {footerServerGitHash}</span>
                  </span>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="px-3 pt-2 text-xs text-gray-500 flex flex-col gap-0.5">
            {footerServerVersion && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onNavigate('releases')}
                  className="hover:text-gray-300 transition-colors underline-offset-2 hover:underline"
                  title="What's new in Agent Hub"
                >
                  v{footerServerVersion}
                </button>
              </div>
            )}
            {footerServerGitHash && (
              <div
                className="text-[10px] text-gray-600 font-mono"
                title={`Build ${footerServerGitHash}`}
              >
                {footerServerGitHash}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
