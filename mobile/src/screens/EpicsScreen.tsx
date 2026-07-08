import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, Switch, } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../utils/api';
import { useApp } from '../context/AppContext';
import { colors } from '../theme/colors';
import { EPIC_COLORS, DEFAULT_EPIC_FORM, DEFAULT_EPIC_LIST_STATE_FILTER, epicFormFromRow, epicFormToUpdateBody, epicFormToCreateBody, countOpenCardsForEpic, epicDropdownLabel, EPIC_STATE_LABELS, epicStateLabel, } from '../utils/epics';
import { groupEpicsByState } from '../utils/epicBoard';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
import LinkedTodosPanel from '../components/LinkedTodosPanel';
export default function EpicsScreen({ route, navigation }: any) {
    const { projectId, project: routeProject } = route.params || {};
    const project = routeProject;
    const [board, setBoard] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [editingEpic, setEditingEpic] = useState<any>(null);
    const [epicForm, setEpicForm] = useState(DEFAULT_EPIC_FORM);
    const [showForm, setShowForm] = useState(false);
    const [saving, setSaving] = useState(false);
    const [scopingId, setScopingId] = useState<any>(null);
    const [stateFilter, setStateFilter] = useState(DEFAULT_EPIC_LIST_STATE_FILTER);
    const [viewMode, setViewMode] = useState<'list' | 'board'>('list');
    const { setActiveAgentId, setActiveSessionId } = useApp();
    const openScopingSession = useCallback(async (epicId: any) => {
        if (!epicId || scopingId)
            return false;
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
        }
        catch {
            Alert.alert('Error', 'Failed to open scoping session');
            return false;
        }
        finally {
            setScopingId(null);
        }
    }, [projectId, scopingId, navigation, setActiveAgentId, setActiveSessionId]);
    const loadBoard = useCallback(async () => {
        setLoading(true);
        try {
            const data = await api.getProjectBoard(projectId);
            setBoard(data);
        }
        catch (err: any) {
            Alert.alert('Error', err?.message || 'Failed to load epics');
            setBoard(null);
        }
        finally {
            setLoading(false);
        }
    }, [projectId]);
    useEffect(() => {
        loadBoard();
    }, [loadBoard]);
    const epics = board?.epics || [];
    const cards = board?.cards || [];
    const doneColumnIds = new Set((board?.columns || []).filter((c: any) => /done/i.test(c.name || '')).map((c: any) => c.id));
    const visibleEpics = epics.filter((epic: any) => stateFilter === 'all' || epic.state === stateFilter);
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
    const handleSave = async () => {
        if (!epicForm.name.trim()) {
            Alert.alert('Error', 'Epic name is required');
            return;
        }
        setSaving(true);
        try {
            if (editingEpic) {
                await api.updateEpic(projectId, editingEpic.id, epicFormToUpdateBody(epicForm));
            }
            else {
                const created = await api.createEpic(projectId, epicFormToCreateBody(epicForm));
                if (created?.id && epicForm.autonomous) {
                    await api.updateEpic(projectId, created.id, epicFormToUpdateBody(epicForm));
                }
            }
            setShowForm(false);
            setEditingEpic(null);
            setEpicForm(DEFAULT_EPIC_FORM);
            await loadBoard();
        }
        catch {
            Alert.alert('Error', 'Failed to save epic');
        }
        finally {
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
            if (created?.id && epicForm.autonomous) {
                await api.updateEpic(projectId, created.id, epicFormToUpdateBody(epicForm));
            }
            setShowForm(false);
            setEditingEpic(null);
            setEpicForm(DEFAULT_EPIC_FORM);
            await loadBoard();
            if (created?.id)
                await openScopingSession(created.id);
        }
        catch {
            Alert.alert('Error', 'Failed to create epic');
        }
        finally {
            setSaving(false);
        }
    };
    const handleDelete = () => {
        if (!editingEpic)
            return;
        Alert.alert('Delete Epic', `Delete "${editingEpic.name}"? Linked cards will be unlinked.`, [
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
                    }
                    catch {
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
        return (<TouchableOpacity key={epic.id} style={styles.epicCard} onPress={() => openEdit(epic)}>
            <View style={[styles.epicDot, { backgroundColor: epic.color || colors.indigo500 }]}/>
            <View style={styles.epicInfo}>
              <Text style={styles.epicName}>{epicDropdownLabel(epic)}</Text>
              {epic.description ? (<Text style={styles.epicDesc} numberOfLines={2}>{epic.description}</Text>) : null}
              <Text style={styles.epicCount}>
                {open} open · {total} total card{total === 1 ? '' : 's'}
              </Text>
              {viewMode === 'list' && stateLabel ? (<Text style={styles.epicState}>{stateLabel}</Text>) : null}
            </View>
            <View style={styles.epicActions}>
              <TouchableOpacity style={styles.boardLink} onPress={() => openScopingSession(epic.id)} disabled={!!scopingId}>
                <Text style={styles.scopeLinkText}>{scopingId === epic.id ? '…' : 'Scope'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.boardLink} onPress={() => navigation.navigate('Kanban', { projectId, project, epicId: epic.id })}>
                <Text style={styles.boardLinkText}>Board</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>);
    };
    const boardColumns = groupEpicsByState(epics);
    return (<SafeAreaView style={styles.screen} edges={['top']}>
      <ProjectScreenHeader title="Epics" project={project} onBack={() => navigation.goBack()}/>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.headerRow}>
          <Text style={styles.desc}>Group kanban cards into epics for this project.</Text>
          <TouchableOpacity onPress={() => (showForm ? setShowForm(false) : openCreate())}>
            <Text style={styles.link}>{showForm ? 'Cancel' : '+ New'}</Text>
          </TouchableOpacity>
        </View>

        {showForm && (<View style={styles.formCard}>
            <Text style={styles.label}>Name</Text>
            <TextInput style={styles.input} value={epicForm.name} onChangeText={(v: any) => setEpicForm({ ...epicForm, name: v })} placeholderTextColor={colors.gray600}/>
            <Text style={styles.label}>Description</Text>
            <TextInput style={[styles.input, { minHeight: 60 }]} value={epicForm.description} onChangeText={(v: any) => setEpicForm({ ...epicForm, description: v })} multiline placeholderTextColor={colors.gray600}/>
            <Text style={styles.label}>Color</Text>
            <View style={styles.colorRow}>
              {EPIC_COLORS.map((c: any) => (<TouchableOpacity key={c} style={[
                    styles.colorBtn,
                    { backgroundColor: c },
                    epicForm.color === c && styles.colorBtnActive,
                ]} onPress={() => setEpicForm({ ...epicForm, color: c })}/>))}
            </View>
            <View style={styles.switchRow}>
              <Text style={styles.label}>Autonomous</Text>
              <Switch value={!!epicForm.autonomous} onValueChange={(v: any) => setEpicForm({ ...epicForm, autonomous: v ? 1 : 0 })} trackColor={{ false: colors.gray700, true: colors.emerald800_50 }} thumbColor={epicForm.autonomous ? colors.emerald400 : colors.gray500}/>
            </View>
            <TouchableOpacity style={[styles.primaryBtn, saving && { opacity: 0.5 }]} onPress={handleSave} disabled={saving}>
              <Text style={styles.primaryBtnText}>{saving ? 'Saving…' : editingEpic ? 'Update' : 'Create'}</Text>
            </TouchableOpacity>
            {!editingEpic && (<TouchableOpacity style={[styles.scopeBtn, (saving || !!scopingId) && { opacity: 0.5 }]} onPress={handleCreateAndScope} disabled={saving || !!scopingId}>
                <Text style={styles.scopeBtnText}>{scopingId ? 'Opening…' : 'Create & scope with agent'}</Text>
              </TouchableOpacity>)}
            {editingEpic && (<TouchableOpacity style={[styles.scopeBtn, !!scopingId && { opacity: 0.5 }]} onPress={() => openScopingSession(editingEpic.id)} disabled={!!scopingId}>
                <Text style={styles.scopeBtnText}>{scopingId ? 'Opening…' : 'Scope with agent'}</Text>
              </TouchableOpacity>)}
            {editingEpic && (<TouchableOpacity style={styles.deleteBtn} onPress={handleDelete}>
                <Text style={styles.deleteBtnText}>Delete epic</Text>
              </TouchableOpacity>)}
            {/* Reverse (bidirectional) display: the caller's own personal todos
                linked to this epic. Renders nothing when there are none. */}
            {editingEpic ? (<LinkedTodosPanel targetType="epic" entity={editingEpic} projectId={projectId} />) : null}
          </View>)}

        <View style={styles.stateFilterRow}>
          {[
            ['list', 'List'],
            ['board', 'Board'],
        ].map(([value, label]) => (<TouchableOpacity key={value} style={[styles.stateFilterBtn, viewMode === value && styles.stateFilterBtnActive]} onPress={() => setViewMode(value as 'list' | 'board')}>
              <Text style={[styles.stateFilterText, viewMode === value && styles.stateFilterTextActive]}>{label}</Text>
            </TouchableOpacity>))}
        </View>

        {viewMode === 'list' && (<View style={styles.stateFilterRow}>
          {[
            ['all', 'All states'],
            ['not_started', EPIC_STATE_LABELS.not_started],
            ['in_progress', EPIC_STATE_LABELS.in_progress],
            ['done', EPIC_STATE_LABELS.done],
        ].map(([value, label]) => (<TouchableOpacity key={value} style={[styles.stateFilterBtn, stateFilter === value && styles.stateFilterBtnActive]} onPress={() => setStateFilter(value)}>
              <Text style={[styles.stateFilterText, stateFilter === value && styles.stateFilterTextActive]}>{label}</Text>
            </TouchableOpacity>))}
        </View>)}

        {loading ? (<ActivityIndicator color={colors.gray400} style={{ marginTop: 24 }}/>) : epics.length === 0 ? (<Text style={styles.empty}>No epics yet.</Text>) : viewMode === 'board' ? (<View>
            {boardColumns.map((column) => (<View key={column.key} style={styles.boardSection}>
              <View style={styles.boardSectionHeader}>
                <Text style={styles.boardSectionTitle}>{column.label}</Text>
                <Text style={styles.boardSectionCount}>{column.epics.length}</Text>
              </View>
              {column.epics.length === 0 ? (<Text style={styles.boardSectionEmpty}>No epics</Text>) : column.epics.map(renderEpicCard)}
            </View>))}
          </View>) : visibleEpics.length === 0 ? (<Text style={styles.empty}>No epics match this state.</Text>) : (visibleEpics.map(renderEpicCard))}
      </ScrollView>
    </SafeAreaView>);
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
    switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
    primaryBtn: {
        marginTop: 12,
        backgroundColor: colors.emerald800_50,
        paddingVertical: 10,
        borderRadius: 8,
        alignItems: 'center',
    },
    primaryBtnText: { color: colors.emerald400, fontWeight: '600' },
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
