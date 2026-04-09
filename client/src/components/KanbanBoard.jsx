import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, GripVertical, MoreHorizontal, X, MessageSquare, ExternalLink, Trash2 } from 'lucide-react';
import { api } from '../utils/api.js';

const PRIORITY_STYLES = {
  urgent: 'bg-red-500/20 text-red-400',
  high: 'bg-orange-500/20 text-orange-400',
  medium: 'bg-blue-500/20 text-blue-400',
  low: 'bg-gray-500/20 text-gray-400',
};

const PRIORITIES = ['urgent', 'high', 'medium', 'low'];

export default function KanbanBoard({ projectId, project, agents = [], refreshKey }) {
  const [board, setBoard] = useState(null);
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

  const addTitleRef = useRef(null);

  const fetchBoard = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await api.getBoard(projectId);
      setBoard(data.board);
      setColumns(data.columns);
      setCards(data.cards);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    fetchBoard();
  }, [fetchBoard, refreshKey]);

  // Focus title input when add form opens
  useEffect(() => {
    if (addingInColumn && addTitleRef.current) {
      addTitleRef.current.focus();
    }
  }, [addingInColumn]);

  // Load comments when card selected
  useEffect(() => {
    if (!selectedCard) return;
    api.getCardComments(projectId, selectedCard.id)
      .then(setComments)
      .catch(() => setComments([]));
  }, [selectedCard, projectId]);

  const cardsForColumn = (columnId) =>
    cards
      .filter((c) => c.column_id === columnId)
      .sort((a, b) => a.position - b.position);

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

  const handleDragLeave = (e, columnId) => {
    // Only clear if we're truly leaving the column
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

    // Optimistic update
    const colCards = cardsForColumn(columnId);
    const newPosition = colCards.length;
    setCards((prev) =>
      prev.map((c) =>
        c.id === card.id ? { ...c, column_id: columnId, position: newPosition } : c
      )
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
      await api.createCard(projectId, {
        title: newCardTitle.trim(),
        priority: newCardPriority,
        columnId,
        createdBy: 'user',
      });
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
      });
      fetchBoard();
      setSelectedCard((prev) => ({ ...prev, ...detailForm }));
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
    });
    setConfirmDelete(false);
    setNewComment('');
  };

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
            onClick={() => { setLoading(true); fetchBoard(); }}
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
          <h1 className="text-lg font-semibold text-white">
            {project?.name || 'Project'} Board
          </h1>
          <span className="text-sm text-gray-500">
            {cards.length} card{cards.length !== 1 ? 's' : ''}
          </span>
        </div>
        <button
          onClick={() => {
            // Open add form in the first non-backlog column, or first column
            const target = columns.find((c) => c.name.toLowerCase() !== 'backlog') || columns[0];
            if (target) setAddingInColumn(target.id);
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white rounded-lg text-sm transition-colors"
        >
          <Plus size={14} />
          Add Card
        </button>
      </div>

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
                    <span className="text-sm font-semibold text-gray-300">
                      {col.name}
                    </span>
                    <span className="text-xs text-gray-500">({colCards.length})</span>
                  </div>
                </div>

                {/* Cards */}
                <div className="flex-1 overflow-y-auto px-2 py-1 space-y-2">
                  {colCards.map((card) => (
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
                          {card.priority && (
                            <span
                              className={`inline-block text-xs px-1.5 py-0.5 rounded-full mb-1 ${
                                PRIORITY_STYLES[card.priority] || PRIORITY_STYLES.medium
                              }`}
                            >
                              {card.priority}
                            </span>
                          )}
                          {card.description && (
                            <p className="text-xs text-gray-500 line-clamp-2 mt-1">
                              {card.description}
                            </p>
                          )}
                          <div className="flex items-center gap-2 mt-2 flex-wrap">
                            {card.assignee && (
                              <span className="text-xs text-gray-400">{card.assignee}</span>
                            )}
                            {card.labels &&
                              card.labels.split(',').filter(Boolean).map((label) => (
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
                  ))}

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
                            <option key={p} value={p}>{p}</option>
                          ))}
                        </select>
                        <button
                          onClick={() => handleAddCard(col.id)}
                          className="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded transition-colors"
                        >
                          Add
                        </button>
                        <button
                          onClick={() => { setAddingInColumn(null); setNewCardTitle(''); }}
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

      {/* Card Detail Panel (slide-over) */}
      {selectedCard && (
        <div className="fixed inset-0 z-50 flex justify-end">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setSelectedCard(null)}
          />
          {/* Panel */}
          <div className="relative w-full max-w-lg bg-gray-900 border-l border-gray-800 overflow-y-auto">
            <div className="p-6">
              {/* Header */}
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-semibold text-white">Card Details</h2>
                <button
                  onClick={() => setSelectedCard(null)}
                  className="text-gray-500 hover:text-gray-300"
                >
                  <X size={20} />
                </button>
              </div>

              {/* Title */}
              <label className="block text-xs text-gray-500 mb-1">Title</label>
              <input
                type="text"
                value={detailForm.title}
                onChange={(e) => setDetailForm((f) => ({ ...f, title: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500 mb-4"
              />

              {/* Description */}
              <label className="block text-xs text-gray-500 mb-1">Description</label>
              <textarea
                value={detailForm.description}
                onChange={(e) => setDetailForm((f) => ({ ...f, description: e.target.value }))}
                rows={4}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500 mb-4 resize-none"
              />

              {/* Priority */}
              <label className="block text-xs text-gray-500 mb-1">Priority</label>
              <select
                value={detailForm.priority}
                onChange={(e) => setDetailForm((f) => ({ ...f, priority: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500 mb-4"
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>

              {/* Assignee */}
              <label className="block text-xs text-gray-500 mb-1">Assignee</label>
              <select
                value={detailForm.assignee}
                onChange={(e) => setDetailForm((f) => ({ ...f, assignee: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500 mb-4"
              >
                <option value="">Unassigned</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.name}>{a.name}</option>
                ))}
              </select>

              {/* Labels */}
              <label className="block text-xs text-gray-500 mb-1">Labels (comma separated)</label>
              <input
                type="text"
                value={detailForm.labels}
                onChange={(e) => setDetailForm((f) => ({ ...f, labels: e.target.value }))}
                placeholder="bug, feature, docs"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-500 mb-4"
              />

              {/* GitHub URL */}
              <label className="block text-xs text-gray-500 mb-1">GitHub URL</label>
              <div className="flex items-center gap-2 mb-6">
                <input
                  type="text"
                  value={detailForm.github_issue_url}
                  onChange={(e) => setDetailForm((f) => ({ ...f, github_issue_url: e.target.value }))}
                  placeholder="https://github.com/..."
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-500"
                />
                {detailForm.github_issue_url && (
                  <a
                    href={detailForm.github_issue_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-gray-500 hover:text-gray-300"
                  >
                    <ExternalLink size={16} />
                  </a>
                )}
              </div>

              {/* Save */}
              <button
                onClick={handleSaveDetail}
                disabled={saving}
                className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white rounded-lg text-sm font-medium transition-colors mb-6"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>

              {/* Comments */}
              <div className="border-t border-gray-800 pt-4">
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
                      <p className="text-sm text-gray-400">{c.content}</p>
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

              {/* Delete */}
              <div className="border-t border-gray-800 pt-4 mt-6">
                {confirmDelete ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-red-400">Delete this card?</span>
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
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
