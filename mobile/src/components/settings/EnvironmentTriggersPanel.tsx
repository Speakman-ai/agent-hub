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
import { Plus, Power, PowerOff, Trash2, Zap } from 'lucide-react-native';
import { colors } from '../../theme/colors';
import { api } from '../../utils/api';
import {
  DEPLOY_TRIGGER_EVENTS,
  sortTriggers,
  triggerEventLabel,
  validateTriggerDraft,
  type DeployTrigger,
  type DeployTriggerEvent,
} from '../../utils/deployTriggers';

/**
 * Presentational body for the per-environment deploy-triggers editor. Pure and
 * props-driven so it can be render-tested (react-dom/server) without effects or
 * a live API — mirrors the CalendarAgendaContent / GoogleConnectionContent split.
 */
export function EnvironmentTriggersPanelContent({
  environmentName,
  triggers,
  loading,
  error,
  actionKey,
  event,
  branchPattern,
  adding,
  onEventChange,
  onBranchPatternChange,
  onAdd,
  onToggle,
  onDelete,
}: {
  environmentName: string;
  triggers: DeployTrigger[];
  loading: boolean;
  error: string | null;
  actionKey: string | null;
  event: DeployTriggerEvent;
  branchPattern: string;
  adding: boolean;
  onEventChange: (event: DeployTriggerEvent) => void;
  onBranchPatternChange: (value: string) => void;
  onAdd: () => void;
  onToggle: (trigger: DeployTrigger) => void;
  onDelete: (trigger: DeployTrigger) => void;
}) {
  const sorted = sortTriggers(triggers);
  return (
    <View style={styles.panel} testID={`env-triggers-${environmentName}`}>
      <View style={styles.headerRow}>
        <Zap size={13} color={colors.amber400} />
        <Text style={styles.title}>Deploy triggers</Text>
      </View>
      <Text style={styles.help}>
        A matching push or merge auto-deploys {environmentName}. Use * to match within a branch
        segment and ** across segments.
      </Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {loading && triggers.length === 0 ? (
        <ActivityIndicator color={colors.gray400} />
      ) : sorted.length === 0 ? (
        <Text style={styles.empty}>No triggers yet. Add one below.</Text>
      ) : (
        sorted.map((trigger) => {
          const toggleKey = `toggle:${trigger.id}`;
          const deleteKey = `delete:${trigger.id}`;
          return (
            <View
              key={trigger.id}
              style={[styles.triggerRow, !trigger.enabled && styles.disabledRow]}
              testID={`trigger-row-${trigger.id}`}
            >
              <View style={styles.eventBadge}>
                <Text style={styles.eventBadgeText}>{triggerEventLabel(trigger.event)}</Text>
              </View>
              <Text style={styles.pattern} numberOfLines={1}>
                {trigger.branchPattern}
              </Text>
              <TouchableOpacity
                onPress={() => onToggle(trigger)}
                disabled={actionKey === toggleKey}
                style={[styles.smallButton, actionKey === toggleKey && styles.disabled]}
                accessibilityLabel={`${trigger.enabled ? 'Disable' : 'Enable'} trigger`}
              >
                {actionKey === toggleKey ? (
                  <ActivityIndicator color={colors.gray300} size="small" />
                ) : trigger.enabled ? (
                  <PowerOff size={12} color={colors.gray300} />
                ) : (
                  <Power size={12} color={colors.emerald300} />
                )}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => onDelete(trigger)}
                disabled={actionKey === deleteKey}
                style={[styles.smallButton, actionKey === deleteKey && styles.disabled]}
                accessibilityLabel="Delete trigger"
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

      <View style={styles.addRow}>
        <View style={styles.eventToggle}>
          {DEPLOY_TRIGGER_EVENTS.map((ev) => (
            <TouchableOpacity
              key={ev}
              onPress={() => onEventChange(ev)}
              style={[styles.eventOption, event === ev && styles.eventOptionActive]}
              accessibilityLabel={`Event ${ev}`}
              accessibilityState={{ selected: event === ev }}
            >
              <Text style={[styles.eventOptionText, event === ev && styles.eventOptionTextActive]}>
                {triggerEventLabel(ev)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <TextInput
          value={branchPattern}
          onChangeText={onBranchPatternChange}
          placeholder="branch pattern"
          placeholderTextColor={colors.gray600}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          accessibilityLabel="Branch pattern"
        />
        <TouchableOpacity
          onPress={onAdd}
          disabled={adding || !branchPattern.trim()}
          style={[styles.addButton, (adding || !branchPattern.trim()) && styles.disabled]}
          accessibilityLabel="Add trigger"
        >
          {adding ? (
            <ActivityIndicator color={colors.emerald300} size="small" />
          ) : (
            <Plus size={13} color={colors.emerald300} />
          )}
          <Text style={styles.addButtonText}>Add</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/**
 * Per-environment deploy-triggers editor (mobile). Owns state + API calls and
 * delegates rendering to {@link EnvironmentTriggersPanelContent}. Mirrors the web
 * EnvironmentTriggersPanel: list git-event triggers for one environment and
 * add / enable / disable / delete them without editing deploy.yaml.
 */
export default function EnvironmentTriggersPanel({
  projectId,
  environmentName,
  onNotify,
}: {
  projectId: string;
  environmentName: string;
  onNotify?: (message: string, type?: string) => void;
}) {
  const [triggers, setTriggers] = useState<DeployTrigger[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [event, setEvent] = useState<DeployTriggerEvent>('push');
  const [branchPattern, setBranchPattern] = useState('');
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
      const res = await api.listDeployTriggers(projectId, environmentName);
      setTriggers(res?.triggers || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load triggers');
    } finally {
      setLoading(false);
    }
  }, [projectId, environmentName]);

  useEffect(() => {
    load();
  }, [load]);

  const addTrigger = useCallback(async () => {
    const draft = { event, branchPattern };
    const validationError = validateTriggerDraft(draft);
    if (validationError) {
      notify(validationError, 'error');
      return;
    }
    setAdding(true);
    try {
      const res = await api.createDeployTrigger(projectId, environmentName, {
        event: draft.event,
        branchPattern: draft.branchPattern.trim(),
      });
      if (res?.trigger) setTriggers((prev) => [...prev, res.trigger]);
      setBranchPattern('');
      setEvent('push');
      notify(`Trigger added to ${environmentName}`, 'success');
    } catch (e: any) {
      notify(e?.message || 'Failed to add trigger', 'error');
    } finally {
      setAdding(false);
    }
  }, [projectId, environmentName, event, branchPattern, notify]);

  const toggleTrigger = useCallback(
    async (trigger: DeployTrigger) => {
      const key = `toggle:${trigger.id}`;
      setActionKey(key);
      try {
        const res = await api.updateDeployTrigger(projectId, environmentName, trigger.id, {
          enabled: !trigger.enabled,
        });
        if (res?.trigger) {
          setTriggers((prev) => prev.map((t) => (t.id === trigger.id ? res.trigger : t)));
        }
        notify(`Trigger ${!trigger.enabled ? 'enabled' : 'disabled'}`, 'success');
      } catch (e: any) {
        notify(e?.message || 'Failed to update trigger', 'error');
      } finally {
        setActionKey(null);
      }
    },
    [projectId, environmentName, notify],
  );

  const doDelete = useCallback(
    async (trigger: DeployTrigger) => {
      const key = `delete:${trigger.id}`;
      setActionKey(key);
      try {
        await api.deleteDeployTrigger(projectId, environmentName, trigger.id);
        setTriggers((prev) => prev.filter((t) => t.id !== trigger.id));
        notify('Trigger deleted', 'success');
      } catch (e: any) {
        notify(e?.message || 'Failed to delete trigger', 'error');
      } finally {
        setActionKey(null);
      }
    },
    [projectId, environmentName, notify],
  );

  const confirmDelete = useCallback(
    (trigger: DeployTrigger) => {
      Alert.alert(
        'Delete trigger',
        `Delete the ${trigger.event} trigger for "${trigger.branchPattern}"?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: () => doDelete(trigger) },
        ],
      );
    },
    [doDelete],
  );

  return (
    <EnvironmentTriggersPanelContent
      environmentName={environmentName}
      triggers={triggers}
      loading={loading}
      error={error}
      actionKey={actionKey}
      event={event}
      branchPattern={branchPattern}
      adding={adding}
      onEventChange={setEvent}
      onBranchPatternChange={setBranchPattern}
      onAdd={addTrigger}
      onToggle={toggleTrigger}
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
  triggerRow: {
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
  eventBadge: {
    borderWidth: 1,
    borderColor: colors.blue500,
    backgroundColor: colors.blue900_40,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  eventBadgeText: {
    color: colors.blue300,
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  pattern: { flex: 1, color: colors.gray200, fontSize: 12, fontFamily: 'monospace' },
  smallButton: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    padding: 6,
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
    paddingTop: 8,
    flexWrap: 'wrap',
  },
  eventToggle: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    overflow: 'hidden',
  },
  eventOption: { paddingHorizontal: 8, paddingVertical: 6 },
  eventOptionActive: { backgroundColor: colors.blue900_40 },
  eventOptionText: { color: colors.gray400, fontSize: 11 },
  eventOptionTextActive: { color: colors.blue300, fontWeight: '600' },
  input: {
    flex: 1,
    minWidth: 120,
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
    gap: 4,
    borderWidth: 1,
    borderColor: colors.emerald500,
    backgroundColor: colors.emerald900_40,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  addButtonText: { color: colors.emerald300, fontSize: 12, fontWeight: '500' },
  disabled: { opacity: 0.5 },
});
