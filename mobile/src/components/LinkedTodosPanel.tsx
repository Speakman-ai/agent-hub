import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { useApp } from '../context/AppContext';
import { dueState, dueLabel } from '../utils/todos';
import {
  buildLinkedTodoTarget,
  summarizeLinkedTodos,
  type LinkedTodoTargetType,
  type LinkedTodoEntity,
  type LinkedTodoSummary,
  type LinkedTodoPriority,
} from '@shared/utils/linkedTodos';

/**
 * Reverse (bidirectional) display of the caller's own todos linked to a card /
 * epic (spec TODO-TO-TICKET, "target shows from-todo" half). The RN 1:1 peer of
 * the web `LinkedTodosPanel`: reads `GET /api/me/todos/linked` (server-scoped
 * per-user) and renders nothing when there's no valid target (a draft card) or
 * no linked todos. Refetches on the `user_todo_update` WS signal that
 * AppContext surfaces as `lastUserTodoEvent`, so a link created from the Todos
 * screen shows up without a manual refresh.
 */

const PRIORITY_BADGE_STYLE: Record<
  LinkedTodoPriority,
  { bg: string; text: string; border: string }
> = {
  urgent: { bg: colors.red900_50, text: colors.red400, border: colors.red600 },
  high: { bg: colors.amber900_40, text: colors.amber400, border: colors.amber400 },
  medium: { bg: colors.gray800, text: colors.gray400, border: colors.gray700 },
  low: { bg: colors.gray800, text: colors.gray500, border: colors.gray700 },
};

const DUE_BADGE_STYLE: Record<string, { bg: string; text: string; border: string }> = {
  overdue: { bg: colors.red900_50, text: colors.red400, border: colors.red600 },
  today: { bg: colors.amber900_40, text: colors.amber400, border: colors.amber400 },
  tomorrow: { bg: colors.blue900_40, text: colors.blue300, border: colors.blue500 },
  upcoming: { bg: colors.gray800, text: colors.gray400, border: colors.gray700 },
};

type Props = {
  targetType: LinkedTodoTargetType;
  entity: LinkedTodoEntity | null | undefined;
  projectId: string | null | undefined;
};

export default function LinkedTodosPanel({ targetType, entity, projectId }: Props) {
  const { lastUserTodoEvent } = useApp();
  const target = buildLinkedTodoTarget(targetType, entity, projectId);
  const targetKey = target ? `${target.targetType}:${target.targetId}:${target.projectId}` : null;
  const [todos, setTodos] = useState<LinkedTodoSummary[]>([]);

  useEffect(() => {
    if (!target || typeof api.getLinkedTodos !== 'function') {
      setTodos([]);
      return;
    }
    let cancelled = false;
    api
      .getLinkedTodos(target)
      .then((res: { todos?: any[] }) => {
        if (!cancelled) setTodos(summarizeLinkedTodos(res.todos || []));
      })
      .catch(() => {
        if (!cancelled) setTodos([]);
      });
    return () => {
      cancelled = true;
    };
    // targetKey captures target identity; lastUserTodoEvent re-runs on a WS bump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, lastUserTodoEvent]);

  if (!target) return null;
  return <LinkedTodosPanelContent todos={todos} />;
}

/**
 * Pure presentational list — no context / network, so the mobile test env
 * (node, no RN testing-library) can serialize it. Renders nothing when the
 * list is empty.
 */
export function LinkedTodosPanelContent({ todos }: { todos: LinkedTodoSummary[] }) {
  if (todos.length === 0) return null;

  return (
    <View testID="linked-todos-panel" style={styles.wrap}>
      <Text style={styles.label}>From your todos ({todos.length})</Text>
      {todos.map((todo) => {
        const state = dueState(todo.doDate);
        const badge = dueLabel(todo.doDate);
        const priorityStyle = PRIORITY_BADGE_STYLE[todo.priority];
        const dueStyle = DUE_BADGE_STYLE[state] ?? DUE_BADGE_STYLE.upcoming;
        return (
          <View key={todo.id} testID="linked-todo-item" style={styles.row}>
            <View style={[styles.check, todo.done && styles.checkDone]}>
              {todo.done ? <Text style={styles.checkMark}>{'✓'}</Text> : null}
            </View>
            <Text style={[styles.title, todo.done && styles.titleDone]} numberOfLines={1}>
              {todo.title}
            </Text>
            <View
              style={[
                styles.chip,
                { backgroundColor: priorityStyle.bg, borderColor: priorityStyle.border },
              ]}
            >
              <Text style={[styles.chipText, { color: priorityStyle.text }]}>{todo.priority}</Text>
            </View>
            {badge ? (
              <View
                style={[
                  styles.chip,
                  { backgroundColor: dueStyle.bg, borderColor: dueStyle.border },
                ]}
              >
                <Text style={[styles.chipText, { color: dueStyle.text }]}>{badge}</Text>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 16 },
  label: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.gray500,
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 6,
  },
  check: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.gray600,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkDone: { borderColor: colors.emerald700, backgroundColor: colors.emerald900_40 },
  checkMark: { color: colors.emerald300, fontSize: 10, lineHeight: 12 },
  title: { flex: 1, fontSize: 14, color: colors.gray200 },
  titleDone: { color: colors.gray500, textDecorationLine: 'line-through' },
  chip: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  chipText: { fontSize: 10, fontWeight: '600' },
});
