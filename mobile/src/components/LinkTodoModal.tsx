import React, { useEffect, useMemo, useState } from 'react';
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
import {
  LINK_TARGET_TYPES,
  LINK_TARGET_LABELS,
  DEFAULT_LINK_TARGET_TYPE,
  agentsForProject,
  buildLinkPayload,
  canSubmitLink,
  filterLinkOptions,
  normalizeLinkOptions,
  type LinkOption,
  type LinkTargetType,
} from '@shared/utils/linkTodo';

/**
 * Mobile link-to-existing picker (spec TODO-TO-TICKET LINK op) — 1:1 peer of the
 * web `LinkTodoModal`. Associates a personal todo with an ALREADY-EXISTING card,
 * epic, or session (nothing is created — that is the promote op). A card / epic
 * target is project-scoped; a session is browsed project → agent → session.
 *
 * The container owns fetching + state; `LinkTodoModalContent` is a pure,
 * props-driven view so every state (loading / error / selection) is unit-testable
 * via static render. Option normalization, the write payload, and the submit gate
 * come from the shared `linkTodo` helpers so web + mobile agree.
 */

export interface LinkTodoModalContentProps {
  todoTitle: string;
  targetType: LinkTargetType;
  onSelectType: (t: LinkTargetType) => void;
  projects: any[];
  projectId: string;
  onSelectProject: (id: string) => void;
  agents: LinkOption[];
  agentId: string;
  onSelectAgent: (id: string) => void;
  options: LinkOption[];
  targetId: string;
  onSelectTarget: (id: string) => void;
  filter: string;
  onChangeFilter: (v: string) => void;
  loadingProjects: boolean;
  loadingList: boolean;
  submitting: boolean;
  done: boolean;
  error: string | null;
  canSubmit: boolean;
  onSubmit: () => void;
  onClose: () => void;
}

export function LinkTodoModalContent({
  todoTitle,
  targetType,
  onSelectType,
  projects,
  projectId,
  onSelectProject,
  agents,
  agentId,
  onSelectAgent,
  options,
  targetId,
  onSelectTarget,
  filter,
  onChangeFilter,
  loadingProjects,
  loadingList,
  submitting,
  done,
  error,
  canSubmit,
  onSubmit,
  onClose,
}: LinkTodoModalContentProps) {
  const listEmptyLabel =
    targetType === 'session'
      ? agentId
        ? 'No sessions for this agent'
        : 'Pick an agent first'
      : `No ${targetType === 'card' ? 'cards' : 'epics'} on this board`;

  return (
    <View style={styles.backdrop}>
      <View style={styles.card}>
        <Text style={styles.heading}>Link to existing</Text>
        <ScrollView keyboardShouldPersistTaps="handled">
          {error ? (
            <Text style={styles.errorText} testID="link-error">
              {error}
            </Text>
          ) : null}

          <Text style={styles.todoTitle} numberOfLines={2}>
            {todoTitle}
          </Text>

          <Text style={styles.label}>Link to</Text>
          <View style={styles.chipWrap}>
            {LINK_TARGET_TYPES.map((t) => {
              const active = t === targetType;
              return (
                <TouchableOpacity
                  key={t}
                  testID={`link-type-${t}`}
                  accessibilityState={{ selected: active }}
                  onPress={() => onSelectType(t)}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {LINK_TARGET_LABELS[t]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={styles.label}>Project</Text>
          {loadingProjects ? (
            <ActivityIndicator
              color={colors.blue400}
              style={styles.loader}
              testID="link-loading-projects"
            />
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
                    testID={`link-project-${id}`}
                    accessibilityState={{ selected: active }}
                    onPress={() => onSelectProject(id)}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{p.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {targetType === 'session' ? (
            <>
              <Text style={styles.label}>Agent</Text>
              {!agents.length ? (
                <Text style={styles.muted}>No agents</Text>
              ) : (
                <View style={styles.chipWrap}>
                  {agents.map((a) => {
                    const active = a.id === agentId;
                    return (
                      <TouchableOpacity
                        key={a.id}
                        testID={`link-agent-${a.id}`}
                        accessibilityState={{ selected: active }}
                        onPress={() => onSelectAgent(a.id)}
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
            </>
          ) : null}

          <Text style={styles.label}>{LINK_TARGET_LABELS[targetType]}</Text>
          <TextInput
            style={styles.filterInput}
            value={filter}
            onChangeText={onChangeFilter}
            placeholder="Filter…"
            placeholderTextColor={colors.gray600}
            accessibilityLabel="Filter targets"
            testID="link-filter"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={styles.optionList} testID="link-options">
            {loadingList ? (
              <ActivityIndicator
                color={colors.blue400}
                style={styles.loader}
                testID="link-loading-list"
              />
            ) : !options.length ? (
              <Text style={styles.muted}>{listEmptyLabel}</Text>
            ) : (
              options.map((o) => {
                const active = o.id === targetId;
                return (
                  <TouchableOpacity
                    key={o.id}
                    testID={`link-option-${o.id}`}
                    accessibilityState={{ selected: active }}
                    onPress={() => onSelectTarget(o.id)}
                    style={[styles.option, active && styles.optionActive]}
                  >
                    <Text
                      style={[styles.optionText, active && styles.optionTextActive]}
                      numberOfLines={1}
                    >
                      {o.name}
                    </Text>
                  </TouchableOpacity>
                );
              })
            )}
          </View>
        </ScrollView>

        <View style={styles.actions}>
          <TouchableOpacity onPress={onClose} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onSubmit}
            disabled={!canSubmit}
            style={[styles.primaryButton, !canSubmit && styles.disabledButton]}
            accessibilityLabel="Link to existing"
            accessibilityState={{ disabled: !canSubmit }}
            testID="link-submit"
          >
            <Text style={styles.primaryButtonText}>
              {submitting ? 'Linking…' : done ? '✓ Linked' : 'Link'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

export default function LinkTodoModal({
  todo,
  onClose,
  onLinked,
}: {
  todo: any;
  onClose: () => void;
  onLinked?: (result: { todo: any }) => void;
}) {
  const [targetType, setTargetType] = useState<LinkTargetType>(DEFAULT_LINK_TARGET_TYPE);
  const [projects, setProjects] = useState<any[]>([]);
  const [projectId, setProjectId] = useState<string>('');
  const [cards, setCards] = useState<LinkOption[]>([]);
  const [epics, setEpics] = useState<LinkOption[]>([]);
  const [agents, setAgents] = useState<LinkOption[]>([]);
  const [agentId, setAgentId] = useState<string>('');
  const [sessions, setSessions] = useState<LinkOption[]>([]);
  const [targetId, setTargetId] = useState<string>('');
  const [filter, setFilter] = useState('');
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingList, setLoadingList] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
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

  // Reset the target and (re)load the option source when project / type changes.
  useEffect(() => {
    setTargetId('');
    setFilter('');
    setError(null);
    if (!projectId) return;
    let cancelled = false;
    setLoadingList(true);
    if (targetType === 'session') {
      setAgents([]);
      setSessions([]);
      setAgentId('');
      api
        .getAgents()
        .then((list: any) => {
          if (cancelled) return;
          setAgents(agentsForProject(list, projectId));
        })
        .catch((err: any) => {
          if (!cancelled) setError(err?.message || 'Failed to load agents');
        })
        .finally(() => {
          if (!cancelled) setLoadingList(false);
        });
    } else {
      setCards([]);
      setEpics([]);
      api
        .getProjectBoard(projectId, { limit: 'all' })
        .then((board: any) => {
          if (cancelled) return;
          setCards(normalizeLinkOptions(board?.cards, ['title', 'name']));
          setEpics(normalizeLinkOptions(board?.epics, ['name', 'title']));
        })
        .catch((err: any) => {
          if (!cancelled) setError(err?.message || 'Failed to load board');
        })
        .finally(() => {
          if (!cancelled) setLoadingList(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [projectId, targetType]);

  useEffect(() => {
    if (targetType !== 'session' || !agentId) {
      setSessions([]);
      return;
    }
    let cancelled = false;
    setLoadingList(true);
    setSessions([]);
    setTargetId('');
    api
      .getSessions(agentId)
      .then((list: any) => {
        if (cancelled) return;
        setSessions(normalizeLinkOptions(list, ['name']));
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || 'Failed to load sessions');
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, targetType]);

  const options = useMemo<LinkOption[]>(() => {
    const source = targetType === 'card' ? cards : targetType === 'epic' ? epics : sessions;
    return filterLinkOptions(source, filter);
  }, [targetType, cards, epics, sessions, filter]);

  const canSubmit = canSubmitLink({
    targetType,
    targetId,
    projectId,
    submitting,
    loading: loadingList,
  });

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result: any = await api.linkTodo(
        todo.id,
        buildLinkPayload({ targetType, targetId, projectId }),
      );
      setDone(true);
      onLinked?.(result);
      setTimeout(() => onClose(), 700);
    } catch (err: any) {
      setError(err?.message || 'Failed to link todo');
      setSubmitting(false);
    }
  };

  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <LinkTodoModalContent
        todoTitle={todo.title}
        targetType={targetType}
        onSelectType={setTargetType}
        projects={projects}
        projectId={projectId}
        onSelectProject={setProjectId}
        agents={agents}
        agentId={agentId}
        onSelectAgent={setAgentId}
        options={options}
        targetId={targetId}
        onSelectTarget={setTargetId}
        filter={filter}
        onChangeFilter={setFilter}
        loadingProjects={loadingProjects}
        loadingList={loadingList}
        submitting={submitting}
        done={done}
        error={error}
        canSubmit={canSubmit}
        onSubmit={submit}
        onClose={onClose}
      />
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
  todoTitle: { color: colors.gray300, fontSize: 14, marginBottom: 4 },
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
  filterInput: {
    backgroundColor: colors.gray800,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    color: colors.white,
    fontSize: 13,
    marginBottom: 8,
  },
  optionList: {
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    backgroundColor: colors.gray950,
    padding: 4,
  },
  option: {
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 6,
  },
  optionActive: { backgroundColor: colors.blue600 },
  optionText: { color: colors.gray300, fontSize: 13 },
  optionTextActive: { color: colors.white, fontWeight: '600' },
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
