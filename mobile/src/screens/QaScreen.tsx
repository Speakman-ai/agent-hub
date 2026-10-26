import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../context/AppContext';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
import NewQaPlanModal from '../components/NewQaPlanModal';
import QaPlanDetailView, { QaLinkChips, type QaLinkHandlers } from '../components/QaPlanDetailView';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import {
  groupPlansByStatus,
  latestRunVerdicts,
  planCounts,
  qaEventMatches,
  QA_STATUSES,
  targetHost,
  VERDICT_COLORS,
  VERDICT_LABELS,
  type QaPlanListItem,
  type QaPlanStatus,
} from '../utils/qa';

type ViewMode = 'list' | 'board';

export function VerdictSummary({ plan }: { plan: QaPlanListItem }) {
  const run = plan.summary.latestRun;
  if (!run) return <Text style={styles.muted}>Not run</Text>;
  return (
    <View style={styles.verdicts}>
      <Text style={styles.runLabel}>
        Run {run.iteration} {run.status}
      </Text>
      {latestRunVerdicts(plan).map(({ verdict, count }) => (
        <Text key={verdict} style={[styles.verdict, { color: VERDICT_COLORS[verdict] }]}>
          {count} {VERDICT_LABELS[verdict]}
        </Text>
      ))}
    </View>
  );
}

export function QaPlanItem({
  plan,
  onOpenPlan,
  variant,
  ...links
}: {
  plan: QaPlanListItem;
  onOpenPlan: (planId: string) => void;
  variant: 'row' | 'card';
} & QaLinkHandlers) {
  return (
    <View
      style={variant === 'row' ? styles.planRow : styles.planCard}
      testID={`qa-plan-${variant}-${plan.id}`}
    >
      <TouchableOpacity onPress={() => onOpenPlan(plan.id)} testID={`qa-plan-open-${plan.id}`}>
        <Text style={styles.planTitle} numberOfLines={2}>
          {plan.title}
        </Text>
      </TouchableOpacity>
      <Text style={styles.muted} numberOfLines={1}>
        {targetHost(plan.targetUrl)}
      </Text>
      <VerdictSummary plan={plan} />
      <QaLinkChips epic={plan.summary.epic} card={plan.summary.card} {...links} />
    </View>
  );
}

export function QaStatusTabs({
  tab,
  counts,
  onSelect,
}: {
  tab: QaPlanStatus;
  counts: Record<QaPlanStatus, number>;
  onSelect: (tab: QaPlanStatus) => void;
}) {
  return (
    <View style={styles.tabs} accessibilityRole="tablist">
      {QA_STATUSES.map(({ key, label }) => (
        <TouchableOpacity
          key={key}
          testID={`qa-tab-${key}`}
          accessibilityRole="tab"
          accessibilityState={{ selected: tab === key }}
          onPress={() => onSelect(key)}
          style={[styles.tab, tab === key && styles.tabActive]}
        >
          <Text style={[styles.tabText, tab === key && styles.tabTextActive]}>
            {label} <Text style={styles.count}>{counts[key]}</Text>
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

export default function QaScreen({ route, navigation }: any) {
  const { projects, subscribeQaUpdates, setActiveAgentId, setActiveSessionId } = useApp();
  const projectId: string = route?.params?.projectId || projects?.[0]?.id;
  const project = route?.params?.project || projects?.find((p: any) => p.id === projectId);
  const routePlanId: string | null = route?.params?.planId ?? null;

  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(routePlanId);
  const [plans, setPlans] = useState<QaPlanListItem[]>([]);
  const [serverCounts, setServerCounts] = useState<Record<QaPlanStatus, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<QaPlanStatus>('new');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [creating, setCreating] = useState(false);
  const [detailNotice, setDetailNotice] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    if (!projectId) return;
    const seq = ++requestSeq.current;
    try {
      const data = await api.listQaPlans(projectId);
      if (seq !== requestSeq.current) return;
      setPlans(Array.isArray(data?.plans) ? data.plans : []);
      setServerCounts(data?.counts ?? null);
      setError(null);
    } catch (e: any) {
      if (seq !== requestSeq.current) return;
      setError(e?.message || 'Failed to load QA plans');
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    setPlans([]);
    setServerCounts(null);
    setError(null);
    setLoading(true);
    void load();
    return () => {
      requestSeq.current += 1;
    };
  }, [load]);

  // A different project drops the open plan (it belongs to the old project)
  // unless the navigation named a plan in the new one.
  const shownProjectId = useRef(projectId);
  useEffect(() => {
    if (shownProjectId.current !== projectId) {
      shownProjectId.current = projectId;
      setSelectedPlanId(routePlanId);
      setDetailNotice(null);
    } else if (routePlanId) {
      setSelectedPlanId(routePlanId);
    }
  }, [projectId, routePlanId]);

  useEffect(
    () =>
      subscribeQaUpdates?.((event: any) => {
        if (projectId && qaEventMatches(event, projectId)) void load();
      }),
    [subscribeQaUpdates, load, projectId],
  );

  const grouped = useMemo(() => groupPlansByStatus(plans), [plans]);
  const counts = useMemo(() => planCounts(grouped, serverCounts), [grouped, serverCounts]);

  const openSession = useCallback(
    (agentId: string | null, sessionId: string) => {
      if (agentId) setActiveAgentId(agentId);
      setActiveSessionId(sessionId);
      navigation?.navigate('Chat');
    },
    [navigation, setActiveAgentId, setActiveSessionId],
  );
  const links: QaLinkHandlers = {
    onOpenEpic: (epicId) => navigation?.navigate('EpicDetail', { projectId, project, epicId }),
    onOpenCard: (cardId) => navigation?.navigate('Kanban', { projectId, project, cardId }),
  };

  /**
   * A new plan opens its detail and its seeded authoring chat. The plan
   * already exists if the chat fails to open, so the detail says why and
   * offers the chat button again.
   */
  const handlePlanCreated = async (planId: string) => {
    setCreating(false);
    setTab('new');
    setSelectedPlanId(planId);
    setDetailNotice(null);
    void load();
    try {
      const { agentId, sessionId } = await api.openQaAuthoringSession(projectId, planId);
      openSession(agentId, sessionId);
    } catch (e: any) {
      setDetailNotice(
        `Plan created, but the QA chat did not open: ${e?.message || 'unknown error'}`,
      );
    }
  };

  if (selectedPlanId) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <ProjectScreenHeader
          title="QA plan"
          project={project}
          onBack={() => {
            setSelectedPlanId(null);
            setDetailNotice(null);
            navigation?.setParams?.({ planId: undefined });
          }}
        />
        <QaPlanDetailView
          key={selectedPlanId}
          projectId={projectId}
          planId={selectedPlanId}
          notice={detailNotice}
          onOpenSession={openSession}
          {...links}
        />
      </SafeAreaView>
    );
  }

  const header = (
    <View style={styles.toolbar}>
      <TouchableOpacity
        testID="qa-new-plan"
        onPress={() => setCreating(true)}
        style={styles.newButton}
      >
        <Text style={styles.newButtonText}>+ New QA plan</Text>
      </TouchableOpacity>
      <View style={styles.toggle}>
        {(['list', 'board'] as const).map((mode) => (
          <TouchableOpacity
            key={mode}
            testID={`qa-view-${mode}`}
            accessibilityState={{ selected: viewMode === mode }}
            onPress={() => setViewMode(mode)}
            style={[styles.toggleItem, viewMode === mode && styles.toggleItemActive]}
          >
            <Text style={[styles.toggleText, viewMode === mode && styles.toggleTextActive]}>
              {mode === 'list' ? 'List' : 'Board'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );

  const refreshControl = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true);
        void load();
      }}
      tintColor={colors.gray400}
    />
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="qa-screen">
      <ProjectScreenHeader title="QA" project={project} />
      {header}
      {error ? <Text style={styles.errorBox}>{error}</Text> : null}
      {creating ? (
        <NewQaPlanModal
          projectId={projectId}
          onClose={() => setCreating(false)}
          onCreated={handlePlanCreated}
        />
      ) : null}
      {viewMode === 'list' ? (
        <>
          <QaStatusTabs tab={tab} counts={counts} onSelect={setTab} />
          <ScrollView contentContainerStyle={styles.listBody} refreshControl={refreshControl}>
            {loading ? (
              <ActivityIndicator color={colors.gray400} />
            ) : grouped[tab].length === 0 ? (
              <Text style={styles.muted} testID="qa-empty">
                No plans here.
              </Text>
            ) : (
              <View style={styles.list} testID="qa-plan-list">
                {grouped[tab].map((p) => (
                  <QaPlanItem
                    key={p.id}
                    plan={p}
                    variant="row"
                    onOpenPlan={setSelectedPlanId}
                    {...links}
                  />
                ))}
              </View>
            )}
          </ScrollView>
        </>
      ) : (
        <ScrollView horizontal contentContainerStyle={styles.board} testID="qa-board">
          {QA_STATUSES.map(({ key, label }) => (
            <View key={key} style={styles.column} testID={`qa-column-${key}`}>
              <Text style={styles.columnHeader}>
                {label} <Text style={styles.count}>{counts[key]}</Text>
              </Text>
              <ScrollView contentContainerStyle={styles.columnBody} refreshControl={refreshControl}>
                {grouped[key].map((p) => (
                  <QaPlanItem
                    key={p.id}
                    plan={p}
                    variant="card"
                    onOpenPlan={setSelectedPlanId}
                    {...links}
                  />
                ))}
              </ScrollView>
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray900 },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  newButton: {
    backgroundColor: colors.blue600,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  newButtonText: { fontSize: 13, color: colors.white },
  toggle: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    overflow: 'hidden',
  },
  toggleItem: { paddingHorizontal: 10, paddingVertical: 5, backgroundColor: colors.gray800 },
  toggleItemActive: { backgroundColor: colors.gray700 },
  toggleText: { fontSize: 12, color: colors.gray400 },
  toggleTextActive: { color: colors.white },
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    paddingHorizontal: 8,
  },
  tab: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: { borderBottomColor: colors.blue500 },
  tabText: { fontSize: 14, color: colors.gray400 },
  tabTextActive: { color: colors.white },
  count: { fontSize: 11, color: colors.gray500 },
  listBody: { padding: 12, paddingBottom: 40 },
  list: { borderWidth: 1, borderColor: colors.gray800, borderRadius: 8, overflow: 'hidden' },
  planRow: {
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  planCard: {
    gap: 4,
    padding: 10,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    backgroundColor: colors.gray950,
  },
  planTitle: { fontSize: 14, color: colors.gray100 },
  muted: { fontSize: 12, color: colors.gray500 },
  verdicts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  runLabel: { fontSize: 12, color: colors.gray400 },
  verdict: { fontSize: 12 },
  errorBox: {
    marginHorizontal: 12,
    fontSize: 13,
    color: colors.red400,
    backgroundColor: colors.red900_50,
    borderRadius: 6,
    padding: 10,
  },
  board: { padding: 12, gap: 10 },
  column: {
    width: 280,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    backgroundColor: colors.gray950,
  },
  columnHeader: {
    fontSize: 14,
    color: colors.gray300,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  columnBody: { padding: 8, gap: 8 },
});
