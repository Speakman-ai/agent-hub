import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import HubIcon from './HubIcon';
import {
  moveTodoIdWithinPriorityBand,
  isPriorityBandEdge,
  splitTodos,
  sortOpenTodos,
  dueState,
  dueLabel,
  todoDoDate,
  timeWindowLabel,
  dateInputToTodoDatePatch,
  isoToDateInput,
  orgTodoEventMatchesOrg,
  type TodoPriority,
} from '../utils/todos';

/**
 * Shared, organization-wide Todos section — the mobile 1:1 peer of the web
 * `OrgTodosSection`. Rendered above the personal list in the Todos screen. Every
 * member of the org sees and edits the SAME list; this is a distinct shared
 * list, not an aggregation of members' personal todos.
 *
 * Live updates: every server-side write to the org's todos broadcasts an
 * `org_todo_update` WS event. AppContext surfaces the last such event as
 * `lastOrgTodoEvent`; we silently refetch when it bumps for our org.
 */

const DUE_BADGE_STYLE: Record<string, { bg: string; text: string; border: string }> = {
  overdue: { bg: colors.red900_50, text: colors.red400, border: colors.red600 },
  today: { bg: colors.amber900_40, text: colors.amber400, border: colors.amber400 },
  tomorrow: { bg: colors.blue900_40, text: colors.blue300, border: colors.blue500 },
  upcoming: { bg: colors.gray800, text: colors.gray400, border: colors.gray700 },
};

const PRIORITY_BADGE_STYLE: Record<TodoPriority, { bg: string; text: string; border: string }> = {
  urgent: { bg: colors.red900_50, text: colors.red400, border: colors.red600 },
  high: { bg: colors.amber900_40, text: colors.amber400, border: colors.amber400 },
  medium: { bg: colors.gray800, text: colors.gray400, border: colors.gray700 },
  low: { bg: colors.gray800, text: colors.gray500, border: colors.gray700 },
};

const PRIORITY_OPTIONS: TodoPriority[] = ['urgent', 'high', 'medium', 'low'];

/**
 * Sentinel key for the reorder write chain. Reorder is a whole-list write (not
 * per-todo), so it serializes under one key. Underscored so it can never collide
 * with a real todo id (server ids are UUIDs).
 */
const REORDER_CHAIN_KEY = '__reorder__';

/** The parent-owned editor draft for the currently-open row editor. */
interface EditorDraft {
  title: string;
  notes: string;
  /** date picker value (YYYY-MM-DD or ''). */
  due: string;
  priority: TodoPriority;
}

function PrioritySelect({
  value,
  onChange,
  disabled = false,
}: {
  value: TodoPriority;
  onChange: (p: TodoPriority) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.prioritySelect}>
      {PRIORITY_OPTIONS.map((p) => {
        const active = p === value;
        const style = PRIORITY_BADGE_STYLE[p];
        return (
          <TouchableOpacity
            key={p}
            onPress={() => onChange(p)}
            disabled={disabled}
            accessibilityLabel={`Priority ${p}`}
            accessibilityState={{ selected: active, disabled }}
            style={[
              styles.priorityOption,
              active
                ? { backgroundColor: style.bg, borderColor: style.border }
                : { backgroundColor: colors.gray900, borderColor: colors.gray800 },
              disabled && { opacity: 0.6 },
            ]}
          >
            <Text
              style={[styles.priorityOptionText, { color: active ? style.text : colors.gray500 }]}
            >
              {p}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export default function OrgTodosSection({ orgId }: { orgId: string }) {
  const { lastOrgTodoEvent } = useApp();
  const [todos, setTodos] = useState<any[]>([]);
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
  const [editSession, setEditSession] = useState(0);
  const editSessionRef = useRef(0);
  editSessionRef.current = editSession;
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const openEditor = useCallback((todo: any) => {
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
  // intermediate order that a further arrow tap would then compute from. We defer
  // applying any refresh until the reorder queue drains and its own reconcile runs.
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
    async ({ silent = false } = {}) => {
      const seq = ++loadSeqRef.current;
      const isCurrent = () => mountedRef.current && seq === loadSeqRef.current;
      // A non-silent load is user-initiated (mount / Refresh) — treat it as a
      // retry/dismissal and clear any prior error up front. A silent load is a
      // background reconcile (WS refresh, post-mutation) and must NOT touch the
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

  // Refetch when this org's shared todos change server-side. Ignore events for
  // a different org so a multi-org user's other lists don't trigger our refetch.
  // `orgTodoEventMatchesOrg` accounts for the `active` alias (remote orgs), whose
  // concrete id the event carries but the component can't compare against.
  useEffect(() => {
    if (!lastOrgTodoEvent) return;
    if (!orgTodoEventMatchesOrg(orgId, lastOrgTodoEvent.orgId)) return;
    load({ silent: true });
  }, [lastOrgTodoEvent, orgId, load]);

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
        ...dateInputToTodoDatePatch(newDue),
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
    async (id: string, patch: any): Promise<boolean> => {
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
      const displayTodos = editingId ? open.filter((t) => t.id !== editingId) : open;
      const nextDisplayIds = moveTodoIdWithinPriorityBand(displayTodos, id, dir);
      if (!nextDisplayIds) return;

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
      const reorderedOpen = nextOpenIds.map((tid, i) => ({ ...byId.get(tid), position: i }));
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
      ...dateInputToTodoDatePatch(draft.due),
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
    <View style={styles.section} testID="org-todos-section">
      <View style={styles.header}>
        <HubIcon name="Users" size={18} color={colors.emerald400} />
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Organization</Text>
          <Text style={styles.headerSubtitle}>Shared with everyone in your org</Text>
        </View>
      </View>

      {/* Add form */}
      <View style={styles.addForm}>
        <TextInput
          style={styles.titleInput}
          value={newTitle}
          onChangeText={setNewTitle}
          placeholder="Add a shared todo…"
          placeholderTextColor={colors.gray600}
          accessibilityLabel="New org todo title"
          testID="org-todo-new-title"
          returnKeyType="done"
          onSubmitEditing={addTodo}
        />
        <TextInput
          style={styles.notesInput}
          value={newNotes}
          onChangeText={setNewNotes}
          placeholder="Add more detail (optional)…"
          placeholderTextColor={colors.gray600}
          accessibilityLabel="New org todo detail"
          multiline
        />
        <PrioritySelect value={newPriority} onChange={setNewPriority} />
        <View style={styles.addRow}>
          <TextInput
            style={styles.dueInput}
            value={newDue}
            onChangeText={setNewDue}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.gray600}
            accessibilityLabel="New org todo due date"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity
            style={[styles.addButton, (adding || !newTitle.trim()) && styles.disabled]}
            onPress={addTodo}
            disabled={adding || !newTitle.trim()}
            testID="org-todo-add"
          >
            <HubIcon name="Plus" size={16} color={colors.white} />
            <Text style={styles.addButtonText}>Add</Text>
          </TouchableOpacity>
        </View>
      </View>

      {error ? (
        <View style={styles.errorBox} accessibilityRole="alert">
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {staleReconcile ? (
        <View style={styles.reconcileBox} testID="org-todos-reconcile-error">
          <Text style={styles.reconcileText}>
            Couldn't refresh the list — it may be out of date.
          </Text>
          <TouchableOpacity
            style={styles.reconcileRetry}
            onPress={() => load({ silent: true })}
            testID="org-todos-reconcile-retry"
            accessibilityLabel="Retry refresh"
          >
            <HubIcon name="RefreshCw" size={13} color={colors.amber400} />
            <Text style={styles.reconcileRetryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Active editor — rendered on its own, keyed by editing session, so it
          survives any re-derivation of the open/done lists (refresh, remote
          status change, reorder). The draft lives in the parent, so it is never
          lost when a row unmounts. */}
      {editingId && draft ? (
        <View style={styles.editorCard} testID="org-todos-editor">
          {editingConflict ? (
            <Text
              accessibilityRole="text"
              testID="org-todo-edit-conflict"
              style={styles.conflictText}
            >
              {editingTodo == null
                ? 'This todo was removed by another member. Your unsaved changes are kept below — cancel to discard.'
                : 'This todo was completed by another member. Your unsaved changes are kept below.'}
            </Text>
          ) : null}
          <TodoEditor
            draft={draft}
            saving={saving}
            onChange={updateDraft}
            onSave={saveEdit}
            onCancel={closeEditor}
          />
        </View>
      ) : null}

      {loading && todos.length === 0 ? (
        <Text style={styles.muted}>Loading shared todos…</Text>
      ) : open.length === 0 && done.length === 0 ? (
        <View style={styles.emptyBox} testID="org-todos-empty">
          <Text style={styles.emptyText}>No shared todos yet. Add one your whole org can see.</Text>
        </View>
      ) : (
        <>
          <View style={styles.listCard} testID="org-todos-open">
            {openDisplay.length === 0 ? (
              <Text style={styles.allCaughtUp}>All caught up. No open shared todos.</Text>
            ) : (
              openDisplay.map((todo) => (
                <OrgTodoRow
                  key={todo.id}
                  todo={todo}
                  isFirst={isPriorityBandEdge(openDisplay, todo, 'up')}
                  isLast={isPriorityBandEdge(openDisplay, todo, 'down')}
                  onStartEdit={() => openEditor(todo)}
                  onToggle={() => patchTodo(todo.id, { status: 'done' })}
                  onDelete={() => removeTodo(todo.id)}
                  onMoveUp={() => reorder(todo.id, 'up')}
                  onMoveDown={() => reorder(todo.id, 'down')}
                />
              ))
            )}
          </View>

          {doneDisplay.length > 0 ? (
            <View style={{ marginTop: 14 }}>
              <TouchableOpacity
                style={styles.doneToggle}
                onPress={() => setShowDone((v) => !v)}
                testID="org-todos-done-toggle"
              >
                <HubIcon
                  name={showDone ? 'ChevronDown' : 'ChevronUp'}
                  size={14}
                  color={colors.gray400}
                />
                <Text style={styles.doneToggleText}>Completed ({doneDisplay.length})</Text>
              </TouchableOpacity>
              {showDone ? (
                <View style={styles.listCard} testID="org-todos-done">
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
                </View>
              ) : null}
            </View>
          ) : null}
        </>
      )}
    </View>
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
    <View style={styles.rowEditing} testID="org-todo-row-editing">
      <TextInput
        style={styles.editTitleInput}
        value={draft.title}
        onChangeText={(t) => onChange({ title: t })}
        editable={!saving}
        accessibilityLabel="Edit org todo title"
        autoFocus
      />
      <TextInput
        style={styles.editNotesInput}
        value={draft.notes}
        onChangeText={(t) => onChange({ notes: t })}
        editable={!saving}
        placeholder="Add more detail (optional)…"
        placeholderTextColor={colors.gray600}
        accessibilityLabel="Edit org todo detail"
        multiline
      />
      <PrioritySelect
        value={draft.priority}
        onChange={(p) => onChange({ priority: p })}
        disabled={saving}
      />
      <View style={styles.editRow}>
        <TextInput
          style={styles.editDueInput}
          value={draft.due}
          onChangeText={(t) => onChange({ due: t })}
          editable={!saving}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.gray600}
          accessibilityLabel="Edit org todo do date"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity
          style={[styles.iconButton, (!draft.title.trim() || saving) && styles.disabled]}
          disabled={!draft.title.trim() || saving}
          onPress={onSave}
          accessibilityLabel="Save org todo"
        >
          <HubIcon name="Check" size={16} color={colors.emerald400} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.iconButton, saving && styles.disabled]}
          disabled={saving}
          onPress={onCancel}
          accessibilityLabel="Cancel edit"
        >
          <HubIcon name="X" size={16} color={colors.gray400} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

/**
 * Display-only row. Editing is handled by the parent-rendered `TodoEditor`, so
 * this component holds NO draft/session/saving state and can be unmounted freely
 * without losing anything.
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
}: any) {
  const doDate = todoDoDate(todo);
  const done = todo.status === 'done';
  const state = dueState(doDate);
  const badge = dueLabel(doDate);
  const timeWindow = timeWindowLabel(todo.doStartAt, todo.doEndAt);

  const badgeStyle = DUE_BADGE_STYLE[state] || DUE_BADGE_STYLE.upcoming;
  const priorityValue: TodoPriority = todo.priority ?? 'medium';
  const priorityStyle = PRIORITY_BADGE_STYLE[priorityValue] || PRIORITY_BADGE_STYLE.medium;

  return (
    <View style={styles.row} testID="org-todo-row">
      <TouchableOpacity
        onPress={onToggle}
        accessibilityLabel={done ? 'Mark as open' : 'Mark as done'}
        accessibilityState={{ selected: done }}
        style={styles.toggleButton}
      >
        <HubIcon
          name={done ? 'CircleCheck' : 'Circle'}
          size={18}
          color={done ? colors.emerald400 : colors.gray500}
        />
      </TouchableOpacity>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.rowTitle, done && styles.rowTitleDone]} numberOfLines={2}>
          {todo.title}
        </Text>
        {todo.notes && todo.notes.trim() ? (
          <Text
            testID="org-todo-notes"
            style={[styles.rowNotes, done && styles.rowNotesDone]}
            numberOfLines={3}
          >
            {todo.notes}
          </Text>
        ) : null}
        <View style={styles.badgeRow}>
          <View
            testID="org-todo-priority"
            style={[
              styles.badge,
              done
                ? { backgroundColor: colors.gray800, borderColor: colors.gray700 }
                : { backgroundColor: priorityStyle.bg, borderColor: priorityStyle.border },
            ]}
          >
            <Text
              style={[
                styles.badgeText,
                styles.capitalize,
                { color: done ? colors.gray500 : priorityStyle.text },
              ]}
            >
              {priorityValue}
            </Text>
          </View>
          {badge ? (
            <View
              testID="org-todo-due-badge"
              style={[
                styles.badge,
                done
                  ? { backgroundColor: colors.gray800, borderColor: colors.gray700 }
                  : { backgroundColor: badgeStyle.bg, borderColor: badgeStyle.border },
              ]}
            >
              <Text style={[styles.badgeText, { color: done ? colors.gray500 : badgeStyle.text }]}>
                {badge}
                {timeWindow ? ` · ${timeWindow}` : ''}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
      {!done ? (
        <View style={styles.rowActions}>
          <TouchableOpacity
            onPress={onMoveUp}
            disabled={isFirst}
            style={[styles.iconButton, isFirst && styles.disabled]}
            accessibilityLabel="Move up"
          >
            <HubIcon name="ChevronUp" size={16} color={colors.gray500} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onMoveDown}
            disabled={isLast}
            style={[styles.iconButton, isLast && styles.disabled]}
            accessibilityLabel="Move down"
          >
            <HubIcon name="ChevronDown" size={16} color={colors.gray500} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onStartEdit}
            style={styles.iconButton}
            accessibilityLabel="Edit org todo"
          >
            <HubIcon name="Pencil" size={14} color={colors.gray500} />
          </TouchableOpacity>
        </View>
      ) : null}
      <TouchableOpacity
        onPress={onDelete}
        style={styles.iconButton}
        accessibilityLabel="Delete org todo"
      >
        <HubIcon name="Trash2" size={15} color={colors.gray500} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginBottom: 22,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  headerTitle: {
    color: colors.white,
    fontSize: 16,
    fontWeight: '700',
  },
  headerSubtitle: {
    color: colors.gray500,
    fontSize: 11,
  },
  addForm: {
    marginBottom: 12,
    gap: 8,
  },
  titleInput: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.white,
    fontSize: 14,
  },
  notesInput: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.gray200,
    fontSize: 14,
    minHeight: 60,
    textAlignVertical: 'top',
  },
  addRow: {
    flexDirection: 'row',
    gap: 8,
  },
  dueInput: {
    flex: 1,
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.gray200,
    fontSize: 14,
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: colors.emerald600,
  },
  addButtonText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '600',
  },
  disabled: {
    opacity: 0.4,
  },
  errorBox: {
    backgroundColor: colors.red900_50,
    borderColor: colors.red600,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  errorText: {
    color: colors.red400,
    fontSize: 13,
  },
  muted: {
    color: colors.gray600,
    fontSize: 13,
    paddingHorizontal: 2,
  },
  emptyBox: {
    backgroundColor: colors.gray900,
    borderColor: colors.gray800,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 32,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  emptyText: {
    color: colors.gray500,
    fontSize: 13,
    textAlign: 'center',
  },
  listCard: {
    backgroundColor: colors.gray900,
    borderColor: colors.gray800,
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
  },
  editorCard: {
    backgroundColor: colors.gray900,
    borderColor: colors.emerald600,
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 14,
  },
  reconcileBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    backgroundColor: colors.amber900_40,
    borderColor: colors.amber400,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  reconcileText: {
    color: colors.amber400,
    fontSize: 13,
    flex: 1,
  },
  reconcileRetry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: colors.gray800,
  },
  reconcileRetryText: {
    color: colors.amber400,
    fontSize: 12,
    fontWeight: '600',
  },
  conflictText: {
    color: colors.amber400,
    fontSize: 12,
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  allCaughtUp: {
    color: colors.gray600,
    fontSize: 12,
    textAlign: 'center',
    paddingVertical: 22,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.gray800,
  },
  toggleButton: {
    padding: 2,
  },
  rowTitle: {
    color: colors.white,
    fontSize: 14,
  },
  rowTitleDone: {
    color: colors.gray500,
    textDecorationLine: 'line-through',
  },
  rowNotes: {
    color: colors.gray400,
    fontSize: 12,
    marginTop: 2,
  },
  rowNotesDone: {
    color: colors.gray600,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 5,
  },
  badge: {
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '600',
  },
  capitalize: {
    textTransform: 'capitalize',
  },
  prioritySelect: {
    flexDirection: 'row',
    gap: 6,
  },
  priorityOption: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 7,
    alignItems: 'center',
  },
  priorityOptionText: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconButton: {
    padding: 6,
  },
  rowEditing: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.gray800,
  },
  editTitleInput: {
    backgroundColor: colors.gray800,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.white,
    fontSize: 14,
  },
  editNotesInput: {
    backgroundColor: colors.gray800,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.gray200,
    fontSize: 14,
    minHeight: 56,
    textAlignVertical: 'top',
  },
  editRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  editDueInput: {
    flex: 1,
    backgroundColor: colors.gray800,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.gray200,
    fontSize: 14,
  },
  doneToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
    paddingHorizontal: 2,
  },
  doneToggleText: {
    color: colors.gray400,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
});
