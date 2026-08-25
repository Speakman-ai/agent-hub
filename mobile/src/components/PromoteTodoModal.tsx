import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import {
  PROMOTE_PRIORITY_OPTIONS,
  buildPromotePayload,
  canSubmitPromote,
  defaultPromoteOptionId,
  defaultPromotePriority,
  normalizePromoteOptions,
  type PromoteOption,
  type PromotePriority,
} from '@shared/utils/promoteTodo';

/**
 * Mobile promote-to-ticket picker (spec TODO-TO-TICKET PROMOTE op) — 1:1 peer of
 * the web `PromoteTodoModal`. Turns a personal todo into a real kanban card on a
 * chosen project board, keeping the todo and card as distinct entities joined by
 * a link. Collects the destination (project + column + optional epic) and the
 * card priority (defaulting to the todo's own priority so a promote maps 1:1).
 *
 * The container owns fetching + state; `PromoteTodoModalContent` is a pure,
 * props-driven view so its every state (loading / error / chip selection) is
 * unit-testable via static render, and the selection defaults + write payload
 * come from the shared `promoteTodo` helpers.
 */

export interface PromoteTodoModalContentProps {
  todoTitle: string;
  projects: any[];
  projectId: string;
  onSelectProject: (id: string) => void;
  columns: PromoteOption[];
  columnId: string;
  onSelectColumn: (id: string) => void;
  epics: PromoteOption[];
  epicId: string;
  onSelectEpic: (id: string) => void;
  priority: PromotePriority;
  onSelectPriority: (p: PromotePriority) => void;
  loadingProjects: boolean;
  loadingBoard: boolean;
  submitting: boolean;
  done: boolean;
  error: string | null;
  canSubmit: boolean;
  onSubmit: () => void;
  onClose: () => void;
}

export function PromoteTodoModalContent({
  todoTitle,
  projects,
  projectId,
  onSelectProject,
  columns,
  columnId,
  onSelectColumn,
  epics,
  epicId,
  onSelectEpic,
  priority,
  onSelectPriority,
  loadingProjects,
  loadingBoard,
  submitting,
  done,
  error,
  canSubmit,
  onSubmit,
  onClose,
}: PromoteTodoModalContentProps) {
  return (
    <View style={styles.backdrop}>
      <View style={styles.card}>
        <Text style={styles.heading}>Promote to ticket</Text>
        <ScrollView>
          {error ? (
            <Text style={styles.errorText} testID="promote-error">
              {error}
            </Text>
          ) : null}

          <Text style={styles.todoTitle} numberOfLines={2}>
            {todoTitle}
          </Text>

          <Text style={styles.label}>Project</Text>
          {loadingProjects ? (
            <ActivityIndicator
              color={colors.blue400}
              style={styles.loader}
              testID="promote-loading-projects"
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
                    testID={`promote-project-${id}`}
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

          <Text style={styles.label}>Column</Text>
          {loadingBoard ? (
            <ActivityIndicator
              color={colors.blue400}
              style={styles.loader}
              testID="promote-loading-board"
            />
          ) : !columns.length ? (
            <Text style={styles.muted}>No columns</Text>
          ) : (
            <View style={styles.chipWrap}>
              {columns.map((c) => {
                const active = c.id === columnId;
                return (
                  <TouchableOpacity
                    key={c.id}
                    testID={`promote-column-${c.id}`}
                    accessibilityState={{ selected: active }}
                    onPress={() => onSelectColumn(c.id)}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{c.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          <Text style={styles.label}>Priority</Text>
          <View style={styles.chipWrap}>
            {PROMOTE_PRIORITY_OPTIONS.map((p) => {
              const active = p === priority;
              return (
                <TouchableOpacity
                  key={p}
                  testID={`promote-priority-${p}`}
                  accessibilityState={{ selected: active }}
                  onPress={() => onSelectPriority(p)}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text
                    style={[styles.chipText, styles.capitalize, active && styles.chipTextActive]}
                  >
                    {p}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {epics.length > 0 ? (
            <>
              <Text style={styles.label}>Epic</Text>
              <View style={styles.chipWrap}>
                <TouchableOpacity
                  testID="promote-epic-none"
                  accessibilityState={{ selected: !epicId }}
                  onPress={() => onSelectEpic('')}
                  style={[styles.chip, !epicId && styles.chipActive]}
                >
                  <Text style={[styles.chipText, !epicId && styles.chipTextActive]}>None</Text>
                </TouchableOpacity>
                {epics.map((e) => {
                  const active = e.id === epicId;
                  return (
                    <TouchableOpacity
                      key={e.id}
                      testID={`promote-epic-${e.id}`}
                      accessibilityState={{ selected: active }}
                      onPress={() => onSelectEpic(e.id)}
                      style={[styles.chip, active && styles.chipActive]}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>
                        {e.name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </>
          ) : null}
        </ScrollView>

        <View style={styles.actions}>
          <TouchableOpacity onPress={onClose} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onSubmit}
            disabled={!canSubmit}
            style={[styles.primaryButton, !canSubmit && styles.disabledButton]}
            accessibilityLabel="Promote to ticket"
            accessibilityState={{ disabled: !canSubmit }}
            testID="promote-submit"
          >
            <Text style={styles.primaryButtonText}>
              {submitting ? 'Promoting…' : done ? '✓ Promoted' : 'Promote'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

export default function PromoteTodoModal({
  todo,
  onClose,
  onPromoted,
}: {
  todo: any;
  onClose: () => void;
  onPromoted?: (result: { todo: any; card: unknown }) => void;
}) {
  const [projects, setProjects] = useState<any[]>([]);
  const [projectId, setProjectId] = useState<string>('');
  const [columns, setColumns] = useState<PromoteOption[]>([]);
  const [columnId, setColumnId] = useState<string>('');
  const [epics, setEpics] = useState<PromoteOption[]>([]);
  const [epicId, setEpicId] = useState<string>('');
  const [priority, setPriority] = useState<PromotePriority>(defaultPromotePriority(todo));
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingBoard, setLoadingBoard] = useState(false);
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

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setError(null);
    setLoadingBoard(true);
    setColumns([]);
    setColumnId('');
    setEpics([]);
    setEpicId('');
    api
      .getProjectBoard(projectId)
      .then((board: any) => {
        if (cancelled) return;
        const cols = normalizePromoteOptions(board?.columns);
        setColumns(cols);
        setColumnId(defaultPromoteOptionId(cols));
        setEpics(normalizePromoteOptions(board?.epics));
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || 'Failed to load board');
      })
      .finally(() => {
        if (!cancelled) setLoadingBoard(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const canSubmit = canSubmitPromote({ projectId, columnId, submitting, loadingBoard });

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result: any = await api.promoteTodo(
        todo.id,
        buildPromotePayload({ projectId, columnId, priority, epicId }),
      );
      setDone(true);
      onPromoted?.(result);
      setTimeout(() => onClose(), 700);
    } catch (err: any) {
      setError(err?.message || 'Failed to promote todo');
      setSubmitting(false);
    }
  };

  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <PromoteTodoModalContent
        todoTitle={todo.title}
        projects={projects}
        projectId={projectId}
        onSelectProject={setProjectId}
        columns={columns}
        columnId={columnId}
        onSelectColumn={setColumnId}
        epics={epics}
        epicId={epicId}
        onSelectEpic={setEpicId}
        priority={priority}
        onSelectPriority={setPriority}
        loadingProjects={loadingProjects}
        loadingBoard={loadingBoard}
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
  capitalize: { textTransform: 'capitalize' },
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
