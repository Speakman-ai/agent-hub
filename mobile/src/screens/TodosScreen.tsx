import React, { useState, useEffect, useCallback, useContext, useMemo, useRef } from 'react';
import {
    View,
    Text,
    ScrollView,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    ActivityIndicator,
    RefreshControl,
    Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SidebarContext } from '../context/SidebarContext';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import HubIcon from '../components/HubIcon';
import {
    moveTodoIdWithinPriorityBand,
    isPriorityBandEdge,
    splitTodos,
    sortOpenTodos,
    dueState,
    dueLabel,
    todoDoDate,
    timeWindowLabel,
    todoLinkLabel,
    dateInputToTodoDatePatch,
    isoToDateInput,
    type TodoPriority,
} from '../utils/todos';
import { todoOriginLabel, todoOriginDeepLink } from '@shared/utils/captureTodo';
import PromoteTodoModal from '../components/PromoteTodoModal';

/**
 * Cross-project personal Todos screen (spec NAV-PLACEMENT) — the mobile 1:1
 * peer of the web `TodosPage`. A per-user, global capture list independent of
 * any project board: add, edit, complete, reorder, and set due dates. It has
 * NO Google dependency and renders identically whether or not the user has
 * linked their Google account.
 *
 * Live updates: every server-side write to the user's todos broadcasts a
 * `user_todo_update` WebSocket event. AppContext surfaces the last such event
 * as `lastUserTodoEvent`; we silently refetch when it bumps so a todo created
 * via the promote path (or another device) appears without a manual refresh.
 */

const DUE_BADGE_STYLE: Record<string, { bg: string; text: string; border: string }> = {
    overdue: { bg: colors.red900_50, text: colors.red400, border: colors.red600 },
    today: { bg: colors.amber900_40, text: colors.amber400, border: colors.amber400 },
    tomorrow: { bg: colors.blue900_40, text: colors.blue300, border: colors.blue500 },
    upcoming: { bg: colors.gray800, text: colors.gray400, border: colors.gray700 },
};

// Priority chip colors — reuse the kanban-card / dashboard priority palette so a
// promoted todo keeps the same visual weight (spec TODO-MODEL). Mirrors the web
// `PRIORITY_BADGE_CLASS`.
const PRIORITY_BADGE_STYLE: Record<TodoPriority, { bg: string; text: string; border: string }> = {
    urgent: { bg: colors.red900_50, text: colors.red400, border: colors.red600 },
    high: { bg: colors.amber900_40, text: colors.amber400, border: colors.amber400 },
    medium: { bg: colors.gray800, text: colors.gray400, border: colors.gray700 },
    low: { bg: colors.gray800, text: colors.gray500, border: colors.gray700 },
};

const PRIORITY_OPTIONS: TodoPriority[] = ['urgent', 'high', 'medium', 'low'];

// Link badge color per polymorphic target type (spec TODO-TO-TICKET). Mirrors
// the web `LINK_BADGE_CLASS`.
const LINK_BADGE_STYLE: Record<string, { bg: string; text: string; border: string }> = {
    Ticket: { bg: colors.purple900_40, text: colors.purple400, border: colors.purple500 },
    Epic: { bg: colors.indigo900_40, text: colors.indigo300, border: colors.indigo500 },
    Session: { bg: colors.teal900_30, text: colors.teal300, border: colors.teal500 },
};

/** Compact 4-way priority picker used in the add + edit forms. */
function PrioritySelect({
    value,
    onChange,
    testIDPrefix,
}: {
    value: TodoPriority;
    onChange: (p: TodoPriority) => void;
    testIDPrefix?: string;
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
                        testID={testIDPrefix ? `${testIDPrefix}-${p}` : undefined}
                        accessibilityLabel={`Priority ${p}`}
                        accessibilityState={{ selected: active }}
                        style={[
                            styles.priorityOption,
                            active
                                ? { backgroundColor: style.bg, borderColor: style.border }
                                : { backgroundColor: colors.gray900, borderColor: colors.gray800 },
                        ]}
                    >
                        <Text
                            style={[
                                styles.priorityOptionText,
                                { color: active ? style.text : colors.gray500 },
                            ]}
                        >
                            {p}
                        </Text>
                    </TouchableOpacity>
                );
            })}
        </View>
    );
}

export default function TodosScreen() {
    const sidebar = useContext(SidebarContext);
    const { lastUserTodoEvent } = useApp();
    const [todos, setTodos] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [newTitle, setNewTitle] = useState('');
    const [newDue, setNewDue] = useState('');
    const [newPriority, setNewPriority] = useState<TodoPriority>('medium');
    const [adding, setAdding] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [showDone, setShowDone] = useState(false);
    const [promoteTarget, setPromoteTarget] = useState<any>(null);

    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const load = useCallback(async ({ silent = false, asRefresh = false } = {}) => {
        if (asRefresh) setRefreshing(true);
        else if (!silent) setLoading(true);
        try {
            const { todos: list } = await api.listTodos();
            if (!mountedRef.current) return;
            setTodos(Array.isArray(list) ? list : []);
            setError(null);
        } catch (err: any) {
            if (mountedRef.current && !silent) setError(err?.message || String(err));
        } finally {
            if (mountedRef.current) {
                setLoading(false);
                setRefreshing(false);
            }
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    // Refetch whenever the owner's todos change server-side (create/update/
    // delete/reorder, including the promote-to-ticket path). Skip the initial
    // null so we don't double-fetch on mount.
    useEffect(() => {
        if (!lastUserTodoEvent) return;
        load({ silent: true });
    }, [lastUserTodoEvent, load]);

    // Open todos render most-urgent first (priority sort); position breaks ties
    // so a manual reorder still decides order within a priority band. Done todos
    // keep their incoming order in the collapsed section.
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
                ...dateInputToTodoDatePatch(newDue),
                priority: newPriority,
            });
            if (!mountedRef.current) return;
            setTodos((prev) => [...prev, todo]);
            setNewTitle('');
            setNewDue('');
            setNewPriority('medium');
            setError(null);
        } catch (err: any) {
            if (mountedRef.current) setError(err?.message || String(err));
        } finally {
            if (mountedRef.current) setAdding(false);
        }
    }, [newTitle, newDue, newPriority]);

    const patchTodo = useCallback(async (id: string, patch: any) => {
        try {
            const { todo } = await api.updateTodo(id, patch);
            if (!mountedRef.current) return;
            setTodos((prev) => prev.map((t) => (t.id === id ? todo : t)));
            setError(null);
        } catch (err: any) {
            if (mountedRef.current) setError(err?.message || String(err));
        }
    }, []);

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
        let removed: any;
        setTodos((prev) => {
            removed = prev.find((t) => t.id === id);
            return prev.filter((t) => t.id !== id);
        });
        try {
            await api.deleteTodo(id);
        } catch (err: any) {
            if (mountedRef.current) {
                if (removed) setTodos((prev) => [...prev, removed]);
                setError(err?.message || String(err));
            }
        }
    }, []);

    const reorder = useCallback(
        async (id: string, dir: 'up' | 'down') => {
            // Open todos are always sorted by priority first, so a cross-priority
            // manual move cannot be represented by positions. Only persist moves
            // inside the current priority band, where position is the tie-breaker.
            const nextOpenIds = moveTodoIdWithinPriorityBand(open, id, dir);
            if (!nextOpenIds) return;

            const prev = todos;
            const byId = new Map(todos.map((t) => [t.id, t]));
            // Re-densify positions in the new visual order so the priority-sort
            // tie-break follows the manual move within the band.
            const reorderedOpen = nextOpenIds.map((tid, i) => ({ ...byId.get(tid), position: i }));
            const doneTodos = done;
            setTodos([...reorderedOpen, ...doneTodos]);

            try {
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
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <View style={styles.topBar}>
                <TouchableOpacity onPress={sidebar?.toggleSidebar} style={styles.menuButton}>
                    <Text style={styles.menuIcon}>{'☰'}</Text>
                </TouchableOpacity>
                <HubIcon name="ListTodo" size={20} color={colors.blue400} style={styles.titleIcon} />
                <View style={{ flex: 1 }}>
                    <Text style={styles.title}>Todos</Text>
                    <Text style={styles.subtitle}>Personal, across every project</Text>
                </View>
                <TouchableOpacity
                    onPress={() => load()}
                    disabled={loading}
                    style={styles.refreshButton}
                    accessibilityLabel="Refresh todos"
                >
                    {loading ? (
                        <ActivityIndicator size="small" color={colors.gray300} />
                    ) : (
                        <Text style={styles.refreshText}>Refresh</Text>
                    )}
                </TouchableOpacity>
            </View>

            <ScrollView
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                keyboardShouldPersistTaps="handled"
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={() => load({ asRefresh: true })}
                        tintColor={colors.gray400}
                    />
                }
            >
                {/* Add form */}
                <View style={styles.addForm}>
                    <TextInput
                        style={styles.titleInput}
                        value={newTitle}
                        onChangeText={setNewTitle}
                        placeholder="Add a todo…"
                        placeholderTextColor={colors.gray600}
                        accessibilityLabel="New todo title"
                        testID="todo-new-title"
                        returnKeyType="done"
                        onSubmitEditing={addTodo}
                    />
                    <PrioritySelect
                        value={newPriority}
                        onChange={setNewPriority}
                        testIDPrefix="todo-new-priority"
                    />
                    <View style={styles.addRow}>
                        <TextInput
                            style={styles.dueInput}
                            value={newDue}
                            onChangeText={setNewDue}
                            placeholder="YYYY-MM-DD"
                            placeholderTextColor={colors.gray600}
                            accessibilityLabel="New todo due date"
                            testID="todo-new-due"
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                        <TouchableOpacity
                            style={[styles.addButton, (adding || !newTitle.trim()) && styles.disabled]}
                            onPress={addTodo}
                            disabled={adding || !newTitle.trim()}
                            testID="todo-add"
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

                {loading && todos.length === 0 ? (
                    <Text style={styles.muted}>Loading todos…</Text>
                ) : open.length === 0 && done.length === 0 ? (
                    <View style={styles.emptyBox} testID="todos-empty">
                        <Text style={styles.emptyText}>
                            Nothing to do yet. Add your first todo above.
                        </Text>
                    </View>
                ) : (
                    <>
                        <View style={styles.listCard} testID="todos-open">
                            {open.length === 0 ? (
                                <Text style={styles.allCaughtUp}>All caught up. No open todos.</Text>
                            ) : (
                                open.map((todo) => (
                                    <TodoRow
                                        key={todo.id}
                                        todo={todo}
                                        isFirst={isPriorityBandEdge(open, todo, 'up')}
                                        isLast={isPriorityBandEdge(open, todo, 'down')}
                                        editing={editingId === todo.id}
                                        onStartEdit={() => setEditingId(todo.id)}
                                        onCancelEdit={() => setEditingId(null)}
                                        onToggle={() => patchTodo(todo.id, { status: 'done' })}
                                        onSave={async (patch: any) => {
                                            await patchTodo(todo.id, patch);
                                            if (mountedRef.current) setEditingId(null);
                                        }}
                                        onDelete={() => removeTodo(todo.id)}
                                        onUnlink={() => unlinkTodo(todo.id)}
                                        onPromote={() => setPromoteTarget(todo)}
                                        onMoveUp={() => reorder(todo.id, 'up')}
                                        onMoveDown={() => reorder(todo.id, 'down')}
                                    />
                                ))
                            )}
                        </View>

                        {done.length > 0 ? (
                            <View style={{ marginTop: 20 }}>
                                <TouchableOpacity
                                    style={styles.doneToggle}
                                    onPress={() => setShowDone((v) => !v)}
                                    testID="todos-done-toggle"
                                >
                                    <HubIcon
                                        name={showDone ? 'ChevronDown' : 'ChevronUp'}
                                        size={14}
                                        color={colors.gray400}
                                    />
                                    <Text style={styles.doneToggleText}>Completed ({done.length})</Text>
                                </TouchableOpacity>
                                {showDone ? (
                                    <View style={styles.listCard} testID="todos-done">
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
            </ScrollView>
            {promoteTarget ? (
                <PromoteTodoModal
                    todo={promoteTarget}
                    onClose={() => setPromoteTarget(null)}
                    onPromoted={({ todo }) => {
                        // Reflect the new link locally; the WS refetch reconciles.
                        setTodos((prev) => prev.map((t) => (t.id === todo.id ? todo : t)));
                    }}
                />
            ) : null}
        </SafeAreaView>
    );
}

export function TodoRow({
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
    onMoveUp,
    onMoveDown,
}: any) {
    const doDate = todoDoDate(todo);
    const [title, setTitle] = useState(todo.title);
    const [due, setDue] = useState(isoToDateInput(doDate));
    const [priority, setPriority] = useState<TodoPriority>(todo.priority ?? 'medium');

    // Reset the draft whenever we (re)enter edit mode for this todo.
    useEffect(() => {
        if (editing) {
            setTitle(todo.title);
            setDue(isoToDateInput(doDate));
            setPriority(todo.priority ?? 'medium');
        }
    }, [editing, todo.title, doDate, todo.priority]);

    const done = todo.status === 'done';
    const state = dueState(doDate);
    const badge = dueLabel(doDate);
    const timeWindow = timeWindowLabel(todo.doStartAt, todo.doEndAt);
    const linkLabel = todoLinkLabel(todo);

    if (editing) {
        return (
            <View style={styles.rowEditing} testID="todo-row-editing">
                <TextInput
                    style={styles.editTitleInput}
                    value={title}
                    onChangeText={setTitle}
                    accessibilityLabel="Edit todo title"
                    autoFocus
                />
                <PrioritySelect
                    value={priority}
                    onChange={setPriority}
                    testIDPrefix="todo-edit-priority"
                />
                <View style={styles.editRow}>
                    <TextInput
                        style={styles.editDueInput}
                        value={due}
                        onChangeText={setDue}
                        placeholder="YYYY-MM-DD"
                        placeholderTextColor={colors.gray600}
                        accessibilityLabel="Edit todo do date"
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                    <TouchableOpacity
                        style={[styles.iconButton, !title.trim() && styles.disabled]}
                        disabled={!title.trim()}
                        onPress={() =>
                            onSave({
                                title: title.trim() || todo.title,
                                ...dateInputToTodoDatePatch(due),
                                priority,
                            })
                        }
                        accessibilityLabel="Save todo"
                    >
                        <HubIcon name="Check" size={16} color={colors.emerald400} />
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={styles.iconButton}
                        onPress={onCancelEdit}
                        accessibilityLabel="Cancel edit"
                    >
                        <HubIcon name="X" size={16} color={colors.gray400} />
                    </TouchableOpacity>
                </View>
            </View>
        );
    }

    const badgeStyle = DUE_BADGE_STYLE[state] || DUE_BADGE_STYLE.upcoming;
    const priorityValue: TodoPriority = todo.priority ?? 'medium';
    const priorityStyle = PRIORITY_BADGE_STYLE[priorityValue] || PRIORITY_BADGE_STYLE.medium;
    const linkStyle = LINK_BADGE_STYLE[linkLabel] || LINK_BADGE_STYLE.Ticket;
    const originLabel = todoOriginLabel(todo);
    const originLink = todoOriginDeepLink(todo);

    return (
        <View style={styles.row} testID="todo-row">
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
                <Text
                    style={[styles.rowTitle, done && styles.rowTitleDone]}
                    numberOfLines={2}
                >
                    {todo.title}
                </Text>
                <View style={styles.badgeRow}>
                    {/* Priority chip — always present, mirrors the web pane. */}
                    <View
                        testID="todo-priority"
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
                            testID="todo-due-badge"
                            style={[
                                styles.badge,
                                done
                                    ? { backgroundColor: colors.gray800, borderColor: colors.gray700 }
                                    : { backgroundColor: badgeStyle.bg, borderColor: badgeStyle.border },
                            ]}
                        >
                            <Text
                                style={[
                                    styles.badgeText,
                                    { color: done ? colors.gray500 : badgeStyle.text },
                                ]}
                            >
                                {badge}
                                {timeWindow ? ` · ${timeWindow}` : ''}
                            </Text>
                        </View>
                    ) : null}
                    {linkLabel ? (
                        <View
                            testID="todo-link-badge"
                            style={[
                                styles.badge,
                                styles.linkBadge,
                                {
                                    backgroundColor: linkStyle.bg,
                                    borderColor: linkStyle.border,
                                },
                            ]}
                        >
                            <Text style={[styles.badgeText, { color: linkStyle.text }]}>{linkLabel}</Text>
                            {!done ? (
                                <TouchableOpacity
                                    testID="todo-unlink"
                                    onPress={onUnlink}
                                    accessibilityLabel="Unlink todo"
                                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                                >
                                    <HubIcon name="X" size={11} color={linkStyle.text} />
                                </TouchableOpacity>
                            ) : null}
                        </View>
                    ) : null}
                    {originLabel ? (
                        <TouchableOpacity
                            testID="todo-origin"
                            disabled={!originLink}
                            onPress={() => originLink && Linking.openURL(originLink)}
                            style={[styles.badge, styles.originBadge]}
                            accessibilityLabel={originLabel}
                        >
                            <Text style={[styles.badgeText, { color: colors.blue300 }]}>
                                {originLabel}
                            </Text>
                        </TouchableOpacity>
                    ) : null}
                </View>
            </View>
            {!done ? (
                <View style={styles.rowActions}>
                    {!linkLabel ? (
                        <TouchableOpacity
                            testID="todo-promote"
                            onPress={onPromote}
                            style={styles.iconButton}
                            accessibilityLabel="Promote to ticket"
                        >
                            <HubIcon name="ArrowUpRight" size={15} color={colors.gray500} />
                        </TouchableOpacity>
                    ) : null}
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
                        accessibilityLabel="Edit todo"
                    >
                        <HubIcon name="Pencil" size={14} color={colors.gray500} />
                    </TouchableOpacity>
                </View>
            ) : null}
            <TouchableOpacity
                onPress={onDelete}
                style={styles.iconButton}
                accessibilityLabel="Delete todo"
            >
                <HubIcon name="Trash2" size={15} color={colors.gray500} />
            </TouchableOpacity>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.gray950,
    },
    topBar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors.gray800,
        gap: 8,
    },
    menuButton: {
        padding: 6,
    },
    menuIcon: {
        color: colors.gray300,
        fontSize: 22,
    },
    titleIcon: {
        marginRight: 2,
    },
    title: {
        color: colors.white,
        fontSize: 18,
        fontWeight: '700',
    },
    subtitle: {
        color: colors.gray500,
        fontSize: 11,
    },
    refreshButton: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: colors.gray800,
        minWidth: 64,
        alignItems: 'center',
    },
    refreshText: {
        color: colors.gray300,
        fontSize: 12,
        fontWeight: '500',
    },
    scroll: {
        flex: 1,
    },
    scrollContent: {
        padding: 12,
        paddingBottom: 32,
    },
    addForm: {
        marginBottom: 16,
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
        backgroundColor: colors.blue600,
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
        paddingVertical: 40,
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
    linkBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
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
    originBadge: {
        backgroundColor: colors.blue900_40,
        borderColor: colors.blue500,
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
