import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, LayoutGrid, List, MessagesSquare, Plus, Search, Trash2 } from 'lucide-react';
import { api } from '../utils/api';
import {
  autonomousFormFromRow,
  defaultAutonomousModel,
  epicFormToCreateBody,
  epicFormToUpdateBody,
  EPIC_STATE_LABELS,
  phaseFormToUpdateBody,
} from '../utils/epics';
import {
  applyEpicListFilters,
  collectDistinctEpicLabels,
  createDefaultEpicListFilters,
  type EpicListFilters,
} from '../utils/epicListFilters';
import { labelsFieldFromInput } from '../utils/epics';
import { maybePromptAssignLeadToEpicCards } from '../utils/epicLeadUserCards';
import EpicDetailsPanel, { EMPTY_EPIC_FORM } from './EpicDetailsPanel';
import FeatureBranchPanel from './FeatureBranchPanel';
import EpicPullsSection from './EpicPullsSection';
import EpicCreateDialog from './epic-scope/EpicCreateDialog';
import EpicManageListView from './epic-scope/EpicManageListView';
import EpicBoardView from './epic-scope/EpicBoardView';
import {
  readEpicListViewMode,
  writeEpicListViewMode,
  type EpicListViewMode,
} from '../utils/epicListViewMode';
import EpicLeadUserField from './EpicLeadUserField';
import KanbanUserFilterChips from './KanbanUserFilterChips';
import EpicScopeWorkbench from './epic-scope/EpicScopeWorkbench';
import EpicStartPanel from './epic-scope/EpicStartPanel';
import { specProgress, ticketsForEpic } from '../utils/epicScopeStats';
import type { AssignableUser } from '../utils/kanbanUserFilter';
import KanbanCardDetailModal from './kanban/KanbanCardDetailModal';
import LinkedTodosPanel from './kanban/LinkedTodosPanel';
import { useKanbanCardDetail } from '../hooks/useKanbanCardDetail';

function SectionCard({ title, description, children, action }: any) {
  return (
    <section className="rounded-xl border border-white/[0.08] bg-white/[0.02] overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-white/[0.06]">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-100">{title}</h2>
          {description ? <p className="text-xs text-gray-500 mt-0.5">{description}</p> : null}
        </div>
        {action}
      </div>
      <div className="px-5 py-5">{children}</div>
    </section>
  );
}

/**
 * Dedicated epic management screen.
 */
export default function EpicView({
  projectId,
  epicId,
  project,
  refreshKey,
  agents = [],
  onBackToBoard,
  onOpenEpic,
  onOpenEpicsList,
  onNavigateToSession,
  onOpenPull,
}: any) {
  const [columns, setColumns] = useState<any[]>([]);
  const [cards, setCards] = useState<any[]>([]);
  const [epics, setEpics] = useState<any[]>([]);
  const [cardTemplates, setCardTemplates] = useState<any[]>([]);
  const [phases, setPhases] = useState<any[]>([]);
  const [specItems, setSpecItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [modelConfig, setModelConfig] = useState<any>(null);

  const [detailsForm, setDetailsForm] = useState({ ...EMPTY_EPIC_FORM });
  const [branchForm, setBranchForm] = useState({ name: '', pr_base_branch: '' });
  const [detailsSaving, setDetailsSaving] = useState(false);
  const [branchSaving, setBranchSaving] = useState(false);
  const [creatingEpic, setCreatingEpic] = useState(false);
  const [scopingEpic, setScopingEpic] = useState(false);
  const [newEpicForm, setNewEpicForm] = useState({ ...EMPTY_EPIC_FORM });
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createDialogIntent, setCreateDialogIntent] = useState<'create' | 'scope'>('create');
  const [pendingScopeEpicId, setPendingScopeEpicId] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [listFilters, setListFilters] = useState<EpicListFilters>(() =>
    createDefaultEpicListFilters(),
  );
  const [deletingEpicId, setDeletingEpicId] = useState<string | null>(null);
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [viewMode, setViewMode] = useState<EpicListViewMode>(() => readEpicListViewMode());

  const changeViewMode = useCallback((mode: EpicListViewMode) => {
    setViewMode(mode);
    writeEpicListViewMode(mode);
  }, []);

  const [addingTicketPhaseId, setAddingTicketPhaseId] = useState<string | null>(null);
  const [creatingPhase, setCreatingPhase] = useState(false);
  const [phaseSavingId, setPhaseSavingId] = useState<any>(null);
  const [phaseForms, setPhaseForms] = useState<Record<string, any>>({});
  const phaseFormsRef = useRef<Record<string, any>>({});
  const phaseSaveQueuesRef = useRef<Record<string, Promise<void>>>({});
  const [specSavingId, setSpecSavingId] = useState<any>(null);
  const [phaseRunError, setPhaseRunError] = useState<string | null>(null);
  const [phaseStoppingId, setPhaseStoppingId] = useState<string | null>(null);
  const [assigningTicketId, setAssigningTicketId] = useState<string | null>(null);

  const epic = epicId ? epics.find((e: any) => e.id === epicId) : null;

  const fetchBoard = useCallback(async () => {
    if (!projectId) return undefined;
    try {
      const data = await api.getBoard(projectId);
      setColumns(data.columns || []);
      setCards(data.cards || []);
      setEpics(data.epics || []);
      setCardTemplates(data.cardTemplates || []);
      setPhases(data.phases || []);
      setSpecItems(data.specItems || []);
      setAssignableUsers(data.assignableUsers || []);
      setError(null);
      return data.cards || [];
    } catch (err: any) {
      setError(err.message);
      return undefined;
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const cardDetail = useKanbanCardDetail({
    projectId,
    agents,
    epics,
    cards,
    modelConfig,
    cardTemplates,
    onRefresh: fetchBoard,
    onNavigateToSession,
  });

  useEffect(() => {
    if (typeof api.getModelConfig !== 'function') return;
    api
      .getModelConfig()
      .then(setModelConfig)
      .catch(() => setModelConfig(null));
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchBoard();
  }, [fetchBoard, projectId]);

  const epicRowId = epic?.id;
  const epicRowName = epic?.name;
  const epicRowDescription = epic?.description;
  const epicRowLabels = epic?.labels;
  const epicRowAssignedUserId = epic?.assigned_user_id;
  const epicRowColor = epic?.color;
  const epicRowPrBaseBranch = epic?.pr_base_branch;

  const isFirstRefresh = useRef(true);
  useEffect(() => {
    if (isFirstRefresh.current) {
      isFirstRefresh.current = false;
      return;
    }
    if (!projectId) return;
    fetchBoard();
  }, [refreshKey, projectId, fetchBoard]);

  useEffect(() => {
    if (!epicRowId) {
      setDetailsForm({ ...EMPTY_EPIC_FORM });
      setBranchForm({ name: '', pr_base_branch: '' });
      return;
    }
    setDetailsForm({
      name: epicRowName,
      description: epicRowDescription || '',
      labels: labelsFieldFromInput(epicRowLabels),
      assigned_user_id: epicRowAssignedUserId || '',
      color: epicRowColor || EMPTY_EPIC_FORM.color,
    });
    setBranchForm({
      name: epicRowName,
      pr_base_branch: epicRowPrBaseBranch || '',
    });
  }, [
    epicRowId,
    epicRowName,
    epicRowDescription,
    epicRowLabels,
    epicRowAssignedUserId,
    epicRowColor,
    epicRowPrBaseBranch,
  ]);

  const defaultColumnId = useMemo(() => {
    const backlog = columns.find((c: any) => c.name.toLowerCase() === 'backlog');
    const todo = columns.find((c: any) => c.name.toLowerCase() === 'to do');
    return backlog?.id || todo?.id || columns[0]?.id || null;
  }, [columns]);

  const epicTickets = useMemo(() => {
    if (!epicId) return [];
    return ticketsForEpic(cards, epicId, columns).sort((a: any, b: any) => {
      const colA = columns.find((c: any) => c.id === a.column_id);
      const colB = columns.find((c: any) => c.id === b.column_id);
      const posA = colA?.position ?? 0;
      const posB = colB?.position ?? 0;
      if (posA !== posB) return posA - posB;
      return (a.position ?? 0) - (b.position ?? 0);
    });
  }, [cards, columns, epicId]);

  const epicPhases = useMemo(() => {
    if (!epicId) return [];
    return phases
      .filter((p: any) => p.epic_id === epicId)
      .sort((a: any, b: any) => a.position - b.position);
  }, [phases, epicId]);

  useEffect(() => {
    if (!epicPhases.length) {
      phaseFormsRef.current = {};
      setPhaseForms({});
      return;
    }
    setPhaseForms((prev: any) => {
      const next = { ...prev };
      for (const phase of epicPhases) {
        if (!next[phase.id]) next[phase.id] = autonomousFormFromRow(phase);
      }
      phaseFormsRef.current = next;
      return next;
    });
  }, [epicPhases]);

  const filteredEpics = useMemo(
    () => applyEpicListFilters(epics, listFilters, cards, columns),
    [epics, listFilters, cards, columns],
  );

  // The board groups epics by lifecycle state across its own columns, so the
  // state dropdown is redundant there — force `state: 'all'` so every column
  // has something to show regardless of the list view's default filter.
  const boardEpics = useMemo(
    () => applyEpicListFilters(epics, { ...listFilters, state: 'all' }, cards, columns),
    [epics, listFilters, cards, columns],
  );

  const availableEpicLabels = useMemo(() => collectDistinctEpicLabels(epics), [epics]);

  const toggleEpicListLabel = (label: string) => {
    setListFilters((prev) => {
      const next = new Set(prev.selectedLabels);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return { ...prev, selectedLabels: next };
    });
  };

  const toggleEpicListUser = (userId: string) => {
    setListFilters((prev) => {
      const next = new Set(prev.selectedUserIds);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return { ...prev, selectedUserIds: next };
    });
  };

  const closeCreateDialog = () => {
    if (creatingEpic || scopingEpic) return;
    setCreateDialogOpen(false);
    setCreateDialogIntent('create');
    setCreateError(null);
    setPendingScopeEpicId(null);
    setNewEpicForm({ ...EMPTY_EPIC_FORM });
  };

  const openCreateDialog = (intent: 'create' | 'scope' = 'create') => {
    setNewEpicForm({ ...EMPTY_EPIC_FORM });
    setCreateError(null);
    setCreateDialogIntent(intent);
    setPendingScopeEpicId(null);
    setCreateDialogOpen(true);
  };

  const handleCreateEpic = async () => {
    if (pendingScopeEpicId) {
      const epicId = pendingScopeEpicId;
      setPendingScopeEpicId(null);
      setNewEpicForm({ ...EMPTY_EPIC_FORM });
      setCreateDialogOpen(false);
      setCreateError(null);
      onOpenEpic(epicId);
      return;
    }
    if (!newEpicForm.name.trim() || creatingEpic || scopingEpic) return;
    setCreatingEpic(true);
    setCreateError(null);
    try {
      const created = await api.createEpic(projectId, epicFormToCreateBody(newEpicForm));
      setNewEpicForm({ ...EMPTY_EPIC_FORM });
      setCreateDialogOpen(false);
      await fetchBoard();
      if (created?.id) onOpenEpic(created.id);
    } catch (err: any) {
      console.error('Failed to create epic:', err);
      setCreateError(err?.message || 'Failed to create epic');
    } finally {
      setCreatingEpic(false);
    }
  };

  const handleSaveDetails = async () => {
    if (!epic || !detailsForm.name.trim() || detailsSaving) return;
    setDetailsSaving(true);
    try {
      const previousLeadUserId = epic.assigned_user_id;
      const nextLeadUserId = detailsForm.assigned_user_id || null;
      const epicCardCount = cards.filter((c: any) => c.epic_id === epic.id).length;
      await api.updateEpic(
        projectId,
        epic.id,
        epicFormToUpdateBody({
          ...detailsForm,
          ...autonomousFormFromRow(epic),
        }),
      );
      await maybePromptAssignLeadToEpicCards({
        projectId,
        epicId: epic.id,
        previousUserId: previousLeadUserId,
        nextUserId: nextLeadUserId,
        cardCount: epicCardCount,
        assignableUsers,
      });
      await fetchBoard();
    } catch (err: any) {
      console.error('Failed to save epic:', err);
    } finally {
      setDetailsSaving(false);
    }
  };

  const handleSaveFeatureBranch = async () => {
    if (!epic || branchSaving) return;
    setBranchSaving(true);
    try {
      await api.updateEpic(
        projectId,
        epic.id,
        epicFormToUpdateBody({
          name: epic.name,
          description: epic.description || '',
          color: epic.color || EMPTY_EPIC_FORM.color,
          labels: epic.labels,
          assigned_user_id: epic.assigned_user_id,
          ...autonomousFormFromRow(epic),
          pr_base_branch: branchForm.pr_base_branch,
        }),
      );
      await fetchBoard();
    } catch (err: any) {
      console.error('Failed to save feature branch:', err);
    } finally {
      setBranchSaving(false);
    }
  };

  const handleDeleteEpic = async () => {
    if (!epic || detailsSaving || branchSaving) return;
    if (!window.confirm(`Delete epic "${epic.name}"? Cards will be unlinked.`)) return;
    setDetailsSaving(true);
    try {
      await api.deleteEpic(projectId, epic.id);
      onOpenEpicsList();
      await fetchBoard();
    } catch (err: any) {
      console.error('Failed to delete epic:', err);
    } finally {
      setDetailsSaving(false);
    }
  };

  const handleDeleteEpicFromList = async (target: any) => {
    if (!target?.id || deletingEpicId) return;
    if (!window.confirm(`Delete epic "${target.name}"? Cards will be unlinked.`)) return;
    setDeletingEpicId(target.id);
    try {
      await api.deleteEpic(projectId, target.id);
      await fetchBoard();
    } catch (err: any) {
      console.error('Failed to delete epic:', err);
    } finally {
      setDeletingEpicId(null);
    }
  };

  const handleAddPhaseByName = async (name: string) => {
    if (!epicId || !name.trim() || creatingPhase) return;
    setCreatingPhase(true);
    try {
      const autonomousModel = defaultAutonomousModel(modelConfig);
      await api.createPhase(projectId, {
        epicId,
        name: name.trim(),
        ...(autonomousModel ? { autonomousModel } : {}),
      });
      await fetchBoard();
    } catch (err: any) {
      console.error('Failed to create phase:', err);
    } finally {
      setCreatingPhase(false);
    }
  };

  const handleAddTicketToPhase = async (phaseId: string, title: string) => {
    if (!epicId || !title.trim() || !defaultColumnId || addingTicketPhaseId) return;
    setAddingTicketPhaseId(phaseId);
    try {
      await api.createCard(projectId, {
        title: title.trim(),
        priority: 'medium',
        columnId: defaultColumnId,
        epicId,
        phaseId,
        createdBy: 'user',
      });
      await fetchBoard();
    } catch (err: any) {
      console.error('Failed to create ticket:', err);
    } finally {
      setAddingTicketPhaseId(null);
    }
  };

  const handleAssignTicketToPhase = async (ticketId: string, phaseId: string) => {
    if (!phaseId || assigningTicketId) return;
    setAssigningTicketId(ticketId);
    setPhaseRunError(null);
    try {
      await api.updateCard(projectId, ticketId, { phaseId });
      await fetchBoard();
    } catch (err: any) {
      console.error('Failed to assign ticket to phase:', err);
      setPhaseRunError(err?.message || 'Failed to assign ticket to phase');
    } finally {
      setAssigningTicketId(null);
    }
  };

  const handleRunPhase = async (phaseId: string) => {
    const phase = epicPhases.find((p: any) => p.id === phaseId);
    const form = phaseForms[phaseId];
    if (!phase || !form?.autonomous) return;
    setPhaseRunError(null);
    try {
      await api.updatePhase(
        projectId,
        phaseId,
        phaseFormToUpdateBody({ ...form, name: phase.name }),
      );
      await api.runPhase(projectId, phaseId);
      await fetchBoard();
    } catch (err: any) {
      console.error('Failed to run phase:', err);
      setPhaseRunError(err?.message || 'Failed to run phase');
    }
  };

  const handleRunEpic = async () => {
    if (!epic?.id) return { outcome: 'no_phases' };
    const res = await api.runEpic(projectId, epic.id);
    await fetchBoard();
    return res;
  };

  const handleSaveEpicSchedule = async (data: {
    cron: string;
    timezone: string | null;
    enabled: boolean;
  }) => {
    if (!epic?.id) return;
    await api.setEpicStartSchedule(projectId, epic.id, data);
    await fetchBoard();
  };

  const handleClearEpicSchedule = async () => {
    if (!epic?.id) return;
    await api.clearEpicStartSchedule(projectId, epic.id);
    await fetchBoard();
  };

  const handleStopPhase = async (phaseId: string) => {
    if (phaseStoppingId) return;
    setPhaseRunError(null);
    setPhaseStoppingId(phaseId);
    try {
      await api.stopPhase(projectId, phaseId);
      await fetchBoard();
    } catch (err: any) {
      console.error('Failed to stop phase:', err);
      setPhaseRunError(err?.message || 'Failed to stop phase');
    } finally {
      setPhaseStoppingId(null);
    }
  };

  const handleReorderPhases = async (phaseIds: string[]) => {
    if (!epic?.id) return;
    setPhaseRunError(null);
    try {
      await api.reorderPhases(projectId, epic.id, { phaseIds });
      await fetchBoard();
    } catch (err: any) {
      console.error('Failed to reorder phases:', err);
      setPhaseRunError(err?.message || 'Failed to reorder phases');
    }
  };

  const handleAutoSortPhases = async () => {
    if (!epic?.id) return;
    setPhaseRunError(null);
    try {
      await api.reorderPhases(projectId, epic.id, { sortByDependencies: true });
      await fetchBoard();
    } catch (err: any) {
      console.error('Failed to auto-sort phases:', err);
      setPhaseRunError(
        err?.message === 'cycle'
          ? 'Cannot auto-order: phases have a circular blocker dependency.'
          : err?.message || 'Failed to auto-order phases',
      );
    }
  };

  const handlePhaseFormChange = (phaseId: string, patch: any) => {
    // Build the next form synchronously from the current render's state so the
    // persist payload below is always the FULL merged form, never the bare
    // patch. (Reading `merged` out of the functional updater closure was racy:
    // React may defer the updater, so the API write could have fired with only
    // `{ autonomous }` and reset description/interval/concurrency/model/send-it
    // to defaults.)
    const merged = { ...(phaseFormsRef.current[phaseId] || phaseForms[phaseId] || {}), ...patch };
    phaseFormsRef.current[phaseId] = merged;
    setPhaseForms((prev: any) => ({
      ...prev,
      [phaseId]: { ...(prev[phaseId] || {}), ...patch },
    }));
    const phase = epicPhases.find((p: any) => p.id === phaseId);
    if (phase) {
      setPhaseRunError(null);
      const previousSave = phaseSaveQueuesRef.current[phaseId] || Promise.resolve();
      const queuedSave = previousSave
        .catch(() => undefined)
        .then(async () => {
          await api.updatePhase(
            projectId,
            phaseId,
            phaseFormToUpdateBody({ ...merged, name: phase.name }),
          );
          await fetchBoard();
        })
        .catch((err: any) => {
          console.error('Failed to persist phase settings:', err);
          setPhaseRunError(err?.message || 'Failed to update phase settings');
        });
      phaseSaveQueuesRef.current[phaseId] = queuedSave;
    }
  };

  const epicSpecStats = useMemo(() => {
    if (!epicId) return null;
    return specProgress(specItems.filter((s: any) => s.epic_id === epicId));
  }, [specItems, epicId]);

  const handleSavePhaseAutonomous = async (phase: any, form: any) => {
    if (phaseSavingId) return;
    setPhaseSavingId(phase.id);
    try {
      await api.updatePhase(
        projectId,
        phase.id,
        phaseFormToUpdateBody({ ...form, name: phase.name }),
      );
      await fetchBoard();
    } catch (err: any) {
      console.error('Failed to save phase:', err);
    } finally {
      setPhaseSavingId(null);
    }
  };

  const handleAddSpecItem = async ({ tag, title }: { tag: string; title: string }) => {
    if (!epicId || specSavingId) return;
    setSpecSavingId('new');
    try {
      await api.createSpecItem(projectId, { epicId, tag, title });
      await fetchBoard();
    } catch (err: any) {
      console.error('Failed to create spec item:', err);
    } finally {
      setSpecSavingId(null);
    }
  };

  const handleUpdateSpecItem = async (specItemId: string, patch: any) => {
    if (specSavingId) return;
    setSpecSavingId(specItemId);
    try {
      await api.updateSpecItem(projectId, specItemId, patch);
      await fetchBoard();
    } catch (err: any) {
      console.error('Failed to update spec item:', err);
    } finally {
      setSpecSavingId(null);
    }
  };

  const handleCreateAndScopeEpic = async () => {
    if ((!pendingScopeEpicId && !newEpicForm.name.trim()) || creatingEpic || scopingEpic) return;
    // Hold BOTH busy flags across the whole create→scope sequence so a second
    // click can't slip in during the scoping leg and create a duplicate epic
    // or a duplicate scoping session.
    setCreatingEpic(true);
    setScopingEpic(true);
    setCreateError(null);
    let epicId = pendingScopeEpicId;
    try {
      if (!epicId) {
        const created = await api.createEpic(projectId, epicFormToCreateBody(newEpicForm));
        if (!created?.id) return;
        epicId = created.id;
        setPendingScopeEpicId(epicId);
        await fetchBoard();
      }
      const result = await api.scopeEpic(projectId, epicId);
      setPendingScopeEpicId(null);
      setNewEpicForm({ ...EMPTY_EPIC_FORM });
      setCreateDialogOpen(false);
      if (onNavigateToSession && result?.sessionId && result?.agentId) {
        onNavigateToSession(result.agentId, result.sessionId);
      } else {
        onOpenEpic(epicId);
      }
    } catch (err: any) {
      console.error('Failed to create and scope epic:', err);
      setCreateError(err?.message || 'Failed to create and scope epic');
      setCreateDialogOpen(true);
    } finally {
      setCreatingEpic(false);
      setScopingEpic(false);
    }
  };

  const handleScopeEpic = async () => {
    if (!epic || scopingEpic) return;
    setScopingEpic(true);
    try {
      const result = await api.scopeEpic(projectId, epic.id);
      if (onNavigateToSession && result?.sessionId && result?.agentId) {
        onNavigateToSession(result.agentId, result.sessionId);
      }
    } catch (err: any) {
      console.error('Failed to start scoping session:', err);
    } finally {
      setScopingEpic(false);
    }
  };

  const handleDecideForMe = async (specItemId: string) => {
    if (specSavingId) return;
    setSpecSavingId(specItemId);
    try {
      const result = await api.decideSpecForMe(projectId, specItemId);
      await fetchBoard();
      if (onNavigateToSession && result?.sessionId && result?.agentId) {
        onNavigateToSession(result.agentId, result.sessionId);
      }
    } catch (err: any) {
      console.error('Failed to start decide-for-me:', err);
    } finally {
      setSpecSavingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-gray-950 text-gray-500">
        <div className="h-8 w-8 rounded-full border-2 border-gray-700 border-t-indigo-500 animate-spin" />
        <p className="text-sm">Loading epics…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-950 text-gray-400">
        <div className="text-center max-w-sm px-6">
          <p className="mb-1 text-base font-medium text-gray-200">Failed to load epics</p>
          <p className="text-sm text-gray-500">{error}</p>
        </div>
      </div>
    );
  }

  if (epicId && !epic) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 bg-gray-950 text-gray-400">
        <p>Epic not found.</p>
        <button
          type="button"
          onClick={onOpenEpicsList}
          className="px-4 py-2 text-sm text-gray-200 bg-white/[0.06] hover:bg-white/[0.1] rounded-lg"
        >
          Back to epics
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-gray-950 min-h-0">
      <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-white/[0.06] bg-gray-950/90 backdrop-blur-sm">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={epicId ? onOpenEpicsList : onBackToBoard}
            className="flex items-center gap-1.5 h-9 px-2.5 rounded-lg text-xs font-medium text-gray-400 hover:text-gray-200 hover:bg-white/[0.06] transition-colors"
          >
            <ArrowLeft size={14} />
            {epicId ? 'All epics' : 'Board'}
          </button>
          {project?.color && (
            <span
              className="w-2 h-2 rounded-full ring-2 ring-white/10"
              style={{ backgroundColor: project.color }}
            />
          )}
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-gray-100 truncate">
              {epicId ? epic.name : 'Epics'}
            </h1>
            <p className="text-xs text-gray-500 truncate">
              {epicId
                ? epicSpecStats && epicSpecStats.total > 0
                  ? `${epicSpecStats.chosen}/${epicSpecStats.total} spec locked · ${epicTickets.length} ticket${epicTickets.length !== 1 ? 's' : ''}`
                  : `${epicTickets.length} ticket${epicTickets.length !== 1 ? 's' : ''} · ${epicPhases.length} phase${epicPhases.length !== 1 ? 's' : ''}`
                : `${epics.length} epic${epics.length !== 1 ? 's' : ''} · ${project?.name || 'Project'}`}
            </p>
          </div>
        </div>
        {epicId && epic ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleScopeEpic}
              disabled={scopingEpic}
              data-testid="epic-scope-button"
              title="Open a scoping session that already knows this epic"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 disabled:opacity-50 px-2.5 py-1.5 rounded-lg transition-colors"
            >
              <MessagesSquare size={13} />
              {scopingEpic ? 'Opening…' : 'Scope with agent'}
            </button>
            <span
              className="w-3 h-3 rounded-full ring-1 ring-white/10"
              style={{ backgroundColor: epic.color }}
            />
          </div>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className={`mx-auto p-5 ${epicId ? 'max-w-[1400px]' : 'max-w-6xl'}`}>
          {!epicId ? (
            <div className="space-y-5">
              <div
                className="sticky top-0 z-10 -mx-5 px-5 py-3 border-b border-white/[0.06] bg-gray-950/95 backdrop-blur-sm space-y-3"
                data-testid="epic-list-toolbar"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => openCreateDialog('create')}
                    disabled={creatingEpic || scopingEpic}
                    data-testid="epic-list-create-button"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white/[0.06] hover:bg-white/[0.10] disabled:opacity-40 text-gray-200 rounded-lg transition-colors"
                  >
                    <Plus size={13} />
                    Create epic
                  </button>
                  <button
                    type="button"
                    onClick={() => openCreateDialog('scope')}
                    disabled={creatingEpic || scopingEpic}
                    data-testid="epic-list-create-scope-button"
                    title="Create the epic and open a scoping session that already knows it"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-600/40 text-white rounded-lg transition-colors"
                  >
                    <MessagesSquare size={13} />
                    Create & scope
                  </button>

                  <div
                    className="ml-auto inline-flex items-center gap-0.5 rounded-lg border border-white/[0.08] bg-white/[0.04] p-0.5"
                    role="group"
                    aria-label="Epics view"
                    data-testid="epic-view-toggle"
                  >
                    <button
                      type="button"
                      onClick={() => changeViewMode('list')}
                      aria-pressed={viewMode === 'list'}
                      data-testid="epic-view-toggle-list"
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                        viewMode === 'list'
                          ? 'bg-white/[0.10] text-gray-100'
                          : 'text-gray-400 hover:text-gray-200'
                      }`}
                    >
                      <List size={13} />
                      List
                    </button>
                    <button
                      type="button"
                      onClick={() => changeViewMode('board')}
                      aria-pressed={viewMode === 'board'}
                      data-testid="epic-view-toggle-board"
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                        viewMode === 'board'
                          ? 'bg-white/[0.10] text-gray-100'
                          : 'text-gray-400 hover:text-gray-200'
                      }`}
                    >
                      <LayoutGrid size={13} />
                      Board
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <label className="relative min-w-[180px] flex-1 max-w-sm">
                    <Search
                      size={14}
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500"
                    />
                    <input
                      type="search"
                      value={listFilters.search}
                      onChange={(event) =>
                        setListFilters((prev) => ({ ...prev, search: event.target.value }))
                      }
                      placeholder="Search epics…"
                      data-testid="epic-list-search"
                      className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] py-2 pl-8 pr-3 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
                    />
                  </label>
                  <select
                    value={listFilters.scope}
                    onChange={(event) =>
                      setListFilters((prev) => ({
                        ...prev,
                        scope: event.target.value as EpicListFilters['scope'],
                      }))
                    }
                    data-testid="epic-list-filter-scope"
                    className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-2 text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
                  >
                    <option value="all">All epics</option>
                    <option value="with-tickets">With tickets</option>
                    <option value="empty">Empty</option>
                  </select>
                  {viewMode === 'list' ? (
                    <select
                      value={listFilters.state}
                      onChange={(event) =>
                        setListFilters((prev) => ({
                          ...prev,
                          state: event.target.value as EpicListFilters['state'],
                        }))
                      }
                      data-testid="epic-list-filter-state"
                      className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-2 text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
                    >
                      <option value="all">All states</option>
                      <option value="not_started">{EPIC_STATE_LABELS.not_started}</option>
                      <option value="in_progress">{EPIC_STATE_LABELS.in_progress}</option>
                      <option value="done">{EPIC_STATE_LABELS.done}</option>
                    </select>
                  ) : null}
                </div>

                {availableEpicLabels.length > 0 ? (
                  <div
                    className="flex flex-wrap items-center gap-2"
                    data-testid="epic-list-label-filters"
                  >
                    {availableEpicLabels.map((label) => {
                      const active = listFilters.selectedLabels.has(label);
                      return (
                        <button
                          key={label}
                          type="button"
                          onClick={() => toggleEpicListLabel(label)}
                          data-testid={`epic-list-label-${label}`}
                          className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                            active
                              ? 'border-indigo-500/40 bg-indigo-500/15 text-indigo-200'
                              : 'border-white/[0.08] bg-white/[0.04] text-gray-400 hover:text-gray-200 hover:bg-white/[0.06]'
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                    {listFilters.selectedLabels.size > 0 ? (
                      <button
                        type="button"
                        onClick={() =>
                          setListFilters((prev) => ({ ...prev, selectedLabels: new Set() }))
                        }
                        data-testid="epic-list-clear-labels"
                        className="text-[11px] text-gray-500 hover:text-gray-300 px-1"
                      >
                        Clear labels
                      </button>
                    ) : null}
                  </div>
                ) : null}

                <KanbanUserFilterChips
                  users={assignableUsers}
                  selectedUserIds={listFilters.selectedUserIds}
                  onToggle={toggleEpicListUser}
                  onClear={() =>
                    setListFilters((prev) => ({ ...prev, selectedUserIds: new Set() }))
                  }
                  testIdPrefix="epic-list-user-filter"
                />
              </div>

              {viewMode === 'board' ? (
                <EpicBoardView
                  epics={boardEpics}
                  phases={phases}
                  cards={cards}
                  columns={columns}
                  assignableUsers={assignableUsers}
                  onOpenEpic={onOpenEpic}
                  onDeleteEpic={handleDeleteEpicFromList}
                  deleteBusyEpicId={deletingEpicId}
                  emptyMessage={
                    epics.length === 0 ? 'No epics yet.' : 'No epics match these filters.'
                  }
                />
              ) : (
                <EpicManageListView
                  epics={filteredEpics}
                  phases={phases}
                  cards={cards}
                  columns={columns}
                  assignableUsers={assignableUsers}
                  onOpenEpic={onOpenEpic}
                  onDeleteEpic={handleDeleteEpicFromList}
                  deleteBusyEpicId={deletingEpicId}
                  emptyMessage={
                    epics.length === 0 ? 'No epics yet.' : 'No epics match these filters.'
                  }
                />
              )}

              <EpicCreateDialog
                open={createDialogOpen}
                onClose={closeCreateDialog}
                form={newEpicForm}
                onChange={(patch: any) => setNewEpicForm((f: any) => ({ ...f, ...patch }))}
                users={assignableUsers}
                busy={creatingEpic || scopingEpic}
                error={createError}
                intent={createDialogIntent}
                onCreate={handleCreateEpic}
                onCreateAndScope={handleCreateAndScopeEpic}
              />
            </div>
          ) : (
            <div className="space-y-6">
              {phaseRunError && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                  {phaseRunError}
                </div>
              )}
              <div className="grid max-w-6xl gap-5 lg:grid-cols-2" data-testid="feature-controls">
                <SectionCard
                  title="Feature branch"
                  description="Control where ticket pull requests merge before the epic ships."
                  action={
                    <button
                      type="button"
                      onClick={handleSaveFeatureBranch}
                      disabled={branchSaving}
                      data-testid="feature-branch-save-button"
                      className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:bg-emerald-600/40"
                    >
                      {branchSaving ? 'Saving…' : 'Save'}
                    </button>
                  }
                >
                  <FeatureBranchPanel
                    form={branchForm}
                    onChange={(patch: any) => setBranchForm((form) => ({ ...form, ...patch }))}
                  />
                </SectionCard>

                <SectionCard
                  title="Epic details"
                  description="Name, description, ownership, and color."
                  action={
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleDeleteEpic}
                        disabled={detailsSaving || branchSaving}
                        data-testid="epic-delete-button"
                        className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                      >
                        <Trash2 size={12} />
                        Delete
                      </button>
                      <button
                        type="button"
                        onClick={handleSaveDetails}
                        disabled={!detailsForm.name.trim() || detailsSaving}
                        data-testid="epic-save-button"
                        className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:bg-indigo-600/40"
                      >
                        {detailsSaving ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  }
                >
                  <EpicDetailsPanel
                    form={detailsForm}
                    onChange={(patch: any) => setDetailsForm((form) => ({ ...form, ...patch }))}
                  />
                  {assignableUsers.length > 0 ? (
                    <div className="mt-5">
                      <EpicLeadUserField
                        users={assignableUsers}
                        value={detailsForm.assigned_user_id || ''}
                        onChange={(assigned_user_id) =>
                          setDetailsForm((form: any) => ({ ...form, assigned_user_id }))
                        }
                      />
                    </div>
                  ) : null}
                </SectionCard>
              </div>

              <EpicPullsSection projectId={projectId} epicId={epicId} onOpenPull={onOpenPull} />

              <div className="max-w-6xl">
                <SectionCard
                  title="Autonomous start"
                  description="Start the epic's phases now, or schedule them to start at a set time."
                >
                  <EpicStartPanel
                    epic={epic}
                    onRunEpic={handleRunEpic}
                    onSaveSchedule={handleSaveEpicSchedule}
                    onClearSchedule={handleClearEpicSchedule}
                  />
                </SectionCard>
              </div>

              <EpicScopeWorkbench
                variant="page"
                epic={epic}
                epics={epics}
                phases={phases}
                tickets={epicTickets}
                allCards={cards}
                columns={columns}
                specItems={specItems}
                projectName={project?.name}
                phaseForms={phaseForms}
                modelConfig={modelConfig}
                onPhaseFormChange={handlePhaseFormChange}
                onSavePhase={handleSavePhaseAutonomous}
                autoSavePhaseSettings
                phaseSavingId={phaseSavingId}
                onAddTicket={handleAddTicketToPhase}
                addingTicketPhaseId={addingTicketPhaseId}
                onAddPhase={handleAddPhaseByName}
                creatingPhase={creatingPhase}
                onRunPhase={handleRunPhase}
                onStopPhase={handleStopPhase}
                onReorderPhases={handleReorderPhases}
                onAutoSortPhases={handleAutoSortPhases}
                phaseStoppingId={phaseStoppingId}
                assigningTicketId={assigningTicketId}
                onAssignTicket={handleAssignTicketToPhase}
                onOpenEpic={onOpenEpic}
                onAddSpecItem={handleAddSpecItem}
                onUpdateSpecItem={handleUpdateSpecItem}
                onDecideForMe={handleDecideForMe}
                specSavingId={specSavingId}
                onOpenCard={cardDetail.openDetail}
              />

              {/* Reverse (bidirectional) display: the caller's own personal
                  todos linked to this epic. Renders nothing when there are
                  none, so it only surfaces when the viewer has linked a todo. */}
              <LinkedTodosPanel targetType="epic" entity={epic} projectId={projectId} />
            </div>
          )}
        </div>
      </div>

      <KanbanCardDetailModal detail={cardDetail} agents={agents} />
    </div>
  );
}
