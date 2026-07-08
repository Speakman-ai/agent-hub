import React, { useCallback, useContext, useEffect, useState } from 'react';
import {
    View,
    Text,
    ScrollView,
    TouchableOpacity,
    StyleSheet,
    ActivityIndicator,
    RefreshControl,
    Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SidebarContext } from '../context/SidebarContext';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import HubIcon from '../components/HubIcon';
import { dueLabel, dueState, todoDoDate } from '../utils/todos';
import { calendarPaneState, mailPaneState, type GooglePaneState } from '../utils/dashboardPanes';

/**
 * Personal Dashboard home — the mobile 1:1 peer of the web `PersonalDashboard`
 * (spec NAV-PLACEMENT). The User Module's global (non-project) landing page:
 * four panes over ONE per-user aggregation call (`GET /api/me/dashboard`, spec
 * AGGREGATION) — My Work (assigned cards across every visible board), Todos
 * (cross-project capture list), Calendar, and Gmail. The Google panes render
 * from the aggregation payload and fall back to a connect-Google affordance
 * when the account isn't linked; Todos and My Work never depend on Google.
 */

type CardPriority = 'urgent' | 'high' | 'medium' | 'low';

const PRIORITY_BADGE: Record<CardPriority, { bg: string; text: string; border: string }> = {
    urgent: { bg: colors.red900_50, text: colors.red400, border: colors.red600 },
    high: { bg: colors.amber900_40, text: colors.amber400, border: colors.amber400 },
    medium: { bg: colors.gray800, text: colors.gray400, border: colors.gray700 },
    low: { bg: colors.gray800, text: colors.gray500, border: colors.gray700 },
};

const DUE_BADGE_STYLE: Record<string, { bg: string; text: string; border: string }> = {
    overdue: { bg: colors.red900_50, text: colors.red400, border: colors.red600 },
    today: { bg: colors.amber900_40, text: colors.amber400, border: colors.amber400 },
    tomorrow: { bg: colors.blue900_40, text: colors.blue300, border: colors.blue500 },
    upcoming: { bg: colors.gray800, text: colors.gray400, border: colors.gray700 },
};

function localDateString(now = new Date()): string {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function localTimeZone(): string | undefined {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    } catch {
        return undefined;
    }
}

function formatEventTime(ev: any): string {
    if (ev.allDay) return 'All day';
    if (!ev.start) return '';
    const d = new Date(ev.start);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function Pane({
    title,
    icon,
    count,
    actionLabel,
    onAction,
    children,
}: {
    title: string;
    icon: string;
    count?: number;
    actionLabel?: string;
    onAction?: () => void;
    children: React.ReactNode;
}) {
    return (
        <View style={styles.pane}>
            <View style={styles.paneHeader}>
                <HubIcon name={icon} size={15} color={colors.gray400} />
                <Text style={styles.paneTitle} numberOfLines={1}>
                    {title}
                </Text>
                {typeof count === 'number' ? <Text style={styles.paneCount}>{count}</Text> : null}
                {actionLabel && onAction ? (
                    <TouchableOpacity onPress={onAction} style={styles.paneAction}>
                        <Text style={styles.paneActionText}>{actionLabel}</Text>
                        <HubIcon name="ChevronRight" size={12} color={colors.gray500} />
                    </TouchableOpacity>
                ) : null}
            </View>
            <View style={styles.paneBody}>{children}</View>
        </View>
    );
}

export function EmptyState({ text }: { text: string }) {
    return <Text style={styles.emptyText}>{text}</Text>;
}

export function GoogleGate({
    state,
    surface,
    onConnect,
    onOpenSurface,
}: {
    state: GooglePaneState;
    surface: 'Calendar' | 'Gmail';
    onConnect: () => void;
    onOpenSurface: () => void;
}) {
    if (state === 'not-configured') {
        return (
            <EmptyState
                text={`Google Workspace isn't configured on this server, so ${surface} is unavailable.`}
            />
        );
    }
    const label =
        state === 'reconnect'
            ? 'Reconnect Google'
            : state === 'scope-required'
              ? `Enable ${surface}`
              : 'Connect Google';
    const blurb =
        state === 'reconnect'
            ? `Your Google connection needs to be refreshed to show ${surface}.`
            : state === 'scope-required'
              ? `Grant ${surface} access to see it here.`
              : `Connect your Google account to see ${surface} here.`;
    // A missing scope is granted inside the full surface screen (incremental
    // consent); connect/reconnect happen in Settings -> Account.
    const onPress = state === 'scope-required' ? onOpenSurface : onConnect;
    return (
        <View style={styles.gate}>
            <Text style={styles.gateBlurb}>{blurb}</Text>
            <TouchableOpacity style={styles.gateButton} onPress={onPress}>
                <Text style={styles.gateButtonText}>{label}</Text>
            </TouchableOpacity>
        </View>
    );
}

export function WorkCardRow({ card, onOpen }: { card: any; onOpen: () => void }) {
    const badge = PRIORITY_BADGE[(card.priority as CardPriority) || 'medium'] || PRIORITY_BADGE.medium;
    return (
        <TouchableOpacity style={styles.workRow} onPress={onOpen}>
            <View style={styles.workRowTop}>
                <View
                    style={[
                        styles.priorityBadge,
                        { backgroundColor: badge.bg, borderColor: badge.border },
                    ]}
                >
                    <Text style={[styles.priorityText, { color: badge.text }]}>{card.priority}</Text>
                </View>
                <Text style={styles.workTitle} numberOfLines={1}>
                    {card.title}
                </Text>
                {card.prUrl ? (
                    <HubIcon name="GitPullRequest" size={12} color={colors.gray500} />
                ) : null}
            </View>
            <View style={styles.workRowBottom}>
                <Text style={styles.workMeta} numberOfLines={1}>
                    {card.projectName}
                </Text>
                <Text style={styles.workMetaDot}>·</Text>
                <Text style={styles.workMeta} numberOfLines={1}>
                    {card.columnName}
                </Text>
            </View>
        </TouchableOpacity>
    );
}

export function TodoRow({ todo }: { todo: any }) {
    const doDate = todoDoDate(todo);
    const state = dueState(doDate);
    const badge = DUE_BADGE_STYLE[state] || DUE_BADGE_STYLE.upcoming;
    return (
        <View style={styles.todoRow}>
            <HubIcon name="Circle" size={12} color={colors.gray600} />
            <Text style={styles.todoTitle} numberOfLines={1}>
                {todo.title}
            </Text>
            {doDate ? (
                <View
                    style={[styles.dueBadge, { backgroundColor: badge.bg, borderColor: badge.border }]}
                >
                    <Text style={[styles.dueBadgeText, { color: badge.text }]}>
                        {dueLabel(doDate)}
                    </Text>
                </View>
            ) : null}
        </View>
    );
}

export function CalendarRow({ ev }: { ev: any }) {
    const time = formatEventTime(ev);
    return (
        <View style={styles.calRow}>
            <Text style={styles.calTime}>{time}</Text>
            <Text style={styles.calSummary} numberOfLines={1}>
                {ev.summary || '(no title)'}
            </Text>
            {ev.hangoutLink ? (
                <TouchableOpacity onPress={() => Linking.openURL(ev.hangoutLink)}>
                    <Text style={styles.calJoin}>Join</Text>
                </TouchableOpacity>
            ) : null}
        </View>
    );
}

export function MailSummary({
    unread,
    starred,
    important,
    onOpen,
}: {
    unread: number;
    starred: number;
    important: number;
    onOpen: () => void;
}) {
    const stats = [
        { label: 'Unread', value: unread },
        { label: 'Starred', value: starred },
        { label: 'Important', value: important },
    ];
    return (
        <View style={styles.mailGrid}>
            {stats.map((s) => (
                <TouchableOpacity key={s.label} style={styles.mailStat} onPress={onOpen}>
                    <Text style={styles.mailValue}>{s.value}</Text>
                    <Text style={styles.mailLabel}>{s.label}</Text>
                </TouchableOpacity>
            ))}
        </View>
    );
}

export default function DashboardHomeScreen({ navigation }: any) {
    const sidebar = useContext(SidebarContext);
    const { projects, lastUserTodoEvent } = useApp();
    const [data, setData] = useState<any | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (fresh: boolean) => {
        if (fresh) setRefreshing(true);
        setError(null);
        try {
            const next = await api.getMeDashboard({
                fresh,
                date: localDateString(),
                tz: localTimeZone(),
            });
            setData(next);
        } catch (err: any) {
            setError(err?.message || 'Failed to load dashboard');
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, []);

    useEffect(() => {
        load(false);
    }, [load]);

    // A todo changed elsewhere (promote path, another device) broadcasts a
    // `user_todo_update` WS event; AppContext surfaces it as `lastUserTodoEvent`.
    // Refetch silently so the Todos/My Work panes stay live. Skip the initial
    // null so we don't double-fetch on mount.
    useEffect(() => {
        if (!lastUserTodoEvent) return;
        load(true);
    }, [lastUserTodoEvent, load]);

    const openKanban = useCallback(
        (projectId: string) => {
            const project = (projects || []).find((p: any) => p.id === projectId);
            navigation.navigate('Kanban', { projectId, project });
        },
        [projects, navigation],
    );

    const onConnectGoogle = useCallback(
        () => navigation.navigate('Settings', { tab: 'account' }),
        [navigation],
    );

    const work = data?.work;
    const todos = data?.todos?.open ?? [];
    const google = data?.google;
    const calState = calendarPaneState(google);
    const mailState = mailPaneState(google);
    const openCards = (work?.cards ?? []).filter((c: any) => !c.isDone);

    return (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <View style={styles.topBar}>
                <TouchableOpacity onPress={sidebar?.toggleSidebar} style={styles.menuButton}>
                    <Text style={styles.menuIcon}>{'☰'}</Text>
                </TouchableOpacity>
                <HubIcon name="LayoutGrid" size={20} color={colors.blue400} style={styles.titleIcon} />
                <View style={{ flex: 1 }}>
                    <Text style={styles.title}>Home</Text>
                    <Text style={styles.subtitle}>Your work across every project</Text>
                </View>
                <TouchableOpacity
                    onPress={() => load(true)}
                    disabled={refreshing}
                    style={styles.refreshButton}
                    accessibilityLabel="Refresh dashboard"
                >
                    {refreshing ? (
                        <ActivityIndicator size="small" color={colors.gray300} />
                    ) : (
                        <Text style={styles.refreshText}>Refresh</Text>
                    )}
                </TouchableOpacity>
            </View>

            {loading && !data ? (
                <View style={styles.centered}>
                    <Text style={styles.muted}>Loading your dashboard…</Text>
                </View>
            ) : error && !data ? (
                <View style={styles.centered}>
                    <Text style={styles.errorText}>{error}</Text>
                    <TouchableOpacity style={styles.retryButton} onPress={() => load(true)}>
                        <Text style={styles.retryText}>Retry</Text>
                    </TouchableOpacity>
                </View>
            ) : (
                <ScrollView
                    style={styles.scroll}
                    contentContainerStyle={styles.scrollContent}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={() => load(true)}
                            tintColor={colors.gray400}
                        />
                    }
                >
                    {/* My Work — assigned cards across every visible project */}
                    <Pane title="My Work" icon="LayoutGrid" count={work?.counts?.open}>
                        {openCards.length === 0 ? (
                            <EmptyState text="No open cards assigned to you." />
                        ) : (
                            openCards.map((card: any) => (
                                <WorkCardRow
                                    key={card.id}
                                    card={card}
                                    onOpen={() => openKanban(card.projectId)}
                                />
                            ))
                        )}
                    </Pane>

                    {/* Todos — cross-project personal capture list */}
                    <Pane
                        title="Todos"
                        icon="ListTodo"
                        count={data?.todos?.openCount}
                        actionLabel="Open"
                        onAction={() => navigation.navigate('Todos')}
                    >
                        {todos.length === 0 ? (
                            <EmptyState text="No open todos. Nice." />
                        ) : (
                            todos.map((todo: any) => <TodoRow key={todo.id} todo={todo} />)
                        )}
                    </Pane>

                    {/* Calendar — Google surface, gated */}
                    <Pane
                        title="Calendar"
                        icon="CalendarDays"
                        count={calState === 'ready' ? (google?.calendar?.events?.length ?? 0) : undefined}
                        actionLabel="Open"
                        onAction={() => navigation.navigate('Calendar')}
                    >
                        {calState !== 'ready' ? (
                            <GoogleGate
                                state={calState}
                                surface="Calendar"
                                onConnect={onConnectGoogle}
                                onOpenSurface={() => navigation.navigate('Calendar')}
                            />
                        ) : google?.calendar?.error ? (
                            <EmptyState text={`Calendar unavailable: ${google.calendar.error}`} />
                        ) : (google?.calendar?.events?.length ?? 0) === 0 ? (
                            <EmptyState text="Nothing on your calendar today." />
                        ) : (
                            google.calendar.events.map((ev: any, i: number) => (
                                <CalendarRow key={ev.id ?? i} ev={ev} />
                            ))
                        )}
                    </Pane>

                    {/* Gmail — Google surface, gated */}
                    <Pane
                        title="Gmail"
                        icon="Mail"
                        count={mailState === 'ready' ? (google?.mail?.unread ?? undefined) : undefined}
                        actionLabel="Open"
                        onAction={() => navigation.navigate('Gmail')}
                    >
                        {mailState !== 'ready' ? (
                            <GoogleGate
                                state={mailState}
                                surface="Gmail"
                                onConnect={onConnectGoogle}
                                onOpenSurface={() => navigation.navigate('Gmail')}
                            />
                        ) : google?.mail?.error ? (
                            <EmptyState text={`Gmail unavailable: ${google.mail.error}`} />
                        ) : (
                            <MailSummary
                                unread={google?.mail?.unread ?? 0}
                                starred={google?.mail?.starred ?? 0}
                                important={google?.mail?.important ?? 0}
                                onOpen={() => navigation.navigate('Gmail')}
                            />
                        )}
                    </Pane>
                </ScrollView>
            )}
        </SafeAreaView>
    );
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
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors.gray800,
        gap: 8,
    },
    menuButton: {
        padding: 6,
    },
    menuIcon: {
        color: colors.gray300,
        fontSize: 22,
    },
    titleIcon: {
        marginRight: 2,
    },
    title: {
        color: colors.white,
        fontSize: 18,
        fontWeight: '700',
    },
    subtitle: {
        color: colors.gray500,
        fontSize: 11,
    },
    refreshButton: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: colors.gray800,
        minWidth: 64,
        alignItems: 'center',
    },
    refreshText: {
        color: colors.gray300,
        fontSize: 12,
        fontWeight: '500',
    },
    centered: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 24,
    },
    muted: {
        color: colors.gray600,
        fontSize: 13,
    },
    retryButton: {
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: colors.gray800,
    },
    retryText: {
        color: colors.gray200,
        fontSize: 13,
    },
    scroll: {
        flex: 1,
    },
    scrollContent: {
        padding: 12,
        paddingBottom: 32,
        gap: 12,
    },
    pane: {
        backgroundColor: colors.gray900,
        borderColor: colors.gray800,
        borderWidth: 1,
        borderRadius: 12,
        overflow: 'hidden',
    },
    paneHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 14,
        paddingVertical: 11,
        borderBottomWidth: 1,
        borderBottomColor: colors.gray800,
    },
    paneTitle: {
        color: colors.gray200,
        fontSize: 14,
        fontWeight: '600',
        flex: 1,
    },
    paneCount: {
        color: colors.gray500,
        fontSize: 12,
        fontWeight: '500',
    },
    paneAction: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
    },
    paneActionText: {
        color: colors.gray500,
        fontSize: 12,
    },
    paneBody: {
        padding: 10,
        gap: 6,
    },
    emptyText: {
        color: colors.gray500,
        fontSize: 13,
        textAlign: 'center',
        paddingVertical: 18,
    },
    gate: {
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 12,
        paddingVertical: 20,
    },
    gateBlurb: {
        color: colors.gray400,
        fontSize: 13,
        textAlign: 'center',
    },
    gateButton: {
        borderWidth: 1,
        borderColor: colors.gray700,
        backgroundColor: colors.gray800,
        borderRadius: 10,
        paddingHorizontal: 14,
        paddingVertical: 8,
    },
    gateButtonText: {
        color: colors.gray200,
        fontSize: 13,
        fontWeight: '500',
    },
    workRow: {
        borderWidth: 1,
        borderColor: colors.gray800,
        backgroundColor: colors.gray950,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 9,
        gap: 4,
    },
    workRowTop: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    priorityBadge: {
        borderWidth: 1,
        borderRadius: 4,
        paddingHorizontal: 5,
        paddingVertical: 1,
    },
    priorityText: {
        fontSize: 9,
        fontWeight: '600',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
    },
    workTitle: {
        color: colors.gray200,
        fontSize: 14,
        flex: 1,
    },
    workRowBottom: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    workMeta: {
        color: colors.gray500,
        fontSize: 12,
        maxWidth: '46%',
    },
    workMetaDot: {
        color: colors.gray700,
        fontSize: 12,
    },
    todoRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderWidth: 1,
        borderColor: colors.gray800,
        backgroundColor: colors.gray950,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    todoTitle: {
        color: colors.gray200,
        fontSize: 14,
        flex: 1,
    },
    dueBadge: {
        borderWidth: 1,
        borderRadius: 4,
        paddingHorizontal: 5,
        paddingVertical: 1,
    },
    dueBadgeText: {
        fontSize: 10,
    },
    calRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        borderWidth: 1,
        borderColor: colors.gray800,
        backgroundColor: colors.gray950,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    calTime: {
        color: colors.gray400,
        fontSize: 12,
        width: 62,
    },
    calSummary: {
        color: colors.gray200,
        fontSize: 14,
        flex: 1,
    },
    calJoin: {
        color: colors.blue400,
        fontSize: 12,
    },
    mailGrid: {
        flexDirection: 'row',
        gap: 8,
    },
    mailStat: {
        flex: 1,
        alignItems: 'center',
        gap: 4,
        borderWidth: 1,
        borderColor: colors.gray800,
        backgroundColor: colors.gray950,
        borderRadius: 10,
        paddingVertical: 16,
    },
    mailValue: {
        color: colors.gray100,
        fontSize: 22,
        fontWeight: '600',
    },
    mailLabel: {
        color: colors.gray500,
        fontSize: 12,
    },
    errorText: {
        color: colors.red400,
        fontSize: 13,
        textAlign: 'center',
    },
});
