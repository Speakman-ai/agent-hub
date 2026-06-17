import React, { useState, useEffect, useCallback, useContext, useRef, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Modal,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../context/AppContext';
import { SidebarContext } from '../context/SidebarContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import {
  EPIC_COLORS,
  DEFAULT_EPIC_COLOR,
  DEFAULT_EPIC_FORM,
  epicFormFromRow,
  epicFormToUpdateBody,
  epicFormToCreateBody,
  filterCardsByEpic,
  countOpenCardsForEpic,
  findEpic,
  epicDropdownLabel,
} from '../utils/epics';
import {
  findAgentByName,
  hasActiveSession,
  buildAssigneeOptions,
  filterAgentsByProject,
  validModelsForAgent,
  engineEntriesWithModels,
} from '../utils/kanbanAssign';
import { hasUnresolvedBlockers, shouldConfirmMove } from '../utils/blockers';

const DEFAULT_COLUMNS = [
  { id: 'todo', name: 'To Do', color: '#3B82F6' },
  { id: 'in-progress', name: 'In Progress', color: '#F59E0B' },
  { id: 'done', name: 'Done', color: '#10B981' },
];

const PRIORITY_OPTIONS = [
  { value: 'urgent', label: 'Urgent', color: '#EF4444' },
  { value: 'high', label: 'High', color: '#F97316' },
  { value: 'medium', label: 'Medium', color: '#3B82F6' },
  { value: 'low', label: 'Low', color: '#6B7280' },
];

function getPriorityColor(priority) {
  const opt = PRIORITY_OPTIONS.find((p) => p.value === priority);
  return opt ? opt.color : colors.gray500;
}

function getPriorityLabel(priority) {
  const opt = PRIORITY_OPTIONS.find((p) => p.value === priority);
  return opt ? opt.label : priority || 'None';
}

export default function KanbanScreen({ route, navigation }) {
  const { projectId, project, cardId: deepLinkCardId } = route.params || {};
  const { agents, kanbanRefreshKey, setActiveAgentId, setActiveSessionId } = useApp();
  const { openSidebar } = useContext(SidebarContext);

  // Agents are loaded app-wide across every visible project; the assignee
  // picker must only offer agents that belong to this project.
  const projectAgents = useMemo(
    () => filterAgentsByProject(agents, projectId),
    [agents, projectId],
  );

  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeColumn, setActiveColumn] = useState(null);
  const [showAddCard, setShowAddCard] = useState(false);
  const [newCardTitle, setNewCardTitle] = useState('');
  const [newCardPriority, setNewCardPriority] = useState('medium');
  const [selectedCard, setSelectedCard] = useState(null);
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [moveCardTarget, setMoveCardTarget] = useState(null);
  const [comments, setComments] = useState([]);
  const [newComment, setNewComment] = useState('');
  const [saving, setSaving] = useState(false);

  // Detail edit state
  const [editDescription, setEditDescription] = useState('');
  const [editPriority, setEditPriority] = useState('');
  const [editAssignee, setEditAssignee] = useState('');
  const [editLabels, setEditLabels] = useState('');
  const [editGithubUrl, setEditGithubUrl] = useState('');
  const [editEpicId, setEditEpicId] = useState('');
  const [showEpicPickerForCard, setShowEpicPickerForCard] = useState(false);

  // Agent assignment state
  const [showAssigneePicker, setShowAssigneePicker] = useState(false);
  const [showReassign, setShowReassign] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [editAssignModel, setEditAssignModel] = useState('');
  const [showAssignModelPicker, setShowAssignModelPicker] = useState(false);
  // Optional engine override for the spawn. Empty string = "use the agent's
  // configured engine" (server falls back to agents.engine). Mirrors the
  // web client's `detailForm.assign_engine`.
  const [editAssignEngine, setEditAssignEngine] = useState('');
  const [showAssignEnginePicker, setShowAssignEnginePicker] = useState(false);
  const [modelConfig, setModelConfig] = useState(null);

  // Blocker picker state
  const [showBlockerPicker, setShowBlockerPicker] = useState(false);
  const [blockerPickerQuery, setBlockerPickerQuery] = useState('');

  // Epic state
  const [selectedEpicId, setSelectedEpicId] = useState(null);
  const [showEpicFilterModal, setShowEpicFilterModal] = useState(false);
  const [showEpicManager, setShowEpicManager] = useState(false);
  const [editingEpic, setEditingEpic] = useState(null); // null = creating new
  const [epicForm, setEpicForm] = useState(DEFAULT_EPIC_FORM);
  const [epicSaving, setEpicSaving] = useState(false);
  const [showAutonomousModelModal, setShowAutonomousModelModal] = useState(false);

  const columns = board?.columns || DEFAULT_COLUMNS;
  const epics = board?.epics || [];
  const doneColumnIds = new Set(
    columns.filter((c) => /done|complete|closed/i.test(c.name || c.id || '')).map((c) => c.id)
  );
  const columnInitialized = useRef(false);

  const loadBoard = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await api.getProjectBoard(projectId);
      setBoard(data);
      if (data?.columns?.length > 0 && !columnInitialized.current) {
        setActiveColumn(data.columns[0].id);
        columnInitialized.current = true;
      }
    } catch (err) {
      console.error('Failed to load board:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadBoard();
  }, [loadBoard, kanbanRefreshKey]);

  // Notification deep-link: open the target card once the board loads.
  const deepLinkHandledRef = useRef(null);
  useEffect(() => {
    if (!deepLinkCardId || !board?.cards) return;
    if (deepLinkHandledRef.current === deepLinkCardId) return;
    const card = board.cards.find((c) => c.id === deepLinkCardId);
    if (!card) return;
    deepLinkHandledRef.current = deepLinkCardId;
    setActiveColumn(card.column_id);
    setSelectedCard(card);
    setEditDescription(card.description || '');
    setEditPriority(card.priority || '');
    setEditAssignee(card.assignee || '');
    setEditLabels((card.labels || []).join(', '));
    setEditGithubUrl(card.github_url || '');
    setEditEpicId(card.epic_id || '');
  }, [deepLinkCardId, board]);

  useEffect(() => {
    if (typeof api.getModelConfig !== 'function') return;
    api
      .getModelConfig()
      .then(setModelConfig)
      .catch(() => setModelConfig(null));
  }, []);

  const autonomousModelOptions = useMemo(() => {
    if (!modelConfig?.engineValidModels) return [];
    const s = new Set();
    for (const arr of Object.values(modelConfig.engineValidModels)) {
      for (const m of arr || []) {
        if (m) s.add(m);
      }
    }
    return Array.from(s).sort();
  }, [modelConfig]);

  const cardsForColumn = (columnId) => {
    if (!board?.cards) return [];
    const scoped = filterCardsByEpic(board.cards, selectedEpicId);
    return scoped
      .filter((c) => c.column_id === columnId)
      .sort((a, b) => (a.position || 0) - (b.position || 0));
  };

  const selectedEpic = findEpic(epics, selectedEpicId);

  const activeColumnObj = columns.find((c) => c.id === activeColumn) || columns[0];

  const handleCreateCard = async () => {
    if (!newCardTitle.trim()) return;
    setSaving(true);
    try {
      const payload = {
        title: newCardTitle.trim(),
        priority: newCardPriority,
        columnId: activeColumn,
      };
      // If the board is filtered to an epic, tag the new card with that epic
      // (matches the web behaviour in KanbanBoard.jsx).
      if (selectedEpicId) payload.epicId = selectedEpicId;
      await api.createKanbanCard(projectId, payload);
      setNewCardTitle('');
      setNewCardPriority('medium');
      setShowAddCard(false);
      await loadBoard();
    } catch (err) {
      Alert.alert('Error', 'Failed to create card');
    } finally {
      setSaving(false);
    }
  };

  const handleOpenDetail = async (card) => {
    setSelectedCard(card);
    setEditDescription(card.description || '');
    setEditPriority(card.priority || 'medium');
    setEditAssignee(card.assignee || '');
    setEditAssignModel(card.assign_model || '');
    setEditAssignEngine(card.assign_engine || '');
    setEditLabels(typeof card.labels === 'string' ? card.labels : (card.labels || []).join(', '));
    setEditGithubUrl(card.github_issue_url || '');
    setEditEpicId(card.epic_id || '');
    setShowReassign(false);
    // Load comments
    try {
      const data = await api.getCardComments(projectId, card.id);
      setComments(data || []);
    } catch {
      setComments([]);
    }
  };

  // --- Epic CRUD / linking ---

  const openEpicCreate = () => {
    setEditingEpic(null);
    setEpicForm(DEFAULT_EPIC_FORM);
    setShowEpicManager(true);
  };

  const openEpicEdit = (epic) => {
    setEditingEpic(epic);
    setEpicForm(epicFormFromRow(epic));
    setShowEpicManager(true);
  };

  const handleSaveEpic = async () => {
    if (!epicForm.name.trim()) {
      Alert.alert('Error', 'Epic name is required');
      return;
    }
    setEpicSaving(true);
    try {
      if (editingEpic) {
        await api.updateEpic(projectId, editingEpic.id, epicFormToUpdateBody(epicForm));
      } else {
        const created = await api.createEpic(projectId, epicFormToCreateBody(epicForm));
        // If the user toggled autonomous while creating, apply it via a
        // follow-up PUT so the autonomous-exclusive rule runs server-side.
        if (created?.id && epicForm.autonomous) {
          await api.updateEpic(projectId, created.id, epicFormToUpdateBody(epicForm));
        }
      }
      setShowEpicManager(false);
      setEditingEpic(null);
      setEpicForm(DEFAULT_EPIC_FORM);
      await loadBoard();
    } catch (err) {
      Alert.alert('Error', 'Failed to save epic');
    } finally {
      setEpicSaving(false);
    }
  };

  const handleDeleteEpic = () => {
    if (!editingEpic) return;
    Alert.alert(
      'Delete Epic',
      `Delete "${editingEpic.name}"? Cards linked to this epic will be unlinked but not deleted.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.deleteEpic(projectId, editingEpic.id);
              if (selectedEpicId === editingEpic.id) setSelectedEpicId(null);
              setShowEpicManager(false);
              setEditingEpic(null);
              setEpicForm(DEFAULT_EPIC_FORM);
              await loadBoard();
            } catch {
              Alert.alert('Error', 'Failed to delete epic');
            }
          },
        },
      ]
    );
  };

  const handleLinkCardEpic = async (epicId) => {
    if (!selectedCard) return;
    try {
      await api.linkCardToEpic(projectId, selectedCard.id, epicId || null);
      setEditEpicId(epicId || '');
      setShowEpicPickerForCard(false);
      await loadBoard();
    } catch {
      Alert.alert('Error', 'Failed to link epic');
    }
  };

  // Select an agent from the picker modal — stored as the agent's *name* in
  // `editAssignee` to match the server schema (card.assignee = agent.name).
  const handleSelectAssignee = (agentName) => {
    setEditAssignee(agentName || '');
    setEditAssignModel('');
    setEditAssignEngine('');
    setShowAssigneePicker(false);
  };

  const handleSelectAssignModel = (modelId) => {
    setEditAssignModel(modelId || '');
    setShowAssignModelPicker(false);
  };

  // Pick the engine the spawn will run under. Resetting the model is critical:
  // a saved claude-code model is invalid under codex-cli, and the server would
  // refuse the POST. Matches the web client's onChange handler.
  const handleSelectAssignEngine = (engineId) => {
    setEditAssignEngine(engineId || '');
    setEditAssignModel('');
    setShowAssignEnginePicker(false);
  };

  // Spawn a session on the selected agent and attach it to this card. Server
  // moves the card to "In Progress" and returns `{ sessionId, ... }`; we
  // navigate straight into the new chat session (matches web behaviour).
  const handleAssignAndStart = async () => {
    if (!selectedCard || !editAssignee) return;
    const agent = findAgentByName(agents, editAssignee);
    if (!agent) {
      Alert.alert('Error', `Agent "${editAssignee}" not found`);
      return;
    }
    setAssigning(true);
    try {
      const assignOpts = {};
      if (editAssignModel.trim()) assignOpts.model = editAssignModel.trim();
      if (editAssignEngine.trim()) assignOpts.engine = editAssignEngine.trim();
      const result = await api.assignCard(projectId, selectedCard.id, agent.id, assignOpts);
      setSelectedCard(null);
      setShowReassign(false);
      await loadBoard();
      if (result?.sessionId && navigation) {
        setActiveAgentId(agent.id);
        setActiveSessionId(result.sessionId);
        navigation.navigate('Chat');
      }
    } catch (err) {
      Alert.alert('Error', 'Failed to assign card');
    } finally {
      setAssigning(false);
    }
  };

  // Jump to the existing session attached to the card (if any).
  const handleOpenSession = () => {
    if (!selectedCard?.session_id) return;
    const agent = findAgentByName(agents, selectedCard.assignee);
    if (!agent || !navigation) return;
    setActiveAgentId(agent.id);
    setActiveSessionId(selectedCard.session_id);
    setSelectedCard(null);
    navigation.navigate('Chat');
  };

  const handleSaveCard = async () => {
    if (!selectedCard) return;
    setSaving(true);
    try {
      const labelsStr = editLabels
        .split(',')
        .map((l) => l.trim())
        .filter(Boolean)
        .join(',');
      await api.updateKanbanCard(projectId, selectedCard.id, {
        description: editDescription,
        priority: editPriority,
        assignee: editAssignee,
        labels: labelsStr,
        githubIssueUrl: editGithubUrl,
      });
      setSelectedCard(null);
      await loadBoard();
    } catch (err) {
      Alert.alert('Error', 'Failed to update card');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteCard = async () => {
    if (!selectedCard) return;
    Alert.alert('Delete Card', `Delete "${selectedCard.title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteKanbanCard(projectId, selectedCard.id);
            setSelectedCard(null);
            await loadBoard();
          } catch {
            Alert.alert('Error', 'Failed to delete card');
          }
        },
      },
    ]);
  };

  const handleAddComment = async () => {
    if (!newComment.trim() || !selectedCard) return;
    try {
      await api.addCardComment(projectId, selectedCard.id, { author: 'user', content: newComment.trim() });
      setNewComment('');
      const data = await api.getCardComments(projectId, selectedCard.id);
      setComments(data || []);
    } catch {
      Alert.alert('Error', 'Failed to add comment');
    }
  };

  const handleLongPressCard = (card) => {
    setMoveCardTarget(card);
    setShowMoveModal(true);
  };

  const commitMoveCard = async (cardId, targetColumnId) => {
    try {
      await api.moveKanbanCard(projectId, cardId, { columnId: targetColumnId });
      setShowMoveModal(false);
      setMoveCardTarget(null);
      await loadBoard();
    } catch {
      Alert.alert('Error', 'Failed to move card');
    }
  };

  const handleMoveCard = async (targetColumnId) => {
    if (!moveCardTarget) return;
    const targetColumn = columns.find((c) => c.id === targetColumnId);
    // Soft-warn when moving a blocked card into a sensitive column. The API
    // will still allow the move either way.
    if (shouldConfirmMove(moveCardTarget, moveCardTarget.column_id, targetColumn)) {
      const unresolved = moveCardTarget.blockers.filter((b) => !b.done);
      Alert.alert(
        'Card is still blocked',
        `"${moveCardTarget.title}" is blocked by ${unresolved.length} unresolved card(s):\n\n` +
          unresolved.map((b) => `• ${b.title}`).join('\n') +
          `\n\nMove into ${targetColumn?.name || 'column'} anyway?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Move anyway',
            style: 'destructive',
            onPress: () => commitMoveCard(moveCardTarget.id, targetColumnId),
          },
        ],
      );
      return;
    }
    await commitMoveCard(moveCardTarget.id, targetColumnId);
  };

  const refreshBoardAndSelected = async () => {
    const data = await api.getProjectBoard(projectId);
    setBoard(data);
    if (selectedCard) {
      const refreshed = data?.cards?.find((c) => c.id === selectedCard.id);
      if (refreshed) setSelectedCard(refreshed);
    }
  };

  const handleAddBlocker = async (blockedByCardId) => {
    if (!selectedCard || !blockedByCardId) return;
    try {
      await api.addCardBlocker(projectId, selectedCard.id, blockedByCardId);
      setShowBlockerPicker(false);
      setBlockerPickerQuery('');
      await refreshBoardAndSelected();
    } catch (err) {
      const msg = err?.message || '';
      if (msg.includes('cycle')) {
        Alert.alert('Cannot add', 'This would create a blocker cycle.');
      } else if (msg.includes('duplicate')) {
        Alert.alert('Already linked', 'That card is already a blocker.');
      } else {
        Alert.alert('Error', 'Failed to add blocker');
      }
    }
  };

  const handleRemoveBlocker = async (blockedByCardId) => {
    if (!selectedCard || !blockedByCardId) return;
    try {
      await api.removeCardBlocker(projectId, selectedCard.id, blockedByCardId);
      await refreshBoardAndSelected();
    } catch {
      Alert.alert('Error', 'Failed to remove blocker');
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={() => openSidebar()} style={styles.menuButton}>
            <Text style={styles.menuIcon}>{'\u2630'}</Text>
          </TouchableOpacity>
          <Text style={styles.topBarTitle}>{project?.name || 'Board'}</Text>
        </View>
        <View style={styles.centered}>
          <ActivityIndicator color={colors.blue500} />
        </View>
      </SafeAreaView>
    );
  }

  // Card detail modal
  if (selectedCard) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={() => setSelectedCard(null)} style={styles.menuButton}>
            <Text style={styles.backArrow}>{'\u2190'}</Text>
          </TouchableOpacity>
          <Text style={styles.topBarTitle} numberOfLines={1}>{selectedCard.title}</Text>
          <TouchableOpacity onPress={handleDeleteCard} style={styles.deleteBtn}>
            <Text style={styles.deleteBtnText}>Delete</Text>
          </TouchableOpacity>
        </View>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
          <ScrollView style={styles.detailScroll} contentContainerStyle={styles.detailContent}>
            {/* Priority */}
            <Text style={styles.fieldLabel}>Priority</Text>
            <View style={styles.priorityRow}>
              {PRIORITY_OPTIONS.map((p) => (
                <TouchableOpacity
                  key={p.value}
                  style={[
                    styles.priorityBtn,
                    editPriority === p.value && { backgroundColor: p.color + '33', borderColor: p.color },
                  ]}
                  onPress={() => setEditPriority(p.value)}
                >
                  <View style={[styles.priorityDot, { backgroundColor: p.color }]} />
                  <Text style={[styles.priorityBtnText, editPriority === p.value && { color: colors.white }]}>
                    {p.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Assignee */}
            <Text style={styles.fieldLabel}>Assignee</Text>
            {hasActiveSession(selectedCard) && !showReassign ? (
              <View>
                <View style={styles.assigneeActiveRow}>
                  <Text style={styles.assigneeActiveName}>
                    {editAssignee || 'Assigned'}
                  </Text>
                  <View style={styles.sessionActiveBadge}>
                    <Text style={styles.sessionActiveBadgeText}>Session active</Text>
                  </View>
                </View>
                <TouchableOpacity
                  style={styles.openSessionBtn}
                  onPress={handleOpenSession}
                >
                  <Text style={styles.openSessionBtnText}>Open Session</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.reassignBtn}
                  onPress={() => setShowReassign(true)}
                >
                  <Text style={styles.reassignBtnText}>Reassign</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View>
                <TouchableOpacity
                  style={styles.epicPickerBtn}
                  onPress={() => setShowAssigneePicker(true)}
                >
                  {editAssignee ? (
                    <Text style={styles.epicPickerText}>{editAssignee}</Text>
                  ) : (
                    <Text style={styles.epicPickerPlaceholder}>Unassigned</Text>
                  )}
                  <Text style={styles.epicPickerChevron}>{'\u25BE'}</Text>
                </TouchableOpacity>
                {/* Optional engine override: spawn the session under a different
                    engine than the agent's configured one (e.g. assign a Claude
                    agent but spawn under codex-cli). Listed engines are exactly
                    the ones the user is authenticated for. Changing the engine
                    resets the model selection \u2014 a claude-code model id is
                    invalid under codex-cli and the server would refuse it. */}
                {!!editAssignee && engineEntriesWithModels(modelConfig).length > 0 && (
                  <TouchableOpacity
                    style={[styles.epicPickerBtn, { marginTop: 8 }]}
                    onPress={() => setShowAssignEnginePicker(true)}
                    testID="card-assign-engine-picker"
                  >
                    <Text style={styles.epicPickerText}>
                      {editAssignEngine
                        ? `Session engine: ${editAssignEngine}`
                        : `Session engine: Agent default (${findAgentByName(agents, editAssignee)?.engine || 'claude-code'})`}
                    </Text>
                    <Text style={styles.epicPickerChevron}>{'\u25BE'}</Text>
                  </TouchableOpacity>
                )}
                {!!editAssignee &&
                  validModelsForAgent(agents, modelConfig, editAssignee, editAssignEngine).length > 0 && (
                    <TouchableOpacity
                      style={[styles.epicPickerBtn, { marginTop: 8 }]}
                      onPress={() => setShowAssignModelPicker(true)}
                    >
                      <Text style={styles.epicPickerText}>
                        {editAssignModel ? editAssignModel : 'Session model: Agent default'}
                      </Text>
                      <Text style={styles.epicPickerChevron}>{'\u25BE'}</Text>
                    </TouchableOpacity>
                  )}
                {!!editAssignee && (
                  <TouchableOpacity
                    style={[
                      styles.assignStartBtn,
                      assigning && styles.assignStartBtnDisabled,
                    ]}
                    onPress={handleAssignAndStart}
                    disabled={assigning}
                  >
                    <Text style={styles.assignStartBtnText}>
                      {assigning
                        ? 'Starting...'
                        : hasActiveSession(selectedCard)
                          ? 'Reassign & Start'
                          : 'Assign & Start'}
                    </Text>
                  </TouchableOpacity>
                )}
                {hasActiveSession(selectedCard) && showReassign && (
                  <TouchableOpacity
                    style={styles.reassignBtn}
                    onPress={() => {
                      setShowReassign(false);
                      setEditAssignee(selectedCard.assignee || '');
                      setEditAssignModel(selectedCard.assign_model || '');
                      setEditAssignEngine(selectedCard.assign_engine || '');
                    }}
                  >
                    <Text style={styles.reassignBtnText}>Cancel</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* Epic */}
            <Text style={styles.fieldLabel}>Epic</Text>
            <TouchableOpacity
              style={styles.epicPickerBtn}
              onPress={() => setShowEpicPickerForCard(true)}
            >
              {(() => {
                const linked = findEpic(epics, editEpicId);
                if (!linked) {
                  return <Text style={styles.epicPickerPlaceholder}>None</Text>;
                }
                return (
                  <View style={styles.epicPickerRow}>
                    <View style={[styles.epicDot, { backgroundColor: linked.color || DEFAULT_EPIC_COLOR }]} />
                    <Text style={styles.epicPickerText}>{epicDropdownLabel(linked)}</Text>
                  </View>
                );
              })()}
              <Text style={styles.epicPickerChevron}>{'\u25BE'}</Text>
            </TouchableOpacity>

            {/* Labels */}
            <Text style={styles.fieldLabel}>Labels (comma separated)</Text>
            <TextInput
              style={styles.fieldInput}
              value={editLabels}
              onChangeText={setEditLabels}
              placeholder="bug, feature, ui"
              placeholderTextColor={colors.gray600}
            />

            {/* Blocked by */}
            {hasUnresolvedBlockers(selectedCard) && (
              <View style={styles.blockerBanner} testID="blocker-banner">
                <Text style={styles.blockerBannerText}>
                  {'\u26A0'} This card is blocked by{' '}
                  {selectedCard.blockers.filter((b) => !b.done).length} unresolved card(s).
                </Text>
              </View>
            )}
            <View style={styles.blockerHeaderRow}>
              <Text style={styles.fieldLabel}>Blocked by</Text>
              <TouchableOpacity
                onPress={() => {
                  setShowBlockerPicker(true);
                  setBlockerPickerQuery('');
                }}
                style={styles.blockerAddBtn}
              >
                <Text style={styles.blockerAddBtnText}>+ Add</Text>
              </TouchableOpacity>
            </View>
            {(selectedCard.blockers || []).length === 0 ? (
              <Text style={styles.blockerEmpty}>No blockers</Text>
            ) : (
              selectedCard.blockers.map((b) => (
                <View
                  key={b.id}
                  style={[styles.blockerRow, b.done ? styles.blockerRowDone : styles.blockerRowOpen]}
                >
                  <Text
                    style={[styles.blockerRowText, b.done && styles.blockerRowTextDone]}
                    numberOfLines={1}
                  >
                    {b.done ? '\u2713 ' : ''}
                    {b.title}
                  </Text>
                  <TouchableOpacity
                    onPress={() => handleRemoveBlocker(b.id)}
                    style={styles.blockerRemoveBtn}
                  >
                    <Text style={styles.blockerRemoveBtnText}>{'\u2715'}</Text>
                  </TouchableOpacity>
                </View>
              ))
            )}

            {/* Blocks (inverse) */}
            {(selectedCard.blocks || []).length > 0 && (
              <>
                <Text style={styles.fieldLabel}>Blocks</Text>
                {selectedCard.blocks.map((b) => (
                  <View key={b.id} style={styles.blockerRow}>
                    <Text style={styles.blockerRowText} numberOfLines={1}>
                      {b.title}
                    </Text>
                  </View>
                ))}
              </>
            )}

            {/* Description */}
            <Text style={styles.fieldLabel}>Description</Text>
            <TextInput
              style={[styles.fieldInput, styles.multilineInput]}
              value={editDescription}
              onChangeText={setEditDescription}
              placeholder="Card description..."
              placeholderTextColor={colors.gray600}
              multiline
            />

            {/* GitHub URL */}
            <Text style={styles.fieldLabel}>GitHub URL</Text>
            <TextInput
              style={styles.fieldInput}
              value={editGithubUrl}
              onChangeText={setEditGithubUrl}
              placeholder="https://github.com/..."
              placeholderTextColor={colors.gray600}
              autoCapitalize="none"
              keyboardType="url"
            />

            {/* Save button */}
            <TouchableOpacity
              style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
              onPress={handleSaveCard}
              disabled={saving}
            >
              <Text style={styles.saveBtnText}>{saving ? 'Saving...' : 'Save'}</Text>
            </TouchableOpacity>

            {/* Comments */}
            <Text style={[styles.fieldLabel, { marginTop: 20 }]}>Comments</Text>
            {comments.length === 0 && (
              <Text style={styles.noComments}>No comments yet</Text>
            )}
            {comments.map((c, i) => (
              <View key={c.id || i} style={styles.commentItem}>
                <Text style={styles.commentAuthor}>{c.author || 'Anonymous'}</Text>
                <Text style={styles.commentText}>{c.content}</Text>
                {c.created_at && (
                  <Text style={styles.commentTime}>{new Date(c.created_at).toLocaleString()}</Text>
                )}
              </View>
            ))}

            {/* Add comment */}
            <View style={styles.addCommentRow}>
              <TextInput
                style={[styles.fieldInput, { flex: 1 }]}
                value={newComment}
                onChangeText={setNewComment}
                placeholder="Add a comment..."
                placeholderTextColor={colors.gray600}
              />
              <TouchableOpacity
                style={[styles.commentSendBtn, !newComment.trim() && styles.commentSendBtnDisabled]}
                onPress={handleAddComment}
                disabled={!newComment.trim()}
              >
                <Text style={styles.commentSendText}>{'\u2191'}</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>

        {/* Assignee picker for linking card to an agent */}
        <Modal
          visible={showAssigneePicker}
          transparent
          animationType="fade"
          onRequestClose={() => setShowAssigneePicker(false)}
        >
          <TouchableOpacity
            style={styles.modalOverlay}
            activeOpacity={1}
            onPress={() => setShowAssigneePicker(false)}
          >
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>Assign agent</Text>
              <ScrollView style={{ maxHeight: 320 }}>
                {buildAssigneeOptions(projectAgents).map((opt) => (
                  <TouchableOpacity
                    key={opt.id || '__unassigned__'}
                    style={styles.modalOption}
                    onPress={() => handleSelectAssignee(opt.id ? opt.name : '')}
                  >
                    <View
                      style={[
                        styles.modalOptionDot,
                        { backgroundColor: opt.id ? colors.blue500 : colors.gray600 },
                      ]}
                    />
                    <Text style={styles.modalOptionText}>{opt.name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={() => setShowAssigneePicker(false)}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </Modal>

        <Modal
          visible={showAssignEnginePicker}
          transparent
          animationType="fade"
          onRequestClose={() => setShowAssignEnginePicker(false)}
        >
          <TouchableOpacity
            style={styles.modalOverlay}
            activeOpacity={1}
            onPress={() => setShowAssignEnginePicker(false)}
          >
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>Session engine</Text>
              <ScrollView style={{ maxHeight: 320 }}>
                <TouchableOpacity
                  style={styles.modalOption}
                  onPress={() => handleSelectAssignEngine('')}
                  testID="card-assign-engine-option-default"
                >
                  <View style={[styles.modalOptionDot, { backgroundColor: colors.gray600 }]} />
                  <Text style={styles.modalOptionText}>
                    {`Agent default (${findAgentByName(agents, editAssignee)?.engine || 'claude-code'})`}
                  </Text>
                </TouchableOpacity>
                {engineEntriesWithModels(modelConfig).map((eng) => (
                  <TouchableOpacity
                    key={eng}
                    style={styles.modalOption}
                    onPress={() => handleSelectAssignEngine(eng)}
                    testID={`card-assign-engine-option-${eng}`}
                  >
                    <View style={[styles.modalOptionDot, { backgroundColor: colors.blue500 }]} />
                    <Text style={styles.modalOptionText}>{eng}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={() => setShowAssignEnginePicker(false)}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </Modal>

        <Modal
          visible={showAssignModelPicker}
          transparent
          animationType="fade"
          onRequestClose={() => setShowAssignModelPicker(false)}
        >
          <TouchableOpacity
            style={styles.modalOverlay}
            activeOpacity={1}
            onPress={() => setShowAssignModelPicker(false)}
          >
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>Session model</Text>
              <ScrollView style={{ maxHeight: 320 }}>
                <TouchableOpacity
                  style={styles.modalOption}
                  onPress={() => handleSelectAssignModel('')}
                >
                  <View style={[styles.modalOptionDot, { backgroundColor: colors.gray600 }]} />
                  <Text style={styles.modalOptionText}>Agent default</Text>
                </TouchableOpacity>
                {validModelsForAgent(agents, modelConfig, editAssignee, editAssignEngine).map((m) => (
                  <TouchableOpacity
                    key={m}
                    style={styles.modalOption}
                    onPress={() => handleSelectAssignModel(m)}
                  >
                    <View style={[styles.modalOptionDot, { backgroundColor: colors.blue500 }]} />
                    <Text style={styles.modalOptionText}>{m}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={() => setShowAssignModelPicker(false)}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </Modal>

        {/* Blocker picker */}
        <Modal
          visible={showBlockerPicker}
          transparent
          animationType="fade"
          onRequestClose={() => setShowBlockerPicker(false)}
        >
          <TouchableOpacity
            style={styles.modalOverlay}
            activeOpacity={1}
            onPress={() => setShowBlockerPicker(false)}
          >
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>Add blocker</Text>
              <TextInput
                style={styles.fieldInput}
                value={blockerPickerQuery}
                onChangeText={setBlockerPickerQuery}
                placeholder="Search cards..."
                placeholderTextColor={colors.gray600}
                autoFocus
              />
              <ScrollView style={{ maxHeight: 320, marginTop: 8 }}>
                {(() => {
                  const q = (blockerPickerQuery || '').toLowerCase().trim();
                  const excluded = new Set([
                    selectedCard?.id,
                    ...((selectedCard?.blockers) || []).map((b) => b.id),
                  ]);
                  const options = (board?.cards || [])
                    .filter((c) => !excluded.has(c.id))
                    .filter((c) => !q || (c.title || '').toLowerCase().includes(q))
                    .slice(0, 40);
                  if (options.length === 0) {
                    return <Text style={styles.blockerEmpty}>No matching cards</Text>;
                  }
                  return options.map((c) => (
                    <TouchableOpacity
                      key={c.id}
                      style={styles.modalOption}
                      onPress={() => handleAddBlocker(c.id)}
                    >
                      <Text style={styles.modalOptionText} numberOfLines={1}>
                        {c.title}
                      </Text>
                    </TouchableOpacity>
                  ));
                })()}
              </ScrollView>
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={() => setShowBlockerPicker(false)}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </Modal>

        {/* Epic picker for linking card to epic */}
        <Modal
          visible={showEpicPickerForCard}
          transparent
          animationType="fade"
          onRequestClose={() => setShowEpicPickerForCard(false)}
        >
          <TouchableOpacity
            style={styles.modalOverlay}
            activeOpacity={1}
            onPress={() => setShowEpicPickerForCard(false)}
          >
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>Link to epic</Text>
              <ScrollView style={{ maxHeight: 320 }}>
                <TouchableOpacity
                  style={styles.modalOption}
                  onPress={() => handleLinkCardEpic(null)}
                >
                  <View style={[styles.modalOptionDot, { backgroundColor: colors.gray600 }]} />
                  <Text style={styles.modalOptionText}>None</Text>
                </TouchableOpacity>
                {epics.map((epic) => (
                  <TouchableOpacity
                    key={epic.id}
                    style={styles.modalOption}
                    onPress={() => handleLinkCardEpic(epic.id)}
                  >
                    <View style={[styles.modalOptionDot, { backgroundColor: epic.color || DEFAULT_EPIC_COLOR }]} />
                    <Text style={styles.modalOptionText}>{epicDropdownLabel(epic)}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={() => setShowEpicPickerForCard(false)}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </Modal>
      </SafeAreaView>
    );
  }

  const currentCards = cardsForColumn(activeColumn);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* TopBar */}
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => openSidebar()} style={styles.menuButton}>
          <Text style={styles.menuIcon}>{'\u2630'}</Text>
        </TouchableOpacity>
        <Text style={styles.topBarTitle} numberOfLines={1}>
          {project?.name || 'Project'} Board
        </Text>
      </View>

      {/* Epic Filter Bar */}
      <View style={styles.epicBar}>
        <TouchableOpacity
          style={styles.epicFilterBtn}
          onPress={() => setShowEpicFilterModal(true)}
        >
          {selectedEpic ? (
            <>
              <View style={[styles.epicDot, { backgroundColor: selectedEpic.color || DEFAULT_EPIC_COLOR }]} />
              <Text style={styles.epicFilterText} numberOfLines={1}>
                {epicDropdownLabel(selectedEpic)}
              </Text>
            </>
          ) : (
            <Text style={styles.epicFilterText}>All Epics ({epics.length})</Text>
          )}
          <Text style={styles.epicPickerChevron}>{'\u25BE'}</Text>
        </TouchableOpacity>

        {selectedEpic && (
          <TouchableOpacity
            style={styles.epicEditBtn}
            onPress={() => openEpicEdit(selectedEpic)}
          >
            <Text style={styles.epicEditText}>Edit</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={styles.epicNewBtn} onPress={openEpicCreate}>
          <Text style={styles.epicNewBtnText}>+ Epic</Text>
        </TouchableOpacity>
      </View>

      {/* Column Tabs */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabBar} contentContainerStyle={styles.tabBarContent}>
        {columns.map((col) => {
          const count = cardsForColumn(col.id).length;
          const isActive = activeColumn === col.id;
          return (
            <TouchableOpacity
              key={col.id}
              style={[styles.tab, isActive && { borderBottomColor: col.color }]}
              onPress={() => setActiveColumn(col.id)}
            >
              <Text style={[styles.tabText, isActive && styles.tabTextActive]}>
                {col.name}
              </Text>
              {count > 0 && (
                <View style={[styles.tabBadge, { backgroundColor: isActive ? col.color : colors.gray700 }]}>
                  <Text style={styles.tabBadgeText}>{count}</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Cards */}
      <ScrollView style={styles.cardList} contentContainerStyle={styles.cardListContent}>
        {currentCards.length === 0 && (
          <View style={styles.emptyCol}>
            <Text style={styles.emptyColText}>No cards in {activeColumnObj?.name || 'this column'}</Text>
          </View>
        )}
        {currentCards.map((card) => (
          <TouchableOpacity
            key={card.id}
            style={styles.card}
            onPress={() => handleOpenDetail(card)}
            onLongPress={() => handleLongPressCard(card)}
            activeOpacity={0.7}
          >
            <Text style={styles.cardTitle}>{card.title}</Text>
            <View style={styles.cardMeta}>
              <View style={[styles.priorityDotSmall, { backgroundColor: getPriorityColor(card.priority) }]} />
              <Text style={[styles.cardPriorityText, { color: getPriorityColor(card.priority) }]}>
                {getPriorityLabel(card.priority)}
              </Text>
              {hasUnresolvedBlockers(card) && (
                <View style={styles.blockerBadge} testID="card-blocker-badge">
                  <Text style={styles.blockerBadgeText}>
                    {'Lock '}{card.blockers.filter((b) => !b.done).length}
                  </Text>
                </View>
              )}
              {card.assignee ? (
                <Text style={styles.cardAssignee} numberOfLines={1}>{card.assignee}</Text>
              ) : null}
            </View>
            {card.epic_id && (() => {
              const cardEpic = findEpic(epics, card.epic_id);
              if (!cardEpic) return null;
              return (
                <View style={styles.cardEpicRow}>
                  <View style={[styles.epicDot, { backgroundColor: cardEpic.color || DEFAULT_EPIC_COLOR }]} />
                  <Text
                    style={[styles.cardEpicText, { color: cardEpic.color || DEFAULT_EPIC_COLOR }]}
                    numberOfLines={1}
                  >
                    {epicDropdownLabel(cardEpic)}
                  </Text>
                </View>
              );
            })()}
            {card.labels && (typeof card.labels === 'string' ? card.labels : '').length > 0 && (
              <View style={styles.labelsRow}>
                {(typeof card.labels === 'string' ? card.labels.split(',').map(l => l.trim()).filter(Boolean) : card.labels).map((label, i) => (
                  <View key={i} style={styles.labelChip}>
                    <Text style={styles.labelChipText}>{label}</Text>
                  </View>
                ))}
              </View>
            )}
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Add Card FAB */}
      {!showAddCard && (
        <TouchableOpacity style={styles.fab} onPress={() => setShowAddCard(true)}>
          <Text style={styles.fabText}>+</Text>
        </TouchableOpacity>
      )}

      {/* Add Card Inline Form */}
      {showAddCard && (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
          <View style={styles.addCardForm}>
            <TextInput
              style={styles.addCardInput}
              value={newCardTitle}
              onChangeText={setNewCardTitle}
              placeholder="Card title..."
              placeholderTextColor={colors.gray600}
              autoFocus
            />
            <View style={styles.addCardPriorityRow}>
              {PRIORITY_OPTIONS.map((p) => (
                <TouchableOpacity
                  key={p.value}
                  style={[
                    styles.addCardPriorityBtn,
                    newCardPriority === p.value && { backgroundColor: p.color + '33', borderColor: p.color },
                  ]}
                  onPress={() => setNewCardPriority(p.value)}
                >
                  <View style={[styles.priorityDotSmall, { backgroundColor: p.color }]} />
                  <Text style={[styles.addCardPriorityText, newCardPriority === p.value && { color: colors.white }]}>
                    {p.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.addCardActions}>
              <TouchableOpacity style={styles.addCardCancel} onPress={() => { setShowAddCard(false); setNewCardTitle(''); }}>
                <Text style={styles.addCardCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.addCardCreate, (!newCardTitle.trim() || saving) && styles.addCardCreateDisabled]}
                onPress={handleCreateCard}
                disabled={!newCardTitle.trim() || saving}
              >
                <Text style={styles.addCardCreateText}>{saving ? 'Creating...' : 'Create'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      )}

      {/* Move Card Modal */}
      <Modal visible={showMoveModal} transparent animationType="fade" onRequestClose={() => setShowMoveModal(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setShowMoveModal(false)}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Move to column</Text>
            {columns
              .filter((c) => c.id !== moveCardTarget?.column_id)
              .map((col) => (
                <TouchableOpacity key={col.id} style={styles.modalOption} onPress={() => handleMoveCard(col.id)}>
                  <View style={[styles.modalOptionDot, { backgroundColor: col.color }]} />
                  <Text style={styles.modalOptionText}>{col.name}</Text>
                </TouchableOpacity>
              ))}
            <TouchableOpacity style={styles.modalCancel} onPress={() => setShowMoveModal(false)}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Epic Filter Modal */}
      <Modal
        visible={showEpicFilterModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowEpicFilterModal(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowEpicFilterModal(false)}
        >
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Filter by epic</Text>
            <ScrollView style={{ maxHeight: 360 }}>
              <TouchableOpacity
                style={styles.modalOption}
                onPress={() => {
                  setSelectedEpicId(null);
                  setShowEpicFilterModal(false);
                }}
              >
                <View style={[styles.modalOptionDot, { backgroundColor: colors.gray600 }]} />
                <Text style={styles.modalOptionText}>All Epics ({epics.length})</Text>
              </TouchableOpacity>
              {epics.map((epic) => {
                const count = countOpenCardsForEpic(board?.cards, epic.id, doneColumnIds);
                return (
                  <TouchableOpacity
                    key={epic.id}
                    style={styles.modalOption}
                    onPress={() => {
                      setSelectedEpicId(epic.id);
                      setShowEpicFilterModal(false);
                    }}
                  >
                    <View style={[styles.modalOptionDot, { backgroundColor: epic.color || DEFAULT_EPIC_COLOR }]} />
                    <Text style={[styles.modalOptionText, { flex: 1 }]} numberOfLines={1}>
                      {epicDropdownLabel(epic)}
                    </Text>
                    {count > 0 && (
                      <View style={styles.epicCountBadge}>
                        <Text style={styles.epicCountBadgeText}>{count}</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity
              style={styles.modalCancel}
              onPress={() => setShowEpicFilterModal(false)}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Epic Create/Edit Modal */}
      <Modal
        visible={showEpicManager}
        transparent
        animationType="fade"
        onRequestClose={() => setShowEpicManager(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={[styles.modalContent, { width: 320 }]}>
            <ScrollView>
              <Text style={styles.modalTitle}>
                {editingEpic ? 'Edit Epic' : 'New Epic'}
              </Text>

              <Text style={styles.fieldLabel}>Name</Text>
              <TextInput
                style={styles.fieldInput}
                value={epicForm.name}
                onChangeText={(v) => setEpicForm((f) => ({ ...f, name: v }))}
                placeholder="Epic name..."
                placeholderTextColor={colors.gray600}
                autoFocus
              />

              <Text style={styles.fieldLabel}>Description</Text>
              <TextInput
                style={[styles.fieldInput, { minHeight: 60, textAlignVertical: 'top' }]}
                value={epicForm.description}
                onChangeText={(v) => setEpicForm((f) => ({ ...f, description: v }))}
                placeholder="Short description (optional)"
                placeholderTextColor={colors.gray600}
                multiline
              />

              <Text style={styles.fieldLabel}>PR base branch (optional)</Text>
              <TextInput
                style={styles.fieldInput}
                value={epicForm.pr_base_branch ?? ''}
                onChangeText={(v) => setEpicForm((f) => ({ ...f, pr_base_branch: v }))}
                placeholder="e.g. feature/epic-integration"
                placeholderTextColor={colors.gray600}
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Text style={styles.fieldLabel}>Color</Text>
              <View style={styles.colorRow}>
                {EPIC_COLORS.map((c) => (
                  <TouchableOpacity
                    key={c}
                    onPress={() => setEpicForm((f) => ({ ...f, color: c }))}
                    style={[
                      styles.colorSwatch,
                      { backgroundColor: c },
                      epicForm.color === c && styles.colorSwatchActive,
                    ]}
                  />
                ))}
              </View>

              {/* Autonomous — edit only (mirrors web) */}
              {editingEpic && (
                <>
                  <View style={styles.autonomousModeCard}>
                    <View style={{ flex: 1, paddingRight: 8 }}>
                      <Text style={styles.autonomousModeTitle}>Autonomous mode</Text>
                      <Text style={styles.autonomousModeHint}>
                        Automatically assign backlog cards in this epic when agent slots are free.
                      </Text>
                    </View>
                    <Switch
                      value={epicForm.autonomous === 1}
                      onValueChange={(on) =>
                        setEpicForm((f) => ({ ...f, autonomous: on ? 1 : 0 }))
                      }
                      trackColor={{ false: colors.gray600, true: '#059669' }}
                      thumbColor={Platform.OS === 'android' ? colors.white : undefined}
                      ios_backgroundColor={colors.gray600}
                    />
                  </View>

                  {epicForm.autonomous === 1 && (
                    <View style={styles.autonomousSettings}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.autonomousSettingLabel}>Max concurrent</Text>
                        <TextInput
                          style={styles.fieldInput}
                          value={String(epicForm.autonomous_max_concurrent)}
                          onChangeText={(v) =>
                            setEpicForm((f) => ({
                              ...f,
                              autonomous_max_concurrent: parseInt(v, 10) || 2,
                            }))
                          }
                          keyboardType="number-pad"
                        />
                      </View>
                    </View>
                  )}
                  {epicForm.autonomous === 1 && (
                    <View style={{ marginTop: 10 }}>
                      <Text style={styles.autonomousSettingLabel}>Session model</Text>
                      <TouchableOpacity
                        style={styles.fieldInput}
                        onPress={() => setShowAutonomousModelModal(true)}
                      >
                        <Text style={{ fontSize: 13, color: colors.gray200 }} numberOfLines={1}>
                          {epicForm.autonomous_model
                            ? epicForm.autonomous_model
                            : "Each agent's default"}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  )}
                  {epicForm.autonomous === 1 && (
                    <View style={[styles.autonomousModeCard, { marginTop: 10 }]}>
                      <View style={{ flex: 1, paddingRight: 8 }}>
                        <Text style={styles.autonomousModeTitle}>Auto Merge</Text>
                        <Text style={styles.autonomousModeHint}>
                          Start each dispatched session with auto-merge enabled (Finalize "Send
                          It"), even when the project's auto-merge is off.
                        </Text>
                      </View>
                      <Switch
                        value={epicForm.autonomous_send_it === 1}
                        onValueChange={(on) =>
                          setEpicForm((f) => ({ ...f, autonomous_send_it: on ? 1 : 0 }))
                        }
                        trackColor={{ false: colors.gray600, true: '#059669' }}
                        thumbColor={Platform.OS === 'android' ? colors.white : undefined}
                        ios_backgroundColor={colors.gray600}
                      />
                    </View>
                  )}
                </>
              )}

              <View style={styles.epicModalActions}>
                <TouchableOpacity
                  style={styles.addCardCancel}
                  onPress={() => {
                    setShowEpicManager(false);
                    setEditingEpic(null);
                    setEpicForm(DEFAULT_EPIC_FORM);
                  }}
                >
                  <Text style={styles.addCardCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.addCardCreate,
                    (epicSaving || !epicForm.name.trim()) && styles.addCardCreateDisabled,
                  ]}
                  onPress={handleSaveEpic}
                  disabled={epicSaving || !epicForm.name.trim()}
                >
                  <Text style={styles.addCardCreateText}>
                    {epicSaving ? 'Saving...' : editingEpic ? 'Save' : 'Create'}
                  </Text>
                </TouchableOpacity>
              </View>

              {editingEpic && (
                <TouchableOpacity
                  style={styles.deleteEpicBtn}
                  onPress={handleDeleteEpic}
                >
                  <Text style={styles.deleteEpicBtnText}>Delete Epic</Text>
                </TouchableOpacity>
              )}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={showAutonomousModelModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAutonomousModelModal(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowAutonomousModelModal(false)}
        >
          <View style={[styles.modalContent, { width: 300, maxHeight: 420 }]}>
            <Text style={styles.modalTitle}>Autonomous session model</Text>
            <ScrollView style={{ maxHeight: 340 }}>
              <TouchableOpacity
                style={styles.modalOption}
                onPress={() => {
                  setEpicForm((f) => ({ ...f, autonomous_model: '' }));
                  setShowAutonomousModelModal(false);
                }}
              >
                <Text style={styles.modalOptionText}>Each agent's default</Text>
              </TouchableOpacity>
              {autonomousModelOptions.map((m) => (
                <TouchableOpacity
                  key={m}
                  style={styles.modalOption}
                  onPress={() => {
                    setEpicForm((f) => ({ ...f, autonomous_model: m }));
                    setShowAutonomousModelModal(false);
                  }}
                >
                  <Text style={styles.modalOptionText} numberOfLines={2}>
                    {m}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity
              style={styles.modalCancel}
              onPress={() => setShowAutonomousModelModal(false)}
            >
              <Text style={styles.modalCancelText}>Close</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray950 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  topBar: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: colors.gray800, gap: 8,
  },
  menuButton: { padding: 4 },
  menuIcon: { fontSize: 20, color: colors.gray400 },
  backArrow: { fontSize: 20, color: colors.gray400 },
  topBarTitle: { flex: 1, fontSize: 16, fontWeight: '600', color: colors.white },
  deleteBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: colors.red600 },
  deleteBtnText: { fontSize: 12, color: colors.white, fontWeight: '500' },

  // Tabs
  tabBar: { maxHeight: 48, borderBottomWidth: 1, borderBottomColor: colors.gray800 },
  tabBarContent: { paddingHorizontal: 8, alignItems: 'flex-end' },
  tab: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 12,
    borderBottomWidth: 2, borderBottomColor: 'transparent',
  },
  tabText: { fontSize: 13, color: colors.gray500, fontWeight: '500' },
  tabTextActive: { color: colors.white },
  tabBadge: { minWidth: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  tabBadgeText: { fontSize: 10, color: colors.white, fontWeight: '600' },

  // Cards list
  cardList: { flex: 1 },
  cardListContent: { padding: 12, paddingBottom: 80 },
  emptyCol: { paddingVertical: 40, alignItems: 'center' },
  emptyColText: { fontSize: 14, color: colors.gray600 },

  // Card item
  card: {
    backgroundColor: colors.gray800, borderRadius: 10, borderWidth: 1, borderColor: colors.gray700,
    padding: 12, marginBottom: 10,
  },
  cardTitle: { fontSize: 15, fontWeight: '600', color: colors.white, marginBottom: 6 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  priorityDotSmall: { width: 8, height: 8, borderRadius: 4 },
  cardPriorityText: { fontSize: 12, fontWeight: '500' },
  cardAssignee: { fontSize: 12, color: colors.gray400, marginLeft: 'auto' },
  labelsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  labelChip: {
    backgroundColor: colors.gray700, borderRadius: 10,
    paddingHorizontal: 8, paddingVertical: 2,
  },
  labelChipText: { fontSize: 11, color: colors.gray300 },

  // FAB
  fab: {
    position: 'absolute', bottom: 24, right: 20,
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: colors.blue600, alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 6,
    elevation: 8,
  },
  fabText: { fontSize: 28, color: colors.white, fontWeight: '300', marginTop: -2 },

  // Add card form
  addCardForm: {
    backgroundColor: colors.gray900, borderTopWidth: 1, borderTopColor: colors.gray800,
    padding: 12,
  },
  addCardInput: {
    backgroundColor: colors.gray800, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10,
    color: colors.white, fontSize: 14, marginBottom: 8,
  },
  addCardPriorityRow: { flexDirection: 'row', gap: 6, marginBottom: 10 },
  addCardPriorityBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6,
    borderWidth: 1, borderColor: colors.gray700, backgroundColor: colors.gray800,
  },
  addCardPriorityText: { fontSize: 11, color: colors.gray400 },
  addCardActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  addCardCancel: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 },
  addCardCancelText: { fontSize: 13, color: colors.gray400 },
  addCardCreate: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6, backgroundColor: colors.blue600 },
  addCardCreateDisabled: { backgroundColor: colors.gray700 },
  addCardCreateText: { fontSize: 13, color: colors.white, fontWeight: '500' },

  // Detail view
  detailScroll: { flex: 1 },
  detailContent: { padding: 16, paddingBottom: 40 },
  fieldLabel: { fontSize: 12, fontWeight: '600', color: colors.gray400, marginBottom: 6, marginTop: 12 },
  fieldInput: {
    backgroundColor: colors.gray800, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10,
    color: colors.white, fontSize: 14, borderWidth: 1, borderColor: colors.gray700,
  },
  multilineInput: { minHeight: 80, textAlignVertical: 'top' },
  priorityRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  priorityBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6,
    borderWidth: 1, borderColor: colors.gray700, backgroundColor: colors.gray800,
  },
  priorityDot: { width: 10, height: 10, borderRadius: 5 },
  priorityBtnText: { fontSize: 13, color: colors.gray400 },
  saveBtn: {
    marginTop: 16, backgroundColor: colors.blue600, borderRadius: 8,
    paddingVertical: 12, alignItems: 'center',
  },
  saveBtnDisabled: { backgroundColor: colors.gray700 },
  saveBtnText: { fontSize: 14, color: colors.white, fontWeight: '600' },

  // Comments
  noComments: { fontSize: 13, color: colors.gray600, marginBottom: 8 },
  commentItem: {
    backgroundColor: colors.gray800, borderRadius: 8, padding: 10, marginBottom: 6,
  },
  commentAuthor: { fontSize: 12, fontWeight: '600', color: colors.gray300, marginBottom: 2 },
  commentText: { fontSize: 13, color: colors.gray200 },
  commentTime: { fontSize: 10, color: colors.gray600, marginTop: 4 },
  addCommentRow: { flexDirection: 'row', gap: 8, marginTop: 8, alignItems: 'flex-end' },
  commentSendBtn: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: colors.blue600,
    alignItems: 'center', justifyContent: 'center',
  },
  commentSendBtnDisabled: { backgroundColor: colors.gray700 },
  commentSendText: { color: colors.white, fontSize: 18, fontWeight: 'bold' },

  // Move modal
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center',
  },
  modalContent: {
    backgroundColor: colors.gray800, borderRadius: 12, padding: 16, width: 280,
    borderWidth: 1, borderColor: colors.gray700,
  },
  modalTitle: { fontSize: 16, fontWeight: '600', color: colors.white, marginBottom: 12 },
  modalOption: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.gray700,
  },
  modalOptionDot: { width: 12, height: 12, borderRadius: 6 },
  modalOptionText: { fontSize: 14, color: colors.gray200 },
  modalCancel: { paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  modalCancelText: { fontSize: 14, color: colors.gray500 },

  // Epic filter bar
  epicBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: colors.gray800,
  },
  epicFilterBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.gray800, borderWidth: 1, borderColor: colors.gray700,
    paddingHorizontal: 10, paddingVertical: 7, borderRadius: 6,
  },
  epicFilterText: { flex: 1, fontSize: 13, color: colors.gray200 },
  epicDot: { width: 10, height: 10, borderRadius: 5 },
  epicEditBtn: {
    paddingHorizontal: 10, paddingVertical: 7, borderRadius: 6,
    borderWidth: 1, borderColor: colors.gray700, backgroundColor: colors.gray800,
  },
  epicEditText: { fontSize: 12, color: colors.gray300 },
  epicNewBtn: {
    paddingHorizontal: 10, paddingVertical: 7, borderRadius: 6,
    backgroundColor: colors.blue600,
  },
  epicNewBtnText: { fontSize: 12, color: colors.white, fontWeight: '500' },

  // Card epic chip
  cardEpicRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4 },
  cardEpicText: { fontSize: 11, fontWeight: '500' },

  // Epic picker (card detail)
  epicPickerBtn: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.gray800, borderWidth: 1, borderColor: colors.gray700,
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8,
  },
  epicPickerRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  epicPickerText: { flex: 1, fontSize: 14, color: colors.white },
  epicPickerPlaceholder: { flex: 1, fontSize: 14, color: colors.gray500 },
  epicPickerChevron: { fontSize: 12, color: colors.gray500, marginLeft: 6 },

  // Count badge on filter modal rows
  epicCountBadge: {
    minWidth: 22, height: 18, borderRadius: 9, paddingHorizontal: 6,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.gray700,
  },
  epicCountBadgeText: { fontSize: 11, color: colors.gray200, fontWeight: '600' },

  // Epic modal color picker
  colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  colorSwatch: {
    width: 28, height: 28, borderRadius: 14,
    borderWidth: 2, borderColor: 'transparent',
  },
  colorSwatchActive: { borderColor: colors.white, transform: [{ scale: 1.1 }] },

  // Assignee / agent assignment
  assigneeActiveRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap',
    marginBottom: 8,
  },
  assigneeActiveName: { fontSize: 14, color: colors.white, fontWeight: '500' },
  sessionActiveBadge: {
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6,
    backgroundColor: 'rgba(16,185,129,0.2)',
  },
  sessionActiveBadgeText: { fontSize: 11, color: '#6ee7b7', fontWeight: '500' },
  openSessionBtn: {
    backgroundColor: colors.blue600, borderRadius: 8,
    paddingVertical: 10, alignItems: 'center',
  },
  openSessionBtnText: { fontSize: 13, color: colors.white, fontWeight: '600' },
  reassignBtn: {
    marginTop: 8, paddingVertical: 10, alignItems: 'center',
    borderRadius: 8, borderWidth: 1, borderColor: colors.gray700,
    backgroundColor: colors.gray800,
  },
  reassignBtnText: { fontSize: 13, color: colors.gray200 },
  assignStartBtn: {
    marginTop: 8, backgroundColor: colors.blue600, borderRadius: 8,
    paddingVertical: 10, alignItems: 'center',
  },
  assignStartBtnDisabled: { backgroundColor: colors.gray700 },
  assignStartBtnText: { fontSize: 13, color: colors.white, fontWeight: '600' },

  // Epic autonomous block
  autonomousModeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: colors.gray800,
    borderWidth: 1,
    borderColor: colors.gray700,
  },
  autonomousModeTitle: { fontSize: 14, fontWeight: '600', color: colors.gray200 },
  autonomousModeHint: {
    fontSize: 11,
    color: colors.gray500,
    marginTop: 4,
    lineHeight: 15,
  },
  autonomousSettings: { flexDirection: 'row', gap: 10, marginTop: 8 },
  autonomousSettingLabel: { fontSize: 11, color: colors.gray500, marginBottom: 4 },

  // Epic modal actions
  epicModalActions: {
    flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 16,
  },
  deleteEpicBtn: {
    marginTop: 12, paddingVertical: 10, alignItems: 'center',
    borderRadius: 6, backgroundColor: colors.red600,
  },
  deleteEpicBtnText: { fontSize: 13, color: colors.white, fontWeight: '500' },

  // Blockers
  blockerBadge: {
    backgroundColor: 'rgba(185, 28, 28, 0.35)',
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 1,
    marginLeft: 4,
  },
  blockerBadgeText: { color: '#FCA5A5', fontSize: 11, fontWeight: '500' },
  blockerBanner: {
    backgroundColor: 'rgba(127, 29, 29, 0.3)',
    borderColor: '#991B1B',
    borderWidth: 1,
    borderRadius: 6,
    padding: 8,
    marginTop: 12,
  },
  blockerBannerText: { color: '#FCA5A5', fontSize: 12 },
  blockerHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  blockerAddBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: colors.gray800,
  },
  blockerAddBtnText: { color: colors.gray300, fontSize: 12 },
  blockerEmpty: { color: colors.gray600, fontSize: 12, marginTop: 4 },
  blockerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.gray800,
    borderLeftWidth: 2,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginTop: 4,
  },
  blockerRowOpen: { borderLeftColor: '#B91C1C' },
  blockerRowDone: { borderLeftColor: '#065F46', opacity: 0.7 },
  blockerRowText: { flex: 1, color: colors.gray300, fontSize: 12 },
  blockerRowTextDone: { color: colors.gray500 },
  blockerRemoveBtn: { paddingHorizontal: 6, paddingVertical: 2 },
  blockerRemoveBtnText: { color: colors.gray500, fontSize: 12 },
});
