import React, { useState, useEffect, useCallback, useContext, useRef } from 'react';
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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../context/AppContext';
import { SidebarContext } from '../context/SidebarContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';

const DEFAULT_COLUMNS = [
  { id: 'backlog', name: 'Backlog', color: '#6B7280' },
  { id: 'todo', name: 'To Do', color: '#3B82F6' },
  { id: 'in-progress', name: 'In Progress', color: '#F59E0B' },
  { id: 'review', name: 'Review', color: '#8B5CF6' },
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

export default function KanbanScreen({ route }) {
  const { projectId, project } = route.params || {};
  const { agents, kanbanRefreshKey } = useApp();
  const { openSidebar } = useContext(SidebarContext);

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

  const columns = board?.columns || DEFAULT_COLUMNS;
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

  const cardsForColumn = (columnId) => {
    if (!board?.cards) return [];
    return board.cards
      .filter((c) => c.column_id === columnId)
      .sort((a, b) => (a.position || 0) - (b.position || 0));
  };

  const activeColumnObj = columns.find((c) => c.id === activeColumn) || columns[0];

  const handleCreateCard = async () => {
    if (!newCardTitle.trim()) return;
    setSaving(true);
    try {
      await api.createKanbanCard(projectId, {
        title: newCardTitle.trim(),
        priority: newCardPriority,
        columnId: activeColumn,
      });
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
    setEditLabels(typeof card.labels === 'string' ? card.labels : (card.labels || []).join(', '));
    setEditGithubUrl(card.github_issue_url || '');
    // Load comments
    try {
      const data = await api.getCardComments(projectId, card.id);
      setComments(data || []);
    } catch {
      setComments([]);
    }
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

  const handleMoveCard = async (targetColumn) => {
    if (!moveCardTarget) return;
    try {
      await api.moveKanbanCard(projectId, moveCardTarget.id, { columnId: targetColumn });
      setShowMoveModal(false);
      setMoveCardTarget(null);
      await loadBoard();
    } catch {
      Alert.alert('Error', 'Failed to move card');
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
            <TextInput
              style={styles.fieldInput}
              value={editAssignee}
              onChangeText={setEditAssignee}
              placeholder="Assignee name"
              placeholderTextColor={colors.gray600}
            />

            {/* Labels */}
            <Text style={styles.fieldLabel}>Labels (comma separated)</Text>
            <TextInput
              style={styles.fieldInput}
              value={editLabels}
              onChangeText={setEditLabels}
              placeholder="bug, feature, ui"
              placeholderTextColor={colors.gray600}
            />

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
            <Text style={styles.cardTitle} numberOfLines={2}>{card.title}</Text>
            <View style={styles.cardMeta}>
              <View style={[styles.priorityDotSmall, { backgroundColor: getPriorityColor(card.priority) }]} />
              <Text style={[styles.cardPriorityText, { color: getPriorityColor(card.priority) }]}>
                {getPriorityLabel(card.priority)}
              </Text>
              {card.assignee ? (
                <Text style={styles.cardAssignee} numberOfLines={1}>{card.assignee}</Text>
              ) : null}
            </View>
            {card.labels && (typeof card.labels === 'string' ? card.labels : '').length > 0 && (
              <View style={styles.labelsRow}>
                {(typeof card.labels === 'string' ? card.labels.split(',').map(l => l.trim()).filter(Boolean) : card.labels).map((label, i) => (
                  <View key={i} style={styles.labelChip}>
                    <Text style={styles.labelChipText}>{label}</Text>
                  </View>
                ))}
              </View>
            )}
            {card.description ? (
              <Text style={styles.cardDesc} numberOfLines={2}>{card.description}</Text>
            ) : null}
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
  cardDesc: { fontSize: 13, color: colors.gray400, marginTop: 6, lineHeight: 18 },

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
});
