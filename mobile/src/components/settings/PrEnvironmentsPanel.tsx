import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { api } from '../../utils/api';
import { colors } from '../../theme/colors';
import {
  prEnvironmentLimitsNote,
  prEnvironmentRowView,
  type PrEnvironmentLimitsView,
  type PrEnvironmentListItem,
} from '@shared/utils/prEnvironmentSettings';
import { createSerialQueue } from '@shared/utils/serialQueue';

type LimitKey = keyof PrEnvironmentLimitsView;

interface SettingsResponse {
  limits: PrEnvironmentLimitsView;
  overrides: Partial<PrEnvironmentLimitsView>;
  defaults: PrEnvironmentLimitsView;
  enforced?: PrEnvironmentLimitsView;
  wakeOnRequest?: boolean;
  environments: PrEnvironmentListItem[];
}

const FIELDS: Array<{ key: LimitKey; label: string }> = [
  { key: 'maxConcurrent', label: 'Max running envs' },
  { key: 'idleTtlMinutes', label: 'Sleep when idle after (min)' },
  { key: 'maxLifetimeDays', label: 'Stop without a push after (days)' },
];

const TONE_COLOR: Record<string, string> = {
  ok: colors.emerald400,
  busy: colors.sky300,
  error: colors.red400,
  idle: colors.gray400,
};

/** Build the limits PUT body: changed values only; an emptied override resets (null). */
export function limitsPatchFrom(
  data: Pick<SettingsResponse, 'limits' | 'overrides'>,
  draft: Record<LimitKey, string>,
): { patch: Partial<Record<LimitKey, number | null>> } | { error: string } {
  const patch: Partial<Record<LimitKey, number | null>> = {};
  for (const { key } of FIELDS) {
    const raw = draft[key].trim();
    if (raw === '') {
      if (data.overrides[key] !== undefined) patch[key] = null;
      continue;
    }
    const n = Number(raw);
    if (!Number.isInteger(n)) return { error: `${key} must be a whole number` };
    if (n !== data.limits[key]) patch[key] = n;
  }
  return { patch };
}

/**
 * PR environments of a project (web `PrEnvironmentsPanel` parity): each one
 * with status, age, last request, and Stop, plus the cost controls.
 */
export default function PrEnvironmentsPanel({ projectId }: { projectId: string }) {
  // Keyed by project: switching projects remounts with empty state, so one
  // project's environments, limits, and in-flight responses can never drive
  // another project's Stop or Save.
  return <ProjectPrEnvironments key={projectId} projectId={projectId} />;
}

function ProjectPrEnvironments({ projectId }: { projectId: string }) {
  // A response that lands after unmount (project switch) is dropped.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<Record<LimitKey, string>>({
    maxConcurrent: '',
    idleTtlMinutes: '',
    maxLifetimeDays: '',
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [stopping, setStopping] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Every request of this panel goes out one at a time, in order: a refresh
  // issued during a save is sent after it and reads the saved state.
  const queue = useRef(createSerialQueue());

  const apply = (res: SettingsResponse | null | undefined) => {
    if (!mounted.current) return;
    if (!res?.limits) {
      setData(null);
      return;
    }
    setData(res);
    setDraft({
      maxConcurrent: String(res.limits.maxConcurrent),
      idleTtlMinutes: String(res.limits.idleTtlMinutes),
      maxLifetimeDays: String(res.limits.maxLifetimeDays),
    });
  };

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      apply(
        (await queue.current.run(() =>
          api.getProjectPrEnvironments(projectId),
        )) as SettingsResponse,
      );
    } catch (err: any) {
      if (mounted.current) setError(err?.message || 'Failed to load PR environments');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = async () => {
    if (!data) return;
    const built = limitsPatchFrom(data, draft);
    if ('error' in built) {
      setError(built.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      apply(
        (await queue.current.run(() =>
          api.updateProjectPrEnvironmentLimits(projectId, built.patch),
        )) as SettingsResponse,
      );
    } catch (err: any) {
      if (mounted.current) {
        setError(err?.message || 'Failed to save limits');
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const stop = async (prNumber: number) => {
    if (stopping != null) return;
    setStopping(prNumber);
    setError(null);
    try {
      await queue.current.run(() => api.stopPullPreview(projectId, prNumber));
      await reload();
    } catch (err: any) {
      if (mounted.current) setError(err?.message || 'Failed to stop the environment');
    } finally {
      if (mounted.current) setStopping(null);
    }
  };

  const envs = data?.environments ?? [];
  const now = Date.now();

  return (
    <View style={styles.card} testID="pr-environments-panel">
      <View style={styles.headerRow}>
        <Text style={styles.title}>PR environments</Text>
        <TouchableOpacity onPress={() => void reload()} disabled={loading}>
          <Text style={styles.link}>{loading ? 'Loading…' : 'Refresh'}</Text>
        </TouchableOpacity>
      </View>
      {data ? <Text style={styles.hint}>{prEnvironmentLimitsNote(data)}</Text> : null}
      {data
        ? FIELDS.map(({ key, label }) => (
            <View key={key} style={styles.fieldRow}>
              <Text style={styles.fieldLabel}>{label}</Text>
              <TextInput
                value={draft[key]}
                onChangeText={(v) => setDraft((d) => ({ ...d, [key]: v }))}
                placeholder={String(data.defaults[key])}
                placeholderTextColor={colors.gray500}
                keyboardType="number-pad"
                style={styles.input}
                testID={`pr-env-limit-${key}`}
              />
            </View>
          ))
        : null}
      {data ? (
        <TouchableOpacity
          onPress={() => void save()}
          disabled={saving}
          style={styles.saveBtn}
          testID="pr-env-limits-save"
        >
          <Text style={styles.saveText}>{saving ? 'Saving…' : 'Save limits'}</Text>
        </TouchableOpacity>
      ) : null}
      {data ? <Text style={styles.hint}>0 turns a limit off; empty uses the default.</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {!loading && data && envs.length === 0 ? (
        <Text style={styles.hint}>No PR environments for this project.</Text>
      ) : null}
      {envs.map((env) => {
        const view = prEnvironmentRowView(env, now);
        return (
          <View key={env.id} style={styles.row} testID={`pr-env-row-${env.prNumber}`}>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>
                PR #{env.prNumber}
                {env.headBranch ? ` · ${env.headBranch}` : ''}
              </Text>
              <Text style={[styles.status, { color: TONE_COLOR[view.tone] }]}>
                {view.statusLabel}
              </Text>
              <Text style={styles.meta}>
                age {view.age} · last hit {view.lastHit}
              </Text>
            </View>
            {view.canStop ? (
              <TouchableOpacity
                onPress={() => void stop(env.prNumber)}
                disabled={stopping != null}
                style={styles.stopBtn}
                testID={`pr-env-stop-${env.prNumber}`}
              >
                {stopping === env.prNumber ? (
                  <ActivityIndicator size="small" color={colors.gray200} />
                ) : (
                  <Text style={styles.stopText}>Stop</Text>
                )}
              </TouchableOpacity>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 12,
    padding: 14,
    marginTop: 16,
    marginBottom: 12,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 14, fontWeight: '600', color: colors.gray200 },
  link: { fontSize: 12, color: colors.gray400, textDecorationLine: 'underline' },
  hint: { fontSize: 11, color: colors.gray500, marginTop: 6, lineHeight: 15 },
  error: { fontSize: 12, color: colors.red400, marginTop: 6 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 8 },
  fieldLabel: { flex: 1, fontSize: 12, color: colors.gray400 },
  input: {
    width: 72,
    backgroundColor: colors.gray950,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    color: colors.gray100,
    fontSize: 13,
  },
  saveBtn: {
    alignSelf: 'flex-start',
    backgroundColor: colors.emerald600,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginTop: 10,
  },
  saveText: { fontSize: 13, color: colors.white, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
    paddingTop: 10,
    marginTop: 10,
    gap: 8,
  },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 13, color: colors.gray200 },
  status: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', marginTop: 2 },
  meta: { fontSize: 11, color: colors.gray500, marginTop: 2 },
  stopBtn: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  stopText: { fontSize: 12, color: colors.gray200 },
});
