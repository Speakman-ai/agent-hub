import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  TextInput,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { api } from '../utils/api';
import { colors } from '../theme/colors';

/** Page-name hint cap; matches `MAX_PAGE_NAME_HINT_LEN` on the task pack. */
const MAX_PAGE_NAME_HINT_LEN = 80;

export function isScaffolderEligibleAgent(agent: any): boolean {
  if (agent?.active === false) return false;
  return agent?.role !== 'reviewer';
}

export default function VotingScaffolderModal({
  currentProjectId,
  onClose,
  onOpened,
}: {
  currentProjectId: string;
  onClose: () => void;
  onOpened: (target: { sessionId: string; agentId: string }) => void;
}) {
  const [projects, setProjects] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [projectId, setProjectId] = useState(currentProjectId);
  const [agentId, setAgentId] = useState('');
  const [pageNameHint, setPageNameHint] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([api.getProjects(), api.getAgents()])
      .then(([projectList, agentList]) => {
        if (cancelled) return;
        const rows = Array.isArray(projectList) ? projectList : [];
        setProjects(rows);
        setAgents(Array.isArray(agentList) ? agentList : []);
        const defaultId = rows.some((p: any) => String(p.id) === currentProjectId)
          ? currentProjectId
          : rows.length
            ? String(rows[0].id)
            : '';
        if (defaultId) setProjectId(defaultId);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || 'Failed to load projects');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentProjectId]);

  const eligibleAgents = useMemo(
    () =>
      agents.filter((a: any) => String(a.projectId) === projectId && isScaffolderEligibleAgent(a)),
    [agents, projectId],
  );

  useEffect(() => {
    if (!eligibleAgents.length) {
      setAgentId('');
      return;
    }
    if (!eligibleAgents.some((a: any) => a.id === agentId)) {
      setAgentId(eligibleAgents[0].id);
    }
  }, [eligibleAgents, agentId]);

  const canSubmit = Boolean(projectId && agentId) && !submitting && !loading;

  const dismiss = () => {
    if (submitting) return;
    onClose();
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const hint = pageNameHint.trim();
      const res: any = await api.startVotingScaffolder(projectId, {
        agentId,
        pageNameHint: hint || undefined,
      });
      if (!mountedRef.current) return;
      if (!res?.sessionId) {
        throw new Error('Server did not return a session id');
      }
      onOpened({ sessionId: res.sessionId, agentId: res.agentId || agentId });
    } catch (err: any) {
      if (!mountedRef.current) return;
      setError(err?.message || 'Failed to start the voting setup session');
      setSubmitting(false);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={dismiss}>
      <View style={styles.backdrop}>
        <View style={styles.card} testID="voting-setup-modal">
          <View style={styles.header}>
            <Text style={styles.title}>Set up voting in an app</Text>
            <TouchableOpacity
              onPress={dismiss}
              disabled={submitting}
              accessibilityLabel="Close"
              testID="voting-setup-close"
            >
              <Text style={styles.close}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.body}>
            <Text style={styles.explainer} testID="voting-setup-explainer">
              The agent will inspect the target app, match its existing styling, and ask where the
              voting page should live before generating anything.
            </Text>

            {error ? (
              <Text style={styles.error} testID="voting-setup-error">
                {error}
              </Text>
            ) : null}

            <Text style={styles.label}>Target project</Text>
            <View testID="voting-setup-project" style={styles.optionList}>
              {loading ? (
                <Text style={styles.hint}>Loading projects…</Text>
              ) : !projects.length ? (
                <Text style={styles.hint}>No projects available</Text>
              ) : (
                projects.map((p: any) => {
                  const id = String(p.id);
                  const selected = id === projectId;
                  return (
                    <TouchableOpacity
                      key={id}
                      testID={`voting-setup-project-option-${id}`}
                      accessibilityState={{ selected }}
                      disabled={loading || submitting}
                      onPress={() => setProjectId(id)}
                      style={[styles.option, selected && styles.optionSelected]}
                    >
                      <Text style={[styles.optionText, selected && styles.optionTextSelected]}>
                        {p.name || p.id}
                      </Text>
                    </TouchableOpacity>
                  );
                })
              )}
            </View>

            <Text style={styles.label}>Agent / engine</Text>
            <View testID="voting-setup-agent" style={styles.optionList}>
              {loading ? (
                <Text style={styles.hint}>Loading agents…</Text>
              ) : !eligibleAgents.length ? (
                <Text style={styles.hint}>No agents in this project</Text>
              ) : (
                eligibleAgents.map((a: any) => {
                  const selected = a.id === agentId;
                  return (
                    <TouchableOpacity
                      key={a.id}
                      testID={`voting-setup-agent-option-${a.id}`}
                      accessibilityState={{ selected }}
                      disabled={loading || submitting}
                      onPress={() => setAgentId(a.id)}
                      style={[styles.option, selected && styles.optionSelected]}
                    >
                      <Text style={[styles.optionText, selected && styles.optionTextSelected]}>
                        {a.name || a.id}
                        {a.engine ? ` (${a.engine})` : ''}
                      </Text>
                    </TouchableOpacity>
                  );
                })
              )}
            </View>

            <Text style={styles.label}>Page name / route hint (optional)</Text>
            <TextInput
              testID="voting-setup-page-hint"
              value={pageNameHint}
              onChangeText={setPageNameHint}
              maxLength={MAX_PAGE_NAME_HINT_LEN}
              placeholder="e.g. /ideas or Feature Voting"
              placeholderTextColor={colors.gray600}
              editable={!submitting}
              style={styles.input}
            />
          </ScrollView>

          <View style={styles.actions}>
            <TouchableOpacity
              onPress={dismiss}
              disabled={submitting}
              testID="voting-setup-cancel"
              style={[styles.cancel, submitting && styles.confirmDisabled]}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => void submit()}
              disabled={!canSubmit}
              testID="voting-setup-confirm"
              style={[styles.confirm, !canSubmit && styles.confirmDisabled]}
            >
              {submitting ? (
                <ActivityIndicator size="small" color={colors.white} />
              ) : (
                <Text style={styles.confirmText}>Start setup</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '90%',
    backgroundColor: colors.gray900,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  title: { fontSize: 15, fontWeight: '700', color: colors.white, flex: 1, marginRight: 8 },
  close: { fontSize: 16, color: colors.gray400, padding: 4 },
  body: { paddingHorizontal: 16, paddingVertical: 12 },
  explainer: { fontSize: 13, color: colors.gray400, marginBottom: 12, lineHeight: 18 },
  error: {
    fontSize: 13,
    color: colors.red400,
    backgroundColor: colors.red900_50,
    borderWidth: 1,
    borderColor: colors.red400,
    borderRadius: 6,
    padding: 10,
    marginBottom: 12,
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.gray400,
    textTransform: 'uppercase',
    marginBottom: 6,
    marginTop: 8,
  },
  optionList: { gap: 6, marginBottom: 4 },
  option: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray800,
  },
  optionSelected: { backgroundColor: colors.gray700, borderColor: colors.gray600 },
  optionText: { fontSize: 13, color: colors.gray300 },
  optionTextSelected: { color: colors.white, fontWeight: '600' },
  hint: { fontSize: 13, color: colors.gray500, paddingVertical: 6 },
  input: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    backgroundColor: colors.gray950,
    color: colors.gray100,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    marginBottom: 8,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
  },
  cancel: { paddingHorizontal: 12, paddingVertical: 8 },
  cancelText: { fontSize: 13, color: colors.gray400, fontWeight: '600' },
  confirm: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: colors.blue600,
  },
  confirmDisabled: { opacity: 0.5 },
  confirmText: { fontSize: 13, color: colors.white, fontWeight: '700' },
});
