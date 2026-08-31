import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../utils/api';
import { useApp } from '../context/AppContext';
import { colors } from '../theme/colors';
import {
  EPIC_COLORS,
  DEFAULT_EPIC_FORM,
  epicFormFromRow,
  epicFormToUpdateBody,
  epicFormToCreateBody,
  countOpenCardsForEpic,
  EPIC_STATE_LABELS,
  epicStateLabel,
  epicBranchTogglePatch,
} from '../utils/epics';
import {
  applyEpicListFilters,
  collectDistinctEpicLabels,
  createDefaultEpicListFilters,
  type EpicListFilters,
} from '../utils/epicListFilters';
import { groupEpicsByState } from '../utils/epicBoard';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
import LinkedTodosPanel from '../components/LinkedTodosPanel';
import EpicPullsSection from '../components/EpicPullsSection';
import { epicAutosaveLabel, useEpicAutosave } from '../hooks/useEpicAutosave';
export default function EpicsScreen({ route, navigation }: any) {
  const { projectId, project: routeProject, editEpicId } = route.params || {};
  const project = routeProject;
  const [board, setBoard] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [editingEpic, setEditingEpic] = useState<any>(null);
  const [epicForm, setEpicForm] = useState(DEFAULT_EPIC_FORM);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [scopingId, setScopingId] = useState<any>(null);
  const [listFilters, setListFilters] = useState<EpicListFilters>(() =>
    createDefaultEpicListFilters(),
  );
  const [viewMode, setViewMode] = useState<'list' | 'board'>('list');
  const { setActiveAgentId, setActiveSessionId } = useApp();
  const handleEpicAutosaved = useCallback((updated: any) => {
    setBoard((current: any) =>
      current
        ? {
            ...current,
            epics: (current.epics || []).map((row: any) =>
              row.id === updated?.id ? { ...row, ...updated } : row,
            ),
          }
        : current,
    );
    setEditingEpic((current: any) =>
      current?.id === updated?.id ? { ...current, ...updated } : current,
    );
  }, []);
  const epicAutosave = useEpicAutosave({
    projectId,
    epic: editingEpic,
    form: epicForm,
    onSaved: handleEpicAutosaved,
  });
  const changeEpicForm = useCallback(
    (patch: any, immediate = false) => {
      const next = { ...epicForm, ...patch };
      setEpicForm(next);
      epicAutosave.schedule(next, immediate);
    },
    [epicAutosave, epicForm],
  );
  const openScopingSession = useCallback(
    async (epicId: any) => {
      if (!epicId || scopingId) return false;
      setScopingId(epicId);
      try {
        const result = await api.scopeEpic(projectId, epicId);
        if (result?.sessionId && result?.agentId && navigation) {
          setActiveAgentId(result.agentId);
          setActiveSessionId(result.sessionId);
          navigation.navigate('Chat');
          return true;
        }
        return false;
      } catch {
        Alert.alert('Error', 'Failed to open scoping session');
        return false;
      } finally {
        setScopingId(null);
      }
    },
    [projectId, scopingId, navigation, setActiveAgentId, setActiveSessionId],
  );
  const loadBoard = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getProjectBoard(projectId, { limit: 'all' });
      setBoard(data);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to load epics');
      setBoard(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);
  useEffect(() => {
    loadBoard();
  }, [loadBoard]);
  const epics = useMemo(() => board?.epics || [], [board]);
  const cards = useMemo(() => board?.cards || [], [board]);
  const assignableUsers = board?.assignableUsers || [];
  const doneColumnIds = new Set(
    (board?.columns || []).filter((c: any) => /done/i.test(c.name || '')).map((c: any) => c.id),
  );
  const availableEpicLabels = useMemo(() => collectDistinctEpicLabels(epics), [epics]);
  const filteredEpics = useMemo(
    () => applyEpicListFilters(epics, listFilters, cards),
    [epics, listFilters, cards],
  );
  // The board view groups epics by lifecycle state across its own sections, so
  // the state chip is redundant there — force `state: 'all'` so every section
  // has something to show regardless of the list view's default filter.
  const boardEpics = useMemo(
    () => applyEpicListFilters(epics, { ...listFilters, state: 'all' }, cards),
    [epics, listFilters, cards],
  );
  const toggleEpicListLabel = (label: string) => {
    setListFilters((prev) => {
      const next = new Set(prev.selectedLabels);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return { ...prev, selectedLabels: next };
    });
  };
  const toggleEpicListUser = (userId: string) => {
    setListFilters((prev) => {
      const next = new Set(prev.selectedUserIds);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return { ...prev, selectedUserIds: next };
    });
  };
  const openCreate = () => {
    setEditingEpic(null);
    setEpicForm(DEFAULT_EPIC_FORM);
    setShowForm(true);
  };
  const openEdit = (epic: any) => {
    setEditingEpic(epic);
    setEpicForm(epicFormFromRow(epic));
    setShowForm(true);
  };
  const closeForm = () => {
    if (editingEpic) epicAutosave.flush();
    setShowForm(false);
  };
  // The EpicDetail screen's "Edit" button routes back here with `editEpicId`;
  // open that epic's form once the board has loaded it, then consume the
  // route param. Clearing the param (rather than a sticky ref) means tapping
  // Edit again for the same epic re-opens the form even while this screen
  // instance stays mounted.
  useEffect(() => {
    if (!editEpicId) return;
    const target = (board?.epics || []).find((e: any) => e.id === editEpicId);
    if (target) {
      openEdit(target);
      navigation?.setParams?.({ editEpicId: undefined });
    }
  }, [editEpicId, board, navigation]);
  const handleSave = async () => {
    if (!epicForm.name.trim()) {
      Alert.alert('Error', 'Epic name is required');
      return;
    }
    setSaving(true);
    try {
      if (editingEpic) {
        await api.updateEpic(projectId, editingEpic.id, epicFormToUpdateBody(epicForm));
      } else {
        await api.createEpic(projectId, epicFormToCreateBody(epicForm));
      }
      setShowForm(false);
      setEditingEpic(null);
      setEpicForm(DEFAULT_EPIC_FORM);
      await loadBoard();
    } catch {
      Alert.alert('Error', 'Failed to save epic');
    } finally {
      setSaving(false);
    }
  };
  const handleCreateAndScope = async () => {
    if (!epicForm.name.trim()) {
      Alert.alert('Error', 'Epic name is required');
      return;
    }
    setSaving(true);
    try {
      const created = await api.createEpic(projectId, epicFormToCreateBody(epicForm));
      setShowForm(false);
      setEditingEpic(null);
      setEpicForm(DEFAULT_EPIC_FORM);
      await loadBoard();
      if (created?.id) await openScopingSession(created.id);
    } catch {
      Alert.alert('Error', 'Failed to create epic');
    } finally {
      setSaving(false);
    }
  };
  const handleDelete = () => {
    if (!editingEpic) return;
    Alert.alert('Delete epic', `Delete "${editingEpic.name}"? Linked cards will be unlinked.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteEpic(projectId, editingEpic.id);
            setShowForm(false);
            setEditingEpic(null);
            await loadBoard();
          } catch {
            Alert.alert('Error', 'Failed to delete epic');
          }
        },
      },
    ]);
  };
  const cardCountFor = (epicId: any) => {
    const open = countOpenCardsForEpic(cards, epicId, doneColumnIds);
    const total = cards.filter((c: any) => c.epic_id === epicId).length;
    return { open, total };
  };
  const renderEpicCard = (epic: any) => {
    const { open, total } = cardCountFor(epic.id);
    const stateLabel = epicStateLabel(epic.state);
    return (
      <TouchableOpacity
        key={epic.id}
        style={styles.epicCard}
        onPress={() => navigation.navigate('EpicDetail', { projectId, project, epicId: epic.id })}
      >
        <View style={[styles.epicDot, { backgroundColor: epic.color || colors.indigo500 }]} />
        <View style={styles.epicInfo}>
          <Text style={styles.epicName}>{epic.name}</Text>
          {epic.description ? (
            <Text style={styles.epicDesc} numberOfLines={2}>
              {epic.description}
            </Text>
          ) : null}
          <Text style={styles.epicCount}>
            {open} open · {total} total card{total === 1 ? '' : 's'}
          </Text>
          {viewMode === 'list' && stateLabel ? (
            <Text style={styles.epicState}>{stateLabel}</Text>
          ) : null}
        </View>
        <View style={styles.epicActions}>
          <TouchableOpacity
            style={styles.boardLink}
            onPress={() => openScopingSession(epic.id)}
            disabled={!!scopingId}
          >
            <Text style={styles.scopeLinkText}>{scopingId === epic.id ? '…' : 'Scope'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.boardLink}
            onPress={() => navigation.navigate('Kanban', { projectId, project, epicId: epic.id })}
          >
            <Text style={styles.boardLinkText}>Board</Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    );
  };
  const boardColumns = groupEpicsByState(boardEpics);
  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ProjectScreenHeader title="Epics" project={project} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.headerRow}>
          <Text style={styles.desc}>Group kanban cards into epics for this project.</Text>
          <TouchableOpacity onPress={() => (showForm ? closeForm() : openCreate())}>
            <Text style={styles.link}>
              {showForm ? (editingEpic ? 'Close' : 'Cancel') : '+ New'}
            </Text>
          </TouchableOpacity>
        </View>

        {showForm && (
          <View style={styles.formCard}>
            <View style={styles.switchRow}>
              <Text style={styles.label}>Keep on feature branch</Text>
              <Switch
                value={!!epicForm.pr_base_branch?.trim()}
                onValueChange={(v: any) => changeEpicForm(epicBranchTogglePatch(epicForm, v), true)}
                trackColor={{ false: colors.gray700, true: colors.blue600 }}
                thumbColor={epicForm.pr_base_branch?.trim() ? colors.blue400 : colors.gray500}
              />
            </View>
            {!!epicForm.pr_base_branch?.trim() && (
              <>
                <Text style={styles.label}>Feature branch</Text>
                <TextInput
                  style={styles.input}
                  value={epicForm.pr_base_branch}
                  onChangeText={(v: any) => changeEpicForm({ pr_base_branch: v })}
                  onBlur={epicAutosave.flush}
                  placeholder="feature/platform-reliability"
                  placeholderTextColor={colors.gray600}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Text style={styles.branchHint}>
                  Ticket pull requests skip CI. CI runs on the final pull request to the repo
                  default branch.
                </Text>
              </>
            )}
            <Text style={styles.label}>Name</Text>
            <TextInput
              style={styles.input}
              value={epicForm.name}
              onChangeText={(v: any) => changeEpicForm({ name: v })}
              onBlur={epicAutosave.flush}
              placeholderTextColor={colors.gray600}
            />
            <Text style={styles.label}>Description</Text>
            <TextInput
              style={[styles.input, { minHeight: 60 }]}
              value={epicForm.description}
              onChangeText={(v: any) => changeEpicForm({ description: v })}
              onBlur={epicAutosave.flush}
              multiline
              placeholderTextColor={colors.gray600}
            />
            <Text style={styles.label}>Color</Text>
            <View style={styles.colorRow}>
              {EPIC_COLORS.map((c: any) => (
                <TouchableOpacity
                  key={c}
                  style={[
                    styles.colorBtn,
                    { backgroundColor: c },
                    epicForm.color === c && styles.colorBtnActive,
                  ]}
                  onPress={() => changeEpicForm({ color: c }, true)}
                />
              ))}
            </View>
            <Text style={styles.label}>Labels</Text>
            <TextInput
              style={styles.input}
              value={epicForm.labels}
              onChangeText={(v: any) => changeEpicForm({ labels: v })}
              onBlur={epicAutosave.flush}
              placeholder="platform, reliability"
              placeholderTextColor={colors.gray600}
              autoCapitalize="none"
              autoCorrect={false}
              testID="epic-labels-input"
            />
            {assignableUsers.length > 0 && (
              <>
                <Text style={styles.label}>Lead user</Text>
                <View style={styles.chipRow} testID="epic-lead-user-select">
                  {[{ id: '', username: 'Unassigned' }, ...assignableUsers].map((u: any) => {
                    const active = (epicForm.assigned_user_id || '') === u.id;
                    return (
                      <TouchableOpacity
                        key={u.id || 'unassigned'}
                        style={[styles.filterChip, active && styles.filterChipActive]}
                        onPress={() => changeEpicForm({ assigned_user_id: u.id }, true)}
                      >
                        <Text
                          style={[styles.filterChipText, active && styles.filterChipTextActive]}
                        >
                          {u.username}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </>
            )}
            {editingEpic ? (
              <Text
                style={[
                  styles.autosaveStatus,
                  epicAutosave.state === 'error' && styles.autosaveError,
                ]}
                testID="epic-autosave-status"
              >
                {epicAutosaveLabel(epicAutosave.state)}
              </Text>
            ) : (
              <TouchableOpacity
                style={[styles.primaryBtn, saving && { opacity: 0.5 }]}
                onPress={handleSave}
                disabled={saving}
              >
                <Text style={styles.primaryBtnText}>{saving ? 'Saving…' : 'Create'}</Text>
              </TouchableOpacity>
            )}
            {!editingEpic && (
              <TouchableOpacity
                style={[styles.scopeBtn, (saving || !!scopingId) && { opacity: 0.5 }]}
                onPress={handleCreateAndScope}
                disabled={saving || !!scopingId}
              >
                <Text style={styles.scopeBtnText}>
                  {scopingId ? 'Opening…' : 'Create & scope with agent'}
                </Text>
              </TouchableOpacity>
            )}
            {editingEpic && (
              <TouchableOpacity
                style={[styles.scopeBtn, !!scopingId && { opacity: 0.5 }]}
                onPress={() => openScopingSession(editingEpic.id)}
                disabled={!!scopingId}
              >
                <Text style={styles.scopeBtnText}>
                  {scopingId ? 'Opening…' : 'Scope with agent'}
                </Text>
              </TouchableOpacity>
            )}
            {editingEpic && (
              <TouchableOpacity style={styles.deleteBtn} onPress={handleDelete}>
                <Text style={styles.deleteBtnText}>Delete epic</Text>
              </TouchableOpacity>
            )}
            {/* Reverse (bidirectional) display: the caller's own personal todos
                linked to this epic. Renders nothing when there are none. */}
            {editingEpic ? (
              <LinkedTodosPanel targetType="epic" entity={editingEpic} projectId={projectId} />
            ) : null}
            {editingEpic ? (
              <EpicPullsSection
                projectId={projectId}
                epicId={editingEpic.id}
                onOpenPull={(prNumber: any) =>
                  navigation?.navigate?.('PullRequests', { projectId, project, prNumber })
                }
              />
            ) : null}
          </View>
        )}

        <View style={styles.stateFilterRow}>
          {[
            ['list', 'List'],
            ['board', 'Board'],
          ].map(([value, label]) => (
            <TouchableOpacity
              key={value}
              style={[styles.stateFilterBtn, viewMode === value && styles.stateFilterBtnActive]}
              onPress={() => setViewMode(value as 'list' | 'board')}
            >
              <Text
                style={[styles.stateFilterText, viewMode === value && styles.stateFilterTextActive]}
              >
                {label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.searchRow}>
          <TextInput
            style={styles.searchInput}
            value={listFilters.search}
            onChangeText={(v: any) => setListFilters((prev) => ({ ...prev, search: v }))}
            placeholder="Search epics…"
            placeholderTextColor={colors.gray600}
            autoCapitalize="none"
            autoCorrect={false}
            testID="epic-list-search"
          />
        </View>

        <View style={styles.stateFilterRow} testID="epic-list-filter-scope">
          {(
            [
              ['all', 'All epics'],
              ['with-tickets', 'With tickets'],
              ['empty', 'Empty'],
            ] as const
          ).map(([value, label]) => (
            <TouchableOpacity
              key={value}
              style={[
                styles.stateFilterBtn,
                listFilters.scope === value && styles.stateFilterBtnActive,
              ]}
              onPress={() => setListFilters((prev) => ({ ...prev, scope: value }))}
            >
              <Text
                style={[
                  styles.stateFilterText,
                  listFilters.scope === value && styles.stateFilterTextActive,
                ]}
              >
                {label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {viewMode === 'list' && (
          <View style={styles.stateFilterRow} testID="epic-list-filter-state">
            {(
              [
                ['all', 'All states'],
                ['not_started', EPIC_STATE_LABELS.not_started],
                ['in_progress', EPIC_STATE_LABELS.in_progress],
                ['done', EPIC_STATE_LABELS.done],
              ] as const
            ).map(([value, label]) => (
              <TouchableOpacity
                key={value}
                style={[
                  styles.stateFilterBtn,
                  listFilters.state === value && styles.stateFilterBtnActive,
                ]}
                onPress={() => setListFilters((prev) => ({ ...prev, state: value }))}
              >
                <Text
                  style={[
                    styles.stateFilterText,
                    listFilters.state === value && styles.stateFilterTextActive,
                  ]}
                >
                  {label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {availableEpicLabels.length > 0 && (
          <View style={styles.chipRow} testID="epic-list-label-filters">
            {availableEpicLabels.map((label) => {
              const active = listFilters.selectedLabels.has(label);
              return (
                <TouchableOpacity
                  key={label}
                  style={[styles.filterChip, active && styles.filterChipActive]}
                  onPress={() => toggleEpicListLabel(label)}
                  testID={`epic-list-label-${label}`}
                >
                  <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
            {listFilters.selectedLabels.size > 0 && (
              <TouchableOpacity
                onPress={() => setListFilters((prev) => ({ ...prev, selectedLabels: new Set() }))}
                testID="epic-list-clear-labels"
              >
                <Text style={styles.clearFilterText}>Clear labels</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {assignableUsers.length > 0 && (
          <View style={styles.chipRow} testID="epic-list-user-filter-list">
            {assignableUsers.map((user: any) => {
              const active = listFilters.selectedUserIds.has(user.id);
              return (
                <TouchableOpacity
                  key={user.id}
                  style={[styles.userChip, active && styles.userChipActive]}
                  onPress={() => toggleEpicListUser(user.id)}
                  testID={`epic-list-user-filter-${user.username}`}
                >
                  <Text style={[styles.filterChipText, active && styles.userChipTextActive]}>
                    {user.username}
                  </Text>
                </TouchableOpacity>
              );
            })}
            {listFilters.selectedUserIds.size > 0 && (
              <TouchableOpacity
                onPress={() => setListFilters((prev) => ({ ...prev, selectedUserIds: new Set() }))}
                testID="epic-list-user-filter-clear"
              >
                <Text style={styles.clearFilterText}>Clear users</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {loading ? (
          <ActivityIndicator color={colors.gray400} style={{ marginTop: 24 }} />
        ) : epics.length === 0 ? (
          <Text style={styles.empty}>No epics yet.</Text>
        ) : viewMode === 'board' ? (
          <View>
            {boardColumns.map((column) => (
              <View key={column.key} style={styles.boardSection}>
                <View style={styles.boardSectionHeader}>
                  <Text style={styles.boardSectionTitle}>{column.label}</Text>
                  <Text style={styles.boardSectionCount}>{column.epics.length}</Text>
                </View>
                {column.epics.length === 0 ? (
                  <Text style={styles.boardSectionEmpty}>No epics</Text>
                ) : (
                  column.epics.map(renderEpicCard)
                )}
              </View>
            ))}
          </View>
        ) : filteredEpics.length === 0 ? (
          <Text style={styles.empty}>No epics match these filters.</Text>
        ) : (
          filteredEpics.map(renderEpicCard)
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.gray950 },
  content: { padding: 16, paddingBottom: 32 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  desc: { fontSize: 13, color: colors.gray500, flex: 1 },
  link: { fontSize: 13, color: colors.blue400 },
  empty: { fontSize: 14, color: colors.gray500, marginTop: 16 },
  formCard: {
    backgroundColor: colors.gray900,
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  label: { fontSize: 12, color: colors.gray400, marginBottom: 4, marginTop: 8 },
  input: {
    backgroundColor: colors.gray950,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    padding: 10,
    color: colors.white,
    fontSize: 14,
  },
  colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  colorBtn: { width: 28, height: 28, borderRadius: 6 },
  colorBtnActive: { borderWidth: 2, borderColor: colors.white },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  branchHint: { color: colors.gray500, fontSize: 11, lineHeight: 16, marginTop: 6 },
  primaryBtn: {
    marginTop: 12,
    backgroundColor: colors.emerald800_50,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  primaryBtnText: { color: colors.emerald400, fontWeight: '600' },
  autosaveStatus: {
    color: colors.gray500,
    fontSize: 11,
    marginTop: 12,
    textAlign: 'right',
  },
  autosaveError: { color: colors.red400 },
  deleteBtn: { marginTop: 8, alignItems: 'center', paddingVertical: 8 },
  deleteBtnText: { color: colors.red400, fontSize: 13 },
  epicCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.gray900,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
    gap: 10,
  },
  epicDot: { width: 10, height: 10, borderRadius: 3 },
  epicInfo: { flex: 1 },
  epicName: { fontSize: 15, fontWeight: '600', color: colors.white },
  epicDesc: { fontSize: 12, color: colors.gray500, marginTop: 2 },
  epicCount: { fontSize: 11, color: colors.gray500, marginTop: 4 },
  epicState: { fontSize: 11, color: colors.gray400, marginTop: 2 },
  stateFilterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  stateFilterBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
  },
  stateFilterBtnActive: {
    borderColor: colors.blue400,
    backgroundColor: colors.gray800,
  },
  stateFilterText: { color: colors.gray400, fontSize: 12, fontWeight: '600' },
  stateFilterTextActive: { color: colors.blue400 },
  searchRow: { marginBottom: 12 },
  searchInput: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: colors.white,
    fontSize: 14,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
    alignItems: 'center',
  },
  filterChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
  },
  filterChipActive: { borderColor: colors.indigo400, backgroundColor: colors.indigo900_40 },
  filterChipText: { color: colors.gray400, fontSize: 11, fontWeight: '600' },
  filterChipTextActive: { color: colors.indigo300 },
  userChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
  },
  userChipActive: { borderColor: colors.sky400, backgroundColor: colors.sky500_15 },
  userChipTextActive: { color: colors.sky300 },
  clearFilterText: { color: colors.gray500, fontSize: 11, paddingHorizontal: 4 },
  boardSection: { marginBottom: 20 },
  boardSectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  boardSectionTitle: { fontSize: 13, fontWeight: '700', color: colors.gray200 },
  boardSectionCount: { fontSize: 11, fontWeight: '600', color: colors.gray500 },
  boardSectionEmpty: { fontSize: 12, color: colors.gray600, paddingVertical: 8 },
  boardLink: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.gray800,
  },
  boardLinkText: { fontSize: 12, color: colors.blue400 },
  epicActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  scopeLinkText: { fontSize: 12, color: colors.indigo300 },
  scopeBtn: {
    marginTop: 8,
    backgroundColor: colors.indigo900_40,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  scopeBtnText: { color: colors.indigo300, fontWeight: '600' },
});
