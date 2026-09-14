import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Users,
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
import { api, type OrgTodoWire, type TodoPriority } from '../utils/api';
import {
  moveTodoId,
  splitTodos,
  sortOpenTodos,
  dueState,
  dueLabel,
  todoDoDate,
  timeWindowLabel,
  dateInputToIso,
  isoToDateInput,
  orgTodoEventMatchesOrg,
} from '../utils/todos';

/**
 * Shared, organization-wide Todos list. Rendered above the personal list in the
 * Todos pane. Every member of the org sees and edits the SAME list — this is a
 * distinct shared list, not an aggregation of members' personal todos.
 *
 * Live updates: every server-side write to the org's todos broadcasts an
 * `org_todo_update` WebSocket event, which App.tsx bridges to a window
 * CustomEvent. We refetch on that signal (scoped to our org) so a change made
 * by a teammate (or in another tab) shows up without a manual refresh.
 */

const DUE_BADGE_CLASS: Record<string, string> = {
  overdue: 'bg-red-900/40 text-red-300 border-red-800',
  today: 'bg-amber-900/40 text-amber-300 border-amber-800',
  tomorrow: 'bg-blue-900/40 text-blue-300 border-blue-800',
  upcoming: 'bg-gray-800 text-gray-400 border-gray-700',
};

const PRIORITY_BADGE_CLASS: Record<TodoPriority, string> = {
  urgent: 'bg-red-900/40 text-red-300 border-red-800',
  high: 'bg-amber-900/40 text-amber-300 border-amber-800',
  medium: 'bg-gray-800 text-gray-400 border-gray-700',
  low: 'bg-gray-800/60 text-gray-500 border-gray-700',
};

const PRIORITY_OPTIONS: TodoPriority[] = ['urgent', 'high', 'medium', 'low'];

/**
 * Sentinel key for the reorder write chain. Reorder is a whole-list write (not
 * per-todo), so it serializes under one key. underscored so it can never
 * collide with a real todo id (server ids are UUIDs).
 */
const REORDER_CHAIN_KEY = '__reorder__';

/** The parent-owned editor draft for the currently-open row editor. */
interface EditorDraft {
  title: string;
  notes: string;
  /** `<input type="date">` value (YYYY-MM-DD or ''). */
  due: string;
  priority: TodoPriority;
}

export default function OrgTodosSection({ orgId }: { orgId: string }) {
  const [todos, setTodos] = useState<OrgTodoWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Distinct from `error` (mutation failures): set when a background reconcile
  // GET fails. A mutation itself may have succeeded, so we must NOT report it as
  // a mutation error, but the list is now possibly stale — surface a separate,
  // non-destructive banner with a refresh-only retry (never re-runs the
  // mutation, so a create can't be duplicated) and keep any mutation error.
  const [staleReconcile, setStaleReconcile] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [newDue, setNewDue] = useState('');
  const [newPriority, setNewPriority] = useState<TodoPriority>('medium');
  const [adding, setAdding] = useState(false);
  // The editor's transient state — which row, its unsaved draft, the in-flight
  // save lock — lives HERE in the parent, NOT inside the row component. Rows are
  // derived from `todos` and get unmounted whenever the list re-renders (a
  // refresh, a remote status change moving a row between open/done, a reorder, an
  // org switch). Holding the draft in an ephemeral row is exactly what caused the
  // long tail of "the draft/editor was lost/clobbered" bugs. With the draft owned
  // by the parent and the editor rendered independently of the open/done buckets,
  // no list re-derivation can drop it.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Monotonic editing-session token, bumped every time an editor is opened. A row
  // id alone does NOT identify an editing session: opening a different row (or
  // cancelling and reopening the same row) starts a new session, and a save
  // captured by an earlier session must not close the newer one.
  const [editSession, setEditSession] = useState(0);
  const editSessionRef = useRef(0);
  editSessionRef.current = editSession;
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const openEditor = useCallback((todo: OrgTodoWire) => {
    setEditingId(todo.id);
    setEditSession((s) => s + 1);
    setDraft({
      title: todo.title,
      notes: todo.notes ?? '',
      due: isoToDateInput(todoDoDate(todo)),
      priority: todo.priority ?? 'medium',
    });
    setSaving(false);
  }, []);
  const closeEditor = useCallback(() => {
    setEditingId(null);
    setDraft(null);
    setSaving(false);
  }, []);
  const updateDraft = useCallback((patch: Partial<EditorDraft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  }, []);
  const [showDone, setShowDone] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Monotonic request generation. Every broadcast starts its own GET, so
  // responses can complete out of order; without this guard an earlier GET that
  // resolves late would overwrite newer state permanently (no later event is
  // guaranteed to repair it). Each load stamps a generation and only the most
  // recently issued one is allowed to apply — last-issued wins, regardless of
  // completion order.
  const loadSeqRef = useRef(0);

  // Per-todo write serialization. The editing-session guards prevent stale UI
  // completions, but two writes to the SAME todo (e.g. save S1, reopen, save S2)
  // could otherwise be in flight at once — and if S2 reaches the server before
  // S1, the older S1 overwrites the newer saved value at the data layer. Chain
  // each todo's writes so a mutation only issues after the previous write to
  // that id has settled: server application order then matches submission order.
  // Count of reorder writes that are queued or in flight. A reorder is optimistic
  // and whole-list, so while any is pending the local order is authoritative: a
  // reconcile GET may reflect only some of the queued reorders (or none yet) and
  // must NOT overwrite the newer optimistic order — otherwise it exposes an
  // intermediate order that a further arrow click would then compute from. We
  // defer applying any refresh until the reorder queue drains and its own
  // reconcile runs.
  const pendingReordersRef = useRef(0);
  const writeChainsRef = useRef<Map<string, Promise<void>>>(new Map());
  const enqueueWrite = useCallback(<T,>(id: string, op: () => Promise<T>): Promise<T> => {
    const chains = writeChainsRef.current;
    const prev = chains.get(id) ?? Promise.resolve();
    // Run `op` only after the prior write settles (whether it resolved or
    // rejected), so a failed write still can't let the next one overtake it.
    const result = prev.then(op, op);
    const tail = result.then(
      () => {},
      () => {},
    );
    chains.set(id, tail);
    void tail.finally(() => {
      if (chains.get(id) === tail) chains.delete(id);
    });
    return result;
  }, []);

  const load = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      const seq = ++loadSeqRef.current;
      const isCurrent = () => mountedRef.current && seq === loadSeqRef.current;
      // A non-silent load is user-initiated (mount / Refresh button) — treat it
      // as a retry/dismissal and clear any prior error up front. A silent load is
      // a background reconcile (WS refresh, post-mutation) and must NOT touch the
      // error: it would erase a mutation failure whose row it just restored.
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const { todos: list } = await api.listOrgTodos(orgId);
        if (!isCurrent()) return; // a newer load superseded this response
        // Don't clobber an optimistic order while reorder writes are still
        // pending — the drain reconcile (issued when the queue empties) applies
        // the authoritative order. See pendingReordersRef.
        if (pendingReordersRef.current > 0) return;
        setTodos(Array.isArray(list) ? list : []);
        setStaleReconcile(false); // a fresh list clears any prior stale-refresh state
      } catch (err: any) {
        if (!isCurrent()) return;
        // While reorders are still pending, defer reporting too — the drain
        // reconcile will surface any real failure.
        if (pendingReordersRef.current > 0) return;
        // A user-initiated load (mount / Refresh) reports through `error`; a
        // silent background reconcile surfaces the separate stale banner so a
        // mutation's own error (if any) is retained and the create/update is
        // never re-run.
        if (silent) setStaleReconcile(true);
        else setError(err?.message || String(err));
      } finally {
        if (isCurrent()) setLoading(false);
      }
    },
    [orgId],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Refetch whenever this org's shared todos change server-side. App.tsx bridges
  // the `org_todo_update` WS event to this window event; ignore events for a
  // different org so a multi-org user's other lists don't trigger our refetch.
  // `orgTodoEventMatchesOrg` accounts for the `active` alias (remote orgs), whose
  // concrete id the event carries but the component can't compare against.
  useEffect(() => {
    const onUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail as { orgId?: string } | undefined;
      if (!orgTodoEventMatchesOrg(orgId, detail?.orgId)) return;
      load({ silent: true });
    };
    window.addEventListener('org_todo_update', onUpdate);
    return () => window.removeEventListener('org_todo_update', onUpdate);
  }, [load, orgId]);

  const { open, done } = useMemo(() => {
    const split = splitTodos(todos);
    return { open: sortOpenTodos(split.open), done: split.done };
  }, [todos]);

  const addTodo = useCallback(async () => {
    const title = newTitle.trim();
    if (!title) return;
    // Snapshot the submitted values so the post-create clear can be scoped to
    // exactly what was sent — see the field-by-field guard below.
    const sent = { title: newTitle, notes: newNotes, due: newDue, priority: newPriority };
    setAdding(true);
    setError(null); // new user action: clear any prior (mutation) error
    try {
      await api.createOrgTodo(orgId, {
        title,
        notes: newNotes.trim() || undefined,
        doDate: dateInputToIso(newDue),
        priority: newPriority,
      });
      if (!mountedRef.current) return;
      // Clear only the fields the user has NOT changed since submitting: a slow
      // create must not wipe a new entry they started typing while it was in
      // flight (same stale-completion class as the editor close).
      setNewTitle((cur) => (cur === sent.title ? '' : cur));
      setNewNotes((cur) => (cur === sent.notes ? '' : cur));
      setNewDue((cur) => (cur === sent.due ? '' : cur));
      setNewPriority((cur) => (cur === sent.priority ? 'medium' : cur));
      // Don't splice the create response in: an authoritative, generation-guarded
      // refresh is the single writer of `todos` (see `load`). This dedups against
      // the create's own broadcast refetch and can't install a stale snapshot.
      await load({ silent: true });
    } catch (err: any) {
      if (mountedRef.current) setError(err?.message || String(err));
    } finally {
      if (mountedRef.current) setAdding(false);
    }
  }, [orgId, newTitle, newNotes, newDue, newPriority, load]);

  // Returns whether the update succeeded so callers can sequence UI on the
  // outcome — a failed save must NOT close the editor, or the user's in-progress
  // draft (title/notes/date) is silently discarded.
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
    ): Promise<boolean> => {
      setError(null); // new user action: clear any prior (mutation) error
      try {
        // Serialize per todo so a reopened editor's save can't race — and lose
        // to — the previous save still in flight for the same todo.
        await enqueueWrite(id, () => api.updateOrgTodo(orgId, id, patch));
        if (!mountedRef.current) return false;
        // Reconcile through the generation-guarded refresh rather than splicing
        // this PUT's response in: a newer teammate GET that already landed must
        // not be overwritten by this (now older) mutation snapshot.
        await load({ silent: true });
        return true;
      } catch (err: any) {
        if (mountedRef.current) setError(err?.message || String(err));
        return false;
      }
    },
    [orgId, load, enqueueWrite],
  );

  const removeTodo = useCallback(
    async (id: string) => {
      setError(null); // new user action: clear any prior (mutation) error
      // Optimistic removal for instant feedback; the authoritative refresh in
      // `finally` reconciles — it confirms the delete on success and restores the
      // row on failure. The reconcile is silent, so a delete failure's error
      // message survives the row being restored (the user sees why it came back).
      setTodos((prev) => prev.filter((t) => t.id !== id));
      try {
        // Serialize with any pending write to the same todo (see enqueueWrite).
        await enqueueWrite(id, () => api.deleteOrgTodo(orgId, id));
      } catch (err: any) {
        if (mountedRef.current) setError(err?.message || String(err));
      } finally {
        if (mountedRef.current) await load({ silent: true });
      }
    },
    [orgId, load, enqueueWrite],
  );

  const reorder = useCallback(
    async (id: string, dir: 'up' | 'down') => {
      // Move relative to the VISIBLE rows (the pinned editor's row is excluded
      // from the list), then map the result back into the full open order with
      // the edited row kept at its slot. Reordering over `open` directly would
      // move a row against the hidden edited todo — a visible no-op — because the
      // arrows are computed over the displayed rows, not the full list.
      const displayIds = open.filter((t) => t.id !== editingId).map((t) => t.id);
      const nextDisplayIds = moveTodoId(displayIds, id, dir);
      if (nextDisplayIds === displayIds) return;

      const editIdx = editingId ? open.findIndex((t) => t.id === editingId) : -1;
      const nextOpenIds: string[] = [];
      let di = 0;
      for (let i = 0; i < open.length; i++) {
        if (i === editIdx)
          nextOpenIds.push(open[i].id); // keep the edited row put
        else nextOpenIds.push(nextDisplayIds[di++]);
      }

      setError(null); // new user action: clear any prior (mutation) error
      // Optimistic reorder; the authoritative refresh in `finally` reconciles to
      // server truth (and reverts on failure). The reconcile is silent, so a
      // reorder failure's error survives the order being reverted.
      const byId = new Map(todos.map((t) => [t.id, t]));
      const reorderedOpen = nextOpenIds.map((tid, i) => ({ ...byId.get(tid)!, position: i }));
      const doneTodos = done;
      setTodos([...reorderedOpen, ...doneTodos]);

      // Mark a reorder pending so an intervening reconcile can't overwrite this
      // (or a later) optimistic order before the whole queue drains.
      pendingReordersRef.current += 1;
      try {
        // Serialize reorders through a dedicated chain so a rapid second click
        // can't submit its whole-list order before the first request lands (an
        // older order reaching the server last would overwrite the newer one).
        await enqueueWrite(REORDER_CHAIN_KEY, () =>
          api.reorderOrgTodos(orgId, [...nextOpenIds, ...doneTodos.map((t) => t.id)]),
        );
      } catch (err: any) {
        if (mountedRef.current) setError(err?.message || String(err));
      } finally {
        // Drop this reorder from the pending count BEFORE reconciling — the last
        // reorder to finish (count back to 0) issues the reconcile that installs
        // the authoritative order; earlier reconciles are skipped by the guard.
        pendingReordersRef.current -= 1;
        if (mountedRef.current) await load({ silent: true });
      }
    },
    [orgId, todos, open, done, editingId, load, enqueueWrite],
  );

  // Persist the open editor's draft. Locks the editor while in flight, and only
  // closes / re-enables if this is still the live editing session when the save
  // completes (a reopen bumps editSession).
  const saveEdit = useCallback(async () => {
    if (!editingId || !draft) return;
    const id = editingId;
    const mySession = editSessionRef.current;
    const title = draft.title.trim();
    if (!title) return; // Save is disabled in this state; guard anyway.
    setSaving(true);
    const ok = await patchTodo(id, {
      title,
      notes: draft.notes,
      doDate: dateInputToIso(draft.due),
      priority: draft.priority,
    });
    if (!mountedRef.current || editSessionRef.current !== mySession) return;
    if (ok) closeEditor();
    else setSaving(false);
  }, [editingId, draft, patchTodo, closeEditor]);

  // The todo currently being edited, resolved fresh from `todos` each render. It
  // may have been completed or removed by another member while the editor is
  // open — the draft (held above) survives regardless, and we surface the
  // conflict. Editing is only ever started from an open row, so a now-done or
  // missing target means a remote change landed mid-edit.
  const editingTodo = editingId ? (todos.find((t) => t.id === editingId) ?? null) : null;
  const editingConflict =
    editingId != null && (editingTodo == null || editingTodo.status === 'done');
  // The active editor is rendered on its own (pinned), so exclude its row from
  // the open/done lists to avoid rendering the same todo twice.
  const openDisplay = useMemo(() => open.filter((t) => t.id !== editingId), [open, editingId]);
  const doneDisplay = useMemo(() => done.filter((t) => t.id !== editingId), [done, editingId]);

  return (
    <div className="mb-8" data-testid="org-todos-section">
      <div className="flex items-center gap-3 mb-3">
        <Users size={20} className="text-emerald-400" />
        <div>
          <h2 className="text-lg font-semibold text-white">Organization</h2>
          <p className="text-xs text-gray-500">Shared with everyone in your org</p>
        </div>
      </div>

      {/* Add form */}
      <form
        className="mb-4 flex flex-col gap-2"
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
            placeholder="Add a shared todo…"
            aria-label="New org todo title"
            data-testid="org-todo-new-title"
            className="flex-1 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
          <select
            value={newPriority}
            onChange={(e) => setNewPriority(e.target.value as TodoPriority)}
            aria-label="New org todo priority"
            className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200 capitalize focus:outline-none focus:ring-1 focus:ring-emerald-500"
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
            aria-label="New org todo do date"
            className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
          <button
            type="submit"
            disabled={adding || !newTitle.trim()}
            data-testid="org-todo-add"
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium disabled:opacity-50"
          >
            <Plus size={16} />
            Add
          </button>
        </div>
        <textarea
          value={newNotes}
          onChange={(e) => setNewNotes(e.target.value)}
          placeholder="Add more detail (optional)…"
          aria-label="New org todo detail"
          rows={2}
          className="w-full resize-y bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-emerald-500"
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

      {staleReconcile && (
        <div
          role="status"
          data-testid="org-todos-reconcile-error"
          className="mb-4 px-4 py-3 rounded-lg bg-amber-900/20 border border-amber-800 text-amber-200 text-sm flex items-center justify-between gap-3"
        >
          <span>{'Couldn’t refresh the list — it may be out of date.'}</span>
          <button
            type="button"
            onClick={() => load({ silent: true })}
            data-testid="org-todos-reconcile-retry"
            className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-800/40 hover:bg-amber-800/60 text-amber-100 text-xs font-medium"
          >
            <RefreshCw size={13} />
            Retry
          </button>
        </div>
      )}

      {/* Active editor — rendered on its own, keyed by editing session, so it
          survives any re-derivation of the open/done lists (refresh, remote
          status change, reorder). The draft lives in the parent, so it is never
          lost when a row unmounts. */}
      {editingId && draft && (
        <div
          className="mb-4 bg-gray-900 border border-emerald-800 rounded-xl"
          data-testid="org-todos-editor"
        >
          {editingConflict && (
            <div
              role="status"
              data-testid="org-todo-edit-conflict"
              className="px-4 pt-3 text-xs text-amber-300"
            >
              {editingTodo == null
                ? 'This todo was removed by another member. Your unsaved changes are kept below — cancel to discard.'
                : 'This todo was completed by another member. Your unsaved changes are kept below.'}
            </div>
          )}
          <TodoEditor
            draft={draft}
            saving={saving}
            onChange={updateDraft}
            onSave={saveEdit}
            onCancel={closeEditor}
          />
        </div>
      )}

      {loading && todos.length === 0 ? (
        <div className="text-gray-500 text-sm px-1">Loading shared todos…</div>
      ) : open.length === 0 && done.length === 0 ? (
        <div
          data-testid="org-todos-empty"
          className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-8 text-center text-sm text-gray-500"
        >
          No shared todos yet. Add one your whole org can see.
        </div>
      ) : (
        <>
          <div
            data-testid="org-todos-open"
            className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800"
          >
            {openDisplay.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-gray-600">
                All caught up. No open shared todos.
              </div>
            ) : (
              openDisplay.map((todo, index) => (
                <OrgTodoRow
                  key={todo.id}
                  todo={todo}
                  isFirst={index === 0}
                  isLast={index === openDisplay.length - 1}
                  onStartEdit={() => openEditor(todo)}
                  onToggle={() => patchTodo(todo.id, { status: 'done' })}
                  onDelete={() => removeTodo(todo.id)}
                  onMoveUp={() => reorder(todo.id, 'up')}
                  onMoveDown={() => reorder(todo.id, 'down')}
                />
              ))
            )}
          </div>

          {doneDisplay.length > 0 && (
            <div className="mt-4">
              <button
                type="button"
                onClick={() => setShowDone((v) => !v)}
                data-testid="org-todos-done-toggle"
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider hover:text-gray-200 mb-2"
              >
                {showDone ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                Completed ({doneDisplay.length})
              </button>
              {showDone && (
                <div
                  data-testid="org-todos-done"
                  className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800"
                >
                  {doneDisplay.map((todo) => (
                    <OrgTodoRow
                      key={todo.id}
                      todo={todo}
                      isFirst
                      isLast
                      onStartEdit={() => openEditor(todo)}
                      onToggle={() => patchTodo(todo.id, { status: 'open' })}
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
  );
}

/** Controlled editor for the active row's draft. All state lives in the parent. */
function TodoEditor({
  draft,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  draft: EditorDraft;
  saving: boolean;
  onChange: (patch: Partial<EditorDraft>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="px-4 py-3 flex flex-col gap-2" data-testid="org-todo-row-editing">
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={draft.title}
          onChange={(e) => onChange({ title: e.target.value })}
          disabled={saving}
          aria-label="Edit org todo title"
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-60"
        />
        <select
          value={draft.priority}
          onChange={(e) => onChange({ priority: e.target.value as TodoPriority })}
          disabled={saving}
          aria-label="Edit org todo priority"
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 capitalize focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-60"
        >
          {PRIORITY_OPTIONS.map((p) => (
            <option key={p} value={p} className="capitalize">
              {p}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={draft.due}
          onChange={(e) => onChange({ due: e.target.value })}
          disabled={saving}
          aria-label="Edit org todo do date"
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-60"
        />
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onSave}
            disabled={!draft.title.trim() || saving}
            aria-label="Save org todo"
            className="p-1.5 rounded-md text-emerald-400 hover:bg-gray-800 disabled:opacity-40"
          >
            <Check size={16} />
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            aria-label="Cancel edit"
            className="p-1.5 rounded-md text-gray-400 hover:bg-gray-800 disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>
      </div>
      <textarea
        value={draft.notes}
        onChange={(e) => onChange({ notes: e.target.value })}
        disabled={saving}
        placeholder="Add more detail (optional)…"
        aria-label="Edit org todo detail"
        rows={2}
        className="w-full resize-y bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-60"
      />
    </div>
  );
}

interface OrgTodoRowProps {
  todo: OrgTodoWire;
  isFirst: boolean;
  isLast: boolean;
  /** Opens the parent-owned editor for this row (the row holds no editor state). */
  onStartEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

/**
 * Display-only row. It renders the todo and its actions; editing is handled by
 * the parent-rendered `TodoEditor`, so this component holds NO draft/session/
 * saving state and can be unmounted freely without losing anything.
 */
function OrgTodoRow({
  todo,
  isFirst,
  isLast,
  onStartEdit,
  onToggle,
  onDelete,
  onMoveUp,
  onMoveDown,
}: OrgTodoRowProps) {
  const doDate = todoDoDate(todo);
  const done = todo.status === 'done';
  const state = dueState(doDate);
  const badge = dueLabel(doDate);
  const timeWindow = timeWindowLabel(todo.doStartAt, todo.doEndAt);

  return (
    <div className="px-4 py-3 flex items-center gap-3 group" data-testid="org-todo-row">
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
            data-testid="org-todo-notes"
            className={`mt-0.5 text-xs whitespace-pre-wrap break-words ${
              done ? 'text-gray-600' : 'text-gray-400'
            }`}
          >
            {todo.notes}
          </div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span
            data-testid="org-todo-priority"
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
              data-testid="org-todo-due-badge"
              className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium ${
                done ? 'bg-gray-800 text-gray-500 border-gray-700' : DUE_BADGE_CLASS[state]
              }`}
            >
              {badge}
              {timeWindow ? ` · ${timeWindow}` : ''}
            </span>
          )}
        </div>
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
            aria-label="Edit org todo"
            className="p-1 rounded-md text-gray-500 hover:text-gray-200 hover:bg-gray-800"
          >
            <Pencil size={14} />
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete org todo"
        className="p-1 rounded-md text-gray-500 hover:text-red-400 hover:bg-gray-800 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}
