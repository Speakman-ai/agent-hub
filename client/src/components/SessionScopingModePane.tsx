import { useCallback, useEffect, useMemo, useState } from 'react';
import { GitBranch, GripVertical } from 'lucide-react';
import { api } from '../utils/api';
import { epicToAutonomousForm } from './EpicAutonomousPanel';
import { phaseFormToUpdateBody } from '../utils/epics';
import EpicScopeWorkbench from './epic-scope/EpicScopeWorkbench';
import { useResizablePaneWidth } from '../hooks/useResizablePaneWidth';
import {
  DEFAULT_DESIGN_PANE_WIDTH,
  MIN_DESIGN_PANE_WIDTH,
  MAX_DESIGN_PANE_WIDTH,
} from '../utils/sessionPreviewState';

/**
 * Scoping-mode side panel — epic scope workbench with flowchart / manage / spec tabs.
 */
export default function SessionScopingModePane({
  sessionId,
  projectId,
  linkedEpicId,
  onLinkEpic,
  reloadToken = 0,
}: any) {
  const [board, setBoard] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<any>(null);
  const [phaseForms, setPhaseForms] = useState<Record<string, any>>({});
  const [phaseSavingId, setPhaseSavingId] = useState<any>(null);
  const [creatingPhase, setCreatingPhase] = useState(false);
  const [addingTicketPhaseId, setAddingTicketPhaseId] = useState<string | null>(null);
  const [specSavingId, setSpecSavingId] = useState<any>(null);
  const [phaseStoppingId, setPhaseStoppingId] = useState<string | null>(null);
  const [phaseRunError, setPhaseRunError] = useState<string | null>(null);

  const { width, isResizing, handleProps } = useResizablePaneWidth({
    storageKey: `session-scoping-pane-width:${sessionId || 'none'}`,
    defaultWidth: DEFAULT_DESIGN_PANE_WIDTH,
    min: MIN_DESIGN_PANE_WIDTH,
    max: MAX_DESIGN_PANE_WIDTH,
  });

  const fetchBoard = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const data = await api.getBoard(projectId);
      setBoard(data);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchBoard();
  }, [fetchBoard, reloadToken]);

  // Derive these from `board` with a stable reference per board snapshot.
  // Using inline `board?.x || []` would mint a fresh `[]` on every render
  // while `board` is still null, which flows into the memos/effects below
  // (notably the `phaseForms` seeding effect) and can drive an update loop.
  const epics = useMemo(() => board?.epics || [], [board]);
  const phases = useMemo(() => board?.phases || [], [board]);
  const specItems = useMemo(() => board?.specItems || [], [board]);
  const columns = useMemo(() => board?.columns || [], [board]);
  const cards = useMemo(() => board?.cards || [], [board]);
  const epic = linkedEpicId ? epics.find((e: any) => e.id === linkedEpicId) : null;
  const epicPhases = useMemo(
    () =>
      epic
        ? phases
            .filter((p: any) => p.epic_id === epic.id)
            .sort((a: any, b: any) => a.position - b.position)
        : [],
    [phases, epic],
  );
  const epicTickets = useMemo(
    () => (epic ? cards.filter((c: any) => c.epic_id === epic.id) : []),
    [cards, epic],
  );

  useEffect(() => {
    // Seed a form for any phase that doesn't have one yet, and drop forms
    // for phases that no longer exist. Crucially, return the *same* state
    // reference when nothing changed so React bails out of the update —
    // `epicPhases` gets a fresh identity on every render while `board` is
    // still loading (it's derived inline, not stored in state), and an
    // unconditional `setPhaseForms(...)` here would re-render → recompute
    // `epicPhases` → re-run this effect forever (an infinite update loop).
    setPhaseForms((prev) => {
      const validIds = new Set(epicPhases.map((p: any) => p.id));
      const next: Record<string, any> = {};
      let changed = false;
      for (const phase of epicPhases) {
        next[phase.id] = prev[phase.id] || epicToAutonomousForm(phase);
        if (!prev[phase.id]) changed = true;
      }
      for (const id of Object.keys(prev)) {
        if (!validIds.has(id)) changed = true;
      }
      return changed ? next : prev;
    });
  }, [epicPhases]);

  const defaultColumnId = useMemo(() => {
    const todo = columns.find((c: any) => c.name.toLowerCase() === 'to do');
    return todo?.id || columns[0]?.id || null;
  }, [columns]);

  const handleSavePhase = async (phase: any, form: any) => {
    if (!projectId || phaseSavingId) return;
    setPhaseSavingId(phase.id);
    try {
      await api.updatePhase(
        projectId,
        phase.id,
        phaseFormToUpdateBody({ ...form, name: phase.name }),
      );
      await fetchBoard();
    } finally {
      setPhaseSavingId(null);
    }
  };

  const handleRunPhase = async (phaseId: string) => {
    if (!projectId) return;
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
    if (!projectId || phaseStoppingId) return;
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

  const handleAddPhase = async (name: string) => {
    if (!projectId || !linkedEpicId || creatingPhase) return;
    setCreatingPhase(true);
    try {
      await api.createPhase(projectId, { epicId: linkedEpicId, name });
      await fetchBoard();
    } finally {
      setCreatingPhase(false);
    }
  };

  const handleAddTicket = async (phaseId: string, title: string) => {
    if (!projectId || !linkedEpicId || !defaultColumnId || addingTicketPhaseId) return;
    setAddingTicketPhaseId(phaseId);
    try {
      await api.createCard(projectId, {
        title,
        columnId: defaultColumnId,
        epicId: linkedEpicId,
        phaseId,
        createdBy: 'user',
      });
      await fetchBoard();
    } finally {
      setAddingTicketPhaseId(null);
    }
  };

  const handleAddSpecItem = async ({ tag, title }: { tag: string; title: string }) => {
    if (!projectId || !linkedEpicId || specSavingId) return;
    setSpecSavingId('new');
    try {
      await api.createSpecItem(projectId, {
        epicId: linkedEpicId,
        tag,
        title,
      });
      await fetchBoard();
    } finally {
      setSpecSavingId(null);
    }
  };

  const handleUpdateSpecItem = async (specItemId: string, patch: any) => {
    if (!projectId || specSavingId) return;
    setSpecSavingId(specItemId);
    try {
      await api.updateSpecItem(projectId, specItemId, patch);
      await fetchBoard();
    } finally {
      setSpecSavingId(null);
    }
  };

  const handleDecideForMe = async (specItemId: string) => {
    if (!projectId || specSavingId) return;
    setSpecSavingId(specItemId);
    try {
      await api.decideSpecForMe(projectId, specItemId);
      await fetchBoard();
    } finally {
      setSpecSavingId(null);
    }
  };

  if (!sessionId) return null;

  return (
    <div
      className={`hidden lg:flex flex-col shrink-0 border-l border-gray-800 bg-gray-950 relative ${
        isResizing ? 'select-none' : ''
      }`}
      style={{ width: `${width}px` }}
      data-testid="session-scoping-mode-pane"
    >
      <div
        {...handleProps}
        aria-label="Resize scoping pane"
        className={`absolute top-0 left-0 z-20 flex h-full w-3 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center transition-colors focus:outline-none focus-visible:bg-sky-500/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400 ${
          isResizing ? 'bg-sky-500/50' : 'bg-gray-800/80 hover:bg-sky-500/35'
        }`}
      >
        <GripVertical size={14} className="text-gray-500" aria-hidden />
      </div>

      <div className="border-b border-gray-800 px-3 py-2 flex items-center gap-2 flex-shrink-0">
        <GitBranch size={15} className="text-cyan-400 flex-shrink-0" />
        <span className="text-xs font-semibold text-gray-200 truncate">Scope</span>
        <select
          value={linkedEpicId || ''}
          onChange={(e: any) => onLinkEpic?.(e.target.value || null)}
          className="ml-auto max-w-[160px] bg-white/[0.04] border border-white/[0.08] rounded-md px-2 py-1 text-[11px] text-gray-200 focus:outline-none"
          data-testid="scoping-epic-select"
        >
          <option value="">Select epic…</option>
          {epics.map((item: any) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {loading && <p className="text-xs text-gray-500 mb-2">Loading…</p>}
        {error && <p className="text-xs text-red-400 mb-2">{error}</p>}
        {phaseRunError && <p className="text-xs text-red-400 mb-2">{phaseRunError}</p>}

        {epic ? (
          <EpicScopeWorkbench
            variant="compact"
            epic={epic}
            epics={epics}
            phases={phases}
            allCards={cards}
            tickets={epicTickets}
            columns={columns}
            specItems={specItems}
            compact
            phaseForms={phaseForms}
            onPhaseFormChange={(phaseId: string, patch: any) =>
              setPhaseForms((prev) => ({ ...prev, [phaseId]: { ...prev[phaseId], ...patch } }))
            }
            onSavePhase={handleSavePhase}
            phaseSavingId={phaseSavingId}
            onAddTicket={handleAddTicket}
            addingTicketPhaseId={addingTicketPhaseId}
            onAddPhase={handleAddPhase}
            creatingPhase={creatingPhase}
            onRunPhase={handleRunPhase}
            onStopPhase={handleStopPhase}
            phaseStoppingId={phaseStoppingId}
            onOpenEpic={onLinkEpic}
            onAddSpecItem={handleAddSpecItem}
            onUpdateSpecItem={handleUpdateSpecItem}
            onDecideForMe={handleDecideForMe}
            specSavingId={specSavingId}
            showManageTab={false}
          />
        ) : (
          !loading && (
            <p className="text-sm text-gray-500 text-center py-8">
              Link an epic above to scope phases and tickets.
            </p>
          )
        )}
      </div>
    </div>
  );
}
