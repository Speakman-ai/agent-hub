import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Plus,
  GripVertical,
  X,
  MessageSquare,
  ExternalLink,
  Trash2,
  Zap,
  Target,
  ChevronDown,
  Settings,
  Search,
  GitPullRequest,
  Eye,
  Lock,
  AlertTriangle,
} from 'lucide-react';
import { api } from '../utils/api.js';
import { epicFormToUpdateBody } from '../utils/epics.js';
import { hasUnresolvedBlockers, shouldConfirmMove } from '../utils/blockers.js';

const PRIORITY_STYLES = {
  urgent: 'bg-red-500/20 text-red-400',
  high: 'bg-orange-500/20 text-orange-400',
  medium: 'bg-blue-500/20 text-blue-400',
  low: 'bg-gray-500/20 text-gray-400',
};

const PRIORITIES = ['urgent', 'high', 'medium', 'low'];

const EPIC_COLORS = [
  '#6366F1', // indigo
  '#8B5CF6', // violet
  '#EC4899', // pink
  '#EF4444', // red
  '#F97316', // orange
  '#EAB308', // yellow
  '#22C55E', // green
  '#06B6D4', // cyan
  '#3B82F6', // blue
];

export default function KanbanBoard({
  projectId,
  project,
  agents = [],
  refreshKey,
  onNavigateToSession,
}) {
  const [_board, setBoard] = useState(null);
  const [columns, setColumns] = useState([]);
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Inline add card state: columnId that has the form open
  const [addingInColumn, setAddingInColumn] = useState(null);
  const [newCardTitle, setNewCardTitle] = useState('');
  const [newCardPriority, setNewCardPriority] = useState('medium');

  // Drag state
  const [dragCardId, setDragCardId] = useState(null);
  const [dragOverColumn, setDragOverColumn] = useState(null);
  // Where the drop will land, relative to a specific card. Either null
  // (dropping into empty space at the end of a column) or { cardId, half }
  // where half is 'top' or 'bottom'. Used to render the insertion indicator
  // line and to compute the target index on drop.
  const [dropIndicator, setDropIndicator] = useState(null);

  // Detail panel
  const [selectedCard, setSelectedCard] = useState(null);
  const [detailForm, setDetailForm] = useState({});
  const [comments, setComments] = useState([]);
  const [newComment, setNewComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [showReassign, setShowReassign] = useState(false);
  const [unassigning, setUnassigning] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState('');

  // Review Activity
  const [reviewLogs, setReviewLogs] = useState([]);
  const [showReviewPanel, setShowReviewPanel] = useState(false);

  // Epics
  const [epics, setEpics] = useState([]);
  const [selectedEpicId, setSelectedEpicId] = useState(null);
  const [showEpicForm, setShowEpicForm] = useState(false);
  const [epicForm, setEpicForm] = useState({ name: '', description: '', color: '#6366F1' });
  const [editingEpic, setEditingEpic] = useState(null);

  // Blockers
  const [showBlockerPicker, setShowBlockerPicker] = useState(false);
  const [blockerPickerQuery, setBlockerPickerQuery] = useState('');
  const [blockerError, setBlockerError] = useState(null);
  const [pendingMove, setPendingMove] = useState(null); // { card, targetColumn, position }

  /** Engine→valid models map from GET /api/config/models (optional model on card assign + epic autonomous). */
  const [modelConfig, setModelConfig] = useState(null);

  const addTitleRef = useRef(null);

  useEffect(() => {
    if (typeof api.getModelConfig !== 'function') return;
    api
      .getModelConfig()
      .then(setModelConfig)
      .catch((err) => {
        console.warn('[KanbanBoard] getModelConfig failed — session model picker disabled:', err);
        setModelConfig(null);
      });
  }, []);

  const fetchBoard = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await api.getBoard(projectId);
      setBoard(data.board);
      setColumns(data.columns);
      setCards(data.cards);
      setEpics(data.epics || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Initial load / project switch — show loading spinner
  useEffect(() => {
    setLoading(true);
    fetchBoard();
    // Fetch review logs for the project
    if (projectId) {
      api
        .get(`/projects/${projectId}/reviews?limit=20`)
        .then(setReviewLogs)
        .catch(() => {});
    }
  }, [fetchBoard, projectId]);

  // Background refresh triggered by WebSocket events (card moves, updates,
  // comments, etc). Deliberately does NOT toggle `loading`, so the UI updates
  // in place without flashing the full "Loading board..." screen. Skip the
  // very first render — the initial-load effect above handles that.
  const isFirstRefresh = useRef(true);
  useEffect(() => {
    if (isFirstRefresh.current) {
      isFirstRefresh.current = false;
      return;
    }
    if (!projectId) return;
    fetchBoard();
    api
      .get(`/projects/${projectId}/reviews?limit=20`)
      .then(setReviewLogs)
      .catch(() => {});
  }, [refreshKey, projectId, fetchBoard]);

  // Focus title input when add form opens
  useEffect(() => {
    if (addingInColumn && addTitleRef.current) {
      addTitleRef.current.focus();
    }
  }, [addingInColumn]);

  // Load comments when card selected
  useEffect(() => {
    if (!selectedCard) return;
    api
      .getCardComments(projectId, selectedCard.id)
      .then(setComments)
      .catch(() => setComments([]));
  }, [selectedCard, projectId]);

  // Close detail modal on Escape key
  useEffect(() => {
    if (!selectedCard) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setSelectedCard(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedCard]);

  const cardsForColumn = (columnId) => {
    const q = searchQuery.toLowerCase().trim();
    return cards
      .filter((c) => c.column_id === columnId)
      .filter((c) => !selectedEpicId || c.epic_id === selectedEpicId)
      .filter(
        (c) =>
          !q ||
          c.title.toLowerCase().includes(q) ||
          (c.description || '').toLowerCase().includes(q) ||
          (c.labels || '').toLowerCase().includes(q) ||
          (c.assignee || '').toLowerCase().includes(q),
      )
      .sort((a, b) => a.position - b.position);
  };

  // --- Drag and Drop ---
  //
  // Goals:
  //   * Support both cross-column moves AND within-column reordering.
  //   * Allow dropping BETWEEN cards (not just appending).
  //
  // Design:
  //   * Per-card `onDragOver` computes whether the cursor is in the top or
  //     bottom half of the hovered card and sets `dropIndicator`.
  //   * On drop, the target index is derived from `dropIndicator` (indicator
  //     on top half → insert *before* that card; on bottom half → *after*).
  //     If no indicator is set (e.g., dropped into empty column space), we
  //     append to the end.
  //   * The server's `/cards/:id/move` endpoint only updates one card at a
  //     time and does NOT renumber siblings — so we compute the new ordering
  //     on the client and issue `api.moveCard` for every card whose position
  //     (or column) actually changed. Tiny N (visible human-paced drags);
  //     Promise.all is fine.
  //   * Optimistic: the `cards` state is updated locally before the network
  //     round-trip; on any failure we call `fetchBoard()` to roll back.
  const columnCardsSorted = useCallback(
    (columnId) =>
      cards.filter((c) => c.column_id === columnId).sort((a, b) => a.position - b.position),
    [cards],
  );

  const handleDragStart = (e, cardId) => {
    setDragCardId(cardId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(cardId));
  };

  const handleColumnDragOver = (e, columnId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverColumn(columnId);
  };

  const handleColumnDragLeave = (e) => {
    if (e.currentTarget && !e.currentTarget.contains(e.relatedTarget)) {
      setDragOverColumn(null);
      setDropIndicator(null);
    }
  };

  const handleCardDragOver = (e, cardId) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    const half = e.clientY < midpoint ? 'top' : 'bottom';
    setDropIndicator((prev) => {
      if (prev && prev.cardId === cardId && prev.half === half) return prev;
      return { cardId, half };
    });
  };

  // Resolve the drop target to `{ columnId, index }` in the target column's
  // full sorted list. When an indicator is present, `index` comes from the
  // hovered card; otherwise it's the end of the column.
  const resolveDropTarget = (fallbackColumnId, indicator) => {
    if (indicator && indicator.cardId) {
      const hovered = cards.find((c) => c.id === indicator.cardId);
      if (hovered) {
        const targetColumnId = hovered.column_id;
        const sorted = columnCardsSorted(targetColumnId);
        const hoveredIdx = sorted.findIndex((c) => c.id === indicator.cardId);
        const index =
          hoveredIdx === -1
            ? sorted.length
            : indicator.half === 'top'
              ? hoveredIdx
              : hoveredIdx + 1;
        return { columnId: targetColumnId, index };
      }
    }
    const sorted = columnCardsSorted(fallbackColumnId);
    return { columnId: fallbackColumnId, index: sorted.length };
  };

  // Build the list of {cardId, columnId, position} updates needed to reflect
  // the requested move. Returns [] if the drop is a no-op.
  const computePositionUpdates = (card, targetColumnId, targetIndex) => {
    const sourceColumnId = card.column_id;
    const targetSorted = columnCardsSorted(targetColumnId);

    let newTargetOrder;
    if (sourceColumnId === targetColumnId) {
      const without = targetSorted.filter((c) => c.id !== card.id);
      const currentIdx = targetSorted.findIndex((c) => c.id === card.id);
      // If targetIndex is past the card's current slot, account for the
      // splice so adjacent bottom-half drops become no-ops.
      let adjusted = targetIndex;
      if (currentIdx !== -1 && targetIndex > currentIdx) adjusted -= 1;
      if (adjusted === currentIdx) return [];
      adjusted = Math.max(0, Math.min(adjusted, without.length));
      newTargetOrder = [...without.slice(0, adjusted), card, ...without.slice(adjusted)];
    } else {
      const clamped = Math.max(0, Math.min(targetIndex, targetSorted.length));
      newTargetOrder = [
        ...targetSorted.slice(0, clamped),
        { ...card, column_id: targetColumnId },
        ...targetSorted.slice(clamped),
      ];
    }

    const updates = [];
    newTargetOrder.forEach((c, idx) => {
      if (c.id === card.id) {
        // Compare the server's current view (original `card`) against the
        // requested slot — not against the spread copy `c`, whose
        // `column_id` has already been rewritten to the target.
        if (card.column_id !== targetColumnId || card.position !== idx) {
          updates.push({ id: c.id, columnId: targetColumnId, position: idx });
        }
        return;
      }
      if (c.position !== idx) {
        updates.push({ id: c.id, columnId: targetColumnId, position: idx });
      }
    });

    // Cross-column: cards left behind in the source column shift up.
    if (sourceColumnId !== targetColumnId) {
      const sourceSorted = columnCardsSorted(sourceColumnId).filter((c) => c.id !== card.id);
      sourceSorted.forEach((c, idx) => {
        if (c.position !== idx) {
          updates.push({ id: c.id, columnId: sourceColumnId, position: idx });
        }
      });
    }

    return updates;
  };

  const applyUpdatesOptimistic = (updates) => {
    if (updates.length === 0) return;
    setCards((prev) =>
      prev.map((c) => {
        const u = updates.find((x) => x.id === c.id);
        return u ? { ...c, column_id: u.columnId, position: u.position } : c;
      }),
    );
  };

  const commitUpdates = async (updates) => {
    if (updates.length === 0) return;
    try {
      await Promise.all(
        updates.map((u) =>
          api.moveCard(projectId, u.id, { columnId: u.columnId, position: u.position }),
        ),
      );
    } catch {
      fetchBoard();
    }
  };

  // Back-compat: simple single-card commit. Used by the pendingMove confirm
  // dialog to actually apply the move after the user clicks "Move anyway".
  const commitMove = async (card, targetColumnId, targetIndex) => {
    const updates = computePositionUpdates(card, targetColumnId, targetIndex);
    applyUpdatesOptimistic(updates);
    await commitUpdates(updates);
  };

  const performDrop = async (fallbackColumnId, indicator) => {
    const cardId = dragCardId;
    setDragCardId(null);
    setDragOverColumn(null);
    setDropIndicator(null);
    if (!cardId) return;

    const card = cards.find((c) => c.id === cardId || c.id === Number(cardId));
    if (!card) return;

    const { columnId: targetColumnId, index: targetIndex } = resolveDropTarget(
      fallbackColumnId,
      indicator,
    );
    const targetColumn = columns.find((c) => c.id === targetColumnId);
    if (!targetColumn) return;

    // Soft-warn before moving a blocked card into a blocker-sensitive column.
    // API still allows it; the user just has to confirm.
    if (shouldConfirmMove(card, card.column_id, targetColumn)) {
      setPendingMove({ card, targetColumn, position: targetIndex });
      return;
    }

    const updates = computePositionUpdates(card, targetColumnId, targetIndex);
    applyUpdatesOptimistic(updates);
    await commitUpdates(updates);
  };

  const handleColumnDrop = async (e, columnId) => {
    e.preventDefault();
    const indicator = dropIndicator;
    await performDrop(columnId, indicator);
  };

  const handleCardDrop = async (e, targetCardId) => {
    e.preventDefault();
    e.stopPropagation();
    const indicator = dropIndicator || { cardId: targetCardId, half: 'bottom' };
    const hovered = cards.find((c) => c.id === targetCardId);
    await performDrop(hovered ? hovered.column_id : null, indicator);
  };

  const handleDragEnd = () => {
    setDragCardId(null);
    setDragOverColumn(null);
    setDropIndicator(null);
  };

  // --- Card CRUD ---
  const handleAddCard = async (columnId) => {
    if (!newCardTitle.trim()) return;
    try {
      const payload = {
        title: newCardTitle.trim(),
        priority: newCardPriority,
        columnId,
        createdBy: 'user',
      };
      if (selectedEpicId) {
        payload.epicId = selectedEpicId;
      }
      await api.createCard(projectId, payload);
      setNewCardTitle('');
      setNewCardPriority('medium');
      setAddingInColumn(null);
      fetchBoard();
    } catch (err) {
      console.error('Failed to create card:', err);
    }
  };

  const handleSaveDetail = async () => {
    if (!selectedCard) return;
    setSaving(true);
    try {
      await api.updateCard(projectId, selectedCard.id, {
        title: detailForm.title,
        description: detailForm.description,
        priority: detailForm.priority,
        assignee: detailForm.assignee,
        labels: detailForm.labels,
        githubIssueUrl: detailForm.github_issue_url,
        prUrl: detailForm.pr_url,
      });
      fetchBoard();
      setSelectedCard(null);
    } catch (err) {
      console.error('Failed to save card:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteCard = async () => {
    if (!selectedCard) return;
    try {
      await api.deleteCard(projectId, selectedCard.id);
      setSelectedCard(null);
      setConfirmDelete(false);
      fetchBoard();
    } catch (err) {
      console.error('Failed to delete card:', err);
    }
  };

  const handleAddComment = async () => {
    if (!newComment.trim() || !selectedCard) return;
    try {
      await api.addCardComment(projectId, selectedCard.id, {
        author: 'user',
        content: newComment.trim(),
      });
      setNewComment('');
      const updated = await api.getCardComments(projectId, selectedCard.id);
      setComments(updated);
    } catch (err) {
      console.error('Failed to add comment:', err);
    }
  };

  const openDetail = (card) => {
    setSelectedCard(card);
    setDetailForm({
      title: card.title || '',
      description: card.description || '',
      priority: card.priority || 'medium',
      assignee: card.assignee || '',
      assign_model: card.assign_model || '',
      labels: card.labels || '',
      github_issue_url: card.github_issue_url || '',
      pr_url: card.pr_url || '',
      epic_id: card.epic_id || '',
    });
    setConfirmDelete(false);
    setNewComment('');
    setShowReassign(false);
    setShowBlockerPicker(false);
    setBlockerPickerQuery('');
    setBlockerError(null);
  };

  // --- Blocker CRUD ---
  const handleAddBlocker = async (blockedByCardId) => {
    if (!selectedCard || !blockedByCardId) return;
    setBlockerError(null);
    try {
      await api.addCardBlocker(projectId, selectedCard.id, blockedByCardId);
      setShowBlockerPicker(false);
      setBlockerPickerQuery('');
      // Refresh board so both the card's `blockers` and the inverse `blocks`
      // are updated. Then re-pick selectedCard from the fresh list.
      const data = await api.getBoard(projectId);
      setCards(data.cards);
      const refreshed = data.cards.find((c) => c.id === selectedCard.id);
      if (refreshed) setSelectedCard(refreshed);
    } catch (err) {
      const msg = err?.message || '';
      if (msg.includes('cycle')) {
        setBlockerError('Cannot add — this would create a blocker cycle.');
      } else if (msg.includes('duplicate')) {
        setBlockerError('That card is already a blocker.');
      } else {
        setBlockerError('Failed to add blocker.');
      }
    }
  };

  const handleRemoveBlocker = async (blockedByCardId) => {
    if (!selectedCard || !blockedByCardId) return;
    setBlockerError(null);
    try {
      await api.removeCardBlocker(projectId, selectedCard.id, blockedByCardId);
      const data = await api.getBoard(projectId);
      setCards(data.cards);
      const refreshed = data.cards.find((c) => c.id === selectedCard.id);
      if (refreshed) setSelectedCard(refreshed);
    } catch {
      setBlockerError('Failed to remove blocker.');
    }
  };

  // --- Epic CRUD ---
  const handleCreateEpic = async () => {
    if (!epicForm.name.trim()) return;
    try {
      await api.createEpic(projectId, epicForm);
      setEpicForm({ name: '', description: '', color: '#6366F1' });
      setShowEpicForm(false);
      fetchBoard();
    } catch (err) {
      console.error('Failed to create epic:', err);
    }
  };

  const handleUpdateEpic = async () => {
    if (!editingEpic) return;
    try {
      // The server's PUT /board/epics/:id destructures camelCase keys. Our
      // form state uses snake_case (mirroring DB columns), so translate
      // before sending — otherwise autonomous_max_concurrent /
      // autonomous_max_iterations silently fall through to undefined on the
      // server and the old DB values are preserved.
      await api.updateEpic(projectId, editingEpic.id, epicFormToUpdateBody(epicForm));
      setEditingEpic(null);
      setEpicForm({ name: '', description: '', color: '#6366F1' });
      fetchBoard();
    } catch (err) {
      console.error('Failed to update epic:', err);
    }
  };

  const handleDeleteEpic = async (epicId) => {
    try {
      await api.deleteEpic(projectId, epicId);
      if (selectedEpicId === epicId) setSelectedEpicId(null);
      setEditingEpic(null);
      fetchBoard();
    } catch (err) {
      console.error('Failed to delete epic:', err);
    }
  };

  const handleLinkCardEpic = async (epicId) => {
    if (!selectedCard) return;
    try {
      await api.linkCardToEpic(projectId, selectedCard.id, epicId || null);
      setDetailForm((f) => ({ ...f, epic_id: epicId || '' }));
      fetchBoard();
    } catch (err) {
      console.error('Failed to link epic:', err);
    }
  };

  const openEpicEdit = (epic, e) => {
    e.stopPropagation();
    setEditingEpic(epic);
    setEpicForm({
      name: epic.name,
      description: epic.description || '',
      color: epic.color || '#6366F1',
      autonomous: epic.autonomous || 0,
      autonomous_interval: epic.autonomous_interval || 5,
      autonomous_max_concurrent: epic.autonomous_max_concurrent || 2,
      autonomous_max_iterations: epic.autonomous_max_iterations || 3,
      autonomous_model: epic.autonomous_model || '',
    });
    setShowEpicForm(false);
  };

  const doneColumnIds = new Set(
    columns.filter((c) => c.name.toLowerCase() === 'done').map((c) => c.id),
  );
  const epicCardCount = (epicId) =>
    cards.filter((c) => c.epic_id === epicId && !doneColumnIds.has(c.column_id)).length;

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-900 text-gray-400">
        Loading board...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-900 text-gray-400">
        <div className="text-center">
          <p className="mb-2">Failed to load board</p>
          <p className="text-sm text-gray-600">{error}</p>
          <button
            onClick={() => {
              setLoading(true);
              fetchBoard();
            }}
            className="mt-4 px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm text-gray-300 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-gray-900 min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <div className="flex items-center gap-3">
          {project?.color && (
            <span
              className="w-3 h-3 rounded-sm block flex-shrink-0"
              style={{ backgroundColor: project.color }}
            />
          )}
          <h1 className="text-lg font-semibold text-white">{project?.name || 'Project'} Board</h1>
          <span className="text-sm text-gray-500">
            {cards.length} card{cards.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowReviewPanel(!showReviewPanel)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
              showReviewPanel
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white'
            }`}
          >
            <Eye size={14} />
            Reviews
            {reviewLogs.length > 0 && (
              <span className="text-xs bg-gray-700/50 px-1.5 py-0.5 rounded-full">
                {reviewLogs.length}
              </span>
            )}
          </button>
          <button
            onClick={() => {
              const target = columns.find((c) => c.name.toLowerCase() !== 'backlog') || columns[0];
              if (target) setAddingInColumn(target.id);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white rounded-lg text-sm transition-colors"
          >
            <Plus size={14} />
            Add Card
          </button>
        </div>
      </div>

      {/* Review Activity Panel */}
      {showReviewPanel && (
        <div className="px-6 py-3 border-b border-gray-800/50 bg-gray-850/50 space-y-2 max-h-48 overflow-y-auto">
          <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wider">
            Recent Review Activity
          </h4>
          {reviewLogs.length === 0 ? (
            <p className="text-xs text-gray-600">No review activity yet.</p>
          ) : (
            <div className="space-y-1">
              {reviewLogs.slice(0, 10).map((log) => (
                <div
                  key={log.id}
                  className="flex items-center gap-3 text-xs py-1 px-2 rounded bg-gray-800/50"
                >
                  <span
                    className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      log.outcome === 'approved'
                        ? 'bg-emerald-400'
                        : log.outcome === 'changes_requested'
                          ? 'bg-red-400'
                          : log.outcome === 'merge_conflict'
                            ? 'bg-amber-400'
                            : 'bg-gray-400'
                    }`}
                  />
                  <span className="text-gray-300 truncate flex-1">
                    {log.pr_url?.match(/\d+$/)?.[0] ? `PR #${log.pr_url.match(/\d+$/)[0]}` : 'PR'}
                  </span>
                  <span className="text-gray-500">{log.reviewer_agent}</span>
                  <span
                    className={`font-medium ${
                      log.outcome === 'approved'
                        ? 'text-emerald-400'
                        : log.outcome === 'changes_requested'
                          ? 'text-red-400'
                          : 'text-gray-400'
                    }`}
                  >
                    {log.outcome === 'approved'
                      ? 'Approved'
                      : log.outcome === 'changes_requested'
                        ? 'Changes Requested'
                        : log.outcome === 'merge_conflict'
                          ? 'Merge Conflict'
                          : 'Ambiguous'}
                  </span>
                  <span className="text-gray-600 flex-shrink-0">
                    {new Date(log.completed_at).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Epic Dropdown Bar + Search */}
      <div className="px-6 py-2 border-b border-gray-800/50 flex items-center gap-3">
        {/* Search */}
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search cards..."
            className="bg-gray-800 border border-gray-700 text-sm text-gray-200 rounded-md pl-8 pr-3 py-1.5 w-48 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 placeholder-gray-500"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
            >
              <X size={12} />
            </button>
          )}
        </div>

        <div className="relative">
          <select
            value={selectedEpicId || ''}
            onChange={(e) => setSelectedEpicId(e.target.value || null)}
            className="appearance-none bg-gray-800 border border-gray-700 text-sm text-gray-200 rounded-md pl-3 pr-8 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 cursor-pointer"
          >
            <option value="">All Epics ({epics.length})</option>
            {epics.map((epic) => {
              const count = epicCardCount(epic.id);
              return (
                <option key={epic.id} value={epic.id}>
                  {epic.autonomous === 1 ? '⚡ ' : ''}
                  {epic.name}
                  {count > 0 ? ` (${count})` : ''}
                </option>
              );
            })}
          </select>
          <ChevronDown
            size={14}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
          />
        </div>

        {/* Selected epic color dot + edit button */}
        {selectedEpicId &&
          (() => {
            const epic = epics.find((e) => e.id === selectedEpicId);
            return epic ? (
              <div className="flex items-center gap-2">
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: epic.color }}
                />
                <button
                  onClick={(e) => openEpicEdit(epic, e)}
                  className="p-1 text-gray-500 hover:text-gray-300 rounded hover:bg-gray-800 transition-colors"
                  title="Edit epic"
                >
                  <Settings size={14} />
                </button>
              </div>
            ) : null;
          })()}

        {/* + Epic button */}
        <button
          onClick={() => {
            setShowEpicForm(true);
            setEditingEpic(null);
            setEpicForm({ name: '', description: '', color: '#6366F1' });
          }}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs text-gray-500 hover:text-gray-300 hover:bg-gray-800 whitespace-nowrap transition-colors"
        >
          <Plus size={12} />
          New Epic
        </button>
      </div>

      {/* Epic Create/Edit Form (inline dropdown) */}
      {(showEpicForm || editingEpic) && (
        <div className="px-6 py-3 border-b border-gray-800/50 bg-gray-850">
          <div className="max-w-md space-y-3">
            <div className="flex items-center gap-2 mb-1">
              <Target size={14} className="text-gray-400" />
              <span className="text-sm font-medium text-gray-300">
                {editingEpic ? 'Edit Epic' : 'New Epic'}
              </span>
            </div>

            <input
              type="text"
              value={epicForm.name}
              onChange={(e) => setEpicForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Epic name..."
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-500"
              autoFocus
            />

            <input
              type="text"
              value={epicForm.description}
              onChange={(e) => setEpicForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Description (optional)"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-500"
            />

            {/* Color picker */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500 mr-1">Color</span>
              {EPIC_COLORS.map((color) => (
                <button
                  key={color}
                  onClick={() => setEpicForm((f) => ({ ...f, color }))}
                  className={`w-5 h-5 rounded-full transition-all ${
                    epicForm.color === color
                      ? 'ring-2 ring-white ring-offset-1 ring-offset-gray-900 scale-110'
                      : 'hover:scale-110'
                  }`}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>

            {/* Autonomous toggle */}
            {editingEpic && (
              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <button
                    onClick={() => setEpicForm((f) => ({ ...f, autonomous: f.autonomous ? 0 : 1 }))}
                    className={`relative w-8 h-4.5 rounded-full transition-colors ${
                      epicForm.autonomous ? 'bg-emerald-600' : 'bg-gray-700'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${
                        epicForm.autonomous ? 'translate-x-3.5' : ''
                      }`}
                    />
                  </button>
                  <Zap
                    size={14}
                    className={epicForm.autonomous ? 'text-emerald-400' : 'text-gray-500'}
                  />
                  <span
                    className={`text-sm ${epicForm.autonomous ? 'text-emerald-400' : 'text-gray-400'}`}
                  >
                    Autonomous Mode
                  </span>
                </label>

                {epicForm.autonomous === 1 && (
                  <div className="flex items-center gap-3 pl-6">
                    <div>
                      <label
                        className="block text-xs text-gray-500 mb-0.5"
                        title="Limits cards in both In Progress and Review — new work won't start until PRs are merged"
                      >
                        Max concurrent
                      </label>
                      <input
                        type="number"
                        value={epicForm.autonomous_max_concurrent || 2}
                        onChange={(e) =>
                          setEpicForm((f) => ({
                            ...f,
                            autonomous_max_concurrent: parseInt(e.target.value) || 2,
                          }))
                        }
                        min={1}
                        max={5}
                        className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-gray-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-0.5">Max iterations</label>
                      <input
                        type="number"
                        value={epicForm.autonomous_max_iterations || 3}
                        onChange={(e) =>
                          setEpicForm((f) => ({
                            ...f,
                            autonomous_max_iterations: parseInt(e.target.value) || 3,
                          }))
                        }
                        min={1}
                        max={10}
                        className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-gray-500"
                      />
                    </div>
                    <div className="w-full max-w-xs mt-2">
                      <label className="block text-xs text-gray-500 mb-0.5">
                        Session model (optional)
                      </label>
                      <select
                        key={modelConfig ? 'models-loaded' : 'models-pending'}
                        value={epicForm.autonomous_model ?? ''}
                        onChange={(e) =>
                          setEpicForm((f) => ({ ...f, autonomous_model: e.target.value }))
                        }
                        className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-gray-500"
                      >
                        <option value="">Each agent&apos;s default</option>
                        {modelConfig?.engineValidModels &&
                          Object.entries(modelConfig.engineValidModels).map(([eng, models]) => (
                            <optgroup key={eng} label={eng}>
                              {(models || []).map((m) => (
                                <option key={`${eng}:${m}`} value={m}>
                                  {m}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center gap-2">
              <button
                onClick={editingEpic ? handleUpdateEpic : handleCreateEpic}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded transition-colors"
              >
                {editingEpic ? 'Save' : 'Create'}
              </button>
              <button
                onClick={() => {
                  setShowEpicForm(false);
                  setEditingEpic(null);
                  setEpicForm({ name: '', description: '', color: '#6366F1' });
                }}
                className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 text-xs rounded transition-colors"
              >
                Cancel
              </button>
              {editingEpic && (
                <button
                  onClick={() => handleDeleteEpic(editingEpic.id)}
                  className="px-3 py-1.5 text-red-500 hover:text-red-400 text-xs transition-colors ml-auto"
                >
                  Delete Epic
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Board */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden p-4">
        <div className="flex gap-4 h-full min-w-max">
          {columns.map((col) => {
            const colCards = cardsForColumn(col.id);
            const isDragOver = dragOverColumn === col.id;

            return (
              <div
                key={col.id}
                className={`flex flex-col w-[280px] rounded-lg bg-gray-850 flex-shrink-0 ${
                  isDragOver ? 'ring-2 ring-gray-600 bg-gray-700/30' : ''
                }`}
                style={{ minHeight: '200px' }}
                onDragOver={(e) => handleColumnDragOver(e, col.id)}
                onDragLeave={handleColumnDragLeave}
                onDrop={(e) => handleColumnDrop(e, col.id)}
              >
                {/* Column header */}
                <div
                  className="px-3 py-2.5 border-t-2 rounded-t-lg"
                  style={{ borderColor: col.color || '#6b7280' }}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-gray-300">{col.name}</span>
                    <span className="text-xs text-gray-500">({colCards.length})</span>
                  </div>
                </div>

                {/* Cards */}
                <div className="flex-1 overflow-y-auto px-2 py-1 space-y-2">
                  {colCards.map((card) => {
                    const cardEpic = card.epic_id ? epics.find((e) => e.id === card.epic_id) : null;
                    const showTopIndicator =
                      dropIndicator &&
                      dropIndicator.cardId === card.id &&
                      dropIndicator.half === 'top' &&
                      dragCardId !== card.id;
                    const showBottomIndicator =
                      dropIndicator &&
                      dropIndicator.cardId === card.id &&
                      dropIndicator.half === 'bottom' &&
                      dragCardId !== card.id;
                    return (
                      <div key={card.id} data-testid={`card-wrapper-${card.id}`}>
                        {showTopIndicator && (
                          <div
                            className="h-0.5 bg-blue-500 rounded-full mb-1"
                            data-testid={`drop-indicator-top-${card.id}`}
                          />
                        )}
                        <div
                          draggable
                          onDragStart={(e) => handleDragStart(e, card.id)}
                          onDragEnd={handleDragEnd}
                          onDragOver={(e) => handleCardDragOver(e, card.id)}
                          onDrop={(e) => handleCardDrop(e, card.id)}
                          onClick={() => openDetail(card)}
                          className={`rounded-lg p-3 bg-gray-800 border border-gray-700 hover:border-gray-600 cursor-grab active:cursor-grabbing transition-colors ${
                            dragCardId === card.id ? 'opacity-50' : ''
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            <GripVertical
                              size={14}
                              className="text-gray-600 mt-0.5 flex-shrink-0"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-sm font-medium text-white truncate">
                                  {card.title}
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5 flex-wrap mb-1">
                                {card.priority && (
                                  <span
                                    className={`inline-block text-xs px-1.5 py-0.5 rounded-full ${
                                      PRIORITY_STYLES[card.priority] || PRIORITY_STYLES.medium
                                    }`}
                                  >
                                    {card.priority}
                                  </span>
                                )}
                                {hasUnresolvedBlockers(card) && (
                                  <span
                                    className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-red-900/40 text-red-300"
                                    title={`Blocked by ${card.blockers.filter((b) => !b.done).length} unresolved card(s)`}
                                    data-testid="card-blocker-badge"
                                  >
                                    <Lock size={10} />
                                    {card.blockers.filter((b) => !b.done).length}
                                  </span>
                                )}
                                {cardEpic && (
                                  <span
                                    className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full"
                                    style={{
                                      backgroundColor: cardEpic.color + '20',
                                      color: cardEpic.color,
                                    }}
                                  >
                                    <span
                                      className="w-1.5 h-1.5 rounded-full"
                                      style={{ backgroundColor: cardEpic.color }}
                                    />
                                    {cardEpic.name}
                                  </span>
                                )}
                              </div>
                              {card.description && (
                                <p className="text-xs text-gray-500 line-clamp-2 mt-1">
                                  {card.description}
                                </p>
                              )}
                              <div className="flex items-center gap-2 mt-2 flex-wrap">
                                {card.pr_url && (
                                  <a
                                    href={card.pr_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="text-xs text-gray-500 hover:text-indigo-400 flex items-center gap-1"
                                    title={card.pr_url}
                                  >
                                    <GitPullRequest size={12} />#
                                    {card.pr_url.match(/\d+$/)?.[0] || 'PR'}
                                  </a>
                                )}
                                {card.review_status && (
                                  <span
                                    className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                                      card.review_status === 'approved'
                                        ? 'bg-emerald-500/20 text-emerald-400'
                                        : card.review_status === 'reviewing'
                                          ? 'bg-amber-500/20 text-amber-400 animate-pulse'
                                          : card.review_status === 'changes_requested'
                                            ? 'bg-red-500/20 text-red-400'
                                            : 'bg-blue-500/20 text-blue-400'
                                    }`}
                                  >
                                    {card.review_status === 'approved'
                                      ? 'Approved'
                                      : card.review_status === 'reviewing'
                                        ? 'Reviewing...'
                                        : card.review_status === 'changes_requested'
                                          ? 'Changes Requested'
                                          : 'Awaiting Review'}
                                  </span>
                                )}
                                {card.assignee && (
                                  <span
                                    className={`text-xs ${card.session_id ? 'text-indigo-400' : 'text-gray-400'}`}
                                  >
                                    {card.session_id ? '● ' : ''}
                                    {card.assignee}
                                  </span>
                                )}
                                {card.labels &&
                                  card.labels
                                    .split(',')
                                    .filter(Boolean)
                                    .map((label) => (
                                      <span
                                        key={label}
                                        className="text-xs bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded"
                                      >
                                        {label.trim()}
                                      </span>
                                    ))}
                              </div>
                            </div>
                          </div>
                        </div>
                        {showBottomIndicator && (
                          <div
                            className="h-0.5 bg-blue-500 rounded-full mt-1"
                            data-testid={`drop-indicator-bottom-${card.id}`}
                          />
                        )}
                      </div>
                    );
                  })}

                  {/* Inline add form */}
                  {addingInColumn === col.id && (
                    <div className="rounded-lg p-3 bg-gray-800 border border-gray-600">
                      <input
                        ref={addTitleRef}
                        type="text"
                        value={newCardTitle}
                        onChange={(e) => setNewCardTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleAddCard(col.id);
                          if (e.key === 'Escape') {
                            setAddingInColumn(null);
                            setNewCardTitle('');
                          }
                        }}
                        placeholder="Card title..."
                        className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-500 mb-2"
                      />
                      <div className="flex items-center gap-2">
                        <select
                          value={newCardPriority}
                          onChange={(e) => setNewCardPriority(e.target.value)}
                          className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none"
                        >
                          {PRIORITIES.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => handleAddCard(col.id)}
                          className="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded transition-colors"
                        >
                          Add
                        </button>
                        <button
                          onClick={() => {
                            setAddingInColumn(null);
                            setNewCardTitle('');
                          }}
                          className="text-gray-500 hover:text-gray-300"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Add button at bottom */}
                {addingInColumn !== col.id && (
                  <button
                    onClick={() => {
                      setAddingInColumn(col.id);
                      setNewCardTitle('');
                      setNewCardPriority('medium');
                    }}
                    className="flex items-center gap-1 px-3 py-2 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    <Plus size={12} />
                    Add
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Card Detail Modal (centered) */}
      {selectedCard && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          data-testid="card-detail-modal"
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/60" onClick={() => setSelectedCard(null)} />
          {/* Panel */}
          <div className="relative w-full max-w-6xl h-[85vh] bg-gray-900 border border-gray-800 rounded-xl flex flex-col overflow-hidden shadow-2xl">
            {/* Header */}
            <div className="shrink-0 flex items-center justify-between px-6 py-3 border-b border-gray-800">
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <span>Card</span>
                {selectedCard?.id && (
                  <span className="font-mono text-gray-600">
                    #{String(selectedCard.id).slice(0, 8)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSaveDetail}
                  disabled={saving}
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={() => setSelectedCard(null)}
                  className="p-1.5 text-gray-500 hover:text-gray-200 hover:bg-gray-800 rounded-lg transition-colors"
                  aria-label="Close"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            {/* Body — two-column on lg+, stacked on smaller screens */}
            <div className="flex-1 overflow-y-auto">
              {hasUnresolvedBlockers(selectedCard) && (
                <div
                  className="mx-6 mt-4 flex items-start gap-2 rounded-lg border border-red-800 bg-red-900/30 px-3 py-2 text-sm text-red-300"
                  data-testid="blocker-banner"
                >
                  <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                  <span>
                    This card is blocked by {selectedCard.blockers.filter((b) => !b.done).length}{' '}
                    unresolved card(s). Starting work may cause issues.
                  </span>
                </div>
              )}
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6 p-6">
                {/* Main column: title + description */}
                <div className="min-w-0 flex flex-col gap-4">
                  <input
                    type="text"
                    value={detailForm.title}
                    onChange={(e) => setDetailForm((f) => ({ ...f, title: e.target.value }))}
                    placeholder="Card title"
                    className="w-full bg-transparent border-0 border-b border-transparent hover:border-gray-800 focus:border-gray-700 px-0 py-1 text-2xl font-semibold text-white placeholder-gray-600 focus:outline-none"
                  />

                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                      Description
                    </label>
                    <textarea
                      value={detailForm.description}
                      onChange={(e) =>
                        setDetailForm((f) => ({ ...f, description: e.target.value }))
                      }
                      rows={18}
                      placeholder="Add a description — problem, acceptance criteria, context..."
                      className="w-full bg-gray-950/60 border border-gray-800 rounded-lg px-4 py-3 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-600 resize-y min-h-[320px] leading-relaxed font-sans"
                    />
                  </div>
                </div>

                {/* Sidebar: metadata */}
                <aside className="flex flex-col gap-5 lg:border-l lg:border-gray-800 lg:pl-6">
                  {/* Priority */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                      Priority
                    </label>
                    <select
                      value={detailForm.priority}
                      onChange={(e) => setDetailForm((f) => ({ ...f, priority: e.target.value }))}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500"
                    >
                      {PRIORITIES.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Assignee */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                      Assignee
                    </label>
                    {selectedCard?.session_id && !showReassign ? (
                      <div>
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <span className="text-sm text-white">
                            {detailForm.assignee || 'Assigned'}
                          </span>
                          <span className="text-xs bg-emerald-900/40 text-emerald-400 px-2 py-0.5 rounded">
                            Session active
                          </span>
                        </div>
                        <button
                          onClick={() => {
                            const agent = agents.find((a) => a.name === selectedCard.assignee);
                            if (agent && onNavigateToSession) {
                              onNavigateToSession(agent.id, selectedCard.session_id);
                            }
                          }}
                          className="w-full text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-lg transition-colors"
                        >
                          Open Session
                        </button>
                        <button
                          onClick={() => {
                            setShowReassign(true);
                            setDetailForm((f) => ({
                              ...f,
                              assign_model: selectedCard.assign_model || '',
                              assignee: selectedCard.assignee || f.assignee,
                            }));
                          }}
                          className="mt-2 w-full text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-3 py-1.5 rounded-lg transition-colors"
                        >
                          Reassign
                        </button>
                        <button
                          onClick={async () => {
                            if (!selectedCard) return;
                            setUnassigning(true);
                            try {
                              const updated = await api.unassignCard(projectId, selectedCard.id);
                              setSelectedCard(updated);
                              setDetailForm((f) => ({ ...f, assignee: '', assign_model: '' }));
                              setShowReassign(false);
                              fetchBoard();
                            } catch (err) {
                              console.error('Failed to unassign card:', err);
                            } finally {
                              setUnassigning(false);
                            }
                          }}
                          disabled={unassigning}
                          className="mt-2 w-full text-xs bg-transparent hover:bg-red-900/30 border border-red-900/60 text-red-400 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                        >
                          {unassigning ? 'Unassigning...' : 'Unassign'}
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <select
                          value={detailForm.assignee}
                          onChange={(e) =>
                            setDetailForm((f) => ({
                              ...f,
                              assignee: e.target.value,
                              assign_model: '',
                            }))
                          }
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500"
                        >
                          <option value="">Unassigned</option>
                          {agents.map((a) => (
                            <option key={a.id} value={a.name}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                        {detailForm.assignee &&
                          modelConfig &&
                          (() => {
                            const selAgent = agents.find((a) => a.name === detailForm.assignee);
                            const eng = selAgent?.engine || 'claude-code';
                            const opts = modelConfig.engineValidModels?.[eng] || [];
                            if (opts.length === 0) return null;
                            return (
                              <div className="mt-2">
                                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                                  Session model
                                </label>
                                <select
                                  value={detailForm.assign_model || ''}
                                  onChange={(e) =>
                                    setDetailForm((f) => ({ ...f, assign_model: e.target.value }))
                                  }
                                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500"
                                >
                                  <option value="">Agent default</option>
                                  {opts.map((m) => (
                                    <option key={m} value={m}>
                                      {m}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            );
                          })()}
                        {detailForm.assignee && (
                          <button
                            onClick={async () => {
                              const agent = agents.find((a) => a.name === detailForm.assignee);
                              if (!agent) return;
                              setAssigning(true);
                              try {
                                const assignOpts = {};
                                if (detailForm.assign_model?.trim())
                                  assignOpts.model = detailForm.assign_model.trim();
                                const result = await api.assignCard(
                                  projectId,
                                  selectedCard.id,
                                  agent.id,
                                  assignOpts,
                                );
                                setSelectedCard(null);
                                setShowReassign(false);
                                fetchBoard();
                                if (onNavigateToSession) {
                                  onNavigateToSession(agent.id, result.sessionId);
                                }
                              } catch (err) {
                                console.error('Failed to assign card:', err);
                              } finally {
                                setAssigning(false);
                              }
                            }}
                            disabled={assigning}
                            className="w-full text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap disabled:opacity-50"
                          >
                            {assigning
                              ? 'Starting...'
                              : selectedCard?.session_id
                                ? 'Reassign & Start'
                                : 'Assign & Start'}
                          </button>
                        )}
                        {selectedCard?.session_id && (
                          <button
                            onClick={() => setShowReassign(false)}
                            className="w-full text-xs bg-transparent hover:bg-gray-800 border border-gray-700 text-gray-400 px-3 py-1.5 rounded-lg transition-colors"
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Epic */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                      Epic
                    </label>
                    <select
                      value={detailForm.epic_id}
                      onChange={(e) => handleLinkCardEpic(e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500"
                    >
                      <option value="">None</option>
                      {epics.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Labels */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                      Labels
                    </label>
                    <input
                      type="text"
                      value={detailForm.labels}
                      onChange={(e) => setDetailForm((f) => ({ ...f, labels: e.target.value }))}
                      placeholder="bug, feature, docs"
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-500"
                    />
                  </div>

                  {/* Blockers */}
                  <div data-testid="blockers-section">
                    <div className="flex items-center justify-between mb-2">
                      <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Blocked by
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          setShowBlockerPicker((v) => !v);
                          setBlockerPickerQuery('');
                          setBlockerError(null);
                        }}
                        className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1"
                      >
                        <Plus size={12} />
                        Add
                      </button>
                    </div>

                    {selectedCard?.blockers && selectedCard.blockers.length > 0 ? (
                      <ul className="space-y-1">
                        {selectedCard.blockers.map((b) => (
                          <li
                            key={b.id}
                            className={`group flex items-center gap-2 rounded px-2 py-1.5 text-xs border-l-2 ${
                              b.done
                                ? 'bg-gray-800/50 text-gray-500 border-emerald-800'
                                : 'bg-gray-800 text-gray-300 border-red-700'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                const target = cards.find((c) => c.id === b.id);
                                if (target) openDetail(target);
                              }}
                              className="flex-1 min-w-0 text-left truncate hover:underline"
                              title={b.title}
                            >
                              {b.done ? '✓ ' : ''}
                              {b.title}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemoveBlocker(b.id)}
                              className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 transition-opacity"
                              aria-label="Remove blocker"
                            >
                              <X size={12} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-gray-600">No blockers</p>
                    )}

                    {showBlockerPicker && (
                      <div className="mt-2 rounded-lg border border-gray-700 bg-gray-900 p-2">
                        <input
                          type="text"
                          value={blockerPickerQuery}
                          onChange={(e) => setBlockerPickerQuery(e.target.value)}
                          placeholder="Search cards..."
                          autoFocus
                          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-gray-500 mb-2"
                        />
                        <div className="max-h-40 overflow-y-auto space-y-1">
                          {(() => {
                            const q = blockerPickerQuery.toLowerCase().trim();
                            const excluded = new Set([
                              selectedCard.id,
                              ...(selectedCard.blockers || []).map((b) => b.id),
                            ]);
                            const options = cards
                              .filter((c) => !excluded.has(c.id))
                              .filter((c) => !q || c.title.toLowerCase().includes(q))
                              .slice(0, 20);
                            if (options.length === 0) {
                              return (
                                <p className="text-xs text-gray-600 px-1 py-1">No matching cards</p>
                              );
                            }
                            return options.map((c) => (
                              <button
                                key={c.id}
                                type="button"
                                onClick={() => handleAddBlocker(c.id)}
                                className="w-full text-left text-xs text-gray-300 hover:bg-gray-800 rounded px-2 py-1 truncate"
                              >
                                {c.title}
                              </button>
                            ));
                          })()}
                        </div>
                      </div>
                    )}

                    {blockerError && <p className="mt-1 text-xs text-red-400">{blockerError}</p>}
                  </div>

                  {/* Blocks (inverse) */}
                  {selectedCard?.blocks && selectedCard.blocks.length > 0 && (
                    <div data-testid="blocks-section">
                      <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                        Blocks
                      </label>
                      <ul className="space-y-1">
                        {selectedCard.blocks.map((b) => (
                          <li
                            key={b.id}
                            className="bg-gray-800/60 text-gray-400 text-xs rounded px-2 py-1.5"
                          >
                            <button
                              type="button"
                              onClick={() => {
                                const target = cards.find((c) => c.id === b.id);
                                if (target) openDetail(target);
                              }}
                              className="w-full text-left truncate hover:underline"
                              title={b.title}
                            >
                              {b.title}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* GitHub Issue URL */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                      GitHub Issue URL
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={detailForm.github_issue_url}
                        onChange={(e) =>
                          setDetailForm((f) => ({ ...f, github_issue_url: e.target.value }))
                        }
                        placeholder="https://github.com/..."
                        className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-500"
                      />
                      {detailForm.github_issue_url && (
                        <a
                          href={detailForm.github_issue_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-gray-500 hover:text-gray-300 shrink-0"
                        >
                          <ExternalLink size={16} />
                        </a>
                      )}
                    </div>
                  </div>

                  {/* PR URL */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                      Pull Request
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={detailForm.pr_url}
                        onChange={(e) => setDetailForm((f) => ({ ...f, pr_url: e.target.value }))}
                        placeholder="https://github.com/.../pull/123"
                        className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-500"
                      />
                      {detailForm.pr_url && (
                        <a
                          href={detailForm.pr_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-gray-500 hover:text-gray-300 shrink-0"
                        >
                          <ExternalLink size={16} />
                        </a>
                      )}
                    </div>
                  </div>

                  {/* Timestamps */}
                  {(selectedCard?.created_at || selectedCard?.updated_at) && (
                    <div className="text-xs text-gray-600 space-y-1 pt-1">
                      {selectedCard?.created_at && (
                        <div>
                          <span className="text-gray-500">Created:</span>{' '}
                          {new Date(selectedCard.created_at).toLocaleString()}
                        </div>
                      )}
                      {selectedCard?.updated_at && (
                        <div>
                          <span className="text-gray-500">Updated:</span>{' '}
                          {new Date(selectedCard.updated_at).toLocaleString()}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Delete */}
                  <div className="border-t border-gray-800 pt-4 mt-auto">
                    {confirmDelete ? (
                      <div className="flex flex-col gap-2">
                        <span className="text-sm text-red-400">Delete this card?</span>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={handleDeleteCard}
                            className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded text-xs transition-colors"
                          >
                            Confirm
                          </button>
                          <button
                            onClick={() => setConfirmDelete(false)}
                            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded text-xs transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(true)}
                        className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-red-400 transition-colors"
                      >
                        <Trash2 size={14} />
                        Delete card
                      </button>
                    )}
                  </div>
                </aside>
              </div>
            </div>

            {/* Comments — full-width footer */}
            <div className="shrink-0 border-t border-gray-800 bg-gray-950/40 px-6 py-4 max-h-[40%] overflow-y-auto">
              <div className="flex items-center gap-2 mb-3">
                <MessageSquare size={14} className="text-gray-500" />
                <span className="text-sm font-medium text-gray-400">
                  Comments ({comments.length})
                </span>
              </div>

              <div className="space-y-3 mb-4">
                {comments.map((c) => (
                  <div key={c.id} className="bg-gray-800 rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-gray-300">{c.author}</span>
                      <span className="text-xs text-gray-600">
                        {new Date(c.created_at).toLocaleString()}
                      </span>
                    </div>
                    <p className="text-sm text-gray-400 whitespace-pre-wrap">{c.content}</p>
                  </div>
                ))}
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddComment();
                  }}
                  placeholder="Add a comment..."
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-500"
                />
                <button
                  onClick={handleAddComment}
                  className="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm transition-colors"
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Confirm move — blocked-card → blocker-sensitive column */}
      {pendingMove && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          data-testid="confirm-move-dialog"
        >
          <div className="absolute inset-0 bg-black/60" onClick={() => setPendingMove(null)} />
          <div className="relative w-full max-w-md bg-gray-900 border border-red-900/60 rounded-xl shadow-2xl p-5">
            <div className="flex items-start gap-3 mb-3">
              <AlertTriangle size={20} className="text-red-400 mt-0.5 flex-shrink-0" />
              <div>
                <h3 className="text-sm font-semibold text-white mb-1">Card is still blocked</h3>
                <p className="text-xs text-gray-400 leading-relaxed">
                  &ldquo;{pendingMove.card.title}&rdquo; is blocked by{' '}
                  {pendingMove.card.blockers.filter((b) => !b.done).length} unresolved card(s). Move
                  it into <span className="text-gray-200">{pendingMove.targetColumn.name}</span>{' '}
                  anyway?
                </p>
              </div>
            </div>
            <ul className="mb-4 pl-8 space-y-1">
              {pendingMove.card.blockers
                .filter((b) => !b.done)
                .map((b) => (
                  <li key={b.id} className="text-xs text-red-300 truncate" title={b.title}>
                    • {b.title}
                  </li>
                ))}
            </ul>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingMove(null)}
                className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const { card, targetColumn, position } = pendingMove;
                  setPendingMove(null);
                  await commitMove(card, targetColumn.id, position);
                }}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded text-xs font-medium transition-colors"
              >
                Move anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
