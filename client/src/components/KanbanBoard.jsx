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
} from 'lucide-react';
import { api } from '../utils/api.js';

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

  const addTitleRef = useRef(null);

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
  const handleDragStart = (e, cardId) => {
    setDragCardId(cardId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', cardId);
  };

  const handleDragOver = (e, columnId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverColumn(columnId);
  };

  const handleDragLeave = (e, _columnId) => {
    if (e.currentTarget && !e.currentTarget.contains(e.relatedTarget)) {
      setDragOverColumn(null);
    }
  };

  const handleDrop = async (e, columnId) => {
    e.preventDefault();
    setDragOverColumn(null);
    const cardId = e.dataTransfer.getData('text/plain') || dragCardId;
    if (!cardId) return;
    setDragCardId(null);

    const card = cards.find((c) => c.id === cardId || c.id === Number(cardId));
    if (!card || card.column_id === columnId) return;

    const colCards = cardsForColumn(columnId);
    const newPosition = colCards.length;
    setCards((prev) =>
      prev.map((c) =>
        c.id === card.id ? { ...c, column_id: columnId, position: newPosition } : c,
      ),
    );

    try {
      await api.moveCard(projectId, card.id, { columnId, position: newPosition });
    } catch {
      fetchBoard();
    }
  };

  const handleDragEnd = () => {
    setDragCardId(null);
    setDragOverColumn(null);
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
      labels: card.labels || '',
      github_issue_url: card.github_issue_url || '',
      pr_url: card.pr_url || '',
      epic_id: card.epic_id || '',
    });
    setConfirmDelete(false);
    setNewComment('');
    setShowReassign(false);
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
      await api.updateEpic(projectId, editingEpic.id, epicForm);
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
                onDragOver={(e) => handleDragOver(e, col.id)}
                onDragLeave={(e) => handleDragLeave(e, col.id)}
                onDrop={(e) => handleDrop(e, col.id)}
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
                    return (
                      <div
                        key={card.id}
                        draggable
                        onDragStart={(e) => handleDragStart(e, card.id)}
                        onDragEnd={handleDragEnd}
                        onClick={() => openDetail(card)}
                        className={`rounded-lg p-3 bg-gray-800 border border-gray-700 hover:border-gray-600 cursor-grab active:cursor-grabbing transition-colors ${
                          dragCardId === card.id ? 'opacity-50' : ''
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <GripVertical size={14} className="text-gray-600 mt-0.5 flex-shrink-0" />
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
                          onClick={() => setShowReassign(true)}
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
                              setDetailForm((f) => ({ ...f, assignee: '' }));
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
                            setDetailForm((f) => ({ ...f, assignee: e.target.value }))
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
                        {detailForm.assignee && (
                          <button
                            onClick={async () => {
                              const agent = agents.find((a) => a.name === detailForm.assignee);
                              if (!agent) return;
                              setAssigning(true);
                              try {
                                const result = await api.assignCard(
                                  projectId,
                                  selectedCard.id,
                                  agent.id,
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
    </div>
  );
}
