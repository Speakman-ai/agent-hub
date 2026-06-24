import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../utils/api';
import { filterAgentsByProject } from '../utils/kanbanAgents';

export function buildDetailFormFromCard(card: any) {
  return {
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
    auto_merge: card.auto_merge === 1,
    auto_merge_touched: card.auto_merge === 1 || card.auto_merge === 0,
    assign_comment: '',
  };
}

type UseKanbanCardDetailOptions = {
  projectId: string;
  agents?: any[];
  epics?: any[];
  cards: any[];
  modelConfig?: any;
  onRefresh?: () => Promise<any[] | undefined | void>;
  onNavigateToSession?: (agentId: string, sessionId: string) => void;
};

export function useKanbanCardDetail({
  projectId,
  agents = [],
  epics = [],
  cards,
  modelConfig: externalModelConfig,
  onRefresh,
  onNavigateToSession,
}: UseKanbanCardDetailOptions) {
  const projectAgents = useMemo(
    () => filterAgentsByProject(agents, projectId),
    [agents, projectId],
  );

  const [selectedCard, setSelectedCard] = useState<any>(null);
  const [detailForm, setDetailForm] = useState<Record<string, any>>({});
  const [comments, setComments] = useState<any[]>([]);
  const [cardReplay, setCardReplay] = useState<any>(null);
  const [watchingReplay, setWatchingReplay] = useState(false);
  const [newComment, setNewComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [showReassign, setShowReassign] = useState(false);
  const [unassigning, setUnassigning] = useState(false);
  const [showBlockerPicker, setShowBlockerPicker] = useState(false);
  const [blockerPickerQuery, setBlockerPickerQuery] = useState('');
  const [blockerError, setBlockerError] = useState<any>(null);
  const [descriptionEditing, setDescriptionEditing] = useState(false);
  const [modelConfig, setModelConfig] = useState<any>(externalModelConfig ?? null);

  useEffect(() => {
    if (externalModelConfig !== undefined) {
      setModelConfig(externalModelConfig);
    }
  }, [externalModelConfig]);

  useEffect(() => {
    if (externalModelConfig !== undefined) return;
    if (typeof api.getModelConfig !== 'function') return;
    api
      .getModelConfig()
      .then(setModelConfig)
      .catch(() => setModelConfig(null));
  }, [externalModelConfig]);

  const closeDetail = useCallback(() => setSelectedCard(null), []);

  const openDetail = useCallback((card: any) => {
    setSelectedCard(card);
    setDetailForm(buildDetailFormFromCard(card));
    setConfirmDelete(false);
    setNewComment('');
    setShowReassign(false);
    setShowBlockerPicker(false);
    setBlockerPickerQuery('');
    setBlockerError(null);
    setDescriptionEditing(false);
  }, []);

  const refreshSelectedCard = useCallback(
    async (cardId: string) => {
      if (!onRefresh) return;
      const fresh = await onRefresh();
      if (!fresh) return;
      const refreshed = fresh.find((c: any) => c.id === cardId);
      if (refreshed) setSelectedCard(refreshed);
    },
    [onRefresh],
  );

  useEffect(() => {
    if (!selectedCard) return;
    api
      .getCardComments(projectId, selectedCard.id)
      .then(setComments)
      .catch(() => setComments([]));
  }, [selectedCard, projectId]);

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
      .then((r: any) => {
        if (!cancelled) setCardReplay(r?.replayId ? r : null);
      })
      .catch(() => {
        if (!cancelled) setCardReplay(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCard, projectId]);

  useEffect(() => {
    if (!selectedCard) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDetail();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedCard, closeDetail]);

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
      await onRefresh?.();
      closeDetail();
    } catch (err: any) {
      console.error('Failed to save card:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteCard = async () => {
    if (!selectedCard) return;
    try {
      await api.deleteCard(projectId, selectedCard.id);
      closeDetail();
      setConfirmDelete(false);
      await onRefresh?.();
    } catch (err: any) {
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
    } catch (err: any) {
      console.error('Failed to add comment:', err);
    }
  };

  const handleAddBlocker = async (blockedByCardId: string) => {
    if (!selectedCard || !blockedByCardId) return;
    setBlockerError(null);
    try {
      await api.addCardBlocker(projectId, selectedCard.id, blockedByCardId);
      setShowBlockerPicker(false);
      setBlockerPickerQuery('');
      await refreshSelectedCard(selectedCard.id);
    } catch (err: any) {
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

  const handleRemoveBlocker = async (blockedByCardId: string) => {
    if (!selectedCard || !blockedByCardId) return;
    setBlockerError(null);
    try {
      await api.removeCardBlocker(projectId, selectedCard.id, blockedByCardId);
      await refreshSelectedCard(selectedCard.id);
    } catch {
      setBlockerError('Failed to remove blocker.');
    }
  };

  const handleLinkCardEpic = async (epicId: string) => {
    if (!selectedCard) return;
    try {
      // Changing the epic must also drop any phase, since a phase belongs to
      // exactly one epic. Route through the reconciled update-card path (not
      // the legacy `linkCardToEpic`, which only touches `epic_id`) so the card
      // can't become split-scoped — appearing under the new epic while still
      // dispatchable by the old epic's phase runner.
      await api.updateCard(projectId, selectedCard.id, { epicId: epicId || null, phaseId: null });
      setDetailForm((f: any) => ({ ...f, epic_id: epicId || '', phase_id: '' }));
      await onRefresh?.();
    } catch (err: any) {
      console.error('Failed to link epic:', err);
    }
  };

  return {
    selectedCard,
    setSelectedCard,
    openDetail,
    closeDetail,
    detailForm,
    setDetailForm,
    comments,
    cardReplay,
    watchingReplay,
    setWatchingReplay,
    newComment,
    setNewComment,
    saving,
    setSaving,
    confirmDelete,
    setConfirmDelete,
    assigning,
    setAssigning,
    showReassign,
    setShowReassign,
    unassigning,
    setUnassigning,
    showBlockerPicker,
    setShowBlockerPicker,
    blockerPickerQuery,
    setBlockerPickerQuery,
    blockerError,
    setBlockerError,
    descriptionEditing,
    setDescriptionEditing,
    modelConfig,
    projectAgents,
    epics,
    cards,
    handleSaveDetail,
    handleDeleteCard,
    handleAddComment,
    handleAddBlocker,
    handleRemoveBlocker,
    handleLinkCardEpic,
    onRefresh,
    onNavigateToSession,
    projectId,
  };
}

export type KanbanCardDetailState = ReturnType<typeof useKanbanCardDetail>;
