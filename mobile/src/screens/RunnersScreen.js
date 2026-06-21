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
import ProjectDefaultAutomationSection from '../components/settings/ProjectDefaultAutomationSection';

const STATUS_COLOR = {
  success: colors.emerald400,
  failure: colors.red400,
  running: colors.amber400,
  queued: colors.gray400,
  cancelled: colors.gray500,
};

export default function RunnersScreen({ route, navigation }) {
  const { projectId, project: routeProject } = route.params || {};
  const project = routeProject;

  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedRun, setSelectedRun] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadRuns = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.getCiRuns(projectId, { limit: 30 });
      setRuns(data?.runs || []);
    } catch (err) {
      setError(err?.message || 'Failed to load CI runs');
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadRuns();
    const id = setInterval(loadRuns, 60_000);
    return () => clearInterval(id);
  }, [loadRuns]);

  const openDetail = async (run) => {
    setSelectedRun(run);
    setDetail(null);
    setDetailLoading(true);
    try {
      const data = await api.getCiRunDetail(projectId, run.id);
      setDetail(data);
    } catch (err) {
      setDetail({ error: err?.message || 'Failed to load run detail' });
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ProjectScreenHeader title="Runners" project={project} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.content}>
        <FinalizeSection navigation={navigation} fixedProjectId={projectId} />

        <ProjectDefaultAutomationSection projectId={projectId} />

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
          {runs.map((run) => {
            const color = STATUS_COLOR[run.status] || colors.gray400;
            return (
              <TouchableOpacity key={run.id} style={styles.runCard} onPress={() => openDetail(run)}>
                <View style={styles.runRow}>
                  <View style={[styles.statusDot, { backgroundColor: color }]} />
                  <Text style={styles.runStatus}>{run.status || 'unknown'}</Text>
                  <Text style={styles.runTime}>{relativeTime(run.started_at || run.created_at)}</Text>
                </View>
                {run.branch ? (
                  <Text style={styles.runMeta} numberOfLines={1}>
                    {run.branch}
                    {run.trigger ? ` · ${run.trigger}` : ''}
                  </Text>
                ) : null}
              </TouchableOpacity>
            );
          })}
        </View>

        {selectedRun && (
          <View style={styles.detailCard}>
            <View style={styles.detailHeader}>
              <Text style={styles.detailTitle}>Run detail</Text>
              <TouchableOpacity onPress={() => { setSelectedRun(null); setDetail(null); }}>
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
  ciHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
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
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  runStatus: { fontSize: 14, color: colors.gray200, fontWeight: '600', flex: 1 },
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
