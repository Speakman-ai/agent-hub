import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { CheckSquare, Plus, Power, PowerOff, Rocket, Square, Trash2 } from 'lucide-react-native';
import { colors } from '../../theme/colors';
import { api } from '../../utils/api';
import {
  describeReleaseGate,
  describeReleaseGateProgress,
  sortReleaseGates,
  validateReleaseGateDraft,
  type DeployReleaseGate,
} from '../../utils/deployReleaseGates';

export interface ReleaseGatePickOption {
  id: string;
  label: string;
}

function statusLabel(gate: DeployReleaseGate): { text: string; color: string } {
  if (gate.status === 'fired') return { text: 'released', color: colors.emerald300 };
  if (gate.status === 'failed') return { text: 'failed', color: colors.red400 };
  if (gate.progress.blocked) return { text: 'blocked', color: colors.amber400 };
  if (gate.progress.satisfied) return { text: 'ready', color: colors.emerald300 };
  return { text: 'waiting', color: colors.gray400 };
}

/**
 * Presentational body for the per-environment release-gates editor. Pure and
 * props-driven so it can be render-tested (react-dom/server) without effects or
 * a live API — mirrors the EnvironmentSchedulesPanelContent split.
 */
export function EnvironmentReleaseGatesPanelContent({
  environmentName,
  gates,
  sessionOptions,
  epicOptions,
  loading,
  error,
  actionKey,
  refValue,
  selectedSessions,
  selectedEpics,
  adding,
  onRefChange,
  onToggleSessionOption,
  onToggleEpicOption,
  onAdd,
  onToggle,
  onDelete,
}: {
  environmentName: string;
  gates: DeployReleaseGate[];
  sessionOptions: ReleaseGatePickOption[];
  epicOptions: ReleaseGatePickOption[];
  loading: boolean;
  error: string | null;
  actionKey: string | null;
  refValue: string;
  selectedSessions: Record<string, boolean>;
  selectedEpics: Record<string, boolean>;
  adding: boolean;
  onRefChange: (value: string) => void;
  onToggleSessionOption: (id: string) => void;
  onToggleEpicOption: (id: string) => void;
  onAdd: () => void;
  onToggle: (gate: DeployReleaseGate) => void;
  onDelete: (gate: DeployReleaseGate) => void;
}) {
  const sorted = sortReleaseGates(gates);
  const selectedCount =
    Object.values(selectedSessions).filter(Boolean).length +
    Object.values(selectedEpics).filter(Boolean).length;
  const canAdd = selectedCount > 0 && !adding;

  return (
    <View style={styles.panel} testID={`env-release-gates-${environmentName}`}>
      <View style={styles.headerRow}>
        <Rocket size={13} color={colors.purple400} />
        <Text style={styles.title}>Release gates</Text>
      </View>
      <Text style={styles.help}>
        A release gate deploys a ref to {environmentName} once every selected session is merged and
        every selected epic is done — then it is consumed. A deleted selection blocks the gate.
      </Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {loading && gates.length === 0 ? (
        <ActivityIndicator color={colors.gray400} />
      ) : sorted.length === 0 ? (
        <Text style={styles.empty}>No release gates yet. Add one below.</Text>
      ) : (
        sorted.map((gate) => {
          const toggleKey = `toggle:${gate.id}`;
          const deleteKey = `delete:${gate.id}`;
          const terminal = gate.status !== 'armed';
          const status = statusLabel(gate);
          return (
            <View
              key={gate.id}
              style={[styles.gateRow, (!gate.enabled || terminal) && styles.disabledRow]}
              testID={`release-gate-row-${gate.id}`}
            >
              <View style={styles.refBadge}>
                <Text style={styles.refBadgeText} numberOfLines={1}>
                  {gate.ref}
                </Text>
              </View>
              <View style={styles.gateBody}>
                <Text style={[styles.statusText, { color: status.color }]}>{status.text}</Text>
                <Text style={styles.progressText} numberOfLines={1}>
                  {describeReleaseGateProgress(gate.progress)}
                </Text>
                {gate.status === 'failed' && gate.lastError ? (
                  <Text style={styles.failText} numberOfLines={1}>
                    {gate.lastError}
                  </Text>
                ) : null}
              </View>
              {!terminal ? (
                <TouchableOpacity
                  onPress={() => onToggle(gate)}
                  disabled={actionKey === toggleKey}
                  style={[styles.smallButton, actionKey === toggleKey && styles.disabled]}
                  accessibilityLabel={`${gate.enabled ? 'Disable' : 'Enable'} release gate`}
                >
                  {actionKey === toggleKey ? (
                    <ActivityIndicator color={colors.gray300} size="small" />
                  ) : gate.enabled ? (
                    <PowerOff size={12} color={colors.gray300} />
                  ) : (
                    <Power size={12} color={colors.emerald300} />
                  )}
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                onPress={() => onDelete(gate)}
                disabled={actionKey === deleteKey}
                style={[styles.smallButton, actionKey === deleteKey && styles.disabled]}
                accessibilityLabel="Delete release gate"
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
          placeholder="ref to deploy (default: main)"
          placeholderTextColor={colors.gray600}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          accessibilityLabel="Ref"
        />
        <PickList
          title="Sessions (merge to complete)"
          emptyLabel="No active sessions on the board."
          options={sessionOptions}
          selected={selectedSessions}
          onToggle={onToggleSessionOption}
          testID="release-gate-session-options"
        />
        <PickList
          title="Epics (all cards done to complete)"
          emptyLabel="No open epics."
          options={epicOptions}
          selected={selectedEpics}
          onToggle={onToggleEpicOption}
          testID="release-gate-epic-options"
        />
        <TouchableOpacity
          onPress={onAdd}
          disabled={!canAdd}
          style={[styles.addButton, !canAdd && styles.disabled]}
          accessibilityLabel="Add release gate"
        >
          {adding ? (
            <ActivityIndicator color={colors.emerald300} size="small" />
          ) : (
            <Plus size={13} color={colors.emerald300} />
          )}
          <Text style={styles.addButtonText}>Add release gate</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function PickList({
  title,
  emptyLabel,
  options,
  selected,
  onToggle,
  testID,
}: {
  title: string;
  emptyLabel: string;
  options: ReleaseGatePickOption[];
  selected: Record<string, boolean>;
  onToggle: (id: string) => void;
  testID: string;
}) {
  return (
    <View>
      <Text style={styles.pickTitle}>{title}</Text>
      {options.length === 0 ? (
        <Text style={styles.pickEmpty}>{emptyLabel}</Text>
      ) : (
        <View style={styles.pickList} testID={testID}>
          {options.map((o) => (
            <TouchableOpacity
              key={o.id}
              onPress={() => onToggle(o.id)}
              style={styles.pickRow}
              accessibilityLabel={`Toggle ${o.label}`}
            >
              {selected[o.id] ? (
                <CheckSquare size={13} color={colors.emerald300} />
              ) : (
                <Square size={13} color={colors.gray500} />
              )}
              <Text style={styles.pickLabel} numberOfLines={1}>
                {o.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * Per-environment release-gates editor (mobile). Owns state + API calls and
 * delegates rendering to {@link EnvironmentReleaseGatesPanelContent}. Mirrors the
 * web EnvironmentReleaseGatesPanel: curate sessions/epics from the board, then a
 * one-shot deployment fires once they all complete.
 */
export default function EnvironmentReleaseGatesPanel({
  projectId,
  environmentName,
  onNotify,
}: {
  projectId: string;
  environmentName: string;
  onNotify?: (message: string, type?: string) => void;
}) {
  const [gates, setGates] = useState<DeployReleaseGate[]>([]);
  const [sessionOptions, setSessionOptions] = useState<ReleaseGatePickOption[]>([]);
  const [epicOptions, setEpicOptions] = useState<ReleaseGatePickOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [ref, setRef] = useState('');
  const [selectedSessions, setSelectedSessions] = useState<Record<string, boolean>>({});
  const [selectedEpics, setSelectedEpics] = useState<Record<string, boolean>>({});
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
      const res = await api.listDeployReleaseGates(projectId, environmentName);
      setGates(res?.gates || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load release gates');
    } finally {
      setLoading(false);
    }
  }, [projectId, environmentName]);

  const loadOptions = useCallback(async () => {
    if (!projectId) return;
    try {
      const [board, epicsRes] = await Promise.all([
        api.getProjectBoard(projectId, { limit: 500 }).catch(() => null),
        api.getEpics(projectId).catch(() => null),
      ]);
      const columns: any[] = board?.columns || [];
      const sessions: ReleaseGatePickOption[] = [];
      const seen = new Set<string>();
      for (const col of columns) {
        const name = String(col?.name || '').toLowerCase();
        if (name.includes('done') || name.includes('cancel')) continue;
        for (const card of col?.cards || []) {
          if (!card?.session_id || seen.has(card.session_id)) continue;
          seen.add(card.session_id);
          sessions.push({ id: card.session_id, label: card.title || card.session_id });
        }
      }
      setSessionOptions(sessions);
      const epics: any[] = Array.isArray(epicsRes) ? epicsRes : epicsRes?.epics || [];
      setEpicOptions(
        epics
          .filter((e) => e?.id && e?.state !== 'done')
          .map((e) => ({ id: e.id, label: e.name || e.title || e.id })),
      );
    } catch {
      /* best-effort options */
    }
  }, [projectId]);

  useEffect(() => {
    load();
    loadOptions();
  }, [load, loadOptions]);

  const draftSessionIds = useMemo(
    () => Object.keys(selectedSessions).filter((k) => selectedSessions[k]),
    [selectedSessions],
  );
  const draftEpicIds = useMemo(
    () => Object.keys(selectedEpics).filter((k) => selectedEpics[k]),
    [selectedEpics],
  );

  const addGate = useCallback(async () => {
    const draft = { ref, sessionIds: draftSessionIds, epicIds: draftEpicIds };
    const validationError = validateReleaseGateDraft(draft);
    if (validationError) {
      notify(validationError, 'error');
      return;
    }
    setAdding(true);
    try {
      const res = await api.createDeployReleaseGate(projectId, environmentName, {
        ref: draft.ref.trim() || null,
        sessionIds: draft.sessionIds,
        epicIds: draft.epicIds,
      });
      if (res?.gate) setGates((prev) => [...prev, res.gate]);
      setRef('');
      setSelectedSessions({});
      setSelectedEpics({});
      notify(`Release gate added to ${environmentName}`, 'success');
    } catch (e: any) {
      notify(e?.message || 'Failed to add release gate', 'error');
    } finally {
      setAdding(false);
    }
  }, [projectId, environmentName, ref, draftSessionIds, draftEpicIds, notify]);

  const toggleGate = useCallback(
    async (gate: DeployReleaseGate) => {
      const key = `toggle:${gate.id}`;
      setActionKey(key);
      try {
        const res = await api.updateDeployReleaseGate(projectId, environmentName, gate.id, {
          enabled: !gate.enabled,
        });
        if (res?.gate) setGates((prev) => prev.map((g) => (g.id === gate.id ? res.gate : g)));
        notify(`Release gate ${!gate.enabled ? 'enabled' : 'disabled'}`, 'success');
      } catch (e: any) {
        notify(e?.message || 'Failed to update release gate', 'error');
      } finally {
        setActionKey(null);
      }
    },
    [projectId, environmentName, notify],
  );

  const doDelete = useCallback(
    async (gate: DeployReleaseGate) => {
      const key = `delete:${gate.id}`;
      setActionKey(key);
      try {
        await api.deleteDeployReleaseGate(projectId, environmentName, gate.id);
        setGates((prev) => prev.filter((g) => g.id !== gate.id));
        notify('Release gate deleted', 'success');
      } catch (e: any) {
        notify(e?.message || 'Failed to delete release gate', 'error');
      } finally {
        setActionKey(null);
      }
    },
    [projectId, environmentName, notify],
  );

  const confirmDelete = useCallback(
    (gate: DeployReleaseGate) => {
      Alert.alert('Delete release gate', `Delete the release gate "${describeReleaseGate(gate)}"?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => doDelete(gate) },
      ]);
    },
    [doDelete],
  );

  return (
    <EnvironmentReleaseGatesPanelContent
      environmentName={environmentName}
      gates={gates}
      sessionOptions={sessionOptions}
      epicOptions={epicOptions}
      loading={loading}
      error={error}
      actionKey={actionKey}
      refValue={ref}
      selectedSessions={selectedSessions}
      selectedEpics={selectedEpics}
      adding={adding}
      onRefChange={setRef}
      onToggleSessionOption={(id) => setSelectedSessions((p) => ({ ...p, [id]: !p[id] }))}
      onToggleEpicOption={(id) => setSelectedEpics((p) => ({ ...p, [id]: !p[id] }))}
      onAdd={addGate}
      onToggle={toggleGate}
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
  gateRow: {
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
    borderColor: colors.purple500,
    backgroundColor: colors.gray950,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    maxWidth: 110,
  },
  refBadgeText: {
    color: colors.purple400,
    fontSize: 10,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  gateBody: { flex: 1 },
  statusText: { fontSize: 10, fontWeight: '600', textTransform: 'uppercase' },
  progressText: { color: colors.gray400, fontSize: 11 },
  failText: { color: colors.red400, fontSize: 10 },
  smallButton: { borderWidth: 1, borderColor: colors.gray700, borderRadius: 6, padding: 6 },
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
  pickTitle: { color: colors.gray400, fontSize: 11, fontWeight: '500', marginBottom: 2 },
  pickEmpty: {
    color: colors.gray600,
    fontSize: 11,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  pickList: {
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray950,
    borderRadius: 6,
    padding: 4,
    gap: 2,
  },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4, paddingHorizontal: 4 },
  pickLabel: { color: colors.gray300, fontSize: 12, flex: 1 },
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
