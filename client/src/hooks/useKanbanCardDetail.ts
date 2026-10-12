import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../utils/api';
import { filterAgentsByProject } from '../utils/kanbanAgents';
import {
  applyCardTemplateToDetailForm,
  type KanbanCardTemplate,
} from '@shared/utils/kanbanCardTemplates';
import { isPrematureDoneMoveError } from '@shared/utils/prematureDoneMove';

const DONE_STATE_CONTRACT_MARKER = 'done_state_contract_violation';

export type CardStatusError = {
  /** Card the failed move targeted; errors never render for (or retry against) another card. */
  cardId: string;
  columnId: string;
  message: string;
  /** True when the server's premature-Done guard rejected the move and a `force` retry is allowed. */
  canForce: boolean;
};

/** Append position for `cardId` at the end of `columnId`. */
export function endOfColumnPosition(cards: any[], columnId: string, cardId?: string): number {
  let max = -1;
  for (const c of cards) {
    if (c.column_id !== columnId || c.id === cardId) continue;
    if (typeof c.position === 'number' && c.position > max) max = c.position;
  }
  return max + 1;
}

export function buildDetailFormFromCard(card: any) {
  return {
    title: card.title || '',
    description: card.description || '',
    priority: card.priority || 'medium',
    assignee: card.assignee || '',
    assigned_user_id: card.assigned_user_id || '',
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

export function isDraftKanbanCard(card: any): boolean {
  return Boolean(card?.__draft);
}

type UseKanbanCardDetailOptions = {
  projectId: string;
  agents?: any[];
  epics?: any[];
  cards: any[];
  columns?: any[];
  modelConfig?: any;
  cardTemplates?: KanbanCardTemplate[];
  onRefresh?: () => Promise<any[] | undefined | void>;
  onNavigateToSession?: (agentId: string, sessionId: string) => void;
};

export function useKanbanCardDetail({
  projectId,
  agents = [],
  epics = [],
  cards,
  columns = [],
  modelConfig: externalModelConfig,
  cardTemplates = [],
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
  const [statusMovingCardId, setStatusMovingCardId] = useState<string | null>(null);
  const [statusErrorState, setStatusError] = useState<CardStatusError | null>(null);
  // Read in async move handlers to tell whether the dialog still shows the
  // card the request was made for.
  const selectedCardIdRef = useRef<string | null>(null);
  selectedCardIdRef.current = selectedCard?.id ?? null;

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
    setStatusError(null);
  }, []);

  const openCreateDetail = useCallback(
    (columnId: string, opts: { epicId?: string; template?: KanbanCardTemplate } = {}) => {
      let form = buildDetailFormFromCard({});
      if (opts.epicId) form.epic_id = opts.epicId;
      if (opts.template) form = applyCardTemplateToDetailForm(form, opts.template);
      setSelectedCard({ __draft: true, column_id: columnId });
      setDetailForm(form);
      setConfirmDelete(false);
      setNewComment('');
      setShowReassign(false);
      setShowBlockerPicker(false);
      setBlockerPickerQuery('');
      setBlockerError(null);
      setDescriptionEditing(Boolean(opts.template?.description?.trim()) || true);
      setComments([]);
      setCardReplay(null);
      setWatchingReplay(false);
      setStatusError(null);
    },
    [],
  );

  const applyCardTemplate = useCallback((template: KanbanCardTemplate) => {
    setDetailForm((form) => applyCardTemplateToDetailForm(form, template));
    setDescriptionEditing(Boolean(template.description?.trim()) || true);
  }, []);

  const isCreating = isDraftKanbanCard(selectedCard);

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
    if (!selectedCard || isDraftKanbanCard(selectedCard)) return;
    api
      .getCardComments(projectId, selectedCard.id)
      .then(setComments)
      .catch(() => setComments([]));
  }, [selectedCard, projectId]);

  useEffect(() => {
    if (!selectedCard || isDraftKanbanCard(selectedCard)) {
      if (!selectedCard) {
        setCardReplay(null);
        setWatchingReplay(false);
      }
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
    if (!detailForm.title?.trim()) return;
    setSaving(true);
    try {
      if (isDraftKanbanCard(selectedCard)) {
        if (!selectedCard.column_id) return;
        const created = await api.createCard(projectId, {
          title: detailForm.title.trim(),
          description: detailForm.description || null,
          priority: detailForm.priority,
          labels: detailForm.labels || null,
          columnId: selectedCard.column_id,
          createdBy: 'user',
          epicId: detailForm.epic_id || null,
          githubIssueUrl: detailForm.github_issue_url || null,
          assignee: detailForm.assignee || null,
          assignedUserId: detailForm.assigned_user_id || null,
        });
        setSelectedCard(created);
        if (detailForm.pr_url?.trim()) {
          await api.updateCard(projectId, created.id, { prUrl: detailForm.pr_url.trim() });
        }
        await onRefresh?.();
        closeDetail();
        return;
      }

      await api.updateCard(projectId, selectedCard.id, {
        title: detailForm.title,
        description: detailForm.description,
        priority: detailForm.priority,
        assignee: detailForm.assignee,
        assignedUserId: detailForm.assigned_user_id || null,
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
    if (isDraftKanbanCard(selectedCard)) {
      setDetailForm((f: any) => ({ ...f, epic_id: epicId || '' }));
      return;
    }
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

  const moveCardToColumn = async (cardId: string, columnId: string, force: boolean) => {
    setStatusMovingCardId(cardId);
    setStatusError(null);
    try {
      const moved = await api.moveCard(projectId, cardId, {
        columnId,
        position: endOfColumnPosition(cards, columnId, cardId),
        ...(force ? { force: true } : {}),
      });
      setSelectedCard((c: any) =>
        c?.id === cardId ? { ...c, ...(moved || {}), column_id: columnId } : c,
      );
      await onRefresh?.();
    } catch (err: any) {
      // The user may have opened another card while this request was in
      // flight; its error (and force retry) must not land in that dialog.
      if (selectedCardIdRef.current !== cardId) return;
      const raw = String(err?.message || '');
      if (isPrematureDoneMoveError(err)) {
        setStatusError({
          cardId,
          columnId,
          canForce: true,
          message:
            'This card is linked to a session that has not pushed through Finalize yet. ' +
            'The platform moves it to Done when the merge lands.',
        });
      } else if (raw.includes(DONE_STATE_CONTRACT_MARKER)) {
        setStatusError({
          cardId,
          columnId,
          canForce: false,
          message:
            'A [Spec]/[Partial] card needs a comment listing its follow-up card IDs before it can move to Done.',
        });
      } else {
        setStatusError({ cardId, columnId, canForce: false, message: 'Failed to change status.' });
      }
    } finally {
      setStatusMovingCardId((cur) => (cur === cardId ? null : cur));
    }
  };

  // Status changes persist immediately (like the epic picker) rather than
  // waiting for Save, so the dialog can mark a card Done in one step.
  const handleChangeStatus = async (columnId: string) => {
    if (!selectedCard || !columnId) return;
    if (isDraftKanbanCard(selectedCard)) {
      setSelectedCard((c: any) => ({ ...c, column_id: columnId }));
      return;
    }
    if (columnId === selectedCard.column_id) return;
    await moveCardToColumn(selectedCard.id, columnId, false);
  };

  const statusError =
    statusErrorState && statusErrorState.cardId === selectedCard?.id ? statusErrorState : null;
  const statusMoving = statusMovingCardId !== null && statusMovingCardId === selectedCard?.id;

  // Replays the rejected move with `force` against the card that failed,
  // and only while that card is still the one on screen.
  const handleForceStatus = async () => {
    const pending = statusError;
    if (!pending?.canForce) return;
    await moveCardToColumn(pending.cardId, pending.columnId, true);
  };

  return {
    selectedCard,
    setSelectedCard,
    openDetail,
    openCreateDetail,
    applyCardTemplate,
    isCreating,
    cardTemplates,
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
    columns,
    handleSaveDetail,
    handleDeleteCard,
    handleAddComment,
    handleAddBlocker,
    handleRemoveBlocker,
    handleLinkCardEpic,
    handleChangeStatus,
    handleForceStatus,
    statusMoving,
    statusError,
    setStatusError,
    onRefresh,
    onNavigateToSession,
    projectId,
  };
}

export type KanbanCardDetailState = ReturnType<typeof useKanbanCardDetail>;
