import { createUseAiSignInGuide } from '@shared/hooks/useAiSignInGuide';
import { resolveComputerToolEnabled } from '@shared/utils/computerTool';
import { promoteQueuedMessage } from '@shared/utils/promoteQueuedMessage';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {
  createContext,
  useState,
  useCallback,
  useEffect,
  useContext,
  useMemo,
  useRef,
} from 'react';
import { Alert } from 'react-native';
import { api } from '../utils/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { extractSubmittedAskIds } from '../utils/askAnswers';
import { loadOrgs, migrateFromLegacy, getOrgs, getActiveOrg } from '../utils/orgs';
import { createOrgDataGeneration, shouldLoadOrgData } from '../utils/orgDataLoad';
import { applyPreviewEvent } from '../utils/previewEvents';
import { withRestoredSession } from '../utils/sessionRestore';
import { createOrgSwitcher } from '../utils/orgSwitch';
import {
  loadConnectionConfig,
  getApiBaseUrl,
  getAuthHeaders,
  getServerBaseUrl,
} from '../utils/config';
import {
  loadAuthToken,
  isAuthenticated,
  getAuthStatus,
  getAuthRecord,
  needsEmailUpdate,
  onDeadSession,
  loginTokenForServer,
} from '../utils/auth';
import { signOutOfServer as signOutOfServerFlow } from '../utils/serverSignOut';
import {
  answerPushApproval,
  pushSource,
  routePushTap,
  UNKNOWN_SERVER_MESSAGE,
  type ServerPushDeps,
} from '../utils/serverPush';
import { createPushRegistrar } from '../utils/pushRegistrar';
import {
  loadSetupDismissed,
  saveSetupDismissed,
  shouldShowWizard,
  shouldGateLoginAfterSetup,
  shouldGateAuthFromStatus,
} from '../utils/setupState';
import { hydrateChangesReady } from '../utils/changesReady';
import { applyDetectedFlag } from '../utils/worktreeState';
import { isWorkflowProject } from '../utils/project-mode';
import { isSessionConsultModeEnabled } from '../utils/sessionDerivedState';
import {
  selectSessionToActivate,
  deepLinkFetchId,
  upsertSessionRow,
} from '../utils/sessionSelection';
import { registerForPushNotifications, presentLocalNotification } from '../utils/push';
import { mapBroadcastToNotification } from '../utils/ticketNotifications';
import {
  routeNotificationTap,
  routeInboxNotification,
  notificationRouteToNavigation,
} from '../utils/notificationRouting';
import {
  notificationInboxAccountGate,
  notificationInboxStore,
} from '../utils/notificationInboxInstance';
import { NOTIFICATION_WS_EVENTS } from '../utils/notificationInboxStore';
import { APPROVAL_WS_EVENTS } from '@shared/utils/approvals';
import { approvalEvents } from '../utils/approvalEvents';
import {
  listenForNotificationResponses,
  registerApprovalPushCategory,
} from '../utils/approvalPush';
import type { InboxNotification } from '@shared/utils/notificationInbox';
import { foregroundBannerAllowed, loadNotificationPrefs } from '../utils/notificationPreferences';
import { hubChatAccountGate, hubChatStore } from '../utils/hubChatInstance';
import { HUB_CHAT_WS_EVENTS } from '../utils/hubChatStore';
import { uploadAttachments } from '../utils/uploadAttachments';
import { coalescePromiseByKey } from '@shared/utils/coalesceInFlight';
import { coalesceRefreshByKey, type PendingRefresh } from '@shared/utils/coalesceRefresh';
import { createReloadMessages } from '../utils/sessionReload';
import { deriveSessionState } from '../utils/deriveSessionState';
import {
  firstEngineWithAuthenticatedModels,
  defaultModelForAuthenticatedEngine,
} from '../utils/authModelEngines';
import { HUB_ASSISTANT_AGENT_ID } from '@shared/utils/hub';
import { mergeBrowserActivityScreenshot } from '@shared/utils/browserScreensBySessionMerge';
import { usePendingLessonTotal } from '../hooks/usePendingLessonTotal';
import {
  resolveStreamingFromSnapshot,
  buildStreamingAgentState,
} from '@shared/utils/activeTaskSnapshot';
import {
  buildInterruptQueuedMessageDispatch,
  isPersistedUploadAttachment,
} from '@shared/utils/queuedMessageAttachments';
import { shouldAutoPresentArtifact } from '@shared/utils/artifactView';
import { appendImportEvent } from '@shared/utils/projectImportWizard';
import { addKanbanRefreshProject, createRefreshScheduler } from '@shared/utils/kanbanRefresh';
import { isSidebarWsEvent } from '@shared/utils/sessionSidebar';

// Mobile relies on the server's `sidebarParentId` tag and the lifecycle
// events rather than tracking SideBar ids itself.
const NO_REGISTERED_SIDEBAR_IDS: ReadonlySet<string> = new Set();
const useAiSignInGuide = createUseAiSignInGuide({ useCallback, useEffect, useRef, useState });

async function loadAiSignInStatus(server: string, signal: AbortSignal) {
  const response = await fetch(`${server}/setup/status`, {
    headers: getAuthHeaders() as Record<string, string>,
    signal,
  });
  if (!response.ok) return null;
  return response.json();
}

const AppContext = createContext<any>(null);
const SERVER_PUSH_DEPS: ServerPushDeps = {
  fetch: (url, init) => fetch(url, init),
  // Resolved per call, so importing this module never touches the auth module.
  loginTokenFor: (serverUrl) => loginTokenForServer(serverUrl),
};
const PUSH_SIGNED_OUT_KEY = 'agent-hub-push-signed-out';
const PUSH_REGISTRAR = createPushRegistrar({
  deps: SERVER_PUSH_DEPS,
  getOrgs: () => getOrgs()?.orgs,
  // Survives restarts, so a server signed out of stays off this phone.
  signedOutStore: {
    load: async () => {
      const raw = await AsyncStorage.getItem(PUSH_SIGNED_OUT_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((o) => typeof o === 'string') : [];
    },
    save: (origins) => AsyncStorage.setItem(PUSH_SIGNED_OUT_KEY, JSON.stringify(origins)),
  },
});
const AMBIGUOUS_SERVER_TAP_MESSAGE =
  "Can't tell which of your servers sent this. Switch to that server to see it.";
export function AppProvider({ children }: any) {
  const [agents, setAgents] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<any>(null);
  // Organization agents live in a hidden workspace absent from `agents`; the open chat's agent
  // is supplied by the Organizations screen instead.
  const [organizationChatAgent, setOrganizationChatAgent] = useState<any>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  // Soft-deleted sessions within the 7-day recovery window for the active
  // agent. Shape: Array<SessionRow & { message_count:number, deleted_at:string }>.
  // Mirrors App.jsx (web) so the drawer can render an "Archived" section.
  const [archivedSessions, setArchivedSessions] = useState<any[]>([]);
  const [restoringSessionIds, setRestoringSessionIds] = useState<any>(new Set());
  const [activeSessionId, setActiveSessionId] = useState<any>(null);
  // The live per-user Hub assistant session id, resolved by HubScreen's GET.
  // The embedded Hub assistant composer binds/sends ONLY to this session.
  const [hubSessionId, setHubSessionId] = useState<string | null>(null);
  const hubSessionIdRef = useRef<string | null>(null);
  hubSessionIdRef.current = hubSessionId;
  // Whether the Hub screen is currently focused. While it is, a project-agent
  // session restore must not retarget the active session out from under the
  // Hub assistant composer.
  const [hubFocused, setHubFocused] = useState(false);
  const hubFocusedRef = useRef(false);
  hubFocusedRef.current = hubFocused;
  const [messages, setMessages] = useState<any[]>([]);
  const [thinking, setThinking] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingMsgId, setStreamingMsgId] = useState<any>(null);
  const streamingMsgIdRef = useRef<any>(null);
  const [chatScrollNonce, setChatScrollNonce] = useState(0);
  // Bumped to ask ChatScreen to open the Agent browser view for a session
  // (sign-in handoff request or a tapped sign-in notification).
  const [browserPaneRequest, setBrowserPaneRequest] = useState<{
    sessionId: string;
    nonce: number;
  } | null>(null);
  const openBrowserPaneFor = useCallback((sessionId: string) => {
    setBrowserPaneRequest((prev) => ({ sessionId, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  const [streamingEngine, setStreamingEngine] = useState<any>(null);
  const [sessionEngine, setSessionEngine] = useState('claude-code');
  const [sessionModel, setSessionModel] = useState('claude-opus-5-5');
  // Codex reasoning ("thinking") preset for the active session: 'high' (default)
  // or 'pro' (→ xhigh). Only meaningful for the codex-cli engine.
  const [sessionReasoningEffort, setSessionReasoningEffort] = useState('high');
  const [modelConfig, setModelConfig] = useState<any>(null);
  // The legacy worktree toggle (`sessionWorktree`) and CLI-detection
  // signal (`gitWorktreeDetected`) were removed when Agent Hub locked to
  // worktree-only sessions. All user-facing session creation now uses a
  // per-session worktree unconditionally.
  // Consult mode (Hub-only) — sticky preference for new sessions and synced
  // from the active session row. Mirrors the web client's `sessionConsultMode`.
  const [sessionConsultMode, setSessionConsultMode] = useState(false);
  // Map of sessionId -> running task state. Populated from server snapshot on
  // connect and kept in sync via stream events so it survives session switches.
  const [activeTasks, setActiveTasks] = useState<any>({});
  // Skills for the active agent (for /slash-command autocomplete)
  const [skills, setSkills] = useState<any[]>([]);
  // Multi-agent session roster for the active chat session.
  const [sessionAgents, setSessionAgents] = useState<any[]>([]);
  const [sessionRoundProcessing, setSessionRoundProcessing] = useState(false);
  const [streamingAgent, setStreamingAgent] = useState<any>(null);
  // Delegation state: { [sessionId]: { parentMessageId, tasks: [...] } }
  const [delegations, setDelegations] = useState<any>({});
  // Message queue state: { [sessionId]: [{ id, content, position }] }
  const [messageQueues, setMessageQueues] = useState<any>({});
  // Session events: { [messageId]: [{ seq, event }] }
  const [eventsByMessage, setEventsByMessage] = useState<any>({});
  // Live browser screenshot previews: { [messageId]: { [actionId]: dataUrl } }
  const [browserScreensBySession, setBrowserScreensBySession] = useState<any>({});
  const [previewEventBySession, setPreviewEventBySession] = useState<Record<string, any>>({});
  // Per-session nonce bumped on each `artifact_created` / `artifact_deleted`
  // WS event so the SessionArtifactsPanel reloads its list live. Shape:
  //   { [sessionId]: number }
  const [artifactReloadBySession, setArtifactReloadBySession] = useState<any>({});
  // One-shot user-requested deliverable events. ChatScreen acknowledges an
  // entry after handing it to the full-screen artifact viewer.
  const [presentedArtifactBySession, setPresentedArtifactBySession] = useState<any>({});
  // Cron-linked sessions
  const [cronSessions, setCronSessions] = useState<any[]>([]);
  const [lastDesignEvent, setLastDesignEvent] = useState<any>(null);
  // Last `support_ticket_*` WS event for the Customer Support screen.
  //   { type, projectId, ticket?, ticketId?, bump }
  const [lastSupportTicketEvent, setLastSupportTicketEvent] = useState<any>(null);
  // Last Logs Analyze/Fix lifecycle event. LogsScreen passes this through to
  // its issue detail so action state stays live on mobile too.
  const [lastLogIssueActionEvent, setLastLogIssueActionEvent] = useState<any>(null);
  // Unread support-ticket counts keyed by projectId — drives the Support drawer
  // badge. Seeded on demand and kept live by the unreadCount the
  // support_ticket_* events carry.
  const [unreadTicketCounts, setUnreadTicketCounts] = useState<any>({});
  // Open-severity counts per project: { [projectId]: { critical, high, … } }.
  // Drives the Security drawer badge (open critical + high). Seeded from the
  // server on load and refreshed on kanban_update (a scan's only WS signal).
  const [securityOpenCounts, setSecurityOpenCounts] = useState<any>({});
  // Open pull request counts keyed by projectId, used by the Pulls drawer badge.
  const [openPullCounts, setOpenPullCounts] = useState<any>({});
  // Last `finalize_wizard_*` WS event for the Settings → Finalize panel.
  // Mirrors the web component's `agenthub:finalize_wizard_complete`
  // window CustomEvent — RN has no DOM event bus, so we surface the last
  // event through context state. Shape:
  //   { type: 'finalize_wizard_started'|'finalize_wizard_complete',
  //     projectId, sessionId?, agentId?, bump }
  const [lastFinalizeWizardEvent, setLastFinalizeWizardEvent] = useState<any>(null);
  // Project import wizard lifecycle events are exposed here because RN has
  // no window CustomEvent bus. Keep a bounded history, not only the latest
  // event: clone/analyze can complete before the start request's response
  // commits its correlation id in the native screen.
  const [projectImportEvents, setProjectImportEvents] = useState<any[]>([]);
  const projectImportEventSeqRef = useRef(0);
  // Last `finalize_run_*` WS event — drives live FinalizeButton updates without polling.
  const [lastFinalizeRunEvent, setLastFinalizeRunEvent] = useState<any>(null);
  // Last deployment_update WS event. DeploymentsScreen consumes this to keep
  // environment status and step logs live without a project-wide refetch loop.
  const [lastDeploymentEvent, setLastDeploymentEvent] = useState<any>(null);
  // Last release_notification_update WS event. DeploymentsScreen consumes this
  // to keep notification delivery state (queued/sent/failed) live.
  const [lastReleaseNotificationEvent, setLastReleaseNotificationEvent] = useState<any>(null);
  // Last `infra_alert_transition` WS event. InfrastructureScreen consumes this
  // to refetch its alert list on a state change (decision INFRA-UI: WebSocket
  // for state CHANGES only, REST polling for everything else). The payload is
  // deliberately thin server-side — it carries `resourceId` and never
  // `resourceKey`, because it fans out to every client of the project while
  // the alert routes themselves are Admin-gated.
  const [lastInfraAlertEvent, setLastInfraAlertEvent] = useState<any>(null);
  // Last `infra_health_event` WS event. The AWS Health timeline on the
  // Infrastructure Overview consumes this to refetch. Kept separate from
  // `lastInfraAlertEvent` because they are opposite kinds of news: an alert is
  // something the Hub measured and decided, a health event is something AWS
  // pushed at us about its own estate, and a single "infra changed" signal
  // would make each surface refetch on the other's traffic.
  const [lastInfraHealthEvent, setLastInfraHealthEvent] = useState<any>(null);
  // Last `user_todo_update` WS event — drives live TodosScreen refetches
  // without a poll. RN has no DOM event bus, so (mirroring the web
  // window CustomEvent) we surface the last event through context state and
  // bump a timestamp so an effect keyed on it re-runs. Shape:
  //   { action: 'created'|'updated'|'deleted'|'reordered'|'promoted', bump }
  const [lastUserTodoEvent, setLastUserTodoEvent] = useState<any>(null);
  // `reminder_update` WS events (owner-only on the server) go to subscribers
  // one by one. A "last event" state would drop all but the last of several
  // events delivered in one render batch (e.g. two reminders firing at once).
  const reminderListenersRef = useRef(new Set<(event: any) => void>());
  const subscribeReminderUpdates = useCallback((listener: (event: any) => void) => {
    reminderListenersRef.current.add(listener);
    return () => {
      reminderListenersRef.current.delete(listener);
    };
  }, []);
  // Last `google_chat_draft_update` WS event (owner-only on the server):
  // { draft, bump }. Drives the session's agent-reply approval panel.
  const [lastGoogleChatDraftEvent, setLastGoogleChatDraftEvent] = useState<any>(null);
  // Refresh business organizations after membership, links, or project access changes.
  const [lastOrganizationEvent, setLastOrganizationEvent] = useState(0);
  // Last `org_todo_update` WS event — the shared-org counterpart of
  // `lastUserTodoEvent`. Drives live refetches of the org Todos section without
  // a poll. Shape: { orgId, action, bump }.
  const [lastOrgTodoEvent, setLastOrgTodoEvent] = useState<any>(null);
  // Stable ref to refreshSecurityOpenCounts so the WS handler (defined before
  // the helper) can call it without a stale-closure / ordering problem.
  const refreshSecurityOpenCountsRef = useRef<any>(null);
  const refreshOpenPullCountRef = useRef<any>(null);
  // Kanban board refresh trigger
  const [kanbanRefreshKey, setKanbanRefreshKey] = useState(0);
  const [kanbanRefreshProjectIds, setKanbanRefreshProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const kanbanRefreshScheduler = useMemo(
    () => createRefreshScheduler(() => setKanbanRefreshKey((k: any) => (k || 0) + 1)),
    [],
  );
  useEffect(() => () => kanbanRefreshScheduler.dispose(), [kanbanRefreshScheduler]);
  const acknowledgeKanbanRefresh = useCallback((projectId: string) => {
    setKanbanRefreshProjectIds((pending) => {
      if (!pending.has(projectId)) return pending;
      const next = new Set(pending);
      next.delete(projectId);
      return next;
    });
  }, []);
  // Skill-improvement queue refresh trigger — bumped on the
  // `skill_improvement_update` broadcast so SkillsScreen refetches its
  // pending-lessons queue (mirrors the web's window-event fan-out).
  const [skillImprovementRefreshKey, setSkillImprovementRefreshKey] = useState(0);
  // Total pending learned-lessons across all projects, driving the Skills
  // drawer badge so a captured skill-improvement is discoverable without
  // opening the Skills screen. Recomputed on load and whenever the
  // `skill_improvement_update` broadcast bumps skillImprovementRefreshKey.
  // Per-project pending learned-lessons (sidebar Skills badges) and their sum.
  // The hook owns the fetch lifecycle (preserve-on-failure, prune-on-departure).
  const { total: skillImprovementPendingTotal, counts: skillImprovementCounts } =
    usePendingLessonTotal(projects, skillImprovementRefreshKey);
  // Lead-review pills on agent rows (`lead_review` / `lead_review_complete`).
  const [activeReviews, setActiveReviews] = useState<Record<string, any>>({});
  // Ad-hoc PR creation: Map of sessionId -> { agentId, branch, hasUncommitted, hasUnpushed }
  const [changesReady, setChangesReady] = useState<any>({});
  // Map of sessionId -> latest Finalize Code Changes status string. Mirrors
  // the web sidebar's live status map so mobile can derive the same session
  // lifecycle state from Finalize WS events.
  const [finalizeStatusBySession, setFinalizeStatusBySession] = useState<any>({});
  // Tracks which agenthub:ask prompts the user has already answered in this
  // app instance, so the picker renders as "Submitted" immediately after
  // tapping. This is the optimistic, in-memory half; the authoritative source
  // is the derived set below which scans persisted message history.
  // Mirrors the web client's `askSubmittedOptimistic` in client/src/App.jsx.
  const [askSubmittedOptimistic, setAskSubmittedOptimistic] = useState(() => new Set());
  // Handoff DB rows emitted from the active session — used by HandoffCard
  // to resolve the target session id and render a tappable "Open session"
  // link plus pending/failed status pills. Best-effort; missing endpoint or
  // network failures never block the chat render.
  const [sessionHandoffs, setSessionHandoffs] = useState<any[]>([]);
  // Config readiness gate — prevents data fetching before AsyncStorage loads
  const [configReady, setConfigReady] = useState(false);
  // First-run setup wizard gate. `needsSetup` is true when the active org
  // has no remoteUrl configured and the user hasn't dismissed the wizard.
  const [needsSetup, setNeedsSetup] = useState(false);
  // Authentication gate. `needsAuth` is true when the server has a user
  // configured (or no auth configured and we need setup) AND the local JWT
  // is missing/expired. Flipped to false by `completeAuth()` after a
  // successful login/setup via the LoginScreen.
  const [needsAuth, setNeedsAuth] = useState(false);
  const { showAiSignInGuide, dismissAiSignInGuide } = useAiSignInGuide({
    enabled: configReady && !needsAuth && !needsSetup,
    server: getApiBaseUrl(),
    user: getAuthRecord()?.user,
    storage: AsyncStorage,
    loadStatus: loadAiSignInStatus,
  });
  // Mobile push state: Expo token + permission status (used by Settings).
  const [pushToken, setPushToken] = useState<any>(null);
  // Every push-registration lifecycle event goes through PUSH_REGISTRAR.
  const syncPushRegistrations = useCallback(() => PUSH_REGISTRAR.syncAll(), []);
  /** Stop a saved server pushing here. Call before deleting or re-pointing it. */
  const forgetPushServer = useCallback(
    (org: any, applyRemoval: () => Promise<unknown>) => PUSH_REGISTRAR.forget(org, applyRemoval),
    [],
  );
  const [pushPermissionStatus, setPushPermissionStatus] = useState('unknown');
  const activeAgent =
    agents.find((a: any) => a.id === activeAgentId) ??
    (organizationChatAgent?.id === activeAgentId ? organizationChatAgent : undefined);
  const activeSession =
    sessions.find((s: any) => s.id === activeSessionId) ||
    cronSessions.find((s: any) => s.id === activeSessionId) ||
    null;
  const activeSessionState = deriveSessionState(activeSession, {
    activeTaskSessionIds: activeTasks,
    finalizeStatusBySession,
  });
  const defaultModelForEngine = (engine: any) => {
    const fromConfig = modelConfig?.engineDefaultModels?.[engine];
    if (fromConfig) return fromConfig;
    const available = modelConfig?.engineValidModels?.[engine];
    if (Array.isArray(available) && available.length > 0) return available[0];
    if (engine === 'cursor-agent') return 'grok-4.7-high';
    if (engine === 'codex-cli') return 'gpt-5.6-sol';
    if (engine === 'grok-cli') return 'grok-4.7';
    if (engine === 'muse-code') return 'muse-spark-1.3';
    return 'claude-opus-5-5';
  };
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  /** One in-flight implicit `createSession` per agent + ask-mode (send with no session). */
  const implicitSessionCreateByKeyRef = useRef(new Map());
  const activeAgentIdRef = useRef(activeAgentId);
  activeAgentIdRef.current = activeAgentId;
  // Track when a session was explicitly navigated to (e.g. from a handoff
  // "Open session" tap) so the agent-change sessions-load effect doesn't
  // clobber it by defaulting to `data[0].id`. Mirror of the web client's
  // `pendingSessionIdRef` in `client/src/App.jsx:187`.
  const pendingSessionIdRef = useRef<any>(null);
  // Stack navigator bridge — populated by `App.js` via `registerNavigator`
  // once the `NavigationContainer` ref is ready. Used by the notification
  // response listener to open Kanban / Customer Issues from a cold- or warm-start
  // tap. `null` is a no-op (pre-mount or web/test).
  const navigatorRef = useRef<any>(null);
  // A ref — not state — so registering the navigator never triggers a
  // re-render. Wrapped in `useCallback` only for a stable identity.
  const registerNavigator = useCallback((fn: any) => {
    navigatorRef.current = typeof fn === 'function' ? fn : null;
  }, []);
  // Subscribers to the `initial_build_started` broadcast. The new-project
  // flow registers a one-shot callback so it can open the first build
  // session's chat when provisioning dispatches it (web parity).
  const initialBuildListenersRef = useRef<Set<(data: any) => void>>(new Set());
  const subscribeInitialBuild = useCallback((cb: (data: any) => void) => {
    initialBuildListenersRef.current.add(cb);
    return () => {
      initialBuildListenersRef.current.delete(cb);
    };
  }, []);
  // SideBar panel subscribers. Every WS event about a SideBar session (server
  // tags them with `sidebarParentId`) goes here instead of the main chat.
  const sideBarListenersRef = useRef<Set<(data: any) => void>>(new Set());
  const subscribeSideBarEvents = useCallback((cb: (data: any) => void) => {
    sideBarListenersRef.current.add(cb);
    return () => {
      sideBarListenersRef.current.delete(cb);
    };
  }, []);
  // Keep the latest sessions list reachable from the notification listener
  // without re-running the subscription on every sessions change.
  const sessionsRef = useRef<any>([]);
  const agentsRef = useRef<any>([]);
  const projectsRef = useRef<any>([]);
  // Whether the connected server has auth configured (multi-user). Mirrors the
  // server's `isLocalBundledServer()` inverse: when false, the server is a
  // local/bundled single-user install with no per-user boundary, so foreground
  // notification scoping bypasses the strict owner check. Secure default:
  // assume auth IS configured (strict) until the `/auth/status` probe says
  // otherwise, so we never leak owner-only banners before the probe resolves.
  const serverAuthConfiguredRef = useRef(true);
  // Show an in-app (foreground) notification for the subset of broadcast
  // events that map to the desktop/Expo push taxonomy. Remote pushes are
  // typically suppressed while the app is foregrounded, so we mirror them
  // with a locally-scheduled notification so the user still sees a banner.
  // Dynamic require so Vitest doesn't need native mocks.
  const presentForegroundFor = useCallback((data: any) => {
    // Scope session-owned events to the logged-in account — Kevin's
    // session_complete must not banner on Ryan's phone. The owner id rides
    // on the broadcast (`ownerUserId`); our identity comes from the stored
    // JWT login record.
    const currentUserId = getAuthRecord()?.user?.id ?? null;
    const mapped = mapBroadcastToNotification(data, {
      currentUserId,
      projects: projectsRef.current,
      agents: agentsRef.current,
      // Only bypass owner-scoping on a genuine local/bundled single-user
      // server (no auth configured) — NOT merely because we lack a user id.
      localBypass: !serverAuthConfiguredRef.current,
    });
    if (!mapped) return;
    try {
      const Notifications = require('expo-notifications');
      presentLocalNotification(
        { Notifications },
        {
          title: mapped.title,
          body: mapped.body,
          data: { event: mapped.event, ...data },
          serverUrl: getServerBaseUrl(),
        },
      );
    } catch {
      /* expo-notifications unavailable (e.g. web / test) — no banner */
    }
  }, []);
  const reloadActiveAgentSkills = useCallback(() => {
    const agentId = activeAgentIdRef.current;
    if (!configReady || !agentId || !getApiBaseUrl()) return;
    api
      .getSkills(agentId)
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [configReady]);
  // WebSocket handler
  const handleWsMessage = useCallback(
    (data: any) => {
      // SideBar turns stay in the SideBar: no banner, no main-chat streaming.
      if (isSidebarWsEvent(data, NO_REGISTERED_SIDEBAR_IDS)) {
        sideBarListenersRef.current.forEach((cb) => {
          try {
            cb(data);
          } catch {
            /* a listener throwing must not wedge the WS handler */
          }
        });
        return;
      }
      // Fan out to the in-app banner first so every mapped type gets a
      // notification regardless of which switch-case it takes below.
      presentForegroundFor(data);
      if (HUB_CHAT_WS_EVENTS.has(data.type)) {
        hubChatStore.handleWsEvent(data);
        return;
      }
      if (NOTIFICATION_WS_EVENTS.has(data.type)) {
        notificationInboxStore.handleWsEvent(data);
        return;
      }
      if (APPROVAL_WS_EVENTS.has(data.type)) {
        approvalEvents.emit(data);
        return;
      }
      const forActiveSession = data.sessionId && data.sessionId === activeSessionIdRef.current;
      const msgForActiveSession = data.message?.session_id === activeSessionIdRef.current;
      switch (data.type) {
        case 'projects_updated':
          setLastOrganizationEvent((value) => value + 1);
          api
            .getProjects()
            .then(setProjects)
            .catch(() => {});
          break;
        case 'active-tasks-snapshot': {
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
          // snapshot has no live run, so clear rather than leave the
          // previous streaming state standing.
          const streaming = resolveStreamingFromSnapshot(next, activeSessionIdRef.current);
          if (streaming) {
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
                setThinking(false);
                setStreamingContent('');
                setStreamingMsgId(null);
                setStreamingEngine(null);
                setStreamingAgent(null);
              }
            }
          }
          break;
        case 'thinking':
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
        case 'browser_login_requested':
          if (forActiveSession && typeof data.sessionId === 'string') {
            openBrowserPaneFor(data.sessionId);
          }
          break;
        case 'interrupted':
          if (forActiveSession) {
            setThinking(false);
            setStreamingContent('');
            setStreamingMsgId(null);
            setStreamingEngine(null);
            setChatScrollNonce((n: any) => n + 1);
          }
          break;
        case 'done':
          setActiveTasks((prev: any) => {
            const next = { ...prev };
            delete (next as any)[data.sessionId];
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
          break;
        case 'session-updated':
          // Matches web: server sends a full session row; spread keeps fields fresh.
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
        case 'session_state': {
          const sid = data.sessionId;
          if (!sid || typeof data.state !== 'string') break;
          setSessions((prev: any) =>
            prev.map((s: any) => (s.id === sid ? { ...s, state: data.state } : s)),
          );
          setCronSessions((prev: any) =>
            prev.map((s: any) => (s.id === sid ? { ...s, state: data.state } : s)),
          );
          break;
        }
        case 'session-worktree-detected':
          // Keep the per-session row flag in sync for debugging / future
          // tooling. The user-facing badge was removed when Agent Hub
          // locked to worktree-only sessions.
          setSessions((prev: any) => applyDetectedFlag(prev, data.sessionId, data.gitWorktree));
          break;
        case 'error':
          if (data.sessionId) {
            setActiveTasks((prev: any) => {
              const next = { ...prev };
              delete (next as any)[data.sessionId];
              return next;
            });
          }
          if (forActiveSession) {
            setThinking(false);
            setStreamingContent('');
            setStreamingMsgId(null);
            setStreamingEngine(null);
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
        case 'session_round_start':
          if (forActiveSession) setSessionRoundProcessing(true);
          break;
        case 'session_round_done':
          if (forActiveSession) setSessionRoundProcessing(false);
          break;
        // Delegation events
        case 'delegation_start':
          setDelegations((prev: any) => ({
            ...prev,
            [data.sessionId]: {
              parentMessageId: data.parentMessageId,
              tasks: (data.tasks || []).map((t: any) => ({
                delegationId: null,
                agentId: t.agentId,
                agentName: t.agentId,
                agentColor: null,
                task: t.task,
                status: 'pending',
                content: '',
                output: null,
                error: null,
              })),
            },
          }));
          break;
        case 'delegation_thinking':
          setDelegations((prev: any) => {
            const session = prev[data.sessionId];
            if (!session) return prev;
            return {
              ...prev,
              [data.sessionId]: {
                ...session,
                tasks: session.tasks.map((t: any) =>
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
          break;
        case 'delegation_stream':
          setDelegations((prev: any) => {
            const session = prev[data.sessionId];
            if (!session) return prev;
            return {
              ...prev,
              [data.sessionId]: {
                ...session,
                tasks: session.tasks.map((t: any) =>
                  t.agentId === data.agentId
                    ? {
                        ...t,
                        agentName: data.agentName,
                        agentColor: data.agentColor,
                        status: 'running',
                        content: data.content,
                      }
                    : t,
                ),
              },
            };
          });
          break;
        case 'delegation_agent_done':
          setDelegations((prev: any) => {
            const session = prev[data.sessionId];
            if (!session) return prev;
            return {
              ...prev,
              [data.sessionId]: {
                ...session,
                tasks: session.tasks.map((t: any) =>
                  t.agentId === data.agentId
                    ? { ...t, status: 'done', output: data.output, content: '' }
                    : t,
                ),
              },
            };
          });
          break;
        case 'delegation_agent_error':
          setDelegations((prev: any) => {
            const session = prev[data.sessionId];
            if (!session) return prev;
            return {
              ...prev,
              [data.sessionId]: {
                ...session,
                tasks: session.tasks.map((t: any) =>
                  t.agentId === data.agentId ? { ...t, status: 'error', error: data.error } : t,
                ),
              },
            };
          });
          break;
        case 'delegation_cancelled':
          setDelegations((prev: any) => {
            const session = prev[data.sessionId];
            if (!session) return prev;
            return {
              ...prev,
              [data.sessionId]: {
                ...session,
                tasks: session.tasks.map((t: any) =>
                  t.status === 'running' || t.status === 'pending'
                    ? { ...t, status: 'cancelled' }
                    : t,
                ),
              },
            };
          });
          break;
        case 'delegation_round_done':
          // No state change needed — tasks already updated individually
          break;
        case 'delegation_error':
          // System-level delegation error — just log it
          console.warn('[Delegation] Error:', data.error);
          break;
        // Session events (for timeline)
        case 'session-event':
          if (forActiveSession && data.messageId && data.event) {
            setEventsByMessage((prev: any) => ({
              ...prev,
              // Keep the server's wall clock: it is the anchor a relative
              // tool arg needs to become an absolute time (ScheduleWakeup's
              // `delaySeconds`). Older servers omit it — use receive time.
              [data.messageId]: [
                ...(prev[data.messageId] || []),
                {
                  seq: data.seq,
                  event: data.event,
                  timestamp: data.timestamp || new Date().toISOString(),
                },
              ],
            }));
          }
          break;
        case 'agenthub_preview':
          setPreviewEventBySession((prev) => applyPreviewEvent(prev, data));
          break;
        case 'browser_activity_screenshot': {
          const sid = data.sessionId;
          const mid = data.messageId;
          const aid = data.actionId;
          const shot = data.screenshotDataUrl;
          if (!sid || !mid || !aid || typeof shot !== 'string') break;
          setBrowserScreensBySession((prev: any) =>
            mergeBrowserActivityScreenshot(prev, sid, mid, aid, shot),
          );
          break;
        }
        case 'artifact_created':
        case 'artifact_deleted': {
          // Bump the per-session reload nonce so an open SessionArtifactsPanel
          // refetches the authoritative list. Mirrors the web App.tsx handler
          // (which drives SessionArtifactsPane's reloadToken).
          const sid = data.sessionId;
          if (!sid) break;
          setArtifactReloadBySession((prev: any) => ({ ...prev, [sid]: (prev[sid] || 0) + 1 }));
          if (shouldAutoPresentArtifact(data, activeSessionIdRef.current)) {
            setPresentedArtifactBySession((prev: any) => ({ ...prev, [sid]: data.artifact }));
          }
          break;
        }
        // Cron session updates
        case 'cron_session_update':
          api
            .getCronSessions()
            .then(setCronSessions)
            .catch(() => {});
          break;
        // Queue events
        case 'queue_updated':
          setMessageQueues((prev: any) => ({
            ...prev,
            [data.sessionId]: data.queue || [],
          }));
          break;
        case 'queue_item_processing':
          if (forActiveSession) {
            setMessages((prev: any) => promoteQueuedMessage(prev, data.messageId, data.message));
          }
          setMessageQueues((prev: any) => {
            const q = prev[data.sessionId];
            if (!q) return prev;
            return {
              ...prev,
              [data.sessionId]: q.filter((item: any) => item.id !== data.messageId),
            };
          });
          break;
        case 'queue_item_edited':
          if (forActiveSession) {
            setMessages((prev: any) =>
              prev.map((m: any) => (m.id === data.messageId ? { ...m, content: data.content } : m)),
            );
          }
          break;
        case 'skill_improvement_update':
          setSkillImprovementRefreshKey((k: any) => (k || 0) + 1);
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
            for (const [key, val] of Object.entries(next)) {
              if ((val as any).sessionId === data.sessionId) delete next[key];
            }
            return next;
          });
          break;
        case 'kanban_update':
          if (typeof data.projectId === 'string') {
            setKanbanRefreshProjectIds((pending) =>
              addKanbanRefreshProject(pending, data.projectId),
            );
            kanbanRefreshScheduler.schedule();
          }
          if (data.projectId) refreshOpenPullCountRef.current?.(data.projectId);
          // A security scan's only WS signal is kanban_update. Refresh the
          // affected project's open-severity counts so the drawer badge stays live.
          if (data.projectId) refreshSecurityOpenCountsRef.current?.(data.projectId);
          break;
        case 'native_pr_update':
          if (data.projectId) refreshOpenPullCountRef.current?.(data.projectId);
          break;
        case 'google_chat_draft_update':
          setLastGoogleChatDraftEvent({ draft: data.draft ?? null, bump: Date.now() });
          break;
        case 'user_todo_update':
          // The server already filters this to the owner's connections, so
          // any event we receive is ours. Surface it so TodosScreen can
          // silently refetch (create/update/delete/reorder/promote).
          setLastUserTodoEvent({ action: data.action ?? null, bump: Date.now() });
          break;
        case 'reminder_update':
          for (const listener of reminderListenersRef.current) {
            listener({
              action: data.action ?? null,
              reminderId: data.reminderId ?? null,
              reminder: data.reminder ?? null,
            });
          }
          break;
        case 'organization_updated':
        case 'organization_invalidated':
        case 'organization_access_revoked':
          setLastOrganizationEvent((value) => value + 1);
          break;
        case 'org_todo_update':
          // Shared org todo changed. The server fans this to every member of
          // the org, so surface it and let OrgTodosSection (scoped to its org)
          // silently refetch.
          setLastOrgTodoEvent({
            orgId: data.orgId ?? null,
            action: data.action ?? null,
            bump: Date.now(),
          });
          break;
        case 'dispatch_failure':
          // The linked card's kanban_update carries the project id and is
          // enough to refresh the board after the failure comment lands.
          break;
        case 'session_deleted':
          setSessions((prev: any) => prev.filter((s: any) => s.id !== data.sessionId));
          setCronSessions((prev: any) => prev.filter((s: any) => s.id !== data.sessionId));
          setFinalizeStatusBySession((prev: any) => {
            if (!prev[data.sessionId]) return prev;
            const next = { ...prev };
            delete (next as any)[data.sessionId];
            return next;
          });
          break;
        case 'session_created': {
          const row = data.session;
          const agentId = data.agentId || row?.agent_id;
          if (row && agentId === activeAgentIdRef.current) {
            setSessions((prev: any) => {
              if (prev.some((s: any) => s.id === row.id)) return prev;
              return [row, ...prev];
            });
          }
          break;
        }
        case 'session_restored': {
          // Server broadcast after POST /api/sessions/:id/restore. Re-home
          // the row in the live list without a full refetch and drop it
          // from the Archived drawer section. Tolerant of either id shape.
          const restoredId = data.sessionId || data.session?.id;
          if (!restoredId) break;
          setArchivedSessions((prev: any) => prev.filter((s: any) => s.id !== restoredId));
          setSessions((prev: any) =>
            withRestoredSession(prev, data.session, activeAgentIdRef.current),
          );
          break;
        }
        // A session was forwarded from another agent — if the new session
        // belongs to the currently-active agent, splice it into the sidebar
        // list so the user sees it without a manual refresh. Navigation of
        // the originating client is handled by ForwardSessionModal directly.
        case 'session_forwarded': {
          const newSession = data.session;
          if (newSession && newSession.agent_id === activeAgentIdRef.current) {
            setSessions((prev: any) => {
              if (prev.some((s: any) => s.id === newSession.id)) return prev;
              return [newSession, ...prev];
            });
          }
          break;
        }
        // Ad-hoc PR creation — agent finished a worktree session with uncommitted
        // changes and no existing kanban card. Surface the "Create PR" banner.
        case 'changes_ready': {
          const aid = data.agentId;
          const agentRow = agentsRef.current.find((a: any) => a.id === aid);
          const proj = projectsRef.current.find((p: any) => p.id === agentRow?.projectId);
          if (isWorkflowProject(proj)) break;
          setChangesReady((prev: any) => ({
            ...prev,
            [data.sessionId]: {
              agentId: data.agentId,
              branch: data.branch,
              hasUncommitted: data.hasUncommitted,
              hasUnpushed: data.hasUnpushed,
            },
          }));
          break;
        }
        // A PR was opened, or the session's changes were discarded — clear the banner.
        case 'auto_pr_created':
        case 'changes_discarded':
          setChangesReady((prev: any) => {
            if (!prev[data.sessionId]) return prev;
            const next = { ...prev };
            delete (next as any)[data.sessionId];
            return next;
          });
          break;
        case 'finalize_run_phase_changed':
        case 'finalize_run_completed':
          if (data.session_id) {
            setLastFinalizeRunEvent({
              sessionId: data.session_id,
              runId: data.run_id,
              status: data.status,
              phase: data.phase ?? null,
              bump: Date.now(),
            });
          }
          if (data.session_id && typeof data.status === 'string') {
            setFinalizeStatusBySession((prev: any) => {
              const incoming =
                data.status === 'ready_to_push' && data.validated === false
                  ? 'phase_passed'
                  : data.status;
              if (prev[data.session_id] === incoming) return prev;
              return { ...prev, [data.session_id]: incoming };
            });
          }
          break;
        case 'support_ticket_created':
        case 'support_ticket_updated':
          if (data.projectId && typeof data.unreadCount === 'number') {
            setUnreadTicketCounts((prev: any) => ({ ...prev, [data.projectId]: data.unreadCount }));
          }
          setLastSupportTicketEvent({
            type: data.type,
            projectId: data.ticket?.project_id,
            ticket: data.ticket,
            bump: Date.now(),
          });
          break;
        case 'support_ticket_deleted':
          if (data.projectId && typeof data.unreadCount === 'number') {
            setUnreadTicketCounts((prev: any) => ({ ...prev, [data.projectId]: data.unreadCount }));
          }
          setLastSupportTicketEvent({
            type: 'support_ticket_deleted',
            projectId: data.projectId,
            ticketId: data.ticketId,
            bump: Date.now(),
          });
          break;
        case 'support_ticket_vote_updated':
          setLastSupportTicketEvent({
            type: 'support_ticket_vote_updated',
            projectId: data.projectId,
            ticketId: data.ticketId,
            score: data.score,
            upvotes: data.upvotes,
            downvotes: data.downvotes,
            bump: Date.now(),
          });
          break;
        case 'support_ticket_comment_created':
          setLastSupportTicketEvent({
            type: 'support_ticket_comment_created',
            projectId: data.projectId,
            ticketId: data.ticketId,
            comment: data.comment,
            bump: Date.now(),
          });
          break;
        case 'support_ticket_comment_deleted':
          setLastSupportTicketEvent({
            type: 'support_ticket_comment_deleted',
            projectId: data.projectId,
            ticketId: data.ticketId,
            commentId: data.commentId,
            bump: Date.now(),
          });
          break;
        case 'support_tickets_read_all':
          if (data.projectId) {
            setUnreadTicketCounts((prev: any) => ({ ...prev, [data.projectId]: 0 }));
          }
          setLastSupportTicketEvent({
            type: 'support_tickets_read_all',
            projectId: data.projectId,
            bump: Date.now(),
          });
          break;
        case 'log_issue_action':
          setLastLogIssueActionEvent({ ...data, bump: Date.now() });
          break;
        case 'design_message_added':
        case 'design_stream':
        case 'design_thinking':
        case 'design_updated':
        case 'design_cancelled':
          setLastDesignEvent({ ...data, bump: Date.now() });
          break;
        // Finalize setup wizard (Settings → Finalize)
        // The web client listens for `agenthub:finalize_wizard_*` window
        // CustomEvents to refresh the panel. Mobile has no DOM event bus,
        // so we mirror the broadcast through `lastFinalizeWizardEvent`
        // state; FinalizeSection reads it via useApp() and refetches the
        // project list when its own projectId matches.
        case 'finalize_wizard_started':
        case 'finalize_wizard_complete':
          setLastFinalizeWizardEvent({
            type: data.type,
            projectId: data.projectId,
            sessionId: data.sessionId,
            agentId: data.agentId,
            bump: Date.now(),
          });
          break;
        case 'clone-progress':
        case 'clone-complete':
        case 'clone-error':
        case 'clone-preview-defaults':
        case 'analyze-progress':
        case 'analyze-complete':
        case 'analyze-error':
          {
            const event = {
              ...data,
              bump: Date.now(),
              importEventId: ++projectImportEventSeqRef.current,
            };
            setProjectImportEvents((previous) => appendImportEvent(previous, event));
          }
          break;
        case 'infra_alert_transition':
          setLastInfraAlertEvent({
            type: data.type,
            projectId: data.projectId,
            alertId: data.alertId,
            ruleId: data.ruleId,
            severity: data.severity,
            resourceId: data.resourceId,
            fromState: data.fromState,
            toState: data.toState,
            status: data.status,
            // Repeat transitions can carry an identical payload; bump so an
            // effect keyed on this object still re-runs (same reason
            // `lastDeploymentEvent` carries one).
            bump: Date.now(),
          });
          break;
        case 'infra_health_event':
          setLastInfraHealthEvent({
            type: data.type,
            projectId: data.projectId,
            healthEventId: data.healthEventId,
            eventArn: data.eventArn,
            severity: data.severity,
            service: data.service,
            region: data.region,
            eventTypeCode: data.eventTypeCode,
            statusCode: data.statusCode,
            headline: data.headline,
            // AWS re-publishes an event as it progresses, and the two
            // copies can be byte-identical here; bump so an effect keyed
            // on this object still re-runs.
            bump: Date.now(),
          });
          break;
        case 'deployment_update':
          setLastDeploymentEvent({
            type: data.type,
            projectId: data.projectId,
            deployment: data.deployment,
            steps: data.steps || [],
            approvals: data.approvals || [],
            logs: data.logs || [],
            bump: Date.now(),
          });
          break;
        case 'release_notification_update':
          setLastReleaseNotificationEvent({
            type: data.type,
            projectId: data.projectId,
            deploymentId: data.deploymentId,
            releaseNotifications: data.releaseNotifications || [],
            bump: Date.now(),
          });
          break;
        case 'skills_update': {
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
        case 'initial_build_started':
          // The provisioning job dispatched the first build session. Fan out
          // to any subscriber (the new-project flow) so it can open that chat
          // instead of stopping at "provisioning started" — mobile parity
          // with the web adaptive flow's session handoff.
          initialBuildListenersRef.current.forEach((cb) => {
            try {
              cb(data);
            } catch {
              /* a listener throwing must not wedge the WS handler */
            }
          });
          break;
      }
    },
    [kanbanRefreshScheduler, openBrowserPaneFor, presentForegroundFor, reloadActiveAgentSkills],
  );
  const { send, connected, reconnecting, reconnect } = useWebSocket(handleWsMessage);
  // Agent Hub chat: start over whenever the account or server changes, and
  // refetch on every (re)connect, since events missed while disconnected are
  // not replayed.
  useEffect(() => {
    const signedIn = configReady && !needsAuth && !needsSetup;
    const userId = getAuthRecord()?.user?.id ?? null;
    const orgId = getActiveOrg()?.id ?? '';
    const account = signedIn ? `${getApiBaseUrl() ?? ''}|${userId ?? ''}|${orgId}` : null;
    hubChatAccountGate.update({ account, userId, connected });
    notificationInboxAccountGate.update({ account, userId, connected });
    if (signedIn) void loadNotificationPrefs();
  }, [configReady, needsAuth, needsSetup, connected]);
  // Foreground banner for DMs and mentions (remote pushes are hidden while
  // the app is open), with the same rule as the web desktop notice.
  useEffect(() => {
    hubChatStore.setNotifier((notice) => {
      try {
        const Notifications = require('expo-notifications');
        void presentLocalNotification(
          { Notifications },
          {
            title: notice.title,
            body: notice.body,
            serverUrl: getServerBaseUrl(),
            data: {
              event: 'chat_message',
              type: 'chat_message',
              category: notice.category,
              channelId: notice.channelId,
            },
          },
        );
      } catch {
        /* expo-notifications unavailable (web / test) */
      }
    });
    return () => hubChatStore.setNotifier(null);
  }, []);
  // Mirror `sessions` into a ref so the notification-response listener —
  // which registers once on mount — can read the latest list without being
  // torn down and re-registered on every sessions refresh.
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);
  // Register for Expo push notifications once the connection config is
  // ready. Native modules are required lazily so this file can be imported
  // under Vitest without those dependencies being resolvable.
  useEffect(() => {
    if (!configReady || !getApiBaseUrl()) return;
    (async () => {
      try {
        const Notifications = require('expo-notifications');
        // Foreground notifications: show banner + play sound. Without this
        // Expo suppresses banners while the app is in the foreground.
        if (Notifications.setNotificationHandler) {
          Notifications.setNotificationHandler({
            // A banner shown while the app is open is an in-app notice, so
            // it follows the user's `in_app` pref for its category.
            handleNotification: async (notification: any) => {
              const data = notification?.request?.content?.data;
              // Another server's event never reaches this socket, so its push
              // is the only notice; the server already applied its push prefs.
              // A push from a server no longer saved is dropped. One whose
              // server can't be told apart still shows; only acting on it is
              // refused.
              const source = pushSource(data, getOrgs()?.orgs, getServerBaseUrl());
              const show =
                source.kind === 'other' ||
                source.kind === 'ambiguous' ||
                (source.kind === 'active' && foregroundBannerAllowed(data));
              return {
                shouldShowBanner: show,
                shouldShowList: show,
                shouldPlaySound: show,
                shouldSetBadge: false,
              };
            },
          });
        }
        // Lock-screen Allow once / Deny on approval pushes.
        await registerApprovalPushCategory(Notifications);
        const Device = require('expo-device');
        const Constants = require('expo-constants').default;
        const { Platform } = require('react-native');
        const result = await registerForPushNotifications({
          // Register with every saved server, not just the active one.
          api: {
            registerDeviceToken: async (token: string, platform: string) => {
              await PUSH_REGISTRAR.setDevice(token, platform);
            },
          },
          Notifications,
          Device,
          Constants,
          Platform,
        });
        setPushToken(result.token);
        setPushPermissionStatus(result.permissionStatus);
      } catch (err: any) {
        // Native modules missing (dev web, Vitest) — stay silent.
        setPushPermissionStatus('unavailable');
      }
    })();
  }, [configReady]);
  // Shared dispatch for a routed notification-tap payload. Extracted so the
  // cold-start (`getLastNotificationResponseAsync`) path and the live
  // (`addNotificationResponseReceivedListener`) path share identical logic.
  //
  // The routing decision is fully pure (`routeNotificationTap`); only the
  // side-effects — state updates, `navigatorRef.current(screen, params)` —
  // live here.
  const applyRoute = useCallback(
    (route: any) => {
      if (!route) return;
      switch (route.kind) {
        case 'chat': {
          // Stash the target session on `pendingSessionIdRef` before swapping
          // `activeAgentId` so the sessions-load effect honors it (mirror of
          // `handleOpenHandoffSession`). When `agentId` is unknown (the
          // session wasn't in the loaded list) we still stash the pending id
          // — if the user ever lands on that agent the session will activate.
          pendingSessionIdRef.current = route.sessionId;
          if (route.agentId) {
            setActiveAgentId(route.agentId);
          }
          setActiveSessionId(route.sessionId);
          if (route.openPane === 'browser') openBrowserPaneFor(route.sessionId);
          break;
        }
        case 'kanban':
        case 'support':
        case 'pulls':
        case 'infra':
        case 'hubChat':
        case 'deployments':
        case 'crons':
        case 'reminders': {
          // Navigator-driven kinds share one param mapper (screen + params,
          // including the `pulls` PR number and the `infra` alert id).
          const nav = notificationRouteToNavigation(route);
          if (nav) navigatorRef.current?.(nav.screen, nav.params);
          break;
        }
        default:
          break;
      }
    },
    [openBrowserPaneFor],
  );
  const applyNotificationRoute = useCallback(
    (data: any) => applyRoute(routeNotificationTap(data, { sessions: sessionsRef.current })),
    [applyRoute],
  );
  /**
   * Tap on a bell inbox row: mark it read and open what it points at.
   * Returns the route taken (null when the row carries nothing to open), so
   * the caller can switch to the Chat screen for session rows.
   */
  const openInboxNotification = useCallback(
    (n: InboxNotification) => {
      notificationInboxStore.markRead(n);
      const route = routeInboxNotification(n, { sessions: sessionsRef.current });
      applyRoute(route);
      return route;
    },
    [applyRoute],
  );
  // Register a notification-response listener so tapping a banner (whether
  // presented in foreground by `presentLocalNotification` or delivered as a
  // remote Expo push) navigates to the right screen. Also consume any
  // pending cold-start response so launching the app from a dismissed
  // banner still routes correctly.
  //
  // Native modules are required lazily so Vitest (which only exercises
  // pure utils in `src/utils/`) never tries to resolve them.
  // Cold start and the live listener can both see the same button press.
  const answeredPushResponsesRef = useRef<Set<string>>(new Set());
  // Declared below; a tap on another server's push switches to it first.
  const switchToOrgRef = useRef<((orgId: string) => Promise<boolean>) | null>(null);
  useEffect(() => {
    if (!configReady) return undefined;
    let listener: { remove: () => void } | null = null;
    try {
      const Notifications = require('expo-notifications');
      // An Allow once / Deny button answers the approval; a plain tap routes.
      listener = listenForNotificationResponses(
        Notifications,
        {
          answer: (id, decision, data) =>
            answerPushApproval({
              data,
              orgs: getOrgs()?.orgs,
              activeServerUrl: getServerBaseUrl(),
              approvalId: id,
              decision,
              answerOnActive: (approvalId, d) => api.answerApproval(approvalId, d),
              deps: SERVER_PUSH_DEPS,
            }),
          route: (data) => {
            // A push from another saved server opens that server first.
            void routePushTap({
              data,
              orgs: getOrgs()?.orgs,
              activeServerUrl: getServerBaseUrl(),
              routeOnActive: (d) => applyNotificationRoute(d),
              switchTo: async (orgId) => (await switchToOrgRef.current?.(orgId)) ?? false,
              currentServerUrl: getServerBaseUrl,
            })
              .then((outcome) => {
                if (outcome === 'ambiguous') {
                  Alert.alert('Notification', AMBIGUOUS_SERVER_TAP_MESSAGE);
                } else if (outcome === 'unknown') {
                  Alert.alert('Notification', UNKNOWN_SERVER_MESSAGE);
                }
              })
              .catch((err) => console.warn('[push] switch for tap failed', err));
          },
          onAnswerFailed: (message) => Alert.alert('Could not answer the approval', message),
        },
        answeredPushResponsesRef.current,
      );
    } catch {
      /* expo-notifications unavailable — no-op */
    }
    return () => listener?.remove();
  }, [configReady, applyNotificationRoute]);
  const refreshAgents = useCallback(() => {
    api.getAgents().then((data: any) => {
      setAgents(data);
    });
  }, []);
  const refreshProjects = useCallback(() => {
    return api
      .getProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);
  // Load connection config on mount, then signal readiness
  useEffect(() => {
    (async () => {
      await loadConnectionConfig();
      await migrateFromLegacy();
      // Ensure active org's connection config is synced (URL + API key)
      const { getActiveOrg } = require('../utils/orgs');
      const { saveConnectionConfig } = require('../utils/config');
      const activeOrg = getActiveOrg();
      if (activeOrg?.remoteUrl) {
        await saveConnectionConfig({
          remoteUrl: activeOrg.remoteUrl,
          apiKey: activeOrg.apiKey || '',
        });
      }
      // Warm the in-memory JWT mirror from AsyncStorage so sync callers
      // (getAuthHeaders / getWsUrl) can read it immediately. Must happen
      // before we reconnect the WebSocket below.
      await loadAuthToken(activeOrg?.remoteUrl || '');
      // Decide whether to show the first-run wizard before we signal ready.
      // `shouldShowWizard` returns true only when no org has a remoteUrl AND
      // the user hasn't previously dismissed the wizard.
      const dismissed = await loadSetupDismissed();
      setNeedsSetup(shouldShowWizard(getOrgs(), dismissed));
      // Probe the server for auth configuration. If auth is enabled and we
      // don't have a valid cached token, gate the app with the LoginScreen.
      // Failures (server unreachable, no URL configured, etc.) are
      // non-blocking — we fall through and let the normal WS reconnect
      // loop surface the error.
      const baseUrl = getApiBaseUrl();
      if (baseUrl) {
        try {
          const status = await getAuthStatus(baseUrl);
          // Record whether the server enforces auth — drives notification
          // owner-scoping's local-bypass (see `serverAuthConfiguredRef`).
          serverAuthConfiguredRef.current = Boolean(status?.authConfigured);
          if (
            shouldGateAuthFromStatus({
              status,
              isAuthenticated: isAuthenticated(),
              needsEmailUpdate: needsEmailUpdate(),
            })
          ) {
            setNeedsAuth(true);
          }
        } catch {
          /* server unreachable — skip auth gate, let WS reconnect surface it */
        }
      }
      // Signal that config is loaded — this unblocks data fetching & WebSocket
      setConfigReady(true);
      // Always reconnect WebSocket now that config is loaded from AsyncStorage
      reconnect();
    })();
  }, []);
  /**
   * Called from `SetupWizard` once the user has entered the server address.
   * Persists the "dismissed" flag so the wizard never reappears, then hides it.
   * The connection config was already written by the wizard's
   * `updateOrg`/`createOrg` call, so a server URL now exists.
   *
   * Mobile is a pure client: with a server configured, the user must sign in to
   * that server. We raise the login gate here (unless a valid token is already
   * held) so the next screen is the LoginScreen rather than a main app that
   * can't load any data. LoginScreen re-probes the server and renders the
   * correct sign-in / first-run-owner form.
   */
  const completeSetup = useCallback(async () => {
    await saveSetupDismissed(true);
    if (
      shouldGateLoginAfterSetup({
        hasServerUrl: !!getApiBaseUrl(),
        isAuthenticated: isAuthenticated() && !needsEmailUpdate(),
      })
    ) {
      setNeedsAuth(true);
    }
    setNeedsSetup(false);
    // Reconnect so the newly-configured WebSocket picks up the server URL.
    reconnect();
  }, [reconnect]);
  /**
   * Called by `LoginScreen` after a successful login or setup call. The JWT
   * is already persisted to AsyncStorage at this point. Clearing `needsAuth`
   * reconnects the WebSocket and re-runs the project/agent load, which is
   * skipped while the login screen is up.
   */
  const completeAuth = useCallback(() => {
    setNeedsAuth(false);
    reconnect();
    // Signing in is what lets a server push here again after a sign-out.
    void PUSH_REGISTRAR.signedIn(getServerBaseUrl());
  }, [reconnect]);
  /**
   * Sign out of the active server. The server is asked to stop pushing to
   * this phone first, while its login still exists; sign-out completes even
   * if that fails.
   */
  const signOutOfServer = useCallback(async () => {
    // Pinned now: the user may switch servers while the unregister runs.
    const serverUrl = getServerBaseUrl();
    if (!serverUrl) return;
    await signOutOfServerFlow({
      serverUrl,
      registrar: PUSH_REGISTRAR,
      currentServerUrl: getServerBaseUrl,
      onSignedOutWhileActive: () => {
        setNeedsAuth(true);
        reconnect();
      },
    });
  }, [reconnect]);
  useEffect(() => onDeadSession(() => setNeedsAuth(true)), []);
  // Shared with org switching so a signed-in load always beats an earlier
  // unauthenticated fetch (login-screen org change clears the token first).
  const orgDataGenerationRef = useRef(createOrgDataGeneration());
  const applyOrgData = useCallback(async (isCurrent: () => boolean) => {
    const [agentData, projectData, cronSessionData] = await Promise.all([
      api.getAgents(),
      api.getProjects().catch(() => []),
      api.getCronSessions().catch(() => []),
    ]);
    if (!isCurrent()) return;
    setAgents(agentData);
    setProjects(projectData);
    setCronSessions(cronSessionData);
    if (agentData.length > 0) setActiveAgentId(agentData[0].id);
  }, []);
  // Load agents and projects once we can actually authenticate the request.
  // `needsAuth` is a dependency on purpose: the provider stays mounted behind
  // the login screen, and a fetch made before the JWT exists would stick an
  // empty project list on screen until the next full reload.
  useEffect(() => {
    if (!shouldLoadOrgData({ configReady, needsAuth, hasServerUrl: !!getApiBaseUrl() })) return;
    const isCurrent = orgDataGenerationRef.current.begin();
    void applyOrgData(isCurrent).catch((err: any) => {
      if (isCurrent()) console.error('Failed to load initial data:', err);
    });
  }, [applyOrgData, configReady, needsAuth]);
  // Load sessions when agent changes (guarded on configReady)
  useEffect(() => {
    if (!configReady || !activeAgentId || !getApiBaseUrl()) return;
    // Snapshot the pending target (if any) before the async fetch so a
    // cross-agent navigation (e.g. `handleOpenHandoffSession`) can't be
    // clobbered by the default `data[0].id` fallback when the list arrives.
    // Mirror of the web client's logic in `client/src/App.jsx:1277-1304`.
    const targetSessionId = pendingSessionIdRef.current;
    pendingSessionIdRef.current = null;
    // Guard against a stale async continuation: if the user switches agents
    // while the sessions list (or the deep-link fetch below) is in flight,
    // the resolved `.then` must not stomp state for the newer agent. Mirror
    // of the web client's `cancelled` flag in `client/src/App.tsx`.
    let cancelled = false;
    // Fetch archived (soft-deleted) sessions in parallel so the drawer's
    // Archived section is populated at the same moment the live list lands.
    api
      .getArchivedSessions(activeAgentId)
      .then((rows: any) => {
        if (cancelled) return;
        setArchivedSessions(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setArchivedSessions([]);
      });
    api
      .getSessions(activeAgentId)
      .then(async (data: any) => {
        if (cancelled) return;
        setSessions(data);
        // Hydrate the changes_ready banner state from persisted session rows so
        // the "Create PR" button survives page refreshes / reconnects. Merge
        // rather than replace to preserve banners for sessions of other agents.
        setChangesReady((prev: any) => ({ ...prev, ...hydrateChangesReady(data) }));
        // Once HubScreen's GET has resolved a live Hub session, that session
        // owns the active chat while the Hub is focused. A late project-agent
        // restore must not stomp it, or the embedded assistant composer would
        // re-bind to a project session. Only guard once the Hub session
        // exists — before then, normal restore still runs.
        if (
          hubFocusedRef.current &&
          hubSessionIdRef.current &&
          activeAgentId !== HUB_ASSISTANT_AGENT_ID
        ) {
          return;
        }
        // Honor an explicitly requested target session (kanban assign, handoff
        // "Open session" tap, etc.) instead of defaulting to the newest row.
        let target = selectSessionToActivate(data, targetSessionId);
        // Deep-linked to a session the owner-only list omits (dashboard admin
        // click-through into another user's session). Fetch it by id — the
        // server read-gate lets org admins view it — and select it instead of
        // snapping to the caller's newest owned session. Falls back to `target`
        // when the read is denied (non-admin caller).
        const fetchId = deepLinkFetchId(data, targetSessionId);
        if (fetchId) {
          const foreign = await api.getSession(fetchId).catch(() => null);
          if (cancelled) return;
          if (foreign && foreign.id) {
            // Merge the single fetched row so downstream lookups resolve
            // its engine/model and the top bar shows its title. This
            // surfaces exactly one foreign row — the session the user
            // explicitly opened — not an enumeration (the list endpoint
            // stays owner-only). Writes are rejected server-side, so the
            // view is read-only.
            setSessions((prev: any) => upsertSessionRow(prev, foreign));
            target = foreign;
          }
        }
        if (target) {
          setActiveSessionId(target.id);
          const agent = agents.find((a: any) => a.id === activeAgentId);
          setSessionEngine(target.engine || agent?.engine || 'claude-code');
          setSessionModel(
            target.model || defaultModelForEngine(target.engine || agent?.engine || 'claude-code'),
          );
          setSessionConsultMode(isSessionConsultModeEnabled(target));
          setSessionReasoningEffort(target.reasoning_effort === 'pro' ? 'pro' : 'high');
        } else {
          setActiveSessionId(null);
          setMessages([]);
          const agent = agents.find((a: any) => a.id === activeAgentId);
          setSessionEngine(agent?.engine || 'claude-code');
          setSessionModel(defaultModelForEngine(agent?.engine || 'claude-code'));
          setSessionConsultMode(false);
          setSessionReasoningEffort('high');
        }
      })
      .catch((err: any) => {
        if (!cancelled) console.error('Failed to load sessions:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [configReady, activeAgentId, modelConfig]);
  useEffect(() => {
    if (!configReady || !getApiBaseUrl()) return;
    let cancelled = false;
    api
      .getModelConfig()
      .then((cfg: any) => {
        if (!cancelled) setModelConfig(cfg);
      })
      .catch((err: any) => {
        console.warn('[modelConfig] GET /api/config/models failed:', err?.message || err);
      });
    return () => {
      cancelled = true;
    };
  }, [configReady]);
  // Load skills for /slash-command autocomplete when agent changes
  useEffect(() => {
    if (!configReady || !activeAgentId || !getApiBaseUrl()) {
      setSkills([]);
      return;
    }
    reloadActiveAgentSkills();
  }, [configReady, activeAgentId, reloadActiveAgentSkills]);
  // Update session engine/model/worktree state when session changes
  useEffect(() => {
    if (!activeSessionId) return;
    const session = sessions.find((s: any) => s.id === activeSessionId);
    if (session?.engine) setSessionEngine(session.engine);
    if (session?.model) setSessionModel(session.model);
    if (session) {
      setSessionConsultMode(isSessionConsultModeEnabled(session));
      setSessionReasoningEffort(session.reasoning_effort === 'pro' ? 'pro' : 'high');
    }
  }, [activeSessionId, sessions]);
  // Mirror web App.jsx: if the session engine has no authenticated models,
  // migrate to the first engine that does so TopBar state matches the server.
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
  // Reload messages for the currently-active session. Exposed via context so
  // screens (e.g. ChatScreen on navigation focus, DrawerContent when the user
  // re-taps the already-active session) can force a refresh without waiting
  // for `activeSessionId` to change. The race-guard logic lives in the pure
  // `createReloadMessages` factory.
  const reloadMessages = useMemo<any>(
    () =>
      createReloadMessages({
        fetchMessages: (sid: any) => api.getMessages(sid),
        getActiveSessionId: () => activeSessionIdRef.current,
        setMessages,
      }),
    [],
  );
  // Load messages when session changes.
  // NOTE: when switching sessions via the drawer, reloadMessages may fire
  // twice — once here (activeSessionId changed) and once via ChatScreen's
  // useFocusEffect (screen regained focus). The race guard inside
  // createReloadMessages makes this safe; the duplicate fetch is harmless.
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    reloadMessages();
  }, [activeSessionId, reloadMessages]);
  // Load handoffs emitted from this session so HandoffCard can resolve
  // `to_session_id` and render a tappable "Open session" link. Best-effort —
  // a missing endpoint or offline state must never block the chat render.
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
  // Navigate into a handoff's target session (invoked from HandoffCard).
  // Stash the target on `pendingSessionIdRef` *before* flipping
  // `activeAgentId` so the sessions-load effect (which fires on the agent
  // change) honors it instead of clobbering it with `data[0].id`. We still
  // set `activeSessionId` optimistically so the UI swaps immediately; the
  // loader then confirms it once the session list arrives.
  const handleOpenHandoffSession = useCallback((targetAgentId: any, targetSessionId: any) => {
    if (!targetAgentId || !targetSessionId) return;
    pendingSessionIdRef.current = targetSessionId;
    setActiveAgentId(targetAgentId);
    setActiveSessionId(targetSessionId);
  }, []);
  /** Opens an organization chat in the shared chat screen, owned by the signed-in user. */
  const openOrganizationChat = useCallback(
    (target: { agentId: string; sessionId: string; agent?: any; session?: any }) => {
      if (!target.agentId || !target.sessionId) return;
      setOrganizationChatAgent(
        target.agent ?? { id: target.agentId, name: 'Organization agent', engine: 'claude-code' },
      );
      if (target.session && target.agentId === activeAgentIdRef.current)
        setSessions((prev: any) => upsertSessionRow(prev, target.session));
      pendingSessionIdRef.current = target.sessionId;
      setActiveAgentId(target.agentId);
      setActiveSessionId(target.sessionId);
    },
    [],
  );
  // Rehydrate streaming state from activeTasks when switching sessions.
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
  }, [activeSessionId]);
  const reconnectRef = useRef(reconnect);
  reconnectRef.current = reconnect;
  const authProbeGenRef = useRef(0);
  // Resolves once the connection points at the new org; the data reload runs
  // in the background so a hung endpoint can't freeze the caller's UI.
  const switchToOrg = useMemo(
    () =>
      createOrgSwitcher({
        switchOrg: async (orgId) => {
          // Chat belongs to the org being left: drop it before the API
          // configuration changes, so nothing of it stays on screen and no
          // response still in flight for it can land afterwards.
          hubChatAccountGate.invalidate();
          notificationInboxAccountGate.invalidate();
          const { switchOrg } = require('../utils/orgs');
          // Pinned before the await, so an overlapping switch can't redirect it.
          const target = getOrgs()?.orgs?.find((o: any) => o.id === orgId)?.remoteUrl;
          await switchOrg(orgId);
          // Retry this server's registration: it may have been unreachable
          // at launch. Not awaited, so a slow server can't hold the switch.
          void PUSH_REGISTRAR.syncServer(target);
        },
        onConnectionChanged: () => {
          // Reset all state
          setAgents([]);
          setProjects([]);
          setSessions([]);
          setActiveAgentId(null);
          setOrganizationChatAgent(null);
          setActiveSessionId(null);
          setMessages([]);
          setThinking(false);
          setStreamingContent('');
          setActiveTasks({});
          setSessionAgents([]);
          setSessionRoundProcessing(false);
          setDelegations({});
          setMessageQueues({});
          setEventsByMessage({});
          setCronSessions([]);
          setChangesReady({});
          setFinalizeStatusBySession({});
          setSessionHandoffs([]);
          setSessionConsultMode(false);
          // Chat stays empty until the new org's connection is up; the gate
          // loads it then (and drops anything that slipped in meanwhile).
          hubChatAccountGate.invalidate();
          notificationInboxAccountGate.invalidate();
          // Reconnect WebSocket to new org. The token for this server was
          // restored before we got here, so the socket is not opened with the
          // previous org's login.
          reconnectRef.current();
          // A server we have never signed into should show the login screen
          // now. Leaving needsAuth false strands the app on a dead socket
          // until it is force-quit.
          const probeUrl = getApiBaseUrl();
          const probeGen = ++authProbeGenRef.current;
          serverAuthConfiguredRef.current = true;
          if (probeUrl) {
            void getAuthStatus(probeUrl)
              .then((status) => {
                if (probeGen !== authProbeGenRef.current) return;
                serverAuthConfiguredRef.current = Boolean(status?.authConfigured);
                setNeedsAuth(
                  shouldGateAuthFromStatus({
                    status,
                    isAuthenticated: isAuthenticated(),
                    needsEmailUpdate: needsEmailUpdate(),
                  }),
                );
              })
              .catch(() => {
                /* unreachable — keep the strict default, don't trap login */
              });
          }
        },
        loadData: async (isSwitchCurrent) => {
          const isGenerationCurrent = orgDataGenerationRef.current.begin();
          await applyOrgData(() => isSwitchCurrent() && isGenerationCurrent());
        },
        onLoadError: (err) => console.error('Failed to load data after org switch:', err),
      }),
    [applyOrgData],
  );
  switchToOrgRef.current = switchToOrg;
  const handleSwitchOrg = useCallback((orgId: any) => switchToOrg(orgId), [switchToOrg]);
  const handleNewSession = useCallback(
    async (agentIdOverride?: string) => {
      const agentId = agentIdOverride || activeAgentId;
      if (!agentId) return;
      const agent = agents.find((a: any) => a.id === agentId);
      if (agent?.role === 'reviewer') {
        Alert.alert(
          'Reviewer',
          'Reviewer agents only run from the Finalize review phase — sessions cannot be started manually.',
        );
        return;
      }
      // A brand-new session always starts at the project default mode. Consult is
      // a per-session mode opted into via the session-control picker, not a sticky
      // global — inheriting the previous session's consult flag made tapping `+`
      // from a Consult session create another Consult session, overriding the
      // project's default Finalize automation. Matches the web client.
      const session = await api.createSession(agentId, undefined);
      if (agentId !== activeAgentId) {
        pendingSessionIdRef.current = session.id;
        setActiveAgentId(agentId);
      }
      setSessions((prev: any) =>
        prev.some((s: any) => s.id === session.id) ? prev : [session, ...prev],
      );
      setActiveSessionId(session.id);
      setSessionEngine(session.engine || agent?.engine || 'claude-code');
      setSessionModel(
        session.model || defaultModelForEngine(session.engine || agent?.engine || 'claude-code'),
      );
      setSessionConsultMode(isSessionConsultModeEnabled(session));
      setSessionReasoningEffort(session.reasoning_effort === 'pro' ? 'pro' : 'high');
      setMessages([]);
    },
    [activeAgentId, agents],
  );
  const handleRenameSession = useCallback(async (sessionId: string, name: string) => {
    const updated = await api.renameSession(sessionId, name);
    const nextName = updated?.name || name;
    setSessions((prev: any) =>
      prev.map((s: any) => (s.id === sessionId ? { ...s, name: nextName } : s)),
    );
    return nextName;
  }, []);
  const reloadAgentSessions = useCallback(async (agentId: string) => {
    const [live, archived] = await Promise.all([
      api.getSessions(agentId),
      api.getArchivedSessions(agentId).catch(() => []),
    ]);
    const sessions = Array.isArray(live) ? live : [];
    const archivedRows = Array.isArray(archived) ? archived : [];
    if (agentId === activeAgentIdRef.current) {
      setSessions(sessions);
      setArchivedSessions(archivedRows);
      setChangesReady((prev: any) => ({ ...prev, ...hydrateChangesReady(sessions) }));
    }
    return { sessions, archived: archivedRows };
  }, []);
  const handleReorderProjects = useCallback((newOrderIds: string[]) => {
    setProjects((prev: any) => {
      const byId = new Map(prev.map((p: any) => [p.id, p]));
      const reordered = newOrderIds.map((id) => byId.get(id)).filter(Boolean);
      for (const project of prev) {
        if (!newOrderIds.includes(project.id)) reordered.push(project);
      }
      return reordered;
    });
    api.reorderProjects(newOrderIds).catch(() => {
      api
        .getProjects()
        .then((data: any) => setProjects(data))
        .catch(() => {});
    });
  }, []);
  // Start a chat session with a SPECIFIC agent (not necessarily the active one)
  // and make it active. The caller navigates to the Chat screen. Used by the
  // Skills screen "Build a skill" button to open the project's Skill Builder
  // coach. Mirrors the web client's handleStartSessionWithAgent.
  const handleStartSessionWithAgent = useCallback(
    async (agentId: any) => {
      if (!agentId) return;
      const agent = agents.find((a: any) => a.id === agentId);
      if (agent?.role === 'reviewer') return;
      // New sessions start at the project default; Consult is opted into
      // per-session (see handleNewSession), never inherited across creation.
      const session = await api.createSession(agentId, undefined);
      setActiveAgentId(agentId);
      setSessions((prev: any) =>
        prev.some((s: any) => s.id === session.id) ? prev : [session, ...prev],
      );
      setActiveSessionId(session.id);
      setSessionEngine(session.engine || agent?.engine || 'claude-code');
      setSessionModel(
        session.model || defaultModelForEngine(session.engine || agent?.engine || 'claude-code'),
      );
      setSessionConsultMode(isSessionConsultModeEnabled(session));
      setSessionReasoningEffort(session.reasoning_effort === 'pro' ? 'pro' : 'high');
      setMessages([]);
    },
    [agents],
  );
  const handleStartSkillBuilderMode = useCallback(
    async (projectId: any) => {
      // Skill Builder is a DEV-agent mode — only a non-helper agent gets the
      // builder prompt/role. Reject helper-only (or empty) rosters instead of
      // falling back to inProject[0] (which could be a docs/reviewer/skill-
      // builder helper running with the wrong prompt).
      const agent = agents.find(
        (a: any) =>
          a.projectId === projectId &&
          a.active !== false &&
          a.role !== 'skill-builder' &&
          a.role !== 'reviewer' &&
          a.role !== 'docs',
      );
      if (!agent) return;
      const session = await api.createSession(agent.id, '[Skill Builder]');
      const updated = await api.updateSession(session.id, {
        session_mode: 'skill-builder',
        ask_mode: false,
        finalize_automation: 'manual',
      });
      setActiveAgentId(agent.id);
      setSessions((prev: any) =>
        prev.some((s: any) => s.id === updated.id) ? prev : [updated, ...prev],
      );
      setActiveSessionId(updated.id);
      setSessionEngine(updated.engine || agent.engine || 'claude-code');
      setSessionModel(
        updated.model || defaultModelForEngine(updated.engine || agent.engine || 'claude-code'),
      );
      setSessionConsultMode(false);
      setSessionReasoningEffort(updated.reasoning_effort === 'pro' ? 'pro' : 'high');
      setMessages([]);
    },
    [agents],
  );
  // `handleWorktreeChange` was removed when Agent Hub locked to
  // worktree-only sessions. The legacy `PUT /sessions/:id/worktree`
  // endpoint no longer exists.
  const handleConsultModeChange = useCallback(
    async (enabled: any) => {
      const sid = activeSessionIdRef.current;
      const prevEnabled = sessionConsultMode;
      setSessionConsultMode(enabled);
      if (!sid) return;
      try {
        const session =
          activeSession?.id === sid
            ? activeSession
            : sessions.find((s: any) => s.id === sid) ||
              cronSessions.find((s: any) => s.id === sid) ||
              null;
        const agent = agents.find((a: any) => a.id === (session?.agent_id || activeAgentId));
        const project = projects.find((p: any) => p.id === agent?.projectId);
        const workflowProject = isWorkflowProject(project);
        const patch: any = {
          session_mode: enabled ? 'consult' : workflowProject ? 'scoping' : 'chat',
        };
        if (!workflowProject) patch.finalize_automation = 'manual';
        const updated = await api.updateSession(sid, patch);
        setSessions((prev: any) =>
          prev.map((s: any) => (s.id === updated.id ? { ...s, ...updated } : s)),
        );
        setSessionConsultMode(isSessionConsultModeEnabled(updated));
      } catch (err: any) {
        console.warn('updateSession consult mode failed; reverting toggle:', err);
        setSessionConsultMode(prevEnabled);
      }
    },
    [activeAgentId, activeSession, agents, cronSessions, projects, sessionConsultMode, sessions],
  );
  const handleEngineChange = useCallback(
    async (engine: any) => {
      setSessionEngine(engine);
      const defaultModel = defaultModelForEngine(engine);
      setSessionModel(defaultModel);
      const sid = activeSessionIdRef.current;
      if (sid) {
        const updated = await api.setSessionEngine(sid, engine);
        setSessions((prev: any) =>
          prev.map((s: any) => (s.id === updated.id ? { ...s, engine: updated.engine } : s)),
        );
        const modelUpdated = await api.setSessionModel(sid, defaultModel);
        setSessions((prev: any) =>
          prev.map((s: any) =>
            s.id === modelUpdated.id ? { ...s, model: modelUpdated.model } : s,
          ),
        );
      }
    },
    [modelConfig],
  );
  const handleModelChange = useCallback(async (model: any) => {
    setSessionModel(model);
    const sid = activeSessionIdRef.current;
    if (sid) {
      const updated = await api.setSessionModel(sid, model);
      setSessions((prev: any) =>
        prev.map((s: any) => (s.id === updated.id ? { ...s, model: updated.model } : s)),
      );
    }
  }, []);
  const persistHubModel = useCallback(async (engine: string, model: string) => {
    // Snapshot so a failed PUT rolls back instead of leaving the picker
    // showing an engine/model the server never accepted. Read the live value
    // through the functional updater (the callback has empty deps).
    let prevEngine = 'claude-code';
    let prevModel = 'claude-opus-5-5';
    setSessionEngine((cur: any) => {
      prevEngine = cur;
      return engine;
    });
    setSessionModel((cur: any) => {
      prevModel = cur;
      return model;
    });
    setSessions((prev: any) =>
      prev.map((s: any) => (s.agent_id === HUB_ASSISTANT_AGENT_ID ? { ...s, engine, model } : s)),
    );
    try {
      const saved: any = await api.putHubModel({ engine, model });
      if (saved?.engine) setSessionEngine(saved.engine);
      if (saved?.model) setSessionModel(saved.model);
      if (saved?.engine || saved?.model) {
        setSessions((prev: any) =>
          prev.map((s: any) =>
            s.agent_id === HUB_ASSISTANT_AGENT_ID
              ? { ...s, engine: saved.engine || s.engine, model: saved.model || s.model }
              : s,
          ),
        );
      }
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
      Alert.alert('Hub model', err?.message || 'Failed to save Hub model');
    }
  }, []);
  // Optimistically persist the Codex reasoning preset ('high' | 'pro'); reverts
  // on server error. Mirrors handleAskModeChange.
  const sessionComputerToolOn = resolveComputerToolEnabled(
    activeAgent?.computerToolEnabled,
    activeSession?.computer_tool_enabled,
  );
  // Persist the per-session computer tool switch; the server row is the
  // source of truth, so local state only changes once the PUT succeeds.
  const handleComputerToolChange = useCallback(async (enabled: boolean) => {
    const sid = activeSessionIdRef.current;
    if (!sid) return;
    const updated = await api.setSessionComputerTool(sid, enabled);
    setSessions((list: any) =>
      list.map((s: any) =>
        s.id === updated.id ? { ...s, computer_tool_enabled: updated.computer_tool_enabled } : s,
      ),
    );
  }, []);
  const handleReasoningEffortChange = useCallback(async (effort: any) => {
    let prev = 'high';
    setSessionReasoningEffort((cur: any) => {
      prev = cur;
      return effort;
    });
    const sid = activeSessionIdRef.current;
    if (!sid) return;
    try {
      const updated = await api.setSessionReasoningEffort(sid, effort);
      setSessions((list: any) =>
        list.map((s: any) =>
          s.id === updated.id ? { ...s, reasoning_effort: updated.reasoning_effort } : s,
        ),
      );
    } catch (err: any) {
      console.warn('setSessionReasoningEffort failed; reverting:', err);
      setSessionReasoningEffort(prev);
      throw err;
    }
  }, []);
  const handleDeleteSession = useCallback(async (sessionId: any) => {
    // Mirror of the web client's pattern (client/src/App.jsx) — await the
    // DELETE first, then mutate state only on success. Previously we removed
    // the row from `sessions` *before* the await, so a failed DELETE (network
    // drop, 5xx, auth) would leave the session invisible without adding it
    // to `archivedSessions` — the exact data-loss surface this feature is
    // meant to prevent. We also snapshot the row up-front so the archived
    // list can carry the real message_count rather than a placeholder.
    const deletedRow = sessionsRef.current?.find((s: any) => s.id === sessionId) || null;
    try {
      await api.deleteSession(sessionId);
      setBrowserScreensBySession((prev: any) => {
        if (!prev[sessionId]) return prev;
        const next = { ...prev };
        delete (next as any)[sessionId];
        return next;
      });
      setPreviewEventBySession((prev) => {
        if (!prev[sessionId]) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      setSessions((prev: any) => {
        const remaining = prev.filter((s: any) => s.id !== sessionId);
        if (activeSessionIdRef.current === sessionId) {
          setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
        }
        return remaining;
      });
      if (deletedRow) {
        setArchivedSessions((prev: any) => {
          if (prev.some((s: any) => s.id === sessionId)) return prev;
          return [
            {
              ...deletedRow,
              // Client clock — may drift from server's UTC datetime('now')
              // used by the purge cron. The next fetch reconciles.
              deleted_at: new Date().toISOString(),
              message_count: deletedRow.message_count ?? 0,
            },
            ...prev,
          ];
        });
      }
    } catch (err: any) {
      // Surface the failure so the user knows the row is still live. No
      // rollback needed because we never removed it optimistically.
      Alert.alert(
        'Delete failed',
        err?.message || 'Could not archive this session. Please try again.',
      );
      throw err;
    }
  }, []);
  const handleRestoreSession = useCallback(async (sessionId: any) => {
    setRestoringSessionIds((prev: any) => {
      const next = new Set(prev);
      next.add(sessionId);
      return next;
    });
    try {
      const restored = await api.restoreSession(sessionId);
      // Drop from archived; the WS `session_restored` event is the canonical
      // path for re-inserting into `sessions`, but we mirror here to cover
      // the initiating device on a slow WS.
      setArchivedSessions((prev: any) => prev.filter((s: any) => s.id !== sessionId));
      setSessions((prev: any) => withRestoredSession(prev, restored, activeAgentIdRef.current));
      return restored || {};
    } catch (err: any) {
      Alert.alert(
        'Restore failed',
        err?.message || 'Could not restore this session. Please try again.',
      );
      return null;
    } finally {
      setRestoringSessionIds((prev: any) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  }, []);
  useEffect(() => {
    streamingMsgIdRef.current = streamingMsgId;
  }, [streamingMsgId]);
  const handleCancel = useCallback(() => {
    const sid = activeSessionIdRef.current;
    if (sid) {
      setChatScrollNonce((n: any) => n + 1);
      send({ type: 'cancel', sessionId: sid });
      setThinking(false);
      setStreamingContent('');
      setStreamingMsgId(null);
      setStreamingEngine(null);
      setStreamingAgent(null);
    }
  }, [send]);
  const clearHubChat = useCallback(async () => {
    handleCancel();
    const body: any = await api.clearHubSession();
    const session = body?.session;
    if (session?.id) {
      // Clear mints a FRESH Hub session — advance the canonical Hub id too,
      // or the embedded composer stays locked (activeSessionId !==
      // hubSessionId) until Hub is unfocused and remounted.
      setHubSessionId(session.id);
      pendingSessionIdRef.current = session.id;
      setActiveSessionId(session.id);
      setMessages([]);
      if (session.engine) setSessionEngine(session.engine);
      if (session.model) setSessionModel(session.model);
    }
    return body;
  }, [handleCancel]);
  // Derived from persisted message history: any user message containing an
  // `agenthub:ask:answer` block with a matching askId marks that picker as
  // submitted. Surviving reloads requires this — in-memory state is lost on
  // restart, but the user message is persisted in the DB and re-fetched.
  const askSubmittedFromHistory = useMemo<any>(() => extractSubmittedAskIds(messages), [messages]);
  // Union of optimistic (just-tapped) + history-derived (persisted). Passed
  // to the picker's `submitted` prop and used to short-circuit duplicate
  // sends from <AskUserQuestion>.
  const askSubmitted = useMemo<any>(() => {
    if (askSubmittedOptimistic.size === 0) return askSubmittedFromHistory;
    const union = new Set(askSubmittedFromHistory);
    for (const id of askSubmittedOptimistic) union.add(id);
    return union;
  }, [askSubmittedOptimistic, askSubmittedFromHistory]);
  const handleSend = useCallback(
    async (
      content: any,
      images: any = [],
      { interrupt = false, agentId: agentIdOverride, sessionId: sessionIdOverride }: any = {},
    ) => {
      // Callers not bound to the shared activeAgentId/activeSessionId globals
      // (the embedded Hub assistant) must pass their agent/session EXPLICITLY —
      // the Hub turn always runs as `__hub_assistant__` + the Hub session,
      // regardless of whichever project agent init/restore left active.
      // The agent a turn runs as is a property of the ACTIVE SESSION, not the
      // shared activeAgentId. When the active session is the Hub session, the
      // turn runs as `__hub_assistant__` (the server spawns from this id).
      const targetAgentId =
        agentIdOverride ??
        (activeSessionIdRef.current && activeSessionIdRef.current === hubSessionIdRef.current
          ? HUB_ASSISTANT_AGENT_ID
          : activeAgentId);
      let sessionId = sessionIdOverride ?? activeSessionIdRef.current;
      if (!sessionId) {
        // Implicit first-message create also starts at the project default —
        // Consult is not inherited from the prior session (see handleNewSession).
        const coalesceKey = targetAgentId;
        const session = await coalescePromiseByKey(implicitSessionCreateByKeyRef, coalesceKey, () =>
          api.createSession(targetAgentId, undefined).then((s: any) => {
            setSessions((prev: any) =>
              prev.some((x: any) => x.id === s.id) ? prev : [s, ...prev],
            );
            setActiveSessionId(s.id);
            activeSessionIdRef.current = s.id;
            return s;
          }),
        );
        sessionId = session.id;
      }
      // Upload attachments first, then send chat with references. Images go
      // through the base64 /api/upload route; videos and generic files stream
      // via /api/upload/file using api.uploadFile (FileSystem.uploadAsync).
      let uploadedImages: any[] = [];
      if (images.length > 0) {
        const persisted = images.filter(isPersistedUploadAttachment);
        const pending = images.filter((img: any) => !isPersistedUploadAttachment(img));
        try {
          const uploaded = pending.length > 0 ? await uploadAttachments(pending, api) : [];
          uploadedImages = [...persisted, ...uploaded];
        } catch (err: any) {
          console.error('Attachment upload failed:', err);
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
    },
    [activeAgentId, send],
  );
  const handleInterruptQueuedMessage = useCallback(
    (message: any) => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId || !message?.id) return;
      const { chat } = buildInterruptQueuedMessageDispatch({
        message,
        // Session-derived identity: a queued Hub message re-dispatches as the
        // Hub agent, not whatever activeAgentId holds.
        agentId: sessionId === hubSessionIdRef.current ? HUB_ASSISTANT_AGENT_ID : activeAgentId,
        sessionId,
      });
      send(chat);
    },
    [send, activeAgentId],
  );
  // Handle submission from an <AskUserQuestion> picker. We dispatch the
  // pre-formatted chat message (which already contains the
  // agenthub:ask:answer fenced block) and mark the askId as submitted so the
  // picker flips to a disabled "Submitted" state immediately. Once the user
  // message persists to history, `askSubmittedFromHistory` picks the id up
  // from the fenced-block scan and the optimistic set becomes redundant —
  // the union in `askSubmitted` keeps the brief overlap seamless. Mirrors
  // `client/src/App.jsx:handleAskSubmit`.
  const handleAskSubmit = useCallback(
    (askId: any, messageText: any) => {
      if (!askId || !messageText) return;
      // Short-circuit duplicate submissions if the picker somehow re-fires.
      setAskSubmittedOptimistic((prev: any) => {
        if (prev.has(askId)) return prev;
        const next = new Set(prev);
        next.add(askId);
        return next;
      });
      handleSend(messageText);
    },
    [handleSend],
  );
  const handleCredentialSubmit = useCallback(
    (_requestId: any, messageText: any) => {
      if (!messageText) return;
      handleSend(messageText);
    },
    [handleSend],
  );
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
        if (!cancelled) setSessionAgents(detail.agents || []);
      })
      .catch(() => {
        if (!cancelled) setSessionAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);
  const handleSessionAgentsUpdated = useCallback((detail: any) => {
    if (!detail?.id) return;
    setSessionAgents(detail.agents || []);
    setSessions((prev: any) =>
      prev.map((s: any) => (s.id === detail.id ? { ...s, ...detail } : s)),
    );
  }, []);
  const handleDequeue = useCallback(
    (messageId: any) => {
      const sid = activeSessionIdRef.current;
      if (sid) {
        // Removing a queued message only discards that message. The in-flight
        // turn keeps running — dropping a follow-up must never cancel the agent.
        send({ type: 'dequeue', sessionId: sid, messageId });
        setMessages((prev: any) => prev.filter((m: any) => m.id !== messageId));
      }
    },
    [send],
  );
  const handleEditQueuedMessage = useCallback(
    (messageId: any, content: any) => {
      const sid = activeSessionIdRef.current;
      if (sid) {
        send({ type: 'edit_queue_item', sessionId: sid, messageId, content });
        setMessages((prev: any) =>
          prev.map((m: any) => (m.id === messageId ? { ...m, content } : m)),
        );
      }
    },
    [send],
  );
  const handleDelegationCancel = useCallback(() => {
    const sid = activeSessionIdRef.current;
    if (sid) {
      send({ type: 'delegation_cancel', sessionId: sid });
    }
  }, [send]);
  const handleEventsLoaded = useCallback((messageId: any, events: any) => {
    setEventsByMessage((prev: any) => {
      const existing = prev[messageId];
      if (Array.isArray(existing) && existing.length > 0) return prev;
      return { ...prev, [messageId]: events };
    });
  }, []);
  /**
   * Seed the unread support-ticket count for a project from the server. Called
   * by the Support screen on mount so the drawer badge is correct on a cold
   * load; after this the WebSocket unreadCount keeps it live.
   */
  const refreshSupportUnreadCount = useCallback(async (projectId: any) => {
    if (!projectId) return;
    try {
      const { count } = await api.getSupportUnreadCount(projectId);
      setUnreadTicketCounts((prev: any) => ({ ...prev, [projectId]: count ?? 0 }));
    } catch {
      /* best-effort; WebSocket events still keep the badge current */
    }
  }, []);
  /** Optimistically set a project's unread support-ticket count (e.g. to 0). */
  const setSupportUnreadCount = useCallback((projectId: any, count: any) => {
    if (!projectId) return;
    setUnreadTicketCounts((prev: any) => ({ ...prev, [projectId]: Math.max(0, count) }));
  }, []);
  /**
   * Seed/refresh a project's open-severity security counts from the server.
   * Called by the Security screen on mount and on every kanban_update for the
   * project (a scan's only WS signal), so the drawer badge stays live. Passing
   * ?status=open keeps the payload to just the open rows.
   */
  // Coalesce per-project findings fetches: a burst of kanban_update events (a
  // scan inserting many finding-cards) must not fan out into one request each.
  // Concurrent same-project calls share a single in-flight fetch.
  const securityCountFetchesRef = useRef<Map<string, Promise<unknown>>>(new Map());
  const refreshSecurityOpenCounts = useCallback(async (projectId: any) => {
    if (!projectId) return;
    await coalescePromiseByKey(securityCountFetchesRef, projectId, async () => {
      try {
        const data = await api.getSecurityFindings(projectId, 'open');
        const counts = data?.openCounts;
        if (counts) setSecurityOpenCounts((prev: any) => ({ ...prev, [projectId]: counts }));
      } catch {
        /* best-effort; the badge stays at its last value */
      }
    });
  }, []);
  refreshSecurityOpenCountsRef.current = refreshSecurityOpenCounts;
  // Provider-level seed of the Security drawer badge: once the project list is
  // known, fetch each project's open-severity counts so the badge is correct on
  // a cold launch. Mirrors the Support badge seed. Each project seeded once; the
  // kanban_update refresh keeps it live. Resets when the list empties (logout).
  const seededSecurityProjectsRef = useRef<any>(new Set());
  useEffect(() => {
    if (!projects || projects.length === 0) {
      seededSecurityProjectsRef.current = new Set();
      return;
    }
    const toSeed = projects.filter(
      (p: any) => p?.id && !seededSecurityProjectsRef.current.has(p.id),
    );
    if (toSeed.length === 0) return;
    toSeed.forEach((p: any) => seededSecurityProjectsRef.current.add(p.id));
    let cancelled = false;
    Promise.all(
      toSeed.map((p: any) =>
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
  // Coalesced like the security counts above: WS bursts must not fan out into
  // one open-pulls fetch per event.
  const pullCountFetchesRef = useRef<Map<string, PendingRefresh>>(new Map());
  const refreshOpenPullCount = useCallback(async (projectId: any) => {
    if (!projectId) return;
    await coalesceRefreshByKey(pullCountFetchesRef, projectId, async () => {
      try {
        const data = await api.getProjectPulls(projectId, { state: 'open', limit: 100 });
        const count = Array.isArray(data?.pulls) ? data.pulls.length : 0;
        setOpenPullCounts((prev: any) => ({ ...prev, [projectId]: count }));
      } catch {
        setOpenPullCounts((prev: any) =>
          prev[projectId] === undefined ? { ...prev, [projectId]: 0 } : prev,
        );
      }
    });
  }, []);
  refreshOpenPullCountRef.current = refreshOpenPullCount;
  const seededPullProjectsRef = useRef<any>(new Set());
  useEffect(() => {
    if (!projects || projects.length === 0) {
      seededPullProjectsRef.current = new Set();
      return;
    }
    const toSeed = projects.filter(
      (p: any) =>
        p?.id &&
        !isWorkflowProject(p) &&
        (p.githubRepo || p.gitHost === 'agenthub') &&
        !seededPullProjectsRef.current.has(p.id),
    );
    if (toSeed.length === 0) return;
    toSeed.forEach((p: any) => seededPullProjectsRef.current.add(p.id));
    let cancelled = false;
    Promise.all(
      toSeed.map((p: any) =>
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
  // Provider-level seed of the Support drawer badge: as soon as the project list
  // is known, fetch each project's unread count so the badge is correct on a
  // cold app launch — not only after the user opens a project's Support screen.
  // Mirrors the web client, which seeds from the project list in App.jsx. Each
  // project is seeded once; the WebSocket `unreadCount` keeps it live after.
  // Resets when the list empties (logout) so the next login re-seeds.
  const seededTicketProjectsRef = useRef<any>(new Set());
  useEffect(() => {
    if (!projects || projects.length === 0) {
      seededTicketProjectsRef.current = new Set();
      return;
    }
    const toSeed = projects.filter((p: any) => p?.id && !seededTicketProjectsRef.current.has(p.id));
    if (toSeed.length === 0) return;
    toSeed.forEach((p: any) => seededTicketProjectsRef.current.add(p.id));
    let cancelled = false;
    Promise.all(
      toSeed.map((p: any) =>
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
          // Don't clobber a fresher value a WebSocket event already delivered.
          if (next[pid] === undefined) next[pid] = count;
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [projects]);
  const dismissChangesReady = useCallback((sessionId: any) => {
    setChangesReady((prev: any) => {
      if (!prev[sessionId]) return prev;
      const next = { ...prev };
      delete (next as any)[sessionId];
      return next;
    });
  }, []);
  const acknowledgePresentedArtifact = useCallback((sessionId: any, artifactId: any) => {
    setPresentedArtifactBySession((prev: any) => {
      if (prev[sessionId]?.id !== artifactId) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);
  // Finalize Code Changes — kicks off a finalize_runs row for a card-linked
  // session. The card id is required (sessions without a linked card cannot
  // finalize). Errors bubble to the caller so the button can surface them
  // via Alert / inline message.
  const startFinalizeRun = useCallback(async (projectId: any, cardId: any) => {
    if (!projectId || !cardId) {
      throw new Error('Project id and card id are required');
    }
    return api.startFinalizeRun(projectId, cardId);
  }, []);
  const startFinalizeRunForSession = useCallback(async (projectId: any, sessionId: any) => {
    if (!projectId || !sessionId) {
      throw new Error('Project id and session id are required');
    }
    return api.startFinalizeRunForSession(projectId, sessionId);
  }, []);
  // UI-only cancel: flips the DB row to `cancelled` and broadcasts. The
  // orchestrator's CancelSignal is in-process only, so a long-running run
  // may still emit subsequent events for a moment after this resolves.
  const cancelFinalizeRun = useCallback(async (projectId: any, runId: any) => {
    if (!projectId || !runId) {
      throw new Error('Project id and run id are required');
    }
    return api.cancelFinalizeRun(projectId, runId);
  }, []);
  const isProcessing = thinking || !!streamingContent || sessionRoundProcessing;
  const value = {
    configReady,
    showAiSignInGuide,
    dismissAiSignInGuide,
    needsSetup,
    completeSetup,
    needsAuth,
    completeAuth,
    agents,
    projects,
    activeAgentId,
    setActiveAgentId,
    activeAgent,
    sessions,
    activeSessionId,
    activeSessionState,
    setActiveSessionId,
    hubSessionId,
    setHubSessionId,
    hubFocused,
    setHubFocused,
    messages,
    reloadMessages,
    thinking,
    streamingContent,
    streamingMsgId,
    streamingEngine,
    streamingAgent,
    sessionEngine,
    sessionModel,
    setSessionEngine,
    setSessionModel,
    sessionReasoningEffort,
    handleReasoningEffortChange,
    sessionComputerToolOn,
    handleComputerToolChange,
    modelConfig,
    sessionConsultMode,
    handleConsultModeChange,
    connected,
    reconnecting,
    isProcessing,
    activeTasks,
    finalizeStatusBySession,
    handleNewSession,
    handleStartSessionWithAgent,
    handleStartSkillBuilderMode,
    handleEngineChange,
    handleModelChange,
    persistHubModel,
    clearHubChat,
    handleDeleteSession,
    archivedSessions,
    handleRestoreSession,
    restoringSessionIds,
    handleCancel,
    chatScrollNonce,
    browserPaneRequest,
    handleSend,
    handleSwitchOrg,
    refreshAgents,
    refreshProjects,
    skills,
    sessionAgents,
    sessionRoundProcessing,
    handleSessionAgentsUpdated,
    delegations,
    sessionHandoffs,
    handleOpenHandoffSession,
    openOrganizationChat,
    organizationChatAgent,
    messageQueues,
    eventsByMessage,
    browserScreensBySession,
    previewEventBySession,
    artifactReloadBySession,
    presentedArtifactBySession,
    acknowledgePresentedArtifact,
    handleDequeue,
    handleInterruptQueuedMessage,
    handleEditQueuedMessage,
    handleDelegationCancel,
    handleEventsLoaded,
    cronSessions,
    kanbanRefreshKey,
    kanbanRefreshProjectIds,
    acknowledgeKanbanRefresh,
    skillImprovementRefreshKey,
    skillImprovementPendingTotal,
    skillImprovementCounts,
    activeReviews,
    handleRenameSession,
    reloadAgentSessions,
    handleReorderProjects,
    changesReady,
    dismissChangesReady,
    // Finalize Code Changes (card 2bce78c2)
    startFinalizeRun,
    startFinalizeRunForSession,
    cancelFinalizeRun,
    // Ask-prompt (`agenthub:ask`) submission state and handler
    askSubmitted,
    handleAskSubmit,
    handleCredentialSubmit,
    // Finalize setup wizard (Settings → Finalize)
    lastFinalizeWizardEvent,
    projectImportEvents,
    lastFinalizeRunEvent,
    // Deployments
    lastDeploymentEvent,
    lastReleaseNotificationEvent,
    // Infrastructure (alert state transitions)
    lastInfraAlertEvent,
    // Infrastructure (AWS Health events pushed in by an operator's rule)
    lastInfraHealthEvent,
    // Cross-project personal todos (live refetch signal)
    lastUserTodoEvent,
    subscribeReminderUpdates,
    lastGoogleChatDraftEvent,
    lastOrganizationEvent,
    // Shared org todos (live refetch signal)
    lastOrgTodoEvent,
    lastDesignEvent,
    wsSend: send,
    lastSupportTicketEvent,
    lastLogIssueActionEvent,
    unreadTicketCounts,
    openPullCounts,
    refreshSupportUnreadCount,
    setSupportUnreadCount,
    // Security audit drawer badge + screen seed
    securityOpenCounts,
    refreshSecurityOpenCounts,
    // Push notification state (Settings screen surfaces these)
    pushToken,
    pushPermissionStatus,
    syncPushRegistrations,
    forgetPushServer,
    signOutOfServer,
    // Navigation bridge — App.js calls this once the NavigationContainer
    // ref is mounted so the notification-tap listener can open screens.
    registerNavigator,
    openInboxNotification,
    subscribeInitialBuild,
    subscribeSideBarEvents,
  };
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
