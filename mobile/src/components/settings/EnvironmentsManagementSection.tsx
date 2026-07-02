import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { CalendarClock, ChevronDown, ChevronRight, Mail, Pause, Play, RefreshCw, ShieldCheck, Trash2, Zap } from 'lucide-react-native';
import { colors } from '../../theme/colors';
import { api } from '../../utils/api';
import EnvironmentTriggersPanel from './EnvironmentTriggersPanel';
import EnvironmentSchedulesPanel from './EnvironmentSchedulesPanel';
import EnvironmentNotificationRoutingPanel from './EnvironmentNotificationRoutingPanel';
import {
  environmentStatus,
  environmentStatusLabel,
  hasRuntimeConfig,
  shortDeploymentRef,
  sortEnvironmentsForDisplay,
  type EnvironmentStatus,
} from '../../utils/deployments';

const STATUS_STYLE: Record<EnvironmentStatus, { borderColor: string; backgroundColor: string; color: string }> =
  {
    deployable: {
      borderColor: colors.emerald500,
      backgroundColor: colors.emerald900_40,
      color: colors.emerald300,
    },
    paused: {
      borderColor: colors.amber400,
      backgroundColor: colors.amber900_40,
      color: colors.amber400,
    },
    orphaned: {
      borderColor: colors.gray600,
      backgroundColor: colors.gray700_40,
      color: colors.gray300,
    },
  };

export default function EnvironmentsManagementSection({
  projectId,
  onNotify,
}: {
  projectId?: string | null;
  onNotify?: (message: string, type?: string) => void;
}) {
  const [environments, setEnvironments] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [expandedTriggers, setExpandedTriggers] = useState<Record<string, boolean>>({});
  const [expandedSchedules, setExpandedSchedules] = useState<Record<string, boolean>>({});
  const [expandedRouting, setExpandedRouting] = useState<Record<string, boolean>>({});

  const toggleTriggers = useCallback((name: string) => {
    setExpandedTriggers((prev) => ({ ...prev, [name]: !prev[name] }));
  }, []);

  const toggleSchedules = useCallback((name: string) => {
    setExpandedSchedules((prev) => ({ ...prev, [name]: !prev[name] }));
  }, []);

  const toggleRouting = useCallback((name: string) => {
    setExpandedRouting((prev) => ({ ...prev, [name]: !prev[name] }));
  }, []);

  const notify = useCallback(
    (message: string, type: string = 'info') => onNotify?.(message, type),
    [onNotify],
  );

  const load = useCallback(async () => {
    if (!projectId) {
      setEnvironments([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.getDeployEnvironments(projectId);
      setEnvironments(res?.environments || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load environments');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const setEnabled = useCallback(
    async (env: any, enabled: boolean) => {
      if (!projectId) return;
      const key = `toggle:${env.name}`;
      setActionKey(key);
      try {
        const res = await api.setDeployEnvironmentEnabled(projectId, env.name, enabled);
        setEnvironments(res?.environments || []);
        notify(`${env.name} ${enabled ? 'resumed' : 'paused'}`, 'success');
      } catch (e: any) {
        notify(e?.message || 'Failed to update environment', 'error');
      } finally {
        setActionKey(null);
      }
    },
    [projectId, notify],
  );

  const doRemove = useCallback(
    async (env: any) => {
      if (!projectId) return;
      const key = `delete:${env.name}`;
      setActionKey(key);
      try {
        const res = await api.deleteDeployEnvironmentConfig(projectId, env.name);
        setEnvironments(res?.environments || []);
        notify(
          res?.removed
            ? env.active
              ? `${env.name} reset to default`
              : `${env.name} config removed`
            : `No config to remove for ${env.name}`,
          'success',
        );
      } catch (e: any) {
        notify(e?.message || 'Failed to remove environment config', 'error');
      } finally {
        setActionKey(null);
      }
    },
    [projectId, notify],
  );

  const confirmRemove = useCallback(
    (env: any) => {
      const message = env.active
        ? `Reset ${env.name} to the enabled default?`
        : `Remove the stale config for ${env.name}?`;
      Alert.alert('Environment config', message, [
        { text: 'Cancel', style: 'cancel' },
        { text: env.active ? 'Reset' : 'Remove', style: 'destructive', onPress: () => doRemove(env) },
      ]);
    },
    [doRemove],
  );

  const sorted = sortEnvironmentsForDisplay(environments as { name: string; active: boolean }[]);

  return (
    <View style={styles.section} testID="environments-management-section">
      <View style={styles.headerRow}>
        <Text style={styles.title}>Manage environments</Text>
        <TouchableOpacity
          onPress={load}
          disabled={loading}
          style={[styles.iconButton, loading && styles.disabled]}
          accessibilityLabel="Refresh environments"
        >
          {loading ? (
            <ActivityIndicator color={colors.gray300} size="small" />
          ) : (
            <RefreshCw size={15} color={colors.gray300} />
          )}
        </TouchableOpacity>
      </View>

      <Text style={styles.help}>
        Pause or resume an environment without editing .agent-hub/deploy.yaml. A paused environment
        cannot be deployed. Environments no longer declared in deploy.yaml show as orphaned so their
        stale config can be removed.
      </Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {loading && environments.length === 0 ? (
        <ActivityIndicator color={colors.gray400} />
      ) : sorted.length === 0 && !error ? (
        <Text style={styles.empty}>No deployment environments found.</Text>
      ) : (
        sorted.map((raw) => {
          const env = raw as any;
          const status = environmentStatus(env);
          const badge = STATUS_STYLE[status];
          const toggleKey = `toggle:${env.name}`;
          const deleteKey = `delete:${env.name}`;
          const canRemove = hasRuntimeConfig(env);
          return (
            <View key={env.name} style={styles.card} testID={`manage-env-${env.name}`}>
              <View style={styles.cardHeader}>
                <Text style={styles.envName}>{env.name}</Text>
                <View
                  style={[
                    styles.badge,
                    { borderColor: badge.borderColor, backgroundColor: badge.backgroundColor },
                  ]}
                >
                  <Text style={[styles.badgeText, { color: badge.color }]}>
                    {environmentStatusLabel(status)}
                  </Text>
                </View>
                {env.approval ? (
                  <View style={styles.gatedBadge}>
                    <ShieldCheck size={11} color={colors.purple400} />
                    <Text style={styles.gatedText}>gated</Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.meta}>
                live {shortDeploymentRef(env.currentRef)}
                {env.runsOn ? ` · ${env.runsOn}` : ''}
                {!env.active ? ' · not in deploy.yaml' : ''}
              </Text>

              <View style={styles.actions}>
                <TouchableOpacity
                  onPress={() => toggleTriggers(env.name)}
                  style={[
                    styles.actionButton,
                    expandedTriggers[env.name] ? styles.triggersButtonActive : styles.triggersButton,
                  ]}
                  accessibilityLabel={`Manage triggers for ${env.name}`}
                  accessibilityState={{ expanded: !!expandedTriggers[env.name] }}
                >
                  {expandedTriggers[env.name] ? (
                    <ChevronDown size={13} color={colors.amber400} />
                  ) : (
                    <ChevronRight size={13} color={colors.gray300} />
                  )}
                  <Zap size={13} color={expandedTriggers[env.name] ? colors.amber400 : colors.gray300} />
                  <Text
                    style={[
                      styles.actionText,
                      { color: expandedTriggers[env.name] ? colors.amber400 : colors.gray300 },
                    ]}
                  >
                    Triggers
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => toggleSchedules(env.name)}
                  style={[
                    styles.actionButton,
                    expandedSchedules[env.name] ? styles.schedulesButtonActive : styles.schedulesButton,
                  ]}
                  accessibilityLabel={`Manage schedules for ${env.name}`}
                  accessibilityState={{ expanded: !!expandedSchedules[env.name] }}
                >
                  {expandedSchedules[env.name] ? (
                    <ChevronDown size={13} color={colors.blue300} />
                  ) : (
                    <ChevronRight size={13} color={colors.gray300} />
                  )}
                  <CalendarClock size={13} color={expandedSchedules[env.name] ? colors.blue300 : colors.gray300} />
                  <Text
                    style={[
                      styles.actionText,
                      { color: expandedSchedules[env.name] ? colors.blue300 : colors.gray300 },
                    ]}
                  >
                    Schedules
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => toggleRouting(env.name)}
                  style={[
                    styles.actionButton,
                    expandedRouting[env.name] ? styles.routingButtonActive : styles.routingButton,
                  ]}
                  accessibilityLabel={`Manage notification routing for ${env.name}`}
                  accessibilityState={{ expanded: !!expandedRouting[env.name] }}
                >
                  {expandedRouting[env.name] ? (
                    <ChevronDown size={13} color={colors.purple400} />
                  ) : (
                    <ChevronRight size={13} color={colors.gray300} />
                  )}
                  <Mail size={13} color={expandedRouting[env.name] ? colors.purple400 : colors.gray300} />
                  <Text
                    style={[
                      styles.actionText,
                      { color: expandedRouting[env.name] ? colors.purple400 : colors.gray300 },
                    ]}
                  >
                    Notifications
                  </Text>
                </TouchableOpacity>
                {env.active ? (
                  <TouchableOpacity
                    onPress={() => setEnabled(env, !env.enabled)}
                    disabled={actionKey === toggleKey}
                    style={[
                      styles.actionButton,
                      env.enabled ? styles.pauseButton : styles.resumeButton,
                      actionKey === toggleKey && styles.disabled,
                    ]}
                    accessibilityLabel={`${env.enabled ? 'Pause' : 'Resume'} ${env.name}`}
                  >
                    {actionKey === toggleKey ? (
                      <ActivityIndicator color={colors.gray300} size="small" />
                    ) : env.enabled ? (
                      <Pause size={13} color={colors.amber400} />
                    ) : (
                      <Play size={13} color={colors.emerald300} />
                    )}
                    <Text
                      style={[
                        styles.actionText,
                        { color: env.enabled ? colors.amber400 : colors.emerald300 },
                      ]}
                    >
                      {env.enabled ? 'Pause' : 'Resume'}
                    </Text>
                  </TouchableOpacity>
                ) : null}
                {canRemove ? (
                  <TouchableOpacity
                    onPress={() => confirmRemove(env)}
                    disabled={actionKey === deleteKey}
                    style={[styles.actionButton, styles.removeButton, actionKey === deleteKey && styles.disabled]}
                    accessibilityLabel={`${env.active ? 'Reset' : 'Remove'} ${env.name} config`}
                  >
                    {actionKey === deleteKey ? (
                      <ActivityIndicator color={colors.gray300} size="small" />
                    ) : (
                      <Trash2 size={13} color={colors.gray300} />
                    )}
                    <Text style={[styles.actionText, { color: colors.gray300 }]}>
                      {env.active ? 'Reset' : 'Remove'}
                    </Text>
                  </TouchableOpacity>
                ) : null}
              </View>
              {expandedTriggers[env.name] && projectId ? (
                <EnvironmentTriggersPanel
                  projectId={projectId}
                  environmentName={env.name}
                  onNotify={onNotify}
                />
              ) : null}
              {expandedSchedules[env.name] && projectId ? (
                <EnvironmentSchedulesPanel
                  projectId={projectId}
                  environmentName={env.name}
                  onNotify={onNotify}
                />
              ) : null}
              {expandedRouting[env.name] && projectId ? (
                <EnvironmentNotificationRoutingPanel
                  projectId={projectId}
                  environmentName={env.name}
                  onNotify={onNotify}
                />
              ) : null}
            </View>
          );
        })
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
    borderRadius: 12,
    padding: 14,
    gap: 8,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.gray100, fontSize: 15, fontWeight: '600' },
  iconButton: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    padding: 6,
  },
  help: { color: colors.gray500, fontSize: 12, lineHeight: 17 },
  error: { color: colors.red400, fontSize: 13 },
  empty: {
    color: colors.gray500,
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 20,
  },
  card: {
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray950,
    borderRadius: 10,
    padding: 12,
    gap: 6,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  envName: { color: colors.gray200, fontSize: 14, fontWeight: '500' },
  badge: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { fontSize: 11, fontWeight: '500' },
  gatedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderWidth: 1,
    borderColor: colors.purple500,
    backgroundColor: colors.purple900_40,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  gatedText: { color: colors.purple400, fontSize: 11 },
  meta: { color: colors.gray500, fontSize: 12 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  pauseButton: { borderColor: colors.amber400, backgroundColor: colors.amber900_40 },
  resumeButton: { borderColor: colors.emerald500, backgroundColor: colors.emerald900_40 },
  removeButton: { borderColor: colors.gray700 },
  triggersButton: { borderColor: colors.gray700 },
  triggersButtonActive: { borderColor: colors.amber400, backgroundColor: colors.amber900_40 },
  schedulesButton: { borderColor: colors.gray700 },
  schedulesButtonActive: { borderColor: colors.blue500, backgroundColor: colors.blue900_40 },
  routingButton: { borderColor: colors.gray700 },
  routingButtonActive: { borderColor: colors.purple500, backgroundColor: colors.purple900_40 },
  actionText: { fontSize: 12, fontWeight: '500' },
  disabled: { opacity: 0.5 },
});
