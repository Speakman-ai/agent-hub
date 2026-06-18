import React, { useState, useEffect, useCallback, useContext, useRef, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  FlatList,
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
  assignedSessionId,
} from '../utils/kanbanAssign';
import { hasUnresolvedBlockers, shouldConfirmMove } from '../utils/blockers';
import { cardMetaModel, priorityMeta, cardShareUrl, toggleLabelCsv } from '../utils/kanbanCard';
import { getServerBaseUrl } from '../utils/config';
import { buildCardActions } from '../utils/kanbanCardActions';
import { shortDate } from '../utils/time';
import { copyToClipboard } from '../utils/clipboard';
import {
  KANBAN_PAGE_SIZE,
  appendCardPage,
  pagingEntry,
  seedPagingFromBoard,
  loadedCountsByColumn,
  canLoadMore,
} from '../utils/kanbanPagination';

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

/**
 * Linear-style priority glyph (mirrors the web PriorityIcon). Urgent renders a
 * filled square; the other levels render an ascending three-bar signal with
 * `filled` bars lit.
 */
function PriorityGlyph({ priority }) {
  const meta = priorityMeta(priority);
  if (meta.value === 'urgent') {
    return (
      <View
        style={[styles.priUrgent, { backgroundColor: meta.color }]}
        testID="card-priority-icon"
      />
    );
  }
  const filled = meta.value === 'high' ? 3 : meta.value === 'low' ? 1 : 2;
  return (
    <View style={styles.priBars} testID="card-priority-icon">
      {[0, 1, 2].map((i) => (
        <View
          key={i}
          style={[
            styles.priBar,
            { height: 4 + i * 3, backgroundColor: i < filled ? meta.color : colors.gray700 },
          ]}
        />
      ))}
    </View>
  );
}

/**
 * Assignee avatar: initials over a stable hashed colour. A small dot + ring
 * marks an active linked session (mirrors the web CardAvatar).
 */
function CardAvatar({ initials, avatar, active }) {
  if (!initials) return null;
  return (
    <View
      style={[styles.avatar, { backgroundColor: avatar.bg }, active && styles.avatarActive]}
      testID="card-assignee-avatar"
    >
      <Text style={[styles.avatarText, { color: avatar.text }]}>{initials}</Text>
      {active && <View style={styles.avatarDot} />}
    </View>
  );
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
  // Cards loaded so far across all columns (grows as the active column pages).
  // Replaces the old `board.cards` (which held the entire board).
  const [cards, setCards] = useState([]);
  // Per-column keyset-pagination state, keyed by column id:
  //   { nextCursor, hasMore, loading, total }
  const [columnPaging, setColumnPaging] = useState({});
  const [showAddCard, setShowAddCard] = useState(false);
  const [newCardTitle, setNewCardTitle] = useState('');
  const [newCardPriority, setNewCardPriority] = useState('medium');
  const [selectedCard, setSelectedCard] = useState(null);
  // Long-press card action sheet. `actionCard` is the long-pressed card;
  // `actionSubmenu` is the selected top-level action whose options are shown in
  // the second sheet (null = showing the top-level action list).
  const [actionCard, setActionCard] = useState(null);
  const [actionSubmenu, setActionSubmenu] = useState(null);
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

  // Refs mirroring async-read state so the FlatList onEndReached callback and
  // the load-more / drain guards always see live values without re-binding on
  // every render. `inflightRef` is a synchronous double-fetch guard (state
  // updates are async, so a second onEndReached can fire before loading:true
  // commits).
  const cardsRef = useRef(cards);
  const columnPagingRef = useRef(columnPaging);
  const inflightRef = useRef(new Set());
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);
  useEffect(() => {
    columnPagingRef.current = columnPaging;
  }, [columnPaging]);

  // Load the board's first page per column (one `?limit=` request), then page
  // forward on any column the caller asks us to preserve a deeper scroll
  // position for (`preserveDepth[colId]` = cards previously loaded). Mirrors
  // the web client's loadBoardPaged so a background reconcile doesn't collapse
  // a column the user already scrolled.
  const loadBoardPaged = useCallback(
    async (preserveDepth) => {
      const data = await api.getProjectBoard(projectId, { limit: KANBAN_PAGE_SIZE });
      const cursors = data.cursors || {};
      const allCards = [...(data.cards || [])];
      const paging = seedPagingFromBoard({
        columns: data.columns,
        cards: allCards,
        cursors,
        counts: data.counts,
      });
      if (preserveDepth) {
        for (const col of data.columns || []) {
          let loaded = allCards.filter((c) => c.column_id === col.id).length;
          let nextCursor = paging[col.id]?.nextCursor ?? null;
          const want = preserveDepth[col.id] ?? 0;
          while (nextCursor && loaded < want) {
            const res = await api.getColumnCards(projectId, col.id, {
              cursor: nextCursor,
              limit: KANBAN_PAGE_SIZE,
            });
            const page = res.cards || [];
            if (page.length === 0) {
              nextCursor = null;
              break;
            }
            allCards.push(...page);
            loaded += page.length;
            nextCursor = res.nextCursor ?? null;
          }
          paging[col.id] = pagingEntry(nextCursor, paging[col.id]?.total, loaded);
        }
      }
      return { data, allCards, paging };
    },
    [projectId],
  );

  // Initial load / project switch: reset every column to its first page.
  const fetchBoard = useCallback(async () => {
    if (!projectId) return;
    try {
      const { data, allCards, paging } = await loadBoardPaged(null);
      setBoard(data);
      setCards(allCards);
      setColumnPaging(paging);
      if (data?.columns?.length > 0 && !columnInitialized.current) {
        setActiveColumn(data.columns[0].id);
        columnInitialized.current = true;
      }
    } catch (err) {
      console.error('Failed to load board:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId, loadBoardPaged]);

  // WS / refresh reconciliation. A `kanban_update` doesn't say which column
  // changed, so reload the first page of every column and re-page each one up
  // to its previously-loaded depth (counts, positions, cross-column moves all
  // re-resolve) without yanking the user back to the top of a scrolled column.
  const reconcileBoard = useCallback(async () => {
    if (!projectId) return;
    const preserve = loadedCountsByColumn(cardsRef.current);
    try {
      const { data, allCards, paging } = await loadBoardPaged(preserve);
      setBoard(data);
      setCards(allCards);
      setColumnPaging(paging);
    } catch (err) {
      console.error('Failed to reconcile board:', err);
    }
  }, [projectId, loadBoardPaged]);

  // Post-mutation refreshes (create / move / delete / assign) preserve each
  // column's scroll depth rather than collapsing back to the first page.
  const loadBoard = reconcileBoard;

  // Initial mount / project switch.
  useEffect(() => {
    fetchBoard();
  }, [fetchBoard]);

  // Reconcile on a `kanban_update` WS bump (skip the first run — fetchBoard
  // already covers the initial load).
  const firstRefreshRef = useRef(true);
  useEffect(() => {
    if (firstRefreshRef.current) {
      firstRefreshRef.current = false;
      return;
    }
    reconcileBoard();
  }, [kanbanRefreshKey, reconcileBoard]);

  // Append the next keyset page for one column. Guarded against double-fetch
  // (sync inflightRef) and against fetching past the end. Deduped by id so a
  // racing reconcile can't double-insert.
  const loadMoreColumn = useCallback(
    async (columnId) => {
      const entry = columnPagingRef.current[columnId];
      if (!canLoadMore(entry)) return;
      if (inflightRef.current.has(columnId)) return;
      inflightRef.current.add(columnId);
      setColumnPaging((prev) => ({
        ...prev,
        [columnId]: { ...prev[columnId], loading: true },
      }));
      try {
        const res = await api.getColumnCards(projectId, columnId, {
          cursor: entry.nextCursor,
          limit: KANBAN_PAGE_SIZE,
        });
        const page = res.cards || [];
        setCards((prev) => appendCardPage(prev, page));
        setColumnPaging((prev) => ({
          ...prev,
          [columnId]: pagingEntry(res.nextCursor, res.total ?? prev[columnId]?.total, 0),
        }));
      } catch (err) {
        console.error('Failed to load more cards:', err);
        setColumnPaging((prev) => ({
          ...prev,
          [columnId]: { ...prev[columnId], loading: false },
        }));
      } finally {
        inflightRef.current.delete(columnId);
      }
    },
    [projectId],
  );

  // Page a column all the way to its end. Used when an epic filter is active:
  // the filter runs client-side over loaded cards, so matches living past the
  // first page would be invisible unless the column is fully loaded.
  const drainColumn = useCallback(
    async (columnId) => {
      let cursor = columnPagingRef.current[columnId]?.nextCursor ?? null;
      if (!cursor) return;
      if (inflightRef.current.has(columnId)) return;
      inflightRef.current.add(columnId);
      setColumnPaging((prev) => ({
        ...prev,
        [columnId]: { ...prev[columnId], loading: true },
      }));
      try {
        const collected = [];
        let total;
        while (cursor) {
          const res = await api.getColumnCards(projectId, columnId, {
            cursor,
            limit: KANBAN_PAGE_SIZE,
          });
          const page = res.cards || [];
          collected.push(...page);
          total = res.total ?? total;
          cursor = page.length ? (res.nextCursor ?? null) : null;
        }
        if (collected.length) setCards((prev) => appendCardPage(prev, collected));
        setColumnPaging((prev) => ({
          ...prev,
          [columnId]: pagingEntry(null, total ?? prev[columnId]?.total, 0),
        }));
      } catch (err) {
        console.error('Failed to load remaining cards for filter:', err);
        setColumnPaging((prev) => ({
          ...prev,
          [columnId]: { ...prev[columnId], loading: false },
        }));
      } finally {
        inflightRef.current.delete(columnId);
      }
    },
    [projectId],
  );

  // Notification deep-link: open the target card once the board loads. The
  // card may live past the first loaded page, so fall back to a one-shot full
  // board fetch to locate it when it isn't in the loaded set.
  const deepLinkHandledRef = useRef(null);
  useEffect(() => {
    if (!deepLinkCardId || loading) return;
    if (deepLinkHandledRef.current === deepLinkCardId) return;
    let cancelled = false;
    const openCard = (card) => {
      if (!card || cancelled) return;
      deepLinkHandledRef.current = deepLinkCardId;
      setActiveColumn(card.column_id);
      setSelectedCard(card);
      setEditDescription(card.description || '');
      setEditPriority(card.priority || '');
      setEditAssignee(card.assignee || '');
      setEditLabels((card.labels || []).join(', '));
      setEditGithubUrl(card.github_url || '');
      setEditEpicId(card.epic_id || '');
    };
    const loaded = cards.find((c) => c.id === deepLinkCardId);
    if (loaded) {
      openCard(loaded);
      return undefined;
    }
    (async () => {
      try {
        const full = await api.getProjectBoard(projectId);
        const card = full?.cards?.find((c) => c.id === deepLinkCardId);
        openCard(card);
      } catch {
        // Best-effort deep link; ignore failures.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deepLinkCardId, loading, cards, projectId]);

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
    const scoped = filterCardsByEpic(cards, selectedEpicId);
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

  // Stable across renders (only state setters + projectId) so the memoized
  // FlatList renderCard never closes over a stale handler.
  const handleOpenDetail = useCallback(
    async (card) => {
      setSelectedCard(card);
      setEditDescription(card.description || '');
      setEditPriority(card.priority || 'medium');
      setEditAssignee(card.assignee || '');
      setEditAssignModel(card.assign_model || '');
      setEditAssignEngine(card.assign_engine || '');
      setEditLabels(
        typeof card.labels === 'string' ? card.labels : (card.labels || []).join(', '),
      );
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
    },
    [projectId],
  );

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

  // Long-press opens the card action sheet (mobile equivalent of the web
  // right-click CardContextMenu). Stable across renders (only state setters).
  const handleLongPressCard = useCallback((card) => {
    setActionCard(card);
    setActionSubmenu(null);
  }, []);

  const closeActionSheet = useCallback(() => {
    setActionCard(null);
    setActionSubmenu(null);
  }, []);

  // Keep the open action sheet bound to the latest board state so option
  // `checked` flags (notably the Labels submenu, which stays open for repeated
  // toggles) reflect optimistic/reconciled updates instead of the stale
  // long-pressed snapshot.
  useEffect(() => {
    if (!actionCard) return;
    const latest = cards.find((c) => c.id === actionCard.id);
    if (latest && latest !== actionCard) setActionCard(latest);
  }, [cards, actionCard]);

  // --- Long-press quick actions (no detail panel) ---
  // Each handler operates on the long-pressed card, applies an optimistic
  // update where cheap, persists, then reconciles against the eventual
  // `kanban_update` broadcast. Failures fall back to a reconcile.
  const quickPatchCard = useCallback(
    async (card, patch) => {
      setCards((prev) => prev.map((c) => (c.id === card.id ? { ...c, ...patch } : c)));
      try {
        await api.updateKanbanCard(projectId, card.id, patch);
        reconcileBoard();
      } catch {
        reconcileBoard();
      }
    },
    [projectId, reconcileBoard],
  );

  const quickToggleLabel = useCallback(
    (card, label) => {
      // The Labels submenu stays open for repeated toggles, but `card` is the
      // original long-pressed object whose `labels` go stale after the first
      // toggle. Read the latest persisted labels from current state so a second
      // toggle accumulates instead of overwriting the first.
      const latest = cardsRef.current.find((c) => c.id === card.id) || card;
      quickPatchCard(card, { labels: toggleLabelCsv(latest.labels, label) });
    },
    [quickPatchCard],
  );

  const quickAssign = useCallback(
    async (card, agentId, agentName) => {
      try {
        const result = await api.assignCard(projectId, card.id, agentId);
        await loadBoard();
        const newSessionId = assignedSessionId(result);
        if (newSessionId && navigation) {
          setActiveAgentId(agentId);
          setActiveSessionId(newSessionId);
          navigation.navigate('Chat');
        }
      } catch {
        Alert.alert('Error', `Failed to assign to ${agentName || 'agent'}`);
      }
    },
    [projectId, loadBoard, navigation, setActiveAgentId, setActiveSessionId],
  );

  const quickUnassign = useCallback(
    async (card) => {
      try {
        await api.unassignCard(projectId, card.id);
        reconcileBoard();
      } catch {
        Alert.alert('Error', 'Failed to unassign');
      }
    },
    [projectId, reconcileBoard],
  );

  const quickLinkEpic = useCallback(
    async (card, epicId) => {
      setCards((prev) =>
        prev.map((c) => (c.id === card.id ? { ...c, epic_id: epicId || null } : c)),
      );
      try {
        await api.linkCardToEpic(projectId, card.id, epicId || null);
        reconcileBoard();
      } catch {
        reconcileBoard();
      }
    },
    [projectId, reconcileBoard],
  );

  const quickDelete = useCallback(
    (card) => {
      Alert.alert('Delete Card', `Delete "${card.title}"?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            // Optimistically remove, snapshotting the prior list so a failed
            // delete restores the card instead of leaving it silently gone.
            let prevCards = null;
            setCards((prev) => {
              prevCards = prev;
              return prev.filter((c) => c.id !== card.id);
            });
            try {
              await api.deleteKanbanCard(projectId, card.id);
              reconcileBoard();
            } catch {
              if (prevCards) setCards(prevCards);
              Alert.alert('Error', 'Failed to delete card');
            }
          },
        },
      ]);
    },
    [projectId, reconcileBoard],
  );


  const commitMoveCard = async (cardId, targetColumnId) => {
    try {
      await api.moveKanbanCard(projectId, cardId, { columnId: targetColumnId });
      await loadBoard();
    } catch {
      Alert.alert('Error', 'Failed to move card');
    }
  };

  // Move a specific card into a column, with a soft blocker-confirm gate. The
  // API allows the move either way; the alert only warns. Used by the action
  // sheet's Status submenu.
  const handleMoveCardFor = (card, targetColumnId) => {
    if (!card || card.column_id === targetColumnId) return;
    const targetColumn = columns.find((c) => c.id === targetColumnId);
    if (shouldConfirmMove(card, card.column_id, targetColumn)) {
      const unresolved = card.blockers.filter((b) => !b.done);
      Alert.alert(
        'Card is still blocked',
        `"${card.title}" is blocked by ${unresolved.length} unresolved card(s):\n\n` +
          unresolved.map((b) => `• ${b.title}`).join('\n') +
          `\n\nMove into ${targetColumn?.name || 'column'} anyway?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Move anyway',
            style: 'destructive',
            onPress: () => commitMoveCard(card.id, targetColumnId),
          },
        ],
      );
      return;
    }
    commitMoveCard(card.id, targetColumnId);
  };

  // Single dispatcher for an action-sheet option's `action` descriptor. Plain
  // function (re-created each render) — only used by the action-sheet JSX, not
  // passed to a memoised child, so stability doesn't matter.
  const runCardAction = (card, action) => {
    if (!card || !action) return;
    switch (action.type) {
      case 'move':
        closeActionSheet();
        handleMoveCardFor(card, action.columnId);
        break;
      case 'setPriority':
        closeActionSheet();
        quickPatchCard(card, { priority: action.priority });
        break;
      case 'assign':
        closeActionSheet();
        quickAssign(card, action.agentId, action.name);
        break;
      case 'unassign':
        closeActionSheet();
        quickUnassign(card);
        break;
      case 'toggleLabel':
        // Keep the sheet open so several labels can be toggled in a row.
        quickToggleLabel(card, action.label);
        break;
      case 'linkEpic':
        closeActionSheet();
        quickLinkEpic(card, action.epicId);
        break;
      case 'copyId': {
        closeActionSheet();
        const meta = cardMetaModel(card, { board, epics });
        copyToClipboard(meta.shortLabel || String(card.id));
        break;
      }
      case 'copyLink': {
        closeActionSheet();
        // Canonical shareable deep-link (same format as the web card menu).
        // Falls back to the card id when no server URL is configured yet, so
        // we never copy a non-pasteable relative path.
        const link = cardShareUrl(getServerBaseUrl(), projectId, card.id);
        copyToClipboard(link || String(card.id));
        break;
      }
      case 'delete':
        closeActionSheet();
        quickDelete(card);
        break;
      default:
        closeActionSheet();
    }
  };

  // Distinct labels across all loaded cards — drives the Labels action submenu.
  const allLabels = useMemo(() => {
    const set = new Set();
    for (const c of cards) {
      if (!c.labels) continue;
      const arr = typeof c.labels === 'string' ? c.labels.split(',') : c.labels;
      for (const l of arr) {
        const t = String(l).trim();
        if (t) set.add(t);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [cards]);

  const refreshBoardAndSelected = async () => {
    const preserve = loadedCountsByColumn(cardsRef.current);
    const { data, allCards, paging } = await loadBoardPaged(preserve);
    setBoard(data);
    setCards(allCards);
    setColumnPaging(paging);
    if (selectedCard) {
      const refreshed = allCards.find((c) => c.id === selectedCard.id);
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

  // While an epic filter is active the column is drained to its end (see the
  // effect below), so suppress the infinite-scroll fetch — filtering runs
  // client-side over the fully loaded set.
  const paginationActive = !selectedEpicId;

  // When an epic filter is active, the filter runs over loaded cards only, so
  // matches living past the first page would be invisible. Load the active
  // column in full whenever a filter is selected.
  //
  // NOTE: these hooks must stay above the `if (loading) return` early return
  // below — declaring them after a conditional return would change the hook
  // count between the loading and loaded renders (rules-of-hooks violation).
  useEffect(() => {
    if (selectedEpicId && activeColumn) {
      drainColumn(activeColumn);
    }
  }, [selectedEpicId, activeColumn, drainColumn]);

  const handleEndReached = useCallback(() => {
    if (!activeColumn || !paginationActive) return;
    loadMoreColumn(activeColumn);
  }, [activeColumn, paginationActive, loadMoreColumn]);

  const renderCard = useCallback(
    ({ item: card }) => {
      const meta = cardMetaModel(card, { board, epics });
      const dateLabel = shortDate(card.created_at);
      const hasFooter = meta.epic || meta.labels.length > 0 || dateLabel || meta.initials;
      return (
        <TouchableOpacity
          style={[styles.card, { borderLeftWidth: 3, borderLeftColor: meta.priority.color }]}
          onPress={() => handleOpenDetail(card)}
          onLongPress={() => handleLongPressCard(card)}
          activeOpacity={0.7}
        >
          {/* Header: priority glyph + short id (left) · status glyphs (right). */}
          <View style={styles.cardHeader}>
            <PriorityGlyph priority={meta.priority.value} />
            {meta.shortLabel && (
              <Text style={styles.cardShortId} testID="card-short-id">
                {meta.shortLabel}
              </Text>
            )}
            <View style={{ flex: 1 }} />
            {meta.blockerCount > 0 && (
              <View style={styles.blockerBadge} testID="card-blocker-badge">
                <Text style={styles.blockerBadgeText}>
                  {'🔒'} {meta.blockerCount}
                </Text>
              </View>
            )}
            {meta.prNumber && (
              <Text style={styles.prChip} numberOfLines={1}>
                PR {meta.prNumber}
              </Text>
            )}
            {meta.review && (
              <Text
                style={[styles.reviewGlyph, { color: meta.review.color }]}
                testID="card-review-glyph"
                numberOfLines={1}
              >
                {meta.review.label}
              </Text>
            )}
          </View>

          {/* Title */}
          <Text style={styles.cardTitle} testID="card-title">
            {card.title}
          </Text>

          {/* Footer: epic + labels (left) · created date + avatar (right). */}
          {hasFooter && (
            <View style={styles.cardFooter}>
              <View style={styles.cardFooterLeft}>
                {meta.epic && (
                  <View style={styles.cardEpicRow}>
                    <View
                      style={[
                        styles.epicDot,
                        { backgroundColor: meta.epic.color || DEFAULT_EPIC_COLOR },
                      ]}
                    />
                    <Text
                      style={[
                        styles.cardEpicText,
                        { color: meta.epic.color || DEFAULT_EPIC_COLOR },
                      ]}
                      numberOfLines={1}
                    >
                      {epicDropdownLabel(meta.epic)}
                    </Text>
                  </View>
                )}
                {meta.labels.map((label, i) => (
                  <View key={i} style={styles.labelChip}>
                    <Text style={styles.labelChipText}>{label}</Text>
                  </View>
                ))}
              </View>
              <View style={styles.cardFooterRight}>
                {dateLabel ? (
                  <Text style={styles.cardDate} testID="card-created-date">
                    {dateLabel}
                  </Text>
                ) : null}
                <CardAvatar initials={meta.initials} avatar={meta.avatar} active={meta.active} />
              </View>
            </View>
          )}
        </TouchableOpacity>
      );
    },
    [board, epics, handleOpenDetail, handleLongPressCard],
  );

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
                  const options = cards
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
  const activePaging = activeColumn ? columnPaging[activeColumn] : undefined;

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
          // With an epic filter active we can only count loaded+filtered cards;
          // otherwise prefer the server-reported column total.
          const count = selectedEpicId
            ? cardsForColumn(col.id).length
            : (columnPaging[col.id]?.total ?? cardsForColumn(col.id).length);
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
      <FlatList
        style={styles.cardList}
        contentContainerStyle={styles.cardListContent}
        data={currentCards}
        keyExtractor={(card) => card.id}
        renderItem={renderCard}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={
          <View style={styles.emptyCol}>
            <Text style={styles.emptyColText}>No cards in {activeColumnObj?.name || 'this column'}</Text>
          </View>
        }
        ListFooterComponent={
          activePaging?.loading ? (
            <View style={styles.listFooter}>
              <ActivityIndicator color={colors.gray400} />
            </View>
          ) : null
        }
      />

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

      {/* Card Action Sheet (long-press) — mobile equivalent of the web
          right-click CardContextMenu. Top level lists the action groups; tapping
          one with options pushes a second sheet of choices. */}
      <Modal
        visible={!!actionCard}
        transparent
        animationType="fade"
        onRequestClose={closeActionSheet}
      >
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={closeActionSheet}>
          <TouchableOpacity activeOpacity={1} style={styles.actionSheet}>
            {actionCard &&
              (() => {
                const actions = buildCardActions(actionCard, {
                  columns,
                  epics,
                  agents: projectAgents,
                  labels: allLabels,
                });
                if (actionSubmenu) {
                  const group = actions.find((a) => a.key === actionSubmenu) || null;
                  const options = group?.options || [];
                  return (
                    <>
                      <View style={styles.actionSheetHeader}>
                        <TouchableOpacity
                          onPress={() => setActionSubmenu(null)}
                          style={styles.actionSheetBack}
                        >
                          <Text style={styles.actionSheetBackText}>{'←'}</Text>
                        </TouchableOpacity>
                        <Text style={styles.actionSheetTitle} numberOfLines={1}>
                          {group?.title || group?.label}
                        </Text>
                      </View>
                      <ScrollView style={{ maxHeight: 360 }}>
                        {options.map((opt) => (
                          <TouchableOpacity
                            key={opt.key}
                            style={styles.actionRow}
                            disabled={opt.disabled}
                            onPress={() => !opt.disabled && runCardAction(actionCard, opt.action)}
                          >
                            {opt.color != null && (
                              <View
                                style={[styles.actionDot, { backgroundColor: opt.color }]}
                              />
                            )}
                            <Text
                              style={[
                                styles.actionRowText,
                                opt.disabled && styles.actionRowTextDisabled,
                              ]}
                              numberOfLines={1}
                            >
                              {opt.label}
                            </Text>
                            {opt.checked && <Text style={styles.actionCheck}>{'✓'}</Text>}
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                      <TouchableOpacity style={styles.modalCancel} onPress={closeActionSheet}>
                        <Text style={styles.modalCancelText}>Cancel</Text>
                      </TouchableOpacity>
                    </>
                  );
                }
                return (
                  <>
                    <Text style={styles.actionSheetTitle} numberOfLines={1}>
                      {actionCard.title}
                    </Text>
                    <ScrollView style={{ maxHeight: 420 }}>
                      {actions.map((group) => (
                        <TouchableOpacity
                          key={group.key}
                          style={styles.actionRow}
                          testID={`card-action-${group.key}`}
                          onPress={() =>
                            group.leaf
                              ? runCardAction(actionCard, group.action)
                              : setActionSubmenu(group.key)
                          }
                        >
                          <Text
                            style={[
                              styles.actionRowText,
                              group.danger && styles.actionRowTextDanger,
                            ]}
                          >
                            {group.label}
                          </Text>
                          {!group.leaf && <Text style={styles.actionChevron}>{'›'}</Text>}
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                    <TouchableOpacity style={styles.modalCancel} onPress={closeActionSheet}>
                      <Text style={styles.modalCancelText}>Cancel</Text>
                    </TouchableOpacity>
                  </>
                );
              })()}
          </TouchableOpacity>
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
                const count = countOpenCardsForEpic(cards, epic.id, doneColumnIds);
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
  listFooter: { paddingVertical: 16, alignItems: 'center' },
  emptyCol: { paddingVertical: 40, alignItems: 'center' },
  emptyColText: { fontSize: 14, color: colors.gray600 },

  // Card item (dense Linear-style layout)
  card: {
    backgroundColor: colors.gray800, borderRadius: 10, borderWidth: 1, borderColor: colors.gray700,
    padding: 11, marginBottom: 8,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardShortId: { fontSize: 11, color: colors.gray500, fontVariant: ['tabular-nums'] },
  cardTitle: { fontSize: 14, fontWeight: '500', color: colors.gray100, marginTop: 5, lineHeight: 19 },
  priorityDotSmall: { width: 8, height: 8, borderRadius: 4 },
  // Priority glyph
  priUrgent: { width: 13, height: 13, borderRadius: 3 },
  priBars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 13 },
  priBar: { width: 3, borderRadius: 1 },
  // Status glyphs (right of header)
  prChip: { fontSize: 11, color: colors.gray500 },
  reviewGlyph: { fontSize: 11, fontWeight: '500' },
  // Footer
  cardFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 9 },
  cardFooterLeft: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4, flexShrink: 1 },
  cardFooterRight: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  cardDate: { fontSize: 10, color: colors.gray500, fontVariant: ['tabular-nums'] },
  // Assignee avatar
  avatar: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  avatarActive: { borderWidth: 1.5, borderColor: 'rgba(129,140,248,0.7)' },
  avatarText: { fontSize: 9, fontWeight: '700' },
  avatarDot: {
    position: 'absolute', bottom: -1, right: -1, width: 7, height: 7, borderRadius: 4,
    backgroundColor: colors.indigo400, borderWidth: 1.5, borderColor: colors.gray800,
  },
  labelChip: {
    backgroundColor: colors.gray700, borderRadius: 6,
    paddingHorizontal: 7, paddingVertical: 2,
  },
  labelChipText: { fontSize: 10, color: colors.gray400, fontWeight: '500' },

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

  // Card action sheet (long-press)
  actionSheet: {
    backgroundColor: colors.gray800, borderRadius: 12, padding: 12, width: 300,
    borderWidth: 1, borderColor: colors.gray700,
  },
  actionSheetHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  actionSheetBack: { paddingHorizontal: 4, paddingVertical: 2 },
  actionSheetBackText: { fontSize: 20, color: colors.gray400 },
  actionSheetTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.white, marginBottom: 8 },
  actionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.gray700,
  },
  actionDot: { width: 10, height: 10, borderRadius: 5 },
  actionRowText: { flex: 1, fontSize: 14, color: colors.gray200 },
  actionRowTextDisabled: { color: colors.gray600 },
  actionRowTextDanger: { color: colors.red400 },
  actionCheck: { fontSize: 14, color: colors.indigo400 },
  actionChevron: { fontSize: 18, color: colors.gray600 },

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
