import React, { useState, useEffect, useCallback, useMemo } from 'react';
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
import ProjectScreenHeader from '../components/ProjectScreenHeader';

type Granularity = 'day' | 'week' | 'month';

interface StatBucket {
  start: string;
  label: string;
}
interface ProjectStats {
  granularity: Granularity;
  buckets: StatBucket[];
  series: Record<string, number[]>;
  totals: Record<string, number>;
  model_usage: Array<{ model: string; count: number }>;
  top_model: string | null;
}

const METRICS: Array<{ key: string; label: string; color: string }> = [
  { key: 'prs_merged', label: 'PRs merged', color: colors.emerald400 },
  { key: 'support_tickets_resolved', label: 'Support resolved', color: colors.blue400 },
  { key: 'tickets_made', label: 'Tickets made', color: colors.indigo500 },
  { key: 'tickets_completed', label: 'Tickets completed', color: colors.purple500 },
  { key: 'epics_completed', label: 'Epics completed', color: colors.amber400 },
];

const GRANULARITIES: Array<{ value: Granularity; label: string }> = [
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
];

const MONTH_ABBR = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function fmtWindowEndpoint(startIso: string, granularity: Granularity): string {
  const [y, m, d] = startIso.split('-').map((n) => Number.parseInt(n, 10));
  if (!y || !m) return startIso;
  const mon = MONTH_ABBR[m - 1] ?? '';
  if (granularity === 'month') return `${mon} ${y}`;
  return `${mon} ${d}, ${y}`;
}

/**
 * Human label for the window the totals/series cover, e.g.
 * "30 days · Jun 21, 2026 to Jul 20, 2026". Without it the window-scoped summary
 * cards look frozen when toggling granularity on a young project whose data all
 * falls inside the shortest (daily) window.
 */
export function formatStatsWindow(granularity: Granularity, buckets: StatBucket[]): string {
  if (buckets.length === 0) return '';
  const unit = granularity === 'day' ? 'days' : granularity === 'week' ? 'weeks' : 'months';
  const count = `${buckets.length} ${unit}`;
  const start = fmtWindowEndpoint(buckets[0].start, granularity);
  const end = fmtWindowEndpoint(buckets[buckets.length - 1].start, granularity);
  return start === end ? `${count} · ${start}` : `${count} · ${start} to ${end}`;
}

function BarRow({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(1, ...values);
  return (
    <View style={styles.barRow}>
      {values.map((v, i) => (
        <View key={i} style={styles.barTrack}>
          <View
            style={{
              width: '100%',
              height: `${(v / max) * 100}%`,
              backgroundColor: color,
              borderRadius: 2,
            }}
          />
        </View>
      ))}
    </View>
  );
}

export default function StatsScreen({ route, navigation }: any) {
  const { projectId, project: routeProject } = route.params || {};
  const project = routeProject;
  const [granularity, setGranularity] = useState<Granularity>('day');
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const data = (await api.getProjectStats(projectId, { granularity })) as ProjectStats;
      setStats(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load stats');
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, [projectId, granularity]);

  useEffect(() => {
    load();
  }, [load]);

  const totalModelMessages = useMemo(
    () => (stats?.model_usage ?? []).reduce((sum, m) => sum + m.count, 0),
    [stats],
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ProjectScreenHeader title="Stats" project={project} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.granularityRow}>
          {GRANULARITIES.map((g) => (
            <TouchableOpacity
              key={g.value}
              onPress={() => setGranularity(g.value)}
              style={[styles.granBtn, granularity === g.value && styles.granBtnActive]}
            >
              <Text style={[styles.granText, granularity === g.value && styles.granTextActive]}>
                {g.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {error && <Text style={styles.error}>{error}</Text>}
        {loading && !stats && (
          <ActivityIndicator color={colors.indigo400} style={{ marginTop: 24 }} />
        )}

        {stats && (
          <>
            <Text style={styles.windowLabel}>{formatStatsWindow(granularity, stats.buckets)}</Text>
            <View style={styles.totalsGrid}>
              {METRICS.map((m) => (
                <View key={m.key} style={styles.totalCard}>
                  <Text style={styles.totalValue}>{stats.totals[m.key] ?? 0}</Text>
                  <Text style={styles.totalLabel}>{m.label}</Text>
                </View>
              ))}
              <View style={styles.totalCard}>
                <Text style={styles.totalValueSm} numberOfLines={1}>
                  {stats.top_model ?? '—'}
                </Text>
                <Text style={styles.totalLabel}>Most-used model</Text>
              </View>
            </View>

            {METRICS.map((m) => (
              <View key={m.key} style={styles.chartCard}>
                <View style={styles.chartHeader}>
                  <Text style={styles.chartLabel}>{m.label}</Text>
                  <Text style={styles.chartTotal}>{stats.totals[m.key] ?? 0} total</Text>
                </View>
                <BarRow values={stats.series[m.key] ?? []} color={m.color} />
                <View style={styles.axisRow}>
                  <Text style={styles.axisText}>{stats.buckets[0]?.label}</Text>
                  <Text style={styles.axisText}>
                    {stats.buckets[stats.buckets.length - 1]?.label}
                  </Text>
                </View>
              </View>
            ))}

            <View style={styles.chartCard}>
              <Text style={styles.chartLabel}>Model usage</Text>
              {stats.model_usage.length === 0 ? (
                <Text style={styles.axisText}>No model usage in this window.</Text>
              ) : (
                stats.model_usage.map((row) => (
                  <View key={row.model} style={styles.modelRow}>
                    <Text style={styles.modelName} numberOfLines={1}>
                      {row.model}
                    </Text>
                    <View style={styles.modelTrack}>
                      <View
                        style={{
                          height: '100%',
                          width: `${totalModelMessages ? (row.count / totalModelMessages) * 100 : 0}%`,
                          backgroundColor: colors.indigo500,
                          borderRadius: 4,
                        }}
                      />
                    </View>
                    <Text style={styles.modelCount}>{row.count}</Text>
                  </View>
                ))
              )}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray900 },
  content: { padding: 16, paddingBottom: 48 },
  granularityRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  granBtn: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: colors.gray800,
  },
  granBtnActive: { backgroundColor: colors.indigo600 },
  granText: { color: colors.gray300, fontSize: 13 },
  granTextActive: { color: colors.white, fontWeight: '600' },
  error: { color: colors.red400, marginBottom: 12 },
  windowLabel: { color: colors.gray500, fontSize: 11, marginBottom: 8 },
  totalsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  totalCard: {
    width: '31%',
    backgroundColor: colors.gray800,
    borderRadius: 12,
    padding: 12,
  },
  totalValue: { color: colors.white, fontSize: 22, fontWeight: '700' },
  totalValueSm: { color: colors.white, fontSize: 14, fontWeight: '600' },
  totalLabel: { color: colors.gray400, fontSize: 11, marginTop: 2 },
  chartCard: {
    backgroundColor: colors.gray800,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  chartHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  chartLabel: { color: colors.gray300, fontSize: 13 },
  chartTotal: { color: colors.gray500, fontSize: 11 },
  barRow: { flexDirection: 'row', alignItems: 'flex-end', height: 56, gap: 2 },
  barTrack: {
    flex: 1,
    height: '100%',
    justifyContent: 'flex-end',
    backgroundColor: colors.gray700_40,
    borderRadius: 2,
  },
  axisRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  axisText: { color: colors.gray500, fontSize: 10 },
  modelRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  modelName: { color: colors.gray300, fontSize: 12, width: 120 },
  modelTrack: {
    flex: 1,
    height: 8,
    backgroundColor: colors.gray700,
    borderRadius: 4,
    overflow: 'hidden',
  },
  modelCount: { color: colors.gray400, fontSize: 12, width: 40, textAlign: 'right' },
});
