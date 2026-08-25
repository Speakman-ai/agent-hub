import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { relativeTime } from '../utils/time';
import ProjectScreenHeader from '../components/ProjectScreenHeader';

/** Relative "last log …" label from epoch-ms, or "no logs yet". */
export function formatLastIngest(lastIngestAt: any): string {
  if (!lastIngestAt) return 'no logs yet';
  const rel = relativeTime(lastIngestAt);
  return rel ? `last log ${rel}` : 'no logs yet';
}

/** Human byte size — mirrors the web `formatBytes` helper. */
export function formatBytes(bytes: any): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/**
 * Build a two-button destructive-confirmation dialog: a non-destructive Cancel
 * and a destructive confirm that runs `onConfirm` only when tapped. Extracted
 * so the confirmation contract (rotate / revoke / delete never fire without an
 * explicit confirm tap) is unit-testable without a native Alert runtime.
 */
export function buildConfirm(opts: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
}): { title: string; message: string; buttons: any[] } {
  return {
    title: opts.title,
    message: opts.message,
    buttons: [
      { text: 'Cancel', style: 'cancel' },
      { text: opts.confirmLabel, style: 'destructive', onPress: opts.onConfirm },
    ],
  };
}

/**
 * One-time plaintext token reveal. Rendered only after a create/rotate returns
 * a fresh token; always carries the "shown once" warning so the semantics are
 * unmissable. Presentational + exported so the reveal is testable in isolation.
 */
export function FreshTokenReveal({ token, label, onDismiss }: any) {
  if (!token) return null;
  return (
    <View style={styles.tokenBox} testID="logs-fresh-token">
      <Text style={styles.tokenLabel}>
        New token for “{label}” — long-press to copy, shown once
      </Text>
      <Text style={styles.tokenValue} selectable testID="logs-fresh-token-value">
        {token}
      </Text>
      <View style={styles.tokenActions}>
        <TouchableOpacity onPress={onDismiss} testID="logs-token-dismiss">
          <Text style={styles.link}>Dismiss</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/**
 * LogSourcesPanel — the write-only `ahlog_` ingest-credential manager (decision
 * LOG-AUTH), rendered both as the standalone `LogSourcesScreen` and as the
 * "Sources" tab of the Logs module (`LogsScreen`). It owns no header/back chrome
 * so the embedding screen supplies its own. Mirrors the web
 * `LogSourcesSettingsSection`.
 */
export function LogSourcesPanel({
  projectId,
  onOpenSession,
}: {
  projectId: any;
  onOpenSession?: (target: { sessionId: string; agentId: string }) => void;
}) {
  const [sources, setSources] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<any>(null);
  const [metrics, setMetrics] = useState<any>(null);
  const [wizardStarting, setWizardStarting] = useState(false);

  const [newName, setNewName] = useState('');
  const [newService, setNewService] = useState('');
  const [newEnv, setNewEnv] = useState('');
  const [creating, setCreating] = useState(false);

  // One-time token reveal (create + rotate share this block).
  const [freshToken, setFreshToken] = useState<any>(null);
  const [freshLabel, setFreshLabel] = useState('');

  const [busyId, setBusyId] = useState<any>(null);

  // Tracks the currently-selected project so an async wizard/response that
  // started under a previous project can be ignored after the user switches
  // (mirrors the web LogSourcesSettingsSection stale-guard).
  const activePidRef = useRef(projectId);
  useEffect(() => {
    activePidRef.current = projectId;
    // A pending startLogsWizard from the old project keeps its pid-guarded
    // completion from clearing this flag, so reset it on switch to avoid a
    // permanently-disabled button on the new project.
    setWizardStarting(false);
  }, [projectId]);

  const reload = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [srcRes, metricsRes] = await Promise.all([
        api.getLogSources(projectId),
        api.getLogsMetrics(projectId).catch(() => null),
      ]);
      setSources(srcRes?.sources || []);
      setMetrics(metricsRes?.storage || null);
    } catch (err: any) {
      setLoadError(err?.message || 'Failed to load log sources');
      setSources([]);
      setMetrics(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) {
      Alert.alert('Name required', 'Enter a name for the log source.');
      return;
    }
    if (creating) return;
    setCreating(true);
    try {
      const body: Record<string, unknown> = { name };
      if (newService.trim()) body.serviceName = newService.trim();
      if (newEnv.trim()) body.environment = newEnv.trim();
      const created = await api.createLogSource(projectId, body);
      setFreshLabel(created?.name || name);
      setFreshToken(created?.token || null);
      setNewName('');
      setNewService('');
      setNewEnv('');
      await reload();
    } catch (err: any) {
      Alert.alert('Create failed', err?.message || 'Could not create log source');
    } finally {
      setCreating(false);
    }
  };

  const runBusy = useCallback(
    async (source: any, fn: () => Promise<void>, failTitle: string) => {
      if (busyId) return;
      setBusyId(source.id);
      try {
        await fn();
      } catch (err: any) {
        Alert.alert(failTitle, err?.message || 'Request failed');
      } finally {
        setBusyId(null);
      }
    },
    [busyId],
  );

  const handleRotate = (source: any) => {
    const c = buildConfirm({
      title: 'Rotate token',
      message: `Rotate the token for "${source.name}"? The current token stops working immediately.`,
      confirmLabel: 'Rotate',
      onConfirm: () =>
        void runBusy(
          source,
          async () => {
            const rotated = await api.rotateLogSource(projectId, source.id);
            setFreshLabel(rotated?.name || source.name);
            setFreshToken(rotated?.token || null);
            await reload();
          },
          'Rotate failed',
        ),
    });
    Alert.alert(c.title, c.message, c.buttons);
  };

  const handleRevoke = (source: any) => {
    const c = buildConfirm({
      title: 'Revoke token',
      message: `Revoke the token for "${source.name}"? Ingest using it will be rejected until you rotate.`,
      confirmLabel: 'Revoke',
      onConfirm: () =>
        void runBusy(
          source,
          async () => {
            await api.revokeLogSource(projectId, source.id);
            await reload();
          },
          'Revoke failed',
        ),
    });
    Alert.alert(c.title, c.message, c.buttons);
  };

  const handleDelete = (source: any) => {
    const c = buildConfirm({
      title: 'Delete source',
      message: `Delete the source "${source.name}" and its token permanently? This cannot be undone.`,
      confirmLabel: 'Delete',
      onConfirm: () =>
        void runBusy(
          source,
          async () => {
            await api.deleteLogSource(projectId, source.id);
            await reload();
          },
          'Delete failed',
        ),
    });
    Alert.alert(c.title, c.message, c.buttons);
  };

  const handleStartWizard = async () => {
    if (!projectId || wizardStarting) return;
    const pid = projectId;
    setWizardStarting(true);
    try {
      const res = await api.startLogsWizard(pid);
      if (activePidRef.current !== pid) return; // switched projects — drop the result
      if (res?.sessionId && onOpenSession) {
        onOpenSession({ sessionId: res.sessionId, agentId: res.agentId });
      } else if (!res?.sessionId) {
        Alert.alert('Logs', 'Server did not return a wizard session id');
      }
    } catch (err: any) {
      if (activePidRef.current !== pid) return; // stale — don't alert for the old project
      Alert.alert('Logs', err?.message || 'Failed to start the logs setup wizard');
    } finally {
      if (activePidRef.current === pid) setWizardStarting(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {/* AI setup wizard */}
      {onOpenSession && (
        <TouchableOpacity
          style={[styles.primaryBtn, wizardStarting && styles.btnDisabled]}
          onPress={handleStartWizard}
          disabled={wizardStarting}
          testID="logs-setup-wizard-button"
        >
          <Text style={styles.primaryBtnText}>
            {wizardStarting ? 'Starting…' : 'Set up with AI'}
          </Text>
        </TouchableOpacity>
      )}

      {/* Write-only credential warning */}
      <View style={styles.warnBox} testID="logs-writeonly-warning">
        <Text style={styles.warnTitle}>Ingest tokens are write-only server secrets</Text>
        <Text style={styles.warnBody}>
          An ahlog_ token can only send logs — it cannot read logs or call any Agent Hub API. Put it
          in your server or collector config, never in browser/client code. Direct browser ingestion
          is not supported.
        </Text>
      </View>

      {/* Storage limits */}
      <Text style={styles.sectionTitle}>Storage limits (this project)</Text>
      {metrics ? (
        <View style={styles.card} testID="logs-limits">
          <Text style={styles.row} testID="logs-retention">
            Retention: {metrics.retentionDays} days
          </Text>
          <Text style={styles.row} testID="logs-quota">
            Quota: {formatBytes(metrics.quotaBytes)}
          </Text>
          <Text style={styles.row} testID="logs-stored">
            Stored: {formatBytes(metrics.projectBytes)}
          </Text>
          <Text style={styles.row}>Past retention: {metrics.retentionLagRecords} records</Text>
        </View>
      ) : (
        <Text style={styles.hint}>Storage metrics unavailable.</Text>
      )}

      {/* Create source */}
      <Text style={styles.sectionTitle}>Create a log source</Text>
      <TextInput
        style={styles.input}
        value={newName}
        onChangeText={setNewName}
        placeholder="Source name (e.g. production-api)"
        placeholderTextColor={colors.gray600}
        testID="logs-new-name"
      />
      <TextInput
        style={[styles.input, { marginTop: 8 }]}
        value={newService}
        onChangeText={setNewService}
        placeholder="Service (optional)"
        placeholderTextColor={colors.gray600}
        testID="logs-new-service"
      />
      <TextInput
        style={[styles.input, { marginTop: 8 }]}
        value={newEnv}
        onChangeText={setNewEnv}
        placeholder="Environment (optional)"
        placeholderTextColor={colors.gray600}
        testID="logs-new-env"
      />
      <TouchableOpacity
        style={[styles.primaryBtn, creating && styles.btnDisabled]}
        onPress={handleCreate}
        disabled={creating}
        testID="logs-create-btn"
      >
        <Text style={styles.primaryBtnText}>{creating ? '…' : 'Create source & token'}</Text>
      </TouchableOpacity>

      {/* One-time token reveal */}
      <FreshTokenReveal
        token={freshToken}
        label={freshLabel}
        onDismiss={() => setFreshToken(null)}
      />

      {/* Source list */}
      <Text style={styles.sectionTitle}>Log sources</Text>
      {loading && <ActivityIndicator color={colors.gray400} />}
      {loadError && (
        <Text style={styles.error} testID="logs-error">
          {loadError}
        </Text>
      )}
      {!loading && sources.length === 0 && !loadError && (
        <Text style={styles.hint} testID="logs-empty">
          No log sources yet.
        </Text>
      )}
      {sources.map((s: any) => {
        const revoked = s.status === 'revoked';
        // Any in-flight action disables every row's buttons — matches the
        // global `runBusy` guard so a disabled action never looks tappable
        // while another source's mutation is running.
        const busy = busyId != null;
        return (
          <View key={s.id} style={styles.sourceCard} testID="logs-source-card">
            <View style={styles.sourceHead}>
              <Text style={styles.sourceName}>{s.name}</Text>
              <Text
                style={[styles.statusChip, revoked ? styles.statusRevoked : styles.statusActive]}
                testID="logs-source-status"
              >
                {revoked ? 'revoked' : 'active'}
              </Text>
            </View>
            <Text style={styles.sourceMeta}>
              {s.tokenPrefix ? `${s.tokenPrefix}…` : 'no token'}
              {s.serviceName ? ` · ${s.serviceName}` : ''}
              {s.environment ? ` · ${s.environment}` : ''}
            </Text>
            <Text style={styles.sourceMeta}>{formatLastIngest(s.lastIngestAt)}</Text>
            <View style={styles.sourceActions}>
              <TouchableOpacity
                disabled={busy}
                onPress={() => handleRotate(s)}
                testID="logs-rotate"
              >
                <Text style={[styles.actionRotate, busy && styles.btnDisabled]}>Rotate</Text>
              </TouchableOpacity>
              {!revoked && (
                <TouchableOpacity
                  disabled={busy}
                  onPress={() => handleRevoke(s)}
                  testID="logs-revoke"
                >
                  <Text style={[styles.actionRevoke, busy && styles.btnDisabled]}>Revoke</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                disabled={busy}
                onPress={() => handleDelete(s)}
                testID="logs-delete"
              >
                <Text style={[styles.actionDelete, busy && styles.btnDisabled]}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        );
      })}

      {/* Endpoint reference */}
      <Text style={styles.sectionTitle}>Ingest endpoints</Text>
      <View style={styles.card}>
        <Text style={styles.hint}>
          Authenticate with Authorization: Bearer &lt;token&gt; (or the X-AgentHub-Log-Token
          header). Identity is derived from the token, never the request body.
        </Text>
        <Text style={styles.endpoint} testID="logs-endpoint-otlp">
          POST /api/otel/v1/logs
        </Text>
        <Text style={styles.endpoint} testID="logs-endpoint-batch">
          POST /api/logs/ingest
        </Text>
      </View>
    </ScrollView>
  );
}

/**
 * Standalone Log Sources screen (project Settings → Logs entry point kept for
 * deep links). Wraps `LogSourcesPanel` with the shared project header.
 */
export default function LogSourcesScreen({ route, navigation }: any) {
  const { projectId, project } = route.params || {};
  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ProjectScreenHeader title="Logs" project={project} onBack={() => navigation.goBack()} />
      <LogSourcesPanel projectId={projectId} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.gray950 },
  content: { padding: 16, paddingBottom: 32 },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.white,
    marginTop: 16,
    marginBottom: 6,
  },
  hint: { fontSize: 12, color: colors.gray500, marginBottom: 8 },
  card: {
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  row: { fontSize: 13, color: colors.gray300, marginBottom: 4 },
  error: { fontSize: 13, color: colors.red400, marginTop: 6 },
  warnBox: {
    backgroundColor: colors.yellow900_50,
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.amber900_40,
  },
  warnTitle: { fontSize: 13, color: colors.amber400, fontWeight: '600', marginBottom: 4 },
  warnBody: { fontSize: 12, color: colors.gray300 },
  input: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    padding: 10,
    color: colors.white,
    fontSize: 14,
  },
  primaryBtn: {
    backgroundColor: colors.emerald800_50,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryBtnText: { color: colors.emerald400, fontWeight: '600' },
  btnDisabled: { opacity: 0.5 },
  tokenBox: {
    backgroundColor: colors.yellow900_50,
    borderRadius: 8,
    padding: 12,
    marginTop: 8,
    borderWidth: 1,
    borderColor: colors.amber900_40,
  },
  tokenLabel: { fontSize: 12, color: colors.amber400, marginBottom: 6 },
  tokenValue: { fontSize: 11, color: colors.gray200, fontFamily: 'monospace' },
  tokenActions: { flexDirection: 'row', gap: 16, marginTop: 8 },
  link: { fontSize: 12, color: colors.blue400 },
  sourceCard: {
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 12,
    marginTop: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  sourceHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sourceName: { fontSize: 14, color: colors.white, fontWeight: '500' },
  statusChip: {
    fontSize: 10,
    fontWeight: '600',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
    overflow: 'hidden',
  },
  statusActive: { backgroundColor: colors.emerald900_50, color: colors.emerald400 },
  statusRevoked: { backgroundColor: colors.red900_50, color: colors.red400 },
  sourceMeta: { fontSize: 11, color: colors.gray500, marginTop: 3 },
  sourceActions: { flexDirection: 'row', gap: 18, marginTop: 10 },
  actionRotate: { fontSize: 13, color: colors.blue400, fontWeight: '500' },
  actionRevoke: { fontSize: 13, color: colors.amber400, fontWeight: '500' },
  actionDelete: { fontSize: 13, color: colors.red400, fontWeight: '500' },
  endpoint: { fontSize: 12, color: colors.gray300, fontFamily: 'monospace', marginTop: 6 },
});
