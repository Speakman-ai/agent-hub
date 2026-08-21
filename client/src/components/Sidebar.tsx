import { useState, useEffect, useRef } from 'react';
import {
  BookOpen,
  Settings,
  Clock,
  LayoutGrid,
  Trash2,
  GitFork,
  Radio,
  ExternalLink,
  List,
  ListOrdered,
  Terminal,
  Play,
  Cloud,
  Server,
  Activity,
  ScrollText,
  AlertTriangle,
  BarChart3,
  House,
  Plus,
  Archive,
  RotateCcw,
  Loader2,
  Lock,
  GripVertical,
  ScanEye,
  Target,
  ChevronRight,
  ChevronDown,
  Bot,
  GitBranch,
  StickyNote,
  Puzzle,
  LifeBuoy,
  MonitorPlay,
  ShieldAlert,
  PanelLeftClose,
  Sparkles,
} from 'lucide-react';
import { getServerBase } from '../utils/connection';
import { useClientBuildVersion } from '../hooks/useClientBuildVersion';
import OrgSwitcher from './OrgSwitcher';
import { isElectron } from '../utils/isElectron';
import humanCron from '@shared/utils/humanCron';
import { inferPrUrlFromSessionTitle, isResolvePrSessionTitle } from '@shared/utils/sessionTitlePr';
import { parseNativePrUrl } from '../utils/prFormatting';
import AgentAvatar from './AgentAvatar';
import { daysUntilPurge } from '../utils/time';
import SessionStateIcon from './SessionStateIcon';
import { deriveSessionState } from '../utils/deriveSessionState';
import { deriveWatchIndicator, watchIndicatorTitle } from '../utils/backgroundShells';
import BugReportButton from './BugReportButton';
import KanbanSidebarEpicsPanel from './KanbanSidebarEpicsPanel';
import { isWorkflowProject } from '../utils/projectMode';
import { readNavGroupCollapsed, writeNavGroupCollapsed } from '../utils/sidebarNavGroupCollapse';
import {
  currentCollapsedProjectsKey,
  readCollapsedProjects,
  writeCollapsedProjects,
} from '../utils/sidebarProjectCollapse';
import {
  createCollapsedProjectSaver,
  fromCollapsedMap,
  mergeHydratedCollapsedProjects,
  normalizeCollapsedProjects,
  toCollapsedMap,
} from '@shared/utils/sidebarProjectCollapse';
import { api } from '../utils/api';

/**
 * The one API call the collapsed-project saver makes. Module scope so every
 * per-account saver shares the same function identity — the account binding
 * lives in the saver's lifetime, not in this closure.
 */
const putCollapsedProject = (projectId: string, collapsed: boolean) =>
  api.putMySidebarCollapsedProject(projectId, collapsed);

export default function Sidebar({
  /** When true, shows a loading overlay on the nav body (org switcher stays usable). */
  isLoading = false,
  projects = [],
  agents: _agents,
  activeAgentId,
  onSelectAgent,
  /** Fetch session lists for sidebar expand without switching the open chat. */
  onExpandAgent,
  sessionsByAgentId = {},
  archivedSessionsByAgentId = {},
  sessions,
  /**
   * The agent ids the live `sessions` / `archivedSessions` arrays were actually
   * FETCHED for. These are NOT always `activeAgentId`: during an agent switch
   * the new agent is active while these arrays still hold the previous agent's
   * rows (its fetch hasn't resolved). The per-agent fallbacks below key on these
   * so the freshly-active agent never renders (or bulk-clears) stale rows.
   */
  loadedSessionsAgentId = null,
  loadedArchivedAgentId = null,
  activeSessionId,
  onSelectSession,
  /** When set (from App), switches to the session's agent then opens chat. */
  onFocusSession,
  onNewSession,
  onDeleteSession,
  onClearAllSessions,
  onClearMergedSessions,
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
  reviewerProjectId,
  threadsProjectId,
  supportProjectId,
  /** When true, the per-user Google account is connected, so the global
   *  Calendar nav entry (under Dashboard) is shown. Calendar is NOT a
   *  per-project surface. */
  googleCalendarNavVisible: _googleCalendarNavVisible = false,
  googleGmailNavVisible: _googleGmailNavVisible = false,
  deploymentsProjectId,
  replaysProjectId,
  securityProjectId,
  wikiProjectId,
  pullsProjectId,
  /**
   * Open the in-app PR detail view: `(projectId, prNumber) => void`. Used for
   * Agent Hub-native PR links, which are client routes rather than external
   * pages.
   */
  onOpenPrDetail,
  notesProjectId,
  workflowBadgeByProject = {},
  unreadThreadCounts = {},
  unreadTicketCounts = {},
  openPullCounts = {},
  /** Per-project open-severity counts: { [projectId]: { critical, high, … } }. */
  securityOpenCounts = {},
  /** Per-project pending learned-lesson counts: { [projectId]: number }. Drives
   * the Skills nav badge so a captured skill-improvement is discoverable. */
  skillImprovementCounts = {},
  activeReviews = {},
  subagentsBySession = {},
  /**
   * Map of sessionId → running Hub-owned background shells. Sessions with a
   * watched shell get a pulsing pill: they are idle on purpose and will resume
   * on their own when the work finishes.
   */
  backgroundShellsBySession = {},
  changesReadyBySession = {},
  /**
   * Map of sessionId → latest Finalize Code Changes status string. When a
   * session's status is `ready_to_push` (review + checks passed), the
   * sidebar shows a green check next to the name so the user knows it is
   * ready to push to GitHub.
   */
  finalizeStatusBySession = {},
  deletingSessionIds = new Set(),
  deletingBulk = null,
  archivedSessions = [],
  onRestoreSession,
  restoringSessionIds = new Set(),
  showToast,
  connected = false,
  reconnecting = false,
  /** Project context for bug reports (optional — falls back to central intake). */
  bugReportProjectId,
  bugReportAgentId,
  /** Electron: parent provides canonical /api/health so footer matches update prompt. */
  electronSuppressHealthFetch = false,
  electronHealthSnapshot = null,
  /**
   * Collapse the sidebar on desktop (md+). When provided, a collapse button
   * renders in the header. Mobile uses the slide-out drawer and never shows it.
   */
  onCollapseSidebar,
  /** Kanban board: project id when `currentView` is `kanban:<id>`. */
  kanbanProjectId = null,
  kanbanProjectName = null,
  kanbanSearchQuery = '',
  onKanbanSearchChange,
  kanbanSelectedEpicIds = new Set(),
  onKanbanSelectedEpicIdsChange,
  kanbanAvailableLabels = [],
  kanbanSelectedLabels = new Set(),
  onKanbanSelectedLabelsChange,
  kanbanAssignableUsers = [],
  kanbanSelectedUserIds = new Set(),
  onKanbanSelectedUserIdsChange,
  kanbanCollapsedColumnIds = new Set(),
  onKanbanCollapsedColumnIdsChange,
  onOpenKanbanEpics,
  kanbanRefreshKey = 0,
}: any) {
  const [hoveredSession, setHoveredSession] = useState<any>(null);
  /**
   * Which projects are collapsed in the project list. The authoritative store
   * is per-USER on the server (`/api/auth/me/sidebar-collapsed-projects`), so
   * the same account sees the same collapsed projects on every device and
   * surface. localStorage is seeded synchronously here purely so the first
   * paint after a reload matches what the user last saw rather than flashing
   * every project open while the hydration fetch is in flight — and it is
   * keyed per account, so a second user signing in on this browser never
   * inherits the first user's view (see utils/sidebarProjectCollapse).
   */
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, any>>(() =>
    toCollapsedMap(readCollapsedProjects()),
  );
  /**
   * Toggles made before the hydration fetch resolved. They win over the server
   * list when it lands — otherwise a click a few hundred ms too early would
   * visibly snap back, and the reverted value is what the cache would persist.
   */
  const pendingCollapseEditsRef = useRef<Record<string, boolean>>({});
  const collapseHydratedRef = useRef(false);
  /**
   * Serializes + coalesces the save PUTs per project. Rapid clicks would
   * otherwise race and could leave the account holding the opposite of what
   * the UI shows — a divergence that only surfaces on the next reload.
   *
   * The saver belongs to ONE account: its queue holds values, and the auth
   * token is only read when a value is finally dispatched. The hydration
   * effect below retires it and installs a replacement whenever the account
   * changes, so a toggle queued by the previous user can never be written to
   * the new user's preferences. Seeded eagerly so a click landing between
   * first render and the first effect flush still has somewhere to go.
   */
  /**
   * Which account the current collapse state belongs to. Re-running hydration
   * when this changes covers a sign-out/sign-in that doesn't remount Sidebar.
   */
  const collapseAccountKey = currentCollapsedProjectsKey();
  const collapseSaverRef = useRef(createCollapsedProjectSaver(putCollapsedProject));
  const collapseSaverAccountKeyRef = useRef(collapseAccountKey);
  // The first render needs an eager saver so a click cannot land before the
  // hydration effect. Retire and replace it synchronously on an account
  // change; otherwise a pre-effect queue would be orphaned when the effect
  // installs the account-bound saver.
  if (collapseSaverAccountKeyRef.current !== collapseAccountKey) {
    collapseSaverRef.current.cancel();
    collapseSaverRef.current = createCollapsedProjectSaver(putCollapsedProject);
    collapseSaverAccountKeyRef.current = collapseAccountKey;
  }
  const [collapsedAgents, setCollapsedAgents] = useState<Record<string, any>>({});
  /** Agent rows whose session list is expanded in the sidebar (independent of the open chat). */
  const [expandedAgents, setExpandedAgents] = useState<Record<string, any>>({});
  /**
   * Collapse state for the labeled project-nav groups (Git / Planning / Support
   * / AI / Settings). Keyed by `${projectId}:${groupKey}`; default collapsed
   * (`undefined` → collapsed). Seeded from localStorage and persisted on change
   * so the user's expand/collapse choices survive reloads.
   */
  const [collapsedNavGroups, setCollapsedNavGroups] =
    useState<Record<string, boolean>>(readNavGroupCollapsed);
  // Project drag-and-drop state. `draggedProjectId` is the row the user
  // is currently dragging; `dragOverProjectId` is whichever other row has
  // a pending drop indicator. Both reset on dragend / drop / cancel.
  const [draggedProjectId, setDraggedProjectId] = useState<any>(null);
  const [dragOverProjectId, setDragOverProjectId] = useState<any>(null);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<any>(null);
  const [editingSessionName, setEditingSessionName] = useState('');
  const [confirmAction, setConfirmAction] = useState<any>(null); // 'clear-all' | 'clear-merged' | null
  const [confirmAgentId, setConfirmAgentId] = useState<any>(null);
  const [serverVersion, setServerVersion] = useState<any>(null);
  const [serverGitHash, setServerGitHash] = useState<any>(null);
  const renameSavedRef = useRef(false);
  const kanbanFiltersRef = useRef<HTMLDivElement | null>(null);
  const scrolledKanbanFiltersProjectRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeAgentId) return;
    setExpandedAgents((prev: any) =>
      prev[activeAgentId] ? prev : { ...prev, [activeAgentId]: true },
    );
  }, [activeAgentId]);

  // Persist nav-group collapse choices so they survive reloads.
  useEffect(() => {
    writeNavGroupCollapsed(collapsedNavGroups);
  }, [collapsedNavGroups]);

  // Hydrate the collapsed-project list from the caller's account. A failure
  // (offline, or a caller with no per-user row) leaves the cached view in
  // place rather than expanding everything. Re-runs when the signed-in account
  // changes so the new user never keeps looking at the previous one's state.
  useEffect(() => {
    let cancelled = false;
    const accountSaver = collapseSaverRef.current;
    // Repaint from the incoming account's own cache before its fetch lands —
    // otherwise the previous account's collapsed projects stay on screen for
    // the duration of the request, and indefinitely if it fails.
    collapseHydratedRef.current = false;
    pendingCollapseEditsRef.current = {};
    setCollapsedProjects(toCollapsedMap(readCollapsedProjects()));
    api
      .getMySidebarCollapsedProjects()
      .then((data: any) => {
        if (cancelled) return;
        const merged = mergeHydratedCollapsedProjects(
          normalizeCollapsedProjects(data?.sidebarCollapsedProjects),
          pendingCollapseEditsRef.current,
        );
        collapseHydratedRef.current = true;
        pendingCollapseEditsRef.current = {};
        setCollapsedProjects(toCollapsedMap(merged));
        writeCollapsedProjects(merged);
      })
      .catch(() => {
        if (cancelled) return;
        collapseHydratedRef.current = true;
        pendingCollapseEditsRef.current = {};
      });
    return () => {
      cancelled = true;
      // Runs before the next effect body (account change) and on unmount
      // (sign-out). Either way the queued toggles belong to an account that is
      // no longer the one we'd authenticate as.
      accountSaver.cancel();
    };
  }, [collapseAccountKey]);

  const focusSession = (agentId: any, sessionId: any) => {
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
      .then((r: any) => r.json())
      .then((data: any) => {
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

  const toggleProjectCollapse = (projectId: any, e: any) => {
    e.stopPropagation();
    const collapsed = !collapsedProjects[projectId];
    const next = { ...collapsedProjects, [projectId]: collapsed };
    setCollapsedProjects(next);
    if (!collapseHydratedRef.current) pendingCollapseEditsRef.current[projectId] = collapsed;
    writeCollapsedProjects(fromCollapsedMap(next));
    // Serialized + coalesced per project, so double-clicking can't land the
    // PUTs out of order and leave the account inverted relative to the UI.
    // Still fire-and-forget: the optimistic local state is already correct and
    // the saver swallows failures.
    void collapseSaverRef.current.save(projectId, collapsed);
  };

  const toggleAgentCollapse = (agentId: any, e: any) => {
    e.stopPropagation();
    setCollapsedAgents((prev: any) => ({ ...prev, [agentId]: !prev[agentId] }));
  };

  const toggleAgentExpanded = (agentId: any) => {
    setExpandedAgents((prev: any) => {
      const next = !prev[agentId];
      if (next) onExpandAgent?.(agentId);
      return { ...prev, [agentId]: next };
    });
  };

  // Fall back to the live arrays ONLY for the agent they were loaded for, not
  // for whichever agent is merely active right now — otherwise a mid-switch
  // render (new agent active, old `sessions` still in state) would show the old
  // agent's rows and feed them into the per-agent clear controls.
  const sessionsForAgent = (agentId: any) =>
    sessionsByAgentId[agentId] ?? (agentId === loadedSessionsAgentId ? sessions : []);

  const archivedForAgent = (agentId: any) =>
    archivedSessionsByAgentId[agentId] ??
    (agentId === loadedArchivedAgentId ? archivedSessions : []);

  // A project-nav group is collapsed unless the user has explicitly expanded it.
  const isNavGroupCollapsed = (projectId: any, groupKey: string) =>
    collapsedNavGroups[`${projectId}:${groupKey}`] ?? true;

  const toggleNavGroup = (projectId: any, groupKey: string, e: any) => {
    if (e) e.stopPropagation();
    setCollapsedNavGroups((prev) => {
      const k = `${projectId}:${groupKey}`;
      return { ...prev, [k]: !(prev[k] ?? true) };
    });
  };

  const navGroupHeaderClass =
    'w-full text-left px-3 py-1.5 rounded-lg mb-0.5 mt-1 flex items-center gap-2 transition-colors text-[10px] font-semibold uppercase tracking-wide text-gray-500 hover:bg-gray-800/50 hover:text-gray-300';

  const projectMenuLinkClass = (active: any) =>
    `w-full text-left px-3 py-1.5 rounded-lg mb-0.5 flex items-center gap-2 transition-colors text-xs ${
      active ? 'bg-gray-800 text-white' : 'text-gray-500 hover:bg-gray-800/50 hover:text-gray-300'
    }`;

  // Move `sourceId` into the slot currently occupied by `targetId`,
  // preserving the order of every other project. Hands the resulting
  // full id list (every project the sidebar received, not just the
  // rendered subset) back to the parent so the server reorder payload
  // matches the caller-visible set.
  const handleReorderDrop = (sourceId: any, targetId: any) => {
    if (!onReorderProjects) return;
    if (!sourceId || !targetId || sourceId === targetId) return;
    const ids = projects.map((p: any) => p.id);
    const srcIdx = ids.indexOf(sourceId);
    const tgtIdx = ids.indexOf(targetId);
    if (srcIdx === -1 || tgtIdx === -1) return;
    ids.splice(srcIdx, 1);
    const insertIdx = srcIdx < tgtIdx ? tgtIdx - 1 : tgtIdx;
    ids.splice(insertIdx, 0, sourceId);
    onReorderProjects(ids);
  };

  const isRecent = (dateStr: any) => {
    if (!dateStr) return false;
    const d = dateStr.includes('T') ? new Date(dateStr) : new Date(dateStr + 'Z');
    return Date.now() - d.getTime() < 30 * 60 * 1000;
  };

  // humanCron imported from utils/humanCron.js

  // Find which project the active agent belongs to
  const activeProject = projects.find((p: any) =>
    p.agents.some((a: any) => a.id === activeAgentId),
  );

  // A session is "actionable" when it must remain visible regardless of collapse state:
  // - it's currently running (tracked via activeTaskSessionIds)
  // - it has a pending PR/changes ready (tracked via changesReadyBySession), including
  //   `[Resolve PR #N]` sessions — so users can reopen them from the collapsed sidebar.
  //   Resolve sessions may still render an external-link affordance (`resolvePrHref`);
  //   PR-ready status itself is represented by the shared session state icon.
  // - it's blocked on an `agenthub:ask` picker awaiting user input
  //   (tracked via awaitingInputBySession). Stays visible behind ▸ so users
  //   never miss a session that needs their reply.
  const isSessionActionable = (session: any) =>
    !!activeTaskSessionIds[session.id] ||
    !!changesReadyBySession[session.id] ||
    !!awaitingInputBySession[session.id] ||
    finalizeStatusBySession[session.id] === 'ready_to_push';

  // Single source of truth for "does this project render its own Scheduled
  // Tasks block?" — used both by the per-project block gate below AND by the
  // Ungrouped-bucket filter, so the two can never drift (a project must appear
  // in exactly one place). A project shows its block iff it has ≥1 active agent
  // AND it is expanded (or auto-expanded because it has a single active agent).
  // A collapsed multi-agent project therefore does NOT host its crons here, so
  // they fall through to the Ungrouped bucket and stay reachable — matching the
  // old always-visible global list.
  const projectShowsScheduledTasks = (project: any): boolean => {
    const activeAgents = (project.agents || []).filter((a: any) => a.active !== false);
    if (activeAgents.length === 0) return false;
    const isCollapsed = collapsedProjects[project.id];
    return !isCollapsed || activeAgents.length === 1;
  };
  const scheduledTaskHomeProjectIds = new Set(
    (projects || []).filter(projectShowsScheduledTasks).map((p: any) => p.id),
  );

  // Shared cron-row renderer so the per-project block and the Ungrouped bucket
  // stay in lockstep — a future tweak (badge, title attr, …) changes one place.
  const renderCronRow = (cs: any) => {
    const sessionState = deriveSessionState(cs, {
      activeTaskSessionIds,
      finalizeStatusBySession,
    });
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
        <SessionStateIcon state={sessionState} size={12} testId={`session-state-icon-${cs.id}`} />
        <span className="flex-1 truncate text-sm">{cs.cron_name}</span>
        <span className="text-xs text-gray-600 flex-shrink-0">{humanCron(cs.cron_schedule)}</span>
      </button>
    );
  };

  const isKanbanView = Boolean(kanbanProjectId);
  const kanbanProject = isKanbanView ? projects.find((p: any) => p.id === kanbanProjectId) : null;

  useEffect(() => {
    if (!isKanbanView || !kanbanProjectId) {
      scrolledKanbanFiltersProjectRef.current = null;
      return;
    }
    if (scrolledKanbanFiltersProjectRef.current === kanbanProjectId) return;
    scrolledKanbanFiltersProjectRef.current = kanbanProjectId;
    kanbanFiltersRef.current?.scrollIntoView?.({ block: 'start', inline: 'nearest' });
  }, [isKanbanView, kanbanProjectId]);

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
      <div className="sidebar-scroll flex-1 overflow-y-auto min-h-0 relative overscroll-y-contain">
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
          <div className="flex items-center gap-2 mb-3">
            <span
              className={`flex-1 min-w-0 text-xs px-2.5 py-2 rounded-lg text-center truncate ${
                connected
                  ? 'bg-emerald-900/50 text-emerald-400'
                  : reconnecting
                    ? 'bg-yellow-900/50 text-yellow-400'
                    : 'bg-red-900/50 text-red-400'
              }`}
              title={connected ? 'Connected' : reconnecting ? 'Reconnecting…' : 'Disconnected'}
              data-testid="sidebar-connection-status"
            >
              {connected ? '● Connected' : reconnecting ? '● Reconnecting…' : '● Disconnected'}
            </span>
            <BugReportButton
              projectId={bugReportProjectId}
              agentId={bugReportAgentId}
              onToast={showToast}
            />
            {onCollapseSidebar && (
              <button
                type="button"
                onClick={onCollapseSidebar}
                className="hidden md:flex flex-shrink-0 items-center justify-center text-gray-400 hover:text-white p-1.5 rounded-lg hover:bg-gray-800 transition-colors"
                title="Collapse sidebar"
                aria-label="Collapse sidebar"
                data-testid="sidebar-collapse"
              >
                <PanelLeftClose size={16} />
              </button>
            )}
          </div>

          {/* Hub — org/user home: assistant + Dashboard / Daily Summary / Org / Todos / Calendar / Mail. */}
          <button
            onClick={() => onNavigate('hub')}
            data-testid="sidebar-global-hub"
            className={`w-full text-left px-3 py-2 rounded-lg mb-3 flex items-center gap-2 transition-colors ${
              currentView === 'hub' ||
              currentView === 'home' ||
              currentView === 'dashboard' ||
              currentView === 'todos' ||
              currentView === 'calendar' ||
              currentView === 'gmail'
                ? 'bg-gray-800 text-white'
                : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
            }`}
          >
            <House size={14} className="flex-shrink-0" />
            <span className="flex-1 truncate text-sm font-medium">Hub</span>
          </button>

          {/* Org-wide support overview: every project's support issues on one
              page. Per-project Support links — with unread badges — stay in each
              project's menu below. */}
          <button
            onClick={() => onNavigate('support-overview')}
            data-testid="sidebar-support-overview"
            className={`w-full text-left px-3 py-2 rounded-lg mb-3 flex items-center gap-2 transition-colors ${
              currentView === 'support-overview'
                ? 'bg-gray-800 text-white'
                : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
            }`}
          >
            <LifeBuoy size={14} className="flex-shrink-0" />
            <span className="flex-1 truncate text-sm font-medium">Support</span>
          </button>

          {/* Scheduled Tasks (cron sessions) render per-project inside each
              project block below. But a cron may have no rendered home: its
              `project_id` is nullable, points at a project not visible to this
              user, OR points at a project whose per-project block isn't showing
              right now (a collapsed multi-agent project). Surface all of those
              in an "Ungrouped" bucket at the top — restoring the old global
              list's guarantee that EVERY scheduled task stays reachable. The
              `scheduledTaskHomeProjectIds` set is the SAME predicate the
              per-project block uses, so a cron lands in exactly one place. */}
          {(() => {
            const ungroupedCronSessions = cronSessions.filter(
              (cs: any) => !cs.project_id || !scheduledTaskHomeProjectIds.has(cs.project_id),
            );
            if (ungroupedCronSessions.length === 0) return null;
            return (
              <div className="mb-4" data-testid="sidebar-ungrouped-scheduled-tasks">
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 px-2 flex items-center gap-1.5">
                  <Clock size={12} />
                  Scheduled Tasks
                </div>
                {ungroupedCronSessions.map((cs: any) => renderCronRow(cs))}
              </div>
            );
          })()}

          {isKanbanView &&
          kanbanProjectId &&
          onKanbanSearchChange &&
          onKanbanSelectedEpicIdsChange ? (
            <div ref={kanbanFiltersRef} data-testid="kanban-sidebar-filters-anchor">
              <KanbanSidebarEpicsPanel
                projectId={kanbanProjectId}
                projectName={kanbanProjectName || kanbanProject?.name}
                searchQuery={kanbanSearchQuery}
                onSearchChange={onKanbanSearchChange}
                selectedEpicIds={kanbanSelectedEpicIds}
                onSelectedEpicIdsChange={onKanbanSelectedEpicIdsChange}
                availableLabels={kanbanAvailableLabels}
                selectedLabels={kanbanSelectedLabels}
                onSelectedLabelsChange={onKanbanSelectedLabelsChange}
                assignableUsers={kanbanAssignableUsers}
                selectedUserIds={kanbanSelectedUserIds}
                onSelectedUserIdsChange={onKanbanSelectedUserIdsChange}
                collapsedColumnIds={kanbanCollapsedColumnIds}
                onCollapsedColumnIdsChange={onKanbanCollapsedColumnIdsChange}
                refreshKey={kanbanRefreshKey}
              />
            </div>
          ) : null}

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

          {projects.map((project: any, index: any) => {
            const activeAgents = project.agents.filter((a: any) => a.active !== false);
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
                className={`mb-1 flex flex-col ${isBeingDragged ? 'opacity-40' : ''} ${
                  isDropTarget ? 'border-t-2 border-emerald-500' : 'border-t-2 border-transparent'
                }`}
                data-testid={`sidebar-project-row-${project.id}`}
                onDragOver={
                  dragEnabled
                    ? (e: any) => {
                        if (!draggedProjectId || draggedProjectId === project.id) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        if (dragOverProjectId !== project.id) setDragOverProjectId(project.id);
                      }
                    : undefined
                }
                onDragLeave={
                  dragEnabled
                    ? (e: any) => {
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
                    ? (e: any) => {
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
                      onDragStart={(e: any) => {
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
                    onClick={(e: any) => {
                      if (activeAgents.length === 1) {
                        toggleAgentExpanded(activeAgents[0].id);
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
                </div>

                {/* Project links (Board, Wiki, Skills, …) */}
                {(!isCollapsed || activeAgents.length === 1) && (
                  <div
                    className={`order-2 ${activeAgents.length > 1 ? 'ml-3' : ''}`}
                    data-testid={`sidebar-project-menu-wrap-${project.id}`}
                  >
                    {(() => {
                      const workflowProject = isWorkflowProject(project);
                      // Per-item visibility (mirrors the old inline gates).
                      const showRepo = project.gitHost === 'agenthub';
                      // Pulls only makes sense for a repo-backed or Agent Hub-hosted
                      // project (matches mobile `hasPulls`). A non-workflow project
                      // without a repo would otherwise link to an empty PR surface.
                      const showPulls =
                        (!!project.githubRepo || project.gitHost === 'agenthub') &&
                        project.mode !== 'workflow';
                      const showDeployments = !workflowProject;
                      const showEpics = !workflowProject;
                      const showStats = !workflowProject;
                      const showSupport = !workflowProject;
                      const showLogs = !workflowProject;
                      const showRum = !workflowProject;
                      const showReplays = !workflowProject;
                      const showSecurity = !workflowProject;
                      const showAws = !!project.awsEnabled;
                      const showInfra = !!project.infraEnabled;
                      const showReviewer = project.agents?.some((a: any) => a.role === 'reviewer');
                      const showRunners = !workflowProject;
                      const showDevserver = !workflowProject;
                      // A group renders only when it has at least one visible item.
                      const hasGit = showRepo || showPulls || showDeployments;
                      const NavGroupHeader = ({ groupKey, label }: any) => (
                        <button
                          type="button"
                          onClick={(e: any) => toggleNavGroup(project.id, groupKey, e)}
                          data-testid={`sidebar-nav-group-${groupKey}-${project.id}`}
                          className={navGroupHeaderClass}
                        >
                          {isNavGroupCollapsed(project.id, groupKey) ? (
                            <ChevronRight size={14} className="flex-shrink-0" />
                          ) : (
                            <ChevronDown size={14} className="flex-shrink-0" />
                          )}
                          <span className="truncate">{label}</span>
                        </button>
                      );
                      return (
                        <div
                          className="mt-1 mb-1"
                          data-testid={`sidebar-project-menu-${project.id}`}
                        >
                          {/* ── Git ── */}
                          {hasGit && (
                            <>
                              <NavGroupHeader groupKey="git" label="Git" />
                              {!isNavGroupCollapsed(project.id, 'git') && (
                                <div className="ml-3 pl-2 border-l border-gray-800/60">
                                  {showRepo && (
                                    <button
                                      type="button"
                                      onClick={() => onNavigate(`repo:${project.id}`)}
                                      className={projectMenuLinkClass(
                                        currentView === `repo:${project.id}`,
                                      )}
                                    >
                                      <GitBranch size={14} className="flex-shrink-0" />
                                      <span className="truncate">Repository</span>
                                    </button>
                                  )}
                                  {showPulls && (
                                    <button
                                      type="button"
                                      onClick={() => onNavigate('pulls', project.id)}
                                      className={projectMenuLinkClass(
                                        currentView === 'pulls' && pullsProjectId === project.id,
                                      )}
                                    >
                                      <ListOrdered size={14} className="flex-shrink-0" />
                                      <span className="truncate">Pulls</span>
                                      {openPullCounts[project.id] > 0 && (
                                        <span className="ml-auto flex-shrink-0 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-blue-500 text-[10px] font-bold text-white px-1">
                                          {openPullCounts[project.id] > 99
                                            ? '99+'
                                            : openPullCounts[project.id]}
                                        </span>
                                      )}
                                    </button>
                                  )}
                                  {showDeployments && (
                                    <button
                                      type="button"
                                      onClick={() => onNavigate('deployments', project.id)}
                                      className={projectMenuLinkClass(
                                        currentView === 'deployments' &&
                                          deploymentsProjectId === project.id,
                                      )}
                                    >
                                      <Cloud size={14} className="flex-shrink-0" />
                                      <span className="truncate">Deployments</span>
                                    </button>
                                  )}
                                </div>
                              )}
                            </>
                          )}

                          {/* ── Planning ── */}
                          <NavGroupHeader groupKey="planning" label="Planning" />
                          {!isNavGroupCollapsed(project.id, 'planning') && (
                            <div className="ml-3 pl-2 border-l border-gray-800/60">
                              <button
                                type="button"
                                onClick={() => onNavigate(`kanban:${project.id}`)}
                                className={projectMenuLinkClass(
                                  currentView === `kanban:${project.id}`,
                                )}
                              >
                                <LayoutGrid size={14} className="flex-shrink-0" />
                                <span className="truncate">Board</span>
                              </button>
                              {showEpics && (
                                <button
                                  type="button"
                                  data-testid={`sidebar-epics-link-${project.id}`}
                                  onClick={() => onNavigate(`epics:${project.id}`)}
                                  className={projectMenuLinkClass(
                                    currentView === `epics:${project.id}` ||
                                      currentView.startsWith(`epic:${project.id}:`),
                                  )}
                                >
                                  <Target size={14} className="flex-shrink-0" />
                                  <span className="truncate">Epics</span>
                                </button>
                              )}
                              {showStats && (
                                <button
                                  type="button"
                                  onClick={() => onNavigate(`stats:${project.id}`)}
                                  className={projectMenuLinkClass(
                                    currentView === `stats:${project.id}`,
                                  )}
                                >
                                  <BarChart3 size={14} className="flex-shrink-0" />
                                  <span className="truncate">Stats</span>
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => onNavigate('notes', project.id)}
                                className={projectMenuLinkClass(
                                  currentView === 'notes' && notesProjectId === project.id,
                                )}
                              >
                                <StickyNote size={14} className="flex-shrink-0" />
                                <span className="truncate">Notes</span>
                              </button>
                            </div>
                          )}

                          {/* ── Support ── */}
                          <NavGroupHeader groupKey="support" label="Support" />
                          {!isNavGroupCollapsed(project.id, 'support') && (
                            <div className="ml-3 pl-2 border-l border-gray-800/60">
                              {showSupport && (
                                <button
                                  type="button"
                                  onClick={() => onNavigate('support', project.id)}
                                  className={projectMenuLinkClass(
                                    currentView === 'support' && supportProjectId === project.id,
                                  )}
                                >
                                  <LifeBuoy size={14} className="flex-shrink-0" />
                                  <span className="truncate">Customer Issues</span>
                                  {unreadTicketCounts[project.id] > 0 && (
                                    <span className="ml-auto flex-shrink-0 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-blue-500 text-[10px] font-bold text-white px-1">
                                      {unreadTicketCounts[project.id] > 99
                                        ? '99+'
                                        : unreadTicketCounts[project.id]}
                                    </span>
                                  )}
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => onNavigate('threads', project.id)}
                                className={projectMenuLinkClass(
                                  currentView.startsWith('threads') &&
                                    threadsProjectId === project.id,
                                )}
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
                              {showLogs && (
                                <button
                                  type="button"
                                  onClick={() => onNavigate(`logs:${project.id}`)}
                                  className={projectMenuLinkClass(
                                    currentView === `logs:${project.id}`,
                                  )}
                                >
                                  <ScrollText size={14} className="flex-shrink-0" />
                                  <span className="truncate">Logs</span>
                                </button>
                              )}
                              {showRum && (
                                <button
                                  type="button"
                                  onClick={() => onNavigate(`rum:${project.id}`)}
                                  className={projectMenuLinkClass(
                                    currentView === `rum:${project.id}`,
                                  )}
                                >
                                  <Activity size={14} className="flex-shrink-0" />
                                  <span className="truncate">RUM</span>
                                </button>
                              )}
                              {showReplays && (
                                <button
                                  type="button"
                                  onClick={() => onNavigate('replays', project.id)}
                                  className={projectMenuLinkClass(
                                    currentView === 'replays' && replaysProjectId === project.id,
                                  )}
                                >
                                  <MonitorPlay size={14} className="flex-shrink-0" />
                                  <span className="truncate">Replays</span>
                                </button>
                              )}
                              {showAws && (
                                <button
                                  type="button"
                                  onClick={() => onNavigate(`aws:${project.id}`)}
                                  className={projectMenuLinkClass(
                                    currentView === `aws:${project.id}`,
                                  )}
                                >
                                  <Cloud size={14} className="flex-shrink-0" />
                                  <span className="truncate">AWS</span>
                                </button>
                              )}
                              {showInfra && (
                                <button
                                  type="button"
                                  onClick={() => onNavigate(`infra:${project.id}`)}
                                  className={projectMenuLinkClass(
                                    currentView === `infra:${project.id}`,
                                  )}
                                >
                                  <Server size={14} className="flex-shrink-0" />
                                  <span className="truncate">Infrastructure</span>
                                </button>
                              )}
                              {showSecurity &&
                                (() => {
                                  const counts = securityOpenCounts[project.id];
                                  const criticalHigh = counts
                                    ? (counts.critical || 0) + (counts.high || 0)
                                    : 0;
                                  return (
                                    <button
                                      type="button"
                                      onClick={() => onNavigate('security', project.id)}
                                      className={projectMenuLinkClass(
                                        currentView === 'security' &&
                                          securityProjectId === project.id,
                                      )}
                                    >
                                      <ShieldAlert size={14} className="flex-shrink-0" />
                                      <span className="truncate">Security</span>
                                      {criticalHigh > 0 && (
                                        <span className="ml-auto flex-shrink-0 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white px-1">
                                          {criticalHigh > 99 ? '99+' : criticalHigh}
                                        </span>
                                      )}
                                    </button>
                                  );
                                })()}
                            </div>
                          )}

                          {/* ── AI ── */}
                          <NavGroupHeader groupKey="ai" label="AI" />
                          {!isNavGroupCollapsed(project.id, 'ai') && (
                            <div className="ml-3 pl-2 border-l border-gray-800/60">
                              {showReviewer && (
                                <button
                                  type="button"
                                  onClick={() => onNavigate('reviewer', project.id)}
                                  className={projectMenuLinkClass(
                                    currentView === 'reviewer' && reviewerProjectId === project.id,
                                  )}
                                >
                                  <ScanEye size={14} className="flex-shrink-0" />
                                  <span className="truncate">Reviewer</span>
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => onNavigate(`project-agents:${project.id}`)}
                                className={projectMenuLinkClass(
                                  currentView === `project-agents:${project.id}`,
                                )}
                              >
                                <Bot size={14} className="flex-shrink-0" />
                                <span className="truncate">Agents</span>
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  onNavigate(`project-background-agents:${project.id}`)
                                }
                                className={projectMenuLinkClass(
                                  currentView === `project-background-agents:${project.id}`,
                                )}
                              >
                                <Sparkles size={14} className="flex-shrink-0" />
                                <span className="truncate">Background Agents</span>
                              </button>
                              {(() => {
                                const pendingLessons = skillImprovementCounts[project.id] || 0;
                                return (
                                  <button
                                    type="button"
                                    onClick={() => onNavigate(`skills:${project.id}`)}
                                    className={projectMenuLinkClass(
                                      currentView === `skills:${project.id}`,
                                    )}
                                  >
                                    <Puzzle size={14} className="flex-shrink-0" />
                                    <span className="truncate">Skills</span>
                                    {pendingLessons > 0 && (
                                      <span
                                        title={`${pendingLessons} skill ${
                                          pendingLessons === 1 ? 'lesson' : 'lessons'
                                        } pending review`}
                                        className="ml-auto flex-shrink-0 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-white px-1"
                                      >
                                        {pendingLessons > 99 ? '99+' : pendingLessons}
                                      </span>
                                    )}
                                  </button>
                                );
                              })()}
                              <button
                                type="button"
                                onClick={() => onNavigate('wiki', project.id)}
                                className={projectMenuLinkClass(
                                  currentView === 'wiki' && wikiProjectId === project.id,
                                )}
                              >
                                <BookOpen size={14} className="flex-shrink-0" />
                                <span className="truncate">Wiki</span>
                              </button>
                            </div>
                          )}

                          {/* ── Settings ── */}
                          <NavGroupHeader groupKey="settings" label="Settings" />
                          {!isNavGroupCollapsed(project.id, 'settings') && (
                            <div className="ml-3 pl-2 border-l border-gray-800/60">
                              <button
                                type="button"
                                onClick={() => onNavigate(`project-settings:${project.id}`)}
                                className={projectMenuLinkClass(
                                  currentView === `project-settings:${project.id}`,
                                )}
                              >
                                <Settings size={14} className="flex-shrink-0" />
                                <span className="truncate">Project Configuration</span>
                              </button>
                              {showRunners && (
                                <button
                                  type="button"
                                  onClick={() => onNavigate(`runners:${project.id}`)}
                                  className={projectMenuLinkClass(
                                    currentView === `runners:${project.id}`,
                                  )}
                                >
                                  <Play size={14} className="flex-shrink-0" />
                                  <span className="truncate">Runners</span>
                                </button>
                              )}
                              {showDevserver && (
                                <button
                                  type="button"
                                  onClick={() => onNavigate(`devserver:${project.id}`)}
                                  className={projectMenuLinkClass(
                                    currentView === `devserver:${project.id}`,
                                  )}
                                >
                                  <Terminal size={14} className="flex-shrink-0" />
                                  <span className="truncate">Dev server</span>
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => onNavigate(`project-crons:${project.id}`)}
                                className={projectMenuLinkClass(
                                  currentView === `project-crons:${project.id}`,
                                )}
                              >
                                <Clock size={14} className="flex-shrink-0" />
                                <span className="truncate">Cron Jobs</span>
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* Agents within project (auto-expand if single agent) */}
                {(!isCollapsed || activeAgents.length === 1) && (
                  <div
                    className={`order-1 ${activeAgents.length > 1 ? 'ml-3' : ''}`}
                    data-testid={`sidebar-project-agents-${project.id}`}
                  >
                    {(() => {
                      // Hide the reviewer agent row; it's edited via the per-project Reviewer page below.
                      const visibleAgents = activeAgents.filter(
                        (a: any) => a.role !== 'reviewer' && a.role !== 'skill-builder',
                      );

                      const renderAgent = (agent: any) => {
                        const isActive = activeAgentId === agent.id;
                        const isExpanded = !!expandedAgents[agent.id];
                        const agentSessions = sessionsForAgent(agent.id);
                        const isTopLevel = true;
                        const isLead = agent.role === 'lead';

                        return (
                          <div key={agent.id}>
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
                                  // Primary affordance: make this the active chat
                                  // agent and jump to chat. The chevron beside it
                                  // (separate button) expands/collapses the session
                                  // list WITHOUT switching, so a non-active agent's
                                  // sessions can be peeked at too.
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
                              <button
                                type="button"
                                onClick={(e: any) => {
                                  e.stopPropagation();
                                  toggleAgentExpanded(agent.id);
                                }}
                                aria-expanded={isExpanded}
                                aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${agent.name} sessions`}
                                title={isExpanded ? 'Hide sessions' : 'Show sessions'}
                                className="flex-shrink-0 px-2 py-2 text-gray-500 hover:text-gray-200 transition-colors"
                              >
                                <span className="text-lg leading-none">
                                  {isExpanded ? '▾' : '▸'}
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
                              {isExpanded && (
                                <button
                                  type="button"
                                  onClick={(e: any) => toggleAgentCollapse(agent.id, e)}
                                  className="flex-shrink-0 pr-2 text-gray-500 hover:text-gray-300 text-xs leading-none flex items-center cursor-pointer"
                                  title={
                                    collapsedAgents[agent.id]
                                      ? 'Show all sessions'
                                      : 'Show actionable only'
                                  }
                                >
                                  {collapsedAgents[agent.id] ? '···' : '≡'}
                                </button>
                              )}
                            </div>

                            {/* Sessions for expanded agent. */}
                            {isExpanded &&
                              (() => {
                                const agentCollapsed = !!collapsedAgents[agent.id];
                                const visibleSessions = agentCollapsed
                                  ? agentSessions.filter(isSessionActionable)
                                  : agentSessions;
                                if (agentCollapsed && visibleSessions.length === 0) return null;
                                return (
                                  <div className="ml-5 mb-2" data-testid="agent-sessions-list">
                                    {visibleSessions.map((session: any) => {
                                      const sessionState = deriveSessionState(session, {
                                        activeTaskSessionIds,
                                        finalizeStatusBySession,
                                      });
                                      const isEditing = editingSessionId === session.id;
                                      const prReady = changesReadyBySession[session.id];
                                      const resolvePrHref =
                                        prReady && isResolvePrSessionTitle(session.name)
                                          ? inferPrUrlFromSessionTitle(
                                              session.name,
                                              project.githubRepo,
                                              {
                                                gitHost: project.gitHost,
                                                projectId: project.id,
                                              },
                                            )
                                          : null;
                                      const resolvePrNative = parseNativePrUrl(resolvePrHref);
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
                                              onChange={(e: any) =>
                                                setEditingSessionName(e.target.value)
                                              }
                                              onKeyDown={(e: any) => {
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
                                                  title={`Open existing PR on ${
                                                    resolvePrNative ? 'Agent Hub' : 'GitHub'
                                                  }`}
                                                  onClick={(e: any) => {
                                                    e.stopPropagation();
                                                    // Native PR URLs are in-app
                                                    // routes — window.open would
                                                    // miss the hash router.
                                                    if (resolvePrNative) {
                                                      onOpenPrDetail?.(
                                                        resolvePrNative.projectId,
                                                        resolvePrNative.number,
                                                      );
                                                      return;
                                                    }
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
                                                onDoubleClick={(e: any) => {
                                                  e.stopPropagation();
                                                  setEditingSessionId(session.id);
                                                  setEditingSessionName(session.name);
                                                }}
                                                className="flex-1 min-w-0 text-left px-2 py-2 md:py-1.5 pr-7 truncate text-xs flex items-center gap-1.5 cursor-pointer"
                                              >
                                                <SessionStateIcon
                                                  state={sessionState}
                                                  size={12}
                                                  testId={`session-state-icon-${session.id}`}
                                                />
                                                {subagentsBySession[session.id]?.running > 0 && (
                                                  <span
                                                    className="flex items-center gap-0.5 text-[9px] text-indigo-400 flex-shrink-0"
                                                    title={`${subagentsBySession[session.id].running} subagent${subagentsBySession[session.id].running === 1 ? '' : 's'} running`}
                                                  >
                                                    <GitFork size={10} />
                                                    {subagentsBySession[session.id].running}
                                                  </span>
                                                )}
                                                {(() => {
                                                  const watch = deriveWatchIndicator(
                                                    backgroundShellsBySession[session.id],
                                                  );
                                                  if (!watch) return null;
                                                  return (
                                                    <span
                                                      className={`flex items-center gap-0.5 text-[9px] flex-shrink-0 ${
                                                        watch.watching > 0
                                                          ? 'text-amber-400'
                                                          : 'text-gray-500'
                                                      }`}
                                                      title={watchIndicatorTitle(watch)}
                                                      data-testid={`session-watch-pill-${session.id}`}
                                                    >
                                                      <Radio
                                                        size={10}
                                                        className={
                                                          watch.watching > 0 ? 'animate-pulse' : ''
                                                        }
                                                      />
                                                      {watch.watching > 0
                                                        ? watch.watching
                                                        : watch.running}
                                                    </span>
                                                  );
                                                })()}
                                                <span className="truncate">{session.name}</span>
                                                {session.advisor_count > 0 && (
                                                  <span
                                                    className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-indigo-900/50 text-indigo-300 border border-indigo-800/50"
                                                    title={`${session.advisor_count} advisor${session.advisor_count !== 1 ? 's' : ''}`}
                                                  >
                                                    +{session.advisor_count}
                                                  </span>
                                                )}
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
                                              onClick={(e: any) => {
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
                                          <button
                                            onClick={() => onNewSession(agent.id)}
                                            className="text-xs text-gray-600 hover:text-gray-400 px-2 py-1 transition-colors"
                                          >
                                            + New Session
                                          </button>
                                          {agentSessions.length > 0 && (
                                            <div className="ml-auto flex items-center gap-0.5 pr-1">
                                              {/* Single bulk-clear affordance. The
                                                  underlying action clears sessions whose
                                                  work has merged (the settled terminal
                                                  state once per-session auto-merge runs);
                                                  it is labelled "Clear pushed" because that
                                                  is the term users think in ("pushed =
                                                  shipped"). */}
                                              <button
                                                onClick={() => {
                                                  setConfirmAgentId(agent.id);
                                                  setConfirmAction('clear-merged');
                                                }}
                                                disabled={!!deletingBulk}
                                                className="text-[10px] text-gray-600 hover:text-amber-400 px-1.5 py-0.5 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                                title="Clear sessions with pushed changes"
                                              >
                                                {deletingBulk === 'merged' ? '...' : 'Clear pushed'}
                                              </button>
                                              <button
                                                onClick={() => {
                                                  setConfirmAgentId(agent.id);
                                                  setConfirmAction('clear-all');
                                                }}
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
                                        {archivedForAgent(agent.id).length > 0 && (
                                          <div
                                            className="mt-2 border-t border-gray-800/50 pt-1"
                                            data-testid="archived-sessions-section"
                                          >
                                            <button
                                              onClick={() => setArchivedExpanded((v: any) => !v)}
                                              className="w-full text-left px-2 py-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-gray-600 hover:text-gray-400 transition-colors"
                                            >
                                              <Archive size={10} />
                                              <span className="flex-1">
                                                Archived ({archivedForAgent(agent.id).length})
                                              </span>
                                              <span className="text-gray-600">
                                                {archivedExpanded ? '▾' : '▸'}
                                              </span>
                                            </button>
                                            {archivedExpanded && (
                                              <div data-testid="archived-sessions-list">
                                                {archivedForAgent(agent.id).map((a: any) => {
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
                                        {/* Confirmation dialog — scoped to the agent the
                                            action was triggered on. The confirm state is
                                            global, so without the `confirmAgentId === agent.id`
                                            guard the dialog would also render under any OTHER
                                            expanded agent and could clear the wrong agent's
                                            sessions. */}
                                        {confirmAction && confirmAgentId === agent.id && (
                                          <div className="mx-1 mt-1 p-2 bg-gray-800 border border-gray-700 rounded-lg">
                                            <p className="text-xs text-gray-300 mb-2">
                                              {confirmAction === 'clear-all'
                                                ? `Delete all ${agentSessions.length} session${agentSessions.length !== 1 ? 's' : ''}? This cannot be undone.`
                                                : `Delete all sessions with pushed changes? Sessions in any other state will be kept.`}
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
                                                  const targetAgentId = confirmAgentId || agent.id;
                                                  if (confirmAction === 'clear-all') {
                                                    await onClearAllSessions(targetAgentId);
                                                  } else {
                                                    await onClearMergedSessions(targetAgentId);
                                                  }
                                                  setConfirmAction(null);
                                                  setConfirmAgentId(null);
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
                                                    : 'Delete Pushed'}
                                              </button>
                                            </div>
                                          </div>
                                        )}
                                      </>
                                    )}
                                  </div>
                                );
                              })()}
                          </div>
                        );
                      };

                      return visibleAgents.map((agent: any) => renderAgent(agent));
                    })()}
                  </div>
                )}

                {/* Scheduled Tasks (cron sessions) for THIS project. Grouped
                    here — under the project they belong to — rather than in a
                    single global list. Cron sessions carry `project_id` from
                    the cron row (see getAllCronSessions). The render gate is the
                    shared `projectShowsScheduledTasks` predicate (NOT an inline
                    copy) so it can never drift from the Ungrouped-bucket filter:
                    a collapsed multi-agent project fails this gate, and its
                    crons fall back to the Ungrouped bucket instead of vanishing. */}
                {projectShowsScheduledTasks(project) &&
                  (() => {
                    const projectCronSessions = cronSessions.filter(
                      (cs: any) => cs.project_id === project.id,
                    );
                    if (projectCronSessions.length === 0) return null;
                    return (
                      <div
                        className={`order-3 mb-2 ${activeAgents.length > 1 ? 'ml-3' : ''}`}
                        data-testid={`sidebar-project-scheduled-tasks-${project.id}`}
                      >
                        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1 px-2 flex items-center gap-1.5">
                          <Clock size={12} />
                          Scheduled Tasks
                        </div>
                        {projectCronSessions.map((cs: any) => renderCronRow(cs))}
                      </div>
                    );
                  })()}

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
                        {actionableSessions.map((session: any) => {
                          const sessionState = deriveSessionState(session, {
                            activeTaskSessionIds,
                            finalizeStatusBySession,
                          });
                          const prReady = changesReadyBySession[session.id];
                          const resolvePrHref =
                            prReady && isResolvePrSessionTitle(session.name)
                              ? inferPrUrlFromSessionTitle(session.name, project.githubRepo, {
                                  gitHost: project.gitHost,
                                  projectId: project.id,
                                })
                              : null;
                          return (
                            <button
                              type="button"
                              key={session.id}
                              onClick={() =>
                                focusSession(session.agent_id || activeAgentId, session.id)
                              }
                              className={`w-full text-left px-2 py-1 rounded-md mb-0.5 flex items-center gap-1.5 text-xs transition-colors cursor-pointer ${
                                activeSessionId === session.id
                                  ? 'bg-gray-800 text-white'
                                  : 'text-gray-500 hover:bg-gray-800/50 hover:text-gray-300'
                              }`}
                              title={session.name}
                            >
                              <SessionStateIcon
                                state={sessionState}
                                size={12}
                                testId={`session-state-icon-${session.id}`}
                              />
                              {resolvePrHref && (
                                <span
                                  className="flex items-center text-sky-400 flex-shrink-0"
                                  title="Existing PR — open session for the PR link"
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
              onDragOver={(e: any) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (dragOverProjectId !== '__end__') setDragOverProjectId('__end__');
              }}
              onDragLeave={(e: any) => {
                if (e.currentTarget.contains(e.relatedTarget)) return;
                if (dragOverProjectId === '__end__') setDragOverProjectId(null);
              }}
              onDrop={(e: any) => {
                e.preventDefault();
                const sourceId = e.dataTransfer.getData('text/plain') || draggedProjectId;
                if (sourceId) {
                  const ids = projects.map((p: any) => p.id).filter((id: any) => id !== sourceId);
                  ids.push(sourceId);
                  onReorderProjects(ids);
                }
                setDraggedProjectId(null);
                setDragOverProjectId(null);
              }}
            />
          )}
        </div>
      </div>

      {/* Bottom nav */}
      <div className="border-t border-gray-800 p-3 space-y-1">
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
