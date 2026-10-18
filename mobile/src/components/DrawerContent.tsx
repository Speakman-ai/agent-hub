import ProjectIcon from './ProjectIcon';
import AiSignInHint from './AiSignInHint';
import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  Platform,
  Pressable,
  ActivityIndicator,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { getOrgs, getActiveOrg } from '../utils/orgs';
import { getApiBaseUrl, getWsUrl } from '../utils/config';
import { colors } from '../theme/colors';
import { daysUntilPurge, parseDate } from '../utils/time';
import humanCron from '@shared/utils/humanCron';
import { isWorkflowProject } from '../utils/project-mode';
import { projectNavGroups } from '../utils/projectMenu';
import {
  isSidebarSessionActionable,
  projectCanFullyCollapse,
  projectHostsScheduledTasks,
} from '../utils/sidebarSchedule';
import {
  loadNavGroupCollapsed,
  saveNavGroupCollapsed,
  mergeHydratedNavGroups,
} from '../utils/navGroupCollapse';
import {
  createCollapsedProjectsCacheSaver,
  currentCollapsedProjectsKey,
  loadCollapsedProjects,
} from '../utils/sidebarProjectCollapse';
import {
  createCollapsedProjectSaver,
  fromCollapsedMap,
  mergeHydratedCollapsedProjects,
  normalizeCollapsedProjects,
  toCollapsedMap,
} from '@shared/utils/sidebarProjectCollapse';
import { deriveSessionState } from '../utils/deriveSessionState';
import SessionStateIcon from './SessionStateIcon';
import HubIcon from './HubIcon';
import BugReportButton from './BugReportButton';
import NotificationBell from './NotificationBell';
import BrandLogo from './BrandLogo';
import { useHubChatBadge } from '../hooks/useHubChat';

/**
 * The one API call the collapsed-project saver makes. Module scope so every
 * per-account saver shares the same function identity — the account binding
 * lives in the saver's lifetime, not in this closure.
 */
const putCollapsedProject = (projectId: string, collapsed: boolean) =>
  api.putMySidebarCollapsedProject(projectId, collapsed);

export default function DrawerContent({ navigation }: any) {
  const chatBadge = useHubChatBadge();
  const {
    showAiSignInGuide,
    dismissAiSignInGuide,
    agents,
    projects,
    activeAgentId,
    setActiveAgentId,
    sessions,
    activeSessionId,
    setActiveSessionId,
    handleNewSession,
    handleDeleteSession,
    archivedSessions,
    handleRestoreSession,
    restoringSessionIds,
    handleSwitchOrg,
    cronSessions,
    activeTasks,
    finalizeStatusBySession,
    unreadTicketCounts,
    openPullCounts,
    securityOpenCounts,
    skillImprovementCounts,
    activeReviews,
    changesReady,
    handleRenameSession,
    reloadAgentSessions,
    handleReorderProjects,
    handleOpenHandoffSession,
    reloadMessages,
    connected,
    reconnecting,
  } = useApp();
  const activeAgent = agents.find((a: any) => a.id === activeAgentId) || null;
  const bugReportProjectId = activeAgent?.projectId || '';
  const [collapsedAgents, setCollapsedAgents] = useState<any>({});
  // Which projects are collapsed in the drawer. The authoritative store is
  // per-USER on the server (`/api/auth/me/sidebar-collapsed-projects`), so the
  // same account sees the same collapsed projects on web, mobile, and
  // Electron. AsyncStorage is only a cold-start cache that keeps the drawer
  // from flashing every project open while the hydration GET is in flight —
  // and it is keyed per account, so a second user signing in on this device
  // never inherits the first user's view.
  const [collapsedProjects, setCollapsedProjects] = useState<any>({});
  // AsyncStorage is asynchronous, so do not paint project rows until this
  // account's cold-start cache has been read. Without the gate the first
  // render shows every project expanded and then visibly snaps to the cache.
  const [projectCollapseCacheHydrated, setProjectCollapseCacheHydrated] = useState(false);
  // Taps made before hydration resolved; they win over the server list so an
  // early interaction is neither discarded nor written back to the cache.
  const pendingProjectCollapseRef = useRef<Record<string, boolean>>({});
  const projectCollapseHydratedRef = useRef(false);
  // Serializes + coalesces the save PUTs per project. Rapid taps would
  // otherwise race and could leave the account holding the opposite of what
  // the drawer shows — a divergence that only surfaces on the next launch.
  //
  // The saver belongs to ONE account: its queue holds values, and the auth
  // token is only read when a value is finally dispatched. The effect below
  // retires it and installs a replacement whenever the account changes, so a
  // tap queued by the previous user can never be written to the new user's
  // preferences. Seeded eagerly so a tap landing between first render and the
  // first effect flush still has somewhere to go.
  // Re-hydrate when the signed-in account changes (sign-out/sign-in keeps the
  // drawer mounted), so the new user never keeps looking at the old state.
  const collapseAccountKey = currentCollapsedProjectsKey();
  const projectCollapseSaverRef = useRef<ReturnType<typeof createCollapsedProjectSaver> | null>(
    null,
  );
  if (!projectCollapseSaverRef.current)
    projectCollapseSaverRef.current = createCollapsedProjectSaver(putCollapsedProject);
  const projectCollapseSaverAccountKeyRef = useRef(collapseAccountKey);
  const projectCollapseCacheSaverRef = useRef<ReturnType<
    typeof createCollapsedProjectsCacheSaver
  > | null>(null);
  if (!projectCollapseCacheSaverRef.current)
    projectCollapseCacheSaverRef.current = createCollapsedProjectsCacheSaver();
  const projectCollapseCacheSaverAccountKeyRef = useRef(collapseAccountKey);
  // Retire and replace both eager savers synchronously on an account change.
  // This closes the gap before the hydration effect runs: a pre-effect queue
  // can never become orphaned and dispatch under the next account's token.
  if (projectCollapseSaverAccountKeyRef.current !== collapseAccountKey) {
    projectCollapseSaverRef.current!.cancel();
    projectCollapseSaverRef.current = createCollapsedProjectSaver(putCollapsedProject);
    projectCollapseSaverAccountKeyRef.current = collapseAccountKey;
  }
  if (projectCollapseCacheSaverAccountKeyRef.current !== collapseAccountKey) {
    projectCollapseCacheSaverRef.current!.cancel();
    projectCollapseCacheSaverRef.current = createCollapsedProjectsCacheSaver();
    projectCollapseCacheSaverAccountKeyRef.current = collapseAccountKey;
  }
  useEffect(() => {
    let cancelled = false;
    const accountSaver = projectCollapseSaverRef.current!;
    const accountCacheSaver = projectCollapseCacheSaverRef.current!;
    projectCollapseHydratedRef.current = false;
    pendingProjectCollapseRef.current = {};
    setProjectCollapseCacheHydrated(false);
    setCollapsedProjects({});
    (async () => {
      const cachedIds = await loadCollapsedProjects();
      if (cancelled) return;
      if (cachedIds.length) {
        // Cache paints UNDER any taps already made (`prev` wins).
        setCollapsedProjects((prev: any) => ({ ...toCollapsedMap(cachedIds), ...prev }));
      }
      // The cache is the first-paint source of truth while the server
      // request is still in flight. An empty cache is also a completed
      // read and must release the loading gate.
      setProjectCollapseCacheHydrated(true);
      let serverIds: string[] | null = null;
      try {
        const data: any = await api.getMySidebarCollapsedProjects();
        serverIds = normalizeCollapsedProjects(data?.sidebarCollapsedProjects);
      } catch {
        // Offline / no per-user row — keep the cached view rather than
        // expanding everything.
        serverIds = null;
      }
      if (cancelled) return;
      if (serverIds) {
        const merged = mergeHydratedCollapsedProjects(serverIds, pendingProjectCollapseRef.current);
        setCollapsedProjects(toCollapsedMap(merged));
        void accountCacheSaver.save(merged);
      }
      projectCollapseHydratedRef.current = true;
      pendingProjectCollapseRef.current = {};
    })();
    return () => {
      cancelled = true;
      // Runs before the next effect body (account change) and on unmount
      // (sign-out). Either way the queued taps belong to an account that
      // is no longer the one we'd authenticate as.
      accountSaver.cancel();
      accountCacheSaver.cancel();
    };
  }, [collapseAccountKey]);
  const toggleProjectCollapse = (projectId: string) => {
    const collapsed = !collapsedProjects[projectId];
    const next = { ...collapsedProjects, [projectId]: collapsed };
    setCollapsedProjects(next);
    if (!projectCollapseHydratedRef.current)
      pendingProjectCollapseRef.current[projectId] = collapsed;
    void projectCollapseCacheSaverRef.current!.save(fromCollapsedMap(next));
    // Serialized + coalesced per project, so double-tapping can't land the
    // PUTs out of order. Still fire-and-forget: the optimistic local state is
    // already correct and the saver swallows failures.
    void projectCollapseSaverRef.current!.save(projectId, collapsed);
  };
  // Per-project nav-group collapse state, keyed by `${projectId}:${groupKey}`.
  // Default COLLAPSED (mirrors the web sidebar). Hydrated from AsyncStorage on
  // mount and persisted on change so the user's choices survive app restarts.
  const [collapsedNavGroups, setCollapsedNavGroups] = useState<any>({});
  const [navGroupsHydrated, setNavGroupsHydrated] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadNavGroupCollapsed().then((stored) => {
      if (!cancelled) {
        // Merge stored state UNDER any toggles the user made before the
        // async load resolved — `prev` (their taps) wins over `stored` so
        // an early interaction is neither discarded nor lost to storage
        // (the post-hydration persist effect then saves the merged result).
        setCollapsedNavGroups((prev: any) => mergeHydratedNavGroups(stored, prev));
        setNavGroupsHydrated(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    // Skip until hydration so we don't clobber storage with the empty initial
    // state before the stored map has been merged in.
    if (!navGroupsHydrated) return;
    saveNavGroupCollapsed(collapsedNavGroups);
  }, [collapsedNavGroups, navGroupsHydrated]);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  // Session-list open state, independent of which agent is the active chat.
  // `collapsedAgents` (below) is the "actionable only" filter, matching web.
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});
  const [sessionsByAgentId, setSessionsByAgentId] = useState<Record<string, any[]>>({});
  const [archivedByAgentId, setArchivedByAgentId] = useState<Record<string, any[]>>({});
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingSessionName, setEditingSessionName] = useState('');
  const [confirmAction, setConfirmAction] = useState<null | 'clear-all' | 'clear-merged'>(null);
  const [confirmAgentId, setConfirmAgentId] = useState<string | null>(null);
  const [clearingBulk, setClearingBulk] = useState(false);
  const [showOrgPicker, setShowOrgPicker] = useState(false);
  // Server version / git hash for the footer (matches the web sidebar footer).
  const [health, setHealth] = useState<any>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getHealth()
      .then((h: any) => {
        if (!cancelled) setHealth(h);
      })
      .catch(() => {
        /* footer version is best-effort — ignore failures */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const orgState = getOrgs();
  const orgs = orgState?.orgs || [];
  const activeOrg = getActiveOrg();
  const toggleSessionFilter = (agentId: string) => {
    setCollapsedAgents((prev: any) => ({ ...prev, [agentId]: !prev[agentId] }));
  };
  const sessionsForAgent = (agentId: string) =>
    agentId === activeAgentId ? sessions : sessionsByAgentId[agentId] || [];
  const archivedForAgent = (agentId: string) =>
    agentId === activeAgentId ? archivedSessions || [] : archivedByAgentId[agentId] || [];
  // Inactive agents' lists are fetched on every expand (the cache only fills
  // the gap while the request runs); the newest request per agent wins.
  const agentLoadGen = useRef<Record<string, number>>({});
  const loadAgentSessions = async (agentId: string) => {
    if (!agentId || agentId === activeAgentId) return;
    const gen = (agentLoadGen.current[agentId] || 0) + 1;
    agentLoadGen.current[agentId] = gen;
    try {
      const loaded = await reloadAgentSessions(agentId);
      if (agentLoadGen.current[agentId] !== gen) return;
      setSessionsByAgentId((prev) => ({ ...prev, [agentId]: loaded.sessions }));
      setArchivedByAgentId((prev) => ({ ...prev, [agentId]: loaded.archived }));
    } catch {
      /* leave the list empty; the chevron can be tapped again */
    }
  };
  // While an agent is active its rows live in AppContext and change there, so
  // its cached copy goes stale. When it stops being active, refetch it if its
  // list is open and drop the cache otherwise.
  const previousActiveAgent = useRef(activeAgentId);
  const latest = useRef({ loadAgentSessions, expandedAgents });
  latest.current = { loadAgentSessions, expandedAgents };
  useEffect(() => {
    const prev = previousActiveAgent.current;
    previousActiveAgent.current = activeAgentId;
    if (!prev || prev === activeAgentId) return;
    agentLoadGen.current[prev] = (agentLoadGen.current[prev] || 0) + 1;
    if (latest.current.expandedAgents[prev]) {
      void latest.current.loadAgentSessions(prev);
      return;
    }
    const drop = (cache: Record<string, any[]>) => {
      if (!(prev in cache)) return cache;
      const next = { ...cache };
      delete next[prev];
      return next;
    };
    setSessionsByAgentId(drop);
    setArchivedByAgentId(drop);
  }, [activeAgentId]);
  const toggleAgentExpanded = (agentId: string) => {
    setExpandedAgents((prev) => {
      const next = !prev[agentId];
      if (next) void loadAgentSessions(agentId);
      return { ...prev, [agentId]: next };
    });
  };
  const sessionFlags = {
    activeTaskSessionIds: activeTasks,
    changesReadyBySession: changesReady,
    finalizeStatusBySession,
  };
  const moveProject = (projectId: string, direction: -1 | 1) => {
    const ids = projects.map((p: any) => p.id);
    const index = ids.indexOf(projectId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    const next = ids.slice();
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    handleReorderProjects(next);
  };
  const isRecent = (dateStr: any) => {
    const d = parseDate(dateStr);
    if (!d || Number.isNaN(d.getTime())) return false;
    return Date.now() - d.getTime() < 30 * 60 * 1000;
  };
  const handleAgentSelect = (agentId: any) => {
    setActiveAgentId(agentId);
    navigation.navigate('Chat');
    navigation.closeDrawer();
  };
  const showConnectionInfo = () => {
    const org = getActiveOrg();
    const apiUrl = getApiBaseUrl();
    const wsUrl = getWsUrl();
    Alert.alert(
      'Connection Info',
      `Org: ${org?.name || '(none)'}\n` +
        `URL: ${org?.remoteUrl || '(not set)'}\n` +
        `API: ${apiUrl || '(empty)'}\n` +
        `WS: ${wsUrl ? wsUrl.replace(/apiKey=[^&]+/, 'apiKey=***') : '(empty)'}\n` +
        `Key: ${org?.apiKey ? `${org.apiKey.slice(0, 5)}...${org.apiKey.slice(-4)}` : '(none)'}\n` +
        `Status: ${connected ? 'Connected' : reconnecting ? 'Reconnecting' : 'Disconnected'}`,
    );
  };
  const focusSession = (agentId: string, sessionId: string) => {
    if (agentId && agentId !== activeAgentId) {
      handleOpenHandoffSession(agentId, sessionId);
    } else if (sessionId === activeSessionId) {
      reloadMessages();
    } else {
      setActiveSessionId(sessionId);
    }
    navigation.navigate('Chat');
    navigation.closeDrawer();
  };
  const saveSessionName = async (session: any) => {
    const name = editingSessionName.trim();
    setEditingSessionId(null);
    if (!name || name === session.name) return;
    try {
      await handleRenameSession(session.id, name);
      const agentId = session.agent_id;
      if (agentId && agentId !== activeAgentId) {
        setSessionsByAgentId((prev) => ({
          ...prev,
          [agentId]: (prev[agentId] || []).map((row: any) =>
            row.id === session.id ? { ...row, name } : row,
          ),
        }));
      }
    } catch (err: any) {
      Alert.alert('Rename failed', err?.message || 'Failed to rename session');
    }
  };
  const runClear = async (agentId: string, action: 'clear-all' | 'clear-merged') => {
    setClearingBulk(true);
    try {
      if (action === 'clear-all') await api.clearAllSessions(agentId);
      // Same as the web sidebar: "Clear pushed" archives sessions whose work
      // has merged, the settled state once per-session auto-merge runs.
      // Users read "pushed" as "shipped"; the pushed endpoint would also
      // archive branches still waiting on review.
      else await api.clearMergedSessions(agentId);
      const loaded = await reloadAgentSessions(agentId);
      if (agentId !== activeAgentId) {
        setSessionsByAgentId((prev) => ({ ...prev, [agentId]: loaded.sessions }));
        setArchivedByAgentId((prev) => ({ ...prev, [agentId]: loaded.archived }));
      }
    } catch (err: any) {
      Alert.alert('Clear failed', err?.message || 'Failed to clear sessions');
    } finally {
      setClearingBulk(false);
      setConfirmAction(null);
      setConfirmAgentId(null);
    }
  };
  // Archive/restore handlers in AppContext only maintain the active agent's
  // lists; an inactive agent's expanded lists live in this component's caches.
  const moveInAgentCache = (
    agentId: string | null | undefined,
    row: any,
    to: 'archived' | 'live',
  ) => {
    if (!agentId || agentId === activeAgentId || !row?.id) return;
    const drop = (list: any[] | undefined) => (list || []).filter((s: any) => s.id !== row.id);
    const add = (list: any[] | undefined) => [row, ...drop(list)];
    const [setFrom, setTo] =
      to === 'archived'
        ? [setSessionsByAgentId, setArchivedByAgentId]
        : [setArchivedByAgentId, setSessionsByAgentId];
    setFrom((prev) => (prev[agentId] ? { ...prev, [agentId]: drop(prev[agentId]) } : prev));
    setTo((prev) => (prev[agentId] ? { ...prev, [agentId]: add(prev[agentId]) } : prev));
  };
  const restoreSession = async (agentId: string, archivedRow: any) => {
    const restored = await handleRestoreSession(archivedRow.id);
    if (!restored) return;
    moveInAgentCache(
      agentId,
      restored.id ? restored : { ...archivedRow, deleted_at: null },
      'live',
    );
  };
  const confirmDeleteSession = (sessionId: any, session?: any, agentId?: string) => {
    // Holding a session deletes it. The copy explains the 7-day window, so
    // the archive completes without a second modal. The row moves to Archived
    // immediately; failures surface from handleDeleteSession.
    const buttons: any[] = [{ text: 'Cancel', style: 'cancel' }];
    if (session) {
      buttons.push({
        text: 'Rename',
        onPress: () => {
          setEditingSessionId(session.id);
          setEditingSessionName(session.name || '');
        },
      });
    }
    buttons.push({
      text: 'Delete',
      style: 'destructive',
      onPress: () => {
        handleDeleteSession(sessionId)
          .then(() => {
            moveInAgentCache(
              session?.agent_id || agentId,
              {
                ...(session || { id: sessionId }),
                deleted_at: new Date().toISOString(),
                message_count: session?.message_count ?? 0,
              },
              'archived',
            );
          })
          .catch(() => {});
      },
    });
    Alert.alert(
      'Delete Session',
      'Archive this session? You can restore it within 7 days from the Archived section.',
      buttons,
    );
  };
  const renderCronSection = (rows: any[], testID?: string) => {
    if (!rows.length) return null;
    return (
      <View style={styles.cronSection} testID={testID}>
        <View style={styles.sectionLabelRow}>
          <HubIcon name="Clock" size={12} color={colors.gray500} />
          <Text style={[styles.sectionLabel, styles.sectionLabelInline]}>SCHEDULED TASKS</Text>
        </View>
        {rows.map((cs: any) => (
          <TouchableOpacity
            key={cs.id}
            style={[styles.cronRow, activeSessionId === cs.id && styles.agentItemActive]}
            onPress={() => focusSession(cs.agent_id || activeAgentId, cs.id)}
          >
            <SessionStateIcon
              state={deriveSessionState(cs, {
                activeTaskSessionIds: activeTasks,
                finalizeStatusBySession,
              })}
              testID={`session-state-icon-${cs.id}`}
            />
            <Text
              style={[
                styles.agentName,
                styles.cronName,
                activeSessionId === cs.id && styles.agentNameActive,
              ]}
              numberOfLines={1}
            >
              {cs.cron_name || cs.name}
            </Text>
            <Text style={styles.cronScheduleInline}>{humanCron(cs.cron_schedule)}</Text>
          </TouchableOpacity>
        ))}
      </View>
    );
  };
  const renderAgentRow = (agent: any, project: any) => {
    if (agent.role === 'reviewer' || agent.role === 'skill-builder') return null;
    const isExpanded = !!expandedAgents[agent.id];
    const agentSessions = sessionsForAgent(agent.id);
    const agentArchived = archivedForAgent(agent.id);
    const actionableOnly = !!collapsedAgents[agent.id];
    const visibleSessions = actionableOnly
      ? agentSessions.filter((session: any) => isSidebarSessionActionable(session, sessionFlags))
      : agentSessions;
    const isActive = activeAgentId === agent.id;
    const review = project?.mode === 'workflow' ? null : activeReviews?.[agent.name];
    return (
      <View key={agent.id}>
        <View style={[styles.agentItem, isActive && styles.agentItemActive]}>
          <TouchableOpacity style={styles.agentMain} onPress={() => handleAgentSelect(agent.id)}>
            <View style={styles.agentDotContainer}>
              <View style={[styles.agentDot, { backgroundColor: agent.color }]} />
              {isRecent(agent.lastActivity) && <View style={styles.activityIndicator} />}
            </View>
            <Text style={[styles.agentName, isActive && styles.agentNameActive]} numberOfLines={1}>
              {agent.name}
              {agent.role === 'lead' ? <Text style={styles.leadTag}> lead</Text> : null}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => toggleAgentExpanded(agent.id)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel={`${isExpanded ? 'Collapse' : 'Expand'} ${agent.name} sessions`}
          >
            <Text style={styles.collapseIcon}>{isExpanded ? '\u25BE' : '\u25B8'}</Text>
          </TouchableOpacity>
          {review ? (
            <TouchableOpacity
              style={styles.reviewingBadge}
              onPress={() => {
                if (review.sessionId) focusSession(agent.id, review.sessionId);
              }}
            >
              <Text style={styles.reviewingBadgeText}>reviewing PR</Text>
            </TouchableOpacity>
          ) : null}
          {isExpanded ? (
            <TouchableOpacity
              onPress={() => toggleSessionFilter(agent.id)}
              accessibilityLabel={actionableOnly ? 'Show all sessions' : 'Show actionable only'}
            >
              <Text style={styles.collapseIcon}>{actionableOnly ? '···' : '≡'}</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {isExpanded && !(actionableOnly && visibleSessions.length === 0) && (
          <View style={styles.sessionsContainer} testID="agent-sessions-list">
            {visibleSessions.map((session: any) => (
              <View
                key={session.id}
                style={[
                  styles.sessionItem,
                  activeSessionId === session.id && styles.sessionItemActive,
                ]}
              >
                {editingSessionId === session.id ? (
                  <TextInput
                    style={styles.sessionRenameInput}
                    value={editingSessionName}
                    autoFocus
                    onChangeText={setEditingSessionName}
                    onSubmitEditing={() => saveSessionName(session)}
                    onBlur={() => saveSessionName(session)}
                  />
                ) : (
                  <TouchableOpacity
                    style={styles.sessionMain}
                    onPress={() => focusSession(agent.id, session.id)}
                    onLongPress={() => confirmDeleteSession(session.id, session, agent.id)}
                    delayLongPress={400}
                  >
                    <SessionStateIcon
                      state={deriveSessionState(session, {
                        activeTaskSessionIds: activeTasks,
                        finalizeStatusBySession,
                      })}
                      testID={`session-state-icon-${session.id}`}
                    />
                    <Text
                      style={[
                        styles.sessionName,
                        activeSessionId === session.id && styles.sessionNameActive,
                      ]}
                      numberOfLines={1}
                    >
                      {session.name}
                    </Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  onPress={() => confirmDeleteSession(session.id, session, agent.id)}
                  accessibilityLabel="Delete session"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.sessionDelete}>✕</Text>
                </TouchableOpacity>
              </View>
            ))}
            {!actionableOnly && (
              <>
                <View style={styles.sessionActions}>
                  <TouchableOpacity
                    style={styles.newSessionButton}
                    onPress={async () => {
                      await handleNewSession(agent.id);
                      navigation.navigate('Chat');
                      navigation.closeDrawer();
                    }}
                  >
                    <Text style={styles.newSessionText}>+ New Session</Text>
                  </TouchableOpacity>
                  {agentSessions.length > 0 && (
                    <View style={styles.sessionBulk}>
                      <TouchableOpacity
                        disabled={clearingBulk}
                        onPress={() => {
                          setConfirmAgentId(agent.id);
                          setConfirmAction('clear-merged');
                        }}
                      >
                        <Text style={styles.clearPushedText}>
                          {clearingBulk ? '...' : 'Clear pushed'}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        disabled={clearingBulk}
                        onPress={() => {
                          setConfirmAgentId(agent.id);
                          setConfirmAction('clear-all');
                        }}
                        accessibilityLabel="Clear all sessions"
                      >
                        <HubIcon name="Trash2" size={12} color={colors.gray600} />
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
                {agentArchived.length > 0 && (
                  <View style={styles.archivedSection} testID="archived-sessions-section">
                    <TouchableOpacity
                      onPress={() => setArchivedExpanded((v: any) => !v)}
                      style={styles.archivedHeader}
                    >
                      <Text style={styles.archivedHeaderText}>
                        Archived ({agentArchived.length})
                      </Text>
                      <Text style={styles.archivedChevron}>
                        {archivedExpanded ? '\u25BE' : '\u25B8'}
                      </Text>
                    </TouchableOpacity>
                    {archivedExpanded && (
                      <View testID="archived-sessions-list">
                        {agentArchived.map((a: any) => {
                          const purge = daysUntilPurge(a.deleted_at);
                          // AppContext always passes a Set; optional chaining keeps
                          // this safe if a test mounts DrawerContent without it.
                          const isRestoring = restoringSessionIds.has(a.id);
                          const urgent = purge && purge.daysLeft <= 1;
                          return (
                            <View key={a.id} style={styles.archivedRow}>
                              <View style={{ flex: 1 }}>
                                <Text style={styles.archivedName} numberOfLines={1}>
                                  {a.name}
                                </Text>
                                {purge && (
                                  <Text
                                    style={[
                                      styles.archivedPurge,
                                      urgent && styles.archivedPurgeUrgent,
                                    ]}
                                  >
                                    {purge.label}
                                  </Text>
                                )}
                              </View>
                              <TouchableOpacity
                                onPress={() => void restoreSession(agent.id, a)}
                                disabled={isRestoring}
                                style={[
                                  styles.restoreButton,
                                  isRestoring && styles.restoreButtonDisabled,
                                ]}
                              >
                                <Text style={styles.restoreButtonText}>
                                  {isRestoring ? '…' : 'Restore'}
                                </Text>
                              </TouchableOpacity>
                            </View>
                          );
                        })}
                      </View>
                    )}
                  </View>
                )}
                {confirmAction && confirmAgentId === agent.id && (
                  <View style={styles.confirmBox}>
                    <Text style={styles.confirmText}>
                      {confirmAction === 'clear-all'
                        ? `Delete all ${agentSessions.length} session${agentSessions.length === 1 ? '' : 's'}? This cannot be undone.`
                        : 'Delete all sessions with pushed changes? Sessions in any other state will be kept.'}
                    </Text>
                    <View style={styles.confirmActions}>
                      <TouchableOpacity onPress={() => setConfirmAction(null)}>
                        <Text style={styles.confirmCancel}>Cancel</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        disabled={clearingBulk}
                        style={
                          confirmAction === 'clear-all'
                            ? styles.confirmDelete
                            : styles.confirmPushed
                        }
                        onPress={() => runClear(agent.id, confirmAction)}
                      >
                        <Text style={styles.confirmConfirmText}>
                          {clearingBulk
                            ? 'Deleting...'
                            : confirmAction === 'clear-all'
                              ? 'Delete All'
                              : 'Delete Pushed'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              </>
            )}
          </View>
        )}
      </View>
    );
  };
  const renderMenuItem = (project: any, entry: any) => (
    <TouchableOpacity
      key={entry.key}
      style={styles.projectMenuItem}
      onPress={() => {
        navigation.navigate(entry.screen, {
          projectId: project.id,
          project,
        });
        navigation.closeDrawer();
      }}
    >
      <HubIcon
        name={entry.icon}
        size={14}
        color={colors.gray500}
        style={styles.projectMenuItemIcon}
      />
      <Text style={styles.projectMenuItemText} numberOfLines={1}>
        {entry.label}
      </Text>
      {entry.key === 'skills' && (skillImprovementCounts?.[project.id] || 0) > 0 && (
        <View testID="skills-pending-badge" style={[styles.unreadBadge, styles.skillBadge]}>
          <Text style={styles.unreadBadgeText}>
            {
              (skillImprovementCounts[project.id] > 99
                ? '99+'
                : skillImprovementCounts[project.id]) as any
            }
          </Text>
        </View>
      )}
      {entry.key === 'support' && unreadTicketCounts?.[project.id] > 0 && (
        <View style={[styles.unreadBadge, styles.countBadge]}>
          <Text style={styles.unreadBadgeText}>
            {unreadTicketCounts[project.id] > 99 ? '99+' : unreadTicketCounts[project.id]}
          </Text>
        </View>
      )}
      {entry.key === 'pulls' && openPullCounts?.[project.id] > 0 && (
        <View style={[styles.unreadBadge, styles.countBadge]}>
          <Text style={styles.unreadBadgeText}>
            {openPullCounts[project.id] > 99 ? '99+' : openPullCounts[project.id]}
          </Text>
        </View>
      )}
      {entry.key === 'security' &&
        (() => {
          const counts = securityOpenCounts?.[project.id];
          const criticalHigh = counts ? (counts.critical || 0) + (counts.high || 0) : 0;
          if (criticalHigh <= 0) return null;
          return (
            <View style={[styles.unreadBadge, styles.securityBadge]}>
              <Text style={styles.unreadBadgeText}>{criticalHigh > 99 ? '99+' : criticalHigh}</Text>
            </View>
          );
        })()}
    </TouchableOpacity>
  );
  // Grouped nav (Git / Planning / Support / AI / Settings), each group a
  // collapsible section (default collapsed), mirroring the web sidebar.
  const renderProjectMenu = (project: any) => {
    const groups = projectNavGroups(
      project,
      agents.filter((a: any) => a.projectId === project.id),
    );
    return (
      <View style={styles.projectMenu}>
        {groups.map((group: any) => {
          const collapseKey = `${project.id}:${group.key}`;
          const collapsed = collapsedNavGroups[collapseKey] ?? true;
          return (
            <View key={group.key}>
              <TouchableOpacity
                style={styles.projectMenuToggle}
                testID={`drawer-nav-group-${group.key}-${project.id}`}
                onPress={() =>
                  setCollapsedNavGroups((prev: any) => ({
                    ...prev,
                    [collapseKey]: !(prev[collapseKey] ?? true),
                  }))
                }
              >
                <HubIcon
                  name={collapsed ? 'ChevronRight' : 'ChevronDown'}
                  size={14}
                  color={colors.gray500}
                  style={styles.projectMenuChevron}
                />
                <Text style={styles.projectMenuGroupLabel} numberOfLines={1}>
                  {group.label}
                </Text>
              </TouchableOpacity>
              {!collapsed && (
                <View style={styles.projectMenuItems}>
                  {group.entries.map((entry: any) => renderMenuItem(project, entry))}
                </View>
              )}
            </View>
          );
        })}
      </View>
    );
  };
  const scheduledTaskHomeIds = new Set(
    projects
      .filter((project: any) => {
        const activeAgentCount = agents.filter(
          (agent: any) => agent.projectId === project.id && agent.active !== false,
        ).length;
        return projectHostsScheduledTasks({
          activeAgentCount,
          workflow: isWorkflowProject(project),
          collapsed: !!collapsedProjects[project.id],
        });
      })
      .map((project: any) => project.id),
  );
  const ungroupedCronSessions = (cronSessions || []).filter(
    (cs: any) => !cs.project_id || !scheduledTaskHomeIds.has(cs.project_id),
  );
  const routeName = navigation.getCurrentRoute?.()?.name;
  const hubActive = [
    'Hub',
    'Home',
    'Dashboard',
    'Todos',
    'Calendar',
    'Gmail',
    'SupportOverview',
  ].includes(routeName);
  return (
    <SafeAreaView style={styles.container}>
      {/* Org Switcher Header */}
      <TouchableOpacity style={styles.header} onPress={() => setShowOrgPicker(!showOrgPicker)}>
        <View style={[styles.orgDot, { backgroundColor: activeOrg?.color || '#6366f1' }]} />
        <Text style={styles.headerTitle} numberOfLines={1}>
          {activeOrg?.name || 'Agent Hub'}
        </Text>
        <Text style={styles.chevron}>{showOrgPicker ? '\u25B4' : '\u25BE'}</Text>
      </TouchableOpacity>

      {showOrgPicker && (
        <View style={styles.orgDropdown}>
          {orgs.map((org: any) => (
            <TouchableOpacity
              key={org.id}
              style={[styles.orgItem, org.id === activeOrg?.id && styles.orgItemActive]}
              onPress={async () => {
                if (org.id !== activeOrg?.id) {
                  await handleSwitchOrg(org.id);
                }
                setShowOrgPicker(false);
              }}
            >
              <View style={[styles.orgItemDot, { backgroundColor: org.color }]} />
              <Text style={styles.orgItemName} numberOfLines={1}>
                {org.name}
              </Text>
              <Text style={styles.orgMode}>{'\u2601'}</Text>
              {org.id === activeOrg?.id && <Text style={styles.orgCheck}>{'\u2713'}</Text>}
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={styles.orgManage}
            onPress={() => {
              setShowOrgPicker(false);
              navigation.navigate('Settings');
              navigation.closeDrawer();
            }}
          >
            <Text style={styles.orgManageText}>Manage Servers</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Agents grouped by Project */}
      <ScrollView style={styles.agentList}>
        <TouchableOpacity
          testID="drawer-global-hub"
          style={[styles.dashboardItem, hubActive && styles.dashboardItemActive]}
          onPress={() => {
            navigation.navigate('Hub');
            navigation.closeDrawer();
          }}
          accessibilityLabel="Hub"
        >
          <BrandLogo size="sm" />
        </TouchableOpacity>
        <View style={styles.connectionRow}>
          <Pressable
            onLongPress={showConnectionInfo}
            style={[
              styles.connectionBadge,
              connected
                ? styles.connectionBadgeConnected
                : reconnecting
                  ? styles.connectionBadgeReconnecting
                  : styles.connectionBadgeDisconnected,
            ]}
            accessibilityRole="text"
            accessibilityLabel={
              connected ? 'Connected' : reconnecting ? 'Reconnecting' : 'Disconnected'
            }
            testID="sidebar-connection-status"
          >
            <Text
              style={[
                styles.connectionText,
                connected
                  ? styles.connectionTextConnected
                  : reconnecting
                    ? styles.connectionTextReconnecting
                    : styles.connectionTextDisconnected,
              ]}
              numberOfLines={1}
            >
              {connected ? '● Connected' : reconnecting ? '● Reconnecting…' : '● Disconnected'}
            </Text>
          </Pressable>
          <NotificationBell
            onPress={() => {
              navigation.navigate('Notifications');
              navigation.closeDrawer();
            }}
            buttonStyle={styles.bugReportButton}
            testID="drawer-notification-bell"
          />
          <BugReportButton
            projectId={bugReportProjectId}
            agentId={activeAgentId || ''}
            sourceUrl={activeAgent?.name ? `agent:${activeAgent.name}` : ''}
            buttonStyle={styles.bugReportButton}
          />
        </View>

        {renderCronSection(ungroupedCronSessions, 'drawer-ungrouped-scheduled-tasks')}

        {!projectCollapseCacheHydrated && (
          <View style={styles.projectCollapseLoading} testID="drawer-projects-loading">
            <ActivityIndicator color={colors.gray500} />
          </View>
        )}

        {projectCollapseCacheHydrated && (
          <>
            <Text style={styles.sectionLabel}>PROJECTS</Text>
            <TouchableOpacity
              testID="drawer-new-project"
              style={styles.newProjectCta}
              onPress={() => {
                navigation.navigate('NewProject');
                navigation.closeDrawer();
              }}
            >
              <HubIcon name="Plus" size={18} color={colors.white} strokeWidth={2.5} />
              <Text style={styles.newProjectCtaText}>New Project</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="drawer-import-project"
              style={styles.importProjectCta}
              onPress={() => {
                navigation.navigate('ImportProject');
                navigation.closeDrawer();
              }}
            >
              <HubIcon name="Plus" size={14} color={colors.gray400} />
              <Text style={styles.importProjectCtaText}>Import existing project</Text>
            </TouchableOpacity>
            {projects.map((project: any) => {
              const projectAgents = agents.filter(
                (a: any) => a.projectId === project.id && a.active !== false,
              );
              if (projectAgents.length === 0) return null;
              const workflow = isWorkflowProject(project);
              const canCollapse = projectCanFullyCollapse(projectAgents.length, workflow);
              const isCollapsed = !!collapsedProjects[project.id] && canCollapse;
              const isActiveProject = projectAgents.some((a: any) => a.id === activeAgentId);
              const projectIndex = projects
                .filter((candidate: any) =>
                  agents.some(
                    (agent: any) => agent.projectId === candidate.id && agent.active !== false,
                  ),
                )
                .findIndex((candidate: any) => candidate.id === project.id);
              const actionableWhileCollapsed =
                isCollapsed && isActiveProject
                  ? (sessions || []).filter((session: any) =>
                      isSidebarSessionActionable(session, sessionFlags),
                    )
                  : [];
              return (
                <View key={project.id} testID={`drawer-project-row-${project.id}`}>
                  {projectIndex > 0 && <View style={styles.projectDivider} />}
                  <View style={styles.projectHeaderRow}>
                    <TouchableOpacity
                      testID={`drawer-project-${project.id}`}
                      style={[styles.projectHeader, { flex: 1 }]}
                      onPress={() => {
                        if (canCollapse) toggleProjectCollapse(project.id);
                        else if (projectAgents[0]) toggleAgentExpanded(projectAgents[0].id);
                      }}
                      onLongPress={() => {
                        const ids = projects.map((p: any) => p.id);
                        const at = ids.indexOf(project.id);
                        const buttons: any[] = [];
                        if (at > 0) {
                          buttons.push({
                            text: 'Move up',
                            onPress: () => moveProject(project.id, -1),
                          });
                        }
                        if (at >= 0 && at < ids.length - 1) {
                          buttons.push({
                            text: 'Move down',
                            onPress: () => moveProject(project.id, 1),
                          });
                        }
                        buttons.push({ text: 'Cancel', style: 'cancel' });
                        Alert.alert(project.name, 'Reorder project', buttons);
                      }}
                    >
                      <ProjectIcon project={project} style={styles.projectDot} />
                      <Text style={styles.projectName} numberOfLines={1}>
                        {project.name}
                        {workflow ? <Text style={styles.workflowTag}> Wf</Text> : null}
                      </Text>
                      {project.visibility === 'private' && (
                        <HubIcon
                          name="Lock"
                          size={11}
                          color={colors.gray500}
                          accessibilityLabel="Private project"
                        />
                      )}
                      {canCollapse && (
                        <Text style={styles.collapseIcon}>{isCollapsed ? '\u25B8' : '\u25BE'}</Text>
                      )}
                    </TouchableOpacity>
                  </View>

                  {!isCollapsed && (
                    <>
                      {projectAgents.map((agent: any) => renderAgentRow(agent, project))}
                      {renderProjectMenu(project)}
                      {renderCronSection(
                        (cronSessions || []).filter((cs: any) => cs.project_id === project.id),
                        `drawer-project-scheduled-tasks-${project.id}`,
                      )}
                    </>
                  )}
                  {actionableWhileCollapsed.length > 0 && (
                    <View style={styles.collapsedActionable} testID="project-collapsed-actionable">
                      {actionableWhileCollapsed.map((session: any) => (
                        <TouchableOpacity
                          key={session.id}
                          style={styles.sessionItem}
                          onPress={() =>
                            focusSession(session.agent_id || activeAgentId, session.id)
                          }
                          onLongPress={() => confirmDeleteSession(session.id, session)}
                          delayLongPress={400}
                        >
                          <SessionStateIcon
                            state={deriveSessionState(session, {
                              activeTaskSessionIds: activeTasks,
                              finalizeStatusBySession,
                            })}
                            testID={`session-state-icon-${session.id}`}
                          />
                          <Text style={styles.sessionName} numberOfLines={1}>
                            {session.name}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                </View>
              );
            })}
          </>
        )}
      </ScrollView>

      {/* Footer matches the web sidebar: Settings, Chat, then the version
          line (tap opens What's new). */}
      <View style={styles.bottomNav}>
        {showAiSignInGuide && <AiSignInHint target="Settings" onDismiss={dismissAiSignInGuide} />}
        <TouchableOpacity
          style={[styles.navButton, routeName === 'Settings' && styles.navButtonActive]}
          onPress={() => {
            navigation.navigate('Settings');
            navigation.closeDrawer();
          }}
        >
          <HubIcon name="Settings" size={16} style={styles.navButtonIcon} />
          <Text style={styles.navButtonText}>Settings</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="drawer-chat"
          style={[styles.navButton, routeName === 'Chat' && styles.navButtonActive]}
          onPress={() => {
            navigation.navigate('Hub', { tab: 'chat' });
            navigation.closeDrawer();
          }}
          accessibilityLabel={chatBadge > 0 ? `Chat, ${chatBadge} unread` : 'Chat'}
        >
          <HubIcon name="MessageSquare" size={16} color={colors.gray400} />
          <Text style={styles.navButtonText}>Chat</Text>
          {chatBadge > 0 ? (
            <View style={[styles.unreadBadge, styles.countBadge]} testID="drawer-chat-badge">
              <Text style={styles.unreadBadgeText}>{chatBadge > 99 ? '99+' : chatBadge}</Text>
            </View>
          ) : null}
        </TouchableOpacity>
        {health?.version && (
          <TouchableOpacity
            style={styles.versionBox}
            onPress={() => {
              navigation.navigate('Releases');
              navigation.closeDrawer();
            }}
            accessibilityLabel="What's new in Agent Hub"
          >
            <Text style={styles.versionText}>v{health.version}</Text>
            {health.gitHash ? <Text style={styles.versionHash}>{health.gitHash}</Text> : null}
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.gray900,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: 'bold',
    color: colors.white,
  },
  orgDot: {
    width: 20,
    height: 20,
    borderRadius: 6,
  },
  chevron: {
    color: colors.gray500,
    fontSize: 12,
  },
  orgDropdown: {
    backgroundColor: colors.gray800,
    borderRadius: 8,
    marginHorizontal: 12,
    marginBottom: 8,
    overflow: 'hidden',
  },
  orgItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  orgItemActive: {
    backgroundColor: colors.gray700,
  },
  orgItemDot: {
    width: 14,
    height: 14,
    borderRadius: 4,
  },
  orgItemName: {
    flex: 1,
    fontSize: 13,
    color: colors.gray300,
  },
  orgMode: {
    fontSize: 12,
  },
  orgCheck: {
    color: colors.emerald400,
    fontSize: 14,
    fontWeight: 'bold',
  },
  orgManage: {
    borderTopWidth: 1,
    borderTopColor: colors.gray700,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  orgManageText: {
    fontSize: 12,
    color: colors.gray500,
  },
  agentList: {
    flex: 1,
    padding: 12,
  },
  connectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  connectionBadge: {
    flex: 1,
    minWidth: 0,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    alignItems: 'center',
  },
  connectionBadgeConnected: {
    backgroundColor: colors.emerald900_50,
  },
  connectionBadgeReconnecting: {
    backgroundColor: colors.yellow900_50,
  },
  connectionBadgeDisconnected: {
    backgroundColor: colors.red900_50,
  },
  connectionText: {
    fontSize: 12,
    textAlign: 'center',
  },
  connectionTextConnected: {
    color: colors.emerald400,
  },
  connectionTextReconnecting: {
    color: colors.yellow400,
  },
  connectionTextDisconnected: {
    color: colors.red400,
  },
  bugReportButton: {
    padding: 8,
    marginRight: 0,
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.gray500,
    letterSpacing: 1,
    marginBottom: 8,
    paddingHorizontal: 8,
  },
  sectionLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
    paddingHorizontal: 8,
  },
  sectionLabelInline: {
    marginBottom: 0,
    paddingHorizontal: 0,
  },
  chatItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: -10,
    marginBottom: 12,
  },
  chatItemText: { color: colors.gray300, fontSize: 14, fontWeight: '500', flex: 1 },
  dashboardItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    marginBottom: 12,
  },
  dashboardItemActive: {
    backgroundColor: colors.gray800,
  },
  newProjectCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.emerald600,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
  },
  newProjectCtaText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '600',
  },
  importProjectCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 8,
    borderRadius: 8,
  },
  importProjectCtaText: {
    color: colors.gray400,
    fontSize: 12,
  },
  projectCollapseLoading: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  projectHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
  },
  projectDot: {
    width: 16,
    height: 16,
    borderRadius: 4,
  },
  projectName: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: colors.gray300,
  },
  workflowTag: {
    fontSize: 10,
    fontWeight: '500',
    color: colors.purple400,
    letterSpacing: 0.4,
  },
  projectHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  unreadBadge: {
    backgroundColor: colors.rose400,
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  securityBadge: {
    backgroundColor: colors.red500,
  },
  skillBadge: {
    backgroundColor: colors.amber400,
    marginLeft: 'auto',
  },
  countBadge: {
    backgroundColor: colors.blue500,
    marginLeft: 'auto',
  },
  unreadBadgeText: {
    color: colors.white,
    fontSize: 9,
    fontWeight: '700',
  },
  projectDivider: {
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
    marginHorizontal: 8,
    marginVertical: 4,
  },
  agentItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 8,
    marginBottom: 2,
  },
  agentItemActive: {
    backgroundColor: colors.gray800,
  },
  agentDotContainer: {
    position: 'relative',
  },
  agentDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  miniDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  activityIndicator: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.emerald500,
    borderWidth: 1.5,
    borderColor: colors.gray900,
  },
  agentMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  leadTag: {
    fontSize: 12,
    color: colors.gray600,
  },
  reviewingBadge: {
    backgroundColor: 'rgba(245, 158, 11, 0.2)',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginRight: 4,
  },
  reviewingBadgeText: {
    color: colors.amber400,
    fontSize: 10,
    fontWeight: '600',
  },
  agentInfo: {
    flex: 1,
    minWidth: 0,
  },
  agentName: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.gray400,
  },
  agentNameActive: {
    color: colors.white,
  },
  agentLastMessage: {
    fontSize: 11,
    color: colors.gray600,
    marginTop: 2,
  },
  cronScheduleText: {
    fontSize: 11,
    color: colors.gray600,
    marginTop: 2,
  },
  collapseIcon: {
    color: colors.gray500,
    fontSize: 12,
    paddingHorizontal: 4,
  },
  sessionsContainer: {
    marginLeft: 24,
    marginBottom: 8,
  },
  sessionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderRadius: 6,
    marginBottom: 2,
  },
  sessionItemActive: {
    backgroundColor: colors.gray800,
  },
  sessionName: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    color: colors.gray500,
  },
  sessionNameActive: {
    color: colors.white,
  },
  sessionMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  sessionRenameInput: {
    flex: 1,
    minWidth: 0,
    color: colors.gray200,
    fontSize: 12,
    backgroundColor: colors.gray700,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  sessionDelete: {
    color: colors.gray600,
    fontSize: 12,
    paddingHorizontal: 4,
  },
  sessionActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  sessionBulk: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingRight: 4,
  },
  clearPushedText: {
    fontSize: 10,
    color: colors.gray600,
  },
  confirmBox: {
    marginHorizontal: 4,
    marginTop: 4,
    padding: 8,
    backgroundColor: colors.gray800,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
  },
  confirmText: {
    fontSize: 12,
    color: colors.gray300,
    marginBottom: 8,
  },
  confirmActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  confirmCancel: {
    fontSize: 12,
    color: colors.gray400,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  confirmDelete: {
    backgroundColor: colors.red600,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  confirmPushed: {
    backgroundColor: '#d97706',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  confirmConfirmText: {
    fontSize: 12,
    color: colors.white,
  },
  collapsedActionable: {
    marginLeft: 12,
    paddingLeft: 8,
    borderLeftWidth: 1,
    borderLeftColor: colors.gray800,
  },
  cronSection: {
    marginBottom: 12,
  },
  cronRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  cronName: {
    flex: 1,
  },
  cronScheduleInline: {
    fontSize: 12,
    color: colors.gray600,
  },
  newSessionButton: {
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  newSessionText: {
    fontSize: 12,
    color: colors.gray600,
  },
  archivedSection: {
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
  },
  archivedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  archivedHeaderText: {
    flex: 1,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.gray600,
  },
  archivedChevron: {
    color: colors.gray600,
    fontSize: 12,
  },
  archivedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  archivedName: {
    fontSize: 12,
    color: colors.gray500,
  },
  archivedPurge: {
    fontSize: 10,
    color: colors.gray600,
    marginTop: 1,
  },
  archivedPurgeUrgent: {
    color: '#fbbf24', // amber-400 — mirrors web sidebar's urgency signal
  },
  restoreButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.gray800,
    marginLeft: 8,
  },
  restoreButtonDisabled: {
    opacity: 0.4,
  },
  restoreButtonText: {
    fontSize: 11,
    color: colors.gray300,
  },
  bottomNav: {
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
    padding: 12,
    gap: 4,
  },
  navButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 8,
  },
  navButtonActive: {
    backgroundColor: colors.gray800,
  },
  navButtonIcon: {
    flexShrink: 0,
  },
  navButtonText: {
    fontSize: 14,
    color: colors.gray400,
  },
  versionBox: {
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  versionText: {
    fontSize: 12,
    color: colors.gray500,
  },
  versionHash: {
    fontSize: 10,
    color: colors.gray600,
    marginTop: 1,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  // Per-project "<project> Settings" submenu (mirrors the web sidebar).
  projectMenu: {
    marginLeft: 24,
    marginBottom: 6,
  },
  projectMenuToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
  },
  projectMenuChevron: {
    flexShrink: 0,
  },
  projectMenuGroupLabel: {
    flex: 1,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.gray500,
  },
  projectMenuItems: {
    marginLeft: 9,
    paddingLeft: 8,
    borderLeftWidth: 1,
    borderLeftColor: colors.gray800,
  },
  projectMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 6,
  },
  projectMenuItemIcon: {
    flexShrink: 0,
  },
  projectMenuItemText: {
    flex: 1,
    fontSize: 13,
    color: colors.gray400,
  },
});
