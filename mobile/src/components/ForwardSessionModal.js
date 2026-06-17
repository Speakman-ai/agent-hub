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

// Re-export for convenience so callers can import both the modal and the
// filter from a single module (matches the web client's shape).
export { filterForwardTargets };

export default function ForwardSessionModal({
  visible,
  sourceAgent,
  agents,
  sessionId,
  onClose,
  onForward,
  onForwarded,
  onError,
}) {
  const [selectedAgentId, setSelectedAgentId] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [autoStart, setAutoStart] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const candidates = useMemo(
    () => filterForwardTargets(agents, sourceAgent),
    [agents, sourceAgent],
  );

  const reset = () => {
    setSelectedAgentId(null);
    setPrompt('');
    setAutoStart(false);
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
      });
      onForwarded?.(result);
      reset();
      onClose?.();
    } catch (err) {
      const message = err?.message || 'Forward failed';
      setError(message);
      onError?.(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleClose}
    >
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
                No agents in this project to forward to. Add an agent in
                Settings to use this feature.
              </Text>
            </View>
          ) : (
            <>
              <ScrollView style={styles.agentList} keyboardShouldPersistTaps="handled">
                {candidates.map((agent) => {
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
            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={handleClose}
              disabled={submitting}
            >
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
              <Text style={styles.submitText}>
                {submitting ? 'Forwarding...' : 'Forward'}
              </Text>
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
