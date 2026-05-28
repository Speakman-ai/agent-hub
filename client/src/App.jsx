import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import Sidebar from './components/Sidebar.jsx';
import TopBar from './components/TopBar.jsx';
import ChatMessage from './components/ChatMessage.jsx';
import ThinkingIndicator from './components/ThinkingIndicator.jsx';
import SessionTail from './components/SessionTail.jsx';
import MessageInput from './components/MessageInput.jsx';
import AgentSwitcher from './components/AgentSwitcher.jsx';
import ForwardSessionModal, { filterForwardTargets } from './components/ForwardSessionModal.jsx';
import SettingsPage from './components/SettingsPage.jsx';
import SkillsPage from './components/SkillsPage.jsx';
import SessionAgentsPanel from './components/SessionAgentsPanel.jsx';
import DesignsList from './components/DesignsList.jsx';
import DesignView from './components/DesignView.jsx';
import DelegationPanel from './components/DelegationPanel.jsx';
import SessionSummarySidebar from './components/SessionSummarySidebar.jsx';
import ChecksPanel from './components/finalize/ChecksPanel.jsx';
import SessionPreviewPane from './components/SessionPreviewPane.jsx';
import SessionPreviewStartButton from './components/SessionPreviewStartButton.jsx';
import {
  paneOpenStorageKey,
  clearSessionPreviewStorage,
  previewIdFromEvent,
  shouldShowSessionPreviewPane,
} from './utils/sessionPreviewState.js';
import ChangesReadyBox from './components/ChangesReadyBox.jsx';
import ResolveSessionPrBanner from './components/ResolveSessionPrBanner.jsx';
import {
  inferPrUrlFromSessionTitle,
  isResolvePrSessionTitle,
  parseResolvePrNumberFromTitle,
} from '../../shared/utils/sessionTitlePr.js';
import ProgressPanel, { mergeProgressEvent } from './components/ProgressPanel.jsx';
import ReactLoopObservabilityPanel from './components/ReactLoopObservabilityPanel.jsx';
import OrchestrationTimelinePanel from './components/OrchestrationTimelinePanel.jsx';
import OpenProjectWizard from './components/OpenProjectWizard.jsx';
import NewProjectAdaptiveFlow from './components/NewProjectAdaptiveFlow.jsx';
import SetupWizard, { stepIndexForKey } from './components/SetupWizard.jsx';
import KanbanBoard from './components/KanbanBoard.jsx';
import DashboardView from './components/DashboardView.jsx';
import WikiBrowser from './components/WikiBrowser.jsx';
import ThreadList from './components/ThreadList.jsx';
import ThreadView from './components/ThreadView.jsx';
import NotesEditor from './components/NotesEditor.jsx';
import PullRequestsPage from './components/PullRequestsPage.jsx';
import ProjectWorkflowsPage from './components/ProjectWorkflowsPage.jsx';
import ProjectWorkflowBuilder from './components/ProjectWorkflowBuilder.jsx';
import ShortcutsHelpModal from './components/ShortcutsHelpModal.jsx';
import UpdateAvailableModal from './components/UpdateAvailableModal.jsx';
import ReleasesView from './components/ReleasesView.jsx';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useVisibleIntervalRefresh } from './hooks/useVisibleIntervalRefresh.js';
import { useDesktopNotifications } from './hooks/useDesktopNotifications.js';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js';
import { useVersionCheck } from './hooks/useVersionCheck.js';
import { fetchDesktopUpdateHealth } from './utils/desktopUpdateCheck.js';
import { api } from './utils/api.js';
import { mapDelegationRowsToLiveShape } from './utils/delegationsHydrate.js';
import { coalescePromiseByKey } from './utils/coalesceInFlight.js';
import { isNearBottom, forcePinChatTailScroll } from './utils/chatScroll.js';
import {
  buildInterruptQueuedMessageDispatch,
  isPersistedUploadAttachment,
} from '../../shared/utils/queuedMessageAttachments.js';
import { attachTailPinResizeObserver } from './utils/chatScrollResizeObserver.js';
import { parseWorkflowEditView } from './utils/workflowEditView.js';
import {
  awaitingInputNotification,
  cardStartedNotification,
  cardReviewNotification,
  prMergedNotification,
  prReadyNotification,
  sessionCompleteNotification,
  threadCreatedNotification,
  threadEntryNotification,
} from './utils/ticketNotifications.js';
import {
  MessageCircle,
  Info,
  CheckCircle,
  AlertTriangle,
  Loader2,
  ArrowLeftRight,
} from 'lucide-react';
import {
  migrateFromLegacy,
  fetchOrgs,
  getActiveOrg,
  getActiveOrgApiId,
  getOrgs,
  switchOrg,
} from './utils/orgs.js';
import { getApiBase, getAuthHeaders, reloadForOrgSwitch } from './utils/connection.js';
import { extractSubmittedAskIds } from './utils/askAnswers.js';
import {
  applyAwaitingInputEvent,
  applyAwaitingInputSnapshot,
  clearAwaitingInputForSession,
  shouldNotifyForAwaitingInput,
} from './utils/awaitingInputState.js';
import { getDefaultShortcuts } from './utils/shortcuts.js';
import {
  firstEngineWithAuthenticatedModels,
  defaultModelForAuthenticatedEngine,
} from './utils/authModelEngines.js';
import {
  isSessionAskModeEnabled,
  isSessionWorkspaceReady,
  isSessionWorktreeEnabled,
  prependSessionDeduped,
} from './utils/sessionDerivedState.js';
import { appendPreviewLogTail, mergePreviewEventLogTail } from './utils/previewLogTail.js';
import { mergeBrowserActivityScreenshot } from '../../shared/utils/browserScreensBySessionMerge.js';
import { indexSessionsById, resolveChatAccentColor } from './utils/chatAccentColor.js';

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
  // Soft-deleted sessions within the 24-hour recovery window for the active
  // agent. Shape: Array<SessionRow & { message_count:number, deleted_at:string }>.
  // Server filters to 24h window + newest-first; client just renders.
  const [archivedSessions, setArchivedSessions] = useState([]);
  const [restoringSessionIds, setRestoringSessionIds] = useState(new Set());
  // activeSessionId is persisted per-agent in localStorage under
  // `activeSessionId:<agentId>` so an Electron reload / app restart returns
  // the user to the same session instead of silently defaulting to whichever
  // row happens to have the newest `updated_at` (which may be a cron/heartbeat
  // session the user wasn't working on). See the session-restore test + the
  // "Session recovery" troubleshooting wiki page.
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  /** True while GET /api/sessions/:id/messages is in flight after a session switch. */
  const [sessionMessagesLoading, setSessionMessagesLoading] = useState(false);
  // Handoffs (rows from GET /api/sessions/:id/handoffs) for the active
  // source session — used by HandoffCard to render an "Open session" link.
  const [sessionHandoffs, setSessionHandoffs] = useState([]);
  // Sub-lg viewports: inline skill list (the full summary panel is lg+ only).
  const [thinking, setThinking] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingMsgId, setStreamingMsgId] = useState(null);
  const streamingMsgIdRef = useRef(null);
  const [composerPrefill, setComposerPrefill] = useState(null);
  const [streamingEngine, setStreamingEngine] = useState(null);
  const [sessionEngine, setSessionEngine] = useState('claude-code');
  const [sessionModel, setSessionModel] = useState('claude-opus-4-8');
  const [modelConfig, setModelConfig] = useState(null);
  // Worktree state was removed when Agent Hub locked to worktree-only sessions.
  // The CLI-detection signal (`gitWorktreeDetected`) is similarly retired.
  const [sessionAskMode, setSessionAskMode] = useState(false);
  const [currentView, setCurrentView] = useState('chat');
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showForward, setShowForward] = useState(false);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [deletingSessionIds, setDeletingSessionIds] = useState(new Set());
  const [deletingBulk, setDeletingBulk] = useState(null); // 'all' | 'inactive' | null
  // Map of sessionId -> running task state ({messageId, content, engine, model}).
  // Populated from the server's snapshot on connect and updated as stream events arrive.
  // Used to (a) restore streaming state when switching sessions and (b) power the
  // "running" indicator in the sidebar.
  const [activeTasks, setActiveTasks] = useState({});
  // Map of sessionId -> { askIds, agentId, sessionName } for sessions that
  // have stopped on an unanswered `agenthub:ask` picker. Populated by the
  // server's `awaiting-input-snapshot` (connect) and `awaiting_input` (live
  // transitions) events. Used to power the "waiting for you" indicator in
  // the sidebar — distinct from `activeTasks` (which is the "working" signal).
  const [awaitingInputBySession, setAwaitingInputBySession] = useState({});
  // Ref kept in sync so the WS handler can detect "newly waiting" transitions
  // (for desktop notifications) without re-creating the callback on every
  // state change.
  const awaitingInputBySessionRef = useRef(awaitingInputBySession);
  useEffect(() => {
    awaitingInputBySessionRef.current = awaitingInputBySession;
  }, [awaitingInputBySession]);
  // Map of messageId -> array of { seq, event } for the SessionTail timeline.
  // Populated by 'session-event' WS messages (live) or via api.getMessageEvents
  // (historical, lazy on first SessionTail render).
  const [eventsByMessage, setEventsByMessage] = useState({});
  // Message queue state: sessionId -> [{id, content, position}]
  const [messageQueues, setMessageQueues] = useState({});
  // Multi-agent session roster for the active session (executor + advisors).
  const [sessionAgents, setSessionAgents] = useState([]);
  const [sessionRoundProcessing, setSessionRoundProcessing] = useState(false);
  /** When set, the in-flight stream/thinking bubble is from this agent (advisor turn). */
  const [streamingAgent, setStreamingAgent] = useState(null);
  // Claude Design (Phase 1) — top-level, not project-scoped
  const [designs, setDesigns] = useState([]);
  const [activeDesignId, setActiveDesignId] = useState(null);
  const [designMessages, setDesignMessages] = useState([]);
  const [designStreaming, setDesignStreaming] = useState(null);
  const [designThinking, setDesignThinking] = useState(false);
  const [designProcessing, setDesignProcessing] = useState(false);
  // Cache-buster for the design iframe. Bumped on every `design_updated` WS
  // event for the active design so the iframe re-fetches the latest files.
  const [designReloadToken, setDesignReloadToken] = useState(0);
  // Delegation state: Map of sessionId -> { parentMessageId, tasks: [{delegationId, agentId, agentName, agentColor, task, status, content, output, error}] }
  const [delegations, setDelegations] = useState({});
  // Last `delegation_error` per session — surfaces "Dispatch failed: …" on
  // the message-anchored DelegateCard when the round never produced a
  // `delegation_start` (no valid sub-agents, dispatcher exception, etc.).
  // Without this, the only signal was a transient toast and the card sat
  // on "Queued" forever. Cleared when a fresh `delegation_start` arrives
  // for the same session. Shape: { [sessionId]: { message, parentMessageId? } }.
  const [delegationDispatchErrors, setDelegationDispatchErrors] = useState({});
  // Rate-limit throttle state: Map of sessionId -> { active, retryAfterMs, clearedAt }
  const [throttle, setThrottle] = useState({});
  // Subagent tracking: Map of sessionId -> { total, running, done, errored }
  const [subagents, setSubagents] = useState({});
  // Ad-hoc PR creation: Map of sessionId -> { agentId, branch, hasUncommitted, hasUnpushed }
  const [changesReady, setChangesReady] = useState({});
  const [shipFailureAt, setShipFailureAt] = useState(null);
  // Live shell output while verify-before-Done runs (close-card → Done gate).
  const [doneVerifyLogBySession, _setDoneVerifyLogBySession] = useState({});
  // Cursor-style ProgressPanel state — keyed by sessionId.
  // Each value: Array<{ step, status, startedAt, finishedAt? }> in emit order.
  const [sessionProgress, setSessionProgress] = useState({});
  /** Host ReAct / continuation steps from WebSocket `react_loop_step`, keyed by sessionId. */
  const [reactLoopStepsBySession, setReactLoopStepsBySession] = useState({});
  /** Live browser screenshot previews: messageId → { actionId → data URL }. */
  const [browserScreensBySession, setBrowserScreensBySession] = useState({});
  /**
   * Per-session preview state. Updated whenever an `agenthub_preview` WS
   * event arrives. The pane reads `previewEventBySession[activeSessionId]`
   * and renders accordingly.
   */
  const [previewEventBySession, setPreviewEventBySession] = useState({});
  /** Per-session preview pane open/closed flag (auto-opens on first event). */
  const [previewPaneOpenBySession, setPreviewPaneOpenBySession] = useState({});
  /** Optimistic UI while POST /sessions/:id/preview/start is in flight. */
  const [previewStartingBySession, setPreviewStartingBySession] = useState({});
  /** While POST /sessions/:id/workspace/ensure is cloning the session worktree. */
  const [workspaceEnsuringBySession, setWorkspaceEnsuringBySession] = useState({});
  const workspaceEnsureInFlightRef = useRef(new Set());
  const workspaceEnsureAttemptedRef = useRef(new Set());
  const previewEventBySessionRef = useRef(previewEventBySession);
  previewEventBySessionRef.current = previewEventBySession;
  /** Sessions where the user clicked Stop — ignore late preview_failed WS noise. */
  const previewUserStoppedBySessionRef = useRef({});
  const tearDownSessionPreviewRef = useRef(null);
  // Tracks which agenthub:ask prompts the user has already answered in this
  // tab, so the picker renders as "Submitted" immediately after click. This is
  // the optimistic, in-memory half; the authoritative source is the derived
  // set below which scans persisted message history.
  const [askSubmittedOptimistic, setAskSubmittedOptimistic] = useState(() => new Set());
  // Derived from persisted message history: any user message containing an
  // `agenthub:ask:answer` block with a matching askId marks that picker as
  // submitted. Surviving page reloads requires this — in-memory state is lost
  // on refresh, but the user message is persisted in the DB and re-fetched.
  const askSubmittedFromHistory = useMemo(() => extractSubmittedAskIds(messages), [messages]);
  // Union of optimistic (just-clicked) + history-derived (persisted). Passed to
  // the picker's `submitted` prop and used to short-circuit duplicate sends.
  const askSubmitted = useMemo(() => {
    if (askSubmittedOptimistic.size === 0) return askSubmittedFromHistory;
    const union = new Set(askSubmittedFromHistory);
    for (const id of askSubmittedOptimistic) union.add(id);
    return union;
  }, [askSubmittedOptimistic, askSubmittedFromHistory]);
  // Wiki state
  const [wikiProjectId, setWikiProjectId] = useState(null);
  // Notes state
  const [notesProjectId, setNotesProjectId] = useState(null);
  // Previews state
  // Pull Requests state
  const [pullsProjectId, setPullsProjectId] = useState(null);
  /** Deep-link into Pull Requests detail (e.g. session summary linked PR). Cleared when leaving pulls view. */
  const [pullsOpenPrNumber, setPullsOpenPrNumber] = useState(null);
  /** Bumped when the server signals PR/board activity for the open Pulls view — keeps GitHub list live without reload. */
  const [pullsListRefreshNonce, setPullsListRefreshNonce] = useState(0);
  /** Cleared when user opens the Workflows view — set by workflow WebSocket activity. */
  const [workflowSidebarBadgeByProject, setWorkflowSidebarBadgeByProject] = useState({});
  /** Deep-link from Workflows → Settings → GitHub: expand this project row (cleared when leaving Settings). */
  const [settingsGithubExpandProjectId, setSettingsGithubExpandProjectId] = useState(null);
  // Threads state
  const [threadsProjectId, setThreadsProjectId] = useState(null);
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [activeThread, setActiveThread] = useState(null);
  // Unread thread entry counts per project: { [projectId]: number }
  const [unreadThreadCounts, setUnreadThreadCounts] = useState({});
  // Refs to push WebSocket updates into ThreadList/ThreadView
  const threadListRef = useRef(null);
  const threadViewRef = useRef(null);
  // Cron-linked sessions (scheduled tasks)
  const [cronSessions, setCronSessions] = useState([]);
  // Skills for the active agent (for /slash-command autocomplete)
  const [skills, setSkills] = useState([]);
  // First-run setup
  const [setupStatus, setSetupStatus] = useState(null);
  const [showSetup, setShowSetup] = useState(false);
  // When the wizard is triggered specifically because the user has no AI
  // credentials (rather than because this is a true first-run install), we
  // jump straight to the AI-credentials step and hide Back below it. Org +
  // Welcome are skipped because the org already exists. See App init below.
  const [setupInitialStep, setSetupInitialStep] = useState(1);
  // Full-screen "Connecting…" only until org migration + org list + setup probe.
  // Project/session data loads in the main layout (sidebar shows its own spinner).
  const [initializing, setInitializing] = useState(true);
  // True after the first successful projects fetch in init (or after it fails).
  const [projectDataReady, setProjectDataReady] = useState(false);
  // True while GET /sessions (and session list selection) is in flight for the active agent.
  const [sessionsListLoading, setSessionsListLoading] = useState(false);
  // Active lead reviews: Map of agentId -> { prUrl, cardTitle, sessionId }
  const [activeReviews, setActiveReviews] = useState({});
  // Toast notifications
  const [toasts, setToasts] = useState([]);
  const showToast = (message, type = 'info', duration = 5000) => {
    setToasts((prev) => [...prev, { id: `toast-${Date.now()}`, type, message, duration }]);
  };
  // Desktop notifications (Electron native / Web Notifications API)
  const { notify } = useDesktopNotifications();
  // Kanban board refresh trigger
  const [kanbanRefreshKey, setKanbanRefreshKey] = useState(0);
  const activeDesignIdRef = useRef(activeDesignId);
  activeDesignIdRef.current = activeDesignId;

  const scrollContainerRef = useRef(null);
  /** Observed for height changes (streaming, images, code blocks) while pinned to bottom. */
  const messagesColumnRef = useRef(null);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  // Persist the active session per-agent so a reload / Electron restart
  // restores the same session. Intentionally scoped by agent because sessions
  // belong to agents; a remembered id for the wrong agent would be invalid.
  //
  // Only WRITE on a truthy session id — never clear the key. The initial mount
  // fires this effect with `activeSessionId=null` (useState default) before
  // the session-load effect has had a chance to hydrate from localStorage; if
  // we cleared here, we'd race-condition ourselves and wipe the remembered
  // value every reload. Stale ids are handled on the read side instead
  // (`data.find(s => s.id === stored)` gracefully falls through to `data[0]`).
  useEffect(() => {
    if (!activeAgentId || !activeSessionId) return;
    const key = `activeSessionId:${activeAgentId}`;
    try {
      localStorage.setItem(key, activeSessionId);
    } catch {
      /* quota / disabled storage — non-fatal */
    }
  }, [activeAgentId, activeSessionId]);
  /** One in-flight implicit `createSession` per agent + ask-mode (send with no session). */
  const implicitSessionCreateByKeyRef = useRef(new Map());
  const activeAgentIdRef = useRef(activeAgentId);
  activeAgentIdRef.current = activeAgentId;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  /** Cross-agent session rows for accent color + owner sync before per-agent lists reload. */
  const sessionsByIdRef = useRef(new Map());
  const [sessionsIndexTick, setSessionsIndexTick] = useState(0);
  const bumpSessionsIndex = useCallback(() => {
    setSessionsIndexTick((t) => t + 1);
  }, []);
  useEffect(() => {
    indexSessionsById(sessionsByIdRef.current, sessions);
    bumpSessionsIndex();
  }, [sessions, bumpSessionsIndex]);
  useEffect(() => {
    indexSessionsById(sessionsByIdRef.current, cronSessions);
    bumpSessionsIndex();
  }, [cronSessions, bumpSessionsIndex]);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  // Mirror of `changesReady` accessible inside WebSocket callbacks (used to
  // detect whether a `changes_ready` event is a fresh prompt vs a replay).
  const changesReadyRef = useRef(changesReady);
  changesReadyRef.current = changesReady;

  // Track when a session was explicitly navigated to (e.g. from kanban assign)
  // so the agent-change useEffect doesn't overwrite it with a stale session ID.
  const pendingSessionIdRef = useRef(null);
  /** Populated after `focusAgentSession` is defined — WebSocket toasts call `.current(...)`. */
  const focusAgentSessionRef = useRef(null);

  // Refs for thread state (accessible inside WebSocket callback)
  const threadsProjectIdRef = useRef(threadsProjectId);
  threadsProjectIdRef.current = threadsProjectId;
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  const currentViewRef = useRef(currentView);
  currentViewRef.current = currentView;
  const newProjectWizardReturnRef = useRef('chat');

  const isWizardView = (v) =>
    v === 'new-project-wizard' || v === 'new-project-adaptive' || v === 'import-project-wizard';
  const openNewProjectWizard = useCallback(() => {
    const cur = currentViewRef.current;
    newProjectWizardReturnRef.current = isWizardView(cur) ? 'chat' : cur;
    setCurrentView('new-project-wizard');
  }, []);
  // Primary "+ New Project" CTA — routes to the adaptive (prompt-first)
  // wizard (Acts I–V). `openNewProjectWizard` above is retained for the
  // legacy "I already have a folder/repo" import path.
  const openAdaptiveProjectWizard = useCallback(() => {
    const cur = currentViewRef.current;
    newProjectWizardReturnRef.current = isWizardView(cur) ? 'chat' : cur;
    setCurrentView('new-project-adaptive');
  }, []);
  // Secondary "Import existing project" CTA — routes to the legacy
  // folder-picker / clone-from-GitHub wizard. Uses a distinct view key
  // (`import-project-wizard`) for telemetry clarity; the legacy
  // `new-project-wizard` key is preserved for backward compatibility.
  const openImportProjectWizard = useCallback(() => {
    const cur = currentViewRef.current;
    newProjectWizardReturnRef.current = isWizardView(cur) ? 'chat' : cur;
    setCurrentView('import-project-wizard');
  }, []);
  // Persist a new sidebar project order. Optimistic: reorder the local
  // projects array immediately so the UI doesn't flicker, then PUT to the
  // server. On failure, roll back by refetching the canonical list. The
  // server also broadcasts `projects_updated` over the WebSocket, which
  // makes other open clients (and ourselves, harmlessly) refetch.
  const handleReorderProjects = useCallback((newOrderIds) => {
    setProjects((prev) => {
      const byId = new Map(prev.map((p) => [p.id, p]));
      const reordered = newOrderIds.map((id) => byId.get(id)).filter(Boolean);
      // Belt-and-suspenders: if newOrderIds dropped any project we knew
      // about (shouldn't happen — Sidebar passes the full set), append
      // those back at the end so we never lose rows from the UI.
      for (const p of prev) {
        if (!newOrderIds.includes(p.id)) reordered.push(p);
      }
      return reordered;
    });
    api.reorderProjects(newOrderIds).catch((err) => {
      console.error('[reorderProjects] failed, refetching:', err);
      api
        .getProjects()
        .then((data) => setProjects(data))
        .catch(() => {
          /* best-effort rollback; surfacing the original error already happened */
        });
    });
  }, []);
  const pullsProjectIdRef = useRef(pullsProjectId);
  pullsProjectIdRef.current = pullsProjectId;

  const activeAgent = agents.find((a) => a.id === activeAgentId);

  const workflowEditRoute = useMemo(() => parseWorkflowEditView(currentView), [currentView]);

  useEffect(() => {
    const projectId = currentView.startsWith('workflows:')
      ? currentView.slice('workflows:'.length)
      : workflowEditRoute?.projectId;
    if (!projectId) return;
    setWorkflowSidebarBadgeByProject((prev) => {
      if (!prev[projectId]) return prev;
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
  }, [currentView, workflowEditRoute]);

  useEffect(() => {
    if (!currentView.startsWith('settings')) {
      setSettingsGithubExpandProjectId(null);
    }
  }, [currentView]);

  const navigateFromProjectWorkflows = useCallback((view, extra) => {
    if (typeof view === 'string' && view.startsWith('settings') && extra?.expandProjectId) {
      setSettingsGithubExpandProjectId(extra.expandProjectId);
    }
    setCurrentView(view);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .getModelConfig()
      .then((cfg) => {
        if (!cancelled) setModelConfig(cfg);
      })
      .catch((err) => {
        console.warn('[modelConfig] GET /api/config/models failed:', err?.message || err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-scroll — instant snap to the tail while following (streaming uses the same path).
  // Stops auto-scrolling when the user scrolls away from the bottom past the threshold.
  const initialScrollRef = useRef(true);
  const isNearBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  // Tracks whether a programmatic scroll is in progress so we don't
  // interpret the resulting scroll events as the user scrolling away.
  const programmaticScrollRef = useRef(false);

  const checkNearBottom = useCallback(() => isNearBottom(scrollContainerRef.current), []);

  const handleScrollEvent = useCallback(() => {
    // Ignore scroll events caused by our own programmatic scrolling —
    // these would otherwise flip isNearBottomRef to false mid-animation
    // and break auto-follow.
    if (programmaticScrollRef.current) return;
    const nearBottom = checkNearBottom();
    isNearBottomRef.current = nearBottom;
    setShowScrollBtn(!nearBottom);
  }, [checkNearBottom]);

  /** Snap to the tail. Always instant — smooth scroll cannot keep up with streaming tokens. */
  const scrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
      isNearBottomRef.current = true;
      setShowScrollBtn(false);
    });
  }, []);

  useEffect(() => {
    streamingMsgIdRef.current = streamingMsgId;
  }, [streamingMsgId]);

  const pinChatTail = useCallback((messageId) => {
    isNearBottomRef.current = true;
    setShowScrollBtn(false);
    const el = scrollContainerRef.current;
    forcePinChatTailScroll(el, (container) => {
      programmaticScrollRef.current = true;
      container.scrollTop = container.scrollHeight;
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
    });
    if (messageId && el) {
      const root = [...el.querySelectorAll('[data-message-id]')].find(
        (node) => node.getAttribute('data-message-id') === messageId,
      );
      const anchor = root?.querySelector('[data-testid="session-tail-bottom"]');
      anchor?.scrollIntoView?.({ block: 'end' });
    }
  }, []);

  // Reset follow state when switching sessions (must run before the scroll layout effect below).
  useLayoutEffect(() => {
    initialScrollRef.current = true;
    isNearBottomRef.current = true;
    setShowScrollBtn(false);
  }, [activeSessionId]);

  // Auto-scroll on new content, but only if user is near the bottom or it's initial load.
  useLayoutEffect(() => {
    if (initialScrollRef.current || isNearBottomRef.current) {
      scrollToBottom();
    }
    if (initialScrollRef.current) {
      // Schedule a second scroll for content that renders late (images, code
      // blocks, lazy-loaded components). This catches cases where the first
      // scroll fires before the full height is known.
      const timer = setTimeout(() => {
        scrollToBottom();
      }, 100);
      initialScrollRef.current = false;
      return () => clearTimeout(timer);
    }
    initialScrollRef.current = false;
  }, [messages, thinking, streamingContent, scrollToBottom]);

  // Late layout (images, syntax-highlighted blocks) can grow the column without a
  // React state change — keep the viewport pinned when the user is following the tail.
  useEffect(() => {
    const col = messagesColumnRef.current;
    const el = scrollContainerRef.current;
    if (!col || !el) return undefined;
    return attachTailPinResizeObserver({
      observedElement: col,
      shouldPin: () => isNearBottomRef.current,
      pinScroll: () => {
        programmaticScrollRef.current = true;
        el.scrollTop = el.scrollHeight;
        requestAnimationFrame(() => {
          programmaticScrollRef.current = false;
          isNearBottomRef.current = true;
          setShowScrollBtn(false);
        });
      },
    });
  }, [activeSessionId]);

  const refreshAgents = useCallback(() => {
    api.getProjects().then((data) => {
      setProjects(data);
      const flat = data.flatMap((p) =>
        p.agents.map((a) => ({
          ...a,
          projectId: p.id,
          projectName: p.name,
          cwd: p.cwd,
          ahw: p.ahw,
        })),
      );
      setAgents(flat);
    });
  }, []);

  const projectDataReadyRef = useRef(projectDataReady);
  projectDataReadyRef.current = projectDataReady;
  const sessionListRefreshInFlight = useRef(false);

  /** Re-fetch session + archived lists without toggling `sessionsListLoading` or resetting the active session. */
  const silentRefreshSessions = useCallback(async () => {
    const agentId = activeAgentIdRef.current;
    if (!agentId || !projectDataReadyRef.current) return;
    if (sessionListRefreshInFlight.current) return;
    sessionListRefreshInFlight.current = true;
    try {
      const [data, archivedRows] = await Promise.all([
        api.getSessions(agentId),
        api.getArchivedSessions(agentId).catch(() => []),
      ]);
      setSessions(data);
      setArchivedSessions(Array.isArray(archivedRows) ? archivedRows : []);

      setChangesReady((prev) => {
        const next = { ...prev };
        const alive = new Set(data.map((x) => x.id));
        for (const k of Object.keys(next)) {
          if (!alive.has(k)) delete next[k];
        }
        for (const s of data) {
          if (!s.changes_ready) continue;
          try {
            next[s.id] =
              typeof s.changes_ready === 'string' ? JSON.parse(s.changes_ready) : s.changes_ready;
          } catch {
            /* ignore malformed JSON */
          }
        }
        return next;
      });

      const cur = activeSessionIdRef.current;
      if (cur && !data.some((s) => s.id === cur)) {
        const target = data[0];
        if (target) {
          setActiveSessionId(target.id);
          const ag = agentsRef.current.find((a) => a.id === agentId);
          setSessionEngine(target.engine || ag?.engine || 'claude-code');
          setSessionModel(
            target.model ||
              modelConfig?.engineDefaultModels?.[target.engine || ag?.engine || 'claude-code'] ||
              'claude-opus-4-8',
          );
          setSessionAskMode(isSessionAskModeEnabled(target));
        } else {
          setActiveSessionId(null);
          setMessages([]);
          const fallbackEngine =
            agentsRef.current.find((a) => a.id === agentId)?.engine || 'claude-code';
          setSessionEngine(fallbackEngine);
          setSessionModel(modelConfig?.engineDefaultModels?.[fallbackEngine] || 'claude-opus-4-8');
          setSessionAskMode(false);
        }
      }
    } catch (err) {
      console.warn('[Sessions] idle refresh failed:', err?.message || err);
    } finally {
      sessionListRefreshInFlight.current = false;
    }
  }, [modelConfig]);

  // Long-idle / missed-WebSocket reconciliation: sidebar lists are otherwise only
  // loaded on agent switch. Interval pauses while the window is hidden.
  useVisibleIntervalRefresh(silentRefreshSessions, 120_000, {
    enabled: projectDataReady && Boolean(activeAgentId),
  });

  useVisibleIntervalRefresh(refreshAgents, 300_000, {
    enabled: projectDataReady,
  });

  // WebSocket handler
  const handleWsMessage = useCallback(
    (data) => {
      // Is this event for the session the user is currently viewing?
      const forActiveSession = data.sessionId && data.sessionId === activeSessionIdRef.current;
      // 'message' events use message.session_id rather than top-level sessionId.
      const msgForActiveSession = data.message?.session_id === activeSessionIdRef.current;

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
        case 'awaiting-input-snapshot': {
          // Replace the awaiting-input map from server snapshot (sent right
          // after `active-tasks-snapshot` on connect). Notification firing is
          // intentionally NOT done from this branch — snapshot rows describe
          // sessions that were already waiting before this socket connected,
          // so flooding the user with toast/desktop notifications on reload
          // (or on a network reconnect mid-session) would be noise. The
          // `wasWaiting` check in `awaiting_input` below guarantees a fresh
          // session entering the waiting state notifies exactly once.
          setAwaitingInputBySession(applyAwaitingInputSnapshot(data.items));
          break;
        }
        case 'awaiting_input': {
          // Live transition into / out of the awaiting-input state. Fires
          // from `broadcastAwaitingInputForSession` server-side after every
          // chat turn completes (waiting:true on a stop, waiting:false on a
          // clean turn or a user answer that landed before the next ask).
          const sid = data.sessionId;
          if (!sid) break;
          const prev = awaitingInputBySessionRef.current;
          const wasWaiting = !!prev[sid];
          setAwaitingInputBySession((current) => applyAwaitingInputEvent(current, data));
          if (
            data.waiting &&
            shouldNotifyForAwaitingInput({
              wasWaiting,
              sessionId: sid,
              activeSessionId: activeSessionIdRef.current,
            })
          ) {
            const session = sessionsRef.current.find((s) => s.id === sid);
            const agent = agentsRef.current.find(
              (a) => a.id === (data.agentId || session?.agent_id),
            );
            const askCount = Array.isArray(data.askIds) ? data.askIds.length : 1;
            const { title, body } = awaitingInputNotification({
              agentName: agent?.name,
              sessionName: session?.name || data.sessionName,
              askCount,
            });
            setToasts((toasts) => [
              ...toasts,
              {
                id: `awaiting-input-${sid}-${Date.now()}`,
                type: 'info',
                message: session?.name || data.sessionName || 'Agent waiting for input',
                duration: 10000,
                onClick: () =>
                  focusAgentSessionRef.current?.(data.agentId || session?.agent_id, sid),
              },
            ]);
            notify({ title, body, type: 'info' });
          }
          break;
        }
        case 'message':
          if (msgForActiveSession && data.message?.id) {
            if (data.message.role === 'user') {
              setMessages((prev) => {
                if (prev.some((m) => m.id === data.message.id)) return prev;
                return [...prev, data.message];
              });
            } else if (data.message.role === 'assistant' && data.message.agent_id) {
              // Advisor turn — executor messages arrive on `done` instead.
              setMessages((prev) => {
                if (prev.some((m) => m.id === data.message.id)) return prev;
                return [...prev, data.message];
              });
              setThinking(false);
              setStreamingContent('');
              setStreamingMsgId(null);
              setStreamingEngine(null);
              setStreamingAgent(null);
            }
          }
          break;
        case 'thinking':
          if (data.sessionId) {
            setReactLoopStepsBySession((prev) => ({ ...prev, [data.sessionId]: [] }));
          }
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
            if (data.agentId) {
              setStreamingAgent({
                agentId: data.agentId,
                agentName: data.agentName,
                agentColor: data.agentColor,
              });
            } else {
              setStreamingAgent(null);
            }
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
            if (data.agentId) {
              setStreamingAgent({
                agentId: data.agentId,
                agentName: data.agentName,
                agentColor: data.agentColor,
              });
            }
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

          // Track subagent spawns and completions per session
          if (event?.type === 'tool_use' && (event.tool === 'Task' || event.tool === 'Agent')) {
            const sid = data.sessionId;
            setSubagents((prev) => {
              const entry = prev[sid] || {
                total: 0,
                running: 0,
                done: 0,
                errored: 0,
                ids: new Set(),
              };
              if (entry.ids.has(event.id)) return prev; // dedup
              const next = {
                ...entry,
                total: entry.total + 1,
                running: entry.running + 1,
                ids: new Set(entry.ids),
              };
              next.ids.add(event.id);
              return { ...prev, [sid]: next };
            });
          }
          if (event?.type === 'tool_result') {
            const sid = data.sessionId;
            setSubagents((prev) => {
              const entry = prev[sid];
              if (!entry || !entry.ids.has(event.toolUseId)) return prev;
              return {
                ...prev,
                [sid]: {
                  ...entry,
                  running: entry.running - 1,
                  ...(event.isError ? { errored: entry.errored + 1 } : { done: entry.done + 1 }),
                },
              };
            });
          }

          // Track rate-limit throttle state per session
          if (event?.type === 'rate_limit') {
            const sid = data.sessionId;
            const retryMs = event.retryAfterMs || 5000;
            setThrottle((prev) => ({
              ...prev,
              [sid]: { active: true, retryAfterMs: retryMs, ts: Date.now() },
            }));
            // Auto-clear throttle indicator after retry period elapses
            setTimeout(() => {
              setThrottle((prev) => {
                const entry = prev[sid];
                if (!entry || !entry.active) return prev;
                return { ...prev, [sid]: { ...entry, active: false } };
              });
            }, retryMs + 1000);
          }
          break;
        }
        case 'session-progress': {
          // Drives the in-Hub ProgressPanel for this session. The server sends
          // one message per progress_step event; we reduce it into the ordered
          // list keyed by sessionId.
          const sid = data.sessionId;
          if (!sid) break;
          setSessionProgress((prev) => ({
            ...prev,
            [sid]: mergeProgressEvent(prev[sid] || [], {
              step: data.step,
              status: data.status,
              startedAt: data.startedAt,
              finishedAt: data.finishedAt ?? undefined,
            }),
          }));
          break;
        }
        case 'react_loop_step': {
          const sid = data.sessionId;
          if (!sid || !data.stepId) break;
          const entry = {
            stepId: data.stepId,
            phase: data.phase,
            tool: data.tool,
            exitCode: data.exitCode,
            durationMs: data.durationMs,
            continuationDepth: data.continuationDepth ?? 0,
            detail: data.detail,
            receivedAt: Date.now(),
          };
          setReactLoopStepsBySession((prev) => {
            const cur = prev[sid] || [];
            return { ...prev, [sid]: [...cur, entry].slice(-40) };
          });
          break;
        }
        case 'browser_activity_screenshot': {
          const sid = data.sessionId;
          const mid = data.messageId;
          const aid = data.actionId;
          const screenshotDataUrl = data.screenshotDataUrl;
          if (!sid || !mid || !aid || typeof screenshotDataUrl !== 'string') break;
          setBrowserScreensBySession((prev) =>
            mergeBrowserActivityScreenshot(prev, sid, mid, aid, screenshotDataUrl),
          );
          break;
        }
        case 'done':
          setActiveTasks((prev) => {
            const next = { ...prev };
            delete next[data.sessionId];
            return next;
          });
          // Clear throttle state for completed session
          setThrottle((prev) => {
            if (!prev[data.sessionId]) return prev;
            const next = { ...prev };
            delete next[data.sessionId];
            return next;
          });
          // Clear subagent tracking for completed session
          setSubagents((prev) => {
            if (!prev[data.sessionId]) return prev;
            const next = { ...prev };
            delete next[data.sessionId];
            return next;
          });
          if (forActiveSession) {
            setThinking(false);
            setStreamingContent('');
            setStreamingMsgId(null);
            setStreamingEngine(null);
            setStreamingAgent(null);
            if (data.message) {
              setMessages((prev) => {
                if (prev.some((m) => m.id === data.message.id)) return prev;
                return [...prev, data.message];
              });
            }
          }
          // Desktop notification + toast for completed background sessions
          if (!forActiveSession && data.message) {
            const session = sessionsRef.current.find((s) => s.id === data.sessionId);
            const agent = session ? agentsRef.current.find((a) => a.id === session.agent_id) : null;
            const agentName = agent?.name || 'Agent';
            const preview =
              typeof data.message.content === 'string'
                ? data.message.content.replace(/\n+/g, ' ').trim()
                : undefined;
            const { title, body } = sessionCompleteNotification({
              agentName,
              sessionName: session?.name,
              preview,
            });
            setToasts((prev) => [
              ...prev,
              {
                id: `session-done-${data.sessionId}-${Date.now()}`,
                type: 'success',
                message: session?.name || 'Session completed',
                duration: 10000,
                onClick: () => focusAgentSessionRef.current?.(session?.agent_id, data.sessionId),
              },
            ]);
            notify({ title, body, type: 'success' });
          }
          break;
        case 'changes_ready': {
          const alreadyPrompted = !!changesReadyRef.current[data.sessionId];
          setChangesReady((prev) => ({
            ...prev,
            [data.sessionId]: {
              agentId: data.agentId,
              branch: data.branch,
              hasUncommitted: data.hasUncommitted,
              hasUnpushed: data.hasUnpushed,
            },
          }));
          // Only notify on a fresh prompt — avoids re-firing on reconnect/replay.
          if (!alreadyPrompted) {
            const session = sessionsRef.current.find((s) => s.id === data.sessionId);
            const agent = agentsRef.current.find((a) => a.id === data.agentId);
            const { title, body } = prReadyNotification({
              agentName: agent?.name,
              sessionName: session?.name,
              branch: data.branch,
            });
            setToasts((prev) => [
              ...prev,
              {
                id: `pr-ready-${data.sessionId}-${Date.now()}`,
                type: 'info',
                message: session?.name || 'Changes ready for PR',
                duration: 10000,
                onClick: () => focusAgentSessionRef.current?.(data.agentId, data.sessionId),
              },
            ]);
            notify({ title, body, type: 'info' });
          }
          break;
        }
        case 'auto_pr_created': {
          // Clear changes_ready state when a PR is created (manually or automatically)
          setChangesReady((prev) => {
            if (!prev[data.sessionId]) return prev;
            const next = { ...prev };
            delete next[data.sessionId];
            return next;
          });
          if (currentViewRef.current === 'pulls') {
            setPullsListRefreshNonce((n) => n + 1);
          }
          break;
        }
        case 'auto_pr_failed': {
          // The server emits this from autoCommitAndPR when the autonomous /
          // ad-hoc-with-existing-PR path fails (push rejected, commit failed,
          // gh pr create errored). The session timeline already gets a
          // durable system message with `kind: 'pr_failed'`; the toast is a
          // transient nudge so the user notices without scrolling the chat.
          // Skip the toast on benign codes (none broadcast here — server
          // filters nothing_to_publish — but defensive against future codes).
          if (data.sessionId && typeof data.code === 'string') {
            if (data.sessionId === activeSessionIdRef.current) {
              setShipFailureAt(Date.now());
            }
            const codeLabel =
              data.code === 'push_failed'
                ? 'Push rejected'
                : data.code === 'commit_failed'
                  ? 'Commit failed'
                  : data.code === 'pr_failed'
                    ? 'PR creation failed'
                    : data.code === 'rebase_conflict'
                      ? 'Rebase conflict'
                      : 'Auto-PR failed';
            setToasts((prev) => [
              ...prev,
              {
                id: `pr-failed-${data.sessionId}-${Date.now()}`,
                type: 'error',
                message: `${codeLabel}${data.cardTitle ? `: ${data.cardTitle}` : ''}`,
                duration: 12000,
                onClick: () =>
                  data.agentId && focusAgentSessionRef.current?.(data.agentId, data.sessionId),
              },
            ]);
          }
          break;
        }
        case 'done_verify_log':
          if (data.sessionId && typeof data.text === 'string') {
            const maxChars = 250_000;
            _setDoneVerifyLogBySession((prev) => {
              const existing = prev[data.sessionId];
              const combined = (existing ? existing.log : '') + data.text;
              const log = combined.length > maxChars ? combined.slice(-maxChars) : combined;
              return {
                ...prev,
                [data.sessionId]: { log, receivedAt: existing ? existing.receivedAt : Date.now() },
              };
            });
          }
          break;
        case 'done_verify_log_done':
          if (data.sessionId) {
            _setDoneVerifyLogBySession((prev) => {
              if (!prev[data.sessionId]) return prev;
              const next = { ...prev };
              delete next[data.sessionId];
              return next;
            });
          }
          break;
        case 'message_added':
          // A new message (e.g. the system 'PR created' marker persisted by the
          // server) was inserted on the backend. If it belongs to the active
          // session, append it to the timeline — guarded by an id-dedup check
          // so a double broadcast can never duplicate-render.
          if (forActiveSession && data.message?.id) {
            setMessages((prev) => {
              if (prev.some((m) => m.id === data.message.id)) return prev;
              return [...prev, data.message];
            });
          }
          break;
        case 'session-updated':
          // Raw `sessions` table row from `getSession` (same columns as list endpoints).
          // Unlike `GET /api/sessions/:id`, this payload is not enriched with
          // `orchestrationMeta` — use snake_case `orchestration_meta` on the row. Spreading
          // replaces the prior object so DB fields stay in sync; if the payload ever becomes
          // partial, merge field-by-field.
          setSessions((prev) =>
            prev.map((s) => (s.id === data.session.id ? { ...s, ...data.session } : s)),
          );
          if (
            data.session?.id === activeSessionIdRef.current &&
            Array.isArray(data.session.agents)
          ) {
            setSessionAgents(data.session.agents);
          }
          break;
        case 'session-worktree-detected':
          // Worktree-only mode: keep the session-row flag in sync for any
          // debugging surfaces / future tooling, but the user-facing
          // detection badge was removed.
          setSessions((prev) =>
            prev.map((s) =>
              s.id === data.sessionId
                ? { ...s, git_worktree_detected: data.gitWorktree ? 1 : 0 }
                : s,
            ),
          );
          break;
        case 'worktree_failed': {
          const sid = data.sessionId;
          if (!sid) break;
          setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, use_worktree: 0 } : s)));
          if (sid === activeSessionIdRef.current && data.error) {
            showToast(`Worktree creation failed: ${data.error}`, 'warning', 8000);
          }
          break;
        }
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
            setStreamingAgent(null);
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
        case 'interrupted':
          if (forActiveSession) {
            pinChatTail(streamingMsgIdRef.current);
            setThinking(false);
            setStreamingContent('');
            setStreamingMsgId(null);
            setStreamingEngine(null);
            setStreamingAgent(null);
          }
          // Defensive cleanup: a cancelled turn may have persisted a partial
          // assistant message containing an ask block. The user explicitly
          // stopped the run, so don't dangle a stale "needs your input"
          // indicator. If the partial really did contain an unanswered ask,
          // the next chat turn's `done` will re-emit `awaiting_input` and
          // the indicator returns naturally.
          setAwaitingInputBySession((prev) => clearAwaitingInputForSession(prev, data.sessionId));
          break;
        case 'session_round_start':
          if (forActiveSession) setSessionRoundProcessing(true);
          break;
        case 'session_round_done':
          if (forActiveSession) setSessionRoundProcessing(false);
          break;

        // ─── Claude Design events ────────────────────────────────
        case 'design_created':
          // Broadcast from any client creating a design — refresh list
          if (data.design) {
            setDesigns((prev) => {
              if (prev.some((d) => d.id === data.design.id)) return prev;
              return [data.design, ...prev];
            });
          }
          break;
        case 'design_deleted':
          setDesigns((prev) => prev.filter((d) => d.id !== data.designId));
          if (activeDesignIdRef.current === data.designId) {
            setActiveDesignId(null);
            setDesignMessages([]);
            setDesignStreaming(null);
            setDesignThinking(false);
            setDesignProcessing(false);
            setCurrentView('designs');
          }
          break;
        case 'design_updated':
          // Fires once per assistant turn — bump the iframe reload token for
          // the active design so the canvas re-fetches the new files.
          if (data.designId === activeDesignIdRef.current) {
            setDesignReloadToken((t) => t + 1);
            setDesignStreaming(null);
            setDesignThinking(false);
            setDesignProcessing(false);
          }
          // Also refresh design row metadata (updated_at) in the list.
          setDesigns((prev) =>
            prev.map((d) =>
              d.id === data.designId ? { ...d, updated_at: new Date().toISOString() } : d,
            ),
          );
          break;
        case 'design_metadata_updated':
          if (data.design?.id) {
            setDesigns((prev) =>
              prev.map((d) => (d.id === data.design.id ? { ...d, ...data.design } : d)),
            );
          }
          break;
        case 'design_message_added':
          if (data.designId === activeDesignIdRef.current && data.message) {
            // Streaming token deltas arrive as the same messageId with growing content;
            // the final message also arrives as 'design_message_added'. Treat assistant
            // deltas by keeping a separate streaming slot and flushing on role=='assistant'
            // with a final flag (or when the message already exists in the list).
            const msg = data.message;
            if (msg.role === 'assistant' && msg.streaming) {
              setDesignThinking(false);
              setDesignStreaming({ messageId: msg.id, content: msg.content || '' });
              setDesignProcessing(true);
              break;
            }
            setDesignStreaming(null);
            setDesignThinking(false);
            setDesignMessages((prev) => {
              if (prev.some((m) => m.id === msg.id)) {
                return prev.map((m) => (m.id === msg.id ? msg : m));
              }
              return [...prev, msg];
            });
            // Keep processing=true until design_updated closes the turn; a user
            // message shouldn't flip processing off.
            if (msg.role === 'assistant') {
              setDesignProcessing(false);
            }
          }
          break;

        case 'design_cancelled':
          if (data.designId === activeDesignIdRef.current) {
            setDesignStreaming(null);
            setDesignThinking(false);
            setDesignProcessing(false);
          }
          break;
        case 'design_thinking':
          if (data.designId === activeDesignIdRef.current) {
            setDesignThinking(true);
            setDesignProcessing(true);
          }
          break;
        case 'design_stream':
          // Server emits cumulative stdout on every chunk. As soon as any
          // partial text arrives, we flip from the "thinking…" dot to the
          // streaming view so the user sees progress. Ignored when the event
          // is for a design the user has since navigated away from.
          if (data.designId === activeDesignIdRef.current) {
            setDesignThinking(false);
            setDesignProcessing(true);
            setDesignStreaming({ content: data.content || '' });
          }
          break;

        // ─── Delegation events ────────────────────────────────
        case 'delegation_start':
          if (data.sessionId === activeSessionIdRef.current) {
            const delegationStartedAt = Date.now();
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
                  startedAt: delegationStartedAt,
                })),
              },
            }));
            // A fresh round just kicked off — clear any stale dispatch-error
            // banner so the new card doesn't inherit the previous failure.
            setDelegationDispatchErrors((prev) => {
              if (!prev[data.sessionId]) return prev;
              const next = { ...prev };
              delete next[data.sessionId];
              return next;
            });
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
                      ? {
                          ...t,
                          delegationId: data.delegationId,
                          agentName: data.agentName,
                          agentColor: data.agentColor,
                          status: 'running',
                        }
                      : t,
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
                      ? {
                          ...t,
                          agentName: data.agentName,
                          agentColor: data.agentColor,
                          content: data.content,
                          status: 'running',
                        }
                      : t,
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
                      : t,
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
                    t.agentId === data.agentId ? { ...t, status: 'error', error: data.error } : t,
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
                      : t,
                  ),
                },
              };
            });
          }
          break;
        case 'delegation_error': {
          const delegationMsg = `Delegation failed: ${data.error}`;
          if (data.sessionId === activeSessionIdRef.current) {
            setToasts((prev) => [
              ...prev,
              {
                id: `delegation-err-${Date.now()}`,
                type: 'error',
                message: delegationMsg,
                duration: 10000,
              },
            ]);
          }
          // Stash the error so the message-anchored DelegateCard can render a
          // persistent "Dispatch failed: …" banner. Without this, a user who
          // missed the toast saw an indefinite "Queued" spinner with no clue
          // why the round never started.
          if (data.sessionId) {
            setDelegationDispatchErrors((prev) => ({
              ...prev,
              [data.sessionId]: {
                message: typeof data.error === 'string' ? data.error : 'Unknown dispatch error',
                parentMessageId:
                  typeof data.parentMessageId === 'string' ? data.parentMessageId : null,
              },
            }));
          }
          notify({ title: 'Delegation Error', body: delegationMsg, type: 'error' });
          break;
        }
        case 'delegation_disabled': {
          // Operator gate: lead has `delegationEnabled === false`. The server
          // already persisted the explanatory system message — we just need
          // to anchor a card-level banner so users browsing history without
          // the system-message visible (e.g. compact view) still see why
          // dispatch never started. Reuse the dispatchError state slot with
          // a `kind: 'disabled'` discriminator so DelegateCard can render
          // distinct copy (informational, not failure-red).
          if (data.sessionId) {
            const reason =
              typeof data.reason === 'string' && data.reason.length > 0
                ? data.reason
                : 'Delegation disabled for this lead';
            setDelegationDispatchErrors((prev) => ({
              ...prev,
              [data.sessionId]: {
                kind: 'disabled',
                message: reason,
                parentMessageId:
                  typeof data.parentMessageId === 'string' ? data.parentMessageId : null,
              },
            }));
          }
          break;
        }

        case 'sessions_resuming': {
          const count = data.count || 0;
          const toast = {
            id: `sessions-resuming-${Date.now()}`,
            type: 'info',
            message: `Resuming ${count} interrupted session${count !== 1 ? 's' : ''} after server restart…`,
            duration: 10000,
          };
          setToasts((prev) => [...prev, toast]);
          break;
        }
        case 'analyze-progress':
        case 'analyze-complete':
        case 'analyze-error':
          window.dispatchEvent(new CustomEvent('analyze-ws', { detail: data }));
          break;
        case 'clone-progress':
        case 'clone-complete':
        case 'clone-error':
        case 'clone-preview-defaults':
          window.dispatchEvent(new CustomEvent('clone-ws', { detail: data }));
          break;
        case 'preview-defaults-detected':
          window.dispatchEvent(new CustomEvent('preview-defaults-ws', { detail: data }));
          break;
        // AI-assisted preview setup wizard broadcasts. The route spawns
        // a session (`preview_wizard_started`) and the skill pings the
        // completion endpoint after persisting config + secrets
        // (`preview_wizard_complete`). PreviewSection listens for the
        // completion event to refetch the project record.
        case 'preview_wizard_started':
          window.dispatchEvent(
            new CustomEvent('agenthub:preview_wizard_started', { detail: data }),
          );
          break;
        case 'preview_wizard_complete':
          window.dispatchEvent(
            new CustomEvent('agenthub:preview_wizard_complete', { detail: data }),
          );
          break;
        case 'workflow_run':
        case 'workflow_run_status':
        case 'workflow_update':
          if (data.projectId) {
            setWorkflowSidebarBadgeByProject((prev) => ({ ...prev, [data.projectId]: true }));
            window.dispatchEvent(new CustomEvent('agenthub-workflow-ws', { detail: data }));
          }
          break;
        case 'task_complete': {
          const taskStatus = data.status === 'done' ? 'success' : 'error';
          const taskMsg =
            data.status === 'done'
              ? `Background task completed${data.preview ? ': ' + data.preview.substring(0, 80) + '...' : ''}`
              : 'Background task failed';
          setToasts((prev) => [
            ...prev,
            {
              id: `task-${data.taskId}-${Date.now()}`,
              type: taskStatus,
              message: taskMsg,
              duration: 10000,
              onClick: data.sessionId
                ? () => {
                    const row = sessionsRef.current.find((s) => s.id === data.sessionId);
                    focusAgentSessionRef.current?.(row?.agent_id, data.sessionId);
                  }
                : undefined,
            },
          ]);
          notify({
            title: data.status === 'done' ? 'Task Complete' : 'Task Failed',
            body: taskMsg,
            type: taskStatus,
          });
          window.dispatchEvent(new CustomEvent('task-complete', { detail: data }));
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
            prev.map((m) => (m.id === data.messageId ? { ...m, content: data.content } : m)),
          );
          break;

        case 'cron_session_update':
          api
            .getCronSessions()
            .then(setCronSessions)
            .catch(() => {});
          break;

        case 'kanban_update':
          setKanbanRefreshKey((k) => k + 1);
          if (
            data.projectId &&
            pullsProjectIdRef.current === data.projectId &&
            currentViewRef.current === 'pulls'
          ) {
            setPullsListRefreshNonce((n) => n + 1);
          }
          break;

        case 'projects_updated':
          // Server added/changed an agent or project (e.g. GitHub App auto-setup
          // seeded a Reviewer agent). Re-fetch so the sidebar reflects it
          // without requiring a page refresh.
          refreshAgents();
          break;

        case 'webhook_hmac_failure': {
          // The webhook handler rejected a GitHub delivery because neither
          // the per-repo nor the GitHub App webhook secret could verify
          // the `x-hub-signature-256` header. Banner it loudly so the
          // operator can rotate / re-sync the secret instead of finding
          // out hours later via "why hasn't the reviewer agent responded?".
          const where = data.repoFullName || 'a repo';
          const what = data.eventLabel || 'a webhook event';
          const triedBoth = data.triedSources === 'repo + github-app';
          const hint = data.isAppDelivery
            ? 'GitHub App delivery — the App webhook secret on GitHub may have rotated. ' +
              'Settings → GitHub → Sync webhook secret will push our local copy.'
            : triedBoth
              ? 'Neither the per-repo nor the App webhook secret matched.'
              : 'Per-repo webhook secret mismatch.';
          const banner = `Webhook rejected for ${where} (${what}). ${hint}`;
          const toast = {
            id: `webhook-hmac-fail-${data.deliveryId || Date.now()}`,
            type: 'error',
            message: banner,
            duration: 15000,
          };
          setToasts((prev) => [...prev, toast]);
          notify({
            title: 'Webhook HMAC failure',
            body: banner,
            type: 'error',
          });
          break;
        }

        case 'dispatch_failure': {
          const dispatchMsg = `Dispatch failed (${data.source}): ${data.cardTitle} — ${data.reason}`;
          const toast = {
            id: `dispatch-failure-${Date.now()}`,
            type: 'error',
            message: dispatchMsg,
            duration: 10000,
          };
          setToasts((prev) => [...prev, toast]);
          notify({ title: 'Dispatch Failure', body: dispatchMsg, type: 'error' });
          // Also refresh kanban to show the new card comment
          setKanbanRefreshKey((k) => k + 1);
          break;
        }

        // ── Ticket lifecycle notifications ─────────────────────────
        case 'card_moved': {
          const colLower = (data.columnName || '').toLowerCase();
          const navigateCardToast = () => {
            if (data.sessionId && data.agentId) {
              focusAgentSessionRef.current?.(data.agentId, data.sessionId);
            } else if (data.projectId) {
              setCurrentView(`kanban:${data.projectId}`);
              setSidebarOpen(false);
            }
          };
          const canNavigateCardToast = Boolean((data.sessionId && data.agentId) || data.projectId);
          if (colLower === 'in progress') {
            const { title, body } = cardStartedNotification(data);
            setToasts((prev) => [
              ...prev,
              {
                id: `card-started-${data.cardId}-${Date.now()}`,
                type: 'info',
                message: body,
                duration: 8000,
                onClick: canNavigateCardToast ? navigateCardToast : undefined,
              },
            ]);
            notify({ title, body, type: 'info' });
          } else if (colLower === 'review') {
            const { title, body } = cardReviewNotification(data);
            setToasts((prev) => [
              ...prev,
              {
                id: `card-review-${data.cardId}-${Date.now()}`,
                type: 'info',
                message: body,
                duration: 8000,
                onClick: canNavigateCardToast ? navigateCardToast : undefined,
              },
            ]);
            notify({ title, body, type: 'info' });
          }
          break;
        }

        case 'webhook_pr_merged': {
          const { title, body } = prMergedNotification(data);
          const navigatePrMergedToast = () => {
            if (data.sessionId && data.agentId) {
              focusAgentSessionRef.current?.(data.agentId, data.sessionId);
            } else if (data.prUrl) {
              window.open(String(data.prUrl), '_blank', 'noopener,noreferrer');
            } else if (data.projectId) {
              setPullsProjectId(data.projectId);
              setCurrentView('pulls');
              setSidebarOpen(false);
            }
          };
          const canNavigatePrMerged = Boolean(
            (data.sessionId && data.agentId) || data.prUrl || data.projectId,
          );
          setToasts((prev) => [
            ...prev,
            {
              id: `pr-merged-${data.prNumber}-${Date.now()}`,
              type: 'success',
              message: body,
              duration: 10000,
              onClick: canNavigatePrMerged ? navigatePrMergedToast : undefined,
            },
          ]);
          notify({ title, body, type: 'success' });
          setKanbanRefreshKey((k) => k + 1);
          break;
        }

        // ── Thread notifications ─────────────────────────────────
        case 'thread_created': {
          // Live-update ThreadList if viewing threads for this project
          if (threadListRef.current && threadsProjectIdRef.current === data.projectId) {
            threadListRef.current.addThread(data.thread);
          }
          const { title, body } = threadCreatedNotification({
            threadName: data.thread.name,
            threadType: data.thread.type,
          });
          setToasts((prev) => [
            ...prev,
            {
              id: `thread-created-${data.thread.id}-${Date.now()}`,
              type: 'info',
              message: body,
              duration: 6000,
            },
          ]);
          notify({ title, body, type: 'info' });
          break;
        }

        case 'thread_entry_created': {
          const isError = data.entry?.content?.startsWith('ERROR:');
          // Live-update ThreadView if viewing this thread
          if (threadViewRef.current && activeThreadIdRef.current === data.threadId) {
            threadViewRef.current.addEntry(data.entry);
          } else {
            // Increment unread count for the project (we need to find it from data)
            // The broadcast includes threadId — look up the project via thread cache
            // For simplicity, increment for all projects that have threads view open or track globally
            setUnreadThreadCounts((prev) => {
              const pid = data.projectId;
              if (!pid) return prev;
              return { ...prev, [pid]: (prev[pid] || 0) + 1 };
            });
          }
          // Build notification — need thread name which the server should include
          const threadName = data.threadName || 'Thread';
          const threadType = data.threadType || 'cron';
          const preview = data.entry?.content?.replace(/\n+/g, ' ').trim();
          const { title, body } = threadEntryNotification({
            threadName,
            threadType,
            preview,
            isError,
          });
          // Only toast for errors or when not actively viewing the thread
          if (
            isError ||
            activeThreadIdRef.current !== data.threadId ||
            currentViewRef.current !== 'threads'
          ) {
            setToasts((prev) => [
              ...prev,
              {
                id: `thread-entry-${data.entry.id}-${Date.now()}`,
                type: isError ? 'error' : 'info',
                message: body,
                duration: isError ? 10000 : 6000,
              },
            ]);
          }
          notify({ title, body, type: isError ? 'error' : 'info' });
          break;
        }

        case 'thread_deleted': {
          // Live-update ThreadList
          if (threadListRef.current && threadsProjectIdRef.current === data.projectId) {
            threadListRef.current.removeThread(data.threadId);
          }
          // If viewing the deleted thread, go back to list
          if (activeThreadIdRef.current === data.threadId) {
            setActiveThreadId(null);
            setActiveThread(null);
          }
          break;
        }

        case 'wiki_update':
          window.dispatchEvent(new CustomEvent('wiki_update', { detail: data }));
          break;

        case 'wiki_delete':
          window.dispatchEvent(new CustomEvent('wiki_delete', { detail: data }));
          break;

        // Finalize reviewer-dispatch fires one of these per row after the
        // COMMIT (see server/finalize/reviewer-dispatch.ts). Bridged to a
        // window CustomEvent so `<ReviewerThreadsPanel />` can refetch
        // without subscribing to the WS directly.
        case 'reviewer_thread_added':
          window.dispatchEvent(new CustomEvent('reviewer_thread_added', { detail: data }));
          break;

        // Finalize Code Changes lifecycle events. Bridged identically to
        // `reviewer_thread_added` so the `useFinalizeRun` hook (used by
        // both the session-view checks panel and the kanban card badge)
        // can subscribe via `window.addEventListener` without taking a
        // dependency on the shared WS connection.
        //
        // `phase_changed` and `step_state` are emitted server-side today
        // (rebase / reviewer-dispatch / step-runner / stall-watchdog).
        // `active_seconds`, `created`, and `completed` are reserved by
        // the design doc (§14) but not yet wired in `server/finalize/`.
        // Bridging them now is harmless — listeners simply never fire
        // until the server starts emitting — and avoids a follow-up
        // round-trip when the producer side lands.
        case 'finalize_run_phase_changed':
        case 'finalize_run_step_state':
        case 'finalize_run_active_seconds':
        case 'finalize_run_created':
        case 'finalize_run_completed':
          window.dispatchEvent(new CustomEvent(data.type, { detail: data }));
          break;

        case 'lead_review':
          setActiveReviews((prev) => ({
            ...prev,
            [data.reviewerAgent]: {
              prUrl: data.prUrl,
              cardTitle: data.cardTitle,
              sessionId: data.sessionId,
            },
          }));
          break;

        case 'lead_review_complete':
          setActiveReviews((prev) => {
            const next = { ...prev };
            // Remove by matching agentId — the lead_review event uses agent name as key, but we also check by agentId
            for (const [key, val] of Object.entries(next)) {
              if (val.sessionId === data.sessionId) delete next[key];
            }
            return next;
          });
          break;

        case 'session_created': {
          // Kanban assign, autonomous dispatch, handoff target session, another
          // browser tab POST /sessions, etc. — splice into the sidebar without
          // a full refetch when the session belongs to the active agent.
          const row = data.session;
          if (row?.id) {
            sessionsByIdRef.current.set(row.id, row);
            setSessionsIndexTick((t) => t + 1);
          }
          if (row && data.agentId === activeAgentIdRef.current) {
            setSessions((prev) => {
              if (prev.some((s) => s.id === row.id)) return prev;
              return [row, ...prev];
            });
          }
          break;
        }

        case 'session_workspace_ready': {
          const row = data.session;
          const sid = data.sessionId || row?.id;
          if (!sid || !row) break;
          setSessions((prev) => prev.map((s) => (s.id === sid ? row : s)));
          setWorkspaceEnsuringBySession((prev) => {
            if (!prev[sid]) return prev;
            const next = { ...prev };
            delete next[sid];
            return next;
          });
          workspaceEnsureInFlightRef.current.delete(sid);
          break;
        }

        case 'session_deleted':
          tearDownSessionPreviewRef.current?.(data.sessionId);
          setSessions((prev) => prev.filter((s) => s.id !== data.sessionId));
          // Drop any awaiting-input flag — the session is gone, so an
          // indicator pointing at it would dangle.
          setAwaitingInputBySession((prev) => clearAwaitingInputForSession(prev, data.sessionId));
          if (activeSessionIdRef.current === data.sessionId) {
            setActiveSessionId(null);
          }
          break;

        case 'session_restored': {
          // Server broadcast after POST /api/sessions/:id/restore. We re-home
          // the row in the live list without a full refetch and drop it from
          // the Archived sidebar section. Tolerant of either identifier
          // shape because the backend payload carries both.
          const restoredId = data.sessionId || data.session?.id;
          if (!restoredId) break;
          setArchivedSessions((prev) => prev.filter((s) => s.id !== restoredId));
          if (data.session && data.session.agent_id === activeAgentIdRef.current) {
            setSessions((prev) => {
              if (prev.some((s) => s.id === restoredId)) return prev;
              return [data.session, ...prev];
            });
          }
          break;
        }

        case 'handoff_start': {
          // Append the just-created handoff row to the source session's list
          // so the HandoffCard "Open session" link appears without needing a
          // refresh. Only relevant when the source session is currently open.
          if (data.sessionId === activeSessionIdRef.current) {
            setSessionHandoffs((prev) => {
              if (prev.some((h) => h.id === data.handoffId)) return prev;
              return [
                ...prev,
                {
                  id: data.handoffId,
                  from_session_id: data.sessionId,
                  to_session_id: data.toSessionId,
                  from_agent_id: data.fromAgentId,
                  to_agent_id: data.toAgentId,
                  note: null,
                  status: 'delivered',
                  error: null,
                },
              ];
            });
          }
          break;
        }

        case 'session_forwarded': {
          // A session was forwarded somewhere — if the new session belongs to
          // the currently-active agent, splice it into the sidebar list so the
          // user sees it without a refresh. The initiating client also calls
          // onForwarded directly for optimistic navigation.
          const newSession = data.session;
          if (newSession && newSession.agent_id === activeAgentIdRef.current) {
            setSessions((prev) => {
              if (prev.some((s) => s.id === newSession.id)) return prev;
              return [newSession, ...prev];
            });
          }
          break;
        }

        case 'code_changed': {
          const sid = data.sessionId;
          if (!sid || !sessionsRef.current.some((s) => s.id === sid)) break;
          const previewKind = previewEventBySessionRef.current[sid]?.kind;
          if (previewKind !== 'preview' && sid === activeSessionIdRef.current) {
            setPreviewPaneOpenBySession((prev) => ({ ...prev, [sid]: true }));
            showToast(
              'Code updated. Use Start preview below when you want to load the app (only you can start the preview server).',
              'info',
              9000,
            );
          }
          break;
        }

        case 'agenthub_preview': {
          // Per-session preview lifecycle event. Persist the latest event
          // keyed by sessionId so the SessionPreviewPane can render the
          // running app (or failure / unavailable state) inline. Auto-open
          // the pane on first arrival; subsequent updates respect whatever
          // the user explicitly closed.
          const sid = data.sessionId;
          if (!sid) break;
          if (!sessionsRef.current.some((s) => s.id === sid)) break;
          if (data.kind === 'preview_refresh') {
            setPreviewEventBySession((prev) => {
              const last = prev[sid];
              if (!last || last.kind !== 'preview') return prev;
              return {
                ...prev,
                [sid]: {
                  ...last,
                  refreshAt: data.refreshAt ?? Date.now(),
                  refreshReason: data.reason ?? '',
                },
              };
            });
            break;
          }
          if (data.kind === 'preview_stopped') {
            delete previewUserStoppedBySessionRef.current[sid];
            setPreviewEventBySession((prev) => {
              if (!prev[sid]) return prev;
              const next = { ...prev };
              delete next[sid];
              return next;
            });
            setPreviewStartingBySession((prev) => {
              if (!prev[sid]) return prev;
              const next = { ...prev };
              delete next[sid];
              return next;
            });
            break;
          }
          if (
            previewUserStoppedBySessionRef.current[sid] &&
            (data.kind === 'preview_failed' || data.kind === 'preview_starting')
          ) {
            break;
          }
          if (data.kind === 'preview_log' && data.line) {
            setPreviewEventBySession((prev) => {
              const last = prev[sid];
              if (!last || last.kind === 'preview_stopped') return prev;
              const logTail = appendPreviewLogTail(last.logTail, data.line);
              return { ...prev, [sid]: { ...last, logTail } };
            });
            break;
          }
          setPreviewEventBySession((prev) => {
            const last = prev[sid];
            const logTail = mergePreviewEventLogTail(data.logTail, last?.logTail);
            return { ...prev, [sid]: { ...data, logTail } };
          });
          setPreviewStartingBySession((prev) => {
            if (!prev[sid]) return prev;
            const next = { ...prev };
            delete next[sid];
            return next;
          });
          setPreviewPaneOpenBySession((prev) => {
            if (Object.prototype.hasOwnProperty.call(prev, sid)) return prev;
            try {
              const key = paneOpenStorageKey(sid);
              if (key && window.localStorage.getItem(key) === 'false') {
                return { ...prev, [sid]: false };
              }
            } catch {
              /* localStorage unavailable */
            }
            return { ...prev, [sid]: true };
          });
          break;
        }
        case 'handoff_error': {
          // Surface the failure on the source session's handoff list so the
          // UI can render a "Failed — <reason>" chip on the card instead of
          // the usual "Delivering…" placeholder.
          if (data.sessionId === activeSessionIdRef.current && data.handoffId) {
            setSessionHandoffs((prev) => {
              const existing = prev.find((h) => h.id === data.handoffId);
              if (existing) {
                return prev.map((h) =>
                  h.id === data.handoffId
                    ? { ...h, status: 'failed', error: data.error || 'Handoff failed' }
                    : h,
                );
              }
              return [
                ...prev,
                {
                  id: data.handoffId,
                  from_session_id: data.sessionId,
                  to_session_id: null,
                  from_agent_id: null,
                  to_agent_id: null,
                  note: null,
                  status: 'failed',
                  error: data.error || 'Handoff failed',
                },
              ];
            });
          }
          break;
        }
        default: {
          if (import.meta.env.DEV) {
            console.debug('[ws] unhandled message type:', data.type);
          }
          break;
        }
      }
    },
    [notify, refreshAgents, showToast, pinChatTail],
  );

  const { send, connected, reconnecting, wsRef } = useWebSocket(handleWsMessage);

  const handleCancel = useCallback(() => {
    if (activeSessionId) {
      const tailId = streamingMsgIdRef.current;
      pinChatTail(tailId);
      send({ type: 'cancel', sessionId: activeSessionId });
      setThinking(false);
      setStreamingContent('');
      setStreamingMsgId(null);
      setStreamingEngine(null);
    }
  }, [activeSessionId, send, pinChatTail]);

  // Called by SessionTail after it lazy-fetches historical events for a
  // legacy message. Hoists them into the shared map so subsequent renders
  // don't refetch.
  const handleEventsLoaded = useCallback((messageId, events) => {
    setEventsByMessage((prev) => {
      const existing = prev[messageId];
      // Re-fetch if we only have a cached [] (e.g. race) or if live WS never arrived.
      if (Array.isArray(existing) && existing.length > 0) return prev;
      return { ...prev, [messageId]: events };
    });
  }, []);

  // Migrate legacy connection config, ensure the server is pointed at the
  // active org's data directory, THEN load projects/setup status.
  // Sequential: org/switch must complete before we fetch data, otherwise
  // the server might still be pointed at the previous org.
  useEffect(() => {
    const init = async () => {
      // Step 0: Migrate legacy localStorage orgs to server, then fetch org list
      await migrateFromLegacy();
      await fetchOrgs();

      // Step 1: For local orgs, tell the local server which org's data to serve.
      const activeOrg = getActiveOrg();
      if (activeOrg && activeOrg.mode !== 'remote') {
        try {
          await fetch(`${getApiBase()}/orgs/${activeOrg.id}/switch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          });
        } catch {} // server may not support it yet
      }

      // Step 2: Check setup status
      //
      // Three triggers for the SetupWizard, in priority order:
      //
      //   1. **Auth not configured.** No Agent Hub Owner record exists
      //      (`/setup/status` -> `authConfigured: false`). This is the
      //      authoritative "fresh install" signal. We force the full
      //      wizard from step 1 because the user still needs to create an
      //      Owner account regardless of host-CLI auth state or whether
      //      the server auto-seeded a default org. Pre-existing servers
      //      that don't return the field fall back to the legacy logic
      //      below.
      //   2. **No AI credentials.** If the current user has zero usable AI
      //      engines (per-user Claude OR host-level Claude/Cursor/Codex), the
      //      wizard is shown unconditionally — they can't spawn an agent
      //      without picking one of the three. This catches the
      //      sandbox-reset case where orgs and a default user already exist
      //      but `auth.json`/host CLIs were wiped. Without it, init falls
      //      through to the project picker and the user has no obvious
      //      route to the credentials UI.
      //   3. **First run.** Brand-new install with no projects yet. We
      //      open the adaptive project wizard, since this is typically a
      //      returning user adding their first project. (The greenfield
      //      case is now handled by #1; this branch only fires after the
      //      Owner has been created.)
      try {
        const statusRes = await fetch(`${getApiBase()}/setup/status`, {
          headers: getAuthHeaders(),
          signal: AbortSignal.timeout(10000),
        });
        const status = await statusRes.json();
        setSetupStatus(status);
        if (status.authConfigured === false) {
          // Truly fresh install — Owner record does not exist. Always
          // walk the user through the full wizard (Hub account → welcome →
          // creds → github → first project) regardless of host CLI auth or
          // the auto-seeded default org.
          setSetupInitialStep(1);
          setShowSetup(true);
        } else if (status.hasAnyAiCredentials === false) {
          // If an org already exists, skip Welcome and land on AI credentials.
          // With no orgs (true greenfield) we still want the full wizard.
          setSetupInitialStep(
            getOrgs() ? stepIndexForKey(status, 'credentials') : stepIndexForKey(status, 'welcome'),
          );
          setShowSetup(true);
        } else if (status.firstRun) {
          if (!getOrgs()) {
            setSetupInitialStep(1);
            setShowSetup(true);
          } else {
            openAdaptiveProjectWizard();
          }
        }
      } catch {} // server may not have endpoint yet

      // Main chrome (chat + sidebar frame) can render; sidebar shows loading until
      // projects and sessions are ready.
      setInitializing(false);
      setProjectDataReady(false);

      // Step 3: Load projects (after org switch is confirmed)
      try {
        const data = await api.getProjects();
        setProjects(data);
        const flat = data.flatMap((p) =>
          p.agents.map((a) => ({
            ...a,
            projectId: p.id,
            projectName: p.name,
            cwd: p.cwd,
            ahw: p.ahw,
          })),
        );
        setAgents(flat);
        const storedId = localStorage.getItem('activeAgentId');
        const storedAgentExists = storedId && flat.some((a) => a.id === storedId);
        if (storedAgentExists) {
          setActiveAgentId(storedId);
        } else if (flat.length > 0) {
          setActiveAgentId(flat[0].id);
        }
      } catch (err) {
        console.error('[Init] Failed to load projects:', err);
      } finally {
        setProjectDataReady(true);
      }
    };

    init();
    // Mount-only: org + projects bootstrap. Intentionally not re-running on org helper identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load sessions when agent changes
  useEffect(() => {
    if (!projectDataReady) {
      return;
    }
    if (!activeAgentId) {
      setSessionsListLoading(false);
      return;
    }

    const agentId = activeAgentId;
    const targetSessionId = pendingSessionIdRef.current;
    pendingSessionIdRef.current = null;

    setSessionsListLoading(true);
    let cancelled = false;

    // Fetch archived (soft-deleted within 24h window) in parallel so the
    // sidebar "Archived" section is ready as soon as the live list renders.
    api
      .getArchivedSessions(agentId)
      .then((rows) => {
        if (cancelled) return;
        setArchivedSessions(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (cancelled) return;
        setArchivedSessions([]);
      });

    api
      .getSessions(agentId)
      .then((data) => {
        if (cancelled) return;
        setSessions(data);

        // Hydrate changesReady from persisted session data so the PR button
        // survives page refreshes and WebSocket reconnects.
        const persisted = {};
        for (const s of data) {
          if (s.changes_ready) {
            try {
              persisted[s.id] =
                typeof s.changes_ready === 'string' ? JSON.parse(s.changes_ready) : s.changes_ready;
            } catch {
              /* ignore malformed JSON */
            }
          }
        }
        if (Object.keys(persisted).length > 0) {
          setChangesReady((prev) => ({ ...prev, ...persisted }));
        }

        // If we were explicitly navigated to a specific session (e.g. from kanban
        // assign), honour that session ID. Otherwise try to restore the last
        // session the user had open for this agent (persisted in localStorage on
        // every `activeSessionId` change). Fall back to `data[0]` (newest by
        // `updated_at`) only when neither is available — this is what used to
        // surface as "Claude lost my session" after an Electron reload, because
        // `data[0]` could be an unrelated cron/heartbeat row.
        let remembered = null;
        try {
          const key = `activeSessionId:${agentId}`;
          const stored = localStorage.getItem(key);
          if (stored) remembered = data.find((s) => s.id === stored) || null;
        } catch {
          /* storage disabled — ignore */
        }
        const target = targetSessionId
          ? data.find((s) => s.id === targetSessionId) || remembered || data[0]
          : remembered || data[0];

        if (target) {
          setActiveSessionId(target.id);
          const ag = agents.find((a) => a.id === agentId);
          setSessionEngine(target.engine || ag?.engine || 'claude-code');
          setSessionModel(
            target.model ||
              modelConfig?.engineDefaultModels?.[target.engine || ag?.engine || 'claude-code'] ||
              'claude-opus-4-8',
          );
          setSessionAskMode(isSessionAskModeEnabled(target));
        } else {
          setActiveSessionId(null);
          setMessages([]);
          const fallbackEngine = agents.find((a) => a.id === agentId)?.engine || 'claude-code';
          setSessionEngine(fallbackEngine);
          setSessionModel(modelConfig?.engineDefaultModels?.[fallbackEngine] || 'claude-opus-4-8');
          setSessionAskMode(false);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[Sessions] Failed to load sessions:', err);
        setSessions([]);
      })
      .finally(() => {
        if (!cancelled) {
          setSessionsListLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- .then() uses `activeAgent` for defaults; agents[] churn should not re-fetch sessions
  }, [activeAgentId, modelConfig, projectDataReady]);

  // Load skills for slash-command autocomplete when agent changes
  useEffect(() => {
    if (!activeAgentId) {
      setSkills([]);
      return;
    }
    if (!projectDataReady) {
      setSkills([]);
      return;
    }
    api
      .getSkills(activeAgentId)
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [activeAgentId, projectDataReady]);

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
    setSessionAskMode(isSessionAskModeEnabled(session));
  }, [activeSessionId, sessions]);

  // If the server reports no models for the session's engine (e.g. Cursor auth
  // was revoked), migrate the session to the first authenticated engine so UI
  // state matches what we send on the wire (avoids TopBar showing Claude while
  // the session row is still cursor-agent).
  useEffect(() => {
    if (!modelConfig || !activeSessionId) return;
    const allowed = modelConfig.engineValidModels?.[sessionEngine];
    if (Array.isArray(allowed) && allowed.length > 0) return;

    const nextEngine = firstEngineWithAuthenticatedModels(modelConfig);
    if (!nextEngine || nextEngine === sessionEngine) return;
    const defaultModel = defaultModelForAuthenticatedEngine(modelConfig, nextEngine);
    if (!defaultModel) return;

    let cancelled = false;
    const sid = activeSessionIdRef.current;
    void (async () => {
      try {
        setSessionEngine(nextEngine);
        setSessionModel(defaultModel);
        const updatedEngine = await api.setSessionEngine(sid, nextEngine);
        if (cancelled || activeSessionIdRef.current !== sid) return;
        setSessions((prev) =>
          prev.map((s) => (s.id === updatedEngine.id ? { ...s, engine: updatedEngine.engine } : s)),
        );
        const modelUpdated = await api.setSessionModel(sid, defaultModel);
        if (cancelled || activeSessionIdRef.current !== sid) return;
        setSessions((prev) =>
          prev.map((s) => (s.id === modelUpdated.id ? { ...s, model: modelUpdated.model } : s)),
        );
      } catch (err) {
        console.warn('[modelConfig] Failed to migrate session off unauthenticated engine:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modelConfig, activeSessionId, sessionEngine, sessions]);

  // Load messages when session changes — clear immediately so the chat column
  // never briefly shows the previous session's transcript on the new id.
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      setSessionMessagesLoading(false);
      return;
    }
    setMessages([]);
    setSessionMessagesLoading(true);
    let cancelled = false;
    api
      .getMessages(activeSessionId)
      .then((rows) => {
        if (cancelled) return;
        setMessages(Array.isArray(rows) ? rows : []);
        setSessionMessagesLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setMessages([]);
        setSessionMessagesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  // Load any handoffs emitted from this session so HandoffCard can resolve
  // `toSessionId` and render a clickable "Open session" link. Best-effort —
  // missing endpoint / offline must never block the chat render.
  useEffect(() => {
    if (!activeSessionId) {
      setSessionHandoffs([]);
      return;
    }
    let cancelled = false;
    api
      .getSessionHandoffs(activeSessionId)
      .then((rows) => {
        if (cancelled) return;
        setSessionHandoffs(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setSessionHandoffs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  // Hydrate historical delegations on session load so message-anchored
  // `<delegate>` cards in saved assistant messages render their real
  // terminal status (done/error/cancelled) instead of the "Queued"
  // placeholder. Without this fetch, `delegations[sessionId]` is empty
  // until a fresh `delegation_start` WS event arrives — meaning a session
  // refresh after the round completed showed every delegate row as
  // "Queued" forever (Bug intake: "Delegations stay queued; user expects
  // immediate sub-agent kickoff"). Live WS events still win — the
  // `delegation_start` handler replaces the entry when a *new* round
  // begins. Best-effort: missing endpoint / offline must never block
  // the chat render.
  useEffect(() => {
    if (!activeSessionId) return undefined;
    let cancelled = false;
    const sessionId = activeSessionId;
    api
      .getSessionDelegations(sessionId)
      .then((rows) => {
        if (cancelled) return;
        const hydrated = mapDelegationRowsToLiveShape(rows);
        if (!hydrated) return;
        setDelegations((prev) => {
          // Don't clobber a live round that arrived between fetch start
          // and resolution — the WS-driven entry is always more
          // authoritative than the historical snapshot.
          if (prev[sessionId]) return prev;
          return { ...prev, [sessionId]: hydrated };
        });
      })
      .catch(() => {
        // Missing endpoint / offline / 500 — silent: the panel falls back
        // to the existing "Queued" placeholder, matching pre-fix behavior.
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  // Navigate into a handoff's target session (called from HandoffCard).
  const handleOpenHandoffSession = useCallback(
    (targetAgentId, targetSessionId) => {
      if (!targetAgentId || !targetSessionId) return;
      pendingSessionIdRef.current = targetSessionId;
      setActiveAgentId(targetAgentId);
      setActiveSessionId(targetSessionId);
      setCurrentView('chat');
    },
    [setActiveAgentId],
  );

  /** Switch to the agent that owns the session, then open chat (used by sidebar, toasts, dashboard). */
  const focusAgentSession = useCallback(
    (agentId, sessionId) => {
      if (!sessionId) return;
      const row =
        sessionsRef.current.find((x) => x.id === sessionId) ??
        sessionsByIdRef.current.get(sessionId);
      const resolvedAgentId = agentId || row?.agent_id;
      if (resolvedAgentId) {
        pendingSessionIdRef.current = sessionId;
        setActiveAgentId(resolvedAgentId);
        setActiveSessionId(sessionId);
      } else {
        setActiveSessionId(sessionId);
      }
      setCurrentView('chat');
      setSidebarOpen(false);
    },
    [setActiveAgentId],
  );
  focusAgentSessionRef.current = focusAgentSession;

  // Keep the active agent aligned with the open session's owner (cross-project switches).
  useLayoutEffect(() => {
    if (!activeSessionId) return;
    const row =
      sessions.find((s) => s.id === activeSessionId) ??
      sessionsByIdRef.current.get(activeSessionId);
    const ownerId = row?.agent_id;
    if (!ownerId || ownerId === activeAgentId) return;
    pendingSessionIdRef.current = activeSessionId;
    setActiveAgentId(ownerId);
  }, [activeSessionId, sessions, activeAgentId, setActiveAgentId, sessionsIndexTick]);

  // Rehydrate the in-Hub ProgressPanel for the active session whenever the
  // session changes. Skip if we already have live steps in memory (avoid
  // clobbering in-flight state on a quick tab-toggle).
  useEffect(() => {
    if (!activeSessionId) return;
    if ((sessionProgress[activeSessionId] || []).length > 0) return;
    let cancelled = false;
    api
      .getSessionProgress(activeSessionId)
      .then((res) => {
        if (cancelled || !res || !Array.isArray(res.steps)) return;
        if (res.steps.length === 0) return;
        setSessionProgress((prev) => ({ ...prev, [activeSessionId]: res.steps }));
      })
      .catch(() => {
        /* best-effort — missing endpoint / offline should not break chat */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only on session change; `activeTasks` updates stream case-by-case
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
  }, [showSwitcher, thinking, streamingContent, handleCancel]);

  // Load session agents when active session changes.
  useEffect(() => {
    if (!activeSessionId) {
      setSessionAgents([]);
      setSessionRoundProcessing(false);
      return;
    }
    let cancelled = false;
    api
      .getSessionDetail(activeSessionId)
      .then((detail) => {
        if (cancelled) return;
        setSessionAgents(detail.agents || []);
      })
      .catch(() => {
        if (!cancelled) setSessionAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  // ─── Cron sessions (scheduled tasks) ───────────────────
  const refreshCronSessions = useCallback(() => {
    api
      .getCronSessions()
      .then(setCronSessions)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshCronSessions();
  }, [refreshCronSessions]);

  const handleSessionAgentsUpdated = useCallback((detail) => {
    if (!detail?.id) return;
    setSessionAgents(detail.agents || []);
    setSessions((prev) => prev.map((s) => (s.id === detail.id ? { ...s, ...detail } : s)));
  }, []);

  // ─── Designs data loading ───────────────────────────────────
  const refreshDesigns = useCallback(() => {
    api.getDesigns().then(setDesigns).catch(console.error);
  }, []);

  useEffect(() => {
    refreshDesigns();
  }, [refreshDesigns]);

  // Stable preview-pane callbacks. Defined here (not inline in JSX) so that
  // SessionPreviewPane's useMemo([..., onTouch]) never rebuilds the 30s
  // activity-touch throttle on every WS-driven App re-render.
  const handlePreviewClose = useCallback(() => {
    setPreviewPaneOpenBySession((prev) => ({
      ...prev,
      [activeSessionId]: false,
    }));
    try {
      const key = paneOpenStorageKey(activeSessionId);
      if (key) window.localStorage.setItem(key, 'false');
    } catch {
      /* storage unavailable */
    }
  }, [activeSessionId, setPreviewPaneOpenBySession]);

  const handlePreviewTouch = useCallback(async ({ previewId }) => {
    if (!previewId) return;
    // Best-effort runtime touch — silently tolerate 404 / network errors
    // until the runtime HTTP surface lands. Throttled to 30 s by the pane.
    try {
      await fetch(`${getApiBase()}/preview/touch/${encodeURIComponent(previewId)}`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
    } catch {
      /* ignore */
    }
  }, []); // getApiBase / getAuthHeaders are module-level functions, no reactive deps.

  const clearSessionPreviewUi = useCallback((sessionId) => {
    if (!sessionId) return;
    clearSessionPreviewStorage(sessionId);
    setPreviewEventBySession((prev) => {
      if (!prev[sessionId]) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setPreviewPaneOpenBySession((prev) => {
      if (!prev[sessionId]) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setPreviewStartingBySession((prev) => {
      if (!prev[sessionId]) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  const stopSessionPreviewRuntime = useCallback(async (sessionId) => {
    if (!sessionId) return;
    try {
      await fetch(`${getApiBase()}/api/sessions/${encodeURIComponent(sessionId)}/preview/stop`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
    } catch {
      /* ignore */
    }
  }, []);

  const handlePreviewStop = useCallback(
    async ({ sessionId }) => {
      if (!sessionId) return;
      previewUserStoppedBySessionRef.current[sessionId] = true;
      await stopSessionPreviewRuntime(sessionId);
      clearSessionPreviewUi(sessionId);
    },
    [stopSessionPreviewRuntime, clearSessionPreviewUi],
  );

  const tearDownSessionPreview = useCallback(
    (sessionId) => {
      if (!sessionId) return;
      previewUserStoppedBySessionRef.current[sessionId] = true;
      void stopSessionPreviewRuntime(sessionId);
      clearSessionPreviewUi(sessionId);
    },
    [stopSessionPreviewRuntime, clearSessionPreviewUi],
  );

  tearDownSessionPreviewRef.current = tearDownSessionPreview;

  const handlePreviewConfigure = useCallback(() => {
    setCurrentView('settings:preview');
  }, [setCurrentView]);

  const handleStartSessionPreview = useCallback(
    async (sessionId) => {
      if (!sessionId) return;
      setPreviewStartingBySession((prev) => ({ ...prev, [sessionId]: true }));
      setPreviewPaneOpenBySession((prev) => ({ ...prev, [sessionId]: true }));
      try {
        const key = paneOpenStorageKey(sessionId);
        if (key) window.localStorage.setItem(key, 'true');
      } catch {
        /* storage unavailable */
      }
      try {
        await api.startSessionPreview(sessionId);
        // Keep `previewStartingBySession` until a WS `agenthub_preview` event
        // arrives — boot can take minutes (clone + compose build).
      } catch (err) {
        setPreviewStartingBySession((prev) => {
          const next = { ...prev };
          delete next[sessionId];
          return next;
        });
        showToast(err?.message || 'Failed to start preview', 'error', 8000);
      }
    },
    [showToast],
  );

  const activeChatProject = useMemo(() => {
    const row =
      sessions.find((s) => s.id === activeSessionId) ??
      (activeSessionId ? sessionsByIdRef.current.get(activeSessionId) : null);
    const agentId = row?.agent_id ?? activeAgentId;
    const agent = agents.find((a) => a.id === agentId);
    return projects.find((p) => p.id === agent?.projectId) ?? null;
  }, [sessions, activeSessionId, activeAgentId, agents, projects, sessionsIndexTick]);

  const chatGithubRepo = activeChatProject?.githubRepo ?? null;
  const chatProjectIsWorkflow = activeChatProject?.mode === 'workflow';

  const activePreviewEvent =
    (activeSessionId && previewEventBySession[activeSessionId]) ||
    (activeSessionId && previewStartingBySession[activeSessionId]
      ? {
          type: 'agenthub_preview',
          kind: 'preview_starting',
          sessionId: activeSessionId,
          previewId: '',
          target: 'client',
          route: '/',
          agentReason: 'Starting preview…',
          logTail: [],
        }
      : null);

  // The pane is hidden by default and only appears once a preview is
  // actually building (`preview_starting`) or available (`preview` /
  // `preview_failed` / `preview_unavailable`). A bare session in a
  // preview-capable project no longer pops the pane open with an empty
  // "no app loaded here" placeholder — the user opens it via the
  // Start preview button below the chat, which seeds a synthetic
  // `preview_starting` event into `activePreviewEvent`.
  const showSessionPreviewPane = shouldShowSessionPreviewPane({
    activeSessionId,
    project: activeChatProject,
    activePreviewEvent,
    paneOpenBySession: previewPaneOpenBySession,
  });

  // Load full design detail + messages when the active design changes.
  useEffect(() => {
    if (!activeDesignId) {
      setDesignMessages([]);
      setDesignStreaming(null);
      setDesignThinking(false);
      setDesignProcessing(false);
      return;
    }
    // Reset streaming UI state optimistically — the status probe below will
    // restore it if a turn is actually in flight for this design.
    setDesignStreaming(null);
    setDesignThinking(false);
    setDesignProcessing(false);
    // Reset the iframe cache-buster for a fresh design — ensures we don't
    // reuse a stale frame from the previous design.
    setDesignReloadToken((t) => t + 1);
    const designId = activeDesignId;
    api
      .getDesign(designId)
      .then((detail) => {
        if (!detail) return;
        setDesigns((prev) => {
          const existing = prev.find((d) => d.id === detail.id);
          return existing ? prev.map((d) => (d.id === detail.id ? { ...d, ...detail } : d)) : prev;
        });
      })
      .catch(console.error);
    api.getDesignMessages(designId).then(setDesignMessages).catch(console.error);
    // Probe the server for an in-flight turn. If one is running, restore the
    // thinking/streaming indicators so re-entering a design mid-turn doesn't
    // show a silent UI. Guard against races: if the user switched designs
    // again before the probe resolved, drop the result.
    api
      .getDesignStatus(designId)
      .then((status) => {
        if (!status || activeDesignIdRef.current !== designId) return;
        if (!status.inFlight) return;
        setDesignProcessing(true);
        if (status.streaming) {
          setDesignThinking(false);
          setDesignStreaming({ content: status.streaming });
        } else {
          setDesignThinking(true);
        }
      })
      .catch(console.error);
  }, [activeDesignId]);

  const activeDesign = designs.find((d) => d.id === activeDesignId);

  const handleNewSession = async () => {
    if (!activeAgentId) return;
    // Reviewer agents are spawned exclusively by the GitHub PR webhook.
    // The server rejects manual session creation with role=reviewer; we
    // short-circuit here so the keyboard shortcut / swipe handler /
    // other indirect call sites don't produce a noisy 403.
    if (activeAgent?.role === 'reviewer') {
      showToast(
        'Reviewer agents only run from the GitHub PR webhook — sessions cannot be started manually.',
        'info',
        4000,
      );
      return;
    }
    const session = await api.createSession(activeAgentId, undefined, { askMode: sessionAskMode });
    setSessions((prev) => prependSessionDeduped(prev, session));
    setActiveSessionId(session.id);
    setSessionEngine(session.engine || activeAgent?.engine || 'claude-code');
    setSessionModel(
      session.model ||
        modelConfig?.engineDefaultModels?.[
          session.engine || activeAgent?.engine || 'claude-code'
        ] ||
        'claude-opus-4-8',
    );
    setSessionAskMode(isSessionAskModeEnabled(session));
    setMessages([]);
    setCurrentView('chat');
  };

  const defaultModelForEngine = useCallback(
    (engine) => {
      const fromConfig = modelConfig?.engineDefaultModels?.[engine];
      if (fromConfig) return fromConfig;
      if (engine === 'cursor-agent') return 'composer-2.5';
      if (engine === 'codex-cli') return 'gpt-5.3-codex';
      return 'claude-opus-4-8';
    },
    [modelConfig],
  );

  const handleEngineChange = async (engine) => {
    setSessionEngine(engine);
    const defaultModel = defaultModelForEngine(engine);
    setSessionModel(defaultModel);
    if (activeSessionId) {
      const updated = await api.setSessionEngine(activeSessionId, engine);
      setSessions((prev) =>
        prev.map((s) => (s.id === updated.id ? { ...s, engine: updated.engine } : s)),
      );
      const modelUpdated = await api.setSessionModel(activeSessionId, defaultModel);
      setSessions((prev) =>
        prev.map((s) => (s.id === modelUpdated.id ? { ...s, model: modelUpdated.model } : s)),
      );
    }
  };

  const handleModelChange = async (model) => {
    setSessionModel(model);
    if (activeSessionId) {
      const updated = await api.setSessionModel(activeSessionId, model);
      setSessions((prev) =>
        prev.map((s) => (s.id === updated.id ? { ...s, model: updated.model } : s)),
      );
    }
  };

  const handleAskModeChange = async (enabled) => {
    setSessionAskMode(enabled);
    if (activeSessionId) {
      const updated = await api.setSessionAskMode(activeSessionId, enabled);
      setSessions((prev) =>
        prev.map((s) => (s.id === updated.id ? { ...s, ask_mode: updated.ask_mode } : s)),
      );
    }
  };

  const handleDeleteSession = async (sessionId) => {
    setDeletingSessionIds((prev) => new Set(prev).add(sessionId));
    tearDownSessionPreview(sessionId);
    // Capture the row before the filter so we can optimistically add it to
    // the Archived list — avoids a round-trip to refresh the archived view
    // after every delete. The server's `session_restored` / subsequent page
    // refresh will reconcile if anything drifts.
    const deletedRow = sessions.find((s) => s.id === sessionId) || null;
    try {
      await api.deleteSession(sessionId);
      setBrowserScreensBySession((prev) => {
        if (!prev[sessionId]) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (deletedRow) {
        setArchivedSessions((prev) => {
          if (prev.some((s) => s.id === sessionId)) return prev;
          return [
            {
              ...deletedRow,
              // Client clock — may drift from server's UTC datetime('now')
              // used by the purge cron. The next fetch reconciles; sub-day
              // "purges in Nh" labels can briefly disagree.
              deleted_at: new Date().toISOString(),
              // Carry the live message_count through so the Archived row
              // doesn't briefly flash "0" before the next fetch reconciles.
              message_count: deletedRow.message_count ?? 0,
            },
            ...prev,
          ];
        });
      }
      if (activeSessionId === sessionId) {
        const remaining = sessions.filter((s) => s.id !== sessionId);
        setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
      }
      // No success toast — the row appears in the sidebar's Archived
      // section with its own "purges in Nh" countdown, which already
      // tells the user what happened and when it'll be gone.
    } catch (err) {
      showToast(`Archive failed: ${err?.message || 'unknown error'}`, 'error', 6000);
    } finally {
      setDeletingSessionIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  };

  const handleRestoreSession = async (sessionId) => {
    setRestoringSessionIds((prev) => new Set(prev).add(sessionId));
    try {
      const restored = await api.restoreSession(sessionId);
      // Remove from archived list; the WS `session_restored` event is the
      // canonical path for re-inserting into `sessions`, but we apply the
      // same mutation here to cover initiator-only tabs with slow WS.
      setArchivedSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (restored && restored.id) {
        setSessions((prev) => {
          if (prev.some((s) => s.id === restored.id)) return prev;
          return [restored, ...prev];
        });
      }
      showToast('Session restored', 'success', 3000);
    } catch (err) {
      showToast(`Restore failed: ${err?.message || 'unknown error'}`, 'error', 6000);
    } finally {
      setRestoringSessionIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  };

  const handleClearAllSessions = async () => {
    if (!activeAgentId) return;
    setDeletingBulk('all');
    for (const s of sessions) tearDownSessionPreview(s.id);
    try {
      const result = await api.clearAllSessions(activeAgentId);
      if (result.ok) {
        setBrowserScreensBySession({});
        setSessions([]);
        setActiveSessionId(null);
      }
    } finally {
      setDeletingBulk(null);
    }
  };

  const handleClearInactiveSessions = async () => {
    if (!activeAgentId) return;
    setDeletingBulk('inactive');
    const activeIds = new Set(Object.keys(activeTasks));
    for (const s of sessions) {
      if (!activeIds.has(s.id)) tearDownSessionPreview(s.id);
    }
    try {
      const result = await api.clearInactiveSessions(activeAgentId);
      if (result.ok) {
        // Keep only sessions that had active tasks (server skipped them)
        setSessions((prev) => prev.filter((s) => activeIds.has(s.id)));
        if (activeSessionId && !activeIds.has(activeSessionId)) {
          const remaining = sessions.filter((s) => activeIds.has(s.id));
          setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
        }
      }
    } finally {
      setDeletingBulk(null);
    }
  };

  const handleRenameSession = async (sessionId, newName) => {
    await api.renameSession(sessionId, newName);
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, name: newName } : s)));
  };

  const handleDequeue = (messageId, { cancelStream = false } = {}) => {
    if (activeSessionId) {
      send({ type: 'dequeue', sessionId: activeSessionId, messageId });
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
      if (cancelStream && (thinking || streamingContent)) {
        handleCancel();
      }
    }
  };

  const handleEditInComposer = useCallback((messageId, content) => {
    setComposerPrefill({ messageId, content });
  }, []);

  const handleEditQueuedMessage = (messageId, content) => {
    if (activeSessionId) {
      send({ type: 'edit_queue_item', sessionId: activeSessionId, messageId, content });
      // Optimistically update local message content
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, content } : m)));
    }
  };

  // Handle submission from an <AskUserQuestion> picker. We dispatch the
  // pre-formatted chat message (which already contains the agenthub:ask:answer
  // fenced block) and mark the askId as submitted so the picker flips to a
  // disabled "Submitted" state immediately. Once the user message persists to
  // history, `askSubmittedFromHistory` below picks the id up from the
  // fenced-block scan and the optimistic set becomes redundant — but the
  // union in `askSubmitted` makes the brief overlap seamless.
  const handleAskSubmit = (askId, messageText) => {
    if (askSubmitted.has(askId)) return;
    setAskSubmittedOptimistic((prev) => {
      const next = new Set(prev);
      next.add(askId);
      return next;
    });
    // Optimistically drop the "waiting for your input" indicator the instant
    // the picker is submitted. Without this clear, the sidebar would keep
    // showing the prominent dot during the gap between message-send and the
    // server's `thinking`/`active-tasks-snapshot` arrival, defeating the
    // whole point of the indicator. The server's post-`done`
    // `awaiting_input { waiting: false }` will reconfirm — and if this same
    // session emits a fresh ask in its next turn, the server's
    // `awaiting_input { waiting: true }` will re-light the dot. Multi-round
    // ask flows are covered by this round-trip.
    setAwaitingInputBySession((prev) =>
      clearAwaitingInputForSession(prev, activeSessionIdRef.current),
    );
    handleSend(messageText);
  };

  const handleSend = async (content, images = [], { interrupt = false } = {}) => {
    let sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      const coalesceKey = `${activeAgentId}:${sessionAskMode ? 'ask' : 'run'}`;
      const session = await coalescePromiseByKey(implicitSessionCreateByKeyRef, coalesceKey, () =>
        api.createSession(activeAgentId, undefined, { askMode: sessionAskMode }).then((s) => {
          setSessions((prev) => prependSessionDeduped(prev, s));
          setActiveSessionId(s.id);
          activeSessionIdRef.current = s.id;
          return s;
        }),
      );
      sessionId = session.id;
    }

    // Upload media (images + videos) first, then send chat with references.
    //
    // If any upload fails (e.g. a video over the 100 MB server limit, or a
    // transient network error), surface the reason to the user via toast and
    // abort the send — previously we swallowed the error and sent the text
    // alone, which is exactly how users reported "videos don't go through in
    // chat" (the text arrives, the video doesn't, the user has no idea why).
    let uploadedImages = [];
    if (images.length > 0) {
      try {
        uploadedImages = await Promise.all(
          images.map((img) => {
            if (isPersistedUploadAttachment(img)) return img;
            if ((img.type === 'video' || img.type === 'file') && img.file) {
              return api.uploadFile(img.file);
            }
            return api.uploadImage(img.dataUrl, img.name);
          }),
        );
      } catch (err) {
        console.error('Media upload failed:', err);
        const reason = err?.message || 'Unknown error';
        showToast(
          `Attachment upload failed: ${reason}. Your message was not sent — please retry or remove the attachment.`,
          'error',
          8000,
        );
        return;
      }
    }

    send({
      type: 'chat',
      agentId: activeAgentId,
      sessionId,
      content,
      ...(uploadedImages.length > 0 ? { images: uploadedImages } : {}),
      ...(interrupt ? { interrupt: true } : {}),
    });
  };

  /** Send a queued user message now and interrupt the in-flight assistant turn. */
  const handleInterruptQueuedMessage = useCallback(
    (message) => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId || !message?.id) return;
      const { chat } = buildInterruptQueuedMessageDispatch({
        message,
        agentId: activeAgentId,
        sessionId,
      });
      send(chat);
    },
    [send, activeAgentId],
  );

  const isProcessing = thinking || !!streamingContent || sessionRoundProcessing;
  const activeSession = useMemo(
    () =>
      sessions.find((s) => s.id === activeSessionId) ||
      (activeSessionId ? sessionsByIdRef.current.get(activeSessionId) : null) ||
      null,
    [sessions, activeSessionId, sessionsIndexTick],
  );

  const sessionOwnerAgentId = activeSession?.agent_id ?? activeAgentId;
  const chatAgent = useMemo(
    () => agents.find((a) => a.id === sessionOwnerAgentId) ?? activeAgent ?? null,
    [agents, sessionOwnerAgentId, activeAgent],
  );

  const chatAccentColor = useMemo(
    () =>
      resolveChatAccentColor({
        sessionId: activeSessionId,
        sessionRow: activeSession,
        sessionsById: sessionsByIdRef.current,
        agents,
        projects,
        fallbackAgentId: activeAgentId,
      }),
    [activeSessionId, activeSession, agents, projects, activeAgentId, sessionsIndexTick],
  );

  const activeSessionWorktreeReady =
    !activeSession ||
    !isSessionWorktreeEnabled(activeSession) ||
    isSessionWorkspaceReady(activeSession);

  // Provision the git worktree as soon as a session is opened so Start preview
  // mounts the same checkout the agent will edit (not project.cwd).
  useEffect(() => {
    const sid = activeSessionId;
    if (!sid || !connected || activeSessionWorktreeReady) return;
    if (workspaceEnsureAttemptedRef.current.has(sid)) return;
    if (workspaceEnsureInFlightRef.current.has(sid)) return;
    workspaceEnsureInFlightRef.current.add(sid);
    workspaceEnsureAttemptedRef.current.add(sid);
    setWorkspaceEnsuringBySession((prev) => ({ ...prev, [sid]: true }));
    void api
      .ensureSessionWorkspace(sid)
      .then((body) => {
        if (body?.session) {
          setSessions((prev) => prev.map((s) => (s.id === sid ? body.session : s)));
        }
      })
      .catch((err) => {
        showToast(err?.message || 'Failed to prepare session workspace', 'error', 8000);
      })
      .finally(() => {
        workspaceEnsureInFlightRef.current.delete(sid);
        setWorkspaceEnsuringBySession((prev) => {
          if (!prev[sid]) return prev;
          const next = { ...prev };
          delete next[sid];
          return next;
        });
      });
  }, [activeSessionId, connected, activeSessionWorktreeReady, showToast]);
  const activeResolvePrBannerInfo = useMemo(() => {
    if (!activeSession?.name || !isResolvePrSessionTitle(activeSession.name)) return null;
    return {
      prUrl: inferPrUrlFromSessionTitle(activeSession.name, chatGithubRepo),
      prNumber: parseResolvePrNumberFromTitle(activeSession.name),
    };
  }, [activeSession, chatGithubRepo]);
  const orchestrationTimelineEntries = useMemo(() => {
    if (!activeSessionId) return [];
    const out = [];
    if (activeSession?.orchestration_phase) {
      out.push({
        id: `phase:${activeSession.id}:${activeSession.orchestration_phase}`,
        ts: Date.parse(activeSession.updated_at || '') || Date.now(),
        kind: 'phase',
        summary: `Session phase is "${activeSession.orchestration_phase}".`,
      });
    }
    for (const step of sessionProgress[activeSessionId] || []) {
      out.push({
        id: `progress:${activeSessionId}:${step.step}:${step.startedAt}:${step.status}`,
        ts: Date.parse(step.finishedAt || step.startedAt || '') || Date.now(),
        kind: 'progress',
        summary: `${step.step} -> ${step.status}`,
      });
    }
    for (const step of reactLoopStepsBySession[activeSessionId] || []) {
      const outcome = Number(step.exitCode) === 0 ? 'ok' : `exit ${step.exitCode}`;
      out.push({
        id: `react:${activeSessionId}:${step.stepId}`,
        ts: step.receivedAt,
        kind: 'react',
        summary: `${step.phase}/${step.tool} -> ${outcome}${step.detail ? ` (${step.detail})` : ''}`,
      });
    }
    for (const row of delegations[activeSessionId]?.tasks || []) {
      out.push({
        id: `delegation:${activeSessionId}:${row.agentId}:${row.status}`,
        ts: row.startedAt,
        kind: 'delegate',
        summary: `${row.agentName || row.agentId} -> ${row.status}`,
      });
    }
    if (doneVerifyLogBySession[activeSessionId]) {
      out.push({
        id: `verify:${activeSessionId}`,
        ts: doneVerifyLogBySession[activeSessionId].receivedAt,
        kind: 'verify',
        summary: 'Pre-done verification log captured for this turn.',
      });
    }
    out.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
    return out.slice(-40);
  }, [
    activeSessionId,
    activeSession,
    sessionProgress,
    reactLoopStepsBySession,
    delegations,
    doneVerifyLogBySession,
  ]);

  // ─── Global keyboard shortcut actions ───────────────────────
  // Resolve the "current project" for navigation shortcuts: prefer the
  // project currently displayed (kanban/wiki/etc.) and fall back to the
  // project owning the active agent, then the first project.
  const currentProjectId = useMemo(() => {
    if (currentView.startsWith('kanban:')) return currentView.split(':')[1];
    if (currentView.startsWith('workflows:')) return currentView.slice('workflows:'.length);
    if (workflowEditRoute) return workflowEditRoute.projectId;
    if (currentView === 'wiki' && wikiProjectId) return wikiProjectId;
    if (currentView === 'notes' && notesProjectId) return notesProjectId;
    if (currentView === 'pulls' && pullsProjectId) return pullsProjectId;
    if (currentView === 'threads' && threadsProjectId) return threadsProjectId;
    const byAgent = projects.find((p) => p.agents?.some((a) => a.id === activeAgentId));
    return byAgent?.id || projects[0]?.id || null;
  }, [
    currentView,
    workflowEditRoute,
    wikiProjectId,
    notesProjectId,
    pullsProjectId,
    threadsProjectId,
    projects,
    activeAgentId,
  ]);

  // Build the handler map inline — useKeyboardShortcuts reads the latest map
  // via a ref, so rebuilding on every render is cheap and avoids stale closures.
  const goToNextProject = () => {
    if (!projects.length) return;
    const idx = Math.max(
      projects.findIndex((p) => p.id === currentProjectId),
      0,
    );
    const next = projects[(idx + 1) % projects.length];
    if (!next) return;
    const firstAgent = next.agents?.[0];
    if (firstAgent) setActiveAgentId(firstAgent.id);
    setCurrentView(`kanban:${next.id}`);
  };
  const goToBoard = () => {
    if (currentProjectId) setCurrentView(`kanban:${currentProjectId}`);
  };
  const goToWiki = () => {
    if (!currentProjectId) return;
    setWikiProjectId(currentProjectId);
    setCurrentView('wiki');
  };
  const goToNotes = () => {
    if (!currentProjectId) return;
    setNotesProjectId(currentProjectId);
    setCurrentView('notes');
  };
  const goToPulls = () => {
    if (!currentProjectId) return;
    setPullsProjectId(currentProjectId);
    setCurrentView('pulls');
  };

  const handleOpenPrDetail = useCallback((projectId, prNumber) => {
    const n = Number.parseInt(String(prNumber), 10);
    if (!projectId || !Number.isFinite(n) || n < 1) return;
    setPullsProjectId(projectId);
    setPullsOpenPrNumber(n);
    setCurrentView('pulls');
    setSidebarOpen(false);
  }, []);

  useEffect(() => {
    if (currentView !== 'pulls') setPullsOpenPrNumber(null);
  }, [currentView]);

  const isElectron = typeof window !== 'undefined' && !!window.electronAPI?.isElectron;
  const keyboardShortcutList = useMemo(() => getDefaultShortcuts(isElectron), [isElectron]);

  useKeyboardShortcuts({
    handlers: {
      'new-session': () => handleNewSession(),
      'new-ticket-chat': () => {
        // MVP: open the board for the current project + start a fresh session.
        // Future: prefill the session with a link to the selected ticket.
        handleNewSession();
        if (currentProjectId) setCurrentView(`kanban:${currentProjectId}`);
      },
      'new-doc-chat': () => {
        handleNewSession();
        goToWiki();
      },
      'go-to-board': goToBoard,
      'go-to-wiki': goToWiki,
      'go-to-notes': goToNotes,
      'go-to-pulls': goToPulls,
      'go-to-skills': () => setCurrentView('skills'),
      'go-to-settings': () => setCurrentView('settings'),
      'go-to-next-project': goToNextProject,
      'show-help': () => setShowShortcutsHelp(true),
    },
    shortcuts: keyboardShortcutList,
    enabled: !showShortcutsHelp,
  });

  const isMac = window.electronAPI?.platform === 'darwin';

  const sidebarDataLoading = !projectDataReady || sessionsListLoading;

  // Version-check for the "update available" modal + Electron sidebar footer.
  // Local bundled mode compares against Settings → publicUrl (main-process fetch)
  // so the prompt is not stuck on the embedded server's version.
  const [electronDesktopHealth, setElectronDesktopHealth] = useState(null);
  useEffect(() => {
    if (!isElectron) return;
    let cancelled = false;
    fetchDesktopUpdateHealth().then((h) => {
      if (!cancelled && h) setElectronDesktopHealth(h);
    });
    return () => {
      cancelled = true;
    };
  }, [isElectron]);
  const versionCheck = useVersionCheck({
    serverVersion: electronDesktopHealth?.version ?? null,
  });

  // Show loading spinner while connecting to the server and loading org data.
  // Includes an org switcher so users can escape a dead remote org.
  if (initializing) {
    const activeOrg = getActiveOrg();
    const allOrgState = getOrgs();
    const allOrgsList = allOrgState?.orgs || [];
    return (
      <div className="flex flex-col h-screen bg-gray-950 text-gray-100 items-center justify-center gap-4">
        <Loader2 size={32} className="animate-spin text-indigo-400" />
        <div className="text-center">
          <p className="text-sm text-gray-400">Connecting to server...</p>
          {activeOrg && (
            <p className="text-xs text-gray-600 mt-1">
              {activeOrg.name}
              {activeOrg.mode === 'remote' ? ' (remote)' : ''}
            </p>
          )}
        </div>
        {allOrgsList.length > 1 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {allOrgsList
              .filter((o) => o.id !== activeOrg?.id)
              .map((org) => (
                <button
                  key={org.id}
                  onClick={async () => {
                    await switchOrg(org.id);
                    reloadForOrgSwitch();
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-400 bg-gray-800/50 hover:bg-gray-800 rounded-lg border border-gray-700/50 transition-colors"
                >
                  <ArrowLeftRight size={12} />
                  {org.name}
                </button>
              ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100">
      {/* "Update available" modal — rendered at the top level so it floats
          above the sidebar and main content. Only shows when the Electron
          client is older than the server it's connected to. */}
      {versionCheck.updateAvailable && (
        <UpdateAvailableModal
          serverVersion={versionCheck.serverVersion}
          clientVersion={versionCheck.clientVersion}
          downloadUrl={versionCheck.downloadUrl}
          onDismiss={versionCheck.dismiss}
        />
      )}

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
            isLoading={sidebarDataLoading}
            projects={projects}
            agents={agents}
            activeAgentId={activeAgentId}
            onSelectAgent={(id) => {
              pendingSessionIdRef.current = null;
              setActiveSessionId(null);
              setActiveAgentId(id);
              setSidebarOpen(false);
            }}
            onFocusSession={focusAgentSession}
            onOrchestrationSave={async (body) => {
              if (!activeSessionId) return null;
              const row = await api.setSessionOrchestration(activeSessionId, body);
              setSessions((prev) =>
                prev.map((s) => (s.id === activeSessionId ? { ...s, ...row } : s)),
              );
              return row;
            }}
            showToast={showToast}
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelectSession={(id) => focusAgentSession(undefined, id)}
            onNewSession={handleNewSession}
            onDeleteSession={handleDeleteSession}
            onClearAllSessions={handleClearAllSessions}
            onClearInactiveSessions={handleClearInactiveSessions}
            archivedSessions={archivedSessions}
            onRestoreSession={handleRestoreSession}
            restoringSessionIds={restoringSessionIds}
            deletingSessionIds={deletingSessionIds}
            deletingBulk={deletingBulk}
            onRenameSession={handleRenameSession}
            onNavigate={(view, extra) => {
              setCurrentView(view);
              if (view === 'wiki' && extra) setWikiProjectId(extra);
              if (view === 'notes' && extra) setNotesProjectId(extra);
              if (view === 'pulls' && extra) setPullsProjectId(extra);
              if (view === 'design' && extra) setActiveDesignId(extra);
              if (view === 'designs') {
                // Opening the list view shouldn't clobber the last-opened design
                // context, but we do clear any in-progress transient state.
                setDesignStreaming(null);
                setDesignThinking(false);
              }
              if (view === 'threads' && extra) {
                setThreadsProjectId(extra);
                setActiveThreadId(null);
                setActiveThread(null);
                // Clear unread count when opening threads view
                setUnreadThreadCounts((prev) => {
                  if (!prev[extra]) return prev;
                  const next = { ...prev };
                  delete next[extra];
                  return next;
                });
              }
              setSidebarOpen(false);
            }}
            currentView={currentView}
            activeTaskSessionIds={activeTasks}
            awaitingInputBySession={awaitingInputBySession}
            subagentsBySession={subagents}
            changesReadyBySession={changesReady}
            onOpenProject={openAdaptiveProjectWizard}
            onImportProject={openImportProjectWizard}
            onReorderProjects={handleReorderProjects}
            cronSessions={cronSessions}
            wikiProjectId={wikiProjectId}
            notesProjectId={notesProjectId}
            threadsProjectId={threadsProjectId}
            pullsProjectId={pullsProjectId}
            workflowBadgeByProject={workflowSidebarBadgeByProject}
            unreadThreadCounts={unreadThreadCounts}
            activeReviews={activeReviews}
            designs={designs}
            activeDesignId={activeDesignId}
            onSelectDesign={(id) => {
              setActiveDesignId(id);
              setActiveSessionId(null);
              setSidebarOpen(false);
            }}
            electronSuppressHealthFetch={isElectron}
            electronHealthSnapshot={electronDesktopHealth}
          />
        </div>

        <div className="flex-1 flex flex-col min-w-0">
          {/* Top bar */}
          {!isWizardView(currentView) && (
            <>
              <TopBar
                agent={chatAgent}
                accentColor={chatAccentColor}
                connected={connected}
                reconnecting={reconnecting}
                onNewSession={handleNewSession}
                onNavigate={setCurrentView}
                onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
                sessionEngine={sessionEngine}
                onEngineChange={handleEngineChange}
                sessionModel={sessionModel}
                onModelChange={handleModelChange}
                modelConfig={modelConfig}
                messages={messages}
                activeSessionId={activeSessionId}
                sessionAskMode={sessionAskMode}
                onAskModeChange={handleAskModeChange}
                projectId={
                  currentView.startsWith('kanban:')
                    ? currentView.split(':')[1]
                    : currentView.startsWith('workflows:')
                      ? currentView.slice('workflows:'.length)
                      : workflowEditRoute?.projectId ||
                        projects.find((p) => p.agents?.some((a) => a.id === activeAgentId))?.id
                }
                showToast={showToast}
                onOpenForward={() => setShowForward(true)}
                canForward={
                  !!activeSessionId && filterForwardTargets(agents, activeAgent).length > 0
                }
              />

              {currentView === 'chat' && activeSessionId && (
                <SessionSummarySidebar
                  sessionId={activeSessionId}
                  isLive={Boolean(streamingMsgId || activeTasks[activeSessionId])}
                  variant="top"
                  onOpenPrDetail={handleOpenPrDetail}
                />
              )}

              {currentView === 'chat' && activeSessionId && (
                <ChecksPanel
                  sessionId={activeSessionId}
                  onJumpToSession={(targetSessionId) => {
                    if (!targetSessionId) return;
                    // Cross-link to the originating session from a fix-
                    // dispatch run. No-op when it's the active session.
                    if (targetSessionId === activeSessionId) return;
                    pendingSessionIdRef.current = targetSessionId;
                    setActiveSessionId(targetSessionId);
                  }}
                />
              )}

              {currentView.startsWith('kanban:') ? (
                <KanbanBoard
                  projectId={currentView.split(':')[1]}
                  project={projects.find((p) => p.id === currentView.split(':')[1])}
                  agents={agents}
                  refreshKey={kanbanRefreshKey}
                  showToast={showToast}
                  onProjectsRefresh={() => {
                    // Re-pull the project list so derived flags like
                    // `webhookConfigured` flip after a successful
                    // auto-configure click in WebhookConfigBanner.
                    // Errors are swallowed — the banner already
                    // surfaced its own error UI on the API call itself.
                    api
                      .getProjects()
                      .then((data) => setProjects(data))
                      .catch(() => undefined);
                  }}
                  onNavigateToSession={(agentId, sessionId) => {
                    pendingSessionIdRef.current = sessionId;
                    setActiveAgentId(agentId);
                    setActiveSessionId(sessionId);
                    setCurrentView('chat');
                  }}
                />
              ) : workflowEditRoute ? (
                <ProjectWorkflowBuilder
                  projectId={workflowEditRoute.projectId}
                  workflowId={workflowEditRoute.workflowId}
                  project={projects.find((p) => p.id === workflowEditRoute.projectId)}
                  projects={projects}
                  agents={agents}
                  onNavigate={navigateFromProjectWorkflows}
                  showToast={showToast}
                />
              ) : currentView.startsWith('workflows:') ? (
                <ProjectWorkflowsPage
                  projectId={currentView.slice('workflows:'.length)}
                  project={projects.find((p) => p.id === currentView.slice('workflows:'.length))}
                  onNavigate={navigateFromProjectWorkflows}
                  onSelectAgent={setActiveAgentId}
                  showToast={showToast}
                />
              ) : currentView.startsWith('settings') ? (
                <SettingsPage
                  projects={projects}
                  agents={agents}
                  onAgentsChange={refreshAgents}
                  initialTab={currentView.includes(':') ? currentView.split(':')[1] : undefined}
                  initialGithubExpandedProjectId={settingsGithubExpandProjectId}
                  onNavigate={(view, extra) => {
                    setCurrentView(view);
                    if (view === 'threads' && extra) {
                      setThreadsProjectId(extra.projectId);
                      if (extra.threadId) {
                        setActiveThreadId(extra.threadId);
                        setActiveThread(extra.thread || null);
                      } else {
                        setActiveThreadId(null);
                        setActiveThread(null);
                      }
                    }
                    // Direct-jump into a chat session (e.g. from the
                    // Settings → Preview "AI Setup" wizard, which spawns
                    // a wizard session and needs the user to land on it
                    // immediately to see the streaming response).
                    if (view === 'chat' && extra) {
                      focusAgentSession(extra.agentId, extra.sessionId);
                    }
                  }}
                  onOpenSession={({ sessionId, agentId }) => focusAgentSession(agentId, sessionId)}
                  showToast={showToast}
                  wsRef={wsRef}
                />
              ) : currentView === 'wiki' && wikiProjectId ? (
                <WikiBrowser projectId={wikiProjectId} apiBase={getApiBase()} />
              ) : currentView === 'notes' && notesProjectId ? (
                <NotesEditor projectId={notesProjectId} />
              ) : currentView === 'threads' && threadsProjectId ? (
                activeThreadId ? (
                  <ThreadView
                    ref={threadViewRef}
                    key={activeThreadId}
                    threadId={activeThreadId}
                    thread={activeThread}
                    onBack={() => {
                      setActiveThreadId(null);
                      setActiveThread(null);
                    }}
                  />
                ) : (
                  <ThreadList
                    ref={threadListRef}
                    projectId={threadsProjectId}
                    onSelectThread={(thread) => {
                      setActiveThreadId(thread.id);
                      setActiveThread(thread);
                    }}
                  />
                )
              ) : currentView === 'pulls' && pullsProjectId ? (
                <PullRequestsPage
                  projectId={pullsProjectId}
                  project={projects.find((p) => p.id === pullsProjectId)}
                  listRefreshNonce={pullsListRefreshNonce}
                  initialPrNumber={pullsOpenPrNumber}
                  onOpenSession={handleOpenHandoffSession}
                  onToast={showToast}
                />
              ) : currentView === 'releases' ? (
                <ReleasesView />
              ) : currentView === 'dashboard' ? (
                <DashboardView
                  orgId={getActiveOrgApiId()}
                  onNewProject={openAdaptiveProjectWizard}
                  onOpenSession={(agentId, sessionId) => focusAgentSession(agentId, sessionId)}
                  onOpenKanban={(projectId) => {
                    setCurrentView(`kanban:${projectId}`);
                    setSidebarOpen(false);
                  }}
                  onOpenPulls={(projectId) => {
                    setPullsProjectId(projectId);
                    setCurrentView('pulls');
                    setSidebarOpen(false);
                  }}
                  onOpenExternalUrl={(url) => {
                    window.open(url, '_blank', 'noopener,noreferrer');
                  }}
                />
              ) : currentView === 'skills' || currentView.startsWith('skills:') ? (
                <SkillsPage
                  agents={agents}
                  projects={projects}
                  initialSkillsTab={
                    currentView.startsWith('skills:')
                      ? currentView.slice('skills:'.length) || undefined
                      : undefined
                  }
                />
              ) : currentView === 'designs' ? (
                <DesignsList
                  designs={designs}
                  projects={projects}
                  onNavigate={(view, extra) => {
                    setCurrentView(view);
                    if (view === 'design' && extra) setActiveDesignId(extra);
                  }}
                  onChanged={refreshDesigns}
                />
              ) : currentView === 'design' && activeDesign ? (
                <DesignView
                  design={activeDesign}
                  messages={designMessages}
                  streaming={designStreaming}
                  thinking={designThinking}
                  processing={designProcessing}
                  reloadToken={designReloadToken}
                  send={send}
                  onBack={() => setCurrentView('designs')}
                  onManualReload={() => setDesignReloadToken((t) => t + 1)}
                  showToast={showToast}
                  onDesignRecordUpdated={(d) =>
                    setDesigns((prev) => prev.map((x) => (x.id === d.id ? { ...x, ...d } : x)))
                  }
                  agents={agents}
                  onDesignForwarded={(result) => {
                    const session = result?.session;
                    if (!session) return;
                    pendingSessionIdRef.current = session.id;
                    setActiveAgentId(session.agent_id);
                    setActiveSessionId(session.id);
                    setCurrentView('chat');
                    showToast(
                      `Design forwarded — ${session.name || 'new session'}`,
                      'success',
                      4000,
                    );
                  }}
                />
              ) : (
                <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
                  {activeSessionId && (
                    <SessionAgentsPanel
                      sessionId={activeSessionId}
                      sessionAgents={sessionAgents}
                      maxTurns={activeSession?.max_turns}
                      agents={agents}
                      onUpdated={handleSessionAgentsUpdated}
                    />
                  )}
                  <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden lg:flex-row">
                    <div className="flex-1 flex flex-col min-w-0 min-h-0">
                      {/* Messages */}
                      <div
                        ref={scrollContainerRef}
                        onScroll={handleScrollEvent}
                        className="flex-1 overflow-y-auto p-3 md:p-6 relative border-t-2"
                        style={{ borderTopColor: chatAccentColor }}
                      >
                        <div className="mx-auto" ref={messagesColumnRef}>
                          {/* Cursor-style timed checklist — rendered at top of chat
                      whenever the session has emitted `[[STEP:...]]` markers.
                      Collapses automatically once all steps resolve. */}
                          {orchestrationTimelineEntries.length > 0 && (
                            <OrchestrationTimelinePanel entries={orchestrationTimelineEntries} />
                          )}
                          {(sessionProgress[activeSessionId] || []).length > 0 && (
                            <div className="px-3 md:px-0 mb-3 max-w-[95%] sm:max-w-[90%] mx-auto">
                              <ProgressPanel
                                steps={sessionProgress[activeSessionId]}
                                sessionRunning={Boolean(
                                  streamingMsgId || activeTasks[activeSessionId],
                                )}
                              />
                            </div>
                          )}
                          {(reactLoopStepsBySession[activeSessionId] || []).length > 0 && (
                            <ReactLoopObservabilityPanel
                              steps={reactLoopStepsBySession[activeSessionId]}
                              streaming={Boolean(streamingMsgId || activeTasks[activeSessionId])}
                            />
                          )}
                          {messages.length === 0 && !thinking && !streamingContent && (
                            <div
                              className="flex flex-col items-center justify-center h-full text-gray-500 py-20 px-6 text-center"
                              data-testid={
                                sessionMessagesLoading
                                  ? 'chat-messages-loading'
                                  : 'chat-empty-state'
                              }
                            >
                              {sessionMessagesLoading ? (
                                <>
                                  <Loader2 size={40} className="mb-4 text-gray-500 animate-spin" />
                                  <p className="text-lg">Loading conversation</p>
                                  <p className="text-sm mt-1 text-gray-500">Fetching messages…</p>
                                </>
                              ) : (
                                <>
                                  <MessageCircle size={40} className="mb-3 text-gray-600" />
                                  {sessionsListLoading && projectDataReady && activeAgent ? (
                                    <>
                                      <p className="text-lg">Loading conversation</p>
                                      <p className="text-sm mt-1 text-gray-500">
                                        Sessions are syncing…
                                      </p>
                                    </>
                                  ) : activeAgent ? (
                                    <>
                                      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-600 mb-1">
                                        Chat
                                      </p>
                                      <h2 className="text-xl font-semibold text-gray-200 mb-2">
                                        Talk to {activeAgent.name}
                                      </h2>
                                      <p className="text-sm text-gray-500 max-w-md leading-relaxed">
                                        This is a chat session with{' '}
                                        <span className="text-gray-300">{activeAgent.name}</span>.
                                        Type a message below to ask a question, hand off a task, or
                                        pair on changes — replies stream in real time.
                                      </p>
                                    </>
                                  ) : (
                                    <>
                                      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-600 mb-1">
                                        Chat
                                      </p>
                                      <h2 className="text-xl font-semibold text-gray-200 mb-2">
                                        No agent selected
                                      </h2>
                                      <p className="text-sm text-gray-500 max-w-md leading-relaxed">
                                        Pick an agent from the sidebar to start a conversation, or
                                        jump to the dashboard to see what&apos;s happening across
                                        your projects.
                                      </p>
                                    </>
                                  )}
                                </>
                              )}
                              <p className="text-xs text-gray-700 mt-5 hidden sm:block">
                                Ctrl+K to switch agents · Esc to cancel
                              </p>
                            </div>
                          )}
                          {(() => {
                            const queuedIds = new Set(
                              (messageQueues[activeSessionId] || []).map((q) => q.id),
                            );
                            // Render non-queued messages inline, queued messages stick to bottom
                            const nonQueued = messages.filter((msg) => !queuedIds.has(msg.id));
                            const queued = messages.filter((msg) => queuedIds.has(msg.id));
                            return (
                              <>
                                {nonQueued.map((msg) =>
                                  msg.role === 'assistant' ? (
                                    <SessionTail
                                      key={msg.id}
                                      message={msg}
                                      events={eventsByMessage[msg.id]}
                                      agentColor={msg.agent_color || chatAccentColor}
                                      onEventsLoaded={handleEventsLoaded}
                                      onAskSubmit={handleAskSubmit}
                                      askSubmittedIds={askSubmitted}
                                      fromAgent={activeAgent}
                                      agents={agents}
                                      sessionHandoffs={sessionHandoffs}
                                      sessionDelegations={delegations[activeSessionId]}
                                      delegationDispatchError={
                                        delegationDispatchErrors[activeSessionId]
                                      }
                                      onOpenSession={handleOpenHandoffSession}
                                      browserScreenshots={
                                        browserScreensBySession[activeSessionId]?.[msg.id] ?? {}
                                      }
                                    />
                                  ) : (
                                    <ChatMessage
                                      key={msg.id}
                                      message={msg}
                                      agentColor={chatAccentColor}
                                    />
                                  ),
                                )}
                                {sessionRoundProcessing && (
                                  <div className="px-3 md:px-0 mb-3 max-w-[95%] sm:max-w-[90%] mx-auto">
                                    <div className="text-xs text-amber-400/90 bg-amber-950/20 border border-amber-800/40 rounded-lg px-3 py-2">
                                      Multi-agent round in progress…
                                    </div>
                                  </div>
                                )}
                                {thinking && !streamingMsgId && (
                                  <ThinkingIndicator
                                    agentColor={streamingAgent?.agentColor || activeAgent?.color}
                                    agentName={streamingAgent?.agentName}
                                  />
                                )}
                                {streamingMsgId &&
                                streamingAgent &&
                                streamingAgent.agentId !== activeAgentId ? (
                                  <div className="flex justify-start mb-4">
                                    <div className="max-w-[95%] sm:max-w-[90%] bg-gray-800 rounded-2xl rounded-bl-md px-4 py-3">
                                      <div className="flex items-center gap-2 mb-1">
                                        <span
                                          className="w-2 h-2 rounded-full"
                                          style={{ backgroundColor: streamingAgent.agentColor }}
                                        />
                                        <span className="text-xs text-gray-500 font-medium">
                                          {streamingAgent.agentName}
                                        </span>
                                        <span className="text-xs text-gray-600 animate-pulse">
                                          streaming…
                                        </span>
                                      </div>
                                      <div className="text-sm text-gray-300 whitespace-pre-wrap">
                                        {streamingContent}
                                        <span className="inline-block w-2 h-4 bg-gray-500 animate-pulse ml-0.5" />
                                      </div>
                                    </div>
                                  </div>
                                ) : (
                                  streamingMsgId && (
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
                                      agentColor={streamingAgent?.agentColor || activeAgent?.color}
                                      streaming
                                      onInterrupt={handleCancel}
                                      onAskSubmit={handleAskSubmit}
                                      askSubmittedIds={askSubmitted}
                                      fromAgent={activeAgent}
                                      agents={agents}
                                      sessionHandoffs={sessionHandoffs}
                                      sessionDelegations={delegations[activeSessionId]}
                                      delegationDispatchError={
                                        delegationDispatchErrors[activeSessionId]
                                      }
                                      onOpenSession={handleOpenHandoffSession}
                                      browserScreenshots={
                                        activeSessionId
                                          ? (browserScreensBySession[activeSessionId]?.[
                                              streamingMsgId
                                            ] ?? {})
                                          : {}
                                      }
                                    />
                                  )
                                )}
                                {doneVerifyLogBySession[activeSessionId] && (
                                  <div className="px-4 max-w-[95%] sm:max-w-[90%] mx-auto mb-2">
                                    <div className="rounded-lg border border-amber-600/40 bg-amber-950/25 px-3 py-2">
                                      <div className="text-xs font-semibold text-amber-100/90 mb-1">
                                        Pre-done verification
                                      </div>
                                      <pre className="text-[11px] text-gray-300 whitespace-pre-wrap font-mono max-h-72 overflow-y-auto leading-relaxed">
                                        {doneVerifyLogBySession[activeSessionId]}
                                      </pre>
                                    </div>
                                  </div>
                                )}
                                {/* Delegation panel — shows when a lead agent delegates to sub-agents */}
                                {delegations[activeSessionId] &&
                                  delegations[activeSessionId].tasks.length > 0 && (
                                    <div className="px-4 max-w-[95%] sm:max-w-[90%]">
                                      <DelegationPanel
                                        delegations={delegations[activeSessionId].tasks}
                                        sessionId={activeSessionId}
                                        throttled={throttle[activeSessionId]?.active}
                                        onCancel={(sid) =>
                                          send({ type: 'delegation_cancel', sessionId: sid })
                                        }
                                      />
                                    </div>
                                  )}
                                {/* Resolve PR sessions fix an existing PR — never offer Create PR / merge here */}
                                {changesReady[activeSessionId] &&
                                  !streamingMsgId &&
                                  !chatProjectIsWorkflow &&
                                  activeResolvePrBannerInfo && (
                                    <ResolveSessionPrBanner
                                      prUrl={activeResolvePrBannerInfo.prUrl}
                                      prNumber={activeResolvePrBannerInfo.prNumber}
                                      branchLabel={changesReady[activeSessionId]?.branch}
                                      sessionId={activeSessionId}
                                      onDismiss={(sessionId) => {
                                        setChangesReady((prev) => {
                                          const next = { ...prev };
                                          delete next[sessionId];
                                          return next;
                                        });
                                      }}
                                    />
                                  )}
                                {/* Queued messages always render at the very bottom */}
                                {queued.map((msg) => (
                                  <ChatMessage
                                    key={msg.id}
                                    message={{ ...msg, queued: true }}
                                    agentColor={chatAccentColor}
                                    onDequeue={handleDequeue}
                                    onEditQueued={handleEditQueuedMessage}
                                    onEditInComposer={handleEditInComposer}
                                    onInterrupt={handleInterruptQueuedMessage}
                                    inFlightWhileStreaming={isProcessing}
                                  />
                                ))}
                              </>
                            );
                          })()}
                        </div>

                        {/* Scroll to bottom button */}
                        {showScrollBtn && (
                          <button
                            onClick={() => scrollToBottom()}
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
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M19 14l-7 7m0 0l-7-7m7 7V3"
                              />
                            </svg>
                            Scroll to bottom
                          </button>
                        )}
                      </div>

                      {/* Show-preview pill — visible only when there's a
                        preview event for this session but the user has
                        closed the pane. One-click reopen. */}
                      {activeSessionId &&
                        activePreviewEvent &&
                        previewPaneOpenBySession[activeSessionId] === false && (
                          <div className="px-3 md:px-6 pb-1">
                            <button
                              type="button"
                              data-testid="reopen-preview-pane"
                              onClick={() => {
                                setPreviewPaneOpenBySession((prev) => ({
                                  ...prev,
                                  [activeSessionId]: true,
                                }));
                                try {
                                  const key = paneOpenStorageKey(activeSessionId);
                                  if (key) window.localStorage.setItem(key, 'true');
                                } catch {
                                  /* storage unavailable */
                                }
                              }}
                              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-sky-800/60 hover:bg-sky-700/70 text-sky-100 border border-sky-700/60"
                            >
                              <ArrowLeftRight size={12} /> Show preview
                            </button>
                          </div>
                        )}

                      {activeSessionId && (
                        <div className="px-3 md:px-6 pb-2 flex items-center gap-2 border-t border-gray-800/80 pt-2">
                          <SessionPreviewStartButton
                            sessionId={activeSessionId}
                            project={activeChatProject}
                            previewEvent={previewEventBySession[activeSessionId]}
                            disabled={!connected || !activeChatProject}
                            starting={!!previewStartingBySession[activeSessionId]}
                            workspaceEnsuring={!!workspaceEnsuringBySession[activeSessionId]}
                            workspaceNotReady={
                              !!activeSession &&
                              isSessionWorktreeEnabled(activeSession) &&
                              !isSessionWorkspaceReady(activeSession)
                            }
                            onStart={handleStartSessionPreview}
                            onConfigure={handlePreviewConfigure}
                          />
                          {/* Create ticket & PR — loads create-ticket-and-pr skill */}
                          {activeSessionId && (
                            <ChangesReadyBox
                              sessionId={activeSessionId}
                              isSessionProcessing={isProcessing}
                              shipFailureAt={shipFailureAt}
                              changes={
                                changesReady[activeSessionId] || {
                                  agentId: activeSession?.agent_id,
                                  branch: activeSession?.worktree_branch || '',
                                  hasUncommitted: false,
                                  hasUnpushed: false,
                                }
                              }
                              onTrigger={async () => {
                                try {
                                  await api.shipSession(activeSessionId);
                                } catch (err) {
                                  showToast(
                                    err?.message || 'Failed to start Create ticket & PR',
                                    'error',
                                    8000,
                                  );
                                }
                              }}
                              onDismiss={(sessionId) => {
                                setChangesReady((prev) => {
                                  const next = { ...prev };
                                  delete next[sessionId];
                                  return next;
                                });
                              }}
                            />
                          )}
                        </div>
                      )}

                      {/* Input */}
                      <MessageInput
                        onSend={handleSend}
                        onCancel={handleCancel}
                        disabled={!activeAgent || !connected}
                        isProcessing={isProcessing}
                        queueLength={(messageQueues[activeSessionId] || []).length}
                        agentColor={chatAccentColor}
                        skills={skills}
                        askMode={sessionAskMode}
                        readOnly={activeAgent?.role === 'reviewer'}
                        draftKey={activeSessionId || activeAgentId || 'none'}
                        onFileError={(msg) => showToast(msg, 'error', 6000)}
                        composerPrefill={composerPrefill}
                        onComposerPrefillClear={() => setComposerPrefill(null)}
                        onReplaceQueuedMessage={handleEditQueuedMessage}
                        sessionAgents={sessionAgents}
                        enableMentions={sessionAgents.length > 1}
                      />
                    </div>
                    {showSessionPreviewPane && (
                      <SessionPreviewPane
                        sessionId={activeSessionId}
                        event={activePreviewEvent}
                        onClose={handlePreviewClose}
                        onTouch={handlePreviewTouch}
                        onStop={handlePreviewStop}
                        onConfigure={handlePreviewConfigure}
                      />
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Keyboard shortcuts help */}
        <ShortcutsHelpModal
          isOpen={showShortcutsHelp}
          onClose={() => setShowShortcutsHelp(false)}
          shortcuts={keyboardShortcutList}
        />

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

        {/* Forward Session Modal */}
        {showForward && activeSessionId && activeAgent && (
          <ForwardSessionModal
            sourceAgent={activeAgent}
            agents={agents}
            sessionId={activeSessionId}
            onClose={() => setShowForward(false)}
            onForward={({ targetAgentId, prompt, autoStart }) =>
              api.forwardSession(activeSessionId, { targetAgentId, prompt, autoStart })
            }
            onForwarded={(result) => {
              const session = result?.session;
              if (!session) return;
              // Optimistically navigate into the new session (mirrors the
              // handoff open-target pattern in `handleOpenHandoffSession`).
              pendingSessionIdRef.current = session.id;
              setActiveAgentId(session.agent_id);
              setActiveSessionId(session.id);
              setCurrentView('chat');
              showToast(`Forwarded to ${session.name || 'new session'}`, 'success', 4000);
            }}
            onError={(msg) => showToast(`Forward failed: ${msg}`, 'error', 6000)}
          />
        )}

        {/* First-run setup wizard */}
        {showSetup && setupStatus && (
          <SetupWizard
            setupStatus={setupStatus}
            initialStep={setupInitialStep}
            onComplete={() => {
              setShowSetup(false);
              setSetupInitialStep(1);
              openAdaptiveProjectWizard();
            }}
          />
        )}

        {/* Import existing project — full-screen wizard (draft survives
            Back / Close / Esc). Two view keys mount the same component:
            `import-project-wizard` is the current, telemetry-friendly name
            surfaced by the new "Import existing project" CTA;
            `new-project-wizard` is retained as a legacy alias for any
            older links, deep-state, or tests that still reference it. */}
        {(currentView === 'import-project-wizard' || currentView === 'new-project-wizard') && (
          <OpenProjectWizard
            layout="fullscreen"
            onClose={() => setCurrentView(newProjectWizardReturnRef.current)}
            onProjectCreated={() => {
              setCurrentView(newProjectWizardReturnRef.current);
              refreshAgents();
            }}
          />
        )}

        {/* New project — adaptive (prompt-first) flow, Acts I–V. Routed via
            the primary "+ New Project" CTA. Rendered as a fixed-inset
            overlay so it fills the viewport (same layout semantics as the
            legacy fullscreen wizard). */}
        {currentView === 'new-project-adaptive' && (
          <div
            data-testid="new-project-adaptive-mount"
            className="fixed inset-0 z-[100] flex flex-col bg-gray-950 text-white"
          >
            <NewProjectAdaptiveFlow
              onClose={() => setCurrentView(newProjectWizardReturnRef.current)}
              onProjectCreated={(payload) => {
                if (payload?.action === 'import') {
                  setCurrentView('import-project-wizard');
                  setSidebarOpen(false);
                  return;
                }
                refreshAgents();
                if (payload?.action === 'chat' && payload.agentId) {
                  setActiveAgentId(payload.agentId);
                  setCurrentView('chat');
                  setSidebarOpen(false);
                  return;
                }
                if (payload?.action === 'task' && payload.projectId) {
                  setCurrentView(`kanban:${payload.projectId}`);
                  setSidebarOpen(false);
                  return;
                }
                // Default: open/landed — return to the prior view.
                setCurrentView(newProjectWizardReturnRef.current);
              }}
            />
          </div>
        )}

        {/* Toast notifications */}
        {toasts.length > 0 && (
          <div className="fixed top-4 right-4 z-[60] flex flex-col gap-2 max-w-sm">
            {toasts.map((toast) => (
              <Toast
                key={toast.id}
                toast={toast}
                onDismiss={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
              />
            ))}
          </div>
        )}
      </div>
      {/* close flex row wrapper */}
    </div>
  );
}

function Toast({ toast, onDismiss }) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (toast.duration) {
      const timer = setTimeout(() => onDismissRef.current(), toast.duration);
      return () => clearTimeout(timer);
    }
  }, [toast.duration]);

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

  const interactive = Boolean(toast.onClick);

  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? String(toast.message) : undefined}
      onClick={
        interactive
          ? () => {
              toast.onClick();
              onDismiss();
            }
          : undefined
      }
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toast.onClick();
                onDismiss();
              }
            }
          : undefined
      }
      className={`${colors[toast.type] || colors.info} border rounded-lg px-4 py-3 shadow-lg backdrop-blur-sm flex items-start gap-2.5 animate-slide-in ${
        interactive ? 'cursor-pointer hover:brightness-110 transition-[filter]' : ''
      }`}
    >
      <span className="flex-shrink-0">{icons[toast.type] || <Info size={18} />}</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{toast.message}</p>
        {toast.onClick && (
          <p className="text-xs opacity-75 mt-0.5">Click this notification to open</p>
        )}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        className="text-current opacity-50 hover:opacity-100 flex-shrink-0 text-lg leading-none z-10"
        aria-label="Dismiss notification"
      >
        &times;
      </button>
    </div>
  );
}
