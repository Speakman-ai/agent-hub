import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  ListTodo,
  Plus,
  Circle,
  CheckCircle2,
  Trash2,
  ChevronUp,
  ChevronDown,
  Pencil,
  X,
  Check,
  RefreshCw,
} from 'lucide-react';
import { api, type UserTodoWire } from '../utils/api';
import {
  moveTodoId,
  splitTodos,
  dueState,
  dueLabel,
  dateInputToIso,
  isoToDateInput,
} from '../utils/todos';

/**
 * Cross-project personal Todos pane (spec NAV-PLACEMENT). A per-user, global
 * capture list independent of any project board — add, edit, complete, reorder,
 * and set due dates. It has NO Google dependency and renders identically whether
 * or not the user has linked their Google account (the Google-gated panes are
 * Calendar/Gmail, not this one).
 *
 * Live updates: every server-side write to the user's todos broadcasts a
 * `user_todo_update` WebSocket event, which App.tsx bridges to a window
 * CustomEvent. We refetch on that signal so a todo created via the promote path
 * (or another tab) shows up without a manual refresh.
 */

const DUE_BADGE_CLASS: Record<string, string> = {
  overdue: 'bg-red-900/40 text-red-300 border-red-800',
  today: 'bg-amber-900/40 text-amber-300 border-amber-800',
  tomorrow: 'bg-blue-900/40 text-blue-300 border-blue-800',
  upcoming: 'bg-gray-800 text-gray-400 border-gray-700',
};

export default function TodosPage() {
  const [todos, setTodos] = useState<UserTodoWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newDue, setNewDue] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setLoading(true);
    try {
      const { todos: list } = await api.listTodos();
      if (!mountedRef.current) return;
      setTodos(Array.isArray(list) ? list : []);
      setError(null);
    } catch (err: any) {
      if (mountedRef.current && !silent) setError(err?.message || String(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Refetch whenever the owner's todos change server-side (create/update/delete/
  // reorder, including the promote-to-ticket path). App.tsx bridges the
  // `user_todo_update` WS event to this window event.
  useEffect(() => {
    const onUpdate = () => load({ silent: true });
    window.addEventListener('user_todo_update', onUpdate);
    return () => window.removeEventListener('user_todo_update', onUpdate);
  }, [load]);

  const { open, done } = useMemo(() => splitTodos(todos), [todos]);

  const addTodo = useCallback(async () => {
    const title = newTitle.trim();
    if (!title) return;
    setAdding(true);
    try {
      const { todo } = await api.createTodo({ title, dueAt: dateInputToIso(newDue) });
      if (!mountedRef.current) return;
      setTodos((prev) => [...prev, todo]);
      setNewTitle('');
      setNewDue('');
      setError(null);
    } catch (err: any) {
      if (mountedRef.current) setError(err?.message || String(err));
    } finally {
      if (mountedRef.current) setAdding(false);
    }
  }, [newTitle, newDue]);

  const patchTodo = useCallback(
    async (
      id: string,
      patch: { title?: string; status?: 'open' | 'done'; dueAt?: string | null },
    ) => {
      try {
        const { todo } = await api.updateTodo(id, patch);
        if (!mountedRef.current) return;
        setTodos((prev) => prev.map((t) => (t.id === id ? todo : t)));
        setError(null);
      } catch (err: any) {
        if (mountedRef.current) setError(err?.message || String(err));
      }
    },
    [],
  );

  const removeTodo = useCallback(async (id: string) => {
    // Optimistic: drop it immediately, restore on failure.
    let removed: UserTodoWire | undefined;
    setTodos((prev) => {
      removed = prev.find((t) => t.id === id);
      return prev.filter((t) => t.id !== id);
    });
    try {
      await api.deleteTodo(id);
    } catch (err: any) {
      if (mountedRef.current) {
        if (removed) setTodos((prev) => [...prev, removed as UserTodoWire]);
        setError(err?.message || String(err));
      }
    }
  }, []);

  const reorder = useCallback(
    async (id: string, dir: 'up' | 'down') => {
      // Reorder acts within the open list only. Compute the new full order and
      // apply it optimistically, reverting on failure.
      const openIds = todos.filter((t) => t.status === 'open').map((t) => t.id);
      const nextOpenIds = moveTodoId(openIds, id, dir);
      if (nextOpenIds === openIds) return; // no-op (already at the end)

      const prev = todos;
      const byId = new Map(todos.map((t) => [t.id, t]));
      const reorderedOpen = nextOpenIds.map((tid) => byId.get(tid)!);
      const doneTodos = todos.filter((t) => t.status === 'done');
      setTodos([...reorderedOpen, ...doneTodos]);

      try {
        // Persist the full order (open first, then done) so positions stay dense.
        await api.reorderTodos([...nextOpenIds, ...doneTodos.map((t) => t.id)]);
      } catch (err: any) {
        if (mountedRef.current) {
          setTodos(prev);
          setError(err?.message || String(err));
        }
      }
    },
    [todos],
  );

  return (
    <div className="flex-1 overflow-y-auto bg-gray-950">
      <div className="max-w-3xl mx-auto p-4 md:p-8" data-testid="todos-page">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <ListTodo size={28} className="text-blue-400" />
            <div>
              <h1 className="text-2xl font-semibold text-white">Todos</h1>
              <p className="text-sm text-gray-500">Personal, across every project</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => load()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-50"
            aria-label="Refresh todos"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

        {/* Add form */}
        <form
          className="mb-6 flex flex-col sm:flex-row gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addTodo();
          }}
        >
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Add a todo…"
            aria-label="New todo title"
            data-testid="todo-new-title"
            className="flex-1 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <input
            type="date"
            value={newDue}
            onChange={(e) => setNewDue(e.target.value)}
            aria-label="New todo due date"
            data-testid="todo-new-due"
            className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button
            type="submit"
            disabled={adding || !newTitle.trim()}
            data-testid="todo-add"
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium disabled:opacity-50"
          >
            <Plus size={16} />
            Add
          </button>
        </form>

        {error && (
          <div
            role="alert"
            className="mb-4 px-4 py-3 rounded-lg bg-red-900/30 border border-red-800 text-red-300 text-sm"
          >
            {error}
          </div>
        )}

        {loading && todos.length === 0 ? (
          <div className="text-gray-500 text-sm px-1">Loading todos…</div>
        ) : open.length === 0 && done.length === 0 ? (
          <div
            data-testid="todos-empty"
            className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-10 text-center text-sm text-gray-500"
          >
            Nothing to do yet. Add your first todo above.
          </div>
        ) : (
          <>
            <div
              data-testid="todos-open"
              className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800"
            >
              {open.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-gray-600">
                  All caught up. No open todos.
                </div>
              ) : (
                open.map((todo, index) => (
                  <TodoRow
                    key={todo.id}
                    todo={todo}
                    isFirst={index === 0}
                    isLast={index === open.length - 1}
                    editing={editingId === todo.id}
                    onStartEdit={() => setEditingId(todo.id)}
                    onCancelEdit={() => setEditingId(null)}
                    onToggle={() => patchTodo(todo.id, { status: 'done' })}
                    onSave={async (patch) => {
                      await patchTodo(todo.id, patch);
                      if (mountedRef.current) setEditingId(null);
                    }}
                    onDelete={() => removeTodo(todo.id)}
                    onMoveUp={() => reorder(todo.id, 'up')}
                    onMoveDown={() => reorder(todo.id, 'down')}
                  />
                ))
              )}
            </div>

            {done.length > 0 && (
              <div className="mt-6">
                <button
                  type="button"
                  onClick={() => setShowDone((v) => !v)}
                  data-testid="todos-done-toggle"
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider hover:text-gray-200 mb-2"
                >
                  {showDone ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                  Completed ({done.length})
                </button>
                {showDone && (
                  <div
                    data-testid="todos-done"
                    className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800"
                  >
                    {done.map((todo) => (
                      <TodoRow
                        key={todo.id}
                        todo={todo}
                        isFirst
                        isLast
                        editing={false}
                        onStartEdit={() => {}}
                        onCancelEdit={() => {}}
                        onToggle={() => patchTodo(todo.id, { status: 'open' })}
                        onSave={async () => {}}
                        onDelete={() => removeTodo(todo.id)}
                        onMoveUp={() => {}}
                        onMoveDown={() => {}}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface TodoRowProps {
  todo: UserTodoWire;
  isFirst: boolean;
  isLast: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onToggle: () => void;
  onSave: (patch: { title: string; dueAt: string | null }) => void | Promise<void>;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

function TodoRow({
  todo,
  isFirst,
  isLast,
  editing,
  onStartEdit,
  onCancelEdit,
  onToggle,
  onSave,
  onDelete,
  onMoveUp,
  onMoveDown,
}: TodoRowProps) {
  const [title, setTitle] = useState(todo.title);
  const [due, setDue] = useState(isoToDateInput(todo.dueAt));

  // Reset the draft whenever we (re)enter edit mode for this todo.
  useEffect(() => {
    if (editing) {
      setTitle(todo.title);
      setDue(isoToDateInput(todo.dueAt));
    }
  }, [editing, todo.title, todo.dueAt]);

  const done = todo.status === 'done';
  const state = dueState(todo.dueAt);
  const badge = dueLabel(todo.dueAt);

  if (editing) {
    return (
      <div className="px-4 py-3 flex flex-col sm:flex-row gap-2" data-testid="todo-row-editing">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Edit todo title"
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <input
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          aria-label="Edit todo due date"
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() =>
              onSave({ title: title.trim() || todo.title, dueAt: dateInputToIso(due) })
            }
            disabled={!title.trim()}
            aria-label="Save todo"
            className="p-1.5 rounded-md text-emerald-400 hover:bg-gray-800 disabled:opacity-40"
          >
            <Check size={16} />
          </button>
          <button
            type="button"
            onClick={onCancelEdit}
            aria-label="Cancel edit"
            className="p-1.5 rounded-md text-gray-400 hover:bg-gray-800"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 flex items-center gap-3 group" data-testid="todo-row">
      <button
        type="button"
        onClick={onToggle}
        aria-label={done ? 'Mark as open' : 'Mark as done'}
        aria-pressed={done}
        className={done ? 'text-emerald-400' : 'text-gray-500 hover:text-gray-300'}
      >
        {done ? <CheckCircle2 size={18} /> : <Circle size={18} />}
      </button>
      <div className="flex-1 min-w-0">
        <div
          className={`text-sm truncate ${done ? 'text-gray-500 line-through' : 'text-white'}`}
          title={todo.title}
        >
          {todo.title}
        </div>
        {(badge || todo.linkedCardId) && (
          <div className="mt-1 flex items-center gap-2">
            {badge && (
              <span
                data-testid="todo-due-badge"
                className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium ${
                  done ? 'bg-gray-800 text-gray-500 border-gray-700' : DUE_BADGE_CLASS[state]
                }`}
              >
                {badge}
              </span>
            )}
            {todo.linkedCardId && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded border border-violet-800 bg-violet-900/30 text-violet-300 text-[10px] font-medium">
                Ticket
              </span>
            )}
          </div>
        )}
      </div>
      {!done && (
        <div className="flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={isFirst}
            aria-label="Move up"
            className="p-1 rounded-md text-gray-500 hover:text-gray-200 hover:bg-gray-800 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronUp size={15} />
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={isLast}
            aria-label="Move down"
            className="p-1 rounded-md text-gray-500 hover:text-gray-200 hover:bg-gray-800 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronDown size={15} />
          </button>
          <button
            type="button"
            onClick={onStartEdit}
            aria-label="Edit todo"
            className="p-1 rounded-md text-gray-500 hover:text-gray-200 hover:bg-gray-800"
          >
            <Pencil size={14} />
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete todo"
        className="p-1 rounded-md text-gray-500 hover:text-red-400 hover:bg-gray-800 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}
