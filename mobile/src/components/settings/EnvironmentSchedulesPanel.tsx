import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { CalendarClock, Plus, Power, PowerOff, Trash2 } from 'lucide-react-native';
import humanCron from '@shared/utils/humanCron';
import { colors } from '../../theme/colors';
import { api } from '../../utils/api';
import {
  describeSchedule,
  sortSchedules,
  validateScheduleDraft,
  type DeploySchedule,
} from '../../utils/deploySchedules';

/**
 * Presentational body for the per-environment deploy-schedules editor. Pure and
 * props-driven so it can be render-tested (react-dom/server) without effects or
 * a live API — mirrors the EnvironmentTriggersPanelContent split.
 */
export function EnvironmentSchedulesPanelContent({
  environmentName,
  schedules,
  loading,
  error,
  actionKey,
  refValue,
  cron,
  timezone,
  adding,
  onRefChange,
  onCronChange,
  onTimezoneChange,
  onAdd,
  onToggle,
  onDelete,
}: {
  environmentName: string;
  schedules: DeploySchedule[];
  loading: boolean;
  error: string | null;
  actionKey: string | null;
  refValue: string;
  cron: string;
  timezone: string;
  adding: boolean;
  onRefChange: (value: string) => void;
  onCronChange: (value: string) => void;
  onTimezoneChange: (value: string) => void;
  onAdd: () => void;
  onToggle: (schedule: DeploySchedule) => void;
  onDelete: (schedule: DeploySchedule) => void;
}) {
  const sorted = sortSchedules(schedules);
  const canAdd = !!refValue.trim() && !!cron.trim() && !adding;
  return (
    <View style={styles.panel} testID={`env-schedules-${environmentName}`}>
      <View style={styles.headerRow}>
        <CalendarClock size={13} color={colors.blue300} />
        <Text style={styles.title}>Deploy schedules</Text>
      </View>
      <Text style={styles.help}>
        A schedule deploys a ref to {environmentName} on a cron, under your identity. Disabling a
        schedule pauses it without deleting it.
      </Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {loading && schedules.length === 0 ? (
        <ActivityIndicator color={colors.gray400} />
      ) : sorted.length === 0 ? (
        <Text style={styles.empty}>No schedules yet. Add one below.</Text>
      ) : (
        sorted.map((schedule) => {
          const toggleKey = `toggle:${schedule.id}`;
          const deleteKey = `delete:${schedule.id}`;
          const human = humanCron(schedule.cron);
          return (
            <View
              key={schedule.id}
              style={[styles.scheduleRow, !schedule.enabled && styles.disabledRow]}
              testID={`schedule-row-${schedule.id}`}
            >
              <View style={styles.refBadge}>
                <Text style={styles.refBadgeText} numberOfLines={1}>
                  {schedule.ref}
                </Text>
              </View>
              <View style={styles.scheduleBody}>
                <Text style={styles.cron} numberOfLines={1}>
                  {schedule.cron}
                </Text>
                <Text style={styles.cronHuman} numberOfLines={1}>
                  {human !== schedule.cron ? human : ''}
                  {schedule.timezone ? ` · ${schedule.timezone}` : ''}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => onToggle(schedule)}
                disabled={actionKey === toggleKey}
                style={[styles.smallButton, actionKey === toggleKey && styles.disabled]}
                accessibilityLabel={`${schedule.enabled ? 'Disable' : 'Enable'} schedule`}
              >
                {actionKey === toggleKey ? (
                  <ActivityIndicator color={colors.gray300} size="small" />
                ) : schedule.enabled ? (
                  <PowerOff size={12} color={colors.gray300} />
                ) : (
                  <Power size={12} color={colors.emerald300} />
                )}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => onDelete(schedule)}
                disabled={actionKey === deleteKey}
                style={[styles.smallButton, actionKey === deleteKey && styles.disabled]}
                accessibilityLabel="Delete schedule"
              >
                {actionKey === deleteKey ? (
                  <ActivityIndicator color={colors.gray300} size="small" />
                ) : (
                  <Trash2 size={12} color={colors.gray300} />
                )}
              </TouchableOpacity>
            </View>
          );
        })
      )}

      <View style={styles.addBlock}>
        <TextInput
          value={refValue}
          onChangeText={onRefChange}
          placeholder="ref to deploy (e.g. main)"
          placeholderTextColor={colors.gray600}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          accessibilityLabel="Ref"
        />
        <TextInput
          value={cron}
          onChangeText={onCronChange}
          placeholder="cron (e.g. 0 9 * * *)"
          placeholderTextColor={colors.gray600}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          accessibilityLabel="Cron expression"
        />
        <TextInput
          value={timezone}
          onChangeText={onTimezoneChange}
          placeholder="timezone (optional, e.g. America/New_York)"
          placeholderTextColor={colors.gray600}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          accessibilityLabel="Timezone"
        />
        <TouchableOpacity
          onPress={onAdd}
          disabled={!canAdd}
          style={[styles.addButton, !canAdd && styles.disabled]}
          accessibilityLabel="Add schedule"
        >
          {adding ? (
            <ActivityIndicator color={colors.emerald300} size="small" />
          ) : (
            <Plus size={13} color={colors.emerald300} />
          )}
          <Text style={styles.addButtonText}>Add schedule</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/**
 * Per-environment deploy-schedules editor (mobile). Owns state + API calls and
 * delegates rendering to {@link EnvironmentSchedulesPanelContent}. Mirrors the
 * web EnvironmentSchedulesPanel: list cron deploy schedules for one environment
 * and add / enable / disable / delete them without editing deploy.yaml.
 */
export default function EnvironmentSchedulesPanel({
  projectId,
  environmentName,
  onNotify,
}: {
  projectId: string;
  environmentName: string;
  onNotify?: (message: string, type?: string) => void;
}) {
  const [schedules, setSchedules] = useState<DeploySchedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [ref, setRef] = useState('');
  const [cron, setCron] = useState('0 9 * * *');
  const [timezone, setTimezone] = useState('');
  const [adding, setAdding] = useState(false);

  const notify = useCallback(
    (message: string, type: string = 'info') => onNotify?.(message, type),
    [onNotify],
  );

  const load = useCallback(async () => {
    if (!projectId || !environmentName) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.listDeploySchedules(projectId, environmentName);
      setSchedules(res?.schedules || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load schedules');
    } finally {
      setLoading(false);
    }
  }, [projectId, environmentName]);

  useEffect(() => {
    load();
  }, [load]);

  const addSchedule = useCallback(async () => {
    const draft = { ref, cron };
    const validationError = validateScheduleDraft(draft);
    if (validationError) {
      notify(validationError, 'error');
      return;
    }
    setAdding(true);
    try {
      const res = await api.createDeploySchedule(projectId, environmentName, {
        ref: draft.ref.trim(),
        cron: draft.cron.trim(),
        timezone: timezone.trim() || null,
      });
      if (res?.schedule) setSchedules((prev) => [...prev, res.schedule]);
      setRef('');
      setTimezone('');
      notify(`Schedule added to ${environmentName}`, 'success');
    } catch (e: any) {
      notify(e?.message || 'Failed to add schedule', 'error');
    } finally {
      setAdding(false);
    }
  }, [projectId, environmentName, ref, cron, timezone, notify]);

  const toggleSchedule = useCallback(
    async (schedule: DeploySchedule) => {
      const key = `toggle:${schedule.id}`;
      setActionKey(key);
      try {
        const res = await api.updateDeploySchedule(projectId, environmentName, schedule.id, {
          enabled: !schedule.enabled,
        });
        if (res?.schedule) {
          setSchedules((prev) => prev.map((s) => (s.id === schedule.id ? res.schedule : s)));
        }
        notify(`Schedule ${!schedule.enabled ? 'enabled' : 'disabled'}`, 'success');
      } catch (e: any) {
        notify(e?.message || 'Failed to update schedule', 'error');
      } finally {
        setActionKey(null);
      }
    },
    [projectId, environmentName, notify],
  );

  const doDelete = useCallback(
    async (schedule: DeploySchedule) => {
      const key = `delete:${schedule.id}`;
      setActionKey(key);
      try {
        await api.deleteDeploySchedule(projectId, environmentName, schedule.id);
        setSchedules((prev) => prev.filter((s) => s.id !== schedule.id));
        notify('Schedule deleted', 'success');
      } catch (e: any) {
        notify(e?.message || 'Failed to delete schedule', 'error');
      } finally {
        setActionKey(null);
      }
    },
    [projectId, environmentName, notify],
  );

  const confirmDelete = useCallback(
    (schedule: DeploySchedule) => {
      Alert.alert('Delete schedule', `Delete the schedule "${describeSchedule(schedule)}"?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => doDelete(schedule) },
      ]);
    },
    [doDelete],
  );

  return (
    <EnvironmentSchedulesPanelContent
      environmentName={environmentName}
      schedules={schedules}
      loading={loading}
      error={error}
      actionKey={actionKey}
      refValue={ref}
      cron={cron}
      timezone={timezone}
      adding={adding}
      onRefChange={setRef}
      onCronChange={setCron}
      onTimezoneChange={setTimezone}
      onAdd={addSchedule}
      onToggle={toggleSchedule}
      onDelete={confirmDelete}
    />
  );
}

const styles = StyleSheet.create({
  panel: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 10,
    gap: 6,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { color: colors.gray200, fontSize: 12, fontWeight: '600' },
  help: { color: colors.gray500, fontSize: 11, lineHeight: 15 },
  error: { color: colors.red400, fontSize: 12 },
  empty: { color: colors.gray500, fontSize: 12, textAlign: 'center', paddingVertical: 8 },
  scheduleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray950,
    borderRadius: 6,
    padding: 8,
  },
  disabledRow: { opacity: 0.6 },
  refBadge: {
    borderWidth: 1,
    borderColor: colors.blue500,
    backgroundColor: colors.blue900_40,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    maxWidth: 110,
  },
  refBadgeText: { color: colors.blue300, fontSize: 10, fontWeight: '600', fontFamily: 'monospace' },
  scheduleBody: { flex: 1 },
  cron: { color: colors.gray200, fontSize: 12, fontFamily: 'monospace' },
  cronHuman: { color: colors.gray500, fontSize: 10 },
  smallButton: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    padding: 6,
  },
  addBlock: {
    gap: 6,
    marginTop: 6,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
    paddingTop: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    backgroundColor: colors.gray950,
    color: colors.gray200,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 12,
    fontFamily: 'monospace',
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: colors.emerald500,
    backgroundColor: colors.emerald900_40,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  addButtonText: { color: colors.emerald300, fontSize: 12, fontWeight: '500' },
  disabled: { opacity: 0.5 },
});
