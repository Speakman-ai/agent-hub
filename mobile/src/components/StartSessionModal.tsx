import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { agentsForProject, type LinkOption } from '@shared/utils/linkTodo';

/**
 * Mobile "Start session with this as context" picker — 1:1 peer of the web
 * `StartSessionModal`. Emails and cross-project personal todos are not bound to
 * an agent, so the user picks a project → agent, reviews the pre-built context
 * block, and starts a new session seeded with it (server-side `seedMessage`).
 */

export default function StartSessionModal({
  contextLabel,
  seedMessage,
  defaultName,
  onClose,
  onStarted,
}: {
  contextLabel: string;
  seedMessage: string;
  defaultName?: string;
  onClose: () => void;
  onStarted: (session: any) => void;
}) {
  const [projects, setProjects] = useState<any[]>([]);
  const [projectId, setProjectId] = useState<string>('');
  const [agents, setAgents] = useState<LinkOption[]>([]);
  const [agentId, setAgentId] = useState<string>('');
  const [seed, setSeed] = useState<string>(seedMessage);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingProjects(true);
    api
      .getProjects()
      .then((list: any) => {
        if (cancelled) return;
        const rows = Array.isArray(list) ? list : [];
        setProjects(rows);
        if (rows.length) setProjectId(String(rows[0].id));
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || 'Failed to load projects');
      })
      .finally(() => {
        if (!cancelled) setLoadingProjects(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setError(null);
    if (!projectId) return;
    let cancelled = false;
    setLoadingAgents(true);
    setAgents([]);
    setAgentId('');
    api
      .getAgents()
      .then((list: any) => {
        if (cancelled) return;
        const scoped = agentsForProject(list, projectId);
        setAgents(scoped);
        if (scoped.length) setAgentId(scoped[0].id);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || 'Failed to load agents');
      })
      .finally(() => {
        if (!cancelled) setLoadingAgents(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const canSubmit = !!agentId && !!seed.trim() && !submitting && !loadingAgents;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const session: any = await api.createSession(agentId, defaultName, {
        seedMessage: seed.trim(),
      });
      onStarted(session);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to start session');
      setSubmitting(false);
    }
  };

  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.heading}>Start session with context</Text>
          <ScrollView keyboardShouldPersistTaps="handled">
            {error ? (
              <Text style={styles.errorText} testID="start-session-error">
                {error}
              </Text>
            ) : null}

            <Text style={styles.contextLabel} numberOfLines={2}>
              {contextLabel}
            </Text>

            <Text style={styles.label}>Project</Text>
            {loadingProjects ? (
              <ActivityIndicator color={colors.blue400} style={styles.loader} />
            ) : !projects.length ? (
              <Text style={styles.muted}>No projects available</Text>
            ) : (
              <View style={styles.chipWrap}>
                {projects.map((p) => {
                  const id = String(p.id);
                  const active = id === projectId;
                  return (
                    <TouchableOpacity
                      key={id}
                      testID={`start-session-project-${id}`}
                      accessibilityState={{ selected: active }}
                      onPress={() => setProjectId(id)}
                      style={[styles.chip, active && styles.chipActive]}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>
                        {p.name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            <Text style={styles.label}>Agent</Text>
            {loadingAgents ? (
              <ActivityIndicator color={colors.blue400} style={styles.loader} />
            ) : !agents.length ? (
              <Text style={styles.muted}>No agents</Text>
            ) : (
              <View style={styles.chipWrap}>
                {agents.map((a) => {
                  const active = a.id === agentId;
                  return (
                    <TouchableOpacity
                      key={a.id}
                      testID={`start-session-agent-${a.id}`}
                      accessibilityState={{ selected: active }}
                      onPress={() => setAgentId(a.id)}
                      style={[styles.chip, active && styles.chipActive]}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>
                        {a.name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            <Text style={styles.label}>Opening message</Text>
            <TextInput
              style={styles.seedInput}
              value={seed}
              onChangeText={setSeed}
              multiline
              testID="start-session-seed"
              placeholderTextColor={colors.gray600}
            />
          </ScrollView>

          <View style={styles.actions}>
            <TouchableOpacity onPress={onClose} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={submit}
              disabled={!canSubmit}
              style={[styles.primaryButton, !canSubmit && styles.disabledButton]}
              accessibilityLabel="Start session"
              accessibilityState={{ disabled: !canSubmit }}
              testID="start-session-submit"
            >
              <Text style={styles.primaryButtonText}>
                {submitting ? 'Starting…' : 'Start session'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: colors.black60, justifyContent: 'center', padding: 16 },
  card: {
    maxHeight: '85%',
    borderRadius: 8,
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    padding: 16,
  },
  heading: { color: colors.white, fontSize: 18, fontWeight: '700', marginBottom: 8 },
  contextLabel: { color: colors.gray300, fontSize: 14, marginBottom: 4 },
  label: { color: colors.gray400, fontSize: 12, marginBottom: 6, marginTop: 12 },
  muted: { color: colors.gray400, fontSize: 13 },
  loader: { alignSelf: 'flex-start', marginTop: 4 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  chipActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  chipText: { color: colors.gray300, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: colors.white },
  seedInput: {
    backgroundColor: colors.gray800,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.white,
    fontSize: 13,
    minHeight: 140,
    textAlignVertical: 'top',
  },
  errorText: { color: colors.red400, fontSize: 12, marginBottom: 6 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 16 },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.gray700,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
  },
  secondaryButtonText: { color: colors.gray300, fontSize: 13, fontWeight: '600' },
  primaryButton: {
    backgroundColor: colors.blue600,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
  },
  primaryButtonText: { color: colors.white, fontSize: 13, fontWeight: '700' },
  disabledButton: { opacity: 0.5 },
});
