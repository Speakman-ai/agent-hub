import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { relativeTime } from '../utils/time';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
import FinalizeSection from '../components/FinalizeSection';
const STATUS_COLOR: Record<string, any> = {
  success: colors.emerald400,
  failure: colors.red400,
  running: colors.amber400,
  queued: colors.gray400,
  cancelled: colors.gray500,
};
// Mirrors TERMINAL_STATUSES in client/src/components/CiRunsSection.tsx — a run
// is stoppable only while it is still in flight (not one of these).
const TERMINAL_STATUSES = new Set([
  'ready_to_push',
  'pushed',
  'succeeded',
  'failed',
  'timed_out',
  'infra_error',
  'cancelled',
]);
export default function RunnersScreen({ route, navigation }: any) {
  const { projectId, project: routeProject } = route.params || {};
  const project = routeProject;
  const [runs, setRuns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [selectedRun, setSelectedRun] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const loadRuns = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.getCiRuns(projectId, { limit: 30 });
      setRuns(data?.runs || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load CI runs');
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);
  useEffect(() => {
    loadRuns();
    const id = setInterval(loadRuns, 60000);
    return () => clearInterval(id);
  }, [loadRuns]);
  const openDetail = async (run: any) => {
    setSelectedRun(run);
    setDetail(null);
    setDetailLoading(true);
    try {
      const data = await api.getCiRunDetail(projectId, run.id);
      setDetail(data);
    } catch (err: any) {
      setDetail({ error: err?.message || 'Failed to load run detail' });
    } finally {
      setDetailLoading(false);
    }
  };
  const stopRun = async (run: any) => {
    if (!projectId || !run?.id || stoppingId) return;
    setStoppingId(run.id);
    try {
      await api.cancelFinalizeRun(projectId, run.id);
      setTimeout(() => loadRuns(), 1500);
    } catch (err: any) {
      setError(err?.message || 'Failed to stop run');
    } finally {
      setStoppingId(null);
    }
  };
  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ProjectScreenHeader title="Runners" project={project} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.content}>
        <FinalizeSection navigation={navigation} fixedProjectId={projectId} />

        <View style={styles.ciSection}>
          <View style={styles.ciHeader}>
            <Text style={styles.ciTitle}>CI runs</Text>
            <TouchableOpacity onPress={loadRuns}>
              <Text style={styles.refresh}>Refresh</Text>
            </TouchableOpacity>
          </View>
          {loading && <ActivityIndicator color={colors.gray400} />}
          {error && <Text style={styles.error}>{error}</Text>}
          {!loading && runs.length === 0 && !error && (
            <Text style={styles.empty}>No CI runs yet for this project.</Text>
          )}
          {runs.map((run: any) => {
            const color = STATUS_COLOR[run.status] || colors.gray400;
            const stoppable = !TERMINAL_STATUSES.has(run.status);
            const isStopping = stoppingId === run.id;
            // The Stop-all control is a SIBLING of the detail-opening press
            // targets, never nested inside one. React Native fires both a
            // nested and a parent Touchable's onPress, so nesting would let a
            // Stop tap also openDetail(run). Keeping them as separate, adjacent
            // press targets means a Stop tap can never reach openDetail.
            return (
              <View key={run.id} style={styles.runCard}>
                <View style={styles.runRow}>
                  <TouchableOpacity
                    style={styles.runRowMain}
                    onPress={() => openDetail(run)}
                    accessibilityLabel="Open run detail"
                  >
                    <View style={[styles.statusDot, { backgroundColor: color }]} />
                    <Text style={styles.runStatus}>{run.status || 'unknown'}</Text>
                    <Text style={styles.runTime}>
                      {relativeTime(run.started_at || run.created_at)}
                    </Text>
                  </TouchableOpacity>
                  {stoppable ? (
                    <TouchableOpacity
                      style={styles.stopBtn}
                      disabled={isStopping}
                      onPress={() => stopRun(run)}
                      accessibilityLabel="Stop all jobs in this run"
                    >
                      {isStopping ? (
                        <ActivityIndicator color={colors.red400} size="small" />
                      ) : (
                        <Text style={styles.stopBtnText}>Stop all</Text>
                      )}
                    </TouchableOpacity>
                  ) : null}
                </View>
                {run.branch ? (
                  <TouchableOpacity
                    onPress={() => openDetail(run)}
                    accessibilityLabel="Open run detail"
                  >
                    <Text style={styles.runMeta} numberOfLines={1}>
                      {run.branch}
                      {run.trigger ? ` · ${run.trigger}` : ''}
                    </Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            );
          })}
        </View>

        {selectedRun && (
          <View style={styles.detailCard}>
            <View style={styles.detailHeader}>
              <Text style={styles.detailTitle}>Run detail</Text>
              <TouchableOpacity
                onPress={() => {
                  setSelectedRun(null);
                  setDetail(null);
                }}
              >
                <Text style={styles.refresh}>Close</Text>
              </TouchableOpacity>
            </View>
            {detailLoading ? (
              <ActivityIndicator color={colors.gray400} />
            ) : detail?.error ? (
              <Text style={styles.error}>{detail.error}</Text>
            ) : (
              <Text style={styles.detailJson}>
                {JSON.stringify(detail || selectedRun, null, 2)}
              </Text>
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.gray950 },
  content: { padding: 16, paddingBottom: 32 },
  ciSection: { marginTop: 24, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.gray800 },
  ciHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  ciTitle: { fontSize: 16, fontWeight: '600', color: colors.white },
  refresh: { fontSize: 13, color: colors.blue400 },
  empty: { fontSize: 13, color: colors.gray500 },
  error: { fontSize: 13, color: colors.red400, marginBottom: 8 },
  runCard: {
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  runRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  runRowMain: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  runStatus: { fontSize: 14, color: colors.gray200, fontWeight: '600', flex: 1 },
  stopBtn: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.red400,
    marginLeft: 8,
  },
  stopBtnText: { fontSize: 12, color: colors.red400, fontWeight: '600' },
  runTime: { fontSize: 11, color: colors.gray500 },
  runMeta: { fontSize: 12, color: colors.gray500, marginTop: 4, fontFamily: 'monospace' },
  detailCard: {
    marginTop: 16,
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  detailHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  detailTitle: { fontSize: 14, fontWeight: '600', color: colors.white },
  detailJson: { fontSize: 11, color: colors.gray400, fontFamily: 'monospace' },
});
