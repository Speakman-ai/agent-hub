import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { api } from '../../utils/api';
import { colors } from '../../theme/colors';

/**
 * Mobile parity for the web JobQueueSection — Admin observability pane for
 * the host-wide background job queue (heartbeats, crons, autonomous tasks).
 * Lists jobs with a status filter, requeues a dead-lettered job, deletes a
 * row. Backed by GET/POST/DELETE /api/jobs (server enforces the Admin gate).
 */

type JobStatus = 'queued' | 'running' | 'done' | 'dead_letter';

interface JobRow {
    id: string;
    type: string;
    status: JobStatus;
    attempts: number;
    max_attempts: number;
    last_error: string | null;
    created_at: number;
}

interface JobsResponse {
    jobs: JobRow[];
    counts: { queued: number; running: number; done: number; dead_letter: number; total: number };
    types: string[];
}

export const STATUS_FILTERS: Array<{ value: string; label: string }> = [
    { value: '', label: 'All' },
    { value: 'queued', label: 'Queued' },
    { value: 'running', label: 'Running' },
    { value: 'done', label: 'Done' },
    { value: 'dead_letter', label: 'Dead-letter' },
];

/** Only dead-lettered jobs can be requeued (mirrors the web pane + server). */
export function jobIsRetryable(status: JobStatus): boolean {
    return status === 'dead_letter';
}

const STATUS_COLOR: Record<JobStatus, string> = {
    queued: colors.blue500,
    running: colors.amber400,
    done: colors.emerald400,
    dead_letter: colors.red400,
};

export default function JobQueueSection() {
    const [data, setData] = useState<JobsResponse | null>(null);
    const [statusFilter, setStatusFilter] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);

    const load = useCallback(() => {
        setLoading(true);
        setError(null);
        api
            .getJobs({ status: statusFilter || undefined, limit: 200 })
            .then((res: JobsResponse) => setData(res))
            .catch((err: any) => setError(err?.message || 'Failed to load jobs'))
            .finally(() => setLoading(false));
    }, [statusFilter]);

    useEffect(() => {
        load();
    }, [load]);

    const handleRetry = async (id: string) => {
        setBusyId(id);
        setError(null);
        try {
            await api.retryJob(id);
            load();
        } catch (err: any) {
            setError(err?.message || 'Failed to retry job');
        } finally {
            setBusyId(null);
        }
    };

    const handleDelete = async (id: string) => {
        setBusyId(id);
        setError(null);
        try {
            await api.deleteJob(id);
            load();
        } catch (err: any) {
            setError(err?.message || 'Failed to delete job');
        } finally {
            setBusyId(null);
        }
    };

    const counts = data?.counts;
    const jobs = data?.jobs ?? [];

    return (<View style={styles.container}>
      <Text style={styles.title}>Background Jobs</Text>
      <Text style={styles.hint}>
        Host-wide job queue drained by heartbeats, crons, and autonomous tasks. Retry a dead-lettered
        job or delete a stale row.
      </Text>

      {counts ? (<View style={styles.countsRow}>
          {(['total', 'queued', 'running', 'done', 'dead_letter'] as const).map((k) => (<View key={k} style={styles.countCard}>
              <Text style={styles.countLabel}>{k === 'dead_letter' ? 'Dead' : k}</Text>
              <Text style={[styles.countValue, k === 'dead_letter' && counts.dead_letter > 0 ? { color: colors.red400 } : null]}>
                {counts[k]}
              </Text>
            </View>))}
        </View>) : null}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
        {STATUS_FILTERS.map((f) => (<TouchableOpacity key={f.value} style={[styles.chip, statusFilter === f.value && styles.chipActive]} onPress={() => setStatusFilter(f.value)} testID={`jobs-filter-${f.value || 'all'}`}>
            <Text style={[styles.chipText, statusFilter === f.value && styles.chipTextActive]}>
              {f.label}
            </Text>
          </TouchableOpacity>))}
      </ScrollView>

      {error ? (<View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>) : null}

      {loading && !data ? (<ActivityIndicator color={colors.gray400} style={{ marginTop: 12 }}/>) : jobs.length === 0 ? (<Text style={styles.muted}>No jobs match this filter.</Text>) : (jobs.map((job) => (<View key={job.id} style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.jobType} numberOfLines={1}>
                {job.type}
              </Text>
              <View style={[styles.badge, { borderColor: STATUS_COLOR[job.status] }]}>
                <Text style={[styles.badgeText, { color: STATUS_COLOR[job.status] }]}>
                  {job.status === 'dead_letter' ? 'dead-letter' : job.status}
                </Text>
              </View>
            </View>
            <Text style={styles.meta}>
              Attempts {job.attempts}/{job.max_attempts}
            </Text>
            {job.last_error ? (<Text style={styles.errorMsg} numberOfLines={3}>
                {job.last_error}
              </Text>) : null}
            <View style={styles.actionRow}>
              {jobIsRetryable(job.status) ? (<TouchableOpacity style={[styles.actionBtn, styles.retryBtn]} disabled={busyId === job.id} onPress={() => handleRetry(job.id)} testID={`jobs-retry-${job.id}`}>
                  <Text style={styles.retryText}>Retry</Text>
                </TouchableOpacity>) : null}
              <TouchableOpacity style={[styles.actionBtn, styles.deleteBtn]} disabled={busyId === job.id} onPress={() => handleDelete(job.id)} testID={`jobs-delete-${job.id}`}>
                <Text style={styles.deleteText}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>)))}
    </View>);
}

const styles = StyleSheet.create({
    container: { gap: 8 },
    title: { fontSize: 16, fontWeight: '600', color: colors.white },
    hint: { fontSize: 12, color: colors.gray500, marginBottom: 8 },
    countsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
    countCard: {
        backgroundColor: colors.gray800,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 6,
        minWidth: 56,
    },
    countLabel: { fontSize: 10, color: colors.gray500, textTransform: 'uppercase' },
    countValue: { fontSize: 18, fontWeight: '700', color: colors.white },
    chipRow: { marginBottom: 8 },
    chip: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: colors.gray800,
        marginRight: 6,
    },
    chipActive: { borderColor: colors.indigo500, backgroundColor: colors.indigo900_40 },
    chipText: { fontSize: 12, color: colors.gray400 },
    chipTextActive: { color: colors.white },
    card: {
        backgroundColor: colors.gray900,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.gray800,
        padding: 10,
        marginBottom: 8,
    },
    cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    jobType: { fontSize: 13, fontWeight: '600', color: colors.gray200, flex: 1 },
    badge: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
    badgeText: { fontSize: 10 },
    meta: { fontSize: 11, color: colors.gray500, marginTop: 4 },
    errorMsg: { fontSize: 11, color: colors.gray400, marginTop: 4 },
    actionRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
    actionBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
    retryBtn: { backgroundColor: colors.indigo900_40 },
    retryText: { fontSize: 12, color: colors.indigo300 },
    deleteBtn: { backgroundColor: colors.gray800 },
    deleteText: { fontSize: 12, color: colors.red400 },
    errorBox: {
        backgroundColor: colors.red900_50,
        borderRadius: 8,
        padding: 10,
        marginBottom: 8,
    },
    errorText: { fontSize: 12, color: colors.red400 },
    muted: { color: colors.gray500, fontSize: 12 },
});
