import {
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useCallback,
  lazy,
  Suspense,
} from 'react';
import Sidebar from './components/Sidebar';
import BrandLogo from './components/BrandLogo';
import TopBar from './components/TopBar';
import ChatMessage from './components/ChatMessage';
import ThinkingIndicator from './components/ThinkingIndicator';
import SessionTail from './components/SessionTail';
import MessageInput from './components/MessageInput';
import AgentSwitcher from './components/AgentSwitcher';
import ForwardSessionModal, { filterForwardTargets } from './components/ForwardSessionModal';
import SettingsPage from './components/SettingsPage';
import ProjectMenuPage from './components/ProjectMenuPage';
import SkillsPage from './components/SkillsPage';
import ReviewerPage from './components/ReviewerPage';
import SessionAgentsPanel from './components/SessionAgentsPanel';
import DesignsList from './components/DesignsList';
import DesignView from './components/DesignView';
import DelegationPanel from './components/DelegationPanel';
import SessionSummarySidebar from './components/SessionSummarySidebar';
import SessionTimelineSidebar, {
  readTimelinePaneOpen,
  writeTimelinePaneOpen,
} from './components/SessionTimelineSidebar';
import { TIMELINE_ANCHOR_NAVIGATE_EVENT } from '@shared/utils/sessionTimeline';
import SessionPreviewPane from './components/SessionPreviewPane';
import BackgroundShellsPanel from './components/BackgroundShellsPanel';
import SessionDesignPane from './components/SessionDesignPane';
import SessionDesignModePane from './components/SessionDesignModePane';
import SessionScopingModePane from './components/SessionScopingModePane';
// Lazy — pulls in @git-diff-view/react + its CSS only when the diff pane opens.
const SessionChangesPane = lazy(() => import('./components/SessionChangesPane'));
const SessionArtifactsPane = lazy(() => import('./components/SessionArtifactsPane'));
const SessionTerminalPane = lazy(() => import('./components/SessionTerminalPane'));
import { RunInTerminalProvider } from './components/RunInTerminalContext';
import { sendCommandToTerminal } from './utils/terminalCommandBus';
import LinkDesignModal from './components/LinkDesignModal';
import SessionPreviewStartButton from './components/SessionPreviewStartButton';
import SessionBranchPicker from './components/SessionBranchPicker';
import AwsSsoLoginMenu from './components/AwsSsoLoginMenu';
import SessionActionsMenu from './components/SessionActionsMenu';
import {
  paneOpenStorageKey,
  clearSessionPreviewStorage,
  previewIdFromEvent,
  shouldShowSessionPreviewPane,
  previewStateApiPath,
  resolvePreviewHydration,
} from './utils/sessionPreviewState';
import { resolveSessionRightPaneFlags } from './utils/sessionRightPaneFlags';
import FinalizeButton from './components/finalize/FinalizeButton';
import FinalizeAutomationSelect from './components/finalize/FinalizeAutomationSelect';
import FinalizeChecksLiveBlock from './components/finalize/FinalizeChecksLiveBlock';
import ResolveSessionPrBanner from './components/ResolveSessionPrBanner';
import {
  inferPrUrlFromSessionTitle,
  isResolvePrSessionTitle,
  parseResolvePrNumberFromTitle,
} from '@shared/utils/sessionTitlePr';
import ProgressPanel, { mergeProgressEvent } from './components/ProgressPanel';
import ReactLoopObservabilityPanel from './components/ReactLoopObservabilityPanel';
import OrchestrationTimelinePanel from './components/OrchestrationTimelinePanel';
import OpenProjectWizard from './components/OpenProjectWizard';
import NewProjectAdaptiveFlow from './components/NewProjectAdaptiveFlow';
import SetupWizard, {
  resolveSetupWizardPresentation,
  stepIndexForKey,
} from './components/SetupWizard';
import KanbanBoard from './components/KanbanBoard';
import EpicView from './components/EpicView';
import KanbanCardTemplatesView from './components/KanbanCardTemplatesView';
import DashboardView from './components/DashboardView';
import WikiBrowser from './components/WikiBrowser';
import ThreadList from './components/ThreadList';
import ThreadView from './components/ThreadView';
import { isRetiredHeartbeatThread } from '@shared/utils/retiredHeartbeatThread';
import CustomerSupportPage from './components/CustomerSupportPage';
import SupportOverviewPage from './components/SupportOverviewPage';
import CalendarAgendaPage from './components/CalendarAgendaPage';
import GmailPage from './components/GmailPage';
import TodosPage from './components/TodosPage';
import PersonalDashboard from './components/PersonalDashboard';
import DailySummaryPage from './components/DailySummaryPage';
import HubPage from './components/HubPage';
import HubModelPicker, { defaultHubModelForEngine } from './components/HubModelPicker';
import HubClearChatButton from './components/HubClearChatButton';
import {
  parseHubPane,
  hubPaneFromLegacyView,
  HUB_ASSISTANT_AGENT_ID,
  type HubWorkspacePane,
} from '@shared/utils/hub';
import { useGoogleStatus } from './hooks/useGoogleStatus';
import { shouldShowCalendarNav, shouldShowGmailNav } from './utils/googleSurface';
import DeploymentsPage from './components/DeploymentsPage';
import ReplaysDashboardPage from './components/ReplaysDashboardPage';
import SecurityPage from './components/SecurityPage';
import NotesEditor from './components/NotesEditor';
import PullRequestsPage from './components/PullRequestsPage';
import RepositoryPage from './components/RepositoryPage';
import ProjectWorkflowsPage from './components/ProjectWorkflowsPage';
import ProjectWorkflowBuilder from './components/ProjectWorkflowBuilder';
import FinalizeSettingsSection from './components/FinalizeSettingsSection';
import ProjectStatsView from './components/ProjectStatsView';
import DevServerSection from './components/DevServerSection';
import RumSettingsSection from './components/RumSettingsSection';
import LogsPage from './components/logs/LogsPage';
import InfrastructurePage from './components/infra/InfrastructurePage';
import ProjectAwsProfilesEditor from './components/ProjectAwsProfilesEditor';
import ShortcutsHelpModal from './components/ShortcutsHelpModal';
import UpdateAvailableModal from './components/UpdateAvailableModal';
import ReleasesView from './components/ReleasesView';
import { useWebSocket } from './hooks/useWebSocket';
import { useWsReconnectBroadcast } from './hooks/useWsReconnectBroadcast';
import { useVisibleIntervalRefresh } from './hooks/useVisibleIntervalRefresh';
import { useDesktopNotifications } from './hooks/useDesktopNotifications';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useVersionCheck } from './hooks/useVersionCheck';
import { fetchDesktopUpdateHealth } from './utils/desktopUpdateCheck';
import {
  createPendingLessonCountsState,
  reconcilePendingLessonProjects,
  beginPendingLessonFetch,
  applyPendingLessonSuccess,
  applyPendingLessonFailure,
  pendingLessonCountsSnapshot,
} from '@shared/utils/pendingLessonCounts';
import { api } from './utils/api';
import { shouldSuppressToast } from './utils/toastPolicy';
import { canCompleteInstanceOnboarding } from './utils/auth';
import { createRefreshScheduler, kanbanEventTargetsProject } from '@shared/utils/kanbanRefresh';
import { readCollapsedColumnIds, writeCollapsedColumnIds } from './utils/kanbanColumnCollapse';
import { isWorkflowProject } from './utils/projectMode';
import { mapDelegationRowsToLiveShape } from './utils/delegationsHydrate';
import { coalescePromiseByKey } from '@shared/utils/coalesceInFlight';
import {
  isNearBottom,
  forcePinChatTailScroll,
  shouldFollowTailAfterScroll,
  pinChatToBottom,
} from './utils/chatScroll';
import {
  MESSAGES_PAGE_SIZE,
  inferHasMore,
  mergeNewestMessages,
  shouldLoadOlder,
  prependOlderMessages,
  restoredScrollTop,
} from './utils/messagePagination';
import { shouldBackfillFinalizeChecksTimeline } from './utils/finalizeTimelineBackfill';
import {
  buildInterruptQueuedMessageDispatch,
  isPersistedUploadAttachment,
} from '@shared/utils/queuedMessageAttachments';
import { attachTailPinResizeObserver } from './utils/chatScrollResizeObserver';
import { parseWorkflowEditView } from './utils/workflowEditView';
import { pruneSessionScopedMap } from './utils/pruneSessionScopedMap';
import {
  applyBackgroundShellSnapshot,
  applyBackgroundShellUpdate,
  applyBackgroundShellLog,
  applyBackgroundShellLogSnapshot,
  applyTerminalJobSnapshot,
  applyTerminalJobUpdate,
  dismissTerminalJob,
  deriveWatchIndicator,
  PTY_TAB_ID,
  shouldFocusTerminalJob,
  type BackgroundShellsBySession,
} from './utils/backgroundShells';
import {
  awaitingInputNotification,
  cardStartedNotification,
  cardReviewNotification,
  prReadyNotification,
  sessionCompleteNotification,
  threadCreatedNotification,
  threadEntryNotification,
} from './utils/ticketNotifications';
import {
  MessageCircle,
  Info,
  CheckCircle,
  AlertTriangle,
  Loader2,
  ArrowLeftRight,
  GitBranch,
  Package,
  SquareTerminal,
  PanelLeftOpen,
  History,
} from 'lucide-react';
import { readSidebarCollapsed, writeSidebarCollapsed } from './utils/sidebarCollapse';
import {
  migrateFromLegacy,
  fetchOrgs,
  getActiveOrg,
  getActiveOrgApiId,
  getOrgs,
  switchOrg,
} from './utils/orgs';
import { getApiBase, getAuthHeaders, reloadForOrgSwitch } from './utils/connection';
import { extractSubmittedAskIds } from './utils/askAnswers';
import { resolveDesignRedirect } from './utils/designRedirect';
import {
  applyDiffCountWsEffect,
  createDiffFileCountRefresher,
  fileCountFromChangesSummary,
  isWorktreeSession,
  setSessionFileCount,
} from './utils/diffFileCount';
import {
  applyAwaitingInputEvent,
  applyAwaitingInputSnapshot,
  clearAwaitingInputForSession,
  shouldNotifyForAwaitingInput,
} from './utils/awaitingInputState';
import { getDefaultShortcuts } from './utils/shortcuts';
import { buildNavigationHash, getInitialNavigation, parseNavigationPath } from './utils/navigation';
import { isSessionOwnedByOtherUser } from './utils/sessionNotificationOwnership';
import {
  firstEngineWithAuthenticatedModels,
  defaultModelForAuthenticatedEngine,
} from './utils/authModelEngines';
import {
  isSessionConsultModeEnabled,
  isSessionWorkspaceReady,
  isSessionWorktreeEnabled,
  shouldShowSessionChangesButton,
  shouldEnsureSessionWorkspaceOnOpen,
  isSessionComposerWorkspaceReady,
  shouldDisableSessionComposer,
  planWorkspaceEnsureOnOpen,
  withoutSessionKey,
  prependSessionDeduped,
  planCreatedSessionCaches,
  planRemoteSessionCreatedCaches,
} from './utils/sessionDerivedState';
import { appendPreviewLogTail, mergePreviewEventLogTail } from './utils/previewLogTail';
import { mergeBrowserActivityScreenshot } from '@shared/utils/browserScreensBySessionMerge';
import {
  resolveStreamingFromSnapshot,
  resolveLiveStreamIdentity,
  buildStreamingAgentState,
} from '@shared/utils/activeTaskSnapshot';
import { indexSessionsById, resolveChatAccentColor } from './utils/chatAccentColor';
import { notifyFinalizeRunFromTimelineMessage } from './utils/finalizeTimelineLive';
import { deriveSessionState } from './utils/deriveSessionState';
import { resolveDeepLinkTarget, upsertSessionRow } from './utils/sessionDeepLinkTarget';
import { deriveSessionTimelineMarkers } from '@shared/utils/sessionTimeline';
import { shouldAutoPresentArtifact } from '@shared/utils/artifactView';

/**
 * @param {object} [props]
 * @param {string} [props.initialView] — explicit top-level view to mount on
 *   (test seam). Production renders `<App />` with no prop, so the app lands
 *   on the URL hash view or the default home view via `getInitialNavigation`.
 */
export default function App({ initialView }: any = {}) {
  const initialNavigationRef = useRef<any>(null);
  if (!initialNavigationRef.current) {
    initialNavigationRef.current = getInitialNavigation(initialView);
  }
  const initialNavigation = initialNavigationRef.current;
  const [projects, setProjects] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [activeAgentId, _setActiveAgentId] = useState<any>(() => {
    const stored = localStorage.getItem('activeAgentId');
    // Never restore the hidden Hub assistant as the active agent: it is absent
    // from GET /api/projects, so it can't resolve on reload and would fall
    // through to a project agent's session.
    return stored && stored !== HUB_ASSISTANT_AGENT_ID ? stored : null;
  });
  const setActiveAgentId = useCallback((id: any) => {
    // Set Hub-assistant focus in memory, but never persist it — see above.
    if (id && id !== HUB_ASSISTANT_AGENT_ID) localStorage.setItem('activeAgentId', id);
    _setActiveAgentId(id);
  }, []);
  const [sessions, setSessions] = useState<any[]>([]);
  /** Sidebar cache: session lists fetched when an agent row is expanded (without switching chat). */
  const [sessionsByAgentId, setSessionsByAgentId] = useState<Record<string, any[]>>({});
  const [archivedSessionsByAgentId, setArchivedSessionsByAgentId] = useState<Record<string, any[]>>(
    {},
  );
  // Soft-deleted sessions within the 24-hour recovery window for the active
  // agent. Shape: Array<SessionRow & { message_count:number, deleted_at:string }>.
  // Server filters to 24h window + newest-first; client just renders.
  const [archivedSessions, setArchivedSessions] = useState<any[]>([]);
  const [restoringSessionIds, setRestoringSessionIds] = useState<Set<any>>(new Set());
  // activeSessionId is persisted per-agent in localStorage under
  // `activeSessionId:<agentId>` so an Electron reload / app restart returns
  // the user to the same session instead of silently defaulting to whichever
  // row happens to have the newest `updated_at` (which may be a cron/heartbeat
  // session the user wasn't working on). See the session-restore test + the
  // "Session recovery" troubleshooting wiki page.
  const [activeSessionId, setActiveSessionId] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  /** True while GET /api/sessions/:id/messages is in flight after a session switch. */
  const [sessionMessagesLoading, setSessionMessagesLoading] = useState(false);
  /** True while an older page is being fetched (scroll-up). Drives the top spinner. */
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  // Handoffs (rows from GET /api/sessions/:id/handoffs) for the active
  // source session — used by HandoffCard to render an "Open session" link.
  const [sessionHandoffs, setSessionHandoffs] = useState<any[]>([]);
  // Sub-lg viewports: inline skill list (the full summary panel is lg+ only).
  const [thinking, setThinking] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingMsgId, setStreamingMsgId] = useState<any>(null);
  const streamingMsgIdRef = useRef<any>(null);
  const [composerPrefill, setComposerPrefill] = useState<any>(null);
  const [streamingEngine, setStreamingEngine] = useState<any>(null);
  const [sessionEngine, setSessionEngine] = useState('claude-code');
  const [sessionModel, setSessionModel] = useState('claude-opus-5');
  // Codex reasoning ("thinking") preset for the active session: 'high' (default)
  // or 'pro' (→ xhigh). Only meaningful for the codex-cli engine.
  const [sessionReasoningEffort, setSessionReasoningEffort] = useState('high');
  const [modelConfig, setModelConfig] = useState<any>(null);
  // Worktree state was removed when Agent Hub locked to worktree-only sessions.
  // The CLI-detection signal (`gitWorktreeDetected`) is similarly retired.
  const [sessionConsultMode, setSessionConsultMode] = useState(false);
  const [currentView, setCurrentView] = useState(initialNavigation.view);
  const [hubPane, setHubPane] = useState<HubWorkspacePane>(() =>
    parseHubPane(initialNavigation.hubPane || hubPaneFromLegacyView(initialNavigation.view)),
  );
  const [hubMobileTab, setHubMobileTab] = useState<'assistant' | HubWorkspacePane>(() =>
    parseHubPane(initialNavigation.hubPane || hubPaneFromLegacyView(initialNavigation.view)),
  );
  const [hubAgent, setHubAgent] = useState<any>(null);
  // The live per-user Hub assistant session id, resolved from GET /api/me/hub.
  // The Hub composer binds and sends ONLY to this session — never a project row.
  const [hubSessionId, setHubSessionId] = useState<string | null>(null);
  const [hubClearing, setHubClearing] = useState(false);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showForward, setShowForward] = useState(false);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Desktop-only: collapse the sidebar to reclaim horizontal space (mobile keeps
  // using the `sidebarOpen` slide-out drawer and ignores this flag). Persisted
  // to localStorage so the preference survives reloads.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const [deletingSessionIds, setDeletingSessionIds] = useState<Set<any>>(new Set());
  const [deletingBulk, setDeletingBulk] = useState<any>(null); // 'all' | 'inactive' | null
  // Map of sessionId -> running task state ({messageId, content, engine, model}).
  // Populated from the server's snapshot on connect and updated as stream events arrive.
  // Used to (a) restore streaming state when switching sessions and (b) power the
  // "running" indicator in the sidebar.
  const [activeTasks, setActiveTasks] = useState<Record<string, any>>({});
  // Map of sessionId -> { askIds, agentId, sessionName } for sessions that
  // have stopped on an unanswered `agenthub:ask` picker. Populated by the
  // server's `awaiting-input-snapshot` (connect) and `awaiting_input` (live
  // transitions) events. Used to power the "waiting for you" indicator in
  // the sidebar — distinct from `activeTasks` (which is the "working" signal).
  const [awaitingInputBySession, setAwaitingInputBySession] = useState<Record<string, any>>({});
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
  const [eventsByMessage, setEventsByMessage] = useState<Record<string, any>>({});
  // Message queue state: sessionId -> [{id, content, position}]
  const [messageQueues, setMessageQueues] = useState<Record<string, any>>({});
  // Multi-agent session roster for the active session (executor + advisors).
  const [sessionAgents, setSessionAgents] = useState<any[]>([]);
  const [sessionRoundProcessing, setSessionRoundProcessing] = useState(false);
  /** When set, the in-flight stream/thinking bubble is from this agent (advisor turn). */
  const [streamingAgent, setStreamingAgent] = useState<any>(null);
  // Claude Design (Phase 1) — top-level, not project-scoped
  const [designs, setDesigns] = useState<any[]>([]);
  const [activeDesignId, setActiveDesignId] = useState<any>(
    initialNavigation.view === 'design' ? initialNavigation.designId || null : null,
  );
  const [designMessages, setDesignMessages] = useState<any[]>([]);
  const [designStreaming, setDesignStreaming] = useState<any>(null);
  const [designThinking, setDesignThinking] = useState(false);
  const [designProcessing, setDesignProcessing] = useState(false);
  // Cache-buster for the design iframe. Bumped on every `design_updated` WS
  // event for the active design so the iframe re-fetches the latest files.
  const [designReloadToken, setDesignReloadToken] = useState(0);
  // Cache-buster for the in-session linked-design preview pane. Bumped on
  // every `design_updated` WS event whose design id matches the active
  // session's `linked_design_id`, so the embedded canvas updates live.
  const [sessionDesignReloadToken, setSessionDesignReloadToken] = useState(0);
  // Controls the "Link a design" picker modal for the active chat session.
  const [showLinkDesign, setShowLinkDesign] = useState(false);
  // Manual-refresh counter for the design-mode canvas pane. Combined with the
  // per-session `code_changed` tick so the canvas reloads both on agent file
  // writes and on an explicit user reload click.
  const [designModeManualReload, setDesignModeManualReload] = useState(0);
  // Delegation state: Map of sessionId -> { parentMessageId, tasks: [{delegationId, agentId, agentName, agentColor, task, status, content, output, error}] }
  const [delegations, setDelegations] = useState<Record<string, any>>({});
  // Last `delegation_error` per session — surfaces "Dispatch failed: …" on
  // the message-anchored DelegateCard when the round never produced a
  // `delegation_start` (no valid sub-agents, dispatcher exception, etc.).
  // Without this, the only signal was a transient toast and the card sat
  // on "Queued" forever. Cleared when a fresh `delegation_start` arrives
  // for the same session. Shape: { [sessionId]: { message, parentMessageId? } }.
  const [delegationDispatchErrors, setDelegationDispatchErrors] = useState<Record<string, any>>({});
  // Rate-limit throttle state: Map of sessionId -> { active, retryAfterMs, clearedAt }
  const [throttle, setThrottle] = useState<Record<string, any>>({});
  // Subagent tracking: Map of sessionId -> { total, running, done, errored }
  const [subagents, setSubagents] = useState<Record<string, any>>({});
  // Ad-hoc PR creation: Map of sessionId -> { agentId, branch, hasUncommitted, hasUnpushed }
  const [changesReady, setChangesReady] = useState<Record<string, any>>({});
  // Latest Finalize Code Changes status per session (e.g. 'ready_to_push').
  // Seeded from the sessions list (`session.finalize_status`) and patched
  // live by the finalize_run_* WebSocket events. Drives the sidebar
  // "ready to push" indicator.
  const [finalizeStatusBySession, setFinalizeStatusBySession] = useState<Record<string, any>>({});
  // Live shell output while verify-before-Done runs (close-card → Done gate).
  const [doneVerifyLogBySession, _setDoneVerifyLogBySession] = useState<Record<string, any>>({});
  // Cursor-style ProgressPanel state — keyed by sessionId.
  // Each value: Array<{ step, status, startedAt, finishedAt? }> in emit order.
  const [sessionProgress, setSessionProgress] = useState<Record<string, any>>({});
  /** Host ReAct / continuation steps from WebSocket `react_loop_step`, keyed by sessionId. */
  const [reactLoopStepsBySession, setReactLoopStepsBySession] = useState<Record<string, any>>({});
  /** Live browser screenshot previews: messageId → { actionId → data URL }. */
  const [browserScreensBySession, setBrowserScreensBySession] = useState<Record<string, any>>({});
  /**
   * Per-session preview state. Updated whenever an `agenthub_preview` WS
   * event arrives. The pane reads `previewEventBySession[activeSessionId]`
   * and renders accordingly.
   */
  const [previewEventBySession, setPreviewEventBySession] = useState<Record<string, any>>({});
  /** Per-session preview pane open/closed flag (auto-opens on first event). */
  const [previewPaneOpenBySession, setPreviewPaneOpenBySession] = useState<Record<string, any>>({});
  /**
   * Running Hub-owned background shells per session. Drives the watch-loop
   * indicator and the Background shells panel. Seeded by the connect snapshot
   * and folded forward by `background_shell_update`.
   */
  const [backgroundShellsBySession, setBackgroundShellsBySession] =
    useState<BackgroundShellsBySession>({});
  /** Per-session Changes (code diff) pane open flag. When true the diff pane
   * replaces the preview pane on the right (the two are mutually exclusive). */
  const [diffPaneOpenBySession, setDiffPaneOpenBySession] = useState<Record<string, any>>({});
  /** Per-session changed-file count, lifted from the diff pane to badge the
   * "Changes" toolbar button. */
  const [diffFileCountBySession, setDiffFileCountBySession] = useState<Record<string, any>>({});
  /** Per-session counter bumped on each `code_changed` WS event; passed to the
   * diff pane as a reloadToken so the file list stays live while the agent works. */
  const [codeChangedTickBySession, setCodeChangedTickBySession] = useState<Record<string, any>>({});
  /** Per-session Artifacts pane open flag. Mutually exclusive with the Changes
   * and preview panes (only one right pane shows at a time). */
  const [artifactsPaneOpenBySession, setArtifactsPaneOpenBySession] = useState<Record<string, any>>(
    {},
  );
  /** Per-session shared terminal flag. When preview is open this selects the
   * Terminal footer tab; otherwise the terminal occupies the right-hand slot. */
  const [terminalPaneOpenBySession, setTerminalPaneOpenBySession] = useState<Record<string, any>>(
    {},
  );
  /** Per-session activity timeline (change summaries / finalize checks / review comments). */
  const [timelinePaneOpenBySession, setTimelinePaneOpenBySession] = useState<Record<string, any>>(
    {},
  );
  const [selectedTimelineAnchor, setSelectedTimelineAnchor] = useState<string | null>(null);
  /**
   * Running + recently finished Hub background shells, for Terminal job tabs.
   * Distinct from `backgroundShellsBySession`, which drops finished rows so
   * the chat pill only reflects work still in flight.
   */
  const [terminalJobsBySession, setTerminalJobsBySession] = useState<BackgroundShellsBySession>({});
  /** Live stdout/stderr text for Terminal job tabs, keyed session → shell. */
  const [backgroundShellLogsBySession, setBackgroundShellLogsBySession] = useState<
    Record<string, Record<string, string>>
  >({});
  /** Active Terminal tab (`pty` or a background-shell id) per session. */
  const [terminalActiveTabBySession, setTerminalActiveTabBySession] = useState<
    Record<string, string>
  >({});
  /** Per-session count of artifacts, to badge the "Artifacts" toolbar button. */
  const [artifactCountBySession, setArtifactCountBySession] = useState<Record<string, any>>({});
  /** Per-session counter bumped on `artifact_created` / `artifact_deleted` WS
   * events; passed to the artifacts pane as a reloadToken to keep it live. */
  const [artifactTickBySession, setArtifactTickBySession] = useState<Record<string, any>>({});
  /** Latest user-requested deliverable to show in each session's inline viewer. */
  const [presentedArtifactBySession, setPresentedArtifactBySession] = useState<Record<string, any>>(
    {},
  );
  /** Optimistic UI while POST /sessions/:id/preview/start is in flight. */
  const [previewStartingBySession, setPreviewStartingBySession] = useState<Record<string, any>>({});
  /** While POST /sessions/:id/workspace/ensure is cloning the session worktree. */
  const [workspaceEnsuringBySession, setWorkspaceEnsuringBySession] = useState<Record<string, any>>(
    {},
  );
  /**
   * Sessions whose open-time ensure has settled (resolved or failed) this
   * client load. Drives the synchronous composer gate so input stays disabled
   * from first render until the environment is confirmed, not just while the
   * request is in flight.
   */
  const [workspaceEnsureSettledBySession, setWorkspaceEnsureSettledBySession] = useState<
    Record<string, any>
  >({});
  /**
   * Sessions whose open-time ensure FAILED. Tracked separately from the
   * settled (success) map so a failed VM boot keeps the composer gated instead
   * of enabling it — the value is the error message shown with a Retry action.
   */
  const [workspaceEnsureErrorBySession, setWorkspaceEnsureErrorBySession] = useState<
    Record<string, any>
  >({});
  const workspaceEnsureInFlightRef = useRef<Set<any>>(new Set());
  const workspaceEnsureAttemptedRef = useRef<Set<any>>(new Set());
  const previewEventBySessionRef = useRef(previewEventBySession);
  previewEventBySessionRef.current = previewEventBySession;
  const previewStartingBySessionRef = useRef(previewStartingBySession);
  previewStartingBySessionRef.current = previewStartingBySession;
  /**
   * Per-session monotonic "start generation", bumped on each Start-preview
   * click. The /preview/state reconcile poll captures it before its
   * request and re-checks it before applying, so a response computed for
   * an OLDER run is discarded when the user restarted in-flight. This is
   * what lets the synthetic `preview_starting` seed (which has no
   * previewId yet) converge safely without reopening the stale-response
   * race — see the reconcile effect and `reconcilePreviewEvent`.
   */
  const previewStartSeqRef = useRef<Record<string, any>>({});
  /** Sessions where the user clicked Stop — ignore late preview_failed WS noise. */
  const previewUserStoppedBySessionRef = useRef<Record<string, any>>({});
  const tearDownSessionPreviewRef = useRef<any>(null);
  // Tracks which agenthub:ask prompts the user has already answered in this
  // tab, so the picker renders as "Submitted" immediately after click. This is
  // the optimistic, in-memory half; the authoritative source is the derived
  // set below which scans persisted message history.
  const [askSubmittedOptimistic, setAskSubmittedOptimistic] = useState<Set<any>>(() => new Set());
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
  const [wikiProjectId, setWikiProjectId] = useState<any>(
    initialNavigation.view === 'wiki' ? initialNavigation.projectId || null : null,
  );
  // Notes state
  const [notesProjectId, setNotesProjectId] = useState<any>(
    initialNavigation.view === 'notes' ? initialNavigation.projectId || null : null,
  );
  // Previews state
  // Reviewer state — which project's reviewer markdown files are being viewed
  const [reviewerProjectId, setReviewerProjectId] = useState<any>(
    initialNavigation.view === 'reviewer' ? initialNavigation.projectId || null : null,
  );
  // Pull Requests state
  const [pullsProjectId, setPullsProjectId] = useState<any>(
    initialNavigation.view === 'pulls' ? initialNavigation.projectId || null : null,
  );
  /** Deep-link into Pull Requests detail (e.g. session summary linked PR). Cleared when leaving pulls view. */
  const [pullsOpenPrNumber, setPullsOpenPrNumber] = useState<any>(
    initialNavigation.view === 'pulls' ? initialNavigation.prNumber || null : null,
  );
  /** Bumped when the server signals PR/board activity for the open Pulls view — keeps GitHub list live without reload. */
  const [pullsListRefreshNonce, setPullsListRefreshNonce] = useState(0);
  /** Open pull request counts per project, used by the Pulls sidebar badge. */
  const [openPullCounts, setOpenPullCounts] = useState<Record<string, any>>({});
  /** Cleared when user opens the Workflows view — set by workflow WebSocket activity. */
  const [workflowSidebarBadgeByProject, setWorkflowSidebarBadgeByProject] = useState<
    Record<string, any>
  >({});
  /** Deep-link from Workflows → Settings → GitHub: expand this project row (cleared when leaving Settings). */
  const [settingsGithubExpandProjectId, setSettingsGithubExpandProjectId] = useState<any>(null);
  // Threads state
  const [threadsProjectId, setThreadsProjectId] = useState<any>(
    initialNavigation.view === 'threads' ? initialNavigation.projectId || null : null,
  );
  const [activeThreadId, setActiveThreadId] = useState<any>(
    initialNavigation.view === 'threads' ? initialNavigation.threadId || null : null,
  );
  const [activeThread, setActiveThread] = useState<any>(null);
  // Unread thread entry counts per project: { [projectId]: number }
  const [unreadThreadCounts, setUnreadThreadCounts] = useState<Record<string, any>>({});
  // Refs to push WebSocket updates into ThreadList/ThreadView
  const threadListRef = useRef<any>(null);
  const threadViewRef = useRef<any>(null);
  // Customer Support page state
  const [supportProjectId, setSupportProjectId] = useState<any>(
    initialNavigation.view === 'support' ? initialNavigation.projectId || null : null,
  );
  // Deep-linked support ticket to focus on open (e.g. from a Deployments
  // release item). Cleared whenever support is opened without a ticket.
  const [supportTicketId, setSupportTicketId] = useState<any>(
    initialNavigation.view === 'support' ? initialNavigation.ticketId || null : null,
  );
  // Per-user Google connection status — gates the global Calendar surface in
  // navigation (shown only when connected). The connection lives in Settings ->
  // Account; Calendar is NOT a per-project surface.
  const { status: googleStatus } = useGoogleStatus();
  const googleCalendarNavVisible = shouldShowCalendarNav(googleStatus);
  const googleGmailNavVisible = shouldShowGmailNav(googleStatus);
  const [deploymentsProjectId, setDeploymentsProjectId] = useState<any>(
    initialNavigation.view === 'deployments' ? initialNavigation.projectId || null : null,
  );
  const [replaysProjectId, setReplaysProjectId] = useState<any>(
    initialNavigation.view === 'replays' ? initialNavigation.projectId || null : null,
  );
  // Ref to push WebSocket support_ticket_* updates into CustomerSupportPage
  const supportListRef = useRef<any>(null);
  // Unread support-ticket counts per project: { [projectId]: number }. Seeded
  // from the server on load and kept live by the unreadCount the support_ticket_*
  // WebSocket events carry, so the Support sidebar badge survives a refresh.
  const [unreadTicketCounts, setUnreadTicketCounts] = useState<Record<string, any>>({});
  // Security audit page state.
  const [securityProjectId, setSecurityProjectId] = useState<any>(
    initialNavigation.view === 'security' ? initialNavigation.projectId || null : null,
  );
  // Bumped on a kanban_update for the active security project so SecurityPage
  // re-fetches (a scan's only WebSocket signal is kanban_update).
  const [securityRefreshNonce, setSecurityRefreshNonce] = useState(0);
  // Open-severity counts per project: { [projectId]: { critical, high, … } }.
  // Seeded from the server on load and refreshed on kanban_update; drives the
  // Security sidebar badge (open critical + high).
  const [securityOpenCounts, setSecurityOpenCounts] = useState<Record<string, any>>({});
  // Pending skill-improvement (learned-lesson) counts per project. Seeded on
  // load and refreshed on the skill_improvement_update WS event; drives the
  // Skills sidebar badge so a captured lesson is discoverable without opening
  // the Skills page.
  const [skillImprovementCounts, setSkillImprovementCounts] = useState<Record<string, number>>({});
  // Cron-linked sessions (scheduled tasks)
  const [cronSessions, setCronSessions] = useState<any[]>([]);
  // Skills for the active agent (for /slash-command autocomplete)
  const [skills, setSkills] = useState<any[]>([]);
  // First-run setup
  const [setupStatus, setSetupStatus] = useState<any>(null);
  const [showSetup, setShowSetup] = useState(false);
  // When the wizard is triggered specifically because the user has no AI
  // credentials (rather than because this is a true first-run install), we
  // jump straight to the AI-credentials step and hide Back below it. Org +
  // Welcome are skipped because the org already exists. See App init below.
  const [setupInitialStep, setSetupInitialStep] = useState(1);
  // Owner-only ending: persist `onboardingComplete` and open the first-project
  // picker. Invited User/Admin walkthroughs omit this so they never hit the
  // 403 from POST /api/setup/complete.
  const [setupIncludeFirstProject, setSetupIncludeFirstProject] = useState(true);
  // Full-screen "Connecting…" only until org migration + org list + setup probe.
  // Project/session data loads in the main layout (sidebar shows its own spinner).
  const [initializing, setInitializing] = useState(true);
  // True after the first successful projects fetch in init (or after it fails).
  const [projectDataReady, setProjectDataReady] = useState(false);
  // True while GET /sessions (and session list selection) is in flight for the active agent.
  const [sessionsListLoading, setSessionsListLoading] = useState(false);
  // Active lead reviews: Map of agentId -> { prUrl, cardTitle, sessionId }
  const [activeReviews, setActiveReviews] = useState<Record<string, any>>({});
  // Toast notifications
  const [toasts, setToasts] = useState<any[]>([]);
  const showToast = (message: any, type: any = 'info', duration: any = 5000) => {
    setToasts((prev: any) => [...prev, { id: `toast-${Date.now()}`, type, message, duration }]);
  };
  // Desktop notifications (Electron native / Web Notifications API)
  const { notify } = useDesktopNotifications();
  // Kanban board refresh trigger
  const [kanbanRefreshKey, setKanbanRefreshKey] = useState(0);
  const [kanbanSearchQuery, setKanbanSearchQuery] = useState('');
  const [kanbanSelectedEpicIds, setKanbanSelectedEpicIds] = useState<Set<string>>(() => new Set());
  const [kanbanAvailableLabels, setKanbanAvailableLabels] = useState<string[]>([]);
  const [kanbanSelectedLabels, setKanbanSelectedLabels] = useState<Set<string>>(() => new Set());
  const [kanbanAssignableUsers, setKanbanAssignableUsers] = useState<
    { id: string; username: string }[]
  >([]);
  const [kanbanSelectedUserIds, setKanbanSelectedUserIds] = useState<Set<string>>(() => new Set());
  // Collapsed (hidden) board columns, lifted here so the board and the sidebar
  // "Views" panel share one source of truth — saving/applying a view captures
  // and restores the column layout alongside the filters.
  const [kanbanCollapsedColumnIds, setKanbanCollapsedColumnIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [kanbanPendingCreateTemplate, setKanbanPendingCreateTemplate] = useState<any>(null);
  // A card another surface asked the board to open (e.g. the card a support
  // ticket was converted into, or a pasted `/projects/<id>/board?card=<id>`
  // deep link). Cleared once the board consumes it.
  const [kanbanFocusCardId, setKanbanFocusCardId] = useState<string | null>(
    typeof initialNavigation.view === 'string' && initialNavigation.view.startsWith('kanban:')
      ? initialNavigation.cardId || null
      : null,
  );
  const kanbanProjectId = currentView.startsWith('kanban:') ? currentView.slice(7) : null;
  const kanbanContextProjectId =
    kanbanProjectId ??
    (currentView.startsWith('kanban-templates:')
      ? currentView.slice('kanban-templates:'.length)
      : currentView.startsWith('epics:')
        ? currentView.slice('epics:'.length)
        : currentView.startsWith('epic:')
          ? currentView.split(':')[1] || null
          : null);
  const kanbanContextProjectIdRef = useRef<string | null>(kanbanContextProjectId);
  kanbanContextProjectIdRef.current = kanbanContextProjectId;
  const kanbanRefreshScheduler = useMemo(
    () => createRefreshScheduler(() => setKanbanRefreshKey((key: any) => key + 1)),
    [],
  );
  useEffect(() => () => kanbanRefreshScheduler.dispose(), [kanbanRefreshScheduler]);
  const previousKanbanProjectIdRef = useRef<string | null>(null);

  const resetKanbanViewState = useCallback(() => {
    setKanbanPendingCreateTemplate(null);
    setKanbanSearchQuery('');
    setKanbanSelectedEpicIds(new Set());
    setKanbanAvailableLabels([]);
    setKanbanSelectedLabels(new Set());
    setKanbanAssignableUsers([]);
    setKanbanSelectedUserIds(new Set());
  }, []);

  useLayoutEffect(() => {
    if (!kanbanContextProjectId) {
      resetKanbanViewState();
      return;
    }

    if (
      previousKanbanProjectIdRef.current !== null &&
      previousKanbanProjectIdRef.current !== kanbanContextProjectId
    ) {
      resetKanbanViewState();
    }
    previousKanbanProjectIdRef.current = kanbanContextProjectId;
  }, [kanbanContextProjectId, resetKanbanViewState]);

  // Seed the collapsed-column layout from localStorage whenever the active
  // board project changes (read-only — writes go through the apply helper so we
  // never clobber a project's layout under another project's key on switch).
  // useLayoutEffect (not useEffect) so the seeded layout is committed before the
  // browser paints the board: a plain effect runs after paint, which would flash
  // the previous project's column layout (or all-expanded) for one frame on
  // switch. The synchronous-blocking cost is trivial here (one localStorage read
  // + a setState), so layout-effect timing is the right trade-off.
  useLayoutEffect(() => {
    setKanbanCollapsedColumnIds(
      kanbanProjectId ? readCollapsedColumnIds(kanbanProjectId) : new Set(),
    );
  }, [kanbanProjectId]);

  // Single writer for the collapsed-column layout: updates the shared state and
  // persists it. Driven by board column toggles and "apply view" from the
  // sidebar Views panel.
  const applyKanbanCollapsedColumnIds = useCallback(
    (next: Set<string>) => {
      setKanbanCollapsedColumnIds(next);
      if (kanbanProjectId) writeCollapsedColumnIds(kanbanProjectId, next);
    },
    [kanbanProjectId],
  );
  const activeDesignIdRef = useRef(activeDesignId);
  activeDesignIdRef.current = activeDesignId;

  const scrollContainerRef = useRef<any>(null);
  /** Observed for height changes (streaming, images, code blocks) while pinned to bottom. */
  const messagesColumnRef = useRef<any>(null);
  // Reverse-infinite-scroll bookkeeping. Flags live in refs so the scroll
  // handler (a stable useCallback) reads fresh values without redefining.
  const olderHasMoreRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const refreshingNewestMessagesRef = useRef(false);
  /** Mirrors `messages` so the scroll handler can read the oldest loaded id. */
  const messagesRef = useRef<any[]>([]);
  messagesRef.current = messages;
  /** Set just before a prepend so the layout effect can restore scroll offset. */
  const prependRestoreRef = useRef<any>(null);
  /** Imperative handle on the chat composer — lets the toggle-microphone hotkey
   *  start/stop voice input without prop-drilling recording state up the tree. */
  const messageInputRef = useRef<any>(null);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const hubSessionIdRef = useRef<string | null>(hubSessionId);
  hubSessionIdRef.current = hubSessionId;
  // Linked-design id of the active session — kept in a ref so the stable WS
  // handler can decide whether a `design_updated` event should refresh the
  // in-session preview pane. Assigned after `activeSession` is derived below.
  const activeSessionLinkedDesignIdRef = useRef<any>(null);
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
  // Persist the desktop sidebar collapse preference.
  useEffect(() => {
    writeSidebarCollapsed(sidebarCollapsed);
  }, [sidebarCollapsed]);
  /** One in-flight implicit `createSession` per agent + ask-mode (send with no session). */
  const implicitSessionCreateByKeyRef = useRef<Map<any, any>>(new Map());
  const activeAgentIdRef = useRef(activeAgentId);
  activeAgentIdRef.current = activeAgentId;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  /** Cross-agent session rows for accent color + owner sync before per-agent lists reload. */
  const sessionsByIdRef = useRef<Map<any, any>>(new Map());
  const [sessionsIndexTick, setSessionsIndexTick] = useState(0);
  const bumpSessionsIndex = useCallback(() => {
    setSessionsIndexTick((t: any) => t + 1);
  }, []);
  useEffect(() => {
    indexSessionsById(sessionsByIdRef.current, sessions);
    bumpSessionsIndex();
  }, [sessions, bumpSessionsIndex]);
  // The agent id the current `sessions` / `archivedSessions` arrays were fetched
  // for. These are NOT necessarily `activeAgentId`: during an agent switch React
  // can render with the new `activeAgentId` while these arrays still hold the
  // previous agent's rows (the new fetch hasn't resolved yet). Keying the cache
  // warm-up on `activeAgentId` would then stamp the previous agent's rows under
  // the new agent id, corrupting the sidebar list / bulk-clear inputs. So the
  // fetch success/catch paths set these to the agent they loaded, and the
  // cache-warming effects below write under THAT id. Live WebSocket mutations to
  // `sessions` leave the loaded-agent id unchanged, so they still sync correctly.
  const [loadedSessionsAgentId, setLoadedSessionsAgentId] = useState<any>(null);
  const [loadedArchivedAgentId, setLoadedArchivedAgentId] = useState<any>(null);
  const loadedSessionsAgentIdRef = useRef(loadedSessionsAgentId);
  loadedSessionsAgentIdRef.current = loadedSessionsAgentId;
  const sessionsByAgentIdRef = useRef(sessionsByAgentId);
  sessionsByAgentIdRef.current = sessionsByAgentId;
  // Keep the sidebar per-agent cache warm for the agent whose list is loaded into chat state.
  useEffect(() => {
    if (!loadedSessionsAgentId) return;
    setSessionsByAgentId((prev: any) => ({ ...prev, [loadedSessionsAgentId]: sessions }));
  }, [loadedSessionsAgentId, sessions]);
  useEffect(() => {
    if (!loadedArchivedAgentId) return;
    setArchivedSessionsByAgentId((prev: any) => ({
      ...prev,
      [loadedArchivedAgentId]: archivedSessions,
    }));
  }, [loadedArchivedAgentId, archivedSessions]);

  // Optimistically insert a freshly-created session for `agentId`. Always writes
  // the per-agent sidebar cache; only mutates the live `sessions` array when that
  // array currently belongs to `agentId` (i.e. it is the loaded agent). Without
  // the guard, creating a session for a NOT-yet-loaded agent would prepend it
  // onto the previous agent's `sessions`, and the warm-up effect would then cache
  // that row under the previous agent — the cross-agent pollution this tracking
  // prevents. When switching agents, `setActiveAgentId` triggers a fresh fetch
  // that surfaces the persisted row anyway.
  const insertCreatedSession = useCallback((agentId: any, session: any) => {
    if (!agentId || !session) return;
    const plan = planCreatedSessionCaches({
      targetAgentId: agentId,
      loadedSessionsAgentId: loadedSessionsAgentIdRef.current,
      session,
      sessionsByAgentId: sessionsByAgentIdRef.current,
      sessions: sessionsRef.current,
    });
    setSessionsByAgentId(plan.sessionsByAgentId);
    // `plan.sessions` is the SAME reference when the live list does not belong
    // to `agentId`, so React skips the update (no spurious re-render).
    setSessions(plan.sessions);
  }, []);
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
  const finalizeStatusBySessionRef = useRef(finalizeStatusBySession);
  finalizeStatusBySessionRef.current = finalizeStatusBySession;

  // Track when a session was explicitly navigated to (e.g. from kanban assign)
  // so the agent-change useEffect doesn't overwrite it with a stale session ID.
  const pendingSessionIdRef = useRef<any>(null);
  /** Populated after `focusAgentSession` is defined — WebSocket toasts call `.current(...)`. */
  const focusAgentSessionRef = useRef<any>(null);

  // Refs for thread state (accessible inside WebSocket callback)
  const threadsProjectIdRef = useRef(threadsProjectId);
  threadsProjectIdRef.current = threadsProjectId;
  const supportProjectIdRef = useRef(supportProjectId);
  supportProjectIdRef.current = supportProjectId;
  const securityProjectIdRef = useRef(securityProjectId);
  securityProjectIdRef.current = securityProjectId;
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  const currentViewRef = useRef(currentView);
  currentViewRef.current = currentView;
  const newProjectWizardReturnRef = useRef('chat');
  const routeUrlInitializedRef = useRef(false);

  const routeProjectId = useMemo(() => {
    switch (currentView) {
      case 'wiki':
        return wikiProjectId;
      case 'notes':
        return notesProjectId;
      case 'reviewer':
        return reviewerProjectId;
      case 'pulls':
        return pullsProjectId;
      case 'threads':
        return threadsProjectId;
      case 'support':
        return supportProjectId;
      case 'deployments':
        return deploymentsProjectId;
      case 'replays':
        return replaysProjectId;
      case 'security':
        return securityProjectId;
      default:
        return null;
    }
  }, [
    currentView,
    deploymentsProjectId,
    notesProjectId,
    pullsProjectId,
    replaysProjectId,
    reviewerProjectId,
    securityProjectId,
    supportProjectId,
    threadsProjectId,
    wikiProjectId,
  ]);

  const applyNavigationState = useCallback((route: any) => {
    const view = route?.view || 'hub';
    setCurrentView(view);
    if (typeof view === 'string' && view.startsWith('kanban:')) {
      setKanbanFocusCardId(route?.cardId || null);
    }
    if (view === 'hub' || hubPaneFromLegacyView(view)) {
      const pane = parseHubPane(route?.hubPane || hubPaneFromLegacyView(view));
      setHubPane(pane);
      setHubMobileTab(pane);
    }
    if (view === 'wiki') setWikiProjectId(route?.projectId || null);
    if (view === 'notes') setNotesProjectId(route?.projectId || null);
    if (view === 'reviewer') setReviewerProjectId(route?.projectId || null);
    if (view === 'pulls') {
      setPullsProjectId(route?.projectId || null);
      setPullsOpenPrNumber(route?.prNumber || null);
    }
    if (view === 'threads') {
      setThreadsProjectId(route?.projectId || null);
      setActiveThreadId(route?.threadId || null);
      setActiveThread(null);
    }
    if (view === 'support') {
      setSupportProjectId(route?.projectId || null);
      setSupportTicketId(route?.ticketId || null);
    }
    if (view === 'deployments') setDeploymentsProjectId(route?.projectId || null);
    if (view === 'replays') setReplaysProjectId(route?.projectId || null);
    if (view === 'security') setSecurityProjectId(route?.projectId || null);
    if (view === 'design') setActiveDesignId(route?.designId || null);
    setSidebarOpen(false);
  }, []);

  useEffect(() => {
    if (initialView) return;
    if (typeof window === 'undefined') return;
    const onRouteChange = () => applyNavigationState(getInitialNavigation());
    window.addEventListener('hashchange', onRouteChange);
    window.addEventListener('popstate', onRouteChange);
    return () => {
      window.removeEventListener('hashchange', onRouteChange);
      window.removeEventListener('popstate', onRouteChange);
    };
  }, [applyNavigationState, initialView]);

  // A path deep-link (`/projects/acme/pulls/306`) has already been folded into
  // the initial navigation state, so collapse the path back to the app root
  // before the hash-writing effect below reads `location.pathname`. Otherwise
  // the URL keeps growing a stale path in front of the canonical hash.
  useEffect(() => {
    if (initialView) return;
    if (typeof window === 'undefined' || !window.history) return;
    const parsed = parseNavigationPath(window.location.pathname, window.location.search);
    if (!parsed) return;
    const base = parsed.basePath || '';
    // The board deep link's `?card=<id>` has already been folded into the
    // initial navigation state, so drop it here rather than leaving a stale
    // query dangling in front of the canonical hash.
    const search = new URLSearchParams(window.location.search);
    search.delete('card');
    const query = search.toString();
    window.history.replaceState(
      null,
      '',
      `${base}/${query ? `?${query}` : ''}${window.location.hash}`,
    );
  }, [initialView]);

  useEffect(() => {
    if (initialView) return;
    if (typeof window === 'undefined' || !window.history) return;

    const hash = buildNavigationHash({
      view: currentView,
      projectId: routeProjectId,
      prNumber: pullsOpenPrNumber,
      threadId: activeThreadId,
      designId: activeDesignId,
      ticketId: currentView === 'support' ? supportTicketId : null,
      hubPane: currentView === 'hub' ? hubPane : null,
    });
    if (window.location.hash === hash) {
      routeUrlInitializedRef.current = true;
      return;
    }

    const nextUrl = `${window.location.pathname}${window.location.search}${hash}`;
    const method = routeUrlInitializedRef.current ? 'pushState' : 'replaceState';
    window.history[method](null, '', nextUrl);
    routeUrlInitializedRef.current = true;
  }, [
    activeDesignId,
    activeThreadId,
    currentView,
    initialView,
    pullsOpenPrNumber,
    routeProjectId,
    supportTicketId,
    hubPane,
  ]);

  const isWizardView = (v: any) =>
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
  const handleReorderProjects = useCallback((newOrderIds: any) => {
    setProjects((prev: any) => {
      const byId = new Map(prev.map((p: any) => [p.id, p]));
      const reordered = newOrderIds.map((id: any) => byId.get(id)).filter(Boolean);
      // Belt-and-suspenders: if newOrderIds dropped any project we knew
      // about (shouldn't happen — Sidebar passes the full set), append
      // those back at the end so we never lose rows from the UI.
      for (const p of prev) {
        if (!newOrderIds.includes(p.id)) reordered.push(p);
      }
      return reordered;
    });
    api.reorderProjects(newOrderIds).catch((err: any) => {
      console.error('[reorderProjects] failed, refetching:', err);
      api
        .getProjects()
        .then((data: any) => setProjects(data))
        .catch(() => {
          /* best-effort rollback; surfacing the original error already happened */
        });
    });
  }, []);
  const pullsProjectIdRef = useRef(pullsProjectId);
  pullsProjectIdRef.current = pullsProjectId;

  // Seed per-project unread support-ticket counts once projects are known, so
  // the Support sidebar badge is correct on a cold load. After this, the counts
  // ride live on the support_ticket_* WebSocket events. Runs once; never
  // clobbers a value a WebSocket event already delivered.
  const ticketCountsSeededRef = useRef(false);
  useEffect(() => {
    if (ticketCountsSeededRef.current) return;
    if (!projects || projects.length === 0) return;
    ticketCountsSeededRef.current = true;
    let cancelled = false;
    Promise.all(
      projects.map((p: any) =>
        api
          .getSupportUnreadCount(p.id)
          .then((r: any) => [p.id, r?.count ?? 0])
          .catch(() => [p.id, 0]),
      ),
    ).then((entries: any) => {
      if (cancelled) return;
      setUnreadTicketCounts((prev: any) => {
        const next = { ...prev };
        for (const [pid, count] of entries) {
          if (next[pid] === undefined) next[pid] = count;
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [projects]);

  // Seed per-project security open-severity counts once projects are known, so
  // the Security sidebar badge is correct on a cold load. The findings endpoint
  // returns openCounts alongside the list; passing ?status=open keeps the
  // payload to just the open rows. Runs once; never clobbers a value a later
  // refetch already delivered. Refreshed on kanban_update (see the WS handler).
  const securityCountsSeededRef = useRef(false);
  // Coalesce per-project findings fetches: a burst of kanban_update events (a
  // scan inserting many finding-cards) must not fan out into one socket each,
  // which exhausts the browser connection pool (net::ERR_INSUFFICIENT_RESOURCES)
  // and starves the board load. Concurrent same-project calls share one fetch.
  const securityCountFetchesRef = useRef<Map<string, Promise<unknown>>>(new Map());
  const refreshSecurityOpenCounts = useCallback((projectId: any) => {
    if (!projectId) return;
    void coalescePromiseByKey(securityCountFetchesRef, projectId, () =>
      api
        .getSecurityFindings(projectId, 'open')
        .then((data: any) => {
          const counts = data?.openCounts;
          if (!counts) return;
          setSecurityOpenCounts((prev: any) => ({ ...prev, [projectId]: counts }));
        })
        .catch(() => {
          /* best-effort; the badge stays at its last value */
        }),
    );
  }, []);
  useEffect(() => {
    if (securityCountsSeededRef.current) return;
    if (!projects || projects.length === 0) return;
    securityCountsSeededRef.current = true;
    let cancelled = false;
    Promise.all(
      projects.map((p: any) =>
        api
          .getSecurityFindings(p.id, 'open')
          .then((data: any) => [p.id, data?.openCounts || null])
          .catch(() => [p.id, null]),
      ),
    ).then((entries: any) => {
      if (cancelled) return;
      setSecurityOpenCounts((prev: any) => {
        const next = { ...prev };
        for (const [pid, counts] of entries) {
          if (next[pid] === undefined && counts) next[pid] = counts;
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [projects]);

  // Lifecycle-tracked pending learned-lesson counts (see @shared/utils/
  // pendingLessonCounts): only a successful fetch marks a project seeded, a
  // failure/cancellation preserves the last known count and retries later, and
  // departed projects are pruned so an org-switch revisit refetches fresh.
  const skillImprovementStateRef = useRef(createPendingLessonCountsState());
  const syncSkillImprovementCounts = useCallback(() => {
    setSkillImprovementCounts(pendingLessonCountsSnapshot(skillImprovementStateRef.current));
  }, []);

  // Refetch the pending learned-lesson count for one project. Called on the
  // skill_improvement_update WS event (create/approve/reject all shift the
  // pending tally). The fetch carries a token so a slow response can never
  // overwrite a newer count, nor re-seed a project that departed meanwhile.
  const refreshSkillImprovementCount = useCallback(
    (projectId: any) => {
      const state = skillImprovementStateRef.current;
      const fetchInfo = beginPendingLessonFetch(state, projectId);
      if (!fetchInfo) return;
      const { projectId: pid, token } = fetchInfo;
      api
        .getSkillImprovements(pid, 'pending')
        .then((data: any) => {
          const count = Array.isArray(data?.improvements) ? data.improvements.length : 0;
          if (applyPendingLessonSuccess(state, pid, token, count)) syncSkillImprovementCounts();
        })
        .catch(() => {
          if (applyPendingLessonFailure(state, pid, token)) syncSkillImprovementCounts();
        });
    },
    [syncSkillImprovementCounts],
  );

  // Seed pending learned-lesson counts for any not-yet-seeded project, on a
  // cold load AND whenever the project list changes (org switch, project added,
  // incremental delivery). A project is only marked seeded once its fetch
  // succeeds; a cancelled or failed fetch is retried on the next run. Each
  // fetch's token guards against stale/out-of-order completions.
  useEffect(() => {
    const state = skillImprovementStateRef.current;
    const toFetch = reconcilePendingLessonProjects(
      state,
      (projects ?? []).map((p: any) => p?.id),
      'seed',
    );
    // Reflect pruning of departed projects immediately, even with nothing to fetch.
    syncSkillImprovementCounts();
    if (toFetch.length === 0) return;
    let cancelled = false;
    for (const { projectId: pid, token } of toFetch) {
      api
        .getSkillImprovements(pid, 'pending')
        .then((data: any) => {
          if (cancelled) return;
          const count = Array.isArray(data?.improvements) ? data.improvements.length : 0;
          if (applyPendingLessonSuccess(state, pid, token, count)) syncSkillImprovementCounts();
        })
        .catch(() => {
          if (cancelled) return;
          if (applyPendingLessonFailure(state, pid, token)) syncSkillImprovementCounts();
        });
    }
    return () => {
      cancelled = true;
      // Requests still in flight for this run were neither applied nor
      // resolved; clear their in-flight marker so the next run retries them.
      for (const { projectId: pid, token } of toFetch) {
        applyPendingLessonFailure(state, pid, token);
      }
    };
  }, [projects, syncSkillImprovementCounts]);

  // Coalesced like the security counts above: WS bursts must not fan out into
  // one open-pulls fetch per event and drain the browser socket pool.
  const pullCountFetchesRef = useRef<Map<string, Promise<unknown>>>(new Map());
  const refreshOpenPullCount = useCallback((projectId: any) => {
    if (!projectId) return;
    void coalescePromiseByKey(pullCountFetchesRef, projectId, () =>
      api
        .getProjectPulls(projectId, { state: 'open', limit: 100 })
        .then((data: any) => {
          const count = Array.isArray(data?.pulls) ? data.pulls.length : 0;
          setOpenPullCounts((prev: any) => ({ ...prev, [projectId]: count }));
        })
        .catch(() => {
          setOpenPullCounts((prev: any) =>
            prev[projectId] === undefined ? { ...prev, [projectId]: 0 } : prev,
          );
        }),
    );
  }, []);
  const seededPullProjectsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!projects || projects.length === 0) {
      seededPullProjectsRef.current = new Set();
      return;
    }
    const pullProjects = projects.filter(
      (p: any) =>
        p?.id &&
        !isWorkflowProject(p) &&
        (p.githubRepo || p.gitHost === 'agenthub') &&
        !seededPullProjectsRef.current.has(p.id),
    );
    if (pullProjects.length === 0) return;
    pullProjects.forEach((p: any) => seededPullProjectsRef.current.add(p.id));
    let cancelled = false;
    Promise.all(
      pullProjects.map((p: any) =>
        api
          .getProjectPulls(p.id, { state: 'open', limit: 100 })
          .then((data: any) => [p.id, Array.isArray(data?.pulls) ? data.pulls.length : 0])
          .catch(() => [p.id, 0]),
      ),
    ).then((entries: any) => {
      if (cancelled) return;
      setOpenPullCounts((prev: any) => {
        const next = { ...prev };
        for (const [pid, count] of entries) {
          if (next[pid] === undefined) next[pid] = count;
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [projects]);

  const activeAgent =
    agents.find((a: any) => a.id === activeAgentId) ||
    (hubAgent && hubAgent.id === activeAgentId ? hubAgent : undefined);

  const workflowEditRoute = useMemo(() => parseWorkflowEditView(currentView), [currentView]);

  const projectMenuRoute = useMemo(() => {
    if (currentView.startsWith('project-agents:')) {
      return { tab: 'agents', projectId: currentView.slice('project-agents:'.length) };
    }
    if (currentView.startsWith('project-background-agents:')) {
      return {
        tab: 'background-agents',
        projectId: currentView.slice('project-background-agents:'.length),
      };
    }
    if (currentView.startsWith('project-settings:')) {
      return { tab: 'settings', projectId: currentView.slice('project-settings:'.length) };
    }
    if (currentView.startsWith('project-crons:')) {
      return { tab: 'crons', projectId: currentView.slice('project-crons:'.length) };
    }
    return null;
  }, [currentView]);

  useEffect(() => {
    const projectId = currentView.startsWith('workflows:')
      ? currentView.slice('workflows:'.length)
      : workflowEditRoute?.projectId;
    if (!projectId) return;
    setWorkflowSidebarBadgeByProject((prev: any) => {
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

  // Legacy `/skills` route — global skills moved to Settings → Global Skills.
  useEffect(() => {
    if (currentView === 'skills') setCurrentView('settings:global-skills');
  }, [currentView]);

  const navigateFromProjectWorkflows = useCallback((view: any, extra: any) => {
    if (extra?.expandProjectId) {
      setCurrentView(`project-settings:${extra.expandProjectId}`);
      return;
    }
    setCurrentView(view);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadModelConfig = () => {
      api
        .getModelConfig()
        .then((cfg: any) => {
          if (!cancelled) setModelConfig(cfg);
        })
        .catch((err: any) => {
          console.warn('[modelConfig] GET /api/config/models failed:', err?.message || err);
        });
    };
    loadModelConfig();
    const onEngineAuthChanged = () => loadModelConfig();
    window.addEventListener('agent-hub:engine-auth-changed', onEngineAuthChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('agent-hub:engine-auth-changed', onEngineAuthChanged);
    };
  }, []);

  // Auto-scroll — instant snap to the tail while following (streaming uses the same path).
  // Stops auto-scrolling when the user scrolls away from the bottom past the threshold.
  const initialScrollRef = useRef(true);
  const isNearBottomRef = useRef(true);
  // Last scrollTop seen by the scroll handler — lets it detect upward scrolls so
  // a deliberate scroll-up breaks tail-follow even inside the near-bottom band
  // (otherwise a live-growing block like the Finalize "Checks" block re-pins to
  // the bottom on every poll and the user can't scroll up past it). Kept in sync
  // after each programmatic pin so the next user scroll compares against the
  // real resting position.
  const lastScrollTopRef = useRef(0);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  // Tracks whether a programmatic scroll is in progress so we don't
  // interpret the resulting scroll events as the user scrolling away.
  const programmaticScrollRef = useRef(false);

  const checkNearBottom = useCallback(() => isNearBottom(scrollContainerRef.current), []);

  // Reverse infinite scroll: fetch the next older page (keyed off the oldest
  // loaded message id), prepend it, and restore the viewport so the messages
  // the user was reading don't jump.
  const loadOlderMessages = useCallback(() => {
    if (loadingOlderRef.current || !olderHasMoreRef.current) return;
    const sid = activeSessionIdRef.current;
    if (!sid) return;
    const loaded = messagesRef.current;
    const oldest = loaded[0];
    if (!oldest?.id) return;
    const el = scrollContainerRef.current;
    // Anchor against the current scroll position; the layout effect keyed on
    // `messages` reads this back and offsets scrollTop by the height added.
    prependRestoreRef.current = {
      prevScrollHeight: el ? el.scrollHeight : 0,
      prevScrollTop: el ? el.scrollTop : 0,
    };
    loadingOlderRef.current = true;
    setLoadingOlderMessages(true);
    api
      .getMessages(sid, { limit: MESSAGES_PAGE_SIZE, before: oldest.id })
      .then((older: any) => {
        if (activeSessionIdRef.current !== sid) {
          prependRestoreRef.current = null;
          return;
        }
        const page = Array.isArray(older) ? older : [];
        olderHasMoreRef.current = inferHasMore(page.length);
        setMessages((prev: any) => {
          const { messages: next, addedCount } = prependOlderMessages(prev, page);
          if (addedCount === 0) {
            // Nothing new to render — drop the anchor so no scroll restore runs.
            prependRestoreRef.current = null;
          }
          return next;
        });
      })
      .catch(() => {
        prependRestoreRef.current = null;
      })
      .finally(() => {
        loadingOlderRef.current = false;
        setLoadingOlderMessages(false);
      });
  }, []);

  const handleScrollEvent = useCallback(() => {
    // Ignore scroll events caused by our own programmatic scrolling —
    // these would otherwise flip isNearBottomRef to false mid-animation
    // and break auto-follow.
    if (programmaticScrollRef.current) return;
    const el = scrollContainerRef.current;
    // Near the top with older history available → pull the next older page.
    if (
      el &&
      shouldLoadOlder({
        scrollTop: el.scrollTop,
        hasMore: olderHasMoreRef.current,
        loading: loadingOlderRef.current,
      })
    ) {
      loadOlderMessages();
    }
    const nearBottom = checkNearBottom();
    // An upward user scroll breaks follow immediately — even within the
    // near-bottom band — so a live-growing block (Finalize CI checks) can't
    // yank the viewport back to the tail while the user reads earlier messages.
    const following = el
      ? shouldFollowTailAfterScroll({
          prevScrollTop: lastScrollTopRef.current,
          scrollTop: el.scrollTop,
          nearBottom,
        })
      : nearBottom;
    if (el) lastScrollTopRef.current = el.scrollTop;
    isNearBottomRef.current = following;
    setShowScrollBtn(!following);
  }, [checkNearBottom, loadOlderMessages]);

  /** Snap to the tail. Always instant — smooth scroll cannot keep up with streaming tokens. */
  const scrollToBottom = useCallback(() => {
    pinChatToBottom(scrollContainerRef.current, {
      beginProgrammatic: () => {
        programmaticScrollRef.current = true;
      },
      // Re-arm follow synchronously so a streaming token arriving on the next
      // tick keeps pinning instead of pushing the viewport back below the fold.
      armFollow: (scrollTop: number) => {
        lastScrollTopRef.current = scrollTop;
        isNearBottomRef.current = true;
        setShowScrollBtn(false);
      },
      endProgrammatic: () => {
        programmaticScrollRef.current = false;
      },
    });
  }, []);

  const scrollToTimelineAnchor = useCallback((anchorId: string) => {
    const container = scrollContainerRef.current;
    if (!container || !anchorId) return;
    isNearBottomRef.current = false;
    setShowScrollBtn(true);
    setSelectedTimelineAnchor(anchorId);
    // Let blocks that collapse content (review file groups) expand the group
    // owning this anchor first, so the scroll target is actually in the DOM.
    try {
      window.dispatchEvent(
        new CustomEvent(TIMELINE_ANCHOR_NAVIGATE_EVENT, { detail: { anchorId } }),
      );
    } catch {
      /* CustomEvent unavailable */
    }
    const escaped =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(anchorId)
        : anchorId.replace(/"/g, '\\"');
    const selector = `[data-timeline-anchor="${escaped}"]`;
    // A just-expanded group renders on the next frame; retry a few frames.
    let attempts = 0;
    const tryScroll = () => {
      const target = container.querySelector(selector);
      if (target) {
        target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        return;
      }
      if (attempts++ < 5 && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(tryScroll);
      }
    };
    tryScroll();
  }, []);

  useEffect(() => {
    streamingMsgIdRef.current = streamingMsgId;
  }, [streamingMsgId]);

  const pinChatTail = useCallback((messageId: any) => {
    isNearBottomRef.current = true;
    setShowScrollBtn(false);
    const el = scrollContainerRef.current;
    forcePinChatTailScroll(el, (container: any) => {
      programmaticScrollRef.current = true;
      container.scrollTop = container.scrollHeight;
      lastScrollTopRef.current = container.scrollTop;
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
    });
    if (messageId && el) {
      const root = [...el.querySelectorAll('[data-message-id]')].find(
        (node: any) => node.getAttribute('data-message-id') === messageId,
      );
      const anchor = root?.querySelector('[data-testid="session-tail-bottom"]');
      anchor?.scrollIntoView?.({ block: 'end' });
    }
  }, []);

  // Reset follow state when switching sessions (must run before the scroll layout effect below).
  useLayoutEffect(() => {
    initialScrollRef.current = true;
    isNearBottomRef.current = true;
    lastScrollTopRef.current = 0;
    setShowScrollBtn(false);
    setSelectedTimelineAnchor(null);
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

  // After an older page is prepended, restore the scroll position so the
  // viewport stays anchored on the messages the user was reading instead of
  // jumping as content is inserted above. Runs last (after the tail-pin effect
  // above, which is a no-op while scrolled up).
  useLayoutEffect(() => {
    const restore = prependRestoreRef.current;
    if (!restore) return;
    prependRestoreRef.current = null;
    const el = scrollContainerRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTop = restoredScrollTop({
      prevScrollTop: restore.prevScrollTop,
      prevScrollHeight: restore.prevScrollHeight,
      newScrollHeight: el.scrollHeight,
    });
    lastScrollTopRef.current = el.scrollTop;
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, [messages]);

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
        lastScrollTopRef.current = el.scrollTop;
        requestAnimationFrame(() => {
          programmaticScrollRef.current = false;
          isNearBottomRef.current = true;
          setShowScrollBtn(false);
        });
      },
    });
  }, [activeSessionId]);

  const refreshAgents = useCallback(() => {
    api.getProjects().then((data: any) => {
      setProjects(data);
      const flat = data.flatMap((p: any) =>
        p.agents.map((a: any) => ({
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
      // Tag these arrays with the agent they were loaded for so the per-agent
      // cache warm-up writes them under the right id (not a since-switched one).
      setLoadedSessionsAgentId(agentId);
      setLoadedArchivedAgentId(agentId);

      setChangesReady((prev: any) => {
        const next = { ...prev };
        const alive = new Set(data.map((x: any) => x.id));
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

      setFinalizeStatusBySession((prev: any) => {
        const next = { ...prev };
        const alive = new Set(data.map((x: any) => x.id));
        for (const k of Object.keys(next)) {
          if (!alive.has(k)) delete next[k];
        }
        for (const s of data) {
          if (s.finalize_status) next[s.id] = s.finalize_status;
          else delete next[s.id];
        }
        return next;
      });

      const cur = activeSessionIdRef.current;
      if (cur && !data.some((s: any) => s.id === cur)) {
        const target = data[0];
        if (target) {
          setActiveSessionId(target.id);
          const ag = agentsRef.current.find((a: any) => a.id === agentId);
          setSessionEngine(target.engine || ag?.engine || 'claude-code');
          setSessionModel(
            target.model ||
              modelConfig?.engineDefaultModels?.[target.engine || ag?.engine || 'claude-code'] ||
              'claude-opus-5',
          );
          setSessionConsultMode(isSessionConsultModeEnabled(target));
        } else {
          setActiveSessionId(null);
          setMessages([]);
          const fallbackEngine =
            agentsRef.current.find((a: any) => a.id === agentId)?.engine || 'claude-code';
          setSessionEngine(fallbackEngine);
          setSessionModel(modelConfig?.engineDefaultModels?.[fallbackEngine] || 'claude-opus-5');
          setSessionConsultMode(false);
        }
      }
    } catch (err: any) {
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

  /**
   * Order-safe refresher for the "Changes" toolbar badge. Refetches the
   * changed-file count for a session and updates the badge independently of
   * the diff pane being open, so the count stays live as the agent edits
   * files — driven by `code_changed` (first dirty), turn-`done` (final
   * tally), and session activation — instead of only appearing after a click.
   *
   * Built once via a ref so its per-session sequence guard (which discards
   * out-of-order/stale responses so the badge can't regress) survives
   * rerenders. It only touches module-level connection helpers and a state
   * setter, so it is safe to call from the WS handler closure without
   * staleness.
   */
  const diffFileCountRefresherRef = useRef<any>(null);
  if (!diffFileCountRefresherRef.current) {
    diffFileCountRefresherRef.current = createDiffFileCountRefresher({
      fetchCount: async (sessionId: any) => {
        const res = await fetch(`${getApiBase()}/sessions/${sessionId}/changes`, {
          headers: getAuthHeaders(),
        });
        if (!res.ok) return null;
        const body = await res.json();
        return fileCountFromChangesSummary(body);
      },
      applyCount: (sessionId: any, count: any) =>
        setDiffFileCountBySession((prev: any) => setSessionFileCount(prev, sessionId, count)),
    });
  }
  const refreshDiffFileCount = useCallback(
    (sessionId: any) => diffFileCountRefresherRef.current(sessionId),
    [],
  );

  /** Bump a session's diff-pane reload token so an open Changes pane refetches. */
  const bumpDiffReloadToken = useCallback((sessionId: any) => {
    if (!sessionId) return;
    setCodeChangedTickBySession((prev: any) => ({
      ...prev,
      [sessionId]: (prev[sessionId] || 0) + 1,
    }));
  }, []);

  /**
   * On session activation (switch or page reload), seed the Changes badge for
   * worktree sessions that may already have committed/uncommitted changes, so
   * the count shows without first opening the diff pane. `lastCountedSessionRef`
   * keeps this to one fetch per activation even though the effect re-runs as
   * the `sessions` array mutates during streaming. The re-run also covers the
   * race where `activeSessionId` resolves before `sessions` has loaded.
   *
   * The "already counted" mark is only set once we actually seed a count
   * (i.e. after the worktree check passes). If the activated session is still
   * a placeholder/stale row without worktree fields, we leave it unmarked so a
   * later `sessions` update that fills in `use_worktree` / `worktree_branch`
   * re-runs this effect and seeds the badge then.
   */
  const lastCountedSessionRef = useRef<any>(null);
  useEffect(() => {
    if (!activeSessionId) return;
    if (lastCountedSessionRef.current === activeSessionId) return;
    const session = sessions.find((s: any) => s.id === activeSessionId);
    if (!session) return; // sessions not loaded yet — effect re-runs when they are
    if (!isWorktreeSession(session)) return; // not countable yet — re-check on later updates
    lastCountedSessionRef.current = activeSessionId;
    refreshDiffFileCount(activeSessionId);
  }, [activeSessionId, sessions, refreshDiffFileCount]);

  // WebSocket handler
  const reloadActiveAgentSkills = useCallback(() => {
    const agentId = activeAgentIdRef.current;
    if (!agentId || !projectDataReady) return;
    api
      .getSkills(agentId)
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [projectDataReady]);

  const handleWsMessage = useCallback(
    (data: any) => {
      // Is this event for the session the user is currently viewing?
      const forActiveSession = data.sessionId && data.sessionId === activeSessionIdRef.current;
      // 'message' events use message.session_id rather than top-level sessionId.
      const msgForActiveSession = data.message?.session_id === activeSessionIdRef.current;

      switch (data.type) {
        case 'active-tasks-snapshot': {
          // Rebuild active-task map from server snapshot.
          const next: Record<string, any> = {};
          for (const t of data.tasks || []) {
            next[t.sessionId] = {
              messageId: t.messageId,
              agentId: t.agentId || null,
              content: t.content || '',
              engine: t.engine || null,
              model: t.model || null,
            };
          }
          setActiveTasks(next);
          // Authoritative in BOTH directions — a session absent from the
          // snapshot has no live run, so clear rather than leave the previous
          // streaming state standing.
          const streaming = resolveStreamingFromSnapshot(next, activeSessionIdRef.current);
          if (streaming) {
            if (!streaming.streamingMsgId) pinChatTail(streamingMsgIdRef.current);
            setStreamingMsgId(streaming.streamingMsgId);
            setStreamingContent(streaming.streamingContent);
            setStreamingEngine(streaming.streamingEngine);
            setThinking(streaming.thinking);
            setStreamingAgent(
              buildStreamingAgentState(
                {
                  agentId: streaming.agentId,
                  engine: streaming.streamingEngine,
                  model: streaming.streamingModel,
                },
                agentsRef.current,
              ),
            );
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
          setAwaitingInputBySession((current: any) => applyAwaitingInputEvent(current, data));
          if (
            data.waiting &&
            !isSessionOwnedByOtherUser(data.ownerUserId) &&
            shouldNotifyForAwaitingInput({
              wasWaiting,
              sessionId: sid,
              activeSessionId: activeSessionIdRef.current,
            })
          ) {
            const session = sessionsRef.current.find((s: any) => s.id === sid);
            const agent = agentsRef.current.find(
              (a: any) => a.id === (data.agentId || session?.agent_id),
            );
            const askCount = Array.isArray(data.askIds) ? data.askIds.length : 1;
            const { title, body } = awaitingInputNotification({
              agentName: agent?.name,
              sessionName: session?.name || data.sessionName,
              askCount,
            });
            setToasts((toasts: any) => [
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
            const msg = data.message;
            const appendable =
              msg.role === 'user' ||
              msg.role === 'system' ||
              (msg.role === 'assistant' && msg.agent_id);
            if (appendable) {
              setMessages((prev: any) => {
                if (prev.some((m: any) => m.id === msg.id)) return prev;
                return [...prev, msg];
              });
              if (msg.role === 'assistant' && msg.agent_id) {
                // Advisor turn — executor messages arrive on `done` instead.
                setThinking(false);
                setStreamingContent('');
                setStreamingMsgId(null);
                setStreamingEngine(null);
                setStreamingAgent(null);
              }
              if (msg.role === 'system') {
                notifyFinalizeRunFromTimelineMessage(msg);
              }
            }
          }
          break;
        case 'thinking':
          if (data.sessionId) {
            setReactLoopStepsBySession((prev: any) => ({ ...prev, [data.sessionId]: [] }));
          }
          // Always track the task; only update the visible indicator if it's our session.
          setActiveTasks((prev: any) => ({
            ...prev,
            [data.sessionId]: {
              messageId: data.messageId,
              content: '',
              engine: data.engine || null,
              model: data.model || null,
              agentId: data.agentId || null,
            },
          }));
          if (forActiveSession) {
            setThinking(true);
            setStreamingMsgId(data.messageId);
            setStreamingEngine(data.engine || null);
            setStreamingContent('');
            setStreamingAgent(
              buildStreamingAgentState(
                {
                  agentId: data.agentId,
                  agentName: data.agentName,
                  agentColor: data.agentColor,
                  engine: data.engine,
                  model: data.model,
                },
                agentsRef.current,
              ),
            );
          }
          break;
        case 'stream':
          setActiveTasks((prev: any) => ({
            ...prev,
            [data.sessionId]: {
              ...(prev[data.sessionId] || {}),
              messageId: data.messageId,
              content: data.content,
              engine: data.engine || prev[data.sessionId]?.engine || null,
              model: data.model || prev[data.sessionId]?.model || null,
              agentId: data.agentId || prev[data.sessionId]?.agentId || null,
            },
          }));
          if (forActiveSession) {
            setThinking(false);
            setStreamingContent(data.content);
            if (data.engine) setStreamingEngine(data.engine);
            setStreamingAgent(
              (prev: any) =>
                buildStreamingAgentState(
                  {
                    agentId: data.agentId,
                    agentName: data.agentName,
                    agentColor: data.agentColor,
                    engine: data.engine,
                    model: data.model,
                  },
                  agentsRef.current,
                  prev,
                ) || prev,
            );
          }
          break;
        case 'session-event': {
          // Append a single event to the message's timeline. Dedup by seq in case
          // a reconnect causes the server to replay something we already have.
          // The common case is strictly increasing seq, so fast-path the append.
          const { messageId, seq, event } = data;
          if (!messageId) break;
          // Keep the server's wall clock alongside the event: it is the anchor
          // a relative tool arg needs to become an absolute time (ScheduleWakeup's
          // `delaySeconds`). Older servers omit it — fall back to receive time.
          const timestamp = data.timestamp || new Date().toISOString();
          setEventsByMessage((prev: any) => {
            const existing = prev[messageId] || [];
            const last = existing[existing.length - 1];
            if (!last || last.seq < seq) {
              return { ...prev, [messageId]: [...existing, { seq, event, timestamp }] };
            }
            if (existing.some((e: any) => e.seq === seq)) return prev;
            const next = [...existing, { seq, event, timestamp }].sort(
              (a: any, b: any) => a.seq - b.seq,
            );
            return { ...prev, [messageId]: next };
          });

          // Track subagent spawns and completions per session
          if (event?.type === 'tool_use' && (event.tool === 'Task' || event.tool === 'Agent')) {
            const sid = data.sessionId;
            setSubagents((prev: any) => {
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
            setSubagents((prev: any) => {
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
            setThrottle((prev: any) => ({
              ...prev,
              [sid]: { active: true, retryAfterMs: retryMs, ts: Date.now() },
            }));
            // Auto-clear throttle indicator after retry period elapses
            setTimeout(() => {
              setThrottle((prev: any) => {
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
          setSessionProgress((prev: any) => ({
            ...prev,
            [sid]: mergeProgressEvent(prev[sid] || [], {
              step: data.step,
              status: data.status,
              startedAt: data.startedAt,
              finishedAt: data.finishedAt ?? undefined,
              detail: data.detail ?? undefined,
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
          setReactLoopStepsBySession((prev: any) => {
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
          setBrowserScreensBySession((prev: any) =>
            mergeBrowserActivityScreenshot(prev, sid, mid, aid, screenshotDataUrl),
          );
          break;
        }
        case 'done':
          setActiveTasks((prev: any) => {
            const next = { ...prev };
            delete next[data.sessionId];
            return next;
          });
          // Clear throttle state for completed session
          setThrottle((prev: any) => {
            if (!prev[data.sessionId]) return prev;
            const next = { ...prev };
            delete next[data.sessionId];
            return next;
          });
          // Clear subagent tracking for completed session
          setSubagents((prev: any) => {
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
              setMessages((prev: any) => {
                if (prev.some((m: any) => m.id === data.message.id)) return prev;
                return [...prev, data.message];
              });
            }
          }
          // Desktop notification + toast for completed background sessions.
          // Scope to the session owner: on a shared project the `done` event
          // fans out to every client, so without this gate a user gets toasts
          // (that 404 on click) for another account's session. Mirrors the
          // server-side push scoping in push.ts.
          if (!forActiveSession && data.message && !isSessionOwnedByOtherUser(data.ownerUserId)) {
            const session = sessionsRef.current.find((s: any) => s.id === data.sessionId);
            const agent = session
              ? agentsRef.current.find((a: any) => a.id === session.agent_id)
              : null;
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
            setToasts((prev: any) => [
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
          // Re-tally the Changes badge at turn end (and refresh an open diff
          // pane) so it reflects every file touched during the turn — the
          // `code_changed` event only fires on the FIRST dirty transition.
          // Gated to worktree sessions inside applyDiffCountWsEffect.
          applyDiffCountWsEffect(data, {
            sessions: sessionsRef.current,
            refresh: refreshDiffFileCount,
            bumpReloadToken: bumpDiffReloadToken,
          });
          break;
        case 'changes_ready': {
          const alreadyPrompted = !!changesReadyRef.current[data.sessionId];
          setChangesReady((prev: any) => ({
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
            const session = sessionsRef.current.find((s: any) => s.id === data.sessionId);
            const agent = agentsRef.current.find((a: any) => a.id === data.agentId);
            const { title, body } = prReadyNotification({
              agentName: agent?.name,
              sessionName: session?.name,
              branch: data.branch,
            });
            setToasts((prev: any) => [
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
          setChangesReady((prev: any) => {
            if (!prev[data.sessionId]) return prev;
            const next = { ...prev };
            delete next[data.sessionId];
            return next;
          });
          if (currentViewRef.current === 'pulls') {
            setPullsListRefreshNonce((n: any) => n + 1);
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
            setToasts((prev: any) => [
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
            _setDoneVerifyLogBySession((prev: any) => {
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
            _setDoneVerifyLogBySession((prev: any) => {
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
            setMessages((prev: any) => {
              if (prev.some((m: any) => m.id === data.message.id)) return prev;
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
          setSessions((prev: any) =>
            prev.map((s: any) => (s.id === data.session.id ? { ...s, ...data.session } : s)),
          );
          if (
            data.session?.id === activeSessionIdRef.current &&
            Array.isArray(data.session.agents)
          ) {
            setSessionAgents(data.session.agents);
          }
          break;
        case 'background-shells-snapshot': {
          // Replace-the-world seed sent on connect. A background shell can run
          // for hours, so every live update during a tab sleep is gone; only a
          // full replacement can also clear sessions whose shells finished
          // while this client was away.
          setBackgroundShellsBySession(applyBackgroundShellSnapshot(data.sessions));
          setTerminalJobsBySession((prev: BackgroundShellsBySession) =>
            applyTerminalJobSnapshot(prev, data.sessions),
          );
          break;
        }
        case 'background_shell_update': {
          setBackgroundShellsBySession((prev: BackgroundShellsBySession) =>
            applyBackgroundShellUpdate(prev, data.shell),
          );
          setTerminalJobsBySession((prev: BackgroundShellsBySession) =>
            applyTerminalJobUpdate(prev, data.shell),
          );
          if (shouldFocusTerminalJob(data.shell)) {
            const sid = data.shell.session_id;
            setTerminalPaneOpenBySession((prev: Record<string, boolean>) => ({
              ...prev,
              [sid]: true,
            }));
            setDiffPaneOpenBySession((prev: Record<string, boolean>) => ({
              ...prev,
              [sid]: false,
            }));
            setArtifactsPaneOpenBySession((prev: Record<string, boolean>) => ({
              ...prev,
              [sid]: false,
            }));
            setTerminalActiveTabBySession((prev: Record<string, string>) => ({
              ...prev,
              [sid]: data.shell.id,
            }));
          }
          break;
        }
        case 'background_shell_log': {
          setBackgroundShellLogsBySession((prev: Record<string, Record<string, string>>) =>
            applyBackgroundShellLog(prev, data),
          );
          break;
        }
        case 'session_state': {
          // Server-side lifecycle cache push. Keep the session row seed current
          // so late terminal states (pushed / merged) update immediately even
          // when no independent client-side signal map changes.
          const sid = data.sessionId;
          if (!sid || typeof data.state !== 'string') break;
          const current = sessionsByIdRef.current.get(sid);
          if (current) {
            sessionsByIdRef.current.set(sid, { ...current, state: data.state });
            setSessionsIndexTick((t: any) => t + 1);
          }
          setSessions((prev: any) =>
            prev.map((s: any) => (s.id === sid ? { ...s, state: data.state } : s)),
          );
          setCronSessions((prev: any) =>
            prev.map((s: any) => (s.id === sid ? { ...s, state: data.state } : s)),
          );
          break;
        }
        case 'session-worktree-detected':
          // Worktree-only mode: keep the session-row flag in sync for any
          // debugging surfaces / future tooling, but the user-facing
          // detection badge was removed.
          setSessions((prev: any) =>
            prev.map((s: any) =>
              s.id === data.sessionId
                ? { ...s, git_worktree_detected: data.gitWorktree ? 1 : 0 }
                : s,
            ),
          );
          break;
        case 'worktree_failed': {
          const sid = data.sessionId;
          if (!sid) break;
          setSessions((prev: any) =>
            prev.map((s: any) => (s.id === sid ? { ...s, use_worktree: 0 } : s)),
          );
          if (sid === activeSessionIdRef.current && data.error) {
            showToast(`Worktree creation failed: ${data.error}`, 'warning', 8000);
          }
          break;
        }
        case 'error':
          if (data.sessionId) {
            setActiveTasks((prev: any) => {
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
              setMessages((prev: any) => [
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
          setAwaitingInputBySession((prev: any) =>
            clearAwaitingInputForSession(prev, data.sessionId),
          );
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
            setDesigns((prev: any) => {
              if (prev.some((d: any) => d.id === data.design.id)) return prev;
              return [data.design, ...prev];
            });
          }
          break;
        case 'design_deleted':
          setDesigns((prev: any) => prev.filter((d: any) => d.id !== data.designId));
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
            setDesignReloadToken((t: any) => t + 1);
            setDesignStreaming(null);
            setDesignThinking(false);
            setDesignProcessing(false);
          }
          // If the active chat session embeds this design as a live preview
          // pane, refresh that iframe too so edits show up without leaving chat.
          if (data.designId && data.designId === activeSessionLinkedDesignIdRef.current) {
            setSessionDesignReloadToken((t: any) => t + 1);
          }
          // Also refresh design row metadata (updated_at) in the list.
          setDesigns((prev: any) =>
            prev.map((d: any) =>
              d.id === data.designId ? { ...d, updated_at: new Date().toISOString() } : d,
            ),
          );
          break;
        case 'design_metadata_updated':
          if (data.design?.id) {
            setDesigns((prev: any) =>
              prev.map((d: any) => (d.id === data.design.id ? { ...d, ...data.design } : d)),
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
            setDesignMessages((prev: any) => {
              if (prev.some((m: any) => m.id === msg.id)) {
                return prev.map((m: any) => (m.id === msg.id ? msg : m));
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
            setDelegations((prev: any) => ({
              ...prev,
              [data.sessionId]: {
                parentMessageId: data.parentMessageId,
                tasks: data.tasks.map((t: any) => ({
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
            setDelegationDispatchErrors((prev: any) => {
              if (!prev[data.sessionId]) return prev;
              const next = { ...prev };
              delete next[data.sessionId];
              return next;
            });
          }
          break;
        case 'delegation_thinking':
          if (data.sessionId === activeSessionIdRef.current) {
            setDelegations((prev: any) => {
              const existing = prev[data.sessionId];
              if (!existing) return prev;
              return {
                ...prev,
                [data.sessionId]: {
                  ...existing,
                  tasks: existing.tasks.map((t: any) =>
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
            setDelegations((prev: any) => {
              const existing = prev[data.sessionId];
              if (!existing) return prev;
              return {
                ...prev,
                [data.sessionId]: {
                  ...existing,
                  tasks: existing.tasks.map((t: any) =>
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
            setDelegations((prev: any) => {
              const existing = prev[data.sessionId];
              if (!existing) return prev;
              return {
                ...prev,
                [data.sessionId]: {
                  ...existing,
                  tasks: existing.tasks.map((t: any) =>
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
            setDelegations((prev: any) => {
              const existing = prev[data.sessionId];
              if (!existing) return prev;
              return {
                ...prev,
                [data.sessionId]: {
                  ...existing,
                  tasks: existing.tasks.map((t: any) =>
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
            setDelegations((prev: any) => {
              const existing = prev[data.sessionId];
              if (!existing) return prev;
              return {
                ...prev,
                [data.sessionId]: {
                  ...existing,
                  tasks: existing.tasks.map((t: any) =>
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
            setToasts((prev: any) => [
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
            setDelegationDispatchErrors((prev: any) => ({
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
            setDelegationDispatchErrors((prev: any) => ({
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
          setToasts((prev: any) => [...prev, toast]);
          break;
        }
        case 'analyze-progress':
        case 'analyze-complete':
        case 'analyze-error':
          window.dispatchEvent(new CustomEvent('analyze-ws', { detail: data }));
          break;
        case 'log_issue_action':
          // Logs issue detail owns the project-scoped action state. Forward the
          // event without putting log-derived text into the global app store.
          window.dispatchEvent(new CustomEvent('agenthub:log_issue_action', { detail: data }));
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
        case 'initial_build_started':
          window.dispatchEvent(new CustomEvent('initial-build-ws', { detail: data }));
          break;
        // AI-assisted Dev Server (prEnv.devServer) setup wizard. The route
        // spawns a session (`dev_server_wizard_started`) and the skill pings
        // the completion endpoint after persisting config + secrets
        // (`dev_server_wizard_complete`). DevServerSection listens for the
        // completion event to reload the saved config.
        case 'dev_server_wizard_started':
          window.dispatchEvent(
            new CustomEvent('agenthub:dev_server_wizard_started', { detail: data }),
          );
          break;
        case 'dev_server_wizard_complete':
          window.dispatchEvent(
            new CustomEvent('agenthub:dev_server_wizard_complete', { detail: data }),
          );
          break;
        // AI-assisted Finalize Code Changes ci.yaml setup wizard.
        // `finalize_wizard_started` fires on POST .../finalize/setup-wizard;
        // `finalize_wizard_complete` after the skill calls wizard-complete.
        // FinalizeSettingsSection listens for the completion event to
        // refetch state.
        case 'finalize_wizard_started':
          window.dispatchEvent(
            new CustomEvent('agenthub:finalize_wizard_started', { detail: data }),
          );
          break;
        case 'finalize_wizard_complete':
          window.dispatchEvent(
            new CustomEvent('agenthub:finalize_wizard_complete', { detail: data }),
          );
          break;
        case 'deploy_wizard_started':
          window.dispatchEvent(new CustomEvent('agenthub:deploy_wizard_started', { detail: data }));
          break;
        case 'workflow_run':
        case 'workflow_run_status':
        case 'workflow_update':
          if (data.projectId) {
            setWorkflowSidebarBadgeByProject((prev: any) => ({ ...prev, [data.projectId]: true }));
            window.dispatchEvent(new CustomEvent('agenthub-workflow-ws', { detail: data }));
          }
          break;
        case 'task_complete': {
          const taskStatus = data.status === 'done' ? 'success' : 'error';
          const taskMsg =
            data.status === 'done'
              ? `Background task completed${data.preview ? ': ' + data.preview.substring(0, 80) + '...' : ''}`
              : 'Background task failed';
          setToasts((prev: any) => [
            ...prev,
            {
              id: `task-${data.taskId}-${Date.now()}`,
              type: taskStatus,
              message: taskMsg,
              duration: 10000,
              onClick: data.sessionId
                ? () => {
                    const row = sessionsRef.current.find((s: any) => s.id === data.sessionId);
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
          setMessageQueues((prev: any) => ({
            ...prev,
            [data.sessionId]: data.queue,
          }));
          break;

        case 'queue_item_processing':
          // Mark the queued message as no longer queued (it's being processed now).
          // The 'thinking' event that follows will handle the processing indicator.
          setMessageQueues((prev: any) => {
            const q = (prev[data.sessionId] || []).filter((m: any) => m.id !== data.messageId);
            return { ...prev, [data.sessionId]: q };
          });
          break;

        case 'queue_item_edited':
          // Update the message content in local state to reflect the edit
          setMessages((prev: any) =>
            prev.map((m: any) => (m.id === data.messageId ? { ...m, content: data.content } : m)),
          );
          break;

        case 'cron_session_update':
          api
            .getCronSessions()
            .then(setCronSessions)
            .catch(() => {});
          break;

        case 'kanban_update':
          if (kanbanEventTargetsProject(data.projectId, kanbanContextProjectIdRef.current)) {
            kanbanRefreshScheduler.schedule();
          }
          if (
            data.projectId &&
            pullsProjectIdRef.current === data.projectId &&
            currentViewRef.current === 'pulls'
          ) {
            setPullsListRefreshNonce((n: any) => n + 1);
          }
          if (data.projectId) refreshOpenPullCount(data.projectId);
          // A security scan's only WebSocket signal is kanban_update. Keep the
          // open Security view live (refetch via the nonce) and refresh the
          // affected project's open-severity counts for the sidebar badge.
          if (data.projectId) {
            if (
              securityProjectIdRef.current === data.projectId &&
              currentViewRef.current === 'security'
            ) {
              setSecurityRefreshNonce((n: any) => n + 1);
            } else {
              refreshSecurityOpenCounts(data.projectId);
            }
          }
          break;

        case 'native_pr_update':
          // Native PR changed (opened/edited/reviewed/commented/merged/…) —
          // keep the Pulls page live without a manual refresh.
          if (
            data.projectId &&
            pullsProjectIdRef.current === data.projectId &&
            currentViewRef.current === 'pulls'
          ) {
            setPullsListRefreshNonce((n: any) => n + 1);
          }
          if (data.projectId) refreshOpenPullCount(data.projectId);
          break;

        case 'projects_updated':
          // Server added/changed an agent or project (e.g. GitHub App auto-setup
          // seeded a Reviewer agent). Re-fetch so the sidebar reflects it
          // without requiring a page refresh.
          refreshAgents();
          break;

        case 'skills_update': {
          // Project/global skill install/update/delete — refresh slash-command
          // autocomplete for the active agent when the change applies.
          const payload = data.payload || {};
          const agentId = activeAgentIdRef.current;
          if (!agentId) break;
          if (payload.projectId) {
            const agent = agentsRef.current.find((a: any) => a.id === agentId);
            if (agent?.projectId !== payload.projectId) break;
          }
          reloadActiveAgentSkills();
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
          setToasts((prev: any) => [...prev, toast]);
          notify({ title: 'Dispatch Failure', body: dispatchMsg, type: 'error' });
          // The linked card's kanban_update carries the project id and is
          // enough to refresh the board after the failure comment lands.
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
            setToasts((prev: any) => [
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
            setToasts((prev: any) => [
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

        // ── Thread notifications ─────────────────────────────────
        case 'thread_created': {
          if (isRetiredHeartbeatThread(data.thread)) break;
          // Live-update ThreadList if viewing threads for this project
          if (threadListRef.current && threadsProjectIdRef.current === data.projectId) {
            threadListRef.current.addThread(data.thread);
          }
          const { title, body } = threadCreatedNotification({
            threadName: data.thread.name,
            threadType: data.thread.type,
          });
          setToasts((prev: any) => [
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
          if (isRetiredHeartbeatThread({ type: data.threadType })) break;
          const isError = data.entry?.content?.startsWith('ERROR:');
          // Live-update ThreadView if viewing this thread
          if (threadViewRef.current && activeThreadIdRef.current === data.threadId) {
            threadViewRef.current.addEntry(data.entry);
          } else {
            // Increment unread count for the project (we need to find it from data)
            // The broadcast includes threadId — look up the project via thread cache
            // For simplicity, increment for all projects that have threads view open or track globally
            setUnreadThreadCounts((prev: any) => {
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
            setToasts((prev: any) => [
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

        // ── Support ticket queue ─────────────────────────────────
        case 'support_ticket_created': {
          if (data.projectId && typeof data.unreadCount === 'number') {
            setUnreadTicketCounts((prev: any) => ({ ...prev, [data.projectId]: data.unreadCount }));
          }
          if (supportListRef.current && supportProjectIdRef.current === data.ticket?.project_id) {
            supportListRef.current.addTicket(data.ticket);
          }
          break;
        }
        case 'support_ticket_updated': {
          if (data.projectId && typeof data.unreadCount === 'number') {
            setUnreadTicketCounts((prev: any) => ({ ...prev, [data.projectId]: data.unreadCount }));
          }
          if (supportListRef.current && supportProjectIdRef.current === data.ticket?.project_id) {
            supportListRef.current.updateTicket(data.ticket);
          }
          break;
        }
        case 'support_ticket_deleted': {
          if (data.projectId && typeof data.unreadCount === 'number') {
            setUnreadTicketCounts((prev: any) => ({ ...prev, [data.projectId]: data.unreadCount }));
          }
          if (supportListRef.current && supportProjectIdRef.current === data.projectId) {
            supportListRef.current.removeTicket(data.ticketId);
          }
          break;
        }
        case 'support_ticket_vote_updated': {
          window.dispatchEvent(new CustomEvent('agenthub-support-ticket-vote', { detail: data }));
          break;
        }
        case 'support_tickets_read_all': {
          if (data.projectId) {
            setUnreadTicketCounts((prev: any) => ({ ...prev, [data.projectId]: 0 }));
          }
          if (supportListRef.current && supportProjectIdRef.current === data.projectId) {
            supportListRef.current.markAllRead?.();
          }
          break;
        }

        case 'deployment_update':
          window.dispatchEvent(new CustomEvent('agenthub-deployment-ws', { detail: data }));
          break;

        // Release notification delivery state (queued/sent/failed) for a
        // deployment. Bridged to a window CustomEvent so the Deployments page
        // updates the notification history live without a refetch.
        case 'release_notification_update':
          window.dispatchEvent(
            new CustomEvent('agenthub-release-notification-ws', { detail: data }),
          );
          break;

        case 'skill_improvement_update':
          // Skills page listens for this to live-refresh pending-lesson
          // badges and the review panel (same pattern as wiki_update).
          window.dispatchEvent(new CustomEvent('skill_improvement_update', { detail: data }));
          // Also refresh the Skills sidebar badge for the affected project so a
          // captured/approved/rejected lesson updates the pending tally live.
          if (data?.projectId) refreshSkillImprovementCount(data.projectId);
          break;

        case 'wiki_update':
          window.dispatchEvent(new CustomEvent('wiki_update', { detail: data }));
          break;

        // Cross-project personal todos (spec TODO-MODEL). The server filters this
        // event to the owner, so any delivery means *our* todos changed (a
        // create/update/delete/reorder, or a promote-to-ticket). Bridged to a
        // window CustomEvent so <TodosPage /> refetches without subscribing to
        // the WS connection directly.
        case 'user_todo_update':
          window.dispatchEvent(new CustomEvent('user_todo_update', { detail: data }));
          break;

        // GitHub mirror sync status (server/git-host/mirror.ts +
        // reconcile.ts). Bridged to a window CustomEvent so
        // <GitHostMirrorStatusBanner /> refreshes the moment the background
        // reconcile poller acts (pulled / diverged / synced / error)
        // without subscribing to the WS connection directly.
        case 'git_host_mirror':
          window.dispatchEvent(new CustomEvent('git_host_mirror', { detail: data }));
          break;

        case 'wiki_delete':
          window.dispatchEvent(new CustomEvent('wiki_delete', { detail: data }));
          break;

        // An AWS Health event arrived at the ingest route (server/infra
        // health-event-notifications.ts). Bridged to a window CustomEvent so
        // <InfraHealthTimeline /> refreshes the moment AWS pushes an outage
        // rather than on its next poll, without subscribing to the WS directly.
        // The broadcast fans out to every client, so the listener filters by
        // projectId before refetching.
        case 'infra_health_event':
          window.dispatchEvent(new CustomEvent('infra_health_event', { detail: data }));
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
          // Live PR checks: CI runs (pr_push / push) broadcast these as
          // jobs progress — refresh the Pulls page so check rows update
          // in real time without a manual refresh.
          if (
            currentViewRef.current === 'pulls' &&
            data.type !== 'finalize_run_active_seconds' // seconds tick is noise
          ) {
            setPullsListRefreshNonce((n: any) => n + 1);
          }
          // Keep the sidebar "ready to push" indicator live. Only the
          // phase-change / completed events carry a status worth mirroring;
          // they include session_id (see orchestrator.ts ready_to_push emit).
          if (
            data.session_id &&
            typeof data.status === 'string' &&
            (data.type === 'finalize_run_phase_changed' || data.type === 'finalize_run_completed')
          ) {
            setFinalizeStatusBySession((prev: any) => {
              // A single-phase run parks at `ready_to_push` but is NOT fully
              // validated (orchestrator sends `validated: false`). Don't light
              // the sidebar "ready to push" indicator until both phases pass —
              // store an inert phase marker instead so the green check waits.
              const incoming =
                data.status === 'ready_to_push' && data.validated === false
                  ? 'phase_passed'
                  : data.status;
              if (prev[data.session_id] === incoming) return prev;
              return { ...prev, [data.session_id]: incoming };
            });
          }
          window.dispatchEvent(new CustomEvent(data.type, { detail: data }));
          break;

        case 'lead_review':
          setActiveReviews((prev: any) => ({
            ...prev,
            [data.reviewerAgent]: {
              prUrl: data.prUrl,
              cardTitle: data.cardTitle,
              sessionId: data.sessionId,
            },
          }));
          break;

        case 'lead_review_complete':
          setActiveReviews((prev: any) => {
            const next = { ...prev };
            // Remove by matching agentId — the lead_review event uses agent name as key, but we also check by agentId
            for (const [key, val] of Object.entries(next)) {
              if ((val as any).sessionId === data.sessionId) delete next[key];
            }
            return next;
          });
          break;

        case 'session_created': {
          // Triggered spawn (Resolve PR, security fix, kanban assign,
          // autonomous dispatch) and another tab's POST /sessions. Splice
          // into the live list when it belongs to the loaded agent, and
          // into any already-fetched per-agent sidebar cache. Do not
          // invent a cache for an agent that has never been fetched.
          const row = data.session;
          const agentId = data.agentId || row?.agent_id;
          if (row?.id) {
            sessionsByIdRef.current.set(row.id, row);
            setSessionsIndexTick((t: any) => t + 1);
          }
          if (row && agentId) {
            // Functional setters + eager ref writes: two session_created
            // events before paint must compose. Planning only from
            // sessionsRef / sessionsByAgentIdRef then setState(plan) loses
            // the first row — those refs do not advance until the next
            // render, so the second plan starts from the same arrays.
            setSessions((prev: any) => {
              const next = planRemoteSessionCreatedCaches({
                targetAgentId: agentId,
                loadedSessionsAgentId: loadedSessionsAgentIdRef.current,
                session: row,
                sessionsByAgentId: sessionsByAgentIdRef.current,
                sessions: prev,
              }).sessions;
              sessionsRef.current = next;
              return next;
            });
            setSessionsByAgentId((prev: any) => {
              const next = planRemoteSessionCreatedCaches({
                targetAgentId: agentId,
                loadedSessionsAgentId: loadedSessionsAgentIdRef.current,
                session: row,
                sessionsByAgentId: prev,
                sessions: sessionsRef.current,
              }).sessionsByAgentId;
              sessionsByAgentIdRef.current = next;
              return next;
            });
          }
          break;
        }

        case 'session_workspace_ready': {
          const row = data.session;
          const sid = data.sessionId || row?.id;
          if (!sid || !row) break;
          setSessions((prev: any) => prev.map((s: any) => (s.id === sid ? row : s)));
          setWorkspaceEnsuringBySession((prev: any) => {
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
          setSessions((prev: any) => prev.filter((s: any) => s.id !== data.sessionId));
          // Drop any awaiting-input flag — the session is gone, so an
          // indicator pointing at it would dangle.
          setAwaitingInputBySession((prev: any) =>
            clearAwaitingInputForSession(prev, data.sessionId),
          );
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
          setArchivedSessions((prev: any) => prev.filter((s: any) => s.id !== restoredId));
          if (data.session && data.session.agent_id === activeAgentIdRef.current) {
            setSessions((prev: any) => {
              if (prev.some((s: any) => s.id === restoredId)) return prev;
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
            setSessionHandoffs((prev: any) => {
              if (prev.some((h: any) => h.id === data.handoffId)) return prev;
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
            setSessions((prev: any) => {
              if (prev.some((s: any) => s.id === newSession.id)) return prev;
              return [newSession, ...prev];
            });
          }
          break;
        }

        case 'code_changed': {
          const sid = data.sessionId;
          if (!sid || !sessionsRef.current.some((s: any) => s.id === sid)) break;
          // Bump the open-pane reload token AND refresh the closed-pane badge
          // count so it appears live (no click required) the moment files
          // change on the first dirty transition.
          applyDiffCountWsEffect(data, {
            sessions: sessionsRef.current,
            refresh: refreshDiffFileCount,
            bumpReloadToken: bumpDiffReloadToken,
          });
          const previewKind = previewEventBySessionRef.current[sid]?.kind;
          if (previewKind !== 'preview' && sid === activeSessionIdRef.current) {
            setPreviewPaneOpenBySession((prev: any) => ({ ...prev, [sid]: true }));
            showToast(
              'Code updated. Use Start preview below when you want to load the app (only you can start the preview server).',
              'info',
              9000,
            );
          }
          break;
        }

        case 'artifact_created':
        case 'artifact_deleted': {
          const sid = data.sessionId;
          if (!sid || !sessionsRef.current.some((s: any) => s.id === sid)) break;
          // Keep an open pane live (it reloads and reports the authoritative
          // count via onCount). For the closed-pane badge we reconcile to the
          // server's post-mutation count carried on the event rather than
          // blindly +/-1 — otherwise the client that performed a local delete
          // (which already set the count) would decrement a second time on its
          // own broadcast and drift. `data.count` absent (version skew) → leave
          // the badge as-is and let the next pane open recount.
          setArtifactTickBySession((prev: any) => ({ ...prev, [sid]: (prev[sid] || 0) + 1 }));
          if (typeof data.count === 'number') {
            const next = Math.max(0, data.count);
            setArtifactCountBySession((prev: any) =>
              prev[sid] === next ? prev : { ...prev, [sid]: next },
            );
          }
          if (data.type === 'artifact_created' && sid === activeSessionIdRef.current) {
            const name = data.artifact?.filename;
            const autoPresent = shouldAutoPresentArtifact(data, activeSessionIdRef.current);
            if (autoPresent) {
              setPresentedArtifactBySession((prev: any) => ({
                ...prev,
                [sid]: data.artifact,
              }));
              setArtifactsPaneOpenBySession((prev: any) => ({ ...prev, [sid]: true }));
              setDiffPaneOpenBySession((prev: any) => ({ ...prev, [sid]: false }));
              setTerminalPaneOpenBySession((prev: any) => ({ ...prev, [sid]: false }));
            }
            showToast(
              name
                ? `${autoPresent ? 'Opened' : 'New'} artifact: ${name}`
                : 'The agent generated a new artifact.',
              'info',
              7000,
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
          if (!sessionsRef.current.some((s: any) => s.id === sid)) break;
          if (data.kind === 'preview_refresh') {
            setPreviewEventBySession((prev: any) => {
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
            setPreviewEventBySession((prev: any) => {
              if (!prev[sid]) return prev;
              const next = { ...prev };
              delete next[sid];
              return next;
            });
            setPreviewStartingBySession((prev: any) => {
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
            setPreviewEventBySession((prev: any) => {
              const last = prev[sid];
              if (!last || last.kind === 'preview_stopped') return prev;
              const logTail = appendPreviewLogTail(last.logTail, data.line);
              return { ...prev, [sid]: { ...last, logTail } };
            });
            break;
          }
          setPreviewEventBySession((prev: any) => {
            const last = prev[sid];
            const logTail = mergePreviewEventLogTail(data.logTail, last?.logTail);
            return { ...prev, [sid]: { ...data, logTail } };
          });
          setPreviewStartingBySession((prev: any) => {
            if (!prev[sid]) return prev;
            const next = { ...prev };
            delete next[sid];
            return next;
          });
          setPreviewPaneOpenBySession((prev: any) => {
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
            setSessionHandoffs((prev: any) => {
              const existing = prev.find((h: any) => h.id === data.handoffId);
              if (existing) {
                return prev.map((h: any) =>
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
    [
      notify,
      refreshAgents,
      reloadActiveAgentSkills,
      showToast,
      pinChatTail,
      refreshDiffFileCount,
      bumpDiffReloadToken,
      refreshSecurityOpenCounts,
      refreshOpenPullCount,
      kanbanRefreshScheduler,
    ],
  );

  const { send, connected, reconnecting, wsRef } = useWebSocket(handleWsMessage);

  // Reconcile streamed-only state (e.g. the finalize run in `useFinalizeRun`)
  // after a mid-session WS drop by fanning out `agenthub:ws_reconnected`.
  useWsReconnectBroadcast(connected);

  const handleCancel = useCallback(() => {
    if (activeSessionId) {
      const tailId = streamingMsgIdRef.current;
      pinChatTail(tailId);
      send({ type: 'cancel', sessionId: activeSessionId });
      setThinking(false);
      setStreamingContent('');
      setStreamingMsgId(null);
      setStreamingEngine(null);
      setStreamingAgent(null);
    }
  }, [activeSessionId, send, pinChatTail]);

  // Called by SessionTail after it lazy-fetches historical events for a
  // legacy message. Hoists them into the shared map so subsequent renders
  // don't refetch.
  const handleEventsLoaded = useCallback((messageId: any, events: any) => {
    setEventsByMessage((prev: any) => {
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
      // SetupWizard triggers, in priority order:
      //
      //   1. **Onboarding incomplete** (Owner / local-bundled / first Owner
      //      only). `onboardingComplete: false` (or `authConfigured: false`
      //      on legacy servers that omit the new field). Owner creation
      //      alone is not enough — password managers can interrupt after
      //      `/api/auth/setup` and leave the user in the main chrome stuck
      //      on WebSocket "Reconnecting…". Resume the wizard from the
      //      Hub-account step (or Welcome if Owner exists). Invited
      //      Admin/User members skip this — POST /api/setup/complete is
      //      Owner-only and 403s for them.
      //   2. **No AI credentials.** Anyone with zero usable AI engines —
      //      land on the credentials step. Non-Owners omit First Project.
      //   3. **First run.** Brand-new install with no projects yet after
      //      onboarding — open the adaptive project wizard.
      try {
        const statusRes = await fetch(`${getApiBase()}/setup/status`, {
          headers: getAuthHeaders(),
          signal: AbortSignal.timeout(10000),
        });
        const status = await statusRes.json();
        setSetupStatus(status);
        const presentation = resolveSetupWizardPresentation(status, {
          canCompleteOnboarding: canCompleteInstanceOnboarding(),
          hasOrgs: !!getOrgs(),
        });
        if (presentation.show) {
          setSetupInitialStep(
            presentation.initialStepKey ? stepIndexForKey(status, presentation.initialStepKey) : 1,
          );
          setSetupIncludeFirstProject(presentation.includeFirstProject);
          setShowSetup(true);
          // A leftover `#/new-project-adaptive` hash (common after an
          // interrupted first-run that briefly opened the project picker)
          // must not render on top of the SetupWizard.
          setCurrentView('chat');
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
        const flat = data.flatMap((p: any) =>
          p.agents.map((a: any) => ({
            ...a,
            projectId: p.id,
            projectName: p.name,
            cwd: p.cwd,
            ahw: p.ahw,
          })),
        );
        setAgents(flat);
        const storedId = localStorage.getItem('activeAgentId');
        const storedAgentExists = storedId && flat.some((a: any) => a.id === storedId);
        if (storedAgentExists) {
          setActiveAgentId(storedId);
        } else if (flat.length > 0) {
          setActiveAgentId(flat[0].id);
        }
      } catch (err: any) {
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
      .then((rows: any) => {
        if (cancelled) return;
        setArchivedSessions(Array.isArray(rows) ? rows : []);
        setLoadedArchivedAgentId(agentId);
      })
      .catch(() => {
        if (cancelled) return;
        setArchivedSessions([]);
        setLoadedArchivedAgentId(agentId);
      });

    api
      .getSessions(agentId)
      .then(async (data: any) => {
        if (cancelled) return;
        setSessions(data);
        setLoadedSessionsAgentId(agentId);

        // Hydrate changesReady from persisted session data so the PR button
        // survives page refreshes and WebSocket reconnects.
        const persisted: Record<string, any> = {};
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
          setChangesReady((prev: any) => ({ ...prev, ...persisted }));
        }

        // Hydrate finalize status so the sidebar "ready to push" indicator
        // survives page refreshes and WebSocket reconnects.
        const finalizeStatuses: Record<string, any> = {};
        for (const s of data) {
          if (s.finalize_status) finalizeStatuses[s.id] = s.finalize_status;
        }
        if (Object.keys(finalizeStatuses).length > 0) {
          setFinalizeStatusBySession((prev: any) => ({ ...prev, ...finalizeStatuses }));
        }

        // If we were explicitly navigated to a specific session (e.g. from kanban
        // assign), honour that session ID. Otherwise try to restore the last
        // session the user had open for this agent (persisted in localStorage on
        // every `activeSessionId` change). Fall back to `data[0]` (newest by
        // `updated_at`) only when neither is available — this is what used to
        // surface as "Claude lost my session" after an Electron reload, because
        // `data[0]` could be an unrelated cron/heartbeat row.
        // Once the Hub GET has resolved a live Hub session, that session owns the
        // active chat while the Hub is focused. A late project-agent session
        // restore (from init's setActiveAgentId(flat[0])) must not stomp it, or
        // the assistant composer would lock (activeSessionId !== hubSessionId)
        // until the user clicks a pane. The Hub is also reached via the legacy
        // views (home/dashboard/todos/calendar/gmail), which applyNavigationState
        // leaves as currentView='dashboard' etc. rather than normalizing to
        // 'hub' — treat those as Hub too. Only guard once a Hub session exists;
        // before it resolves, normal restore must still run.
        const onHubSurface =
          currentViewRef.current === 'hub' || !!hubPaneFromLegacyView(currentViewRef.current);
        if (onHubSurface && hubSessionIdRef.current && agentId !== HUB_ASSISTANT_AGENT_ID) {
          return;
        }

        let remembered = null;
        try {
          const key = `activeSessionId:${agentId}`;
          const stored = localStorage.getItem(key);
          if (stored) remembered = data.find((s: any) => s.id === stored) || null;
        } catch {
          /* storage disabled — ignore */
        }
        const { target: fallbackTarget, deepLinkFetchId } = resolveDeepLinkTarget(
          data,
          targetSessionId,
          remembered,
        );
        let target = fallbackTarget;
        // Deep-linked to a session the owner-only list omits (e.g. a dashboard
        // admin click-through into another user's session). Fetch it by id —
        // the server read-gate lets org admins view it — and select it instead
        // of snapping back to one of the caller's own sessions. Falls back to
        // `fallbackTarget` when the read is denied (non-admin caller).
        if (deepLinkFetchId) {
          const foreign = await api.getSession(deepLinkFetchId).catch(() => null);
          if (cancelled) return;
          if (foreign?.id) {
            // Merge the single fetched row so `sessions.find(activeSessionId)`
            // resolves its engine/model/reasoning-effort and the top bar shows
            // its title. This surfaces exactly one foreign row — the session the
            // user explicitly opened — in an otherwise owner-only sidebar; it is
            // not enumeration (the list endpoint is still owner-only). Writes to
            // it are rejected server-side (owner-only `userOwnsSession`), so the
            // view stays read-only regardless of what the composer renders.
            setSessions((prev: any) => upsertSessionRow(prev, foreign));
            target = foreign;
          }
        }

        if (target) {
          setActiveSessionId(target.id);
          const ag = agents.find((a: any) => a.id === agentId);
          setSessionEngine(target.engine || ag?.engine || 'claude-code');
          setSessionModel(
            target.model ||
              modelConfig?.engineDefaultModels?.[target.engine || ag?.engine || 'claude-code'] ||
              'claude-opus-5',
          );
          setSessionConsultMode(isSessionConsultModeEnabled(target));
        } else {
          setActiveSessionId(null);
          setMessages([]);
          const fallbackEngine = agents.find((a: any) => a.id === agentId)?.engine || 'claude-code';
          setSessionEngine(fallbackEngine);
          setSessionModel(modelConfig?.engineDefaultModels?.[fallbackEngine] || 'claude-opus-5');
          setSessionConsultMode(false);
        }
      })
      .catch((err: any) => {
        if (cancelled) return;
        console.error('[Sessions] Failed to load sessions:', err);
        setSessions([]);
        setLoadedSessionsAgentId(agentId);
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

  // Load skills for slash-command autocomplete when agent changes or chat opens
  useEffect(() => {
    if (!activeAgentId) {
      setSkills([]);
      return;
    }
    if (!projectDataReady) {
      setSkills([]);
      return;
    }
    reloadActiveAgentSkills();
  }, [activeAgentId, projectDataReady, reloadActiveAgentSkills]);

  useEffect(() => {
    if (currentView === 'chat') {
      reloadActiveAgentSkills();
    }
  }, [currentView, reloadActiveAgentSkills]);

  // Update session engine/model when session changes
  useEffect(() => {
    if (!activeSessionId) return;
    const session = sessions.find((s: any) => s.id === activeSessionId);
    if (session?.engine) {
      setSessionEngine(session.engine);
    }
    if (session?.model) {
      setSessionModel(session.model);
    }
    // NULL/legacy/non-Codex rows default to 'high' (matches the server resolver).
    setSessionReasoningEffort(session?.reasoning_effort === 'pro' ? 'pro' : 'high');
    setSessionConsultMode(isSessionConsultModeEnabled(session));
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
        setSessions((prev: any) =>
          prev.map((s: any) =>
            s.id === updatedEngine.id ? { ...s, engine: updatedEngine.engine } : s,
          ),
        );
        const modelUpdated = await api.setSessionModel(sid, defaultModel);
        if (cancelled || activeSessionIdRef.current !== sid) return;
        setSessions((prev: any) =>
          prev.map((s: any) =>
            s.id === modelUpdated.id ? { ...s, model: modelUpdated.model } : s,
          ),
        );
      } catch (err: any) {
        console.warn('[modelConfig] Failed to migrate session off unauthenticated engine:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modelConfig, activeSessionId, sessionEngine, sessions]);

  // Load messages when session changes — clear immediately so the chat column
  // never briefly shows the previous session's transcript on the new id. Only
  // the newest page is fetched up front; older messages load on scroll-up
  // (reverse infinite scroll), so a huge post-finalize transcript no longer
  // streams the whole history on every session open.
  useEffect(() => {
    // Reset the older-message window for the new session.
    prependRestoreRef.current = null;
    loadingOlderRef.current = false;
    refreshingNewestMessagesRef.current = false;
    setLoadingOlderMessages(false);
    olderHasMoreRef.current = false;
    if (!activeSessionId) {
      setMessages([]);
      setSessionMessagesLoading(false);
      return;
    }
    setMessages([]);
    setSessionMessagesLoading(true);
    let cancelled = false;
    const loadInitialMessages = async () => {
      const firstRows = await api.getMessages(activeSessionId, { limit: MESSAGES_PAGE_SIZE });
      let page = Array.isArray(firstRows) ? firstRows : [];
      let hasMore = inferHasMore(page.length);
      const sessionRow = sessionsByIdRef.current.get(activeSessionId);
      const finalizeStatus =
        finalizeStatusBySessionRef.current[activeSessionId] ?? sessionRow?.finalize_status ?? null;

      for (
        let olderPagesLoaded = 0;
        shouldBackfillFinalizeChecksTimeline({
          messages: page,
          finalizeStatus,
          hasMore,
          olderPagesLoaded,
        });
        olderPagesLoaded += 1
      ) {
        if (cancelled) break;
        const oldest = page[0];
        if (!oldest?.id) break;
        const olderRows = await api.getMessages(activeSessionId, {
          limit: MESSAGES_PAGE_SIZE,
          before: oldest.id,
        });
        const olderPage = Array.isArray(olderRows) ? olderRows : [];
        hasMore = inferHasMore(olderPage.length);
        page = prependOlderMessages(page, olderPage).messages;
      }

      return { page, hasMore };
    };

    loadInitialMessages()
      .then(({ page, hasMore }: any) => {
        if (cancelled) return;
        setMessages(page);
        // A full page implies older messages exist above the loaded window.
        olderHasMoreRef.current = hasMore;
        setSessionMessagesLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setMessages([]);
        olderHasMoreRef.current = false;
        setSessionMessagesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  useEffect(() => {
    const refreshNewestMessages = () => {
      const sid = activeSessionIdRef.current;
      if (!sid || refreshingNewestMessagesRef.current) return;
      refreshingNewestMessagesRef.current = true;
      api
        .getMessages(sid, { limit: MESSAGES_PAGE_SIZE })
        .then((rows: any) => {
          if (activeSessionIdRef.current !== sid) return;
          const page = Array.isArray(rows) ? rows : [];
          setMessages((prev: any) => mergeNewestMessages(prev, page).messages);
          if (page.length > 0) {
            olderHasMoreRef.current = inferHasMore(page.length);
          }
        })
        .catch(() => {
          // Best-effort reconnect repair. The next reconnect or session switch
          // will try again; existing transcript state remains visible.
        })
        .finally(() => {
          if (activeSessionIdRef.current === sid) {
            refreshingNewestMessagesRef.current = false;
          }
        });
    };

    window.addEventListener('agenthub:ws_reconnected', refreshNewestMessages);
    return () => {
      window.removeEventListener('agenthub:ws_reconnected', refreshNewestMessages);
    };
  }, []);

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
      .then((rows: any) => {
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
      .then((rows: any) => {
        if (cancelled) return;
        const hydrated = mapDelegationRowsToLiveShape(rows);
        if (!hydrated) return;
        setDelegations((prev: any) => {
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
    (targetAgentId: any, targetSessionId: any) => {
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
    (agentId: any, sessionId: any) => {
      if (!sessionId) return;
      const row =
        sessionsRef.current.find((x: any) => x.id === sessionId) ??
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

  useEffect(() => {
    if (currentView !== 'hub' && !hubPaneFromLegacyView(currentView)) return;
    let cancelled = false;
    const req = api.getHubSession();
    req
      .then((body: any) => {
        if (cancelled) return;
        const session = body?.session;
        const agent = body?.agent;
        if (agent) setHubAgent(agent);
        if (session?.id) {
          setHubSessionId(session.id);
          pendingSessionIdRef.current = session.id;
          if (agent?.id) setActiveAgentId(agent.id);
          setActiveSessionId(session.id);
          if (session.engine) setSessionEngine(session.engine);
          if (session.model) setSessionModel(session.model);
        }
      })
      .catch(() => {
        // Hub assistant is unavailable; workspace panes still render. Leave
        // hubSessionId null so the assistant composer stays locked rather than
        // sending into whatever project session happens to be active.
        setHubSessionId(null);
      });
    return () => {
      cancelled = true;
    };
    // Fetch the Hub session once per Hub visit — NOT on pane/tab switches.
    // Depending on hubPane / hubMobileTab re-ran this on every Dashboard→Org
    // switch and re-stamped agent/session/engine/model, clobbering an in-flight
    // composer model persist. currentView flips only on entering/leaving Hub.
  }, [currentView, setActiveAgentId]);

  // Keep the active agent aligned with the open session's owner (cross-project switches).
  useLayoutEffect(() => {
    if (!activeSessionId) return;
    const row =
      sessions.find((s: any) => s.id === activeSessionId) ??
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
      .then((res: any) => {
        if (cancelled || !res || !Array.isArray(res.steps)) return;
        if (res.steps.length === 0) return;
        setSessionProgress((prev: any) => ({ ...prev, [activeSessionId]: res.steps }));
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
      setStreamingAgent(null);
      return;
    }
    const t = activeTasks[activeSessionId];
    if (t) {
      setStreamingMsgId(t.messageId);
      setStreamingContent(t.content);
      setStreamingEngine(t.engine);
      setThinking(!t.content);
      setStreamingAgent(
        buildStreamingAgentState(
          {
            agentId: t.agentId,
            engine: t.engine,
            model: t.model,
          },
          agentsRef.current,
        ),
      );
    } else {
      setThinking(false);
      setStreamingContent('');
      setStreamingMsgId(null);
      setStreamingEngine(null);
      setStreamingAgent(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only on session change; `activeTasks` updates stream case-by-case
  }, [activeSessionId]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: any) => {
      // Ctrl+K: agent switcher
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setShowSwitcher((prev: any) => !prev);
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
      .then((detail: any) => {
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

  const handleSessionAgentsUpdated = useCallback((detail: any) => {
    if (!detail?.id) return;
    setSessionAgents(detail.agents || []);
    setSessions((prev: any) =>
      prev.map((s: any) => (s.id === detail.id ? { ...s, ...detail } : s)),
    );
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
    setPreviewPaneOpenBySession((prev: any) => ({
      ...prev,
      [activeSessionId]: false,
    }));
    // X means "clear the column". The footer Terminal tab shares
    // `terminalRequested` with the full-size pane — leave it set and
    // closing a ready preview immediately expands that 600px pane.
    setTerminalPaneOpenBySession((prev: any) =>
      prev[activeSessionId] === true ? { ...prev, [activeSessionId]: false } : prev,
    );
    try {
      const key = paneOpenStorageKey(activeSessionId);
      if (key) window.localStorage.setItem(key, 'false');
    } catch {
      /* storage unavailable */
    }
  }, [activeSessionId, setPreviewPaneOpenBySession]);

  const handlePreviewTouch = useCallback(async ({ previewId }: any) => {
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

  const clearSessionPreviewUi = useCallback((sessionId: any) => {
    if (!sessionId) return;
    clearSessionPreviewStorage(sessionId);
    setPreviewEventBySession((prev: any) => {
      if (!prev[sessionId]) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setPreviewPaneOpenBySession((prev: any) => {
      if (!prev[sessionId]) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setPreviewStartingBySession((prev: any) => {
      if (!prev[sessionId]) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  const stopSessionPreviewRuntime = useCallback(async (sessionId: any) => {
    if (!sessionId) return;
    try {
      await fetch(`${getApiBase()}/sessions/${encodeURIComponent(sessionId)}/preview/stop`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
    } catch {
      /* ignore */
    }
  }, []);

  const handlePreviewStop = useCallback(
    async ({ sessionId }: any) => {
      if (!sessionId) return;
      previewUserStoppedBySessionRef.current[sessionId] = true;
      await stopSessionPreviewRuntime(sessionId);
      clearSessionPreviewUi(sessionId);
    },
    [stopSessionPreviewRuntime, clearSessionPreviewUi],
  );

  const tearDownSessionPreview = useCallback(
    (sessionId: any) => {
      if (!sessionId) return;
      previewUserStoppedBySessionRef.current[sessionId] = true;
      void stopSessionPreviewRuntime(sessionId);
      clearSessionPreviewUi(sessionId);
    },
    [stopSessionPreviewRuntime, clearSessionPreviewUi],
  );

  tearDownSessionPreviewRef.current = tearDownSessionPreview;

  // Declared ahead of `handlePreviewConfigure` (which closes over it) so the
  // ref binding is initialized before any consumer can reference it.
  // `.current` is kept in sync once `activeChatProject` is computed below.
  const activeChatProjectRef = useRef<any>(null);

  const handlePreviewConfigure = useCallback(
    (event: any) => {
      const projectId = event?.wizard?.projectId || activeChatProjectRef.current?.id;
      // The dev-server settings view is the only place a preview is configured.
      setCurrentView(projectId ? `devserver:${projectId}` : 'settings');
    },
    [setCurrentView],
  );

  const handleStartSessionPreview = useCallback(
    async (sessionId: any, mode: 'rebuild' | 'restart-server' = 'rebuild') => {
      if (!sessionId) return;
      // Bump the start generation so any /preview/state poll still in
      // flight for the PREVIOUS run is discarded on arrival rather than
      // clobbering this fresh (re)start — the synthetic seed below has no
      // previewId to match on.
      previewStartSeqRef.current[sessionId] = (previewStartSeqRef.current[sessionId] || 0) + 1;
      // Drop any prior run's event so the synthetic `preview_starting`
      // seed becomes the authoritative current state for this (re)start.
      // Without this, a leftover terminal event (e.g. the previous run's
      // `ready`) keeps masking the seed in `activePreviewEvent` — the pane
      // shows the stale preview, the hydration effect's deps don't change
      // so it never reschedules, and `resolvePreviewHydration` reads the
      // stale event as "current" and can't converge the new run.
      setPreviewEventBySession((prev: any) => {
        if (!prev[sessionId]) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      setPreviewStartingBySession((prev: any) => ({ ...prev, [sessionId]: true }));
      setPreviewPaneOpenBySession((prev: any) => ({ ...prev, [sessionId]: true }));
      try {
        const key = paneOpenStorageKey(sessionId);
        if (key) window.localStorage.setItem(key, 'true');
      } catch {
        /* storage unavailable */
      }
      try {
        await api.startSessionPreview(sessionId, { mode });
        // Keep `previewStartingBySession` until a WS `agenthub_preview` event
        // arrives — boot can take minutes (clone + compose build).
      } catch (err: any) {
        setPreviewStartingBySession((prev: any) => {
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
      sessions.find((s: any) => s.id === activeSessionId) ??
      (activeSessionId ? sessionsByIdRef.current.get(activeSessionId) : null);
    const agentId = row?.agent_id ?? activeAgentId;
    const agent = agents.find((a: any) => a.id === agentId);
    return projects.find((p: any) => p.id === agent?.projectId) ?? null;
  }, [sessions, activeSessionId, activeAgentId, agents, projects, sessionsIndexTick]);

  activeChatProjectRef.current = activeChatProject;

  // Stable refresh used by the per-project Runners/Preview views so the
  // child sections don't re-subscribe their effects on every App render.
  const refreshProjects = useCallback(
    () =>
      api
        .getProjects()
        .then((data: any) => setProjects(data))
        .catch(() => undefined),
    [],
  );

  // Single-project arrays for the `runners:`/`devserver:` views, memoized so
  // the prop reference only changes when the project list or active view does.
  const runnersScopedProjects = useMemo(() => {
    if (!currentView.startsWith('runners:')) return [];
    const id = currentView.slice('runners:'.length);
    return projects.filter((p: any) => p.id === id);
  }, [currentView, projects]);

  const statsScopedProjects = useMemo(() => {
    if (!currentView.startsWith('stats:')) return [];
    const id = currentView.slice('stats:'.length);
    return projects.filter((p: any) => p.id === id);
  }, [currentView, projects]);

  const devServerScopedProjects = useMemo(() => {
    if (!currentView.startsWith('devserver:')) return [];
    const id = currentView.slice('devserver:'.length);
    return projects.filter((p: any) => p.id === id);
  }, [currentView, projects]);

  const rumScopedProjects = useMemo(() => {
    if (!currentView.startsWith('rum:')) return [];
    const id = currentView.slice('rum:'.length);
    return projects.filter((p: any) => p.id === id);
  }, [currentView, projects]);

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
  // The Changes / Artifacts / full-size Terminal panes share the right-hand
  // slot with preview and are mutually exclusive — except that a running
  // preview keeps the iframe and hosts the terminal in its footer tabs
  // (Boot log | Terminal) instead of yielding the slot.
  const previewEligible = shouldShowSessionPreviewPane({
    activeSessionId,
    project: activeChatProject,
    activePreviewEvent,
    paneOpenBySession: previewPaneOpenBySession,
  });
  const terminalRequested =
    !!activeSessionId && terminalPaneOpenBySession[activeSessionId] === true;
  const {
    showSessionTerminalPane,
    showSessionDiffPane,
    showSessionArtifactsPane,
    showSessionPreviewPane,
    footerTab: previewFooterTab,
  } = resolveSessionRightPaneFlags({
    previewEligible,
    previewKind: activePreviewEvent?.kind,
    terminalRequested,
    diffRequested: !!activeSessionId && diffPaneOpenBySession[activeSessionId] === true,
    artifactsRequested: !!activeSessionId && artifactsPaneOpenBySession[activeSessionId] === true,
  });
  const showSessionTimeline =
    !!activeSessionId &&
    (timelinePaneOpenBySession[activeSessionId] ?? readTimelinePaneOpen(activeSessionId)) === true;
  const timelineMarkerCount = useMemo(
    () => deriveSessionTimelineMarkers({ messages }).length,
    [messages],
  );

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
    setDesignReloadToken((t: any) => t + 1);
    const designId = activeDesignId;
    api
      .getDesign(designId)
      .then((detail: any) => {
        if (!detail) return;
        setDesigns((prev: any) => {
          const existing = prev.find((d: any) => d.id === detail.id);
          return existing
            ? prev.map((d: any) => (d.id === detail.id ? { ...d, ...detail } : d))
            : prev;
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
      .then((status: any) => {
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

  const activeDesign = designs.find((d: any) => d.id === activeDesignId);

  // If the open design has been migrated to a design-mode session (e.g. the
  // importer ran while it was open, or it was opened by a stale deep link),
  // redirect to that session instead of rendering the read-only canvas.
  useEffect(() => {
    if (currentView !== 'design') return;
    const redirect = resolveDesignRedirect(activeDesign);
    if (redirect) {
      focusAgentSession(undefined, redirect.sessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView, activeDesign?.id, activeDesign?.imported_session_id]);

  const loadSidebarAgentSessions = useCallback(
    async (agentId: any) => {
      if (!agentId) return;
      // The live and archived caches are populated independently (warm-up,
      // `insertCreatedSession`, the agent-switch fetch). Guard each side on its
      // OWN cache so a pre-populated live list never suppresses the archived
      // fetch — otherwise an agent's recoverable/archived sessions stay hidden
      // when its session list was warmed first.
      const needSessions = !sessionsByAgentId[agentId];
      const needArchived = !archivedSessionsByAgentId[agentId];
      if (!needSessions && !needArchived) return;
      try {
        const [data, archived] = await Promise.all([
          needSessions ? api.getSessions(agentId) : Promise.resolve(null),
          needArchived ? api.getArchivedSessions(agentId) : Promise.resolve(null),
        ]);
        if (needSessions) {
          setSessionsByAgentId((prev: any) => ({
            ...prev,
            [agentId]: Array.isArray(data) ? data : [],
          }));
        }
        if (needArchived) {
          setArchivedSessionsByAgentId((prev: any) => ({
            ...prev,
            [agentId]: Array.isArray(archived) ? archived : [],
          }));
        }
      } catch (err: any) {
        console.error('[Sidebar] Failed to load sessions for agent:', agentId, err);
      }
    },
    [sessionsByAgentId, archivedSessionsByAgentId],
  );

  const handleNewSession = async (agentIdOverride?: any) => {
    const agentId = agentIdOverride || activeAgentId;
    if (!agentId) return;
    const agent = agents.find((a: any) => a.id === agentId);
    if (agent?.role === 'reviewer') {
      showToast(
        'Reviewer agents only run from the Finalize review phase — sessions cannot be started manually.',
        'info',
        4000,
      );
      return;
    }
    const session = await api.createSession(agentId, undefined, {
      consultMode: agentId === activeAgentId ? sessionConsultMode : false,
    });
    insertCreatedSession(agentId, session);
    // Pin the agent-change sessions-load effect to the session we just made.
    // A cross-project focus that targeted the already-active agent parks a
    // session id in pendingSessionIdRef without changing activeAgentId, so the
    // load effect never re-runs to consume it. Left in place, that stale foreign
    // id becomes this agent's deep-link target, gets fetched cross-project via
    // api.getSession, and surfaces the other project's session instead of the
    // empty new one — the "+ New Session opens an existing session in the wrong
    // project" bug. Every sibling navigator (focusAgentSession,
    // handleOpenHandoffSession, the hub loader) sets this for the same reason.
    pendingSessionIdRef.current = session.id;
    setActiveAgentId(agentId);
    setActiveSessionId(session.id);
    setSessionEngine(session.engine || agent?.engine || 'claude-code');
    setSessionModel(
      session.model ||
        modelConfig?.engineDefaultModels?.[session.engine || agent?.engine || 'claude-code'] ||
        'claude-opus-5',
    );
    setSessionConsultMode(isSessionConsultModeEnabled(session));
    setMessages([]);
    setCurrentView('chat');
  };

  // Start chat in Skill Builder mode for a project (replaces the legacy Skill Builder agent).
  const handleStartSkillBuilderMode = useCallback(
    async (projectId: any) => {
      // Skill Builder is a DEV-agent mode. Only a non-helper agent gets the
      // builder prompt/role; helper agents (skill-builder/reviewer/docs) must
      // NOT be silently used as a fallback — running the builder on a docs or
      // reviewer agent would apply the wrong prompt/role. Reject helper-only
      // (or empty) rosters instead of falling back to inProject[0].
      const pickAgent = () =>
        agents.find(
          (a: any) =>
            a.projectId === projectId &&
            a.active !== false &&
            a.role !== 'skill-builder' &&
            a.role !== 'reviewer' &&
            a.role !== 'docs',
        );
      const agent = pickAgent();
      if (!agent) {
        showToast(
          'Skill Builder needs a dev agent — this project has no eligible agent.',
          'error',
          4000,
        );
        return;
      }
      try {
        const session = await api.createSession(agent.id, '[Skill Builder]');
        const updated = await api.updateSession(session.id, {
          session_mode: 'skill-builder',
          ask_mode: false,
          finalize_automation: 'manual',
        });
        setActiveAgentId(agent.id);
        insertCreatedSession(agent.id, updated);
        setActiveSessionId(updated.id);
        setSessionEngine(updated.engine || agent.engine || 'claude-code');
        setSessionModel(
          updated.model ||
            modelConfig?.engineDefaultModels?.[updated.engine || agent.engine || 'claude-code'] ||
            'claude-opus-5',
        );
        setSessionConsultMode(false);
        setMessages([]);
        setCurrentView('chat');
      } catch (err: any) {
        showToast(err?.message || 'Failed to start Skill Builder session', 'error', 4000);
      }
    },
    [agents, modelConfig, showToast, insertCreatedSession],
  );

  // Start a chat session with a SPECIFIC agent (not necessarily the active one)
  // and navigate into it.
  const handleStartSessionWithAgent = useCallback(
    async (agentId: any) => {
      if (!agentId) return;
      const agent = agents.find((a: any) => a.id === agentId);
      if (agent?.role === 'reviewer') {
        showToast(
          'Reviewer agents only run from the Finalize review phase — sessions cannot be started manually.',
          'info',
          4000,
        );
        return;
      }
      try {
        const session = await api.createSession(agentId, undefined, {
          consultMode: sessionConsultMode,
        });
        // Same guard as handleNewSession: pin the agent-change load effect to
        // this new session so a stale foreign id in pendingSessionIdRef can't be
        // resolved as a cross-project deep-link and surface the wrong session.
        pendingSessionIdRef.current = session.id;
        setActiveAgentId(agentId);
        insertCreatedSession(agentId, session);
        setActiveSessionId(session.id);
        setSessionEngine(session.engine || agent?.engine || 'claude-code');
        setSessionModel(
          session.model ||
            modelConfig?.engineDefaultModels?.[session.engine || agent?.engine || 'claude-code'] ||
            'claude-opus-5',
        );
        setSessionConsultMode(isSessionConsultModeEnabled(session));
        setMessages([]);
        setCurrentView('chat');
      } catch (err: any) {
        showToast(err?.message || 'Failed to start session', 'error', 4000);
      }
    },
    [agents, sessionConsultMode, modelConfig, setActiveAgentId, insertCreatedSession, showToast],
  );

  const defaultModelForEngine = useCallback(
    (engine: any) => {
      const fromConfig = modelConfig?.engineDefaultModels?.[engine];
      if (fromConfig) return fromConfig;
      const available = modelConfig?.engineValidModels?.[engine];
      if (Array.isArray(available) && available.length > 0) return available[0];
      if (engine === 'cursor-agent') return 'cursor-grok-4.6-high';
      if (engine === 'codex-cli') return 'gpt-5.6-sol';
      if (engine === 'grok-cli') return 'grok-4.6';
      return 'claude-opus-5';
    },
    [modelConfig],
  );

  const handleEngineChange = async (engine: any) => {
    setSessionEngine(engine);
    const defaultModel = defaultModelForEngine(engine);
    setSessionModel(defaultModel);
    if (activeSessionId) {
      const updated = await api.setSessionEngine(activeSessionId, engine);
      setSessions((prev: any) =>
        prev.map((s: any) => (s.id === updated.id ? { ...s, engine: updated.engine } : s)),
      );
      const modelUpdated = await api.setSessionModel(activeSessionId, defaultModel);
      setSessions((prev: any) =>
        prev.map((s: any) => (s.id === modelUpdated.id ? { ...s, model: modelUpdated.model } : s)),
      );
    }
  };

  const handleModelChange = async (model: any) => {
    setSessionModel(model);
    if (activeSessionId) {
      const updated = await api.setSessionModel(activeSessionId, model);
      setSessions((prev: any) =>
        prev.map((s: any) => (s.id === updated.id ? { ...s, model: updated.model } : s)),
      );
    }
  };

  const persistHubModel = async (engine: string, model: string) => {
    // Snapshot the current pick so a failed PUT can be rolled back instead of
    // leaving the picker showing an engine/model the server never accepted.
    const prevEngine = sessionEngine;
    const prevModel = sessionModel;
    setSessionEngine(engine);
    setSessionModel(model);
    setSessions((prev: any) =>
      prev.map((s: any) => (s.agent_id === HUB_ASSISTANT_AGENT_ID ? { ...s, engine, model } : s)),
    );
    try {
      const saved = await api.putHubModel({ engine, model });
      setSessionEngine(saved.engine);
      setSessionModel(saved.model);
      setSessions((prev: any) =>
        prev.map((s: any) =>
          s.agent_id === HUB_ASSISTANT_AGENT_ID
            ? { ...s, engine: saved.engine, model: saved.model }
            : s,
        ),
      );
    } catch (err: any) {
      // Revert the optimistic stamp so the picker reflects reality.
      setSessionEngine(prevEngine);
      setSessionModel(prevModel);
      setSessions((prev: any) =>
        prev.map((s: any) =>
          s.agent_id === HUB_ASSISTANT_AGENT_ID
            ? { ...s, engine: prevEngine, model: prevModel }
            : s,
        ),
      );
      showToast(err?.message || 'Failed to save Hub model', 'error', 5000);
    }
  };

  const handleHubEngineChange = (engine: string) => {
    const nextModel = defaultHubModelForEngine(modelConfig, engine);
    // Never fall back to the previous engine's model — a cross-engine model is
    // invalid for `engine` and the server would 400 it. If the new engine has no
    // resolvable default, skip the persist rather than sending a bad pair.
    if (!nextModel) return;
    void persistHubModel(engine, nextModel);
  };

  const handleHubModelChange = (model: string) => {
    void persistHubModel(sessionEngine, model);
  };

  const clearActiveHubChat = async () => {
    if (hubClearing) return;
    if (!window.confirm('Clear this Hub chat? History is archived for a day.')) return;
    setHubClearing(true);
    try {
      handleCancel();
      const body = await api.clearHubSession();
      const session = body?.session as { id?: string; engine?: string; model?: string } | undefined;
      if (session?.id) {
        // Clear mints a FRESH Hub session — advance the canonical Hub id too,
        // or the composer stays locked (activeSessionId !== hubSessionId) until
        // the user leaves Hub and the GET re-runs.
        setHubSessionId(session.id);
        pendingSessionIdRef.current = session.id;
        setActiveSessionId(session.id);
        setMessages([]);
        if (session.engine) setSessionEngine(session.engine);
        if (session.model) setSessionModel(session.model);
      }
    } catch (err: any) {
      showToast(err?.message || 'Failed to clear Hub chat', 'error', 5000);
    } finally {
      setHubClearing(false);
    }
  };

  const handleReasoningEffortChange = async (effort: any) => {
    setSessionReasoningEffort(effort);
    if (activeSessionId) {
      const updated = await api.setSessionReasoningEffort(activeSessionId, effort);
      setSessions((prev: any) =>
        prev.map((s: any) =>
          s.id === updated.id ? { ...s, reasoning_effort: updated.reasoning_effort } : s,
        ),
      );
    }
  };

  const handleDeleteSession = async (sessionId: any) => {
    setDeletingSessionIds((prev: any) => new Set(prev).add(sessionId));
    tearDownSessionPreview(sessionId);
    // Capture the row before the filter so we can optimistically add it to
    // the Archived list — avoids a round-trip to refresh the archived view
    // after every delete. The server's `session_restored` / subsequent page
    // refresh will reconcile if anything drifts.
    const deletedRow = sessions.find((s: any) => s.id === sessionId) || null;
    try {
      await api.deleteSession(sessionId);
      setBrowserScreensBySession((prev: any) => {
        if (!prev[sessionId]) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      setSessions((prev: any) => prev.filter((s: any) => s.id !== sessionId));
      if (deletedRow) {
        setArchivedSessions((prev: any) => {
          if (prev.some((s: any) => s.id === sessionId)) return prev;
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
        const remaining = sessions.filter((s: any) => s.id !== sessionId);
        setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
      }
      // No success toast — the row appears in the sidebar's Archived
      // section with its own "purges in Nh" countdown, which already
      // tells the user what happened and when it'll be gone.
    } catch (err: any) {
      showToast(`Archive failed: ${err?.message || 'unknown error'}`, 'error', 6000);
    } finally {
      setDeletingSessionIds((prev: any) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  };

  const handleRestoreSession = async (sessionId: any) => {
    setRestoringSessionIds((prev: any) => new Set(prev).add(sessionId));
    try {
      const restored = await api.restoreSession(sessionId);
      // Remove from archived list; the WS `session_restored` event is the
      // canonical path for re-inserting into `sessions`, but we apply the
      // same mutation here to cover initiator-only tabs with slow WS.
      setArchivedSessions((prev: any) => prev.filter((s: any) => s.id !== sessionId));
      if (restored && restored.id) {
        setSessions((prev: any) => {
          if (prev.some((s: any) => s.id === restored.id)) return prev;
          return [restored, ...prev];
        });
      }
      showToast('Session restored', 'success', 3000);
    } catch (err: any) {
      showToast(`Restore failed: ${err?.message || 'unknown error'}`, 'error', 6000);
    } finally {
      setRestoringSessionIds((prev: any) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  };

  const handleClearAllSessions = async (agentIdOverride?: any) => {
    const agentId = agentIdOverride || activeAgentId;
    if (!agentId) return;
    const agentSessions = agentId === activeAgentId ? sessions : sessionsByAgentId[agentId] || [];
    setDeletingBulk('all');
    for (const s of agentSessions) tearDownSessionPreview(s.id);
    try {
      const result = await api.clearAllSessions(agentId);
      // Prefer server-authoritative `archivedIds` so a partial teardown failure
      // does not hide still-live sessions in the sidebar.
      const removedIds = new Set<string>(
        Array.isArray(result?.archivedIds)
          ? (result.archivedIds as string[])
          : result?.ok
            ? agentSessions.map((s: any) => String(s.id))
            : [],
      );
      if (removedIds.size === 0) return;
      setBrowserScreensBySession((prev: any) => pruneSessionScopedMap(prev, removedIds));
      const dropRemoved = (prev: any[]) => prev.filter((s: any) => !removedIds.has(s.id));
      setSessionsByAgentId((prev: any) => ({
        ...prev,
        [agentId]: dropRemoved(prev[agentId] || []),
      }));
      if (agentId === activeAgentId) {
        setSessions((prev: any) => dropRemoved(prev));
        if (activeSessionId && removedIds.has(activeSessionId)) {
          const remaining = dropRemoved(agentSessions);
          setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
        }
      } else if (activeSessionId && removedIds.has(activeSessionId)) {
        setActiveSessionId(null);
      }
    } finally {
      setDeletingBulk(null);
    }
  };

  const handleClearMergedSessions = async (agentIdOverride?: any) => {
    const agentId = agentIdOverride || activeAgentId;
    if (!agentId) return;
    const agentSessions = agentId === activeAgentId ? sessions : sessionsByAgentId[agentId] || [];
    setDeletingBulk('merged');
    // Resolve which sessions the server will archive (state === 'merged') using
    // the same shared resolver the sidebar status icon uses, so the optimistic
    // local update matches what the server does.
    const isMerged = (s: any) =>
      deriveSessionState(s, {
        activeTaskSessionIds: activeTasks,
        finalizeStatusBySession,
      }) === 'merged';
    const mergedIds = new Set(agentSessions.filter(isMerged).map((s: any) => s.id));
    for (const id of mergedIds) tearDownSessionPreview(id);
    try {
      const result = await api.clearMergedSessions(agentId);
      const removedIds = new Set<string>(
        Array.isArray(result?.archivedIds)
          ? (result.archivedIds as string[])
          : result?.ok
            ? [...mergedIds]
            : [],
      );
      if (removedIds.size === 0) return;
      const dropMerged = (prev: any[]) => prev.filter((s: any) => !removedIds.has(s.id));
      setSessionsByAgentId((prev: any) => ({
        ...prev,
        [agentId]: dropMerged(prev[agentId] || []),
      }));
      if (agentId === activeAgentId) {
        setSessions((prev: any) => dropMerged(prev));
        if (activeSessionId && removedIds.has(activeSessionId)) {
          const remaining = dropMerged(agentSessions);
          setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
        }
      } else if (activeSessionId && removedIds.has(activeSessionId)) {
        const remaining = dropMerged(agentSessions);
        setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
      }
    } finally {
      setDeletingBulk(null);
    }
  };

  const handleRenameSession = async (sessionId: any, newName: any) => {
    await api.renameSession(sessionId, newName);
    setSessions((prev: any) =>
      prev.map((s: any) => (s.id === sessionId ? { ...s, name: newName } : s)),
    );
  };

  const handleDequeue = (messageId: any) => {
    if (activeSessionId) {
      // Removing a queued message only discards that message. The in-flight
      // turn keeps running — dropping a follow-up must never cancel the agent.
      send({ type: 'dequeue', sessionId: activeSessionId, messageId });
      setMessages((prev: any) => prev.filter((m: any) => m.id !== messageId));
    }
  };

  const handleEditInComposer = useCallback((messageId: any, content: any) => {
    setComposerPrefill({ messageId, content });
  }, []);

  const handleEditQueuedMessage = (messageId: any, content: any) => {
    if (activeSessionId) {
      send({ type: 'edit_queue_item', sessionId: activeSessionId, messageId, content });
      // Optimistically update local message content
      setMessages((prev: any) =>
        prev.map((m: any) => (m.id === messageId ? { ...m, content } : m)),
      );
    }
  };

  // Handle submission from an <AskUserQuestion> picker. We dispatch the
  // pre-formatted chat message (which already contains the agenthub:ask:answer
  // fenced block) and mark the askId as submitted so the picker flips to a
  // disabled "Submitted" state immediately. Once the user message persists to
  // history, `askSubmittedFromHistory` below picks the id up from the
  // fenced-block scan and the optimistic set becomes redundant — but the
  // union in `askSubmitted` makes the brief overlap seamless.
  const handleAskSubmit = (askId: any, messageText: any) => {
    if (askSubmitted.has(askId)) return;
    setAskSubmittedOptimistic((prev: any) => {
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
    setAwaitingInputBySession((prev: any) =>
      clearAwaitingInputForSession(prev, activeSessionIdRef.current),
    );
    handleSend(messageText);
  };

  const handleCredentialSubmit = (_requestId: any, messageText: any) => {
    handleSend(messageText);
  };

  // The agent a turn must run as is a property of the ACTIVE SESSION, not the
  // shared `activeAgentId` (which init / config-ready / restore can leave on a
  // project agent). When the active session is the Hub session, the turn runs
  // as the `__hub_assistant__` agent. The server's handleChat spawns from the
  // message's agentId, so getting this wrong runs the Hub turn with a project
  // agent's cwd/skills.
  const resolveTurnAgentId = () =>
    activeSessionIdRef.current && activeSessionIdRef.current === hubSessionIdRef.current
      ? HUB_ASSISTANT_AGENT_ID
      : activeAgentId;

  const handleSend = async (
    content: any,
    images: any = [],
    { interrupt = false, agentId: agentIdOverride, sessionId: sessionIdOverride }: any = {},
  ) => {
    // The agent/session a turn runs as must be passed EXPLICITLY by callers that
    // are not bound to the shared `activeAgentId` / `activeSessionId` globals
    // (notably the Hub assistant, whose identity is `__hub_assistant__` + the
    // per-user Hub session, independent of whatever project agent init/restore
    // left active). Everyone else falls back to the active globals as before.
    const targetAgentId = agentIdOverride ?? resolveTurnAgentId();
    let sessionId = sessionIdOverride ?? activeSessionIdRef.current;
    if (!sessionId) {
      const coalesceKey = `${targetAgentId}:${sessionConsultMode ? 'consult' : 'run'}`;
      const session = await coalescePromiseByKey(implicitSessionCreateByKeyRef, coalesceKey, () =>
        api
          .createSession(targetAgentId, undefined, { consultMode: sessionConsultMode })
          .then((s: any) => {
            setSessions((prev: any) => prependSessionDeduped(prev, s));
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
    let uploadedImages: any[] = [];
    if (images.length > 0) {
      try {
        uploadedImages = await Promise.all(
          images.map((img: any) => {
            if (isPersistedUploadAttachment(img)) return img;
            if ((img.type === 'video' || img.type === 'file') && img.file) {
              return api.uploadFile(img.file);
            }
            return api.uploadImage(img.dataUrl, img.name);
          }),
        );
      } catch (err: any) {
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
      agentId: targetAgentId,
      sessionId,
      content,
      ...(uploadedImages.length > 0 ? { images: uploadedImages } : {}),
      ...(interrupt ? { interrupt: true } : {}),
    });
  };

  const sendHubChat = (content: any, images: any = [], opts: any = {}) => {
    // Bind the Hub turn to the canonical Hub identity — the `__hub_assistant__`
    // agent and the live per-user Hub session — NOT the shared activeAgentId /
    // activeSessionId, which init / config-ready / restore can point at a
    // project agent. Without an explicit agentId the server's handleChat would
    // spawn the turn as that project agent (wrong cwd/skills). Refuse to send
    // until the Hub session is resolved.
    const hubId = hubSessionIdRef.current;
    if (!hubId) return;
    return handleSend(content, images, {
      ...opts,
      agentId: HUB_ASSISTANT_AGENT_ID,
      sessionId: hubId,
    });
  };

  /** Send a queued user message now and interrupt the in-flight assistant turn. */
  const handleInterruptQueuedMessage = useCallback(
    (message: any) => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId || !message?.id) return;
      const { chat } = buildInterruptQueuedMessageDispatch({
        message,
        // Same session-derived identity as handleSend: a queued Hub message
        // must re-dispatch as the Hub agent, not whatever activeAgentId holds.
        agentId: sessionId === hubSessionIdRef.current ? HUB_ASSISTANT_AGENT_ID : activeAgentId,
        sessionId,
      });
      send(chat);
    },
    [send, activeAgentId],
  );

  const isProcessing = thinking || !!streamingContent || sessionRoundProcessing;
  const activeSession = useMemo(
    () =>
      sessions.find((s: any) => s.id === activeSessionId) ||
      (activeSessionId ? sessionsByIdRef.current.get(activeSessionId) : null) ||
      null,
    [sessions, activeSessionId, sessionsIndexTick],
  );

  // Resolve the design linked to the active session (if any) against the
  // loaded designs list. A stale id (design since deleted) resolves to
  // undefined and the preview pane simply doesn't render.
  const linkedDesign = useMemo(() => {
    const id = activeSession?.linked_design_id;
    if (!id) return null;
    return designs.find((d: any) => d.id === id) || null;
  }, [activeSession, designs]);
  activeSessionLinkedDesignIdRef.current = activeSession?.linked_design_id ?? null;

  const handleLinkSessionDesign = useCallback(
    async (designId: any) => {
      if (!activeSessionId) return;
      try {
        const updated = await api.setSessionLinkedDesign(activeSessionId, designId);
        setSessions((prev: any) =>
          prev.map((s: any) => (s.id === updated.id ? { ...s, ...updated } : s)),
        );
        setSessionDesignReloadToken((t: any) => t + 1);
        setShowLinkDesign(false);
      } catch (err: any) {
        showToast(err?.message || 'Failed to link design', 'error', 6000);
      }
    },
    [activeSessionId, showToast],
  );

  const handleUnlinkSessionDesign = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      const updated = await api.setSessionLinkedDesign(activeSessionId, null);
      setSessions((prev: any) =>
        prev.map((s: any) => (s.id === updated.id ? { ...s, ...updated } : s)),
      );
      setShowLinkDesign(false);
    } catch (err: any) {
      showToast(err?.message || 'Failed to unlink design', 'error', 6000);
    }
  }, [activeSessionId, showToast]);

  const handleLinkScopingEpic = useCallback(
    async (epicId: any) => {
      if (!activeSessionId) return;
      try {
        const updated = await api.setSessionLinkedEpic(activeSessionId, epicId);
        setSessions((prev: any) =>
          prev.map((s: any) => (s.id === updated.id ? { ...s, ...updated } : s)),
        );
      } catch (err: any) {
        showToast(err?.message || 'Failed to link epic', 'error', 6000);
      }
    },
    [activeSessionId, showToast],
  );

  const handleOpenLinkedDesignStudio = useCallback(() => {
    if (!linkedDesign) return;
    setActiveDesignId(linkedDesign.id);
    setCurrentView('design');
  }, [linkedDesign]);

  // Session mode (chat | design). Design mode needs an isolated worktree — the
  // server rejects `PUT /mode design` without one. We use the server-computed
  // `can_design_mode` capability (derived from the SAME `sessionHasUsableWorktree`
  // gate) rather than reimplementing the worktree check here, so the picker
  // offers Design exactly when the server would accept it and can't drift.
  const sessionMode =
    activeSession?.session_mode === 'design'
      ? 'design'
      : activeSession?.session_mode === 'scoping'
        ? 'scoping'
        : activeSession?.session_mode === 'skill-builder'
          ? 'skill-builder'
          : activeSession?.session_mode === 'consult'
            ? 'consult'
            : activeSession?.session_mode === 'hub'
              ? 'hub'
              : activeSession?.session_mode === 'isolated'
                ? 'isolated'
                : 'chat';
  const designModeActive = sessionMode === 'design';
  const scopingModeActive = sessionMode === 'scoping';
  // Skill Builder mode is purely conversational (the coach runs in chat and
  // writes skills via the API) — it has no dedicated side pane like Design /
  // Scoping, so there is no `skillBuilderModeActive` flag to render here.

  // Atomic multi-axis session-control change for the Finalize automation picker
  // (Consult / Design / Build / …). The picker can change session_mode +
  // finalize_automation at once; we send them as ONE PATCH so the server applies
  // them in a single transaction. Optimistic `sessionConsultMode` is tracked
  // separately from the session row, so it is updated here and reverted if the
  // (atomic) call fails — the server changed nothing, so neither should we.
  const handleSessionControlChange = useCallback(
    async (patch: any) => {
      if (!activeSessionId) return;
      const prevConsult = sessionConsultMode;
      if (patch.session_mode === 'consult') setSessionConsultMode(true);
      else if (
        patch.session_mode === 'chat' ||
        patch.session_mode === 'isolated' ||
        patch.finalize_automation !== undefined
      ) {
        setSessionConsultMode(false);
      }
      if (patch.ask_mode === false) setSessionConsultMode(false);
      try {
        const updated = await api.updateSession(activeSessionId, patch);
        setSessions((prev: any) =>
          prev.map((s: any) => (s.id === updated.id ? { ...s, ...updated } : s)),
        );
        setSessionConsultMode(isSessionConsultModeEnabled(updated));
      } catch (err: any) {
        setSessionConsultMode(prevConsult);
        throw err;
      }
    },
    [activeSessionId, sessionConsultMode],
  );

  const sessionConsultActive = isSessionConsultModeEnabled(activeSession);

  const liveStream = resolveLiveStreamIdentity({
    streamingAgent,
    streamingEngine,
    sessionAgentName: activeAgent?.name,
    sessionAgentColor: activeAgent?.color,
    sessionModel,
  });

  // "Run in terminal" on a code fence / Bash tool card: open the shared
  // terminal (it may be closed, and it shares the right-hand slot with the
  // diff and artifacts panes) and hand the command to the pane. The pane holds
  // it on the bus until its socket attaches, so the click works from cold.
  const runCommandInSessionTerminal = useCallback(
    (command: string) => {
      if (!activeSessionId) return;
      setTerminalPaneOpenBySession((prev: any) => ({ ...prev, [activeSessionId]: true }));
      setDiffPaneOpenBySession((prev: any) => ({ ...prev, [activeSessionId]: false }));
      setArtifactsPaneOpenBySession((prev: any) => ({ ...prev, [activeSessionId]: false }));
      sendCommandToTerminal(activeSessionId, command);
    },
    [activeSessionId],
  );

  // Mirrors the Terminal toggle button's own availability rules — no terminal
  // to send to means no button in the transcript.
  const runInTerminalHandler =
    activeSessionId && !chatProjectIsWorkflow && !sessionConsultActive
      ? runCommandInSessionTerminal
      : null;

  const sessionOwnerAgentId = activeSession?.agent_id ?? activeAgentId;
  const chatAgent = useMemo(
    () => agents.find((a: any) => a.id === sessionOwnerAgentId) ?? activeAgent ?? null,
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

  const activeSessionState = useMemo(
    () =>
      deriveSessionState(activeSession, {
        activeTaskSessionIds: activeTasks,
        finalizeStatusBySession,
      }),
    [activeSession, activeTasks, finalizeStatusBySession],
  );

  // Fire an ensure for every opened worktree session, independent of the
  // persisted worktree_path. A persisted path proves the clone happened once,
  // but the session VM/container is in-memory and can be gone after a Hub
  // restart or idle reap — reopening such a session must reboot it so the
  // first chat does not pay the boot delay.
  const activeSessionNeedsWorkspaceEnsure = shouldEnsureSessionWorkspaceOnOpen(activeSession);

  // Provision the git worktree and boot the environment for a session so Start
  // preview mounts the same checkout the agent will edit (not project.cwd) and
  // the first chat turn spawns in a ready VM. Success marks the session ready;
  // FAILURE records an error (not ready) so the composer stays gated and a
  // Retry path is offered — a failed boot must never enable the composer.
  const runSessionWorkspaceEnsure = useCallback(
    (sid: string) => {
      const plan = planWorkspaceEnsureOnOpen({
        attempted: workspaceEnsureAttemptedRef.current.has(sid),
        inFlight: workspaceEnsureInFlightRef.current.has(sid),
      });
      if (plan === 'skip') return;
      // Register this activation's attempt before issuing/adopting so the
      // request that ultimately settles (this one, or the in-flight one we
      // adopt) marks the session ready/failed via its attempted-ref check.
      workspaceEnsureAttemptedRef.current.add(sid);
      setWorkspaceEnsuringBySession((prev: any) => ({ ...prev, [sid]: true }));
      // Starting (or adopting) a fresh attempt clears any prior failure.
      setWorkspaceEnsureErrorBySession((prev: any) => withoutSessionKey(prev, sid));
      if (plan === 'adopt') {
        // A prior request for this session is still in flight (rapid
        // leave→reopen). Its handlers now see the re-added attempt and will
        // settle this activation — issuing a second request would race.
        return;
      }
      workspaceEnsureInFlightRef.current.add(sid);
      void api
        .ensureSessionWorkspace(sid)
        .then((body: any) => {
          if (body?.session) {
            setSessions((prev: any) => prev.map((s: any) => (s.id === sid ? body.session : s)));
          }
          // Mark ready only on success, and only if this activation still owns
          // the attempt (the user may have navigated away mid-request).
          if (workspaceEnsureAttemptedRef.current.has(sid)) {
            setWorkspaceEnsureSettledBySession((prev: any) =>
              prev[sid] ? prev : { ...prev, [sid]: true },
            );
          }
        })
        .catch((err: any) => {
          const message = err?.message || 'Failed to prepare session workspace';
          // A raw request-timeout here is pure noise as a toast: this caller
          // records the failure inline below (composer stays gated, Retry
          // offered), so the toast would only interrupt. Every other failure
          // (and every other caller's toast) is unaffected. Scoped here rather
          // than in showToast so a timeout on an action whose *only* feedback
          // is a toast is not silently swallowed.
          if (!shouldSuppressToast(message)) {
            showToast(message, 'error', 8000);
          }
          // Record the failure (keeps the composer gated) so the UI can offer a
          // Retry instead of pretending the environment is ready.
          if (workspaceEnsureAttemptedRef.current.has(sid)) {
            setWorkspaceEnsureErrorBySession((prev: any) => ({ ...prev, [sid]: message }));
          }
        })
        .finally(() => {
          workspaceEnsureInFlightRef.current.delete(sid);
          setWorkspaceEnsuringBySession((prev: any) => {
            if (!prev[sid]) return prev;
            const next = { ...prev };
            delete next[sid];
            return next;
          });
        });
    },
    [showToast],
  );

  // Ensure the workspace as soon as a session is opened.
  useEffect(() => {
    const sid = activeSessionId;
    if (!sid || !connected || !activeSessionNeedsWorkspaceEnsure) return;
    runSessionWorkspaceEnsure(sid);
  }, [activeSessionId, connected, activeSessionNeedsWorkspaceEnsure, runSessionWorkspaceEnsure]);

  // Retry a failed open-time ensure: drop the prior attempt + error so the
  // runner issues a fresh request and re-gates the composer while it runs.
  const retrySessionWorkspaceEnsure = useCallback(
    (sid: string) => {
      if (!sid) return;
      workspaceEnsureAttemptedRef.current.delete(sid);
      setWorkspaceEnsureErrorBySession((prev: any) => withoutSessionKey(prev, sid));
      runSessionWorkspaceEnsure(sid);
    },
    [runSessionWorkspaceEnsure],
  );

  // Model open-time readiness PER ACTIVATION. The attempted/settled state above
  // otherwise persists for the whole browser lifetime, so a session whose VM is
  // idle-reaped while the user works elsewhere would reopen still marked
  // attempted+settled — skipping the reboot and opening the composer against a
  // dead environment. Reset both when leaving the session (effect cleanup keyed
  // only on activeSessionId, so unstable deps like showToast can't retrigger
  // it) so the reopen re-runs the idempotent ensure and re-gates the composer.
  useEffect(() => {
    const sid = activeSessionId;
    if (!sid) return;
    return () => {
      workspaceEnsureAttemptedRef.current.delete(sid);
      setWorkspaceEnsureSettledBySession((prev: any) => withoutSessionKey(prev, sid));
      setWorkspaceEnsureErrorBySession((prev: any) => withoutSessionKey(prev, sid));
    };
  }, [activeSessionId]);

  // Invalidate open-time readiness on WebSocket disconnect. A drop can mean a
  // Hub restart that lost every in-memory session VM while the persisted
  // worktree_path survives, so trusting the settled/attempted state after
  // reconnect would leave the composer enabled against a dead environment.
  // Clearing it forces the ensure effect (which re-runs when `connected` flips
  // back to true) to issue a fresh, re-gating ensure. In-flight requests are
  // left alone: the ensure POST is served by the server, so a request that
  // completes after a restart genuinely reflects the rebooted VM.
  useEffect(() => {
    if (connected) return;
    workspaceEnsureAttemptedRef.current.clear();
    setWorkspaceEnsureSettledBySession((prev: any) => (Object.keys(prev).length ? {} : prev));
    setWorkspaceEnsureErrorBySession((prev: any) => (Object.keys(prev).length ? {} : prev));
  }, [connected]);

  // Composer readiness: a session that needs an open-time ensure only accepts
  // input once that ensure has settled. Computed synchronously so the composer
  // is disabled from first render, not just after the effect sets the
  // in-flight flag.
  const activeSessionComposerWorkspaceReady = isSessionComposerWorkspaceReady({
    needsEnsure: activeSessionNeedsWorkspaceEnsure,
    settled: !!(activeSessionId && workspaceEnsureSettledBySession[activeSessionId]),
  });
  // Error message when the active session's open-time ensure failed (composer
  // stays gated; the UI offers a Retry).
  const activeSessionWorkspaceEnsureError: string | null =
    (activeSessionId && workspaceEnsureErrorBySession[activeSessionId]) || null;

  // Whether the active session currently shows the optimistic synthetic
  // `preview_starting` seed. Extracted (rather than inlined into the
  // effect deps) so `react-hooks/exhaustive-deps` can statically check it,
  // and so a Start click that flips the seed reschedules the hydration
  // effect even when `activePreviewEvent?.kind` is unchanged.
  const activeSessionSeedStarting = !!(
    activeSessionId && previewStartingBySession[activeSessionId]
  );

  // Self-heal a preview pane stuck on "Booting preview…". The pane's
  // status is driven purely by live `agenthub_preview` WS events; the
  // WS connect-snapshot rehydrates a client that *reconnects*, but a
  // live frame dropped while the socket stays OPEN (a transient blip that
  // never triggers onclose → reconnect) leaves the pane pinned on
  // `preview_starting` forever, even though the backend group is already
  // `ready` and the proxy serves 200. The dropped frame can be the
  // `ready`/`failed` terminal OR the `preview_starting` itself — in the
  // latter case the only client state is the synthetic seed (no
  // previewId). While the active session shows a starting preview (real
  // WS event OR synthetic seed), poll the authoritative `GET
  // /preview/state` and reconcile.
  //
  // Stale-response race: a poll issued for run A can return after the
  // user restarts (run B). We capture the per-session start generation
  // before the request and re-check it before applying, so a response
  // for an old run is discarded rather than clobbering the restart. That
  // generation guard is what lets the no-id synthetic seed converge
  // safely; `reconcilePreviewEvent` additionally requires a positive
  // previewId match when the current run already has one (covers
  // WS-driven restarts that don't bump the generation).
  useEffect(() => {
    const sid = activeSessionId;
    if (!sid || !connected) return;
    const wsEvent = previewEventBySessionRef.current[sid];
    const seeded = !!previewStartingBySessionRef.current[sid];
    const isStarting = wsEvent ? wsEvent.kind === 'preview_starting' : seeded;
    if (!isStarting) return;
    let cancelled = false;
    const reconcile = async () => {
      const liveWs = previewEventBySessionRef.current[sid];
      const liveSeeded = !!previewStartingBySessionRef.current[sid];
      const stillStarting = liveWs ? liveWs.kind === 'preview_starting' : liveSeeded;
      if (!stillStarting) return;
      const seqAtRequest = previewStartSeqRef.current[sid] || 0;
      try {
        const res = await api.get(previewStateApiPath(sid));
        if (cancelled || !res?.event) return;
        const decision = resolvePreviewHydration({
          currentEvent: previewEventBySessionRef.current[sid],
          seeded: !!previewStartingBySessionRef.current[sid],
          fetched: res.event,
          seqAtRequest,
          currentSeq: previewStartSeqRef.current[sid] || 0,
        });
        if (!decision) return;
        setPreviewEventBySession((prev: any) => ({ ...prev, [sid]: decision.event }));
        // A terminal event landed via hydration — clear the optimistic
        // seed flag so the pane reads the freshly stored terminal event
        // (mirrors the WS-event handler's cleanup).
        if (decision.event.kind === 'preview' || decision.event.kind === 'preview_failed') {
          setPreviewStartingBySession((prev: any) => {
            if (!prev[sid]) return prev;
            const nextSeed = { ...prev };
            delete nextSeed[sid];
            return nextSeed;
          });
        }
      } catch {
        // Best-effort hydration — live WS events remain the primary
        // path; a failed poll just retries on the next tick.
      }
    };
    const id = setInterval(reconcile, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // Keyed on the event *kind* AND the synthetic seed flag, not the
    // whole event: streaming `preview_log` frames mutate `logTail` every
    // line but leave `kind` as `preview_starting`, so depending on the
    // kind avoids tearing down and recreating the interval (which would
    // reset the 5 s timer) on every log line while still re-running on
    // real transitions. The seed flag is a separate dep because a Start
    // click can flip `previewStartingBySession[sid]` to true WITHOUT
    // changing `activePreviewEvent?.kind` (e.g. a dropped `preview_starting`
    // frame) — without it the effect would never schedule the poll that
    // converges the no-id seed.
  }, [activeSessionId, connected, activePreviewEvent?.kind, activeSessionSeedStarting]);

  const activeResolvePrBannerInfo = useMemo(() => {
    if (!activeSession?.name || !isResolvePrSessionTitle(activeSession.name)) return null;
    return {
      prUrl: inferPrUrlFromSessionTitle(activeSession.name, chatGithubRepo, {
        gitHost: activeChatProject?.gitHost ?? null,
        projectId: activeChatProject?.id ?? null,
      }),
      prNumber: parseResolvePrNumberFromTitle(activeSession.name),
    };
  }, [activeSession, chatGithubRepo, activeChatProject?.gitHost, activeChatProject?.id]);
  const orchestrationTimelineEntries = useMemo(() => {
    if (!activeSessionId) return [];
    const out: any[] = [];
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
    out.sort((a: any, b: any) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
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
    if (currentView.startsWith('epics:')) return currentView.slice('epics:'.length);
    if (currentView.startsWith('epic:')) return currentView.split(':')[1] || null;
    if (currentView.startsWith('workflows:')) return currentView.slice('workflows:'.length);
    if (projectMenuRoute) return projectMenuRoute.projectId;
    if (currentView.startsWith('runners:')) return currentView.slice('runners:'.length);
    if (currentView.startsWith('stats:')) return currentView.slice('stats:'.length);
    if (currentView.startsWith('devserver:')) return currentView.slice('devserver:'.length);
    if (currentView.startsWith('aws:')) return currentView.slice('aws:'.length);
    if (currentView.startsWith('infra:')) return currentView.slice('infra:'.length);
    if (workflowEditRoute) return workflowEditRoute.projectId;
    if (currentView === 'wiki' && wikiProjectId) return wikiProjectId;
    if (currentView === 'notes' && notesProjectId) return notesProjectId;
    if (currentView === 'pulls' && pullsProjectId) return pullsProjectId;
    if (currentView === 'threads' && threadsProjectId) return threadsProjectId;
    if (currentView === 'support' && supportProjectId) return supportProjectId;
    if (currentView === 'replays' && replaysProjectId) return replaysProjectId;
    if (currentView === 'security' && securityProjectId) return securityProjectId;
    const byAgent = projects.find((p: any) => p.agents?.some((a: any) => a.id === activeAgentId));
    return byAgent?.id || projects[0]?.id || null;
  }, [
    currentView,
    workflowEditRoute,
    projectMenuRoute,
    wikiProjectId,
    notesProjectId,
    pullsProjectId,
    threadsProjectId,
    supportProjectId,
    replaysProjectId,
    securityProjectId,
    projects,
    activeAgentId,
  ]);

  // Build the handler map inline — useKeyboardShortcuts reads the latest map
  // via a ref, so rebuilding on every render is cheap and avoids stale closures.
  const goToNextProject = () => {
    if (!projects.length) return;
    const idx = Math.max(
      projects.findIndex((p: any) => p.id === currentProjectId),
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

  const handleOpenPrDetail = useCallback((projectId: any, prNumber: any) => {
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

  /**
   * Spawn a follow-up session from the Finalize summary block.
   *
   * The seed message is pre-stored rather than auto-started: the operator lands
   * in a session that already knows what shipped and what still has to be run
   * by hand, and types the actual ask themselves.
   */
  const handleStartFollowUpSession = useCallback(
    async (sourceSessionId: any) => {
      // Typed check, not just truthiness: every caller must hand over a real
      // session id. If this is ever wired straight to a child's callback that
      // passes something else through, drop it here rather than POSTing to
      // `/sessions/<whatever>/follow-up` and surfacing a confusing 404.
      if (typeof sourceSessionId !== 'string' || !sourceSessionId) return;
      try {
        const result = await api.startFollowUpSession(sourceSessionId, {});
        const session = result?.session;
        if (!session) return;
        pendingSessionIdRef.current = session.id;
        setActiveAgentId(session.agent_id);
        setActiveSessionId(session.id);
        setCurrentView('chat');
        showToast('Follow-up session started', 'success', 4000);
      } catch (err: any) {
        showToast(`Could not start follow-up: ${err?.message || err}`, 'error', 6000);
      }
    },
    [showToast],
  );

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
      'go-to-skills': () => setCurrentView('settings:global-skills'),
      'go-to-settings': () => setCurrentView('settings'),
      'go-to-next-project': goToNextProject,
      'toggle-microphone': () => messageInputRef.current?.toggleRecording(),
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
  const [electronDesktopHealth, setElectronDesktopHealth] = useState<any>(null);
  useEffect(() => {
    if (!isElectron) return;
    let cancelled = false;
    fetchDesktopUpdateHealth().then((h: any) => {
      if (!cancelled && h) setElectronDesktopHealth(h);
    });
    return () => {
      cancelled = true;
    };
  }, [isElectron]);
  const versionCheck = useVersionCheck({
    serverVersion: electronDesktopHealth?.version ?? null,
  });

  const renderSessionTerminalPane = (embedded: boolean) => {
    if (!activeSessionId) return null;
    return (
      <SessionTerminalPane
        embedded={embedded}
        sessionId={activeSessionId}
        jobs={terminalJobsBySession[activeSessionId] ?? []}
        logsById={backgroundShellLogsBySession[activeSessionId] ?? {}}
        activeTabId={terminalActiveTabBySession[activeSessionId] ?? PTY_TAB_ID}
        onActiveTabChange={(tabId) =>
          setTerminalActiveTabBySession((prev) => ({
            ...prev,
            [activeSessionId]: tabId,
          }))
        }
        onDismissJob={(shellId) => {
          setTerminalJobsBySession((prev) => dismissTerminalJob(prev, activeSessionId, shellId));
          setTerminalActiveTabBySession((prev) =>
            prev[activeSessionId] === shellId ? { ...prev, [activeSessionId]: PTY_TAB_ID } : prev,
          );
        }}
        onLogSnapshot={(shellId, snapshot) =>
          setBackgroundShellLogsBySession((prev) =>
            applyBackgroundShellLogSnapshot(prev, activeSessionId, shellId, snapshot),
          )
        }
        onClose={
          embedded
            ? undefined
            : () =>
                setTerminalPaneOpenBySession((prev: any) => ({
                  ...prev,
                  [activeSessionId]: false,
                }))
        }
      />
    );
  };

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
              .filter((o: any) => o.id !== activeOrg?.id)
              .map((org: any) => (
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

  // Shared live-turn chrome: thinking dots + streaming SessionTail. Hub and
  // project chat both mount this so Hub does not wait for the finished
  // assistant row before showing output.
  const liveStreamingAssistantTurn = (
    <>
      {thinking && !streamingMsgId && (
        <ThinkingIndicator
          agentColor={streamingAgent?.agentColor || activeAgent?.color}
          agentName={streamingAgent?.agentName}
        />
      )}
      {streamingMsgId && (
        <SessionTail
          key={streamingMsgId}
          message={{
            id: streamingMsgId,
            session_id: activeSessionId,
            role: 'assistant',
            engine: liveStream.engine,
            model: liveStream.model,
            agent_name: liveStream.agentName,
            content: streamingContent,
          }}
          events={eventsByMessage[streamingMsgId]}
          agentColor={liveStream.agentColor}
          agentName={liveStream.agentName}
          streaming
          onInterrupt={handleCancel}
          onAskSubmit={handleAskSubmit}
          onCredentialSubmit={handleCredentialSubmit}
          askSubmittedIds={askSubmitted}
          fromAgent={activeAgent}
          agents={agents}
          sessionHandoffs={sessionHandoffs}
          sessionDelegations={delegations[activeSessionId]}
          delegationDispatchError={delegationDispatchErrors[activeSessionId]}
          onOpenSession={handleOpenHandoffSession}
          browserScreenshots={
            activeSessionId
              ? (browserScreensBySession[activeSessionId]?.[streamingMsgId] ?? {})
              : {}
          }
        />
      )}
    </>
  );

  const hubModelPicker = (
    <HubModelPicker
      modelConfig={modelConfig}
      engine={sessionEngine}
      model={sessionModel}
      onEngineChange={handleHubEngineChange}
      onModelChange={handleHubModelChange}
    />
  );
  const hubClearButton = <HubClearChatButton onClear={clearActiveHubChat} clearing={hubClearing} />;
  const hubAssistantChat = (
    <div className="flex-1 flex flex-col min-h-0">
      <div
        ref={scrollContainerRef}
        onScroll={handleScrollEvent}
        data-testid="hub-assistant-scroll"
        className="flex-1 overflow-y-auto px-3 py-3 space-y-2"
        style={{ overflowAnchor: 'none' }}
      >
        <div ref={messagesColumnRef}>
          {messages.length === 0 && !thinking && !streamingMsgId && !streamingContent && (
            <p className="text-sm text-gray-500 px-1">
              Ask Hub what to focus on next, to kick off an agent, or to configure Agent Hub. It
              reads your boards, todos, support, and calendar through the API — not by scraping
              pages.
            </p>
          )}
          {messages.map((msg: any) =>
            msg.role === 'assistant' ? (
              <SessionTail
                key={msg.id}
                message={msg}
                events={eventsByMessage[msg.id]}
                agentColor={msg.agent_color || chatAccentColor}
                agentName={activeAgent?.name || 'Hub'}
                onEventsLoaded={handleEventsLoaded}
                onAskSubmit={handleAskSubmit}
                onCredentialSubmit={handleCredentialSubmit}
                askSubmittedIds={askSubmitted}
                fromAgent={activeAgent}
                agents={agents}
                sessionHandoffs={sessionHandoffs}
                sessionDelegations={delegations[activeSessionId]}
                delegationDispatchError={delegationDispatchErrors[activeSessionId]}
                onOpenSession={handleOpenHandoffSession}
                browserScreenshots={browserScreensBySession[activeSessionId]?.[msg.id] ?? {}}
              />
            ) : (
              <ChatMessage
                key={msg.id}
                message={msg}
                agentColor={chatAccentColor}
                projectId={activeChatProject?.id}
                hosted={activeChatProject?.gitHost === 'agenthub'}
                onOpenPrDetail={handleOpenPrDetail}
                onStartFollowUp={() => handleStartFollowUpSession(activeSessionId)}
              />
            ),
          )}
          {(reactLoopStepsBySession[activeSessionId] || []).length > 0 && (
            <ReactLoopObservabilityPanel
              steps={reactLoopStepsBySession[activeSessionId]}
              streaming={Boolean(streamingMsgId || activeTasks[activeSessionId])}
            />
          )}
          {liveStreamingAssistantTurn}
        </div>
      </div>
      <div className="shrink-0">
        <MessageInput
          ref={messageInputRef}
          onSend={sendHubChat}
          onCancel={handleCancel}
          disabled={
            shouldDisableSessionComposer({
              hasAgent: !!activeAgent,
              connected,
              workspaceEnsureFailed: !!activeSessionWorkspaceEnsureError,
            }) ||
            // Lock the composer until the live Hub session is the active one, so
            // the user can never type into (and send to) a project session that
            // happens to be active before the Hub GET resolves.
            !hubSessionId ||
            activeSessionId !== hubSessionId
          }
          isProcessing={isProcessing}
          queueLength={(messageQueues[activeSessionId] || []).length}
          agentColor={chatAccentColor}
          skills={skills}
          consultMode
          consultHint="Hub assistant — org & account help, no code ship or Finalize"
          readOnly={false}
          draftKey={activeSessionId || 'hub'}
          onFileError={(msg: any) => showToast(msg, 'error', 6000)}
          composerPrefill={composerPrefill}
          onComposerPrefillClear={() => setComposerPrefill(null)}
          onReplaceQueuedMessage={handleEditQueuedMessage}
          sessionAgents={sessionAgents}
          enableMentions={false}
          toolbarStart={
            <div className="flex items-center gap-2 min-w-0 w-full">
              {hubModelPicker}
              <div className="lg:hidden ml-auto shrink-0">{hubClearButton}</div>
            </div>
          }
        />
      </div>
    </div>
  );

  return (
    <div className="flex flex-col h-dvh max-h-dvh overflow-hidden bg-gray-950 text-gray-100">
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
          <span className="flex-1 flex items-center justify-center select-none">
            <BrandLogo size="sm" />
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

        {/* Collapsed rail (desktop only) — lets users re-open the sidebar from
            any view after collapsing it. Hidden on mobile, which uses the
            slide-out drawer instead. */}
        {sidebarCollapsed && (
          <div className="hidden md:flex flex-col items-center w-10 flex-shrink-0 border-r border-gray-800 bg-gray-900 pt-2.5 electron-no-drag">
            <BrandLogo variant="mark" size="sm" className="mb-2" />
            <button
              type="button"
              onClick={() => setSidebarCollapsed(false)}
              className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-800 transition-colors"
              title="Expand sidebar"
              aria-label="Expand sidebar"
              data-testid="sidebar-expand"
            >
              <PanelLeftOpen size={18} />
            </button>
          </div>
        )}

        {/* Sidebar */}
        <div
          className={`fixed md:relative inset-y-0 left-0 z-50 md:z-auto flex h-dvh max-h-dvh md:h-full md:max-h-none overflow-hidden transition-transform duration-200 ${
            sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
          } ${sidebarCollapsed ? 'md:hidden' : ''}`}
        >
          <Sidebar
            onCollapseSidebar={() => setSidebarCollapsed(true)}
            isLoading={sidebarDataLoading}
            projects={projects}
            agents={agents}
            activeAgentId={activeAgentId}
            onSelectAgent={(id: any) => {
              pendingSessionIdRef.current = null;
              setActiveSessionId(null);
              setActiveAgentId(id);
              setSidebarOpen(false);
            }}
            onExpandAgent={loadSidebarAgentSessions}
            sessionsByAgentId={sessionsByAgentId}
            archivedSessionsByAgentId={archivedSessionsByAgentId}
            loadedSessionsAgentId={loadedSessionsAgentId}
            loadedArchivedAgentId={loadedArchivedAgentId}
            onFocusSession={focusAgentSession}
            showToast={showToast}
            connected={connected}
            reconnecting={reconnecting}
            bugReportProjectId={currentProjectId}
            bugReportAgentId={activeAgentId}
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelectSession={(id: any) => focusAgentSession(undefined, id)}
            onNewSession={handleNewSession}
            onDeleteSession={handleDeleteSession}
            onClearAllSessions={handleClearAllSessions}
            onClearMergedSessions={handleClearMergedSessions}
            archivedSessions={archivedSessions}
            onRestoreSession={handleRestoreSession}
            restoringSessionIds={restoringSessionIds}
            deletingSessionIds={deletingSessionIds}
            deletingBulk={deletingBulk}
            onRenameSession={handleRenameSession}
            onNavigate={(view: any, extra: any) => {
              setCurrentView(view);
              if (view === 'wiki' && extra) setWikiProjectId(extra);
              if (view === 'notes' && extra) setNotesProjectId(extra);
              if (view === 'reviewer' && extra) setReviewerProjectId(extra);
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
                setUnreadThreadCounts((prev: any) => {
                  if (!prev[extra]) return prev;
                  const next = { ...prev };
                  delete next[extra];
                  return next;
                });
              }
              if (view === 'support') {
                if (extra) setSupportProjectId(extra);
                // Opening support from the sidebar is not a ticket deep-link.
                setSupportTicketId(null);
              }
              if (view === 'deployments' && extra) setDeploymentsProjectId(extra);
              if (view === 'replays' && extra) setReplaysProjectId(extra);
              if (view === 'security' && extra) setSecurityProjectId(extra);
              setSidebarOpen(false);
            }}
            currentView={currentView}
            activeTaskSessionIds={activeTasks}
            awaitingInputBySession={awaitingInputBySession}
            subagentsBySession={subagents}
            backgroundShellsBySession={backgroundShellsBySession}
            changesReadyBySession={changesReady}
            finalizeStatusBySession={finalizeStatusBySession}
            onOpenProject={openAdaptiveProjectWizard}
            onImportProject={openImportProjectWizard}
            onReorderProjects={handleReorderProjects}
            cronSessions={cronSessions}
            wikiProjectId={wikiProjectId}
            notesProjectId={notesProjectId}
            reviewerProjectId={reviewerProjectId}
            threadsProjectId={threadsProjectId}
            supportProjectId={supportProjectId}
            googleCalendarNavVisible={googleCalendarNavVisible}
            googleGmailNavVisible={googleGmailNavVisible}
            deploymentsProjectId={deploymentsProjectId}
            replaysProjectId={replaysProjectId}
            securityProjectId={securityProjectId}
            pullsProjectId={pullsProjectId}
            onOpenPrDetail={handleOpenPrDetail}
            workflowBadgeByProject={workflowSidebarBadgeByProject}
            unreadThreadCounts={unreadThreadCounts}
            unreadTicketCounts={unreadTicketCounts}
            openPullCounts={openPullCounts}
            securityOpenCounts={securityOpenCounts}
            skillImprovementCounts={skillImprovementCounts}
            activeReviews={activeReviews}
            electronSuppressHealthFetch={isElectron}
            electronHealthSnapshot={electronDesktopHealth}
            kanbanProjectId={currentView.startsWith('kanban:') ? currentView.split(':')[1] : null}
            kanbanProjectName={
              currentView.startsWith('kanban:')
                ? projects.find((p: any) => p.id === currentView.split(':')[1])?.name
                : null
            }
            kanbanSearchQuery={kanbanSearchQuery}
            onKanbanSearchChange={setKanbanSearchQuery}
            kanbanSelectedEpicIds={kanbanSelectedEpicIds}
            onKanbanSelectedEpicIdsChange={setKanbanSelectedEpicIds}
            kanbanAvailableLabels={kanbanAvailableLabels}
            kanbanSelectedLabels={kanbanSelectedLabels}
            onKanbanSelectedLabelsChange={setKanbanSelectedLabels}
            kanbanAssignableUsers={kanbanAssignableUsers}
            kanbanSelectedUserIds={kanbanSelectedUserIds}
            onKanbanSelectedUserIdsChange={setKanbanSelectedUserIds}
            kanbanCollapsedColumnIds={kanbanCollapsedColumnIds}
            onKanbanCollapsedColumnIdsChange={applyKanbanCollapsedColumnIds}
            onOpenKanbanEpics={() => {
              const projectId = currentView.split(':')[1];
              setCurrentView(`epics:${projectId}`);
              setSidebarOpen(false);
            }}
            kanbanRefreshKey={kanbanRefreshKey}
          />
        </div>

        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
          {/* Session top bar — only on an active chat session, not dashboard/kanban/etc. */}
          {!isWizardView(currentView) && (
            <>
              {currentView === 'chat' && activeSessionId ? (
                <>
                  <TopBar
                    agent={chatAgent}
                    accentColor={chatAccentColor}
                    onNewSession={handleNewSession}
                    onToggleSidebar={() => setSidebarOpen((prev: any) => !prev)}
                    sessionEngine={sessionEngine}
                    onEngineChange={handleEngineChange}
                    sessionModel={sessionModel}
                    onModelChange={handleModelChange}
                    sessionReasoningEffort={sessionReasoningEffort}
                    onReasoningEffortChange={handleReasoningEffortChange}
                    modelConfig={modelConfig}
                    messages={messages}
                    activeSessionId={activeSessionId}
                    activeSessionState={activeSessionState}
                    backgroundShellWatch={
                      activeSessionId
                        ? deriveWatchIndicator(backgroundShellsBySession[activeSessionId])
                        : null
                    }
                    projectId={
                      workflowEditRoute?.projectId ||
                      projects.find((p: any) => p.agents?.some((a: any) => a.id === activeAgentId))
                        ?.id
                    }
                    showToast={showToast}
                    onOpenForward={() => setShowForward(true)}
                    canForward={
                      !!activeSessionId && filterForwardTargets(agents, activeAgent).length > 0
                    }
                  />

                  <SessionSummarySidebar
                    sessionId={activeSessionId}
                    isLive={Boolean(streamingMsgId || activeTasks[activeSessionId])}
                    variant="top"
                    onOpenPrDetail={handleOpenPrDetail}
                    onOpenCard={(projectId: any, cardId: any) => {
                      if (!projectId) return;
                      if (cardId) setKanbanFocusCardId(cardId);
                      setCurrentView(`kanban:${projectId}`);
                      setSidebarOpen(false);
                    }}
                  />
                </>
              ) : (
                <div className="md:hidden flex items-center px-3 py-2 border-b border-gray-800 bg-gray-900/50 electron-no-drag">
                  <button
                    type="button"
                    onClick={() => setSidebarOpen((prev: any) => !prev)}
                    className="text-gray-400 hover:text-white p-2 min-w-[44px] min-h-[44px] flex items-center justify-center"
                    aria-label="Open sidebar"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-6 w-6"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 6h16M4 12h16M4 18h16"
                      />
                    </svg>
                  </button>
                </div>
              )}

              {currentView.startsWith('kanban:') ? (
                <KanbanBoard
                  projectId={currentView.split(':')[1]}
                  project={projects.find((p: any) => p.id === currentView.split(':')[1])}
                  agents={agents}
                  refreshKey={kanbanRefreshKey}
                  pendingCreateTemplate={kanbanPendingCreateTemplate}
                  onPendingCreateTemplateConsumed={() => {
                    setKanbanPendingCreateTemplate(null);
                  }}
                  searchQuery={kanbanSearchQuery}
                  selectedEpicIds={kanbanSelectedEpicIds}
                  onSelectedEpicIdsChange={setKanbanSelectedEpicIds}
                  selectedLabels={kanbanSelectedLabels}
                  onAvailableLabelsChange={setKanbanAvailableLabels}
                  selectedUserIds={kanbanSelectedUserIds}
                  assignableUsers={kanbanAssignableUsers}
                  onAssignableUsersChange={setKanbanAssignableUsers}
                  collapsedColumnIds={kanbanCollapsedColumnIds}
                  onCollapsedColumnIdsChange={applyKanbanCollapsedColumnIds}
                  onOpenEpics={() => {
                    const projectId = currentView.split(':')[1];
                    setCurrentView(`epics:${projectId}`);
                  }}
                  onOpenEpic={(epicId: any) => {
                    if (!epicId) return;
                    const projectId = currentView.split(':')[1];
                    setCurrentView(`epic:${projectId}:${epicId}`);
                  }}
                  onOpenTemplates={() => {
                    const projectId = currentView.split(':')[1];
                    setCurrentView(`kanban-templates:${projectId}`);
                  }}
                  focusCardId={kanbanFocusCardId}
                  onFocusCardConsumed={() => setKanbanFocusCardId(null)}
                  showToast={showToast}
                  onProjectsRefresh={() => {
                    // Re-pull the project list so derived flags reflect any
                    // server-side change. Errors are swallowed — callers
                    // surface their own error UI on the originating action.
                    api
                      .getProjects()
                      .then((data: any) => setProjects(data))
                      .catch(() => undefined);
                  }}
                  onNavigateToSession={(agentId: any, sessionId: any) => {
                    pendingSessionIdRef.current = sessionId;
                    setActiveAgentId(agentId);
                    setActiveSessionId(sessionId);
                    setCurrentView('chat');
                  }}
                />
              ) : currentView.startsWith('kanban-templates:') ? (
                <KanbanCardTemplatesView
                  projectId={currentView.slice('kanban-templates:'.length)}
                  project={projects.find(
                    (p: any) => p.id === currentView.slice('kanban-templates:'.length),
                  )}
                  refreshKey={kanbanRefreshKey}
                  onBackToBoard={() => {
                    const projectId = currentView.slice('kanban-templates:'.length);
                    setCurrentView(`kanban:${projectId}`);
                  }}
                  onUseTemplate={(template) => {
                    const projectId = currentView.slice('kanban-templates:'.length);
                    setKanbanPendingCreateTemplate(template);
                    setCurrentView(`kanban:${projectId}`);
                  }}
                />
              ) : currentView.startsWith('epics:') || currentView.startsWith('epic:') ? (
                <EpicView
                  projectId={
                    currentView.startsWith('epics:')
                      ? currentView.slice('epics:'.length)
                      : currentView.split(':')[1]
                  }
                  epicId={currentView.startsWith('epic:') ? currentView.split(':')[2] : null}
                  project={projects.find(
                    (p: any) =>
                      p.id ===
                      (currentView.startsWith('epics:')
                        ? currentView.slice('epics:'.length)
                        : currentView.split(':')[1]),
                  )}
                  agents={agents}
                  refreshKey={kanbanRefreshKey}
                  onNavigateToSession={(agentId: any, sessionId: any) => {
                    pendingSessionIdRef.current = sessionId;
                    setActiveAgentId(agentId);
                    setActiveSessionId(sessionId);
                    setCurrentView('chat');
                  }}
                  onBackToBoard={() => {
                    const projectId = currentView.startsWith('epics:')
                      ? currentView.slice('epics:'.length)
                      : currentView.split(':')[1];
                    setCurrentView(`kanban:${projectId}`);
                  }}
                  onOpenEpicsList={() => {
                    const projectId = currentView.startsWith('epics:')
                      ? currentView.slice('epics:'.length)
                      : currentView.split(':')[1];
                    setCurrentView(`epics:${projectId}`);
                  }}
                  onOpenEpic={(epicId: any) => {
                    const projectId = currentView.startsWith('epics:')
                      ? currentView.slice('epics:'.length)
                      : currentView.split(':')[1];
                    setCurrentView(`epic:${projectId}:${epicId}`);
                  }}
                  onOpenPull={(prNumber: any) => {
                    const projectId = currentView.startsWith('epics:')
                      ? currentView.slice('epics:'.length)
                      : currentView.split(':')[1];
                    handleOpenPrDetail(projectId, prNumber);
                  }}
                />
              ) : workflowEditRoute ? (
                <ProjectWorkflowBuilder
                  projectId={workflowEditRoute.projectId}
                  workflowId={workflowEditRoute.workflowId}
                  project={projects.find((p: any) => p.id === workflowEditRoute.projectId)}
                  projects={projects}
                  agents={agents}
                  onNavigate={navigateFromProjectWorkflows}
                  showToast={showToast}
                />
              ) : currentView.startsWith('workflows:') ? (
                <ProjectWorkflowsPage
                  projectId={currentView.slice('workflows:'.length)}
                  project={projects.find(
                    (p: any) => p.id === currentView.slice('workflows:'.length),
                  )}
                  onNavigate={navigateFromProjectWorkflows}
                  onSelectAgent={setActiveAgentId}
                  showToast={showToast}
                />
              ) : projectMenuRoute ? (
                <ProjectMenuPage
                  projectId={projectMenuRoute.projectId}
                  project={projects.find((p: any) => p.id === projectMenuRoute.projectId)}
                  tab={projectMenuRoute.tab}
                  projects={projects}
                  agents={agents}
                  onAgentsChange={refreshAgents}
                  onProjectsChange={refreshProjects}
                  onNavigate={(view: any, extra: any) => {
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
                    if (view === 'chat' && extra) {
                      focusAgentSession(extra.agentId, extra.sessionId);
                    }
                  }}
                  showToast={showToast}
                />
              ) : currentView.startsWith('runners:') ? (
                <div className="flex-1 overflow-y-auto p-4 md:p-6">
                  <FinalizeSettingsSection
                    projects={runnersScopedProjects}
                    onProjectsChange={refreshProjects}
                    onOpenSession={({ sessionId, agentId }: any) =>
                      focusAgentSession(agentId, sessionId)
                    }
                  />
                </div>
              ) : currentView.startsWith('stats:') ? (
                <div className="flex-1 overflow-y-auto p-4 md:p-6">
                  <ProjectStatsView projects={statsScopedProjects} />
                </div>
              ) : currentView.startsWith('devserver:') ? (
                <div className="flex-1 overflow-y-auto p-4 md:p-6">
                  <div className="max-w-4xl mx-auto">
                    <DevServerSection
                      projects={devServerScopedProjects}
                      onProjectsChange={refreshProjects}
                      onOpenSession={({ sessionId, agentId }: any) =>
                        focusAgentSession(agentId, sessionId)
                      }
                    />
                  </div>
                </div>
              ) : currentView.startsWith('rum:') ? (
                <div className="flex-1 overflow-y-auto p-4 md:p-6">
                  <div className="max-w-4xl mx-auto">
                    <RumSettingsSection
                      projects={rumScopedProjects}
                      onOpenSession={({ sessionId, agentId }: any) =>
                        focusAgentSession(agentId, sessionId)
                      }
                      showToast={showToast}
                    />
                  </div>
                </div>
              ) : currentView.startsWith('logs:') ? (
                (() => {
                  // Resolve the selected project by id (not positionally) so the
                  // Logs header and Sources tab always show the project named in
                  // the route, even in a multi-project workspace.
                  const logsProjectId = currentView.slice('logs:'.length);
                  const logsProject = projects.find((p: any) => p.id === logsProjectId);
                  return (
                    <div className="flex-1 overflow-hidden p-4 md:p-6">
                      <div className="mx-auto flex h-full max-w-6xl flex-col">
                        <LogsPage
                          projectId={logsProjectId}
                          projectName={logsProject?.name}
                          showToast={showToast}
                          onOpenSession={({ sessionId, agentId }: any) =>
                            focusAgentSession(agentId, sessionId)
                          }
                        />
                      </div>
                    </div>
                  );
                })()
              ) : currentView.startsWith('infra:') ? (
                (() => {
                  const infraProjectId = currentView.slice('infra:'.length);
                  const infraProject = projects.find((p: any) => p.id === infraProjectId);
                  return (
                    <div className="flex-1 overflow-hidden p-4 md:p-6">
                      <div className="mx-auto flex h-full max-w-6xl flex-col">
                        <InfrastructurePage
                          projectId={infraProjectId}
                          projectName={infraProject?.name}
                          project={infraProject}
                          showToast={showToast}
                          onOpenSession={({ sessionId, agentId }: any) =>
                            focusAgentSession(agentId, sessionId)
                          }
                        />
                      </div>
                    </div>
                  );
                })()
              ) : currentView.startsWith('aws:') ? (
                <div className="flex-1 overflow-y-auto p-4 md:p-6">
                  <div className="max-w-4xl mx-auto">
                    <h3 className="text-lg font-semibold mb-1">AWS</h3>
                    <p className="text-xs text-gray-500 mb-4">
                      IAM Identity Center (SSO) profiles for this project.
                    </p>
                    <ProjectAwsProfilesEditor projectId={currentView.slice('aws:'.length)} />
                  </div>
                </div>
              ) : currentView.startsWith('settings') ? (
                <SettingsPage
                  projects={projects}
                  agents={agents}
                  onAgentsChange={refreshAgents}
                  initialTab={currentView.includes(':') ? currentView.split(':')[1] : undefined}
                  initialGithubExpandedProjectId={settingsGithubExpandProjectId}
                  onNavigate={(view: any, extra: any) => {
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
                  onOpenSession={({ sessionId, agentId }: any) =>
                    focusAgentSession(agentId, sessionId)
                  }
                  showToast={showToast}
                  wsRef={wsRef}
                />
              ) : currentView === 'wiki' && wikiProjectId ? (
                <WikiBrowser projectId={wikiProjectId} apiBase={getApiBase()} />
              ) : currentView === 'notes' && notesProjectId ? (
                <NotesEditor projectId={notesProjectId} />
              ) : currentView === 'reviewer' && reviewerProjectId ? (
                <ReviewerPage
                  projectId={reviewerProjectId}
                  projects={projects}
                  onAgentsChange={refreshAgents}
                />
              ) : currentView === 'threads' && threadsProjectId ? (
                activeThreadId ? (
                  <ThreadView
                    ref={threadViewRef}
                    key={activeThreadId}
                    threadId={activeThreadId}
                    thread={activeThread}
                    agents={agents}
                    onForwarded={(result: any) => {
                      const session = result?.session;
                      showToast(
                        `Forwarded to ${session?.name || 'a new session'}`,
                        'success',
                        4000,
                      );
                    }}
                    onBack={() => {
                      setActiveThreadId(null);
                      setActiveThread(null);
                    }}
                  />
                ) : (
                  <ThreadList
                    ref={threadListRef}
                    projectId={threadsProjectId}
                    onSelectThread={(thread: any) => {
                      if (isRetiredHeartbeatThread(thread)) return;
                      setActiveThreadId(thread.id);
                      setActiveThread(thread);
                    }}
                  />
                )
              ) : currentView === 'support' && supportProjectId ? (
                <CustomerSupportPage
                  ref={supportListRef}
                  projectId={supportProjectId}
                  initialTicketId={supportTicketId}
                  agents={agents.filter((a: any) => a.projectId === supportProjectId)}
                  modelConfig={modelConfig}
                  onNotify={(message: any, type: any = 'info') => showToast(message, type, 8000)}
                  onOpenCard={(cardId: any) => {
                    if (!cardId) return;
                    setKanbanFocusCardId(cardId);
                    setCurrentView(`kanban:${supportProjectId}`);
                    setSidebarOpen(false);
                  }}
                />
              ) : currentView === 'hub' ||
                currentView === 'home' ||
                currentView === 'dashboard' ||
                currentView === 'todos' ||
                currentView === 'calendar' ||
                currentView === 'gmail' ||
                currentView === 'support-overview' ? (
                <HubPage
                  pane={
                    currentView === 'hub'
                      ? hubPane
                      : parseHubPane(hubPaneFromLegacyView(currentView) || hubPane)
                  }
                  onPaneChange={(pane) => {
                    setCurrentView('hub');
                    setHubPane(pane);
                    setHubMobileTab(pane);
                  }}
                  mobileAssistantTab
                  mobileTab={hubMobileTab}
                  onMobileTabChange={setHubMobileTab}
                  assistantActions={hubClearButton}
                  today={
                    <PersonalDashboard
                      onNavigate={(view: any) => {
                        const pane = hubPaneFromLegacyView(view);
                        if (pane) {
                          setCurrentView('hub');
                          setHubPane(pane);
                          setHubMobileTab(pane);
                          return;
                        }
                        setCurrentView(view);
                      }}
                      onOpenAccountSettings={() => setCurrentView('settings:account')}
                      onOpenKanban={(projectId: any) => {
                        setCurrentView(`kanban:${projectId}`);
                        setSidebarOpen(false);
                      }}
                    />
                  }
                  summary={
                    <DailySummaryPage
                      onOpenCard={(projectId, cardId) => {
                        setKanbanFocusCardId(cardId);
                        setCurrentView(`kanban:${projectId}`);
                        setSidebarOpen(false);
                      }}
                      onOpenSession={(agentId, sessionId) => {
                        focusAgentSession(agentId, sessionId);
                      }}
                      onOpenTodos={() => {
                        setCurrentView('hub');
                        setHubPane('todos');
                        setHubMobileTab('todos');
                      }}
                      onOpenProject={(projectId) => {
                        setCurrentView(`kanban:${projectId}`);
                        setSidebarOpen(false);
                      }}
                    />
                  }
                  org={
                    <DashboardView
                      orgId={getActiveOrgApiId()}
                      onNavigate={setCurrentView}
                      onNewProject={openAdaptiveProjectWizard}
                      onOpenSession={(agentId: any, sessionId: any) =>
                        focusAgentSession(agentId, sessionId)
                      }
                      onOpenKanban={(projectId: any) => {
                        setCurrentView(`kanban:${projectId}`);
                        setSidebarOpen(false);
                      }}
                      onOpenPulls={(projectId: any) => {
                        setPullsProjectId(projectId);
                        setCurrentView('pulls');
                        setSidebarOpen(false);
                      }}
                      onOpenExternalUrl={(url: any) => {
                        window.open(url, '_blank', 'noopener,noreferrer');
                      }}
                      onOpenProjectSupport={(projectId: any) => {
                        setSupportProjectId(projectId);
                        setSupportTicketId(null);
                        setCurrentView('support');
                        setSidebarOpen(false);
                      }}
                    />
                  }
                  todos={<TodosPage />}
                  calendar={
                    <CalendarAgendaPage
                      onOpenAccountSettings={() => setCurrentView('settings:account')}
                    />
                  }
                  mail={
                    <GmailPage onOpenAccountSettings={() => setCurrentView('settings:account')} />
                  }
                  support={
                    <SupportOverviewPage
                      onOpenProjectSupport={(projectId: any, ticketId: any = null) => {
                        setSupportProjectId(projectId);
                        setSupportTicketId(ticketId);
                        setCurrentView('support');
                        setSidebarOpen(false);
                      }}
                    />
                  }
                  assistant={hubAssistantChat}
                />
              ) : currentView === 'deployments' && deploymentsProjectId ? (
                <DeploymentsPage
                  projectId={deploymentsProjectId}
                  onNotify={(message: any, type: any = 'info') => showToast(message, type, 8000)}
                  onOpenSession={({ sessionId, agentId }: any) => {
                    if (sessionId) focusAgentSession(agentId, sessionId);
                  }}
                />
              ) : currentView === 'replays' && replaysProjectId ? (
                <ReplaysDashboardPage
                  projectId={replaysProjectId}
                  onNotify={(message: any, type: any = 'info') => showToast(message, type, 8000)}
                />
              ) : currentView === 'security' && securityProjectId ? (
                <SecurityPage
                  projectId={securityProjectId}
                  refreshNonce={securityRefreshNonce}
                  onOpenCounts={(counts: any) =>
                    setSecurityOpenCounts((prev: any) => ({ ...prev, [securityProjectId]: counts }))
                  }
                  onNotify={(message: any, type: any = 'info') => showToast(message, type, 8000)}
                />
              ) : currentView === 'pulls' && pullsProjectId ? (
                <PullRequestsPage
                  projectId={pullsProjectId}
                  project={projects.find((p: any) => p.id === pullsProjectId)}
                  listRefreshNonce={pullsListRefreshNonce}
                  initialPrNumber={pullsOpenPrNumber}
                  onPrNumberChange={(prNumber: any) => setPullsOpenPrNumber(prNumber ?? null)}
                  onOpenSession={handleOpenHandoffSession}
                  onToast={showToast}
                  onOpenCard={(cardId: any) => {
                    if (cardId) setKanbanFocusCardId(cardId);
                    setCurrentView(`kanban:${pullsProjectId}`);
                  }}
                  onOpenEpic={(epicId: any) => setCurrentView(`epic:${pullsProjectId}:${epicId}`)}
                />
              ) : currentView.startsWith('repo:') ? (
                <RepositoryPage
                  projectId={currentView.slice('repo:'.length)}
                  project={projects.find((p: any) => p.id === currentView.slice('repo:'.length))}
                  onOpenPulls={(projectId: any) => {
                    setPullsProjectId(projectId);
                    setCurrentView('pulls');
                  }}
                  onToast={showToast}
                />
              ) : currentView === 'releases' ? (
                <ReleasesView />
              ) : currentView.startsWith('skills:') ? (
                <SkillsPage
                  agents={agents}
                  projects={projects}
                  initialProjectId={currentView.slice('skills:'.length)}
                  onStartSkillBuilderMode={handleStartSkillBuilderMode}
                  onOpenSession={({ sessionId, agentId }: any) =>
                    focusAgentSession(agentId, sessionId)
                  }
                />
              ) : currentView === 'designs' ? (
                <DesignsList
                  designs={designs}
                  projects={projects}
                  onNavigate={(view: any, extra: any) => {
                    // Migrated designs redirect to their design-mode session
                    // instead of opening the (read-only) standalone canvas.
                    if (view === 'design' && extra) {
                      const target = designs.find((d: any) => d.id === extra);
                      const redirect = resolveDesignRedirect(target);
                      if (redirect) {
                        focusAgentSession(undefined, redirect.sessionId);
                        return;
                      }
                      setActiveDesignId(extra);
                    }
                    setCurrentView(view);
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
                  onManualReload={() => setDesignReloadToken((t: any) => t + 1)}
                  showToast={showToast}
                  onDesignRecordUpdated={(d: any) =>
                    setDesigns((prev: any) =>
                      prev.map((x: any) => (x.id === d.id ? { ...x, ...d } : x)),
                    )
                  }
                  agents={agents}
                  onDesignForwarded={(result: any) => {
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
                      modelConfig={modelConfig}
                      onUpdated={handleSessionAgentsUpdated}
                    />
                  )}
                  <div className="relative flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden lg:flex-row">
                    {showSessionTimeline && (
                      <SessionTimelineSidebar
                        sessionId={activeSessionId}
                        messages={messages}
                        selectedAnchorId={selectedTimelineAnchor}
                        onSelectAnchor={scrollToTimelineAnchor}
                        onClose={() => {
                          if (!activeSessionId) return;
                          setTimelinePaneOpenBySession((prev: any) => ({
                            ...prev,
                            [activeSessionId]: false,
                          }));
                          writeTimelinePaneOpen(activeSessionId, false);
                        }}
                      />
                    )}
                    <div className="flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden">
                      {/* Messages */}
                      <RunInTerminalProvider onRun={runInTerminalHandler}>
                        <div
                          ref={scrollContainerRef}
                          onScroll={handleScrollEvent}
                          data-testid="chat-scroll-container"
                          className="flex-1 overflow-y-auto p-3 md:p-6 relative border-t-2"
                          // `overflowAnchor: none` hands scroll-position ownership entirely to
                          // the JS in this component (auto-follow tail-pin + manual prepend
                          // restore). Left at the browser default `auto`, native scroll
                          // anchoring *also* shifts scrollTop when an older page is prepended
                          // above the viewport — fighting `restoredScrollTop` across frames and
                          // producing the rapid back-and-forth scroll jitter on load-older.
                          style={{ borderTopColor: chatAccentColor, overflowAnchor: 'none' }}
                        >
                          <div className="mx-auto" ref={messagesColumnRef}>
                            {/* Reverse-infinite-scroll: spinner shown at the top
                      while an older page is being fetched on scroll-up. */}
                            {loadingOlderMessages && (
                              <div
                                className="flex items-center justify-center gap-2 py-3 text-xs text-gray-500"
                                data-testid="chat-loading-older"
                              >
                                <Loader2 size={14} className="animate-spin" />
                                <span>Loading earlier messages…</span>
                              </div>
                            )}
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
                                    <Loader2
                                      size={40}
                                      className="mb-4 text-gray-500 animate-spin"
                                    />
                                    <p className="text-lg">Loading conversation</p>
                                    <p className="text-sm mt-1 text-gray-500">Fetching messages…</p>
                                  </>
                                ) : activeSessionWorkspaceEnsureError ? (
                                  <>
                                    <AlertTriangle size={40} className="mb-4 text-amber-500" />
                                    <p className="text-lg">Couldn't set up this session</p>
                                    <p className="text-sm mt-1 text-gray-500 max-w-md">
                                      {activeSessionWorkspaceEnsureError}
                                    </p>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        activeSessionId &&
                                        retrySessionWorkspaceEnsure(activeSessionId)
                                      }
                                      className="mt-4 px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 text-gray-100 text-sm"
                                    >
                                      Retry
                                    </button>
                                  </>
                                ) : !activeSessionComposerWorkspaceReady ? (
                                  <>
                                    <Loader2
                                      size={40}
                                      className="mb-4 text-gray-500 animate-spin"
                                    />
                                    <p className="text-lg">Setting up this session</p>
                                    <p className="text-sm mt-1 text-gray-500">
                                      Preparing the workspace and environment…
                                    </p>
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
                                          Type a message below to ask a question, hand off a task,
                                          or pair on changes — replies stream in real time.
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
                                (messageQueues[activeSessionId] || []).map((q: any) => q.id),
                              );
                              // Render non-queued messages inline, queued messages stick to bottom
                              const nonQueued = messages.filter(
                                (msg: any) => !queuedIds.has(msg.id),
                              );
                              const queued = messages.filter((msg: any) => queuedIds.has(msg.id));
                              return (
                                <>
                                  {nonQueued.map((msg: any) =>
                                    msg.role === 'assistant' ? (
                                      <SessionTail
                                        key={msg.id}
                                        message={msg}
                                        events={eventsByMessage[msg.id]}
                                        agentColor={msg.agent_color || chatAccentColor}
                                        agentName={activeAgent?.name}
                                        onEventsLoaded={handleEventsLoaded}
                                        onAskSubmit={handleAskSubmit}
                                        onCredentialSubmit={handleCredentialSubmit}
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
                                        projectId={activeChatProject?.id}
                                        hosted={activeChatProject?.gitHost === 'agenthub'}
                                        onOpenPrDetail={handleOpenPrDetail}
                                        onStartFollowUp={() =>
                                          handleStartFollowUpSession(activeSessionId)
                                        }
                                      />
                                    ),
                                  )}
                                  {activeSessionId &&
                                  activeChatProject?.id &&
                                  !chatProjectIsWorkflow ? (
                                    <FinalizeChecksLiveBlock
                                      sessionId={activeSessionId}
                                      projectId={activeChatProject.id}
                                    />
                                  ) : null}
                                  {sessionRoundProcessing && (
                                    <div className="px-3 md:px-0 mb-3 max-w-[95%] sm:max-w-[90%] mx-auto">
                                      <div className="text-xs text-amber-400/90 bg-amber-950/20 border border-amber-800/40 rounded-lg px-3 py-2">
                                        Multi-agent round in progress…
                                      </div>
                                    </div>
                                  )}
                                  {activeSessionId &&
                                    (backgroundShellsBySession[activeSessionId]?.length ?? 0) >
                                      0 && (
                                      <div className="px-3 md:px-0 mb-3 max-w-[95%] sm:max-w-[90%] mx-auto">
                                        <BackgroundShellsPanel
                                          sessionId={activeSessionId}
                                          shells={backgroundShellsBySession[activeSessionId]}
                                          onOpenTerminal={(shellId) => {
                                            setTerminalPaneOpenBySession((prev: any) => ({
                                              ...prev,
                                              [activeSessionId]: true,
                                            }));
                                            setDiffPaneOpenBySession((prev: any) => ({
                                              ...prev,
                                              [activeSessionId]: false,
                                            }));
                                            setArtifactsPaneOpenBySession((prev: any) => ({
                                              ...prev,
                                              [activeSessionId]: false,
                                            }));
                                            if (shellId) {
                                              setTerminalActiveTabBySession((prev) => ({
                                                ...prev,
                                                [activeSessionId]: shellId,
                                              }));
                                            }
                                          }}
                                        />
                                      </div>
                                    )}
                                  {/* Streaming assistant turn — always render via
                                    SessionTail (Cursor-style thin stripe). The legacy
                                    heavy grey cross-agent bubble was removed from web:
                                    it mistriggered whenever the streaming agent differed
                                    from the active agent and dumped raw narration text.
                                    Mobile keeps its own StreamingMessage bubble.
                                    Hub reuses the same liveStreamingAssistantTurn. */}
                                  {liveStreamingAssistantTurn}
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
                                          onCancel={(sid: any) =>
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
                                        onOpenPrDetail={handleOpenPrDetail}
                                        onDismiss={(sessionId: any) => {
                                          setChangesReady((prev: any) => {
                                            const next = { ...prev };
                                            delete next[sessionId];
                                            return next;
                                          });
                                        }}
                                      />
                                    )}
                                  {/* Queued messages always render at the very bottom */}
                                  {queued.map((msg: any) => (
                                    <ChatMessage
                                      key={msg.id}
                                      message={{ ...msg, queued: true }}
                                      agentColor={chatAccentColor}
                                      projectId={activeChatProject?.id}
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
                      </RunInTerminalProvider>

                      {/* Show-preview pill — visible only when there's a
                        preview event for this session but the user has
                        closed the pane. One-click reopen. */}
                      {activeSessionId &&
                        !chatProjectIsWorkflow &&
                        activePreviewEvent &&
                        previewPaneOpenBySession[activeSessionId] === false && (
                          <div className="px-3 md:px-6 pb-1">
                            <button
                              type="button"
                              data-testid="reopen-preview-pane"
                              onClick={() => {
                                setPreviewPaneOpenBySession((prev: any) => ({
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
                        <div className="shrink-0 border-t border-gray-800/80">
                          <div className="px-3 md:px-6 pb-2 flex flex-wrap justify-center gap-2 sm:flex-nowrap sm:justify-start sm:items-center pt-2">
                            <SessionActionsMenu
                              inline={chatProjectIsWorkflow}
                              items={[
                                {
                                  id: 'timeline',
                                  testId: 'toggle-timeline-pane',
                                  label: 'Timeline',
                                  icon: History,
                                  title: 'Show or hide the session timeline',
                                  pressed: showSessionTimeline,
                                  badge: timelineMarkerCount,
                                  onSelect: () => {
                                    if (!activeSessionId) return;
                                    const opening = !showSessionTimeline;
                                    setTimelinePaneOpenBySession((prev: any) => ({
                                      ...prev,
                                      [activeSessionId]: opening,
                                    }));
                                    writeTimelinePaneOpen(activeSessionId, opening);
                                  },
                                },
                                {
                                  id: 'changes',
                                  testId: 'toggle-changes-pane',
                                  label: 'Changes',
                                  icon: GitBranch,
                                  title: 'View session file changes',
                                  hidden: !shouldShowSessionChangesButton({
                                    isWorkflowProject: chatProjectIsWorkflow,
                                    consultActive: sessionConsultActive,
                                    session: activeSession,
                                  }),
                                  pressed: showSessionDiffPane,
                                  badge: diffFileCountBySession[activeSessionId],
                                  onSelect: () => {
                                    const opening = !diffPaneOpenBySession[activeSessionId];
                                    setDiffPaneOpenBySession((prev: any) => ({
                                      ...prev,
                                      [activeSessionId]: opening,
                                    }));
                                    if (opening) {
                                      setArtifactsPaneOpenBySession((prev: any) => ({
                                        ...prev,
                                        [activeSessionId]: false,
                                      }));
                                      setTerminalPaneOpenBySession((prev: any) => ({
                                        ...prev,
                                        [activeSessionId]: false,
                                      }));
                                    }
                                  },
                                },
                                {
                                  id: 'artifacts',
                                  testId: 'toggle-artifacts-pane',
                                  label: 'Artifacts',
                                  icon: Package,
                                  title: 'View documents the agent generated',
                                  pressed: showSessionArtifactsPane,
                                  badge: artifactCountBySession[activeSessionId],
                                  onSelect: () => {
                                    const opening = !artifactsPaneOpenBySession[activeSessionId];
                                    setArtifactsPaneOpenBySession((prev: any) => ({
                                      ...prev,
                                      [activeSessionId]: opening,
                                    }));
                                    if (opening) {
                                      setDiffPaneOpenBySession((prev: any) => ({
                                        ...prev,
                                        [activeSessionId]: false,
                                      }));
                                      setTerminalPaneOpenBySession((prev: any) => ({
                                        ...prev,
                                        [activeSessionId]: false,
                                      }));
                                    }
                                  },
                                },
                                {
                                  id: 'terminal',
                                  testId: 'toggle-terminal-pane',
                                  label: 'Terminal',
                                  icon: SquareTerminal,
                                  title:
                                    'Shared session terminal — docks under preview when one is running',
                                  hidden: chatProjectIsWorkflow || sessionConsultActive,
                                  pressed: terminalRequested,
                                  onSelect: () => {
                                    const opening = !terminalPaneOpenBySession[activeSessionId];
                                    setTerminalPaneOpenBySession((prev: any) => ({
                                      ...prev,
                                      [activeSessionId]: opening,
                                    }));
                                    if (opening) {
                                      setDiffPaneOpenBySession((prev: any) => ({
                                        ...prev,
                                        [activeSessionId]: false,
                                      }));
                                      setArtifactsPaneOpenBySession((prev: any) => ({
                                        ...prev,
                                        [activeSessionId]: false,
                                      }));
                                    }
                                  },
                                },
                              ]}
                            >
                              {!chatProjectIsWorkflow && (
                                <SessionPreviewStartButton
                                  variant="menu"
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
                              )}
                              {activeSessionId && activeChatProject?.id ? (
                                <AwsSsoLoginMenu
                                  variant={chatProjectIsWorkflow ? 'toolbar' : 'menu'}
                                  projectId={activeChatProject.id}
                                  project={activeChatProject}
                                  disabled={!connected}
                                  onError={(msg: any) => showToast(msg, 'error', 8000)}
                                />
                              ) : null}
                            </SessionActionsMenu>
                            {!chatProjectIsWorkflow && !sessionConsultActive && (
                              <SessionBranchPicker
                                sessionId={activeSessionId}
                                session={activeSession}
                                projectId={activeChatProject?.id}
                                disabled={!connected || !activeChatProject}
                                onError={(msg: any) => showToast(msg, 'error', 8000)}
                              />
                            )}
                            {activeSessionId && activeChatProject?.id ? (
                              <>
                                <FinalizeAutomationSelect
                                  sessionId={activeSessionId}
                                  session={activeSession}
                                  agent={activeAgent}
                                  project={activeChatProject}
                                  disabled={!connected}
                                  legacyAskMode={Number(activeSession?.ask_mode ?? 0) !== 0}
                                  onControlChange={handleSessionControlChange}
                                  onError={(msg: any) => showToast(msg, 'error', 8000)}
                                />
                                {!chatProjectIsWorkflow && !sessionConsultActive && (
                                  <FinalizeButton
                                    projectId={activeChatProject.id}
                                    cardId={activeSession?.card_id ?? null}
                                    sessionId={activeSessionId}
                                    branchLabel={activeSession?.worktree_branch || ''}
                                    pendingChanges={changesReady[activeSessionId] ?? null}
                                    onError={(msg: any) => showToast(msg, 'error', 8000)}
                                    hosted={activeChatProject?.gitHost === 'agenthub'}
                                    isResolveSession={isResolvePrSessionTitle(activeSession?.name)}
                                  />
                                )}
                              </>
                            ) : null}
                          </div>
                        </div>
                      )}

                      {/* Input */}
                      <div className="shrink-0">
                        {activeSessionWorkspaceEnsureError && messages.length > 0 && (
                          <div className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-amber-700/50 bg-amber-900/20 px-3 py-2 text-sm text-amber-200">
                            <AlertTriangle size={16} className="shrink-0 text-amber-400" />
                            <span className="flex-1 min-w-0 truncate">
                              Couldn't set up this session's environment.
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                activeSessionId && retrySessionWorkspaceEnsure(activeSessionId)
                              }
                              className="shrink-0 rounded bg-amber-700/60 hover:bg-amber-700 px-2.5 py-1 text-amber-50"
                            >
                              Retry
                            </button>
                          </div>
                        )}
                        <MessageInput
                          ref={messageInputRef}
                          onSend={handleSend}
                          onCancel={handleCancel}
                          disabled={shouldDisableSessionComposer({
                            hasAgent: !!activeAgent,
                            connected,
                            workspaceEnsureFailed: !!activeSessionWorkspaceEnsureError,
                          })}
                          isProcessing={isProcessing}
                          queueLength={(messageQueues[activeSessionId] || []).length}
                          agentColor={chatAccentColor}
                          skills={skills}
                          consultMode={sessionConsultActive}
                          readOnly={activeAgent?.role === 'reviewer'}
                          draftKey={activeSessionId || activeAgentId || 'none'}
                          onFileError={(msg: any) => showToast(msg, 'error', 6000)}
                          composerPrefill={composerPrefill}
                          onComposerPrefillClear={() => setComposerPrefill(null)}
                          onReplaceQueuedMessage={handleEditQueuedMessage}
                          sessionAgents={sessionAgents}
                          enableMentions={sessionAgents.length > 1}
                        />
                      </div>
                    </div>
                    {showSessionPreviewPane && (
                      <SessionPreviewPane
                        sessionId={activeSessionId}
                        event={activePreviewEvent}
                        onClose={handlePreviewClose}
                        onTouch={handlePreviewTouch}
                        onStop={handlePreviewStop}
                        onConfigure={handlePreviewConfigure}
                        footerTab={previewFooterTab}
                        onFooterTabChange={(tab: 'boot' | 'terminal') => {
                          setTerminalPaneOpenBySession((prev: any) => ({
                            ...prev,
                            [activeSessionId]: tab === 'terminal',
                          }));
                        }}
                        terminal={
                          !chatProjectIsWorkflow && !sessionConsultActive ? (
                            <Suspense
                              fallback={
                                <div className="flex h-full items-center justify-center">
                                  <Loader2 size={16} className="animate-spin text-cyan-300" />
                                </div>
                              }
                            >
                              {renderSessionTerminalPane(true)}
                            </Suspense>
                          ) : null
                        }
                      />
                    )}
                    {showSessionDiffPane && (
                      <Suspense
                        fallback={
                          <aside className="hidden lg:flex items-center justify-center shrink-0 border-l border-gray-800 bg-gray-950 w-[720px]">
                            <Loader2 size={18} className="animate-spin text-sky-300" />
                          </aside>
                        }
                      >
                        <SessionChangesPane
                          sessionId={activeSessionId}
                          reloadToken={codeChangedTickBySession[activeSessionId] || 0}
                          onClose={() =>
                            setDiffPaneOpenBySession((prev: any) => ({
                              ...prev,
                              [activeSessionId]: false,
                            }))
                          }
                          onSummary={(s: any) =>
                            setDiffFileCountBySession((prev: any) =>
                              setSessionFileCount(
                                prev,
                                activeSessionId,
                                fileCountFromChangesSummary(s),
                              ),
                            )
                          }
                        />
                      </Suspense>
                    )}
                    {showSessionArtifactsPane && (
                      <Suspense
                        fallback={
                          <aside className="hidden lg:flex items-center justify-center shrink-0 border-l border-gray-800 bg-gray-950 w-[420px]">
                            <Loader2 size={18} className="animate-spin text-violet-300" />
                          </aside>
                        }
                      >
                        <SessionArtifactsPane
                          sessionId={activeSessionId}
                          reloadToken={artifactTickBySession[activeSessionId] || 0}
                          presentedArtifact={presentedArtifactBySession[activeSessionId] || null}
                          onPresentedArtifact={(sessionId: any, artifactId: any) =>
                            setPresentedArtifactBySession((prev: any) => {
                              if (prev[sessionId]?.id !== artifactId) return prev;
                              const next = { ...prev };
                              delete next[sessionId];
                              return next;
                            })
                          }
                          onClose={() =>
                            setArtifactsPaneOpenBySession((prev: any) => ({
                              ...prev,
                              [activeSessionId]: false,
                            }))
                          }
                          onCount={(n: any) =>
                            setArtifactCountBySession((prev: any) =>
                              prev[activeSessionId] === n
                                ? prev
                                : { ...prev, [activeSessionId]: n },
                            )
                          }
                        />
                      </Suspense>
                    )}
                    {showSessionTerminalPane && (
                      <Suspense
                        fallback={
                          <aside className="hidden lg:flex items-center justify-center shrink-0 border-l border-gray-800 bg-gray-950 w-[600px]">
                            <Loader2 size={18} className="animate-spin text-cyan-300" />
                          </aside>
                        }
                      >
                        {renderSessionTerminalPane(false)}
                      </Suspense>
                    )}
                    {linkedDesign && (
                      <SessionDesignPane
                        sessionId={activeSessionId}
                        design={linkedDesign}
                        reloadToken={sessionDesignReloadToken}
                        onUnlink={handleUnlinkSessionDesign}
                        onOpenStudio={handleOpenLinkedDesignStudio}
                        onManualReload={() => setSessionDesignReloadToken((t: any) => t + 1)}
                      />
                    )}
                    {designModeActive && (
                      <SessionDesignModePane
                        sessionId={activeSessionId}
                        reloadToken={
                          (codeChangedTickBySession[activeSessionId] || 0) + designModeManualReload
                        }
                        busy={isProcessing || Boolean(activeTasks[activeSessionId])}
                        onManualReload={() => setDesignModeManualReload((n: any) => n + 1)}
                      />
                    )}
                    {scopingModeActive && (
                      <SessionScopingModePane
                        sessionId={activeSessionId}
                        projectId={activeChatProject?.id}
                        linkedEpicId={activeSession?.linked_epic_id ?? null}
                        agent={chatAgent}
                        sessionEngine={sessionEngine}
                        sessionModel={sessionModel}
                        onLinkEpic={handleLinkScopingEpic}
                        onOpenEpic={(epicId: any) => {
                          const projectId = activeChatProject?.id;
                          if (projectId && epicId) {
                            setCurrentView(`epic:${projectId}:${epicId}`);
                          }
                        }}
                        reloadToken={kanbanRefreshKey}
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
            onSelect={(id: any) => {
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
            modelConfig={modelConfig}
            onClose={() => setShowForward(false)}
            onForward={({ targetAgentId, prompt, autoStart, model }: any) =>
              api.forwardSession(activeSessionId, { targetAgentId, prompt, autoStart, model })
            }
            onForwarded={(result: any) => {
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
            onError={(msg: any) => showToast(`Forward failed: ${msg}`, 'error', 6000)}
          />
        )}

        {/* Link a Design Studio design to the active session */}
        {showLinkDesign && activeSessionId && (
          <LinkDesignModal
            designs={designs}
            currentDesignId={activeSession?.linked_design_id ?? null}
            onClose={() => setShowLinkDesign(false)}
            onSelect={handleLinkSessionDesign}
            onUnlink={handleUnlinkSessionDesign}
          />
        )}

        {/* First-run setup wizard */}
        {showSetup && setupStatus && (
          <SetupWizard
            setupStatus={setupStatus}
            initialStep={setupInitialStep}
            includeFirstProject={setupIncludeFirstProject}
            onComplete={async () => {
              // Owner instance onboarding: persist the flag before tearing
              // the wizard down. If the write fails, leave the step mounted
              // so the button becomes Retry. Invited User/Admin walkthroughs
              // skip this call — they cannot mark instance onboarding done.
              if (setupIncludeFirstProject) {
                await api.completeSetup();
              }
              setShowSetup(false);
              setSetupInitialStep(1);
              if (setupIncludeFirstProject) {
                openAdaptiveProjectWizard();
              }
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
            modelConfig={modelConfig}
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
              onProjectCreated={(payload: any) => {
                if (payload?.action === 'import') {
                  setCurrentView('import-project-wizard');
                  setSidebarOpen(false);
                  return;
                }
                refreshAgents();
                if (payload?.action === 'session' && payload.sessionId) {
                  focusAgentSession(payload.agentId, payload.sessionId);
                  return;
                }
                if (payload?.action === 'task' && payload.projectId) {
                  setCurrentView(`kanban:${payload.projectId}`);
                  setSidebarOpen(false);
                  return;
                }
                if (payload?.action === 'session' && payload.sessionId) {
                  // First build kicked off — open its chat instead of
                  // bouncing back to whatever view launched the wizard.
                  focusAgentSession(payload.agentId, payload.sessionId);
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
            {toasts.map((toast: any) => (
              <Toast
                key={toast.id}
                toast={toast}
                onDismiss={() =>
                  setToasts((prev: any) => prev.filter((t: any) => t.id !== toast.id))
                }
              />
            ))}
          </div>
        )}
      </div>
      {/* close flex row wrapper */}
    </div>
  );
}

function Toast({ toast, onDismiss }: any) {
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
  } as Record<string, any>;
  const icons = {
    info: <Info size={18} />,
    success: <CheckCircle size={18} />,
    error: <AlertTriangle size={18} />,
  } as Record<string, any>;

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
          ? (e: any) => {
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
        onClick={(e: any) => {
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
