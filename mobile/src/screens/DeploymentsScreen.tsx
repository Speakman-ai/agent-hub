import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  CheckCircle2,
  Circle,
  Clock,
  Play,
  RefreshCw,
  RotateCcw,
  Settings,
  ShieldCheck,
  Terminal,
  Wrench,
  XCircle,
} from 'lucide-react-native';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
import ReleaseNotificationSettingsSection from '../components/settings/ReleaseNotificationSettingsSection';
import { useApp } from '../context/AppContext';
import { colors } from '../theme/colors';
import { api } from '../utils/api';
import {
  deploymentEventFromSnapshot,
  deploymentStepLogText,
  isTerminalDeploymentStatus,
  isMissingDeployConfigError,
  loadReleaseVersionDeployments,
  mergeDeploymentConfigWithSnapshot,
  preferredDeploymentFromConfig,
  releaseItemCardLabel,
  releaseNotificationRecipientLabel,
  releaseNotificationStatusLabel,
  releaseItemStatusLabel,
  releaseItemSupportLabel,
  releaseVersionLabel,
  shortDeploymentRef,
} from '../utils/deployments';
import { parseDate, relativeTime } from '../utils/time';

const STATUS_STYLE: Record<string, { borderColor: string; backgroundColor: string; color: string }> =
  {
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
    running: { borderColor: colors.blue500, backgroundColor: colors.blue900_40, color: colors.blue300 },
    awaiting_approval: {
      borderColor: colors.purple500,
      backgroundColor: colors.purple900_40,
      color: colors.purple400,
    },
    idle: { borderColor: colors.gray700, backgroundColor: colors.gray800, color: colors.gray300 },
  };

function formatDate(value: any) {
  const d = parseDate(value);
  if (!d || Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString();
}

function StatusBadge({ status }: any) {
  const label = String(status || 'idle');
  const style = STATUS_STYLE[label] || STATUS_STYLE.idle;
  return (
    <View
      style={[
        styles.statusBadge,
        { borderColor: style.borderColor, backgroundColor: style.backgroundColor },
      ]}
    >
      <Text style={[styles.statusBadgeText, { color: style.color }]}>
        {label.replaceAll('_', ' ')}
      </Text>
    </View>
  );
}

function StepIcon({ status }: any) {
  if (status === 'success') return <CheckCircle2 size={16} color={colors.emerald400} />;
  if (status === 'error') return <XCircle size={16} color={colors.red400} />;
  if (status === 'cancelled') return <XCircle size={16} color={colors.amber400} />;
  if (status === 'skipped') return <Circle size={16} color={colors.gray600} />;
  if (status === 'running') return <ActivityIndicator color={colors.blue400} size="small" />;
  return <Clock size={16} color={colors.gray500} />;
}

function branchNames(branchData: any): string[] {
  return Array.isArray(branchData?.branches)
    ? branchData.branches.map((branch: any) => branch?.name).filter(Boolean)
    : [];
}

function defaultDeployRef(env: any, branchData: any): string {
  const defaultBranch =
    branchData?.defaultBranch ||
    branchData?.branches?.find((branch: any) => branch?.isDefault)?.name ||
    null;
  return defaultBranch || env.currentRef || 'HEAD';
}

function loadDeployBranches(projectId: string): Promise<any> {
  return api
    .getProjectBranches(projectId)
    .catch(() => api.getGitHostBranches(projectId).catch(() => null));
}

export default function DeploymentsScreen({ route, navigation }: any) {
  const { projects, lastDeploymentEvent } = useApp();
  const projectId = route?.params?.projectId || projects?.[0]?.id;
  const project = route?.params?.project || projects?.find((p: any) => p.id === projectId);
  const [config, setConfig] = useState<any>(null);
  const [branchData, setBranchData] = useState<any>(null);
  const [releaseDeployments, setReleaseDeployments] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [refByEnv, setRefByEnv] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<any>(null);
  const [missingConfig, setMissingConfig] = useState(false);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [setupStarting, setSetupStarting] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const selectedIdRef = useRef<string | null>(null);

  useEffect(() => {
    selectedIdRef.current = selected?.deployment?.id ?? null;
  }, [selected]);

  const selectDeployment = useCallback(
    async (deployment: any) => {
      if (!projectId || !deployment?.id) return;
      selectedIdRef.current = deployment.id;
      setSelected({ deployment, steps: [], approvals: [], releaseItems: [] });
      try {
        const detail = await api.getDeployment(projectId, deployment.id);
        if (selectedIdRef.current === deployment.id) setSelected(detail);
      } catch {
        if (selectedIdRef.current === deployment.id) {
          setSelected({ deployment, steps: [], approvals: [], releaseItems: [] });
        }
      }
    },
    [projectId],
  );

  const load = useCallback(
    async ({ silent = false }: any = {}) => {
      if (!projectId) return;
      if (silent) setRefreshing(true);
      else {
        setLoading(true);
        setError(null);
      }
      try {
        const [res, branches, releaseHistory] = await Promise.all([
          api.getDeployConfig(projectId),
          loadDeployBranches(projectId),
          loadReleaseVersionDeployments(() => api.listDeployments(projectId, { limit: 100 })),
        ]);
        setConfig(res);
        setBranchData(branches);
        setReleaseDeployments(releaseHistory);
        setMissingConfig(false);
        setRefByEnv((prev) => {
          const next = { ...prev };
          for (const env of res.environments || []) {
            if (!next[env.name]) next[env.name] = defaultDeployRef(env, branches);
          }
          return next;
        });
        const preferred = preferredDeploymentFromConfig(res);
        if (preferred && !selectedIdRef.current) {
          selectDeployment(preferred);
        }
      } catch (err: any) {
        if (isMissingDeployConfigError(err)) {
          setConfig(null);
          setBranchData(null);
          setReleaseDeployments([]);
          setMissingConfig(true);
          setError(null);
        } else {
          setMissingConfig(false);
          setError(err?.message || 'Failed to load deployments');
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [projectId, selectDeployment],
  );

  const startSetup = useCallback(async () => {
    if (!projectId || setupStarting) return;
    setSetupStarting(true);
    try {
      const res = await api.startDeployWizard(projectId);
      if (!res?.sessionId) {
        Alert.alert('Deployments', 'Server did not return a setup session id');
        return;
      }
      Alert.alert('Deployments', `Deploy setup walkthrough started: ${res.sessionId}`);
    } catch (err: any) {
      Alert.alert('Deploy setup failed', err?.message || 'Failed to start deploy setup');
    } finally {
      setSetupStarting(false);
    }
  }, [projectId, setupStarting]);

  useEffect(() => {
    selectedIdRef.current = null;
    setSelected(null);
    setRefByEnv({});
    setBranchData(null);
    setEvents([]);
    load();
  }, [load]);

  const applySnapshot = useCallback((snapshot: any) => {
    const deployment = snapshot?.deployment;
    if (!deployment) return;
    setConfig((prev: any) => mergeDeploymentConfigWithSnapshot(prev, snapshot));
    setReleaseDeployments((prev) => {
      const withoutCurrent = prev.filter((item) => item?.id !== deployment.id);
      return deployment.status === 'success' ? [deployment, ...withoutCurrent] : withoutCurrent;
    });
    if (!selectedIdRef.current || selectedIdRef.current === deployment.id) {
      selectedIdRef.current = deployment.id;
      setSelected((prev: any) => ({
        deployment,
        steps: snapshot.steps || [],
        approvals: snapshot.approvals || prev?.approvals || [],
        logs: snapshot.logs || prev?.logs || [],
        releaseItems: snapshot.releaseItems || prev?.releaseItems || [],
        releaseNotifications: snapshot.releaseNotifications || prev?.releaseNotifications || [],
      }));
    }
    const event = deploymentEventFromSnapshot(snapshot);
    if (event) {
      setEvents((prev) => [event, ...prev].slice(0, 20));
    }
  }, []);

  useEffect(() => {
    if (!lastDeploymentEvent || lastDeploymentEvent.projectId !== projectId) return;
    applySnapshot({
      deployment: lastDeploymentEvent.deployment,
      steps: lastDeploymentEvent.steps || [],
      approvals: lastDeploymentEvent.approvals || [],
      logs: lastDeploymentEvent.logs || [],
    });
  }, [applySnapshot, lastDeploymentEvent, projectId]);

  const runAction = useCallback(
    async (key: string, fn: () => Promise<any>, message: string) => {
      setActionKey(key);
      try {
        const snapshot = await fn();
        applySnapshot(snapshot);
        Alert.alert('Deployments', message);
        load({ silent: true });
      } catch (err: any) {
        Alert.alert('Deployment action failed', err?.message || 'Deployment action failed');
      } finally {
        setActionKey(null);
      }
    },
    [applySnapshot, load],
  );

  const environments = config?.environments || [];
  const selectedDeployment = selected?.deployment;
  const selectedSteps = selected?.steps || [];
  const selectedLogs = selected?.logs || [];
  const selectedReleaseItems = selected?.releaseItems || [];
  const selectedReleaseNotifications = selected?.releaseNotifications || [];
  const releaseOptions =
    releaseDeployments.length > 0 && selectedDeployment?.status === 'success'
      ? [
          selectedDeployment,
          ...releaseDeployments.filter((deployment) => deployment.id !== selectedDeployment.id),
        ]
      : releaseDeployments;
  const selectedReleaseDeploymentId =
    selectedDeployment?.status === 'success' ? selectedDeployment.id : '';

  const retryNotification = useCallback(
    async (notification: any) => {
      if (!projectId || !selectedDeployment?.id || !notification?.id) return;
      const key = `notification:${notification.id}:retry`;
      setActionKey(key);
      try {
        const res = await api.retryReleaseNotification(
          projectId,
          selectedDeployment.id,
          notification.id,
        );
        setSelected((prev: any) =>
          prev
            ? {
                ...prev,
                releaseNotifications: res.releaseNotifications || prev.releaseNotifications || [],
              }
            : prev,
        );
        Alert.alert('Deployments', 'Release notification queued for retry');
      } catch (err: any) {
        Alert.alert('Retry failed', err?.message || 'Failed to retry release notification');
      } finally {
        setActionKey(null);
      }
    },
    [projectId, selectedDeployment?.id],
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ProjectScreenHeader
        title="Deployments"
        project={project}
        onBack={() => navigation.goBack()}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.title}>Deployments</Text>
            <Text style={styles.subtitle}>deploy.yaml environments and live run status</Text>
          </View>
          <View style={styles.headerActions}>
            <TouchableOpacity
              onPress={() => setShowSettings((prev) => !prev)}
              style={[styles.iconButton, showSettings && styles.iconButtonActive]}
              accessibilityLabel="Release digest settings"
              accessibilityState={{ selected: showSettings }}
            >
              <Settings size={16} color={showSettings ? colors.blue300 : colors.gray300} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => load({ silent: true })}
              disabled={refreshing}
              style={[styles.iconButton, refreshing && styles.disabled]}
              accessibilityLabel="Refresh deployments"
            >
              {refreshing ? (
                <ActivityIndicator color={colors.gray300} size="small" />
              ) : (
                <RefreshCw size={16} color={colors.gray300} />
              )}
            </TouchableOpacity>
          </View>
        </View>

        {showSettings ? (
          <View style={styles.settingsPanel} testID="deployments-settings-panel">
            <ReleaseNotificationSettingsSection projectId={projectId} />
          </View>
        ) : null}

        {loading && !config ? <ActivityIndicator color={colors.gray400} /> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        {!loading && !error && missingConfig ? (
          <View style={styles.setupCard}>
            <View style={styles.setupIcon}>
              <Wrench size={18} color={colors.blue300} />
            </View>
            <View style={styles.setupBody}>
              <Text style={styles.setupTitle}>Set up deployment environments</Text>
              <Text style={styles.setupText}>
                This project does not have .agent-hub/deploy.yaml yet. Start an AI setup session to
                inspect the repo, choose environments, and author the config on a reviewable branch.
              </Text>
              <TouchableOpacity
                onPress={startSetup}
                disabled={setupStarting}
                style={[styles.primaryButton, styles.setupButton, setupStarting && styles.disabled]}
              >
                {setupStarting ? (
                  <ActivityIndicator color={colors.white} size="small" />
                ) : (
                  <Wrench size={14} color={colors.white} />
                )}
                <Text style={styles.primaryButtonText}>Start AI setup</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}

        {!loading && !error && !missingConfig && environments.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>No deployment environments found.</Text>
          </View>
        ) : null}

        {environments.map((env: any) => {
          const active = env.activeDeployment;
          const last = env.lastDeployment;
          const busy = Boolean(active && !isTerminalDeploymentStatus(active.status));
          const awaitingApproval = active?.status === 'awaiting_approval';
          const refValue = refByEnv[env.name] ?? defaultDeployRef(env, branchData);
          const branches = branchNames(branchData);
          const rollbackTargetId = env.rollbackTarget?.id;
          const deployKey = `deploy:${env.name}`;
          const rollbackKey = `rollback:${env.name}`;
          const approveKey = `approve:${active?.id}`;

          return (
            <View key={env.name} style={styles.envCard} testID={`deploy-env-${env.name}`}>
              <View style={styles.envHeader}>
                <View style={styles.envTitleBlock}>
                  <View style={styles.envNameRow}>
                    <Text style={styles.envName} numberOfLines={1}>
                      {env.name}
                    </Text>
                    {env.approval ? (
                      <View style={styles.gatedBadge}>
                        <ShieldCheck size={12} color={colors.purple400} />
                        <Text style={styles.gatedText}>gated</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.envMeta} numberOfLines={1}>
                    live {env.currentRef ? shortDeploymentRef(env.currentRef) : 'none'} ·{' '}
                    {env.runsOn} · {env.timeoutMinutes}m · {env.steps?.length || 0} steps
                  </Text>
                </View>
                <StatusBadge status={active?.status || last?.status || 'idle'} />
              </View>

              {branches.length > 0 ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={styles.branchPicker}
                  accessibilityLabel={`Branches for ${env.name}`}
                >
                  {branches.map((branch) => {
                    const activeBranch = branch === refValue;
                    return (
                      <TouchableOpacity
                        key={branch}
                        style={[styles.branchChip, activeBranch && styles.branchChipActive]}
                        onPress={() =>
                          setRefByEnv((prev) => ({ ...prev, [env.name]: branch }))
                        }
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityLabel={`Deploy ${env.name} from ${branch}`}
                      >
                        <Text
                          style={[
                            styles.branchChipText,
                            activeBranch && styles.branchChipTextActive,
                          ]}
                          numberOfLines={1}
                        >
                          {branch}
                          {branch === defaultDeployRef({ currentRef: null }, branchData)
                            ? ' (default)'
                            : ''}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              ) : null}

              <View style={styles.deployRow}>
                <TextInput
                  accessibilityLabel={`Ref for ${env.name}`}
                  value={refValue}
                  onChangeText={(value) =>
                    setRefByEnv((prev) => ({ ...prev, [env.name]: value }))
                  }
                  editable={!busy}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[styles.refInput, busy && styles.inputDisabled]}
                />
                <TouchableOpacity
                  onPress={() =>
                    runAction(
                      deployKey,
                      () =>
                        api.triggerDeployment(projectId, env.name, {
                          ref: refValue.trim() || 'HEAD',
                        }),
                      `Deploy started for ${env.name}`,
                    )
                  }
                  disabled={busy || actionKey === deployKey}
                  style={[styles.primaryButton, (busy || actionKey === deployKey) && styles.disabled]}
                >
                  {actionKey === deployKey ? (
                    <ActivityIndicator color={colors.white} size="small" />
                  ) : (
                    <Play size={14} color={colors.white} />
                  )}
                  <Text style={styles.primaryButtonText}>Deploy</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.actionRow}>
                <TouchableOpacity
                  onPress={() =>
                    runAction(
                      rollbackKey,
                      () => api.rollbackDeployment(projectId, rollbackTargetId, {}),
                      `Rollback started for ${env.name}`,
                    )
                  }
                  disabled={busy || !rollbackTargetId || actionKey === rollbackKey}
                  style={[
                    styles.secondaryButton,
                    (busy || !rollbackTargetId || actionKey === rollbackKey) && styles.disabled,
                  ]}
                >
                  <RotateCcw size={13} color={colors.gray300} />
                  <Text style={styles.secondaryButtonText}>Rollback</Text>
                </TouchableOpacity>

                {awaitingApproval ? (
                  <TouchableOpacity
                    onPress={() =>
                      runAction(
                        approveKey,
                        () => api.approveDeployment(projectId, active.id, {}),
                        `Deployment approved for ${env.name}`,
                      )
                    }
                    disabled={actionKey === approveKey}
                    style={[styles.approveButton, actionKey === approveKey && styles.disabled]}
                  >
                    {actionKey === approveKey ? (
                      <ActivityIndicator color={colors.purple400} size="small" />
                    ) : (
                      <ShieldCheck size={13} color={colors.purple400} />
                    )}
                    <Text style={styles.approveButtonText}>Approve</Text>
                  </TouchableOpacity>
                ) : null}

                {active || last ? (
                  <TouchableOpacity
                    onPress={() => selectDeployment(active || last)}
                    style={styles.secondaryButton}
                  >
                    <Terminal size={13} color={colors.gray300} />
                    <Text style={styles.secondaryButtonText}>View</Text>
                  </TouchableOpacity>
                ) : null}
              </View>

              <Text style={styles.lastRun} numberOfLines={1}>
                {last
                  ? `${shortDeploymentRef(last.ref)} · ${relativeTime(last.updated_at)}`
                  : 'No runs'}
              </Text>
            </View>
          );
        })}

        {releaseOptions.length > 0 ? (
          <View style={styles.releasePickerCard}>
            <Text style={styles.releasePickerTitle}>Release version</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.releasePickerScroller}
              accessibilityLabel="Release versions"
            >
              {releaseOptions.map((deployment: any) => {
                const active = deployment.id === selectedReleaseDeploymentId;
                return (
                  <TouchableOpacity
                    key={deployment.id}
                    onPress={() => selectDeployment(deployment)}
                    style={[styles.releaseVersionChip, active && styles.releaseVersionChipActive]}
                    accessibilityRole="button"
                    accessibilityLabel={`Release version ${releaseVersionLabel(deployment)}`}
                    accessibilityState={{ selected: active }}
                  >
                    <Text
                      style={[
                        styles.releaseVersionChipText,
                        active && styles.releaseVersionChipTextActive,
                      ]}
                      numberOfLines={1}
                    >
                      {releaseVersionLabel(deployment)}
                    </Text>
                    <Text style={styles.releaseVersionChipMeta} numberOfLines={1}>
                      {formatDate(
                        deployment.completed_at || deployment.updated_at || deployment.created_at,
                      )}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        ) : null}

        <View style={styles.detailCard}>
          <View style={styles.sectionHeader}>
            <Terminal size={16} color={colors.gray400} />
            <Text style={styles.sectionTitle}>Selected Run</Text>
            {selectedDeployment ? <StatusBadge status={selectedDeployment.status} /> : null}
          </View>
          {selectedDeployment ? (
            <Text style={styles.selectedMeta} numberOfLines={1}>
              {selectedDeployment.environment} / {shortDeploymentRef(selectedDeployment.ref)}
            </Text>
          ) : null}

          {!selectedDeployment ? (
            <Text style={styles.emptyText}>No deployment selected.</Text>
          ) : selectedSteps.length === 0 ? (
            <Text style={styles.emptyText}>No steps recorded yet.</Text>
          ) : (
            selectedSteps.map((step: any) => {
              const logText = deploymentStepLogText(step, selectedLogs);
              return (
                <View key={step.id} style={styles.stepCard}>
                  <View style={styles.stepRow}>
                    <StepIcon status={step.status} />
                    <View style={styles.stepBody}>
                      <View style={styles.stepTitleRow}>
                        <Text style={styles.stepTitle} numberOfLines={1}>
                          {step.step_order}. {step.name}
                        </Text>
                        <StatusBadge status={step.status} />
                      </View>
                      <Text style={styles.stepMeta}>
                        {step.started_at ? `started ${formatDate(step.started_at)} ` : ''}
                        {step.completed_at ? `completed ${formatDate(step.completed_at)} ` : ''}
                        {step.exit_code != null ? `exit ${step.exit_code} ` : ''}
                        {step.github_conclusion
                          ? `workflow ${String(step.github_conclusion).replaceAll('_', ' ')}`
                          : ''}
                      </Text>
                      {step.github_run_url ? (
                        <TouchableOpacity
                          onPress={() => Linking.openURL(String(step.github_run_url))}
                        >
                          <Text style={styles.stepLink}>
                            View GitHub Actions run
                            {step.github_run_id ? ` #${step.github_run_id}` : ''}
                          </Text>
                        </TouchableOpacity>
                      ) : null}
                      {step.error ? <Text style={styles.stepError}>{step.error}</Text> : null}
                      {logText ? <Text style={styles.stepLog}>{logText}</Text> : null}
                    </View>
                  </View>
                </View>
              );
            })
          )}

          {selectedDeployment ? (
            <View style={styles.releaseSection}>
              <View style={styles.releaseHeader}>
                <Text style={styles.releaseTitle}>Release changes</Text>
                <Text style={styles.releaseCount}>
                  {
                    selectedReleaseItems.filter((item: any) => item.inclusion_status !== 'excluded')
                      .length
                  }{' '}
                  included
                </Text>
              </View>
              {selectedReleaseItems.length === 0 ? (
                <Text style={styles.emptyText}>No release items recorded for this deployment.</Text>
              ) : (
                selectedReleaseItems.map((item: any) => {
                  const excluded = item.inclusion_status === 'excluded';
                  return (
                    <View key={item.id} style={styles.releaseItemCard}>
                      <View style={styles.releaseItemHeader}>
                        <Text style={styles.releaseItemTitle} numberOfLines={1}>
                          {releaseItemCardLabel(item)}
                        </Text>
                        <View
                          style={[
                            styles.releaseBadge,
                            excluded ? styles.releaseBadgeExcluded : styles.releaseBadgeIncluded,
                          ]}
                        >
                          <Text
                            style={[
                              styles.releaseBadgeText,
                              excluded
                                ? styles.releaseBadgeTextExcluded
                                : styles.releaseBadgeTextIncluded,
                            ]}
                          >
                            {releaseItemStatusLabel(item)}
                          </Text>
                        </View>
                      </View>
                      {item.supportTicket?.id ? (
                        <TouchableOpacity
                          onPress={() =>
                            navigation.navigate('CustomerSupport', {
                              projectId,
                              ticketId: item.supportTicket.id,
                            })
                          }
                          accessibilityRole="link"
                        >
                          <Text style={styles.releaseTicketText} numberOfLines={2}>
                            {releaseItemSupportLabel(item)}
                          </Text>
                        </TouchableOpacity>
                      ) : (
                        <Text style={styles.releaseTicketMutedText} numberOfLines={2}>
                          {releaseItemSupportLabel(item)}
                        </Text>
                      )}
                      {item.operator_adjustment_note ? (
                        <Text style={styles.releaseReasonText} numberOfLines={2}>
                          Last reason: {item.operator_adjustment_note}
                        </Text>
                      ) : null}
                    </View>
                  );
                })
              )}
            </View>
          ) : null}

          {selectedDeployment ? (
            <View style={styles.releaseSection}>
              <View style={styles.releaseHeader}>
                <Text style={styles.releaseTitle}>Notifications</Text>
                <Text style={styles.releaseCount}>{selectedReleaseNotifications.length} recorded</Text>
              </View>
              {selectedReleaseNotifications.length === 0 ? (
                <Text style={styles.emptyText}>
                  No release notifications recorded for this deployment.
                </Text>
              ) : (
                selectedReleaseNotifications.map((notification: any) => {
                  const retryKey = `notification:${notification.id}:retry`;
                  return (
                    <View key={notification.id} style={styles.releaseItemCard}>
                      <View style={styles.releaseItemHeader}>
                        <Text style={styles.releaseItemTitle} numberOfLines={1}>
                          {releaseNotificationRecipientLabel(notification)}
                        </Text>
                        <StatusBadge status={notification.status} />
                      </View>
                      <Text style={styles.releaseTicketMutedText} numberOfLines={2}>
                        {notification.subject || 'Release notification'}
                      </Text>
                      <Text style={styles.releaseReasonText}>
                        {releaseNotificationStatusLabel(notification)} ·{' '}
                        {notification.attempts || 0} attempts
                        {notification.sent_at ? ` · sent ${formatDate(notification.sent_at)}` : ''}
                      </Text>
                      {notification.error_summary ? (
                        <Text style={styles.notificationErrorText}>
                          {notification.error_summary}
                        </Text>
                      ) : null}
                      {notification.can_retry ? (
                        <TouchableOpacity
                          onPress={() => retryNotification(notification)}
                          disabled={actionKey === retryKey}
                          style={[styles.secondaryButton, actionKey === retryKey && styles.disabled]}
                        >
                          {actionKey === retryKey ? (
                            <ActivityIndicator color={colors.gray300} size="small" />
                          ) : (
                            <RefreshCw size={13} color={colors.gray300} />
                          )}
                          <Text style={styles.secondaryButtonText}>Retry</Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  );
                })
              )}
            </View>
          ) : null}
        </View>

        <View style={styles.detailCard}>
          <View style={styles.sectionHeader}>
            <RefreshCw size={15} color={colors.gray400} />
            <Text style={styles.sectionTitle}>Live Stream</Text>
          </View>
          {events.length === 0 ? (
            <Text style={styles.emptyText}>Waiting for deployment updates.</Text>
          ) : (
            events.map((event) => (
              <View key={event.id} style={styles.eventRow}>
                <StatusBadge status={event.status} />
                <View style={styles.eventBody}>
                  <Text style={styles.eventText} numberOfLines={1}>
                    {event.environment} / {shortDeploymentRef(event.ref)}
                  </Text>
                  <Text style={styles.eventTime}>{formatDate(event.at)}</Text>
                </View>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.gray950 },
  content: { padding: 16, paddingBottom: 32, gap: 12 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 20, fontWeight: '700', color: colors.white },
  subtitle: { marginTop: 2, fontSize: 12, color: colors.gray500 },
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
  iconButtonActive: { borderColor: colors.blue500, backgroundColor: colors.blue900_40 },
  settingsPanel: { marginTop: 12 },
  error: { color: colors.red400, fontSize: 13 },
  setupCard: {
    flexDirection: 'row',
    gap: 12,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    padding: 14,
    backgroundColor: colors.gray900,
  },
  setupIcon: {
    width: 36,
    height: 36,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.blue500,
    backgroundColor: colors.blue900_40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  setupBody: { flex: 1, minWidth: 0 },
  setupTitle: { color: colors.white, fontSize: 15, fontWeight: '700' },
  setupText: { marginTop: 6, color: colors.gray400, fontSize: 13, lineHeight: 18 },
  setupButton: { alignSelf: 'flex-start', marginTop: 12, paddingHorizontal: 12 },
  emptyCard: {
    minHeight: 96,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.gray800,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: { color: colors.gray500, fontSize: 13, textAlign: 'center', paddingVertical: 12 },
  envCard: {
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    padding: 12,
    backgroundColor: colors.gray900,
    gap: 12,
  },
  envHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  envTitleBlock: { flex: 1, minWidth: 0 },
  envNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  envName: { flexShrink: 1, color: colors.white, fontSize: 16, fontWeight: '700' },
  envMeta: { marginTop: 4, color: colors.gray500, fontSize: 12 },
  gatedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: colors.purple500,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: colors.purple900_40,
  },
  gatedText: { color: colors.purple400, fontSize: 11, fontWeight: '600' },
  statusBadge: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  statusBadgeText: { fontSize: 11, fontWeight: '700', textTransform: 'lowercase' },
  branchPicker: { maxHeight: 38 },
  branchChip: {
    maxWidth: 220,
    minHeight: 32,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: colors.gray700,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    backgroundColor: colors.gray950,
  },
  branchChipActive: { borderColor: colors.emerald400, backgroundColor: colors.emerald900_40 },
  branchChipText: { color: colors.gray300, fontSize: 12, fontFamily: 'monospace' },
  branchChipTextActive: { color: colors.emerald300 },
  deployRow: { flexDirection: 'row', gap: 8 },
  refInput: {
    flex: 1,
    minHeight: 38,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray950,
    color: colors.gray200,
    paddingHorizontal: 10,
    fontSize: 14,
  },
  inputDisabled: { color: colors.gray500 },
  primaryButton: {
    minHeight: 38,
    minWidth: 92,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
    backgroundColor: colors.blue600,
  },
  primaryButtonText: { color: colors.white, fontSize: 13, fontWeight: '700' },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  secondaryButton: {
    minHeight: 32,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: colors.gray700,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
  },
  secondaryButtonText: { color: colors.gray300, fontSize: 12, fontWeight: '600' },
  approveButton: {
    minHeight: 32,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: colors.purple500,
    backgroundColor: colors.purple900_40,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
  },
  approveButtonText: { color: colors.purple400, fontSize: 12, fontWeight: '700' },
  disabled: { opacity: 0.5 },
  lastRun: { color: colors.gray500, fontSize: 12 },
  releasePickerCard: {
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    padding: 12,
    backgroundColor: colors.gray900,
    gap: 8,
  },
  releasePickerTitle: { color: colors.gray300, fontSize: 12, fontWeight: '700' },
  releasePickerScroller: { maxHeight: 52 },
  releaseVersionChip: {
    maxWidth: 260,
    minHeight: 46,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: colors.gray700,
    paddingHorizontal: 10,
    justifyContent: 'center',
    marginRight: 8,
    backgroundColor: colors.gray950,
  },
  releaseVersionChipActive: {
    borderColor: colors.blue500,
    backgroundColor: colors.blue900_40,
  },
  releaseVersionChipText: { color: colors.gray200, fontSize: 12, fontWeight: '700' },
  releaseVersionChipTextActive: { color: colors.blue300 },
  releaseVersionChipMeta: { marginTop: 2, color: colors.gray500, fontSize: 11 },
  detailCard: {
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    padding: 12,
    backgroundColor: colors.gray900,
    gap: 10,
  },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionTitle: { color: colors.white, fontSize: 15, fontWeight: '700', flex: 1 },
  selectedMeta: { color: colors.gray500, fontSize: 12 },
  stepCard: {
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 7,
    padding: 10,
    backgroundColor: colors.gray950,
  },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  stepBody: { flex: 1, minWidth: 0 },
  stepTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepTitle: { flex: 1, color: colors.gray200, fontSize: 13, fontWeight: '700' },
  stepMeta: { marginTop: 4, color: colors.gray500, fontSize: 11 },
  stepLink: { marginTop: 4, color: colors.blue300, fontSize: 12 },
  stepError: {
    marginTop: 8,
    color: colors.red400,
    fontSize: 12,
    padding: 8,
    borderRadius: 6,
    backgroundColor: colors.red900_50,
  },
  stepLog: {
    marginTop: 8,
    color: colors.gray300,
    fontSize: 11,
    fontFamily: 'monospace',
    padding: 8,
    borderRadius: 6,
    backgroundColor: colors.black60,
  },
  releaseSection: {
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
    paddingTop: 10,
    gap: 8,
  },
  releaseHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  releaseTitle: { color: colors.gray300, fontSize: 12, fontWeight: '700' },
  releaseCount: { color: colors.gray500, fontSize: 12 },
  releaseItemCard: {
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 7,
    padding: 10,
    backgroundColor: colors.gray950,
    gap: 6,
  },
  releaseItemHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  releaseItemTitle: { flex: 1, minWidth: 0, color: colors.gray200, fontSize: 13, fontWeight: '700' },
  releaseBadge: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  releaseBadgeIncluded: {
    borderColor: colors.emerald500,
    backgroundColor: colors.emerald900_40,
  },
  releaseBadgeExcluded: { borderColor: colors.amber400, backgroundColor: colors.amber900_40 },
  releaseBadgeText: { fontSize: 11, fontWeight: '700' },
  releaseBadgeTextIncluded: { color: colors.emerald300 },
  releaseBadgeTextExcluded: { color: colors.amber400 },
  releaseTicketText: { color: colors.blue300, fontSize: 12, lineHeight: 17 },
  releaseTicketMutedText: { color: colors.gray500, fontSize: 12, lineHeight: 17 },
  releaseReasonText: { color: colors.gray500, fontSize: 11, lineHeight: 16 },
  notificationErrorText: { color: colors.red400, fontSize: 12, lineHeight: 17 },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 7,
    padding: 9,
    backgroundColor: colors.gray950,
  },
  eventBody: { flex: 1, minWidth: 0 },
  eventText: { color: colors.gray300, fontSize: 12, fontWeight: '600' },
  eventTime: { marginTop: 2, color: colors.gray600, fontSize: 11 },
});
