import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, MessagesSquare, Plus, Search, Trash2 } from 'lucide-react';
import { api } from '../utils/api';
import {
  defaultAutonomousModel,
  epicFormToCreateBody,
  epicFormToUpdateBody,
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
import EpicAutonomousPanel, {
  EMPTY_AUTONOMOUS_FORM,
  epicToAutonomousForm,
} from './EpicAutonomousPanel';
import EpicCreateDialog from './epic-scope/EpicCreateDialog';
import EpicManageListView from './epic-scope/EpicManageListView';
import EpicLeadUserField from './EpicLeadUserField';
import KanbanUserFilterChips from './KanbanUserFilterChips';
import EpicScopeWorkbench from './epic-scope/EpicScopeWorkbench';
import { specProgress } from '../utils/epicScopeStats';
import type { AssignableUser } from '../utils/kanbanUserFilter';
import KanbanCardDetailModal from './kanban/KanbanCardDetailModal';
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
 * Dedicated epic management screen — list epics, edit settings inline, and add tickets
 * linked to an epic without modal popups.
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
  const [autonomousForm, setAutonomousForm] = useState({ ...EMPTY_AUTONOMOUS_FORM });
  const [detailsSaving, setDetailsSaving] = useState(false);
  const [autonomousSaving, setAutonomousSaving] = useState(false);
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

  const [addingTicketPhaseId, setAddingTicketPhaseId] = useState<string | null>(null);
  const [creatingPhase, setCreatingPhase] = useState(false);
  const [phaseSavingId, setPhaseSavingId] = useState<any>(null);
  const [phaseForms, setPhaseForms] = useState<Record<string, any>>({});
  const [specSavingId, setSpecSavingId] = useState<any>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [phaseRunError, setPhaseRunError] = useState<string | null>(null);
  const [phaseStoppingId, setPhaseStoppingId] = useState<string | null>(null);

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
  const epicRowAutonomous = epic?.autonomous;
  const epicRowAutonomousInterval = epic?.autonomous_interval;
  const epicRowAutonomousMaxConcurrent = epic?.autonomous_max_concurrent;
  const epicRowAutonomousModel = epic?.autonomous_model;
  const epicRowAutonomousSendIt = epic?.autonomous_send_it;
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
      setAutonomousForm({ ...EMPTY_AUTONOMOUS_FORM });
      return;
    }
    setDetailsForm({
      name: epicRowName,
      description: epicRowDescription || '',
      labels: labelsFieldFromInput(epicRowLabels),
      assigned_user_id: epicRowAssignedUserId || '',
      color: epicRowColor || EMPTY_EPIC_FORM.color,
    });
    setAutonomousForm({
      autonomous: epicRowAutonomous || 0,
      autonomous_interval: epicRowAutonomousInterval || 5,
      autonomous_max_concurrent: epicRowAutonomousMaxConcurrent || 1,
      autonomous_model: epicRowAutonomousModel || '',
      autonomous_send_it: epicRowAutonomousSendIt === 0 ? 0 : 1,
      pr_base_branch: epicRowPrBaseBranch || '',
    });
  }, [
    epicRowId,
    epicRowName,
    epicRowDescription,
    epicRowLabels,
    epicRowAssignedUserId,
    epicRowColor,
    epicRowAutonomous,
    epicRowAutonomousInterval,
    epicRowAutonomousMaxConcurrent,
    epicRowAutonomousModel,
    epicRowAutonomousSendIt,
    epicRowPrBaseBranch,
  ]);

  const defaultColumnId = useMemo(() => {
    const backlog = columns.find((c: any) => c.name.toLowerCase() === 'backlog');
    const todo = columns.find((c: any) => c.name.toLowerCase() === 'to do');
    return backlog?.id || todo?.id || columns[0]?.id || null;
  }, [columns]);

  const epicTickets = useMemo(() => {
    if (!epicId) return [];
    return cards
      .filter((c: any) => c.epic_id === epicId)
      .sort((a: any, b: any) => {
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
      setPhaseForms({});
      return;
    }
    setPhaseForms((prev: any) => {
      const next = { ...prev };
      for (const phase of epicPhases) {
        if (!next[phase.id]) next[phase.id] = epicToAutonomousForm(phase);
      }
      return next;
    });
  }, [epicPhases]);

  const filteredEpics = useMemo(
    () => applyEpicListFilters(epics, listFilters, cards),
    [epics, listFilters, cards],
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
          ...epicToAutonomousForm(epic),
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

  const handleSaveAutonomous = async () => {
    if (!epic || autonomousSaving) return;
    setAutonomousSaving(true);
    try {
      await api.updateEpic(
        projectId,
        epic.id,
        epicFormToUpdateBody({
          name: epic.name,
          description: epic.description || '',
          color: epic.color || EMPTY_EPIC_FORM.color,
          ...autonomousForm,
        }),
      );
      await fetchBoard();
    } catch (err: any) {
      console.error('Failed to save autonomous settings:', err);
    } finally {
      setAutonomousSaving(false);
    }
  };

  const handleDeleteEpic = async () => {
    if (!epic || detailsSaving || autonomousSaving) return;
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

  const handlePhaseFormChange = (phaseId: string, patch: any) => {
    // Build the next form synchronously from the current render's state so the
    // persist payload below is always the FULL merged form, never the bare
    // patch. (Reading `merged` out of the functional updater closure was racy:
    // React may defer the updater, so the API write could have fired with only
    // `{ autonomous }` and reset description/interval/concurrency/model/send-it
    // to defaults.)
    const merged = { ...(phaseForms[phaseId] || {}), ...patch };
    setPhaseForms((prev: any) => ({
      ...prev,
      [phaseId]: { ...(prev[phaseId] || {}), ...patch },
    }));
    // Auto-persist the auto-dispatch toggle so it sticks across remounts/reloads.
    // Other fields (e.g. "tickets at once") still persist via "Save phase
    // settings" / "Run phase" so we don't fire a request on every keystroke.
    if ('autonomous' in patch) {
      const phase = epicPhases.find((p: any) => p.id === phaseId);
      if (phase) {
        setPhaseRunError(null);
        api
          .updatePhase(projectId, phaseId, phaseFormToUpdateBody({ ...merged, name: phase.name }))
          .then(() => fetchBoard())
          .catch((err: any) => {
            console.error('Failed to persist auto-dispatch toggle:', err);
            setPhaseRunError(err?.message || 'Failed to update auto-dispatch');
          });
      }
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
            <button
              type="button"
              onClick={() => setShowSettings((s) => !s)}
              className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1 rounded-lg hover:bg-white/[0.06]"
            >
              Settings
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
                phaseSavingId={phaseSavingId}
                onAddTicket={handleAddTicketToPhase}
                addingTicketPhaseId={addingTicketPhaseId}
                onAddPhase={handleAddPhaseByName}
                creatingPhase={creatingPhase}
                onRunPhase={handleRunPhase}
                onStopPhase={handleStopPhase}
                phaseStoppingId={phaseStoppingId}
                onOpenEpic={onOpenEpic}
                onAddSpecItem={handleAddSpecItem}
                onUpdateSpecItem={handleUpdateSpecItem}
                onDecideForMe={handleDecideForMe}
                specSavingId={specSavingId}
                onOpenCard={cardDetail.openDetail}
              />

              {showSettings && (
                <div className="grid gap-5 lg:grid-cols-2 max-w-6xl">
                  <SectionCard
                    title="Epic details"
                    description="Name, description, and color."
                    action={
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handleDeleteEpic}
                          disabled={detailsSaving || autonomousSaving}
                          data-testid="epic-delete-button"
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-50"
                        >
                          <Trash2 size={12} />
                          Delete
                        </button>
                        <button
                          type="button"
                          onClick={handleSaveDetails}
                          disabled={!detailsForm.name.trim() || detailsSaving}
                          data-testid="epic-save-button"
                          className="px-3 py-1.5 text-xs font-medium bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-600/40 text-white rounded-lg transition-colors"
                        >
                          {detailsSaving ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    }
                  >
                    <EpicDetailsPanel
                      form={detailsForm}
                      onChange={(patch: any) => setDetailsForm((f: any) => ({ ...f, ...patch }))}
                    />
                    {assignableUsers.length > 0 ? (
                      <div className="mt-5">
                        <EpicLeadUserField
                          users={assignableUsers}
                          value={detailsForm.assigned_user_id || ''}
                          onChange={(assigned_user_id) =>
                            setDetailsForm((f: any) => ({ ...f, assigned_user_id }))
                          }
                        />
                      </div>
                    ) : null}
                  </SectionCard>

                  <SectionCard
                    title="Epic settings"
                    description="PR base branch and legacy epic-level autonomous (phases preferred)."
                    action={
                      <button
                        type="button"
                        onClick={handleSaveAutonomous}
                        disabled={autonomousSaving}
                        data-testid="autonomous-save-button"
                        className="px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/40 text-white rounded-lg transition-colors"
                      >
                        {autonomousSaving ? 'Saving…' : 'Save'}
                      </button>
                    }
                  >
                    <EpicAutonomousPanel
                      form={autonomousForm}
                      onChange={(patch: any) => setAutonomousForm((f: any) => ({ ...f, ...patch }))}
                      modelConfig={modelConfig}
                    />
                  </SectionCard>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <KanbanCardDetailModal detail={cardDetail} agents={agents} />
    </div>
  );
}
