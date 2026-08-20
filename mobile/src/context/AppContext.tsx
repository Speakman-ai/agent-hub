import React, { createContext, useState, useCallback, useEffect, useContext, useMemo, useRef } from 'react';
import { Alert } from 'react-native';
import { api } from '../utils/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { extractSubmittedAskIds } from '../utils/askAnswers';
import { loadOrgs, migrateFromLegacy, getOrgs } from '../utils/orgs';
import { loadConnectionConfig, getApiBaseUrl } from '../utils/config';
import { loadAuthToken, isAuthenticated, getAuthStatus, getAuthRecord, needsEmailUpdate } from '../utils/auth';
import { loadSetupDismissed, saveSetupDismissed, shouldShowWizard, shouldGateLoginAfterSetup, shouldGateAuthFromStatus, } from '../utils/setupState';
import { hydrateChangesReady } from '../utils/changesReady';
import { applyDetectedFlag } from '../utils/worktreeState';
import { isWorkflowProject } from '../utils/project-mode';
import { isSessionConsultModeEnabled } from '../utils/sessionDerivedState';
import { selectSessionToActivate, deepLinkFetchId, upsertSessionRow } from '../utils/sessionSelection';
import { applyEntryUnread, clearProjectUnread, isRetiredHeartbeatThread } from '../utils/threads';
import { registerForPushNotifications, presentLocalNotification } from '../utils/push';
import { mapBroadcastToNotification } from '../utils/ticketNotifications';
import { routeNotificationTap, notificationRouteToNavigation, } from '../utils/notificationRouting';
import { uploadAttachments } from '../utils/uploadAttachments';
import { coalescePromiseByKey } from '../utils/coalesceInFlight';
import { createReloadMessages } from '../utils/sessionReload';
import { deriveSessionState } from '../utils/deriveSessionState';
import { firstEngineWithAuthenticatedModels, defaultModelForAuthenticatedEngine, } from '../utils/authModelEngines';
import { HUB_ASSISTANT_AGENT_ID } from '@shared/utils/hub';
import { mergeBrowserActivityScreenshot } from '@shared/utils/browserScreensBySessionMerge';
import { usePendingLessonTotal } from '../hooks/usePendingLessonTotal';
import { resolveStreamingFromSnapshot, buildStreamingAgentState } from '@shared/utils/activeTaskSnapshot';
import { buildInterruptQueuedMessageDispatch, isPersistedUploadAttachment, } from '@shared/utils/queuedMessageAttachments';
import { appendImportEvent } from '@shared/utils/projectImportWizard';
import { addKanbanRefreshProject, createRefreshScheduler } from '@shared/utils/kanbanRefresh';
const AppContext = createContext<any>(null);
export function AppProvider({ children }: any) {
    const [agents, setAgents] = useState<any[]>([]);
    const [projects, setProjects] = useState<any[]>([]);
    const [activeAgentId, setActiveAgentId] = useState<any>(null);
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
    const [streamingEngine, setStreamingEngine] = useState<any>(null);
    const [sessionEngine, setSessionEngine] = useState('claude-code');
    const [sessionModel, setSessionModel] = useState('claude-opus-5');
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
    // Per-session nonce bumped on each `artifact_created` / `artifact_deleted`
    // WS event so the SessionArtifactsPanel reloads its list live. Shape:
    //   { [sessionId]: number }
    const [artifactReloadBySession, setArtifactReloadBySession] = useState<any>({});
    // Cron-linked sessions
    const [cronSessions, setCronSessions] = useState<any[]>([]);
    // Threads (persistent output logs for crons)
    // Unread entry counts keyed by projectId
    const [unreadThreadCounts, setUnreadThreadCounts] = useState<any>({});
    // The last raw thread event received from the server. Screens listening for
    // live updates react to this ref bump via a counter. Shape:
    //   { type, projectId, thread?, threadId?, entry?, bump }
    const [lastThreadEvent, setLastThreadEvent] = useState<any>(null);
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
    // Tracks the project currently being viewed in ThreadsScreen so we can
    // suppress unread-badge increments (counts are only incremented when the
    // user isn't already looking at that project's threads list).
    const activeThreadsProjectIdRef = useRef<any>(null);
    const activeThreadIdRef = useRef<any>(null);
    // Stable ref to refreshSecurityOpenCounts so the WS handler (defined before
    // the helper) can call it without a stale-closure / ordering problem.
    const refreshSecurityOpenCountsRef = useRef<any>(null);
    const refreshOpenPullCountRef = useRef<any>(null);
    // Kanban board refresh trigger
    const [kanbanRefreshKey, setKanbanRefreshKey] = useState(0);
    const [kanbanRefreshProjectIds, setKanbanRefreshProjectIds] = useState<Set<string>>(() => new Set());
    const kanbanRefreshScheduler = useMemo(() => createRefreshScheduler(() => setKanbanRefreshKey((k: any) => (k || 0) + 1)), []);
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
    // Total pending learned-lessons across all projects, driving the Skills
    // drawer badge. The hook owns the fetch lifecycle (preserve-on-failure,
    // prune-on-departure); see usePendingLessonTotal.
    const skillImprovementPendingTotal = usePendingLessonTotal(projects, skillImprovementRefreshKey);
    // Ad-hoc PR creation: Map of sessionId -> { agentId, branch, hasUncommitted, hasUnpushed }
    const [changesReady, setChangesReady] = useState<any>({});
    // Map of sessionId -> latest Finalize Code Changes status string. Mirrors
    // the web sidebar's live status map so mobile can derive the same session
    // lifecycle state from Finalize WS events.
    const [finalizeStatusBySession, setFinalizeStatusBySession] = useState<any>({});
    const [shipFailureAt, setShipFailureAt] = useState<any>(null);
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
    // Mobile push state: Expo token + permission status (used by Settings).
    const [pushToken, setPushToken] = useState<any>(null);
    const [pushPermissionStatus, setPushPermissionStatus] = useState('unknown');
    const activeAgent = agents.find((a: any) => a.id === activeAgentId);
    const activeSession = sessions.find((s: any) => s.id === activeSessionId) ||
        cronSessions.find((s: any) => s.id === activeSessionId) ||
        null;
    const activeSessionState = deriveSessionState(activeSession, {
        activeTaskSessionIds: activeTasks,
        finalizeStatusBySession,
    });
    const defaultModelForEngine = (engine: any) => {
        const fromConfig = modelConfig?.engineDefaultModels?.[engine];
        if (fromConfig)
            return fromConfig;
        const available = modelConfig?.engineValidModels?.[engine];
        if (Array.isArray(available) && available.length > 0)
            return available[0];
        if (engine === 'cursor-agent')
            return 'cursor-grok-4.6-high';
        if (engine === 'codex-cli')
            return 'gpt-5.6-sol';
        if (engine === 'grok-cli')
            return 'grok-4.6';
        return 'claude-opus-5';
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
    // response listener to open Kanban / Threads from a cold- or warm-start
    // tap. `null` is a no-op (pre-mount or web/test).
    const navigatorRef = useRef<any>(null);
    // A ref — not state — so registering the navigator never triggers a
    // re-render. Wrapped in `useCallback` only for a stable identity.
    const registerNavigator = useCallback((fn: any) => {
        navigatorRef.current = typeof fn === 'function' ? fn : null;
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
        if (!mapped)
            return;
        try {
            const Notifications = require('expo-notifications');
            presentLocalNotification({ Notifications }, {
                title: mapped.title,
                body: mapped.body,
                data: { event: mapped.event, ...data },
            });
        }
        catch {
            /* expo-notifications unavailable (e.g. web / test) — no banner */
        }
    }, []);
    const reloadActiveAgentSkills = useCallback(() => {
        const agentId = activeAgentIdRef.current;
        if (!configReady || !agentId || !getApiBaseUrl())
            return;
        api.getSkills(agentId)
            .then(setSkills)
            .catch(() => setSkills([]));
    }, [configReady]);
    // WebSocket handler
    const handleWsMessage = useCallback((data: any) => {
        // Fan out to the in-app banner first so every mapped type gets a
        // notification regardless of which switch-case it takes below.
        presentForegroundFor(data);
        const forActiveSession = data.sessionId && data.sessionId === activeSessionIdRef.current;
        const msgForActiveSession = data.message?.session_id === activeSessionIdRef.current;
        switch (data.type) {
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
                    setStreamingAgent(buildStreamingAgentState({
                        agentId: streaming.agentId,
                        engine: streaming.streamingEngine,
                        model: streaming.streamingModel,
                    }, agentsRef.current));
                }
                break;
            }
            case 'message':
                if (msgForActiveSession && data.message?.id) {
                    const msg = data.message;
                    const appendable = msg.role === 'user' ||
                        msg.role === 'system' ||
                        (msg.role === 'assistant' && msg.agent_id);
                    if (appendable) {
                        setMessages((prev: any) => {
                            if (prev.some((m: any) => m.id === msg.id))
                                return prev;
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
                    setStreamingAgent(buildStreamingAgentState({
                        agentId: data.agentId,
                        agentName: data.agentName,
                        agentColor: data.agentColor,
                        engine: data.engine,
                        model: data.model,
                    }, agentsRef.current));
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
                    if (data.engine)
                        setStreamingEngine(data.engine);
                    setStreamingAgent((prev: any) => buildStreamingAgentState({
                        agentId: data.agentId,
                        agentName: data.agentName,
                        agentColor: data.agentColor,
                        engine: data.engine,
                        model: data.model,
                    }, agentsRef.current, prev) || prev);
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
                            if (prev.some((m: any) => m.id === data.message.id))
                                return prev;
                            return [...prev, data.message];
                        });
                    }
                }
                break;
            case 'session-updated':
                // Matches web: server sends a full session row; spread keeps fields fresh.
                setSessions((prev: any) => prev.map((s: any) => (s.id === data.session.id ? { ...s, ...data.session } : s)));
                if (data.session?.id === activeSessionIdRef.current && Array.isArray(data.session.agents)) {
                    setSessionAgents(data.session.agents);
                }
                break;
            case 'session_state': {
                const sid = data.sessionId;
                if (!sid || typeof data.state !== 'string')
                    break;
                setSessions((prev: any) => prev.map((s: any) => (s.id === sid ? { ...s, state: data.state } : s)));
                setCronSessions((prev: any) => prev.map((s: any) => (s.id === sid ? { ...s, state: data.state } : s)));
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
                if (forActiveSession)
                    setSessionRoundProcessing(true);
                break;
            case 'session_round_done':
                if (forActiveSession)
                    setSessionRoundProcessing(false);
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
                    if (!session)
                        return prev;
                    return {
                        ...prev,
                        [data.sessionId]: {
                            ...session,
                            tasks: session.tasks.map((t: any) => t.agentId === data.agentId
                                ? { ...t, delegationId: data.delegationId, agentName: data.agentName, agentColor: data.agentColor, status: 'running' }
                                : t),
                        },
                    };
                });
                break;
            case 'delegation_stream':
                setDelegations((prev: any) => {
                    const session = prev[data.sessionId];
                    if (!session)
                        return prev;
                    return {
                        ...prev,
                        [data.sessionId]: {
                            ...session,
                            tasks: session.tasks.map((t: any) => t.agentId === data.agentId
                                ? { ...t, agentName: data.agentName, agentColor: data.agentColor, status: 'running', content: data.content }
                                : t),
                        },
                    };
                });
                break;
            case 'delegation_agent_done':
                setDelegations((prev: any) => {
                    const session = prev[data.sessionId];
                    if (!session)
                        return prev;
                    return {
                        ...prev,
                        [data.sessionId]: {
                            ...session,
                            tasks: session.tasks.map((t: any) => t.agentId === data.agentId
                                ? { ...t, status: 'done', output: data.output, content: '' }
                                : t),
                        },
                    };
                });
                break;
            case 'delegation_agent_error':
                setDelegations((prev: any) => {
                    const session = prev[data.sessionId];
                    if (!session)
                        return prev;
                    return {
                        ...prev,
                        [data.sessionId]: {
                            ...session,
                            tasks: session.tasks.map((t: any) => t.agentId === data.agentId
                                ? { ...t, status: 'error', error: data.error }
                                : t),
                        },
                    };
                });
                break;
            case 'delegation_cancelled':
                setDelegations((prev: any) => {
                    const session = prev[data.sessionId];
                    if (!session)
                        return prev;
                    return {
                        ...prev,
                        [data.sessionId]: {
                            ...session,
                            tasks: session.tasks.map((t: any) => t.status === 'running' || t.status === 'pending'
                                ? { ...t, status: 'cancelled' }
                                : t),
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
            case 'browser_activity_screenshot': {
                const sid = data.sessionId;
                const mid = data.messageId;
                const aid = data.actionId;
                const shot = data.screenshotDataUrl;
                if (!sid || !mid || !aid || typeof shot !== 'string')
                    break;
                setBrowserScreensBySession((prev: any) => mergeBrowserActivityScreenshot(prev, sid, mid, aid, shot));
                break;
            }
            case 'artifact_created':
            case 'artifact_deleted': {
                // Bump the per-session reload nonce so an open SessionArtifactsPanel
                // refetches the authoritative list. Mirrors the web App.tsx handler
                // (which drives SessionArtifactsPane's reloadToken).
                const sid = data.sessionId;
                if (!sid)
                    break;
                setArtifactReloadBySession((prev: any) => ({ ...prev, [sid]: (prev[sid] || 0) + 1 }));
                break;
            }
            // Cron session updates
            case 'cron_session_update':
                api.getCronSessions().then(setCronSessions).catch(() => { });
                break;
            // Queue events
            case 'queue_updated':
                setMessageQueues((prev: any) => ({
                    ...prev,
                    [data.sessionId]: data.queue || [],
                }));
                break;
            case 'queue_item_processing':
                setMessageQueues((prev: any) => {
                    const q = prev[data.sessionId];
                    if (!q)
                        return prev;
                    return { ...prev, [data.sessionId]: q.filter((item: any) => item.id !== data.messageId) };
                });
                break;
            case 'queue_item_edited':
                if (forActiveSession) {
                    setMessages((prev: any) => prev.map((m: any) => (m.id === data.messageId ? { ...m, content: data.content } : m)));
                }
                break;
            case 'skill_improvement_update':
                setSkillImprovementRefreshKey((k: any) => (k || 0) + 1);
                break;
            case 'kanban_update':
                if (typeof data.projectId === 'string') {
                    setKanbanRefreshProjectIds((pending) => addKanbanRefreshProject(pending, data.projectId));
                    kanbanRefreshScheduler.schedule();
                }
                if (data.projectId)
                    refreshOpenPullCountRef.current?.(data.projectId);
                // A security scan's only WS signal is kanban_update. Refresh the
                // affected project's open-severity counts so the drawer badge stays live.
                if (data.projectId)
                    refreshSecurityOpenCountsRef.current?.(data.projectId);
                break;
            case 'native_pr_update':
                if (data.projectId)
                    refreshOpenPullCountRef.current?.(data.projectId);
                break;
            case 'user_todo_update':
                // The server already filters this to the owner's connections, so
                // any event we receive is ours. Surface it so TodosScreen can
                // silently refetch (create/update/delete/reorder/promote).
                setLastUserTodoEvent({ action: data.action ?? null, bump: Date.now() });
                break;
            case 'dispatch_failure':
                // The linked card's kanban_update carries the project id and is
                // enough to refresh the board after the failure comment lands.
                break;
            case 'session_deleted':
                setSessions((prev: any) => prev.filter((s: any) => s.id !== data.sessionId));
                setCronSessions((prev: any) => prev.filter((s: any) => s.id !== data.sessionId));
                setFinalizeStatusBySession((prev: any) => {
                    if (!prev[data.sessionId])
                        return prev;
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
                        if (prev.some((s: any) => s.id === row.id))
                            return prev;
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
                if (!restoredId)
                    break;
                setArchivedSessions((prev: any) => prev.filter((s: any) => s.id !== restoredId));
                if (data.session && data.session.agent_id === activeAgentIdRef.current) {
                    setSessions((prev: any) => {
                        if (prev.some((s: any) => s.id === restoredId))
                            return prev;
                        return [data.session, ...prev];
                    });
                }
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
                        if (prev.some((s: any) => s.id === newSession.id))
                            return prev;
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
                if (isWorkflowProject(proj))
                    break;
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
            // A PR was opened (manually or automatically) — clear the banner.
            case 'auto_pr_created':
                setChangesReady((prev: any) => {
                    if (!prev[data.sessionId])
                        return prev;
                    const next = { ...prev };
                    delete (next as any)[data.sessionId];
                    return next;
                });
                break;
            case 'auto_pr_failed':
                if (data.sessionId === activeSessionIdRef.current) {
                    setShipFailureAt(Date.now());
                }
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
                        const incoming = data.status === 'ready_to_push' && data.validated === false
                            ? 'phase_passed'
                            : data.status;
                        if (prev[data.session_id] === incoming)
                            return prev;
                        return { ...prev, [data.session_id]: incoming };
                    });
                }
                break;
            // ── Thread events (persistent output logs) ───────────────
            case 'thread_created':
                if (isRetiredHeartbeatThread(data.thread))
                    break;
                setLastThreadEvent({
                    type: 'thread_created',
                    projectId: data.projectId,
                    thread: data.thread,
                    bump: Date.now(),
                });
                break;
            case 'thread_entry_created': {
                if (isRetiredHeartbeatThread({ type: data.threadType }))
                    break;
                setUnreadThreadCounts((prev: any) => applyEntryUnread(prev, { projectId: data.projectId, threadId: data.threadId, threadType: data.threadType }, activeThreadIdRef.current));
                setLastThreadEvent({
                    type: 'thread_entry_created',
                    projectId: data.projectId,
                    threadId: data.threadId,
                    threadName: data.threadName,
                    threadType: data.threadType,
                    entry: data.entry,
                    bump: Date.now(),
                });
                break;
            }
            case 'thread_deleted':
                setLastThreadEvent({
                    type: 'thread_deleted',
                    projectId: data.projectId,
                    threadId: data.threadId,
                    bump: Date.now(),
                });
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
            // ── Finalize setup wizard (Settings → Finalize) ─────────
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
                if (!agentId)
                    break;
                if (payload.projectId) {
                    const agent = agentsRef.current.find((a: any) => a.id === agentId);
                    if (agent?.projectId !== payload.projectId)
                        break;
                }
                reloadActiveAgentSkills();
                break;
            }
        }
    }, [kanbanRefreshScheduler, presentForegroundFor, reloadActiveAgentSkills]);
    const { send, connected, reconnecting, reconnect } = useWebSocket(handleWsMessage);
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
        if (!configReady || !getApiBaseUrl())
            return;
        (async () => {
            try {
                const Notifications = require('expo-notifications');
                // Foreground notifications: show banner + play sound. Without this
                // Expo suppresses banners while the app is in the foreground.
                if (Notifications.setNotificationHandler) {
                    Notifications.setNotificationHandler({
                        handleNotification: async () => ({
                            shouldShowBanner: true,
                            shouldShowList: true,
                            shouldPlaySound: true,
                            shouldSetBadge: false,
                        }),
                    });
                }
                const Device = require('expo-device');
                const Constants = require('expo-constants').default;
                const { Platform } = require('react-native');
                const result = await registerForPushNotifications({
                    api,
                    Notifications,
                    Device,
                    Constants,
                    Platform,
                });
                setPushToken(result.token);
                setPushPermissionStatus(result.permissionStatus);
            }
            catch (err: any) {
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
    const applyNotificationRoute = useCallback((data: any) => {
        const route = routeNotificationTap(data, { sessions: sessionsRef.current });
        if (!route)
            return;
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
                break;
            }
            case 'kanban':
            case 'threads':
            case 'support':
            case 'pulls':
            case 'infra': {
                // Navigator-driven kinds share one pure param mapper so the screen +
                // params (including the `pulls` PR number and the `infra` alert id)
                // stay unit-testable.
                const nav = notificationRouteToNavigation(route);
                if (nav)
                    navigatorRef.current?.(nav.screen, nav.params);
                break;
            }
            default:
                break;
        }
    }, []);
    // Register a notification-response listener so tapping a banner (whether
    // presented in foreground by `presentLocalNotification` or delivered as a
    // remote Expo push) navigates to the right screen. Also consume any
    // pending cold-start response so launching the app from a dismissed
    // banner still routes correctly.
    //
    // Native modules are required lazily so Vitest (which only exercises
    // pure utils in `src/utils/`) never tries to resolve them.
    useEffect(() => {
        if (!configReady)
            return undefined;
        let subscription: any = null;
        let cancelled = false;
        (async () => {
            try {
                const Notifications = require('expo-notifications');
                // Cold-start: the app was launched by tapping a notification while
                // it was backgrounded/killed. Apply once on mount.
                if (typeof Notifications.getLastNotificationResponseAsync === 'function') {
                    try {
                        const last = await Notifications.getLastNotificationResponseAsync();
                        const data = last?.notification?.request?.content?.data;
                        if (!cancelled && data)
                            applyNotificationRoute(data);
                    }
                    catch {
                        /* non-fatal — listener still covers the warm-start path */
                    }
                }
                if (typeof Notifications.addNotificationResponseReceivedListener === 'function') {
                    subscription = Notifications.addNotificationResponseReceivedListener((response: any) => {
                        const data = response?.notification?.request?.content?.data;
                        if (data)
                            applyNotificationRoute(data);
                    });
                }
            }
            catch {
                /* expo-notifications unavailable — no-op */
            }
        })();
        return () => {
            cancelled = true;
            if (subscription && typeof subscription.remove === 'function') {
                subscription.remove();
            }
        };
    }, [configReady, applyNotificationRoute]);
    const refreshAgents = useCallback(() => {
        api.getAgents().then((data: any) => {
            setAgents(data);
        });
    }, []);
    const refreshProjects = useCallback(() => {
        api.getProjects().then(setProjects).catch(() => setProjects([]));
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
            await loadAuthToken();
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
                    if (shouldGateAuthFromStatus({
                        status,
                        isAuthenticated: isAuthenticated(),
                        needsEmailUpdate: needsEmailUpdate(),
                    })) {
                        setNeedsAuth(true);
                    }
                }
                catch {
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
        if (shouldGateLoginAfterSetup({
            hasServerUrl: !!getApiBaseUrl(),
            isAuthenticated: isAuthenticated() && !needsEmailUpdate(),
        })) {
            setNeedsAuth(true);
        }
        setNeedsSetup(false);
        // Reconnect so the newly-configured WebSocket picks up the server URL.
        reconnect();
    }, [reconnect]);
    /**
     * Called by `LoginScreen` after a successful login or setup call. The JWT
     * is already persisted to AsyncStorage at this point; we just need to
     * flip `needsAuth` and reconnect the WebSocket so it picks up the new
     * `?token=` credential.
     */
    const completeAuth = useCallback(() => {
        setNeedsAuth(false);
        reconnect();
    }, [reconnect]);
    // Load agents and projects once config is ready
    useEffect(() => {
        if (!configReady)
            return;
        if (!getApiBaseUrl())
            return; // No server configured yet
        (async () => {
            try {
                const [agentData, projectData, cronSessionData] = await Promise.all([
                    api.getAgents(),
                    api.getProjects().catch(() => []),
                    api.getCronSessions().catch(() => []),
                ]);
                setAgents(agentData);
                setProjects(projectData);
                setCronSessions(cronSessionData);
                if (agentData.length > 0)
                    setActiveAgentId(agentData[0].id);
            }
            catch (err: any) {
                console.error('Failed to load initial data:', err);
            }
        })();
    }, [configReady]);
    // Load sessions when agent changes (guarded on configReady)
    useEffect(() => {
        if (!configReady || !activeAgentId || !getApiBaseUrl())
            return;
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
        api.getSessions(activeAgentId).then(async (data: any) => {
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
                setSessionModel(target.model || defaultModelForEngine(target.engine || agent?.engine || 'claude-code'));
                setSessionConsultMode(isSessionConsultModeEnabled(target));
                setSessionReasoningEffort(target.reasoning_effort === 'pro' ? 'pro' : 'high');
            }
            else {
                setActiveSessionId(null);
                setMessages([]);
                const agent = agents.find((a: any) => a.id === activeAgentId);
                setSessionEngine(agent?.engine || 'claude-code');
                setSessionModel(defaultModelForEngine(agent?.engine || 'claude-code'));
                setSessionConsultMode(false);
                setSessionReasoningEffort('high');
            }
        }).catch((err: any) => {
            if (!cancelled) console.error('Failed to load sessions:', err);
        });
        return () => {
            cancelled = true;
        };
    }, [configReady, activeAgentId, modelConfig]);
    useEffect(() => {
        if (!configReady || !getApiBaseUrl())
            return;
        let cancelled = false;
        api
            .getModelConfig()
            .then((cfg: any) => {
            if (!cancelled)
                setModelConfig(cfg);
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
        if (!activeSessionId)
            return;
        const session = sessions.find((s: any) => s.id === activeSessionId);
        if (session?.engine)
            setSessionEngine(session.engine);
        if (session?.model)
            setSessionModel(session.model);
        if (session) {
            setSessionConsultMode(isSessionConsultModeEnabled(session));
            setSessionReasoningEffort(session.reasoning_effort === 'pro' ? 'pro' : 'high');
        }
    }, [activeSessionId, sessions]);
    // Mirror web App.jsx: if the session engine has no authenticated models,
    // migrate to the first engine that does so TopBar state matches the server.
    useEffect(() => {
        if (!modelConfig || !activeSessionId)
            return;
        const allowed = modelConfig.engineValidModels?.[sessionEngine];
        if (Array.isArray(allowed) && allowed.length > 0)
            return;
        const nextEngine = firstEngineWithAuthenticatedModels(modelConfig);
        if (!nextEngine || nextEngine === sessionEngine)
            return;
        const defaultModel = defaultModelForAuthenticatedEngine(modelConfig, nextEngine);
        if (!defaultModel)
            return;
        let cancelled = false;
        const sid = activeSessionIdRef.current;
        void (async () => {
            try {
                setSessionEngine(nextEngine);
                setSessionModel(defaultModel);
                const updatedEngine = await api.setSessionEngine(sid, nextEngine);
                if (cancelled || activeSessionIdRef.current !== sid)
                    return;
                setSessions((prev: any) => prev.map((s: any) => (s.id === updatedEngine.id ? { ...s, engine: updatedEngine.engine } : s)));
                const modelUpdated = await api.setSessionModel(sid, defaultModel);
                if (cancelled || activeSessionIdRef.current !== sid)
                    return;
                setSessions((prev: any) => prev.map((s: any) => (s.id === modelUpdated.id ? { ...s, model: modelUpdated.model } : s)));
            }
            catch (err: any) {
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
    // `createReloadMessages` factory so it can be unit-tested in isolation.
    const reloadMessages = useMemo<any>(() => createReloadMessages({
        fetchMessages: (sid: any) => api.getMessages(sid),
        getActiveSessionId: () => activeSessionIdRef.current,
        setMessages,
    }), []);
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
            if (cancelled)
                return;
            setSessionHandoffs(Array.isArray(rows) ? rows : []);
        })
            .catch(() => {
            if (!cancelled)
                setSessionHandoffs([]);
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
        if (!targetAgentId || !targetSessionId)
            return;
        pendingSessionIdRef.current = targetSessionId;
        setActiveAgentId(targetAgentId);
        setActiveSessionId(targetSessionId);
    }, []);
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
            setStreamingAgent(buildStreamingAgentState({
                agentId: t.agentId,
                engine: t.engine,
                model: t.model,
            }, agentsRef.current));
        }
        else {
            setThinking(false);
            setStreamingContent('');
            setStreamingMsgId(null);
            setStreamingEngine(null);
            setStreamingAgent(null);
        }
    }, [activeSessionId]);
    const handleSwitchOrg = useCallback(async (orgId: any) => {
        const { switchOrg } = require('../utils/orgs');
        await switchOrg(orgId);
        // Reset all state
        setAgents([]);
        setProjects([]);
        setSessions([]);
        setActiveAgentId(null);
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
        // Reconnect WebSocket to new org
        reconnect();
        // Re-probe the new server's auth mode so notification owner-scoping uses
        // the right local-bypass. Reset to the secure default (strict) first so a
        // stale value from the previous server can never leak owner-only banners
        // if the probe fails.
        serverAuthConfiguredRef.current = true;
        (async () => {
            const probeUrl = getApiBaseUrl();
            if (!probeUrl)
                return;
            try {
                const status = await getAuthStatus(probeUrl);
                serverAuthConfiguredRef.current = Boolean(status?.authConfigured);
            }
            catch {
                /* unreachable — keep the strict default */
            }
        })();
        // Reload data
        try {
            const [agentData, projectData, cronSessionData] = await Promise.all([
                api.getAgents(),
                api.getProjects().catch(() => []),
                api.getCronSessions().catch(() => []),
            ]);
            setAgents(agentData);
            setProjects(projectData);
            setCronSessions(cronSessionData);
            if (agentData.length > 0)
                setActiveAgentId(agentData[0].id);
        }
        catch (err: any) {
            console.error('Failed to load data after org switch:', err);
        }
    }, [reconnect]);
    const handleNewSession = useCallback(async () => {
        if (!activeAgentId)
            return;
        // Propagate the current Ask Mode preference to the new session so a user
        // who toggled "Ask (read-only)" before tapping `+` gets a read-only
        // session. Matches the web client's behavior in App.jsx.
        const session = await api.createSession(activeAgentId, undefined, {
            consultMode: sessionConsultMode,
        });
        setSessions((prev: any) => prev.some((s: any) => s.id === session.id) ? prev : [session, ...prev]);
        setActiveSessionId(session.id);
        const agent = agents.find((a: any) => a.id === activeAgentId);
        setSessionEngine(session.engine || agent?.engine || 'claude-code');
        setSessionModel(session.model || defaultModelForEngine(session.engine || agent?.engine || 'claude-code'));
        setSessionConsultMode(isSessionConsultModeEnabled(session));
        setSessionReasoningEffort(session.reasoning_effort === 'pro' ? 'pro' : 'high');
        setMessages([]);
    }, [activeAgentId, agents, sessionConsultMode]);
    // Start a chat session with a SPECIFIC agent (not necessarily the active one)
    // and make it active. The caller navigates to the Chat screen. Used by the
    // Skills screen "Build a skill" button to open the project's Skill Builder
    // coach. Mirrors the web client's handleStartSessionWithAgent.
    const handleStartSessionWithAgent = useCallback(async (agentId: any) => {
        if (!agentId)
            return;
        const agent = agents.find((a: any) => a.id === agentId);
        if (agent?.role === 'reviewer')
            return;
        const session = await api.createSession(agentId, undefined, {
          consultMode: sessionConsultMode,
        });
        setActiveAgentId(agentId);
        setSessions((prev: any) => (prev.some((s: any) => s.id === session.id) ? prev : [session, ...prev]));
        setActiveSessionId(session.id);
        setSessionEngine(session.engine || agent?.engine || 'claude-code');
        setSessionModel(session.model || defaultModelForEngine(session.engine || agent?.engine || 'claude-code'));
        setSessionConsultMode(isSessionConsultModeEnabled(session));
        setSessionReasoningEffort(session.reasoning_effort === 'pro' ? 'pro' : 'high');
        setMessages([]);
    }, [agents, sessionConsultMode]);
    const handleStartSkillBuilderMode = useCallback(async (projectId: any) => {
        // Skill Builder is a DEV-agent mode — only a non-helper agent gets the
        // builder prompt/role. Reject helper-only (or empty) rosters instead of
        // falling back to inProject[0] (which could be a docs/reviewer/skill-
        // builder helper running with the wrong prompt).
        const agent = agents.find((a: any) => a.projectId === projectId && a.active !== false && a.role !== 'skill-builder' && a.role !== 'reviewer' && a.role !== 'docs');
        if (!agent)
            return;
        const session = await api.createSession(agent.id, '[Skill Builder]');
        const updated = await api.updateSession(session.id, {
            session_mode: 'skill-builder',
            ask_mode: false,
            finalize_automation: 'manual',
        });
        setActiveAgentId(agent.id);
        setSessions((prev: any) => (prev.some((s: any) => s.id === updated.id) ? prev : [updated, ...prev]));
        setActiveSessionId(updated.id);
        setSessionEngine(updated.engine || agent.engine || 'claude-code');
        setSessionModel(updated.model || defaultModelForEngine(updated.engine || agent.engine || 'claude-code'));
        setSessionConsultMode(false);
        setSessionReasoningEffort(updated.reasoning_effort === 'pro' ? 'pro' : 'high');
        setMessages([]);
    }, [agents]);
    // `handleWorktreeChange` was removed when Agent Hub locked to
    // worktree-only sessions. The legacy `PUT /sessions/:id/worktree`
    // endpoint no longer exists.
    const handleConsultModeChange = useCallback(async (enabled: any) => {
        const sid = activeSessionIdRef.current;
        const prevEnabled = sessionConsultMode;
        setSessionConsultMode(enabled);
        if (!sid)
            return;
        try {
            const session = activeSession?.id === sid
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
            if (!workflowProject)
                patch.finalize_automation = 'manual';
            const updated = await api.updateSession(sid, patch);
            setSessions((prev: any) =>
                prev.map((s: any) => (s.id === updated.id ? { ...s, ...updated } : s)),
            );
            setSessionConsultMode(isSessionConsultModeEnabled(updated));
        }
        catch (err: any) {
            console.warn('updateSession consult mode failed; reverting toggle:', err);
            setSessionConsultMode(prevEnabled);
        }
    }, [activeAgentId, activeSession, agents, cronSessions, projects, sessionConsultMode, sessions]);
    const handleEngineChange = useCallback(async (engine: any) => {
        setSessionEngine(engine);
        const defaultModel = defaultModelForEngine(engine);
        setSessionModel(defaultModel);
        const sid = activeSessionIdRef.current;
        if (sid) {
            const updated = await api.setSessionEngine(sid, engine);
            setSessions((prev: any) => prev.map((s: any) => (s.id === updated.id ? { ...s, engine: updated.engine } : s)));
            const modelUpdated = await api.setSessionModel(sid, defaultModel);
            setSessions((prev: any) => prev.map((s: any) => (s.id === modelUpdated.id ? { ...s, model: modelUpdated.model } : s)));
        }
    }, [modelConfig]);
    const handleModelChange = useCallback(async (model: any) => {
        setSessionModel(model);
        const sid = activeSessionIdRef.current;
        if (sid) {
            const updated = await api.setSessionModel(sid, model);
            setSessions((prev: any) => prev.map((s: any) => (s.id === updated.id ? { ...s, model: updated.model } : s)));
        }
    }, []);
    const persistHubModel = useCallback(async (engine: string, model: string) => {
        // Snapshot so a failed PUT rolls back instead of leaving the picker
        // showing an engine/model the server never accepted. Read the live value
        // through the functional updater (the callback has empty deps).
        let prevEngine = 'claude-code';
        let prevModel = 'claude-opus-5';
        setSessionEngine((cur: any) => {
            prevEngine = cur;
            return engine;
        });
        setSessionModel((cur: any) => {
            prevModel = cur;
            return model;
        });
        setSessions((prev: any) => prev.map((s: any) => s.agent_id === HUB_ASSISTANT_AGENT_ID ? { ...s, engine, model } : s));
        try {
            const saved: any = await api.putHubModel({ engine, model });
            if (saved?.engine) setSessionEngine(saved.engine);
            if (saved?.model) setSessionModel(saved.model);
            if (saved?.engine || saved?.model) {
                setSessions((prev: any) => prev.map((s: any) => s.agent_id === HUB_ASSISTANT_AGENT_ID ? { ...s, engine: saved.engine || s.engine, model: saved.model || s.model } : s));
            }
        }
        catch (err: any) {
            // Revert the optimistic stamp so the picker reflects reality.
            setSessionEngine(prevEngine);
            setSessionModel(prevModel);
            setSessions((prev: any) => prev.map((s: any) => s.agent_id === HUB_ASSISTANT_AGENT_ID ? { ...s, engine: prevEngine, model: prevModel } : s));
            Alert.alert('Hub model', err?.message || 'Failed to save Hub model');
        }
    }, []);
    // Optimistically persist the Codex reasoning preset ('high' | 'pro'); reverts
    // on server error. Mirrors handleAskModeChange.
    const handleReasoningEffortChange = useCallback(async (effort: any) => {
        let prev = 'high';
        setSessionReasoningEffort((cur: any) => {
            prev = cur;
            return effort;
        });
        const sid = activeSessionIdRef.current;
        if (!sid)
            return;
        try {
            const updated = await api.setSessionReasoningEffort(sid, effort);
            setSessions((list: any) => list.map((s: any) => s.id === updated.id ? { ...s, reasoning_effort: updated.reasoning_effort } : s));
        }
        catch (err: any) {
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
                if (!prev[sessionId])
                    return prev;
                const next = { ...prev };
                delete (next as any)[sessionId];
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
                    if (prev.some((s: any) => s.id === sessionId))
                        return prev;
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
        }
        catch (err: any) {
            // Surface the failure so the user knows the row is still live. No
            // rollback needed because we never removed it optimistically.
            Alert.alert('Delete failed', err?.message || 'Could not archive this session. Please try again.');
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
            if (restored && restored.id) {
                setSessions((prev: any) => {
                    if (prev.some((s: any) => s.id === restored.id))
                        return prev;
                    return [restored, ...prev];
                });
            }
        }
        catch (err: any) {
            Alert.alert('Restore failed', err?.message || 'Could not restore this session. Please try again.');
        }
        finally {
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
            if (session.engine)
                setSessionEngine(session.engine);
            if (session.model)
                setSessionModel(session.model);
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
        if (askSubmittedOptimistic.size === 0)
            return askSubmittedFromHistory;
        const union = new Set(askSubmittedFromHistory);
        for (const id of askSubmittedOptimistic)
            union.add(id);
        return union;
    }, [askSubmittedOptimistic, askSubmittedFromHistory]);
    const handleSend = useCallback(async (content: any, images: any = [], { interrupt = false, agentId: agentIdOverride, sessionId: sessionIdOverride }: any = {}) => {
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
            const coalesceKey = `${targetAgentId}:${sessionConsultMode ? 'consult' : 'run'}`;
            const session = await coalescePromiseByKey(implicitSessionCreateByKeyRef, coalesceKey, () => api
                .createSession(targetAgentId, undefined, { consultMode: sessionConsultMode })
                .then((s: any) => {
                setSessions((prev: any) => (prev.some((x: any) => x.id === s.id) ? prev : [s, ...prev]));
                setActiveSessionId(s.id);
                activeSessionIdRef.current = s.id;
                return s;
            }));
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
            }
            catch (err: any) {
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
    }, [activeAgentId, sessionConsultMode, send]);
    const handleInterruptQueuedMessage = useCallback((message: any) => {
        const sessionId = activeSessionIdRef.current;
        if (!sessionId || !message?.id)
            return;
        const { chat } = buildInterruptQueuedMessageDispatch({
            message,
            // Session-derived identity: a queued Hub message re-dispatches as the
            // Hub agent, not whatever activeAgentId holds.
            agentId: sessionId === hubSessionIdRef.current ? HUB_ASSISTANT_AGENT_ID : activeAgentId,
            sessionId,
        });
        send(chat);
    }, [send, activeAgentId]);
    // Handle submission from an <AskUserQuestion> picker. We dispatch the
    // pre-formatted chat message (which already contains the
    // agenthub:ask:answer fenced block) and mark the askId as submitted so the
    // picker flips to a disabled "Submitted" state immediately. Once the user
    // message persists to history, `askSubmittedFromHistory` picks the id up
    // from the fenced-block scan and the optimistic set becomes redundant —
    // the union in `askSubmitted` keeps the brief overlap seamless. Mirrors
    // `client/src/App.jsx:handleAskSubmit`.
    const handleAskSubmit = useCallback((askId: any, messageText: any) => {
        if (!askId || !messageText)
            return;
        // Short-circuit duplicate submissions if the picker somehow re-fires.
        setAskSubmittedOptimistic((prev: any) => {
            if (prev.has(askId))
                return prev;
            const next = new Set(prev);
            next.add(askId);
            return next;
        });
        handleSend(messageText);
    }, [handleSend]);
    const handleCredentialSubmit = useCallback((_requestId: any, messageText: any) => {
        if (!messageText)
            return;
        handleSend(messageText);
    }, [handleSend]);
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
            if (!cancelled)
                setSessionAgents(detail.agents || []);
        })
            .catch(() => {
            if (!cancelled)
                setSessionAgents([]);
        });
        return () => {
            cancelled = true;
        };
    }, [activeSessionId]);
    const handleSessionAgentsUpdated = useCallback((detail: any) => {
        if (!detail?.id)
            return;
        setSessionAgents(detail.agents || []);
        setSessions((prev: any) => prev.map((s: any) => (s.id === detail.id ? { ...s, ...detail } : s)));
    }, []);
    const handleDequeue = useCallback((messageId: any) => {
        const sid = activeSessionIdRef.current;
        if (sid) {
            // Removing a queued message only discards that message. The in-flight
            // turn keeps running — dropping a follow-up must never cancel the agent.
            send({ type: 'dequeue', sessionId: sid, messageId });
            setMessages((prev: any) => prev.filter((m: any) => m.id !== messageId));
        }
    }, [send]);
    const handleEditQueuedMessage = useCallback((messageId: any, content: any) => {
        const sid = activeSessionIdRef.current;
        if (sid) {
            send({ type: 'edit_queue_item', sessionId: sid, messageId, content });
            setMessages((prev: any) => prev.map((m: any) => (m.id === messageId ? { ...m, content } : m)));
        }
    }, [send]);
    const handleDelegationCancel = useCallback(() => {
        const sid = activeSessionIdRef.current;
        if (sid) {
            send({ type: 'delegation_cancel', sessionId: sid });
        }
    }, [send]);
    const handleEventsLoaded = useCallback((messageId: any, events: any) => {
        setEventsByMessage((prev: any) => {
            const existing = prev[messageId];
            if (Array.isArray(existing) && existing.length > 0)
                return prev;
            return { ...prev, [messageId]: events };
        });
    }, []);
    /**
     * Clear the unread-threads badge for a project. Call when the user opens
     * the threads list or a specific thread so the sidebar chip resets.
     */
    const markProjectThreadsRead = useCallback((projectId: any) => {
        if (!projectId)
            return;
        setUnreadThreadCounts((prev: any) => clearProjectUnread(prev, projectId));
    }, []);
    /**
     * Seed the unread support-ticket count for a project from the server. Called
     * by the Support screen on mount so the drawer badge is correct on a cold
     * load; after this the WebSocket unreadCount keeps it live.
     */
    const refreshSupportUnreadCount = useCallback(async (projectId: any) => {
        if (!projectId)
            return;
        try {
            const { count } = await api.getSupportUnreadCount(projectId);
            setUnreadTicketCounts((prev: any) => ({ ...prev, [projectId]: count ?? 0 }));
        }
        catch {
            /* best-effort; WebSocket events still keep the badge current */
        }
    }, []);
    /** Optimistically set a project's unread support-ticket count (e.g. to 0). */
    const setSupportUnreadCount = useCallback((projectId: any, count: any) => {
        if (!projectId)
            return;
        setUnreadTicketCounts((prev: any) => ({ ...prev, [projectId]: Math.max(0, count) }));
    }, []);
    /**
     * Seed/refresh a project's open-severity security counts from the server.
     * Called by the Security screen on mount and on every kanban_update for the
     * project (a scan's only WS signal), so the drawer badge stays live. Passing
     * ?status=open keeps the payload to just the open rows.
     */
    const refreshSecurityOpenCounts = useCallback(async (projectId: any) => {
        if (!projectId)
            return;
        try {
            const data = await api.getSecurityFindings(projectId, 'open');
            const counts = data?.openCounts;
            if (counts)
                setSecurityOpenCounts((prev: any) => ({ ...prev, [projectId]: counts }));
        }
        catch {
            /* best-effort; the badge stays at its last value */
        }
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
        const toSeed = projects.filter((p: any) => p?.id && !seededSecurityProjectsRef.current.has(p.id));
        if (toSeed.length === 0)
            return;
        toSeed.forEach((p: any) => seededSecurityProjectsRef.current.add(p.id));
        let cancelled = false;
        Promise.all(toSeed.map((p: any) => api
            .getSecurityFindings(p.id, 'open')
            .then((data: any) => [p.id, data?.openCounts || null])
            .catch(() => [p.id, null]))).then((entries: any) => {
            if (cancelled)
                return;
            setSecurityOpenCounts((prev: any) => {
                const next = { ...prev };
                for (const [pid, counts] of entries) {
                    if (next[pid] === undefined && counts)
                        next[pid] = counts;
                }
                return next;
            });
        });
        return () => {
            cancelled = true;
        };
    }, [projects]);
    const refreshOpenPullCount = useCallback(async (projectId: any) => {
        if (!projectId)
            return;
        try {
            const data = await api.getProjectPulls(projectId, { state: 'open', limit: 100 });
            const count = Array.isArray(data?.pulls) ? data.pulls.length : 0;
            setOpenPullCounts((prev: any) => ({ ...prev, [projectId]: count }));
        }
        catch {
            setOpenPullCounts((prev: any) => prev[projectId] === undefined ? { ...prev, [projectId]: 0 } : prev);
        }
    }, []);
    refreshOpenPullCountRef.current = refreshOpenPullCount;
    const seededPullProjectsRef = useRef<any>(new Set());
    useEffect(() => {
        if (!projects || projects.length === 0) {
            seededPullProjectsRef.current = new Set();
            return;
        }
        const toSeed = projects.filter((p: any) => p?.id &&
            !isWorkflowProject(p) &&
            (p.githubRepo || p.gitHost === 'agenthub') &&
            !seededPullProjectsRef.current.has(p.id));
        if (toSeed.length === 0)
            return;
        toSeed.forEach((p: any) => seededPullProjectsRef.current.add(p.id));
        let cancelled = false;
        Promise.all(toSeed.map((p: any) => api
            .getProjectPulls(p.id, { state: 'open', limit: 100 })
            .then((data: any) => [p.id, Array.isArray(data?.pulls) ? data.pulls.length : 0])
            .catch(() => [p.id, 0]))).then((entries: any) => {
            if (cancelled)
                return;
            setOpenPullCounts((prev: any) => {
                const next = { ...prev };
                for (const [pid, count] of entries) {
                    if (next[pid] === undefined)
                        next[pid] = count;
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
        if (toSeed.length === 0)
            return;
        toSeed.forEach((p: any) => seededTicketProjectsRef.current.add(p.id));
        let cancelled = false;
        Promise.all(toSeed.map((p: any) => api
            .getSupportUnreadCount(p.id)
            .then((r: any) => [p.id, r?.count ?? 0])
            .catch(() => [p.id, 0]))).then((entries: any) => {
            if (cancelled)
                return;
            setUnreadTicketCounts((prev: any) => {
                const next = { ...prev };
                for (const [pid, count] of entries) {
                    // Don't clobber a fresher value a WebSocket event already delivered.
                    if (next[pid] === undefined)
                        next[pid] = count;
                }
                return next;
            });
        });
        return () => {
            cancelled = true;
        };
    }, [projects]);
    /**
     * ThreadsScreen calls this when the user enters the list view for a project,
     * so the WS handler knows which project is currently focused (used later if
     * we want to keep the list live without also pinging the badge).
     */
    const setActiveThreadsProject = useCallback((projectId: any) => {
        activeThreadsProjectIdRef.current = projectId;
    }, []);
    /**
     * ThreadsScreen calls this when the user opens a specific thread detail.
     * Passing `null` clears (e.g. on back / unmount). While set, incoming entry
     * events for that thread skip unread-count bumps.
     */
    const setActiveThread = useCallback((threadId: any) => {
        activeThreadIdRef.current = threadId;
    }, []);
    const dismissChangesReady = useCallback((sessionId: any) => {
        setChangesReady((prev: any) => {
            if (!prev[sessionId])
                return prev;
            const next = { ...prev };
            delete (next as any)[sessionId];
            return next;
        });
    }, []);
    const triggerCreateTicketAndPr = useCallback(async () => {
        const sessionId = activeSessionIdRef.current;
        if (!sessionId)
            return;
        try {
            await api.shipSession(sessionId);
        }
        catch (err: any) {
            Alert.alert('Create ticket & PR', (err && err.message) || 'Failed to start shipping');
        }
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
        messageQueues,
        eventsByMessage,
        browserScreensBySession,
        artifactReloadBySession,
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
        changesReady,
        shipFailureAt,
        dismissChangesReady,
        triggerCreateTicketAndPr,
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
        // Threads
        unreadThreadCounts,
        lastThreadEvent,
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
        markProjectThreadsRead,
        setActiveThreadsProject,
        setActiveThread,
        // Push notification state (Settings screen surfaces these)
        pushToken,
        pushPermissionStatus,
        // Navigation bridge — App.js calls this once the NavigationContainer
        // ref is mounted so the notification-tap listener can open screens.
        registerNavigator,
    };
    return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
export function useApp() {
    const ctx = useContext(AppContext);
    if (!ctx)
        throw new Error('useApp must be used within AppProvider');
    return ctx;
}
