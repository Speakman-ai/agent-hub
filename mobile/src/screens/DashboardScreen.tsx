import React, { useState, useEffect, useCallback, useContext, useMemo, useRef } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, RefreshControl, Linking, Alert, } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { SidebarContext } from '../context/SidebarContext';
import { useApp } from '../context/AppContext';
import { getApiBaseUrl, getAuthHeaders } from '../utils/config';
import { getActiveOrg } from '../utils/orgs';
import { relativeTime } from '../utils/time';
import { colors } from '../theme/colors';
import SessionStateIcon from '../components/SessionStateIcon';
import HubIcon from '../components/HubIcon';
import { groupSessionsByState } from '@shared/utils/sessionState';
import { ALL_OWNERS, ownerKeyForUser, defaultOwnerFilter, buildOwnerOptions, filterSessionsByOwner, } from '@shared/utils/sessionOwnerFilter';
import { getAuthRecord } from '../utils/auth';
import { api } from '../utils/api';
import { createRequestGenerationState, beginRequest } from '@shared/utils/requestGeneration';
import { useVisibleIntervalRefresh } from '../hooks/useVisibleIntervalRefresh';
import { openPrDashboardStatusBadge } from '../utils/prFormatting';
import { hasCalendarScope } from '../utils/googleSurface';
import { activityLabel, filterActivity, countByType, ACTIVITY_TYPE_KEYS, sortSupportBySeverity, SUPPORT_SEVERITY_DOT, PR_PRIORITY_DOT, resolveActivityTarget, activityIsActionable, resolveOpenPrTarget, openPrIsActionable, } from '../utils/dashboard';
import { defaultCalendarRange, eventTimeLabel, localTimeZone, sortCalendarEvents } from '@shared/utils/calendarEvents';
import { buildCalendarTodoDraft } from '@shared/utils/captureTodo';
import { buildCalendarCardDraft, type CaptureCardDraft } from '@shared/utils/captureCard';
import CaptureToTicketModal from '../components/CaptureToTicketModal';
/** How often the dashboard silently re-polls while the app is foregrounded. */
const DASHBOARD_REFRESH_MS = 5000;
const ACTIVITY_DOT: Record<string, any> = {
    card_created: colors.emerald400,
    card_updated: colors.amber400,
    session_created: colors.blue400,
    escalation: colors.rose400,
    pr_created: colors.purple400,
};
export default function DashboardScreen() {
    const { openSidebar } = useContext(SidebarContext);
    const navigation = useNavigation<any>();
    const { setActiveAgentId, setActiveSessionId, projects } = useApp();
    const [data, setData] = useState<any>(null);
    const [error, setError] = useState<any>(null);
    const [loading, setLoading] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [supportTickets, setSupportTickets] = useState<any[]>([]);
    const [supportLoading, setSupportLoading] = useState(true);
    const [supportError, setSupportError] = useState<any>(null);
    const [calendarStatus, setCalendarStatus] = useState<any>(null);
    const [calendarEvents, setCalendarEvents] = useState<any[]>([]);
    const [calendarLoading, setCalendarLoading] = useState(true);
    const [calendarError, setCalendarError] = useState<any>(null);
    // Per-event capture state, mirroring CalendarScreen: the event key being
    // captured to todos, the key just captured (transient "Added" flag), and the
    // draft that seeds the create-ticket picker.
    const [capturingId, setCapturingId] = useState<string | null>(null);
    const [capturedId, setCapturedId] = useState<string | null>(null);
    const [ticketDraft, setTicketDraft] = useState<CaptureCardDraft | null>(null);
    const [activeTypes, setActiveTypes] = useState(() => new Set());
    const currentUser = getAuthRecord()?.user || null;
    const accountName = currentUser?.email || currentUser?.username || 'Account';
    const currentUserKey = ownerKeyForUser(currentUser);
    const currentUserName = (currentUser && (currentUser.email || currentUser.username)) || null;
    const [ownerFilter, setOwnerFilter] = useState(() => defaultOwnerFilter(currentUserKey));
    // Generation guards keyed on commit order (see
    // `@shared/utils/requestGeneration`): a result lands unless a strictly newer
    // request has already committed replacement data. A silent poll that fails
    // commits nothing, so it can't discard a slow foreground load / pull-to-
    // refresh that later succeeds.
    const mountedRef = useRef(true);
    const dashGenRef = useRef(createRequestGenerationState());
    const supportGenRef = useRef(createRequestGenerationState());
    const calendarGenRef = useRef(createRequestGenerationState());
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);
    const toggleActivityType = useCallback((key: any) => {
        setActiveTypes((prev: any) => {
            const next = new Set(prev);
            if (next.has(key))
                next.delete(key);
            else
                next.add(key);
            return next;
        });
    }, []);
    const clearActivityFilter = useCallback(() => {
        setActiveTypes(new Set());
    }, []);
    const findProject = useCallback((projectId: any) => projects?.find((p: any) => p.id === projectId), [projects]);
    const openSession = useCallback((agentId: any, sessionId: any) => {
        if (!sessionId)
            return;
        if (agentId)
            setActiveAgentId(agentId);
        setActiveSessionId(sessionId);
        navigation.navigate('Chat');
    }, [navigation, setActiveAgentId, setActiveSessionId]);
    const openProjectPulls = useCallback((projectId: any, prNumber: any) => {
        if (!projectId)
            return;
        navigation.navigate('PullRequests', {
            projectId,
            project: findProject(projectId),
            // When the row resolved to a specific native PR, open its detail
            // directly; PullRequestsScreen consumes `route.params.prNumber`.
            prNumber: prNumber ?? undefined,
        });
    }, [findProject, navigation]);
    const openProjectKanban = useCallback((projectId: any, cardId: any) => {
        if (!projectId)
            return;
        navigation.navigate('Kanban', {
            projectId,
            project: findProject(projectId),
            cardId: cardId || undefined,
        });
    }, [findProject, navigation]);
    const openProjectSupport = useCallback((projectId: any, ticketId: any) => {
        if (!projectId)
            return;
        navigation.navigate('CustomerSupport', {
            projectId,
            project: findProject(projectId),
            // Support rows are ticket-specific; CustomerSupportScreen consumes
            // `route.params.ticketId` to open that ticket's detail directly.
            ticketId: ticketId || undefined,
        });
    }, [findProject, navigation]);
    const followTarget = useCallback((target: any) => {
        if (!target)
            return;
        if (target.kind === 'session') {
            openSession(target.agentId, target.sessionId);
            return;
        }
        if (target.kind === 'pulls') {
            openProjectPulls(target.projectId, target.prNumber);
            return;
        }
        if (target.kind === 'kanban') {
            openProjectKanban(target.projectId, target.cardId);
            return;
        }
        if (target.kind === 'external' && target.url) {
            Linking.openURL(target.url).catch(() => { });
        }
    }, [openProjectKanban, openProjectPulls, openSession]);
    const openActivity = useCallback((item: any) => {
        followTarget(resolveActivityTarget(item));
    }, [followTarget]);
    const openPr = useCallback((pr: any) => {
        followTarget(resolveOpenPrTarget(pr));
    }, [followTarget]);
    const load = useCallback(async ({ asRefresh, silent }: any = {}) => {
        const req = beginRequest(dashGenRef.current, { silent });
        const org = getActiveOrg();
        // Identity of the org this `/orgs/active/dashboard` result belongs to.
        // The commit-order guard alone can't stop a slow response for a
        // *previous* active org from landing once the user switches orgs, so
        // each commit also confirms the active org is still the same — matching
        // the web `orgIdRef` check.
        const reqOrgId = org ? org.id : null;
        const orgStillCurrent = () => (getActiveOrg()?.id ?? null) === reqOrgId;
        if (!org) {
            if (!silent && mountedRef.current && req.canCommit()) {
                req.commit();
                setError('No active organization.');
            }
            return;
        }
        // Background polls refresh in place: no spinner, and a transient failure
        // keeps the last-good dashboard on screen instead of flashing an error.
        if (asRefresh)
            setRefreshing(true);
        else if (!silent)
            setLoading(true);
        if (!silent)
            setError(null);
        let committed = false;
        try {
            const base = getApiBaseUrl();
            const res = await fetch(`${base}/orgs/active/dashboard`, {
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() } as any,
            });
            if (!res.ok) {
                let detail = `HTTP ${res.status}`;
                try {
                    const body = await res.json();
                    detail = body.error || detail;
                }
                catch {
                    /* not json */
                }
                throw new Error(detail);
            }
            const json = await res.json();
            if (mountedRef.current && orgStillCurrent() && req.canCommit()) {
                req.commit();
                committed = true;
                setData(json);
                setError(null);
            }
        }
        catch (err: any) {
            // Only a foreground request surfaces an error; a silent failure
            // commits nothing, so it can't invalidate an older foreground result.
            if (!silent && mountedRef.current && orgStillCurrent() && req.canCommit()) {
                req.commit();
                committed = true;
                setError(err.message || String(err));
            }
        }
        finally {
            // Clear the spinners once we've committed, or for the foreground
            // request that still owns them — so a superseding poll can't strand
            // a slow foreground load / pull-to-refresh.
            if (mountedRef.current && (committed || req.ownsLoading())) {
                setLoading(false);
                setRefreshing(false);
            }
        }
    }, []);
    const loadSupport = useCallback(async ({ silent }: any = {}) => {
        const req = beginRequest(supportGenRef.current, { silent });
        // Mirror the web path: only clear the error on a non-silent start or on
        // success. Clearing it unconditionally would make a foreground support
        // error blink away every 5s even when the background retry also fails.
        if (!silent) {
            setSupportLoading(true);
            setSupportError(null);
        }
        let committed = false;
        try {
            const payload = await api.getAllSupportTickets({ status: 'new', unread: true });
            if (mountedRef.current && req.canCommit()) {
                req.commit();
                committed = true;
                setSupportTickets(Array.isArray(payload?.tickets) ? payload.tickets : []);
                setSupportError(null);
            }
        }
        catch (err: any) {
            // Keep the last triage list on a transient background-poll failure; a
            // silent failure commits nothing so it can't drop an older result.
            if (!silent && mountedRef.current && req.canCommit()) {
                req.commit();
                committed = true;
                setSupportError(err.message || String(err));
                setSupportTickets([]);
            }
        }
        finally {
            if (mountedRef.current && (committed || req.ownsLoading()))
                setSupportLoading(false);
        }
    }, []);
    const loadCalendar = useCallback(async ({ silent }: any = {}) => {
        const req = beginRequest(calendarGenRef.current, { silent });
        if (!silent) {
            setCalendarLoading(true);
            setCalendarError(null);
        }
        let committed = false;
        try {
            const nextStatus = await api.getGoogleStatus();
            let nextEvents: any[] = [];
            if (nextStatus?.connected && hasCalendarScope(nextStatus)) {
                const body = await api.listGoogleCalendarEvents({
                    ...defaultCalendarRange(),
                    timeZone: localTimeZone(),
                    maxResults: 20,
                });
                nextEvents = sortCalendarEvents(Array.isArray(body?.events) ? body.events : []);
            }
            if (mountedRef.current && req.canCommit()) {
                req.commit();
                committed = true;
                setCalendarStatus(nextStatus);
                setCalendarEvents(nextEvents);
                setCalendarError(null);
            }
        }
        catch (err: any) {
            if (!silent && mountedRef.current && req.canCommit()) {
                req.commit();
                committed = true;
                setCalendarError(err.message || String(err));
                setCalendarEvents([]);
            }
        }
        finally {
            if (mountedRef.current && (committed || req.ownsLoading()))
                setCalendarLoading(false);
        }
    }, []);
    useEffect(() => {
        load();
    }, [load]);
    useEffect(() => {
        loadSupport();
    }, [loadSupport]);
    useEffect(() => {
        loadCalendar();
    }, [loadCalendar]);
    // `key` is the row's stable key (folds in the list index) so two same-titled
    // events without an `id` don't share capture/captured state.
    const captureEvent = useCallback(async (event: any, key: string) => {
        setCapturingId(key);
        try {
            await api.createTodo(buildCalendarTodoDraft(event));
            if (!mountedRef.current)
                return;
            setCapturedId(key);
            setTimeout(() => {
                if (mountedRef.current)
                    setCapturedId((cur) => (cur === key ? null : cur));
            }, 2000);
        }
        catch (err: any) {
            Alert.alert('Todos', err.message || 'Failed to add to todos');
        }
        finally {
            if (mountedRef.current)
                setCapturingId((cur) => (cur === key ? null : cur));
        }
    }, []);
    // Return the combined promise so the hook's in-flight guard waits for both
    // requests — a slow poll then skips the next 5s tick instead of stacking.
    useVisibleIntervalRefresh(() => Promise.all([
        load({ silent: true }),
        loadSupport({ silent: true }),
        loadCalendar({ silent: true }),
    ]), DASHBOARD_REFRESH_MS);
    const sortedSupport = useMemo<any>(() => sortSupportBySeverity(supportTickets), [supportTickets]);
    const allActivity = data?.recentActivity || [];
    const activity = filterActivity(allActivity, activeTypes);
    const activityCounts = countByType(allActivity);
    const openPrs = data?.openPRs || [];
    return (<SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={openSidebar} style={styles.menuButton}>
          <Text style={styles.menuIcon}>{'\u2630'}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Dashboard</Text>
        <TouchableOpacity onPress={() => navigation.navigate('Settings', { tab: 'account' })} style={styles.accountButton} accessibilityLabel="Account settings">
          <Text style={styles.accountLabel} numberOfLines={1}>
            {accountName}
          </Text>
        </TouchableOpacity>
      </View>
      {data?.orgName ? (<Text style={styles.orgSubtitle} numberOfLines={1}>
          {data.orgName}
        </Text>) : null}

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => {
                load({ asRefresh: true });
                loadSupport();
                loadCalendar();
            }} tintColor={colors.gray400}/>}>
        {error ? (<View style={styles.errorBox}>
            <Text style={styles.errorText}>Failed to load dashboard: {error}</Text>
          </View>) : null}

        {loading && !data ? (<View style={styles.centered}>
            <ActivityIndicator color={colors.blue400}/>
          </View>) : null}

        {data ? (<>
            <SectionHeader title="This week"/>
            <View style={styles.card} testID="dashboard-calendar">
              {calendarError ? (<Text style={styles.errorInline}>
                  Failed to load Calendar: {calendarError}
                </Text>) : calendarLoading ? (<Text style={styles.muted}>Loading Calendar...</Text>) : !calendarStatus?.connected ? (<DashboardCalendarEmpty title={calendarStatus?.serverConfigured === false ? 'Google is not configured' : 'Connect Google to show Calendar'} body={calendarStatus?.serverConfigured === false
                    ? 'An Admin needs to add the Google OAuth app before Calendar can connect.'
                    : 'Link your Google account in Account settings to show this week on the dashboard.'} action="Account settings" onPress={() => navigation.navigate('Settings', { tab: 'account' })}/>) : !hasCalendarScope(calendarStatus) ? (<DashboardCalendarEmpty title="Enable Calendar access" body={`Connected as ${calendarStatus?.email || 'Google account'}, but Calendar access has not been granted yet.`} action="Open Calendar" onPress={() => navigation.navigate('Calendar')}/>) : calendarEvents.length === 0 ? (<DashboardCalendarEmpty title="No events this week" body="Your primary Google Calendar has no events in the next seven days." action="Open Calendar" onPress={() => navigation.navigate('Calendar')}/>) : (calendarEvents.slice(0, 6).map((event: any, index: number) => {
                    const rowKey = event.id || `${event.summary}-${index}`;
                    return (<DashboardCalendarRow key={rowKey} rowKey={rowKey} event={event} capturingId={capturingId} capturedId={capturedId} onOpen={() => navigation.navigate('Calendar')} onCapture={captureEvent} onTicket={(e: any) => setTicketDraft(buildCalendarCardDraft(e))}/>);
                  }))}
            </View>
            {ticketDraft ? (<CaptureToTicketModal draft={ticketDraft} onClose={() => setTicketDraft(null)}/>) : null}

            {(() => {
                const allSessions = data.activeSessions || [];
                const ownerOptions = buildOwnerOptions(allSessions, {
                    currentUserKey,
                    currentUserName,
                });
                const selectedOwner = ownerOptions.some((o: any) => o.key === ownerFilter)
                    ? ownerFilter
                    : ALL_OWNERS;
                const sessions = filterSessionsByOwner(allSessions, selectedOwner);
                const filteredByOwner = selectedOwner !== ALL_OWNERS;
                return (<>
                  <SectionHeader title="Active sessions" subtitle={`${sessions.length} in flight`}/>
                  {allSessions.length > 0 && (<ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.ownerFilterRow} contentContainerStyle={styles.ownerFilterContent} testID="active-sessions-owner-filter">
                      {ownerOptions.map((o: any) => {
                            const active = o.key === selectedOwner;
                            return (<TouchableOpacity key={o.key} onPress={() => setOwnerFilter(o.key)} testID={`active-sessions-owner-filter-${o.key}`} accessibilityState={{ selected: active }} style={[styles.ownerChip, active && styles.ownerChipActive]}>
                            <Text style={[styles.ownerChipText, active && styles.ownerChipTextActive]}>
                              {o.label} ({o.count})
                            </Text>
                          </TouchableOpacity>);
                        })}
                    </ScrollView>)}
                  {sessions.length === 0 ? (<View style={styles.card} testID="active-sessions">
                      <Text style={styles.muted}>
                        {filteredByOwner
                            ? 'No active sessions for the selected user.'
                            : 'No active sessions. Everything has merged or there is no work in flight.'}
                      </Text>
                    </View>) : (<View testID="active-sessions">
                      {groupSessionsByState(sessions as any).map((group: any) => (<View key={group.state} testID={`active-sessions-group-${group.state}`}>
                          <View style={styles.sessionGroupHeader}>
                            <Text style={styles.sessionGroupLabel}>{group.meta.label}</Text>
                            <Text style={styles.sessionGroupCount}>{group.sessions.length}</Text>
                          </View>
                          <View style={styles.card}>
                            {group.sessions.map((s: any) => {
                                const actionable = Boolean(s.agentId && s.sessionId);
                                const Row = actionable ? TouchableOpacity : View;
                                return (<Row key={s.sessionId} style={styles.activityRow} {...(actionable
                                    ? { onPress: () => openSession(s.agentId, s.sessionId) }
                                    : {})}>
                                  <SessionStateIcon state={s.state} size={16} style={styles.activitySessionIcon}/>
                                  <View style={{ flex: 1, minWidth: 0 }}>
                                    <Text style={styles.activityTitle} numberOfLines={1}>
                                      {s.sessionName || 'Untitled session'}
                                    </Text>
                                    <Text style={styles.activityMeta} numberOfLines={1}>
                                      {[
                                        s.agentName || s.agentId,
                                        s.ownerName ? s.ownerName : null,
                                        s.engine,
                                        s.model,
                                        s.prompt,
                                    ]
                                        .filter(Boolean)
                                        .join(' · ')}
                                    </Text>
                                  </View>
                                  <View style={{ alignItems: 'flex-end' }}>
                                    <Text style={styles.activityTime}>
                                      {s.startedAt || s.lastActivityAt
                                        ? relativeTime(s.startedAt || s.lastActivityAt)
                                        : ''}
                                    </Text>
                                  </View>
                                </Row>);
                            })}
                          </View>
                        </View>))}
                    </View>)}
                </>);
            })()}

            <SectionHeader title="Open PRs" subtitle={`${openPrs.length} open PR${openPrs.length === 1 ? '' : 's'}`}/>
            <View style={styles.card} testID="open-prs">
              {openPrs.length === 0 ? (<Text style={styles.muted}>No open pull requests.</Text>) : (openPrs.map((pr: any) => {
                const actionable = openPrIsActionable(pr);
                const statusBadge = openPrDashboardStatusBadge(pr);
                const Row = actionable ? TouchableOpacity : View;
                return (<Row key={pr.key || pr.cardId || pr.prUrl} style={styles.activityRow} {...(actionable ? { onPress: () => openPr(pr) } : {})}>
                      <HubIcon name="GitPullRequest" size={16} color={colors.purple400} style={styles.prIcon}/>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <View style={styles.prTitleRow}>
                          {statusBadge ? (<View style={[styles.statusBadge, { backgroundColor: statusBadge.bg }]} testID="open-pr-status-badge">
                              <Text style={[styles.statusBadgeText, { color: statusBadge.color }]}>
                                {statusBadge.label}
                              </Text>
                            </View>) : null}
                          <Text style={styles.activityTitle} numberOfLines={1}>
                            {pr.title || pr.cardTitle}
                          </Text>
                        </View>
                        <Text style={styles.activityMeta} numberOfLines={1}>
                          {pr.projectName || pr.projectId}
                          {pr.authorAgent ? ` · ${pr.authorAgent}` : ''}
                        </Text>
                      </View>
                      {pr.priority && PR_PRIORITY_DOT[pr.priority] ? (<View style={[
                            styles.priorityDot,
                            { backgroundColor: PR_PRIORITY_DOT[pr.priority] },
                        ]}/>) : null}
                      <Text style={styles.activityTime}>
                        {pr.updatedAt ? relativeTime(pr.updatedAt) : ''}
                      </Text>
                    </Row>);
            }))}
            </View>

            <SectionHeader title="New support issues"/>
            <View style={styles.card} testID="support-issues">
              {supportError ? (<Text style={styles.errorInline}>
                  Failed to load support issues: {supportError}
                </Text>) : supportLoading ? (<Text style={styles.muted}>Loading support issues…</Text>) : sortedSupport.length === 0 ? (<Text style={styles.muted}>No new support issues. Everything is triaged.</Text>) : (sortedSupport.map((ticket: any) => {
                const actionable = Boolean(ticket.project_id);
                const title = ticket.subject?.trim() || ticket.body?.trim() || '(no subject)';
                const dot = SUPPORT_SEVERITY_DOT[ticket.severity] || SUPPORT_SEVERITY_DOT.low;
                const Row = actionable ? TouchableOpacity : View;
                return (<Row key={ticket.id} style={styles.activityRow} testID="support-issue-row" {...(actionable
                    ? {
                        onPress: () => openProjectSupport(String(ticket.project_id), ticket.id),
                    }
                    : {})}>
                      <View style={[styles.priorityDot, { backgroundColor: dot }]}/>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.activityTitle} numberOfLines={1}>
                          {title}
                        </Text>
                        <Text style={styles.activityMeta} numberOfLines={1}>
                          {ticket.project_name || ticket.project_id}
                          {ticket.status ? ` · ${ticket.status}` : ''}
                        </Text>
                      </View>
                      <Text style={styles.activityTime}>
                        {ticket.created_at ? relativeTime(ticket.created_at) : ''}
                      </Text>
                    </Row>);
            }))}
            </View>

            <SectionHeader title="Recent activity"/>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow} testID="recent-activity-filter">
              <TouchableOpacity onPress={clearActivityFilter} style={[styles.filterChip, activeTypes.size === 0 && styles.filterChipActive]} accessibilityRole="button" accessibilityState={{ selected: activeTypes.size === 0 }} testID="recent-activity-filter-all">
                <Text style={[
                styles.filterChipText,
                activeTypes.size === 0 && styles.filterChipTextActive,
            ]}>
                  All
                </Text>
              </TouchableOpacity>
              {ACTIVITY_TYPE_KEYS.map((key: any) => {
                const isActive = activeTypes.has(key);
                const count = activityCounts[key] || 0;
                return (<TouchableOpacity key={key} onPress={() => toggleActivityType(key)} style={[styles.filterChip, isActive && styles.filterChipActive]} accessibilityRole="button" accessibilityState={{ selected: isActive }} testID={`recent-activity-filter-${key}`}>
                    <View style={[
                        styles.activityDot,
                        { backgroundColor: ACTIVITY_DOT[key] || colors.gray500 },
                    ]}/>
                    <Text style={[styles.filterChipText, isActive && styles.filterChipTextActive]}>
                      {activityLabel(key)}
                    </Text>
                    <Text style={styles.filterChipCount}>{count}</Text>
                  </TouchableOpacity>);
            })}
            </ScrollView>
            <View style={styles.card} testID="recent-activity">
              {activity.length === 0 ? (<Text style={styles.muted}>
                  {allActivity.length === 0
                    ? 'No recent activity yet.'
                    : 'No activity matches the selected filters.'}
                </Text>) : (activity.map((item: any) => {
                const actionable = activityIsActionable(item);
                const Row = actionable ? TouchableOpacity : View;
                return (<Row key={`${item.type}-${item.id}`} style={styles.activityRow} {...(actionable ? { onPress: () => openActivity(item) } : {})}>
                      <View style={[
                        styles.activityDot,
                        { backgroundColor: ACTIVITY_DOT[item.type] || colors.gray500 },
                    ]}/>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.activityTitle} numberOfLines={1}>
                          {item.title || '(untitled)'}
                        </Text>
                        <Text style={styles.activityMeta}>{activityLabel(item.type)}</Text>
                      </View>
                      <Text style={styles.activityTime}>{relativeTime(item.timestamp)}</Text>
                    </Row>);
            }))}
            </View>
          </>) : null}
      </ScrollView>
    </SafeAreaView>);
}
function SectionHeader({ title, subtitle }: any) {
    return (<View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {subtitle ? <Text style={styles.sectionSubtitle}>{subtitle}</Text> : null}
    </View>);
}
function DashboardCalendarEmpty({ title, body, action, onPress }: any) {
    return (<View style={styles.calendarEmpty}>
      <Text style={styles.calendarEmptyTitle}>{title}</Text>
      <Text style={styles.calendarEmptyBody}>{body}</Text>
      {action ? (<TouchableOpacity onPress={onPress} style={styles.calendarAction}>
          <Text style={styles.calendarActionText}>{action}</Text>
        </TouchableOpacity>) : null}
    </View>);
}
// A single "This week" event row with the same Todo / Ticket capture
// affordances as the full Calendar screen (spec CAPTURE-PROVENANCE parity).
export function DashboardCalendarRow({ event, rowKey, capturingId, capturedId, onOpen, onCapture, onTicket }: any) {
    // Falls back to the id/summary composite for standalone (test) renders that
    // don't thread a rowKey; the screen always passes an index-folded key.
    const key = rowKey ?? (event.id || event.summary || '');
    const isCaptured = capturedId === key;
    return (<View>
      <TouchableOpacity style={styles.activityRow} onPress={onOpen}>
        <HubIcon name="CalendarDays" size={16} color={colors.blue400} style={styles.prIcon}/>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.activityTitle} numberOfLines={1}>
            {event.summary || '(no title)'}
          </Text>
          <Text style={styles.activityMeta} numberOfLines={1}>
            {eventTimeLabel(event)}
            {event.location ? ` · ${event.location}` : ''}
          </Text>
        </View>
      </TouchableOpacity>
      <View style={styles.calendarCaptureRow}>
        <TouchableOpacity onPress={() => onCapture(event, key)} disabled={capturingId === key} style={styles.calendarCaptureButton} accessibilityLabel="Add to todos">
          <Text style={styles.calendarCaptureButtonText}>
            {capturingId === key ? 'Adding…' : isCaptured ? '✓ Added to todos' : '+ Add to todos'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => onTicket(event)} style={styles.calendarCaptureButton} accessibilityLabel="Create ticket">
          <Text style={styles.calendarCaptureButtonText}>+ Ticket</Text>
        </TouchableOpacity>
      </View>
    </View>);
}
const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.gray950,
    },
    topBar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: colors.gray800,
        gap: 8,
    },
    menuButton: {
        padding: 8,
    },
    menuIcon: {
        color: colors.gray300,
        fontSize: 22,
    },
    title: {
        color: colors.white,
        fontSize: 18,
        fontWeight: '600',
        flex: 1,
    },
    accountButton: {
        maxWidth: 140,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: colors.gray900,
        borderWidth: 1,
        borderColor: colors.gray800,
    },
    accountLabel: {
        color: colors.gray300,
        fontSize: 12,
        fontWeight: '500',
    },
    orgSubtitle: {
        color: colors.gray500,
        fontSize: 12,
        paddingHorizontal: 16,
        paddingTop: 4,
        paddingBottom: 2,
    },
    scroll: {
        flex: 1,
    },
    scrollContent: {
        padding: 12,
        paddingBottom: 24,
    },
    centered: {
        paddingVertical: 32,
        alignItems: 'center',
    },
    errorBox: {
        backgroundColor: 'rgba(127, 29, 29, 0.5)',
        borderColor: colors.red600,
        borderWidth: 1,
        borderRadius: 8,
        padding: 12,
        marginBottom: 12,
    },
    errorText: {
        color: colors.red400,
        fontSize: 13,
    },
    errorInline: {
        color: colors.red400,
        fontSize: 12,
    },
    sectionHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        marginTop: 8,
        marginBottom: 8,
    },
    sectionTitle: {
        color: colors.gray300,
        fontSize: 12,
        textTransform: 'uppercase',
        letterSpacing: 1,
        fontWeight: '600',
    },
    sectionSubtitle: {
        color: colors.gray500,
        fontSize: 11,
    },
    card: {
        backgroundColor: colors.gray900,
        borderColor: colors.gray800,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        marginBottom: 12,
    },
    muted: {
        color: colors.gray600,
        fontSize: 12,
    },
    calendarEmpty: {
        alignItems: 'center',
        paddingVertical: 12,
        gap: 6,
    },
    calendarEmptyTitle: {
        color: colors.gray300,
        fontSize: 13,
        fontWeight: '600',
        textAlign: 'center',
    },
    calendarEmptyBody: {
        color: colors.gray500,
        fontSize: 12,
        textAlign: 'center',
        lineHeight: 17,
    },
    calendarAction: {
        borderColor: colors.gray700,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 6,
        marginTop: 4,
    },
    calendarActionText: {
        color: colors.gray300,
        fontSize: 12,
        fontWeight: '500',
    },
    filterRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingBottom: 8,
    },
    filterChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: colors.gray800,
        backgroundColor: colors.gray900,
    },
    filterChipActive: {
        borderColor: colors.blue400,
        backgroundColor: 'rgba(59, 130, 246, 0.16)',
    },
    filterChipText: {
        color: colors.gray400,
        fontSize: 11,
    },
    filterChipTextActive: {
        color: colors.blue400,
    },
    filterChipCount: {
        color: colors.gray500,
        fontSize: 10,
    },
    activityRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.gray800,
    },
    activityDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    priorityDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    activitySessionIcon: {
        width: 16,
        textAlign: 'center',
    },
    ownerFilterRow: {
        marginBottom: 10,
        flexGrow: 0,
    },
    ownerFilterContent: {
        gap: 8,
        paddingRight: 12,
    },
    ownerChip: {
        borderColor: colors.gray800,
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 12,
        paddingVertical: 6,
        backgroundColor: colors.gray900,
    },
    ownerChipActive: {
        borderColor: colors.blue500,
        backgroundColor: colors.blue900_40,
    },
    ownerChipText: {
        color: colors.gray400,
        fontSize: 12,
    },
    ownerChipTextActive: {
        color: colors.white,
        fontWeight: '600',
    },
    sessionGroupHeader: {
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        marginBottom: 6,
        paddingHorizontal: 2,
    },
    sessionGroupLabel: {
        color: colors.gray400,
        fontSize: 11,
        fontWeight: '600',
        textTransform: 'uppercase',
        letterSpacing: 0.6,
    },
    sessionGroupCount: {
        color: colors.gray600,
        fontSize: 11,
    },
    activityTitle: {
        color: colors.white,
        fontSize: 13,
        flexShrink: 1,
    },
    activityMeta: {
        color: colors.gray500,
        fontSize: 10,
    },
    activityTime: {
        color: colors.gray500,
        fontSize: 10,
    },
    prIcon: {
        width: 20,
        flexShrink: 0,
    },
    calendarCaptureRow: {
        flexDirection: 'row',
        gap: 8,
        paddingLeft: 28,
        paddingBottom: 10,
        marginTop: -4,
    },
    calendarCaptureButton: {
        alignSelf: 'flex-start',
        borderWidth: 1,
        borderColor: colors.gray700,
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
    },
    calendarCaptureButtonText: {
        color: colors.blue300,
        fontSize: 12,
        fontWeight: '600',
    },
    prTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
    },
    statusBadge: {
        borderRadius: 999,
        paddingHorizontal: 6,
        paddingVertical: 2,
    },
    statusBadgeText: {
        fontSize: 9,
        fontWeight: '600',
    },
});
