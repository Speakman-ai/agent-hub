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
  ExternalLink,
  ArrowUpRight,
  Link2,
} from 'lucide-react';
import PromoteTodoModal from './PromoteTodoModal';
import LinkTodoModal from './LinkTodoModal';
import { api, type UserTodoWire, type TodoPriority } from '../utils/api';
import {
  moveTodoId,
  splitTodos,
  sortOpenTodos,
  dueState,
  dueLabel,
  todoDoDate,
  timeWindowLabel,
  todoLinkLabel,
  dateInputToIso,
  isoToDateInput,
} from '../utils/todos';
import { todoOriginLabel, todoOriginDeepLink } from '@shared/utils/captureTodo';

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

// Priority chip colors — reuse the kanban-card / dashboard priority palette so a
// promoted todo keeps the same visual weight (spec TODO-MODEL).
const PRIORITY_BADGE_CLASS: Record<TodoPriority, string> = {
  urgent: 'bg-red-900/40 text-red-300 border-red-800',
  high: 'bg-amber-900/40 text-amber-300 border-amber-800',
  medium: 'bg-gray-800 text-gray-400 border-gray-700',
  low: 'bg-gray-800/60 text-gray-500 border-gray-700',
};

const PRIORITY_OPTIONS: TodoPriority[] = ['urgent', 'high', 'medium', 'low'];

// Link badge color per polymorphic target type (spec TODO-TO-TICKET).
const LINK_BADGE_CLASS: Record<string, string> = {
  Ticket: 'border-violet-800 bg-violet-900/30 text-violet-300',
  Epic: 'border-indigo-800 bg-indigo-900/30 text-indigo-300',
  Session: 'border-teal-800 bg-teal-900/30 text-teal-300',
};

export default function TodosPage() {
  const [todos, setTodos] = useState<UserTodoWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [newDue, setNewDue] = useState('');
  const [newPriority, setNewPriority] = useState<TodoPriority>('medium');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [promoteTarget, setPromoteTarget] = useState<UserTodoWire | null>(null);
  const [linkTarget, setLinkTarget] = useState<UserTodoWire | null>(null);

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

  // Open todos render most-urgent first (priority sort); position breaks ties so
  // a manual reorder still decides order within a priority band. Done todos keep
  // their incoming order in the collapsed section.
  const { open, done } = useMemo(() => {
    const split = splitTodos(todos);
    return { open: sortOpenTodos(split.open), done: split.done };
  }, [todos]);

  const addTodo = useCallback(async () => {
    const title = newTitle.trim();
    if (!title) return;
    setAdding(true);
    try {
      const { todo } = await api.createTodo({
        title,
        notes: newNotes.trim() || undefined,
        doDate: dateInputToIso(newDue),
        priority: newPriority,
      });
      if (!mountedRef.current) return;
      setTodos((prev) => [...prev, todo]);
      setNewTitle('');
      setNewNotes('');
      setNewDue('');
      setNewPriority('medium');
      setError(null);
    } catch (err: any) {
      if (mountedRef.current) setError(err?.message || String(err));
    } finally {
      if (mountedRef.current) setAdding(false);
    }
  }, [newTitle, newNotes, newDue, newPriority]);

  const patchTodo = useCallback(
    async (
      id: string,
      patch: {
        title?: string;
        notes?: string;
        status?: 'open' | 'done';
        doDate?: string | null;
        priority?: TodoPriority;
      },
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

  const unlinkTodo = useCallback(async (id: string) => {
    try {
      const { todo } = await api.unlinkTodo(id);
      if (!mountedRef.current) return;
      setTodos((prev) => prev.map((t) => (t.id === id ? todo : t)));
      setError(null);
    } catch (err: any) {
      if (mountedRef.current) setError(err?.message || String(err));
    }
  }, []);

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
      // Reorder acts within the open list only, over the displayed (priority-
      // sorted) order so up/down matches what the user sees. Persist positions in
      // that order, then reapply optimistically, reverting on failure.
      const openIds = open.map((t) => t.id);
      const nextOpenIds = moveTodoId(openIds, id, dir);
      if (nextOpenIds === openIds) return; // no-op (already at the end)

      const prev = todos;
      const byId = new Map(todos.map((t) => [t.id, t]));
      // Re-densify positions in the new visual order so the priority-sort tie-
      // break follows the manual move within the band.
      const reorderedOpen = nextOpenIds.map((tid, i) => ({ ...byId.get(tid)!, position: i }));
      const doneTodos = done;
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
    [todos, open, done],
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
          className="mb-6 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addTodo();
          }}
        >
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Add a todo…"
              aria-label="New todo title"
              data-testid="todo-new-title"
              className="flex-1 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <select
              value={newPriority}
              onChange={(e) => setNewPriority(e.target.value as TodoPriority)}
              aria-label="New todo priority"
              data-testid="todo-new-priority"
              className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200 capitalize focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {PRIORITY_OPTIONS.map((p) => (
                <option key={p} value={p} className="capitalize">
                  {p}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={newDue}
              onChange={(e) => setNewDue(e.target.value)}
              aria-label="New todo do date"
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
          </div>
          <textarea
            value={newNotes}
            onChange={(e) => setNewNotes(e.target.value)}
            placeholder="Add more detail (optional)…"
            aria-label="New todo detail"
            data-testid="todo-new-notes"
            rows={2}
            className="w-full resize-y bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
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
                    onUnlink={() => unlinkTodo(todo.id)}
                    onPromote={() => setPromoteTarget(todo)}
                    onLink={() => setLinkTarget(todo)}
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
                        onUnlink={() => unlinkTodo(todo.id)}
                        onPromote={() => {}}
                        onLink={() => {}}
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
      {promoteTarget && (
        <PromoteTodoModal
          todo={promoteTarget}
          onClose={() => setPromoteTarget(null)}
          onPromoted={({ todo }) => {
            // Reflect the new link locally right away; the WS refetch reconciles.
            setTodos((prev) => prev.map((t) => (t.id === todo.id ? todo : t)));
          }}
        />
      )}
      {linkTarget && (
        <LinkTodoModal
          todo={linkTarget}
          onClose={() => setLinkTarget(null)}
          onLinked={({ todo }) => {
            // Reflect the new link locally right away; the WS refetch reconciles.
            setTodos((prev) => prev.map((t) => (t.id === todo.id ? todo : t)));
          }}
        />
      )}
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
  onSave: (patch: {
    title: string;
    notes: string;
    doDate: string | null;
    priority: TodoPriority;
  }) => void | Promise<void>;
  onDelete: () => void;
  onUnlink: () => void;
  onPromote: () => void;
  onLink: () => void;
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
  onUnlink,
  onPromote,
  onLink,
  onMoveUp,
  onMoveDown,
}: TodoRowProps) {
  const doDate = todoDoDate(todo);
  const [title, setTitle] = useState(todo.title);
  const [notes, setNotes] = useState(todo.notes ?? '');
  const [due, setDue] = useState(isoToDateInput(doDate));
  const [priority, setPriority] = useState<TodoPriority>(todo.priority ?? 'medium');

  // Reset the draft whenever we (re)enter edit mode for this todo.
  useEffect(() => {
    if (editing) {
      setTitle(todo.title);
      setNotes(todo.notes ?? '');
      setDue(isoToDateInput(doDate));
      setPriority(todo.priority ?? 'medium');
    }
  }, [editing, todo.title, todo.notes, doDate, todo.priority]);

  const done = todo.status === 'done';
  const state = dueState(doDate);
  const badge = dueLabel(doDate);
  const timeWindow = timeWindowLabel(todo.doStartAt, todo.doEndAt);
  const linkLabel = todoLinkLabel(todo);
  const originLabel = todoOriginLabel(todo);
  const originLink = todoOriginDeepLink(todo);

  if (editing) {
    return (
      <div className="px-4 py-3 flex flex-col gap-2" data-testid="todo-row-editing">
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Edit todo title"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as TodoPriority)}
            aria-label="Edit todo priority"
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 capitalize focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {PRIORITY_OPTIONS.map((p) => (
              <option key={p} value={p} className="capitalize">
                {p}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            aria-label="Edit todo do date"
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() =>
                onSave({
                  title: title.trim() || todo.title,
                  notes,
                  doDate: dateInputToIso(due),
                  priority,
                })
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
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Add more detail (optional)…"
          aria-label="Edit todo detail"
          rows={2}
          className="w-full resize-y bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
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
        {todo.notes?.trim() && (
          <div
            data-testid="todo-notes"
            className={`mt-0.5 text-xs whitespace-pre-wrap break-words ${
              done ? 'text-gray-600' : 'text-gray-400'
            }`}
          >
            {todo.notes}
          </div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span
            data-testid="todo-priority"
            className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium capitalize ${
              done
                ? 'bg-gray-800 text-gray-500 border-gray-700'
                : PRIORITY_BADGE_CLASS[todo.priority ?? 'medium']
            }`}
          >
            {todo.priority ?? 'medium'}
          </span>
          {badge && (
            <span
              data-testid="todo-due-badge"
              className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium ${
                done ? 'bg-gray-800 text-gray-500 border-gray-700' : DUE_BADGE_CLASS[state]
              }`}
            >
              {badge}
              {timeWindow ? ` · ${timeWindow}` : ''}
            </span>
          )}
          {linkLabel && (
            <span
              data-testid="todo-link-badge"
              className={`inline-flex items-center gap-1 pl-1.5 pr-1 py-0.5 rounded border text-[10px] font-medium ${
                LINK_BADGE_CLASS[linkLabel] ?? LINK_BADGE_CLASS.Ticket
              }`}
            >
              {linkLabel}
              {!done && (
                <button
                  type="button"
                  onClick={onUnlink}
                  aria-label="Unlink todo"
                  data-testid="todo-unlink"
                  className="inline-flex items-center rounded-sm hover:bg-white/10 -mr-0.5"
                >
                  <X size={10} />
                </button>
              )}
            </span>
          )}
          {originLabel &&
            (originLink ? (
              <a
                href={originLink}
                target="_blank"
                rel="noreferrer"
                data-testid="todo-origin"
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-sky-800 bg-sky-900/30 text-sky-300 text-[10px] font-medium hover:bg-sky-900/50"
              >
                {originLabel}
                <ExternalLink size={9} />
              </a>
            ) : (
              <span
                data-testid="todo-origin"
                className="inline-flex items-center px-1.5 py-0.5 rounded border border-sky-800 bg-sky-900/30 text-sky-300 text-[10px] font-medium"
              >
                {originLabel}
              </span>
            ))}
        </div>
      </div>
      {!done && (
        <div className="flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          {!linkLabel && (
            <>
              <button
                type="button"
                onClick={onLink}
                aria-label="Link to existing"
                data-testid="todo-link"
                title="Link to existing card, epic, or session"
                className="p-1 rounded-md text-gray-500 hover:text-violet-300 hover:bg-gray-800"
              >
                <Link2 size={15} />
              </button>
              <button
                type="button"
                onClick={onPromote}
                aria-label="Promote to ticket"
                data-testid="todo-promote"
                title="Promote to ticket"
                className="p-1 rounded-md text-gray-500 hover:text-violet-300 hover:bg-gray-800"
              >
                <ArrowUpRight size={15} />
              </button>
            </>
          )}
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
