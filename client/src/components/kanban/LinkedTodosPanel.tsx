import { useEffect, useState } from 'react';
import { ListTodo } from 'lucide-react';
import { api } from '../../utils/api';
import { dueLabel, dueState } from '../../utils/todos';
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
 * epic (spec TODO-TO-TICKET, "target shows from-todo" half). Reads
 * `GET /api/me/todos/linked`, which the server scopes per-user, so this only
 * ever shows the viewer's own from-todos — never another user's. Renders
 * nothing when there's no valid target (draft card) or no linked todos, so it
 * stays invisible on the common case.
 */

const PRIORITY_BADGE_CLASS: Record<LinkedTodoPriority, string> = {
  urgent: 'bg-red-900/40 text-red-300 border-red-800',
  high: 'bg-amber-900/40 text-amber-300 border-amber-800',
  medium: 'bg-gray-800 text-gray-400 border-gray-700',
  low: 'bg-gray-800/60 text-gray-500 border-gray-700',
};

const DUE_BADGE_CLASS: Record<string, string> = {
  overdue: 'bg-red-900/40 text-red-300 border-red-800',
  today: 'bg-amber-900/40 text-amber-300 border-amber-800',
  tomorrow: 'bg-blue-900/40 text-blue-300 border-blue-800',
  upcoming: 'bg-gray-800 text-gray-400 border-gray-700',
};

type Props = {
  targetType: LinkedTodoTargetType;
  entity: LinkedTodoEntity | null | undefined;
  projectId: string | null | undefined;
};

export default function LinkedTodosPanel({ targetType, entity, projectId }: Props) {
  const target = buildLinkedTodoTarget(targetType, entity, projectId);
  const targetKey = target ? `${target.targetType}:${target.targetId}:${target.projectId}` : null;
  const [todos, setTodos] = useState<LinkedTodoSummary[]>([]);

  useEffect(() => {
    if (!target || typeof api.getLinkedTodos !== 'function') {
      setTodos([]);
      return;
    }
    let cancelled = false;
    const load = () => {
      api
        .getLinkedTodos(target)
        .then((res) => {
          if (!cancelled) setTodos(summarizeLinkedTodos(res.todos || []));
        })
        .catch(() => {
          if (!cancelled) setTodos([]);
        });
    };
    load();
    // A link created / cleared from the Todos pane broadcasts `user_todo_update`;
    // App.tsx bridges it to this window event so the panel stays fresh.
    window.addEventListener('user_todo_update', load);
    return () => {
      cancelled = true;
      window.removeEventListener('user_todo_update', load);
    };
    // targetKey captures the identity of `target`; re-fetch only when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  if (!target || todos.length === 0) return null;

  return (
    <div data-testid="linked-todos-panel">
      <label className="flex items-center gap-1.5 text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
        <ListTodo size={12} />
        From your todos ({todos.length})
      </label>
      <ul className="space-y-1.5">
        {todos.map((todo) => {
          const state = dueState(todo.doDate);
          const badge = dueLabel(todo.doDate);
          return (
            <li
              key={todo.id}
              data-testid="linked-todo-item"
              className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5"
            >
              <span
                className={`inline-block h-3.5 w-3.5 shrink-0 rounded-sm border text-center text-[10px] leading-[13px] ${
                  todo.done
                    ? 'border-emerald-700 bg-emerald-900/40 text-emerald-300'
                    : 'border-gray-600'
                }`}
                aria-hidden
              >
                {todo.done ? '✓' : ''}
              </span>
              <span
                className={`min-w-0 flex-1 truncate text-sm ${
                  todo.done ? 'text-gray-500 line-through' : 'text-gray-200'
                }`}
                title={todo.title}
              >
                {todo.title}
              </span>
              <span
                className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${PRIORITY_BADGE_CLASS[todo.priority]}`}
              >
                {todo.priority}
              </span>
              {badge && (
                <span
                  className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                    DUE_BADGE_CLASS[state] ?? DUE_BADGE_CLASS.upcoming
                  }`}
                >
                  {badge}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
