import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Plus,
  GripVertical,
  X,
  MessageSquare,
  ExternalLink,
  Trash2,
  Search,
  GitPullRequest,
  Target,
  Lock,
  AlertTriangle,
  Zap,
  PlayCircle,
} from 'lucide-react';
import { api } from '../utils/api.js';
import { useVisibleIntervalRefresh } from '../hooks/useVisibleIntervalRefresh.js';
import { epicFormToUpdateBody } from '../utils/epics.js';
import { hasUnresolvedBlockers, shouldConfirmMove } from '../utils/blockers.js';
import { filterAgentsByProject } from '../utils/kanbanAgents.js';
import { MarkdownContent } from './MarkdownRenderer.jsx';
import FinalizeCardBadge from './finalize/CardBadge.jsx';
import EpicFilterDropdown from './EpicFilterDropdown.jsx';
import EpicAutonomousDialog from './EpicAutonomousDialog.jsx';
import { epicToAutonomousForm } from './EpicAutonomousPanel.jsx';
import ReplayPlayerModal from './ReplayPlayerModal.jsx';

const PRIORITY_STYLES = {
  urgent: 'bg-red-500/10 text-red-300 ring-1 ring-inset ring-red-500/25',
  high: 'bg-orange-500/10 text-orange-300 ring-1 ring-inset ring-orange-500/25',
  medium: 'bg-sky-500/10 text-sky-300 ring-1 ring-inset ring-sky-500/25',
  low: 'bg-gray-500/10 text-gray-400 ring-1 ring-inset ring-gray-500/20',
};

const PRIORITY_ACCENT = {
  urgent: 'border-l-red-500',
  high: 'border-l-orange-500',
  medium: 'border-l-sky-500',
  low: 'border-l-gray-600',
};

const PRIORITIES = ['urgent', 'high', 'medium', 'low'];

export default function KanbanBoard({
  projectId,
  project,
  agents = [],
  refreshKey,
  onNavigateToSession,
  onOpenEpics,
}) {
  // The assignment dropdown must only offer agents that belong to this
  // project — agents are loaded app-wide and flattened across every visible
  // project, so scope them to `projectId` before rendering options.
  const projectAgents = useMemo(
    () => filterAgentsByProject(agents, projectId),
    [agents, projectId],
  );

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
  // Session replay attributed to the open card (carried over from a converted
  // bug ticket). null = none / not-yet-resolved; drives the "Watch replay" CTA.
  const [cardReplay, setCardReplay] = useState(null);
  const [watchingReplay, setWatchingReplay] = useState(false);
  const [newComment, setNewComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [showReassign, setShowReassign] = useState(false);
  const [unassigning, setUnassigning] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState('');

  // Epics (filter, badges, autonomous dispatch)
  const [epics, setEpics] = useState([]);
  const [selectedEpicId, setSelectedEpicId] = useState(null);
  const [showAutonomousDialog, setShowAutonomousDialog] = useState(false);
  const [autonomousForm, setAutonomousForm] = useState(null);
  const [autonomousSaving, setAutonomousSaving] = useState(false);

  // Blockers
  const [showBlockerPicker, setShowBlockerPicker] = useState(false);
  const [blockerPickerQuery, setBlockerPickerQuery] = useState('');
  const [blockerError, setBlockerError] = useState(null);
  const [pendingMove, setPendingMove] = useState(null); // { card, targetColumn, position }

  /** Card detail: description shown as rendered markdown until user chooses Edit. */
  const [descriptionEditing, setDescriptionEditing] = useState(false);

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
  }, [refreshKey, projectId, fetchBoard]);

  // WebSocket-driven `refreshKey` covers most edits; this catches long idle periods
  // or missed events without toggling `loading` (fetchBoard leaves loading false).
  useVisibleIntervalRefresh(
    () => {
      if (!projectId) return;
      void fetchBoard();
    },
    180_000,
    { enabled: Boolean(projectId) },
  );

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

  // Resolve the card's session replay, if any. A card carries no replay ref on
  // its row — the attribution lives on session_replays.card_id — so we ask the
  // server. 404 (the common case: most cards have no replay) clears it.
  useEffect(() => {
    if (!selectedCard) {
      setCardReplay(null);
      setWatchingReplay(false);
      return;
    }
    let cancelled = false;
    setCardReplay(null);
    setWatchingReplay(false);
    api
      .getCardReplay(projectId, selectedCard.id)
      .then((r) => {
        if (!cancelled) setCardReplay(r?.replayId ? r : null);
      })
      .catch(() => {
        if (!cancelled) setCardReplay(null);
      });
    return () => {
      cancelled = true;
    };
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
        assign_model: detailForm.assign_model || null,
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
      assign_engine: card.assign_engine || '',
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
    setDescriptionEditing(false);
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

  const doneColumnIds = new Set(
    columns.filter((c) => c.name.toLowerCase() === 'done').map((c) => c.id),
  );
  const epicCardCount = (epicId) =>
    cards.filter((c) => c.epic_id === epicId && !doneColumnIds.has(c.column_id)).length;

  const selectedEpic = selectedEpicId ? epics.find((e) => e.id === selectedEpicId) : null;

  const openAutonomousDialog = () => {
    if (!selectedEpic) return;
    setAutonomousForm(epicToAutonomousForm(selectedEpic));
    setShowAutonomousDialog(true);
  };

  const closeAutonomousDialog = () => {
    if (autonomousSaving) return;
    setShowAutonomousDialog(false);
    setAutonomousForm(null);
  };

  const handleAutonomousFormChange = (patch) => {
    setAutonomousForm((prev) => ({ ...prev, ...patch }));
  };

  const handleSaveAutonomous = async () => {
    if (!selectedEpic || !autonomousForm || autonomousSaving) return;
    setAutonomousSaving(true);
    try {
      await api.updateEpic(
        projectId,
        selectedEpic.id,
        epicFormToUpdateBody({
          name: selectedEpic.name,
          description: selectedEpic.description || '',
          color: selectedEpic.color,
          ...autonomousForm,
        }),
      );
      setShowAutonomousDialog(false);
      setAutonomousForm(null);
      fetchBoard();
    } catch (err) {
      console.error('Failed to save autonomous settings:', err);
    } finally {
      setAutonomousSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-gray-950 text-gray-500">
        <div className="h-8 w-8 rounded-full border-2 border-gray-700 border-t-indigo-500 animate-spin" />
        <p className="text-sm">Loading board…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-950 text-gray-400">
        <div className="text-center max-w-sm px-6">
          <p className="mb-1 text-base font-medium text-gray-200">Failed to load board</p>
          <p className="text-sm text-gray-500">{error}</p>
          <button
            onClick={() => {
              setLoading(true);
              fetchBoard();
            }}
            className="mt-5 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm text-gray-200 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-gray-950 min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.06] bg-gray-950/90 backdrop-blur-sm">
        <div className="flex items-center gap-3 min-w-0">
          {project?.color && (
            <span
              className="w-2.5 h-2.5 rounded-full block flex-shrink-0 ring-2 ring-white/10"
              style={{ backgroundColor: project.color }}
            />
          )}
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-gray-100 truncate">
              {project?.name || 'Project'}
            </h1>
            <p className="text-xs text-gray-500">
              {cards.length} card{cards.length !== 1 ? 's' : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onOpenEpics ? (
            <button
              type="button"
              onClick={onOpenEpics}
              className="flex items-center gap-1.5 h-9 px-3 rounded-lg text-xs font-medium text-gray-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] transition-colors"
              data-testid="open-epics-screen"
            >
              <Target size={14} />
              Epics
            </button>
          ) : null}
          <button
            onClick={() => {
              const target = columns.find((c) => c.name.toLowerCase() !== 'backlog') || columns[0];
              if (target) setAddingInColumn(target.id);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium transition-colors shadow-sm shadow-indigo-900/30"
          >
            <Plus size={14} />
            Add card
          </button>
        </div>
      </div>

      {/* Search + epic filter */}
      <div className="px-5 py-2.5 border-b border-white/[0.06] bg-gray-950/60 flex items-center gap-3 flex-wrap">
        <div className="relative max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search cards…"
            className="bg-white/[0.04] border border-white/[0.08] text-sm text-gray-100 rounded-lg pl-9 pr-8 h-9 w-52 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 focus:border-indigo-500/50 placeholder-gray-500 transition-colors"
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

        <EpicFilterDropdown
          epics={epics}
          selectedEpicId={selectedEpicId}
          onSelect={setSelectedEpicId}
          epicCardCount={epicCardCount}
        />

        {selectedEpic ? (
          <button
            type="button"
            onClick={openAutonomousDialog}
            data-testid="open-autonomous-dialog"
            className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-xs font-medium border transition-colors ${
              selectedEpic.autonomous === 1
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15'
                : 'border-white/[0.08] bg-white/[0.04] text-gray-400 hover:text-gray-200 hover:bg-white/[0.06]'
            }`}
          >
            <Zap size={14} className={selectedEpic.autonomous === 1 ? 'text-emerald-400' : ''} />
            Autonomous
          </button>
        ) : null}
      </div>

      <EpicAutonomousDialog
        open={showAutonomousDialog}
        epic={selectedEpic}
        form={autonomousForm || epicToAutonomousForm(selectedEpic || {})}
        onChange={handleAutonomousFormChange}
        modelConfig={modelConfig}
        saving={autonomousSaving}
        onSave={handleSaveAutonomous}
        onClose={closeAutonomousDialog}
      />

      {/* Board */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden p-5 min-w-0">
        <div className="flex gap-3.5 h-full w-full min-w-0 pb-1">
          {columns.map((col) => {
            const colCards = cardsForColumn(col.id);
            const isDragOver = dragOverColumn === col.id;
            const columnColor = col.color || '#6b7280';

            return (
              <div
                key={col.id}
                className={`flex flex-col flex-1 min-w-[220px] h-full min-h-0 rounded-xl border transition-all duration-150 ${
                  isDragOver
                    ? 'border-indigo-500/40 bg-indigo-500/[0.06] ring-1 ring-indigo-500/30'
                    : 'border-white/[0.06] bg-white/[0.02]'
                }`}
                onDragOver={(e) => handleColumnDragOver(e, col.id)}
                onDragLeave={handleColumnDragLeave}
                onDrop={(e) => handleColumnDrop(e, col.id)}
              >
                {/* Column header */}
                <div className="px-3.5 py-3 border-b border-white/[0.05]">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: columnColor }}
                      />
                      <span className="text-xs font-semibold uppercase tracking-wide text-gray-300 truncate">
                        {col.name}
                      </span>
                    </div>
                    <span className="text-[11px] font-medium text-gray-500 bg-white/[0.05] px-2 py-0.5 rounded-full tabular-nums flex-shrink-0">
                      {colCards.length}
                    </span>
                  </div>
                </div>

                {/* Cards */}
                <div className="flex-1 overflow-y-auto kanban-column-scroll px-2.5 py-2 space-y-2">
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
                      <div key={card.id} data-testid={`card-wrapper-${card.id}`} className="w-full">
                        {showTopIndicator && (
                          <div
                            className="h-0.5 bg-indigo-400 rounded-full mb-1.5 shadow-[0_0_8px_rgba(129,140,248,0.6)]"
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
                          className={`group w-full rounded-xl border border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.05] hover:border-white/[0.12] hover:shadow-lg hover:shadow-black/25 cursor-grab active:cursor-grabbing transition-all duration-150 border-l-[3px] ${
                            PRIORITY_ACCENT[card.priority] || PRIORITY_ACCENT.medium
                          } ${dragCardId === card.id ? 'opacity-40 scale-[0.98]' : ''}`}
                        >
                          <div className="flex items-start gap-1.5 p-3">
                            <GripVertical
                              size={14}
                              className="text-gray-600 mt-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                            />
                            <div className="flex-1 min-w-0 -ml-1 group-hover:ml-0 transition-all">
                              <span
                                className="block text-[13px] font-medium text-gray-100 leading-snug break-words"
                                data-testid="card-title"
                              >
                                {card.title}
                              </span>
                              <div className="flex items-center gap-1 flex-wrap mt-2">
                                {card.priority && (
                                  <span
                                    className={`inline-block text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded-md ${
                                      PRIORITY_STYLES[card.priority] || PRIORITY_STYLES.medium
                                    }`}
                                  >
                                    {card.priority}
                                  </span>
                                )}
                                {hasUnresolvedBlockers(card) && (
                                  <span
                                    className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-red-500/10 text-red-300 ring-1 ring-inset ring-red-500/20"
                                    title={`Blocked by ${card.blockers.filter((b) => !b.done).length} unresolved card(s)`}
                                    data-testid="card-blocker-badge"
                                  >
                                    <Lock size={10} />
                                    {card.blockers.filter((b) => !b.done).length}
                                  </span>
                                )}
                                {cardEpic && (
                                  <span
                                    className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-md max-w-full"
                                    style={{
                                      backgroundColor: `${cardEpic.color}18`,
                                      color: cardEpic.color,
                                      boxShadow: `inset 0 0 0 1px ${cardEpic.color}30`,
                                    }}
                                  >
                                    <span
                                      className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                                      style={{ backgroundColor: cardEpic.color }}
                                    />
                                    <span className="truncate">{cardEpic.name}</span>
                                  </span>
                                )}
                              </div>
                              {(card.pr_url ||
                                card.review_status ||
                                card.session_id ||
                                card.assignee ||
                                (card.labels &&
                                  card.labels.split(',').filter(Boolean).length > 0)) && (
                                <div className="flex items-center gap-1.5 mt-2.5 pt-2.5 border-t border-white/[0.05] flex-wrap">
                                  {card.pr_url &&
                                    (/^https?:\/\//i.test(card.pr_url) ? (
                                      <a
                                        href={card.pr_url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={(e) => e.stopPropagation()}
                                        className="text-[11px] text-gray-500 hover:text-indigo-300 flex items-center gap-1 transition-colors"
                                        title={card.pr_url}
                                      >
                                        <GitPullRequest size={12} />#
                                        {card.pr_url.match(/\d+$/)?.[0] || 'PR'}
                                      </a>
                                    ) : (
                                      /* Agent Hub-native PR (relative client
                                         route) — no external tab; the Pull
                                         Requests page shows it in-app. */
                                      <span
                                        onClick={(e) => e.stopPropagation()}
                                        className="text-[11px] text-gray-500 flex items-center gap-1"
                                        title={card.pr_url}
                                      >
                                        <GitPullRequest size={12} />#
                                        {card.pr_url.match(/\d+$/)?.[0] || 'PR'}
                                      </span>
                                    ))}
                                  {card.review_status && (
                                    <span
                                      className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md ${
                                        card.review_status === 'approved'
                                          ? 'bg-emerald-500/10 text-emerald-300 ring-1 ring-inset ring-emerald-500/25'
                                          : card.review_status === 'reviewing'
                                            ? 'bg-amber-500/10 text-amber-300 ring-1 ring-inset ring-amber-500/25 animate-pulse'
                                            : card.review_status === 'changes_requested'
                                              ? 'bg-red-500/10 text-red-300 ring-1 ring-inset ring-red-500/25'
                                              : 'bg-sky-500/10 text-sky-300 ring-1 ring-inset ring-sky-500/25'
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
                                  {/* Finalize Code Changes status badge — renders only
                                    when the card's session has an active or recent
                                    Finalize run. The badge surfaces phase + active
                                    time (with wall-clock in the tooltip) so the
                                    user can see at a glance whether the run is
                                    progressing or paused waiting on a session.

                                    `card.finalize_run` is folded into the board
                                    payload server-side (see server/routes/board.ts
                                    + listLatestFinalizeRunsForBoard). Passing it
                                    as `prefetchedRun` tells useFinalizeRun to skip
                                    its initial REST call entirely — both when the
                                    value is a row and when it's `null` (the
                                    server already checked, there is nothing to
                                    load). This eliminates the per-card GET
                                    fan-out that PR #1169 reviewer flagged.
                                    Live updates still flow through the WebSocket
                                    bridge in App.jsx. */}
                                  {card.session_id && (
                                    <FinalizeCardBadge
                                      sessionId={card.session_id}
                                      prefetchedRun={card.finalize_run ?? null}
                                    />
                                  )}
                                  {card.assignee && (
                                    <span
                                      className={`text-[11px] font-medium ${card.session_id ? 'text-indigo-300' : 'text-gray-400'}`}
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
                                          className="text-[10px] font-medium bg-white/[0.06] text-gray-400 px-1.5 py-0.5 rounded-md"
                                        >
                                          {label.trim()}
                                        </span>
                                      ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                        {showBottomIndicator && (
                          <div
                            className="h-0.5 bg-indigo-400 rounded-full mt-1.5 shadow-[0_0_8px_rgba(129,140,248,0.6)]"
                            data-testid={`drop-indicator-bottom-${card.id}`}
                          />
                        )}
                      </div>
                    );
                  })}

                  {/* Inline add form */}
                  {addingInColumn === col.id && (
                    <div className="w-full rounded-xl p-3 bg-white/[0.04] border border-indigo-500/30">
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
                        placeholder="Card title…"
                        className="w-full bg-gray-950/80 border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500/50 mb-2.5"
                      />
                      <div className="flex items-center gap-2">
                        <select
                          value={newCardPriority}
                          onChange={(e) => setNewCardPriority(e.target.value)}
                          className="bg-gray-950/80 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-gray-200 focus:outline-none"
                        >
                          {PRIORITIES.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => handleAddCard(col.id)}
                          className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg transition-colors"
                        >
                          Add
                        </button>
                        <button
                          onClick={() => {
                            setAddingInColumn(null);
                            setNewCardTitle('');
                          }}
                          className="p-1.5 text-gray-500 hover:text-gray-200 rounded-md hover:bg-white/[0.06]"
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
                    className="flex items-center gap-1.5 mx-2.5 mb-2.5 px-2.5 py-2 text-xs font-medium text-gray-500 hover:text-gray-300 hover:bg-white/[0.04] rounded-lg transition-colors"
                  >
                    <Plus size={12} />
                    Add card
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
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setSelectedCard(null)}
          />
          {/* Panel */}
          <div className="relative w-full max-w-6xl h-[85vh] bg-gray-950 border border-white/10 rounded-2xl flex flex-col overflow-hidden shadow-2xl shadow-black/50">
            {/* Header */}
            <div className="shrink-0 flex items-center justify-between px-6 py-3.5 border-b border-white/[0.06] bg-gray-950/95">
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <span className="font-medium uppercase tracking-wide">Card</span>
                {selectedCard?.id && (
                  <span className="font-mono text-gray-600 bg-white/[0.04] px-1.5 py-0.5 rounded">
                    #{String(selectedCard.id).slice(0, 8)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSaveDetail}
                  disabled={saving}
                  className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-600/50 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={() => setSelectedCard(null)}
                  className="p-1.5 text-gray-500 hover:text-gray-200 hover:bg-white/[0.06] rounded-lg transition-colors"
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
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Description
                      </label>
                      {descriptionEditing ? (
                        <button
                          type="button"
                          onClick={() => setDescriptionEditing(false)}
                          className="shrink-0 text-xs font-medium text-indigo-400 hover:text-indigo-300"
                        >
                          Preview
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setDescriptionEditing(true)}
                          className="shrink-0 text-xs font-medium text-indigo-400 hover:text-indigo-300"
                        >
                          Edit
                        </button>
                      )}
                    </div>
                    {descriptionEditing ? (
                      <textarea
                        data-testid="card-description-editor"
                        value={detailForm.description}
                        onChange={(e) =>
                          setDetailForm((f) => ({ ...f, description: e.target.value }))
                        }
                        rows={18}
                        placeholder="Add a description — problem, acceptance criteria, context..."
                        className="w-full bg-gray-950/60 border border-gray-800 rounded-lg px-4 py-3 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-600 resize-y min-h-[320px] leading-relaxed font-sans"
                      />
                    ) : (
                      <div
                        data-testid="card-description-preview"
                        className="w-full min-h-[200px] max-h-[min(480px,55vh)] overflow-y-auto rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3 text-sm text-gray-200 leading-relaxed"
                      >
                        {detailForm.description?.trim() ? (
                          <div className="markdown-content">
                            <MarkdownContent content={detailForm.description} />
                          </div>
                        ) : (
                          <p className="text-gray-500 italic">No description yet.</p>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Sidebar: metadata */}
                <aside className="flex flex-col gap-5 lg:border-l lg:border-white/[0.06] lg:pl-6">
                  {/* Session replay (carried over from a converted bug ticket) */}
                  {cardReplay?.replayId ? (
                    <div>
                      <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                        Session replay
                      </label>
                      <button
                        type="button"
                        onClick={() => setWatchingReplay(true)}
                        data-testid="card-watch-replay-button"
                        className="inline-flex items-center gap-1.5 w-full justify-center text-xs bg-blue-600/90 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg transition-colors"
                      >
                        <PlayCircle size={13} />
                        Watch replay
                      </button>
                    </div>
                  ) : null}

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
                        {/* Engine + model override display/edit for assigned cards.
                            The engine selector lists every engine the user is
                            authed for (modelConfig.engineValidModels keys
                            with non-empty model lists). When unset, the
                            spawn falls back to the assignee agent's shared
                            engine — same behaviour as before this picker
                            shipped. Changing the engine clears the model
                            selection so we can't save a model that's not
                            valid for the chosen engine. */}
                        {modelConfig &&
                          (() => {
                            const selAgent = agents.find(
                              (a) => a.name === (selectedCard.assignee || detailForm.assignee),
                            );
                            const agentEng = selAgent?.engine || 'claude-code';
                            const engineEntries = Object.entries(
                              modelConfig.engineValidModels || {},
                            ).filter(([, models]) => (models?.length ?? 0) > 0);
                            const effectiveEngine =
                              (detailForm.assign_engine && detailForm.assign_engine.trim()) ||
                              agentEng;
                            const modelOpts =
                              modelConfig.engineValidModels?.[effectiveEngine] || [];
                            if (engineEntries.length === 0 && modelOpts.length === 0) return null;
                            const engineChanged =
                              (detailForm.assign_engine || '') !==
                              (selectedCard.assign_engine || '');
                            const modelChanged =
                              (detailForm.assign_model || '') !== (selectedCard.assign_model || '');
                            return (
                              <div className="mb-3 space-y-2">
                                {engineEntries.length > 0 && (
                                  <div>
                                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
                                      Session engine
                                    </label>
                                    <select
                                      data-testid="card-engine-select"
                                      value={detailForm.assign_engine || ''}
                                      onChange={(e) =>
                                        setDetailForm((f) => ({
                                          ...f,
                                          assign_engine: e.target.value,
                                          // Reset the model whenever the
                                          // engine changes — a saved
                                          // claude-code model is invalid
                                          // under codex-cli.
                                          assign_model: '',
                                        }))
                                      }
                                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500"
                                    >
                                      <option value="">Agent default ({agentEng})</option>
                                      {engineEntries.map(([eng]) => (
                                        <option key={eng} value={eng}>
                                          {eng}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                )}
                                {modelOpts.length > 0 && (
                                  <div>
                                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
                                      Session model
                                    </label>
                                    <select
                                      data-testid="card-model-select"
                                      value={detailForm.assign_model || ''}
                                      onChange={(e) =>
                                        setDetailForm((f) => ({
                                          ...f,
                                          assign_model: e.target.value,
                                        }))
                                      }
                                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500"
                                    >
                                      <option value="">Engine default</option>
                                      {modelOpts.map((m) => (
                                        <option key={m} value={m}>
                                          {m}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                )}
                                {(engineChanged || modelChanged) && (
                                  <button
                                    onClick={async () => {
                                      setSaving(true);
                                      try {
                                        await api.updateCard(projectId, selectedCard.id, {
                                          assign_engine: detailForm.assign_engine || null,
                                          assign_model: detailForm.assign_model || null,
                                        });
                                        setSelectedCard((c) => ({
                                          ...c,
                                          assign_engine: detailForm.assign_engine || null,
                                          assign_model: detailForm.assign_model || null,
                                        }));
                                        fetchBoard();
                                      } catch (err) {
                                        console.error(
                                          'Failed to update engine/model override:',
                                          err,
                                        );
                                      } finally {
                                        setSaving(false);
                                      }
                                    }}
                                    disabled={saving}
                                    className="w-full text-xs bg-indigo-700 hover:bg-indigo-600 text-white px-3 py-1 rounded-lg transition-colors disabled:opacity-50"
                                  >
                                    {saving ? 'Saving…' : 'Save override'}
                                  </button>
                                )}
                              </div>
                            );
                          })()}
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
                              assign_engine: selectedCard.assign_engine || '',
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
                              setDetailForm((f) => ({
                                ...f,
                                assignee: '',
                                assign_model: '',
                                assign_engine: '',
                              }));
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
                              assign_engine: '',
                            }))
                          }
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500"
                        >
                          <option value="">Unassigned</option>
                          {projectAgents.map((a) => (
                            <option key={a.id} value={a.name}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                        {detailForm.assignee &&
                          modelConfig &&
                          (() => {
                            const selAgent = agents.find((a) => a.name === detailForm.assignee);
                            const agentEng = selAgent?.engine || 'claude-code';
                            const engineEntries = Object.entries(
                              modelConfig.engineValidModels || {},
                            ).filter(([, models]) => (models?.length ?? 0) > 0);
                            const effectiveEngine =
                              (detailForm.assign_engine && detailForm.assign_engine.trim()) ||
                              agentEng;
                            const modelOpts =
                              modelConfig.engineValidModels?.[effectiveEngine] || [];
                            if (engineEntries.length === 0 && modelOpts.length === 0) return null;
                            return (
                              <>
                                {engineEntries.length > 0 && (
                                  <div className="mt-2">
                                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                                      Session engine
                                    </label>
                                    <select
                                      data-testid="card-engine-select-new"
                                      value={detailForm.assign_engine || ''}
                                      onChange={(e) =>
                                        setDetailForm((f) => ({
                                          ...f,
                                          assign_engine: e.target.value,
                                          assign_model: '',
                                        }))
                                      }
                                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500"
                                    >
                                      <option value="">Agent default ({agentEng})</option>
                                      {engineEntries.map(([eng]) => (
                                        <option key={eng} value={eng}>
                                          {eng}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                )}
                                {modelOpts.length > 0 && (
                                  <div className="mt-2">
                                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                                      Session model
                                    </label>
                                    <select
                                      data-testid="card-model-select-new"
                                      value={detailForm.assign_model || ''}
                                      onChange={(e) =>
                                        setDetailForm((f) => ({
                                          ...f,
                                          assign_model: e.target.value,
                                        }))
                                      }
                                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500"
                                    >
                                      <option value="">Engine default</option>
                                      {modelOpts.map((m) => (
                                        <option key={m} value={m}>
                                          {m}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                )}
                              </>
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
                                if (detailForm.assign_engine?.trim())
                                  assignOpts.engine = detailForm.assign_engine.trim();
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

      {/* Session replay player — sandboxed rrweb-player over the card's replay */}
      {watchingReplay && cardReplay?.replayId && (
        <ReplayPlayerModal
          replayId={cardReplay.replayId}
          title={selectedCard ? `Replay · ${selectedCard.title}` : 'Session replay'}
          onClose={() => setWatchingReplay(false)}
        />
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
