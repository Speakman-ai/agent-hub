import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Switch,
} from 'react-native';
import AppIcon from './AppIcon';
import { colors } from '../theme/colors';
import { filterForwardTargets } from '../utils/forwardTargets';
import {
  modelsForEngine,
  ENGINE_DEFAULT_MODELS,
  engineOptionsFromConfig,
} from '../utils/engineOptions';
// Re-export for convenience so callers can import both the modal and the
// filter from a single module (matches the web client's shape).
export { filterForwardTargets };
export default function ForwardSessionModal({
  visible,
  sourceAgent,
  agents,
  sessionId,
  modelConfig = null,
  onClose,
  onForward,
  onForwarded,
  onError,
}: any) {
  const [selectedAgentId, setSelectedAgentId] = useState<any>(null);
  const [prompt, setPrompt] = useState('');
  const [autoStart, setAutoStart] = useState(false);
  // A model override tagged with the agent id it was picked for. Storing the
  // identity lets us derive the effective model synchronously and ignore a
  // choice that belongs to a previously-selected target — so switching agents
  // can never leave a stale/foreign model in flight (no re-seed effect race).
  const [modelChoice, setModelChoice] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<any>(null);
  const candidates = useMemo<any>(
    () => filterForwardTargets(agents, sourceAgent),
    [agents, sourceAgent],
  );
  const selectedAgent = useMemo<any>(
    () => candidates.find((a: any) => a.id === selectedAgentId) || null,
    [candidates, selectedAgentId],
  );
  // The fork defaults to the target agent's engine, but the picker lists every
  // authenticated engine's models grouped by engine, so a user can fork onto a
  // different engine (e.g. a claude-code agent onto a Codex model). The target
  // engine's group is listed first so the common case stays at the top.
  const selectedEngine = selectedAgent?.engine || 'claude-code';
  const orderedEngines = useMemo<any[]>(() => {
    const opts = engineOptionsFromConfig(modelConfig).filter(
      (o: any) => modelsForEngine(o.id, modelConfig).length > 0,
    );
    const idx = opts.findIndex((o: any) => o.id === selectedEngine);
    if (idx <= 0) return opts;
    const [own] = opts.splice(idx, 1);
    return [own, ...opts];
  }, [modelConfig, selectedEngine]);
  const hasAnyModels = orderedEngines.length > 0;
  // Default model for the currently-selected target: its own configured model
  // when valid for its engine, else the configured/engine default. Derived.
  const defaultModel = useMemo<string>(() => {
    if (!selectedAgent || !hasAnyModels) return '';
    const ids = modelsForEngine(selectedEngine, modelConfig).map((m: any) => m.id);
    const agentModel = selectedAgent.model;
    if (agentModel && ids.includes(agentModel)) return agentModel;
    const configured = modelConfig?.engineDefaultModels?.[selectedEngine];
    if (configured && ids.includes(configured)) return configured;
    const fallback = ENGINE_DEFAULT_MODELS[selectedEngine];
    return fallback && ids.includes(fallback) ? fallback : ids[0];
  }, [selectedAgent, selectedEngine, hasAnyModels, modelConfig]);
  // Effective engine/model, computed synchronously each render. An override only
  // counts when it was picked for the *current* target and is still valid for
  // its engine; otherwise fall back to the target agent's engine and default
  // model. Both the rendered selection and the submitted payload read this, so
  // no window can forward a prior target's choice.
  const choiceValid =
    modelChoice &&
    modelChoice.agentId === selectedAgentId &&
    modelsForEngine(modelChoice.engine, modelConfig).some((m: any) => m.id === modelChoice.model);
  const engine = choiceValid ? modelChoice.engine : selectedEngine;
  const model = choiceValid ? modelChoice.model : defaultModel;
  const reset = () => {
    setSelectedAgentId(null);
    setPrompt('');
    setAutoStart(false);
    setModelChoice(null);
    setError(null);
    setSubmitting(false);
  };
  const handleClose = () => {
    if (submitting) return;
    reset();
    onClose?.();
  };
  const handleSubmit = async () => {
    if (!selectedAgentId || submitting || !sessionId) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await onForward({
        targetAgentId: selectedAgentId,
        prompt: prompt.trim() || undefined,
        autoStart,
        model: model || undefined,
        // Only send an engine override when the pick moves off the target
        // agent's own engine; otherwise the server keeps inheriting it.
        engine: engine && engine !== selectedEngine ? engine : undefined,
      });
      onForwarded?.(result);
      reset();
      onClose?.();
    } catch (err: any) {
      const message = err?.message || 'Forward failed';
      setError(message);
      onError?.(message);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <Pressable style={styles.overlay} onPress={handleClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <AppIcon name="arrow-redo-outline" size={16} color={colors.gray400} />
              <Text style={styles.headerTitle}>Forward session</Text>
              {sourceAgent?.name ? (
                <Text style={styles.headerSubtitle} numberOfLines={1}>
                  from {sourceAgent.name}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity onPress={handleClose} disabled={submitting}>
              <AppIcon name="close" size={20} color={colors.gray400} />
            </TouchableOpacity>
          </View>

          {candidates.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>
                No agents available to forward to. Add an agent in Settings to use this feature.
              </Text>
            </View>
          ) : (
            <>
              <ScrollView style={styles.agentList} keyboardShouldPersistTaps="handled">
                {candidates.map((agent: any) => {
                  const selected = selectedAgentId === agent.id;
                  const isSelf = agent.id === sourceAgent?.id;
                  return (
                    <TouchableOpacity
                      key={agent.id}
                      style={[styles.agentRow, selected && styles.agentRowSelected]}
                      onPress={() => setSelectedAgentId(agent.id)}
                    >
                      <View style={[styles.agentDot, { backgroundColor: agent.color }]} />
                      <View style={styles.agentText}>
                        <View style={styles.agentNameRow}>
                          <Text style={styles.agentName} numberOfLines={1}>
                            {agent.name}
                          </Text>
                          {isSelf && (
                            <View style={styles.selfBadge}>
                              <Text style={styles.selfBadgeText}>THIS AGENT</Text>
                            </View>
                          )}
                        </View>
                        <Text style={styles.agentMeta} numberOfLines={1}>
                          {isSelf
                            ? 'Fork this conversation into a new session'
                            : `${agent.engine}${agent.projectName ? ` · ${agent.projectName}` : ''}`}
                        </Text>
                      </View>
                      {selected && <Text style={styles.check}>✓</Text>}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>

              <View style={styles.controls}>
                {selectedAgent && hasAnyModels && (
                  <View style={styles.modelSection}>
                    <Text style={styles.label}>Model</Text>
                    {orderedEngines.map((eng: any) => (
                      <View key={eng.id} style={styles.modelEngineGroup}>
                        <Text style={styles.modelEngineLabel}>{eng.label || eng.id}</Text>
                        <View style={styles.modelChips}>
                          {modelsForEngine(eng.id, modelConfig).map((m: any) => {
                            const active = m.id === model && eng.id === engine;
                            return (
                              <TouchableOpacity
                                key={`${eng.id}:${m.id}`}
                                style={[styles.modelChip, active && styles.modelChipActive]}
                                accessibilityRole="button"
                                accessibilityLabel={`Use ${eng.label || eng.id} model ${m.label}`}
                                onPress={() =>
                                  setModelChoice({
                                    agentId: selectedAgentId,
                                    engine: eng.id,
                                    model: m.id,
                                  })
                                }
                              >
                                <Text
                                  style={[
                                    styles.modelChipText,
                                    active && styles.modelChipTextActive,
                                  ]}
                                >
                                  {m.short || m.label}
                                </Text>
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                      </View>
                    ))}
                    {engine !== selectedEngine && (
                      <Text style={styles.modelEngineHint}>
                        Forks onto {engine} instead of the agent's {selectedEngine}.
                      </Text>
                    )}
                  </View>
                )}
                <Text style={styles.label}>Extra instructions (optional)</Text>
                <TextInput
                  value={prompt}
                  onChangeText={setPrompt}
                  multiline
                  numberOfLines={2}
                  placeholder="What should the target agent do with this context?"
                  placeholderTextColor={colors.gray500}
                  style={styles.textarea}
                />
                <View style={styles.autoStartRow}>
                  <Text style={styles.autoStartLabel}>Auto-start target agent</Text>
                  <Switch
                    value={autoStart}
                    onValueChange={setAutoStart}
                    trackColor={{ true: colors.blue400, false: colors.gray700 }}
                  />
                </View>
                {error && <Text style={styles.error}>{error}</Text>}
              </View>
            </>
          )}

          <View style={styles.footer}>
            <TouchableOpacity style={styles.cancelBtn} onPress={handleClose} disabled={submitting}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.submitBtn,
                (!selectedAgentId || submitting || candidates.length === 0) &&
                  styles.submitBtnDisabled,
              ]}
              onPress={handleSubmit}
              disabled={!selectedAgentId || submitting || candidates.length === 0}
            >
              {submitting ? (
                <ActivityIndicator size="small" color={colors.white} />
              ) : (
                <AppIcon name="send" size={14} color={colors.white} />
              )}
              <Text style={styles.submitText}>{submitting ? 'Forwarding...' : 'Forward'}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: colors.black50,
    justifyContent: 'center',
    padding: 16,
  },
  sheet: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 12,
    maxHeight: '90%',
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  headerTitle: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '600',
  },
  headerSubtitle: {
    color: colors.gray500,
    fontSize: 12,
    flex: 1,
  },
  empty: {
    padding: 20,
  },
  emptyText: {
    color: colors.gray400,
    fontSize: 13,
  },
  agentList: {
    maxHeight: 240,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  agentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  agentRowSelected: {
    backgroundColor: colors.gray800,
    borderColor: colors.gray600,
  },
  agentDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  agentText: {
    flex: 1,
    minWidth: 0,
  },
  agentNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  agentName: {
    color: colors.white,
    fontSize: 13,
    flexShrink: 1,
  },
  selfBadge: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  selfBadgeText: {
    color: colors.gray500,
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  agentMeta: {
    color: colors.gray500,
    fontSize: 11,
  },
  check: {
    color: colors.emerald400,
    fontSize: 14,
  },
  controls: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
  },
  label: {
    color: colors.gray400,
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 4,
  },
  modelSection: {
    marginBottom: 10,
  },
  modelEngineGroup: {
    marginBottom: 8,
  },
  modelEngineLabel: {
    color: colors.gray500,
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  modelEngineHint: {
    color: '#fbbf24',
    fontSize: 11,
    marginTop: 2,
  },
  modelChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  modelChip: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.gray800,
  },
  modelChipActive: {
    borderColor: colors.gray600,
    backgroundColor: colors.gray700,
  },
  modelChipText: {
    color: colors.gray400,
    fontSize: 12,
  },
  modelChipTextActive: {
    color: colors.white,
  },
  textarea: {
    backgroundColor: colors.gray800,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    color: colors.white,
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 56,
    textAlignVertical: 'top',
  },
  autoStartRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  autoStartLabel: {
    color: colors.gray300,
    fontSize: 12,
  },
  error: {
    color: colors.red400,
    fontSize: 12,
    marginTop: 6,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
  },
  cancelBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  cancelText: {
    color: colors.gray400,
    fontSize: 12,
  },
  submitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.blue600 || '#2563eb',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  submitBtnDisabled: {
    opacity: 0.5,
  },
  submitText: {
    color: colors.white,
    fontSize: 12,
    fontWeight: '600',
  },
});
