import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ChevronDown, ChevronRight, ListOrdered, RefreshCw, Terminal } from 'lucide-react-native';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
import { useApp } from '../context/AppContext';
import { colors } from '../theme/colors';
import { api } from '../utils/api';
import { relativeTime } from '../utils/time';
import { createWorkflowLoadGate } from '../utils/workflowLoadGate';
import {
  indexRowsByWorkflowId,
  mapWithConcurrency,
  planWorkflowEnrichment,
  WORKFLOW_ENRICH_CONCURRENCY,
  type WorkflowRow,
} from '../utils/workflowListLoad';
import { buildWorkflowStepDots } from '@shared/utils/workflowProgressDots';
import { buildWorkflowRunTimeline, isWorkflowRunActive } from '@shared/utils/workflowRunTimeline';

/** Poll cadence while a run in view is still pending/running vs settled. */
const ACTIVE_POLL_MS = 2500;

type StatusTone = { borderColor: string; backgroundColor: string; color: string };

const STATUS_STYLE: Record<string, StatusTone> = {
  success: {
    borderColor: colors.emerald500,
    backgroundColor: colors.emerald900_40,
    color: colors.emerald300,
  },
  error: { borderColor: colors.red500, backgroundColor: colors.red900_50, color: colors.red400 },
  cancelled: {
    borderColor: colors.amber400,
    backgroundColor: colors.amber900_40,
    color: colors.amber400,
  },
  running: {
    borderColor: colors.blue500,
    backgroundColor: colors.blue900_40,
    color: colors.blue300,
  },
  pending: { borderColor: colors.gray700, backgroundColor: colors.gray800, color: colors.gray300 },
  skipped: { borderColor: colors.gray700, backgroundColor: colors.gray800, color: colors.gray400 },
  queued: { borderColor: colors.gray700, backgroundColor: colors.gray800, color: colors.gray400 },
  not_run: { borderColor: colors.gray800, backgroundColor: colors.gray900, color: colors.gray500 },
  idle: { borderColor: colors.gray700, backgroundColor: colors.gray800, color: colors.gray300 },
};

export function statusTone(status: any): StatusTone {
  return STATUS_STYLE[String(status || '').toLowerCase()] || STATUS_STYLE.idle;
}

const DOT_COLOR: Record<string, string> = {
  inactive: colors.gray800,
  pending: colors.gray600,
  running: colors.blue500,
  success: colors.emerald500,
  error: colors.red500,
  cancelled: colors.amber400,
  skipped: colors.gray600,
};

export function dotColor(kind: any): string {
  return DOT_COLOR[String(kind || '')] || colors.gray700;
}

export function formatLastRun(run: any): string {
  if (!run) return '—';
  const label = relativeTime(run.started_at);
  return label || '—';
}

function StatusBadge({ status }: any) {
  const label = String(status || 'idle');
  const tone = statusTone(label);
  return (
    <View
      style={[
        styles.statusBadge,
        { borderColor: tone.borderColor, backgroundColor: tone.backgroundColor },
      ]}
    >
      <Text style={[styles.statusBadgeText, { color: tone.color }]}>
        {label.replace(/_/g, ' ')}
      </Text>
    </View>
  );
}

export default function WorkflowsScreen({ route, navigation }: any) {
  const { projects } = useApp();
  const projectId = route?.params?.projectId || projects?.[0]?.id;
  const project = route?.params?.project || projects?.find((p: any) => p.id === projectId);

  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const projectIdRef = useRef(projectId);
  const loadGateRef = useRef(createWorkflowLoadGate());
  // Latest enriched rows keyed by workflow id, read inside `load` without
  // adding `rows` to its deps (which would tear down the poll interval).
  const rowsRef = useRef<Map<string, WorkflowRow>>(new Map());
  projectIdRef.current = projectId;

  const load = useCallback(
    async ({ silent = false, activeOnly = false }: any = {}) => {
      if (!projectId) return;
      const token = projectId;
      const request = loadGateRef.current.begin(token);
      if (!request) return;
      if (silent) setRefreshing(true);
      else setLoading(true);
      const isCurrent = () =>
        projectIdRef.current === token && loadGateRef.current.isCurrent(request);
      try {
        const list = await api.getProjectWorkflows(token);
        if (!isCurrent()) return;
        const wfList = Array.isArray(list) ? list : [];
        const prevRows = rowsRef.current;
        // Only refetch workflows that can change on a background poll (active or
        // not-yet-loaded); settled ones reuse cached run detail. Bound the
        // remaining fan-out so we never burst dozens of parallel requests.
        const { fetchIds, reuse } = planWorkflowEnrichment(wfList, prevRows, { activeOnly });
        const fetched = await mapWithConcurrency(
          wfList.filter((w: any) => fetchIds.has(String(w.id))),
          WORKFLOW_ENRICH_CONCURRENCY,
          async (w: any): Promise<WorkflowRow> => {
            let lastRun = null;
            let stepRuns: any[] = [];
            try {
              const runs = await api.getWorkflowRuns(token, w.id, { limit: 1 });
              lastRun = (Array.isArray(runs) ? runs : [])[0] || null;
              if (lastRun) {
                const det = await api.getWorkflowRunDetail(token, w.id, lastRun.id);
                stepRuns = det?.step_runs || [];
              }
            } catch {
              // Keep any run detail we already had rather than blanking the row.
              const prev = prevRows.get(String(w.id));
              if (prev) {
                lastRun = prev.lastRun;
                stepRuns = prev.stepRuns;
              }
            }
            return { workflow: w, lastRun, stepRuns };
          },
        );
        if (!isCurrent()) return;
        const fetchedById = indexRowsByWorkflowId(fetched);
        const enriched: WorkflowRow[] = wfList.map(
          (w: any) =>
            fetchedById.get(String(w.id)) ??
            reuse.get(String(w.id)) ?? { workflow: w, lastRun: null, stepRuns: [] },
        );
        rowsRef.current = indexRowsByWorkflowId(enriched);
        setRows(enriched);
        setError(null);
      } catch (e: any) {
        if (!isCurrent()) return;
        setError(e?.message || 'Failed to load workflows');
        if (!silent) {
          rowsRef.current = new Map();
          setRows([]);
        }
      } finally {
        if (isCurrent()) {
          setLoading(false);
          setRefreshing(false);
        }
        loadGateRef.current.finish(request);
      }
    },
    [projectId],
  );

  useEffect(() => {
    setError(null);
    rowsRef.current = new Map();
    setRows([]);
    setExpandedId(null);
    load();
  }, [load]);

  // Refresh on an interval only while a run in view is still active — keeps a
  // settled board quiet but reflects live progress without a WS subscription.
  const hasActiveRun = rows.some(({ lastRun }: any) => isWorkflowRunActive(lastRun));
  useEffect(() => {
    if (!hasActiveRun) return undefined;
    const id = setInterval(() => {
      // Poll only the active rows, not the whole board, to keep the request
      // count bounded while a run is in progress.
      load({ silent: true, activeOnly: true });
    }, ACTIVE_POLL_MS);
    return () => clearInterval(id);
  }, [hasActiveRun, load]);

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ProjectScreenHeader
        title="Workflows"
        project={project}
        onBack={() => navigation.goBack()}
        right={
          <TouchableOpacity
            onPress={() => load({ silent: true })}
            disabled={refreshing || loading}
            style={[styles.iconButton, (refreshing || loading) && styles.disabled]}
            accessibilityLabel="Refresh workflows"
          >
            {refreshing ? (
              <ActivityIndicator color={colors.gray300} size="small" />
            ) : (
              <RefreshCw size={16} color={colors.gray300} />
            )}
          </TouchableOpacity>
        }
      />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <ListOrdered size={16} color={colors.purple400} />
          <Text style={styles.subtitle}>Read-only view of Hub workflow runs</Text>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {loading && rows.length === 0 ? (
          <ActivityIndicator color={colors.gray400} style={styles.loader} />
        ) : rows.length === 0 && !error ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>No Hub workflows defined for this project yet.</Text>
          </View>
        ) : (
          rows.map(({ workflow: w, lastRun, stepRuns }: any) => (
            <WorkflowCard
              key={w.id}
              workflow={w}
              lastRun={lastRun}
              stepRuns={stepRuns}
              expanded={expandedId === w.id}
              onToggle={() => setExpandedId((cur) => (cur === w.id ? null : w.id))}
              projectId={projectId}
            />
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

export function WorkflowCard({ workflow, lastRun, stepRuns, expanded, onToggle, projectId }: any) {
  const dots = buildWorkflowStepDots(workflow, stepRuns, Boolean(lastRun));
  const active = isWorkflowRunActive(lastRun);
  return (
    <View style={styles.card} testID={`workflow-card-${workflow.id}`}>
      <TouchableOpacity style={styles.cardHeader} onPress={onToggle} accessibilityRole="button">
        {expanded ? (
          <ChevronDown size={16} color={colors.gray500} />
        ) : (
          <ChevronRight size={16} color={colors.gray500} />
        )}
        <View style={styles.cardTitleBlock}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle} numberOfLines={1}>
              {workflow.name}
            </Text>
            {lastRun ? <StatusBadge status={lastRun.status} /> : null}
            {active ? <View style={styles.livePulse} /> : null}
          </View>
          <View style={styles.cardMetaRow}>
            <Text style={styles.cardMeta} numberOfLines={1}>
              Last run: {formatLastRun(lastRun)}
            </Text>
            {dots.length > 0 ? (
              <View style={styles.dotRow}>
                {dots.map((d: any) => (
                  <View key={d.id} style={[styles.dot, { backgroundColor: dotColor(d.kind) }]} />
                ))}
              </View>
            ) : null}
          </View>
        </View>
      </TouchableOpacity>
      {expanded ? <WorkflowRunsPanel projectId={projectId} workflow={workflow} /> : null}
    </View>
  );
}

export function WorkflowRunsPanel({ projectId, workflow }: any) {
  const [runs, setRuns] = useState<any[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const keyRef = useRef<string>('');
  const runsGateRef = useRef(createWorkflowLoadGate());
  const detailGateRef = useRef(createWorkflowLoadGate());

  const loadRuns = useCallback(async () => {
    if (!projectId || !workflow?.id) return;
    const requestKey = `${projectId}:${workflow.id}`;
    const request = runsGateRef.current.begin(requestKey);
    if (!request) return;
    setLoading(true);
    try {
      const r = await api.getWorkflowRuns(projectId, workflow.id, { limit: 20 });
      if (!runsGateRef.current.isCurrent(request)) return;
      const arr = Array.isArray(r) ? r : [];
      setRuns(arr);
      setRunsError(null);
      setSelectedRunId((cur) =>
        cur && arr.some((x: any) => x.id === cur) ? cur : arr[0]?.id || null,
      );
    } catch (e: any) {
      if (runsGateRef.current.isCurrent(request)) {
        setRunsError(e?.message || 'Failed to load runs');
        setLoading(false);
      }
    } finally {
      if (runsGateRef.current.isCurrent(request)) setLoading(false);
      runsGateRef.current.finish(request);
    }
  }, [projectId, workflow?.id]);

  const loadDetail = useCallback(
    async (runId: string, { poll = false }: { poll?: boolean } = {}) => {
      if (!projectId || !workflow?.id || !runId) return;
      const myKey = `${workflow.id}:${runId}`;
      // A poll tick must be able to re-arm even if the previous same-run request
      // is still in flight, so it supersedes rather than being deduped away.
      // The initial selection load keeps dedup to coalesce rapid taps.
      const request = detailGateRef.current.begin(`${projectId}:${myKey}`, { allowReplace: poll });
      if (!request) return;
      keyRef.current = myKey;
      try {
        const d = await api.getWorkflowRunDetail(projectId, workflow.id, runId);
        if (keyRef.current !== myKey || !detailGateRef.current.isCurrent(request)) return;
        setDetail(d);
        setDetailError(null);
      } catch (e: any) {
        if (keyRef.current === myKey && detailGateRef.current.isCurrent(request)) {
          setDetailError(e?.message || 'Failed to load run detail');
        }
      } finally {
        detailGateRef.current.finish(request);
      }
    },
    [projectId, workflow?.id],
  );

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    setDetailError(null);
    if (!selectedRunId) {
      setDetail(null);
      return undefined;
    }
    // Do not leave the previous run's timeline visible while the newly selected
    // run is loading. The detail response is asynchronous and may take longer
    // than the tap transition.
    setDetail(null);
    loadDetail(selectedRunId);
    return undefined;
  }, [selectedRunId, loadDetail]);

  // Poll run + detail while the selected run is still active. Base the decision
  // on the fresh run-list row for the selected run (authoritative each tick),
  // not on the possibly-null/stale `detail`, so polling is never stopped while
  // the selected run is still pending/running. Any other active run keeps the
  // loop alive too, so a newly-started run is picked up on the next refresh.
  const selectedRunRow = selectedRunId
    ? runs.find((r: any) => r.id === selectedRunId) || null
    : null;
  const detailActive =
    isWorkflowRunActive(selectedRunRow) ||
    isWorkflowRunActive(detail?.run) ||
    runs.some((r: any) => isWorkflowRunActive(r));
  useEffect(() => {
    if (!detailActive) return undefined;
    const id = setInterval(() => {
      loadRuns();
      if (selectedRunId) loadDetail(selectedRunId, { poll: true });
    }, ACTIVE_POLL_MS);
    return () => clearInterval(id);
  }, [detailActive, selectedRunId, loadRuns, loadDetail]);

  const timeline = buildWorkflowRunTimeline(workflow, detail?.step_runs, detail?.run);

  return (
    <View style={styles.panel}>
      {runsError ? (
        <View style={styles.errorRow}>
          <Text style={styles.error}>{runsError}</Text>
          <TouchableOpacity
            onPress={loadRuns}
            style={styles.retryButton}
            accessibilityLabel="Retry loading runs"
          >
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {detailError ? (
        <View style={styles.errorRow}>
          <Text style={styles.error}>{detailError}</Text>
          <TouchableOpacity
            onPress={() => selectedRunId && loadDetail(selectedRunId)}
            style={styles.retryButton}
            accessibilityLabel="Retry run detail"
          >
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {loading && runs.length === 0 ? (
        <ActivityIndicator color={colors.gray500} size="small" />
      ) : runs.length === 0 ? (
        <Text style={styles.emptyText}>No runs recorded for this workflow.</Text>
      ) : (
        <>
          <Text style={styles.panelLabel}>Recent runs</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.runPicker}
            accessibilityLabel="Recent runs"
          >
            {runs.map((r: any) => {
              const selected = r.id === selectedRunId;
              return (
                <TouchableOpacity
                  key={r.id}
                  onPress={() => setSelectedRunId(r.id)}
                  style={[styles.runChip, selected && styles.runChipActive]}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                >
                  <Text
                    style={[styles.runChipText, selected && styles.runChipTextActive]}
                    numberOfLines={1}
                  >
                    {String(r.id).slice(0, 8)}… · {r.status}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {detail?.run ? (
            <RunTimeline detail={detail} timeline={timeline} />
          ) : (
            <ActivityIndicator color={colors.gray500} size="small" style={styles.loader} />
          )}
        </>
      )}
    </View>
  );
}

export function RunTimeline({ detail, timeline }: any) {
  const run = detail.run;
  const progressDone = timeline.completedSteps;
  const progressTotal = timeline.totalSteps || 0;
  return (
    <View style={styles.detailCard}>
      <View style={styles.detailHeader}>
        <Text style={styles.detailId} numberOfLines={1}>
          {String(run.id).slice(0, 12)}…
        </Text>
        <StatusBadge status={run.status} />
      </View>

      {run.error ? <Text style={styles.runError}>{String(run.error)}</Text> : null}

      <Text style={styles.progressLabel}>
        {progressDone}/{progressTotal} steps · {timeline.progressPct}%
      </Text>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${timeline.progressPct}%` }]} />
      </View>

      <View style={styles.stepsHeaderRow}>
        <Terminal size={13} color={colors.gray400} />
        <Text style={styles.stepsHeader}>Steps</Text>
      </View>
      {timeline.rows.length === 0 ? (
        <Text style={styles.emptyText}>No steps defined for this workflow.</Text>
      ) : (
        timeline.rows.map((row: any) => (
          <View key={row.key} style={styles.stepRow}>
            <View
              style={[styles.stepDot, { backgroundColor: statusTone(row.displayStatus).color }]}
            />
            <View style={styles.stepBody}>
              <View style={styles.stepTitleRow}>
                <Text style={styles.stepTitle} numberOfLines={1}>
                  {String(row.step.title || 'Step')}
                </Text>
                <StatusBadge status={row.displayStatus} />
                {row.orphan ? <Text style={styles.orphanTag}>(historical)</Text> : null}
              </View>
              {row.stepRun?.error && row.displayStatus === 'error' ? (
                <Text style={styles.stepError}>{String(row.stepRun.error)}</Text>
              ) : null}
            </View>
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.gray950 },
  content: { padding: 16, paddingBottom: 32, gap: 12 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  subtitle: { color: colors.gray500, fontSize: 12 },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.gray900,
  },
  disabled: { opacity: 0.5 },
  error: { color: colors.red400, fontSize: 13 },
  loader: { marginVertical: 12 },
  emptyCard: {
    minHeight: 88,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.gray800,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  emptyText: { color: colors.gray500, fontSize: 13, textAlign: 'center', paddingVertical: 8 },
  card: {
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    backgroundColor: colors.gray900,
    overflow: 'hidden',
  },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 12 },
  cardTitleBlock: { flex: 1, minWidth: 0, gap: 6 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  cardTitle: { flexShrink: 1, color: colors.white, fontSize: 15, fontWeight: '700' },
  livePulse: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.emerald400 },
  cardMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  cardMeta: { color: colors.gray500, fontSize: 12 },
  dotRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusBadge: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  statusBadgeText: { fontSize: 10, fontWeight: '700', textTransform: 'lowercase' },
  panel: {
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
    padding: 12,
    gap: 8,
    backgroundColor: colors.gray950,
  },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  retryButton: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  retryButtonText: { color: colors.gray300, fontSize: 12, fontWeight: '700' },
  panelLabel: { color: colors.gray400, fontSize: 12, fontWeight: '700' },
  runPicker: { maxHeight: 40 },
  runChip: {
    minHeight: 32,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: colors.gray700,
    paddingHorizontal: 10,
    justifyContent: 'center',
    marginRight: 8,
    backgroundColor: colors.gray900,
  },
  runChipActive: { borderColor: colors.blue500, backgroundColor: colors.blue900_40 },
  runChipText: { color: colors.gray300, fontSize: 12, fontFamily: 'monospace' },
  runChipTextActive: { color: colors.blue300 },
  detailCard: {
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    backgroundColor: colors.gray900,
    padding: 12,
    gap: 8,
  },
  detailHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  detailId: { flex: 1, color: colors.gray200, fontSize: 12, fontFamily: 'monospace' },
  runError: {
    color: colors.red400,
    fontSize: 12,
    padding: 8,
    borderRadius: 6,
    backgroundColor: colors.red900_50,
  },
  progressLabel: { color: colors.gray400, fontSize: 11 },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.gray800,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: 4, backgroundColor: colors.purple500 },
  stepsHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  stepsHeader: {
    color: colors.gray500,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  stepDot: { width: 10, height: 10, borderRadius: 5, marginTop: 4 },
  stepBody: { flex: 1, minWidth: 0 },
  stepTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  stepTitle: { flexShrink: 1, color: colors.gray100, fontSize: 13, fontWeight: '600' },
  orphanTag: { color: colors.gray500, fontSize: 10 },
  stepError: { marginTop: 4, color: colors.red400, fontSize: 12 },
});
