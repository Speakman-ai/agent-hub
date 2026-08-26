import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GitBranch, GripVertical, ExternalLink } from 'lucide-react';
import { api } from '../utils/api';
import {
  autonomousFormFromRow,
  defaultAutonomousModel,
  phaseFormToUpdateBody,
} from '../utils/epics';
import EpicScopeWorkbench from './epic-scope/EpicScopeWorkbench';
import { ticketsForEpic } from '../utils/epicScopeStats';
import { useResizablePaneWidth } from '../hooks/useResizablePaneWidth';
import {
  DEFAULT_DESIGN_PANE_WIDTH,
  MIN_DESIGN_PANE_WIDTH,
  MAX_DESIGN_PANE_WIDTH,
} from '../utils/sessionPreviewState';

/**
 * Parse an epic's `created_at` to epoch millis for relative ordering. SQLite
 * emits space-separated timestamps (`'2026-07-08 12:00:00'`); `new Date(...)`
 * on that non-ISO format is engine-dependent (V8 tolerates it, the spec does
 * not), so normalise the space to `'T'` before parsing. Only relative order
 * matters here, so a missing/unparseable value sorts oldest (`0`).
 */
function epicCreatedMs(epic: any): number {
  const raw = epic?.created_at;
  if (!raw) return 0;
  const iso = typeof raw === 'string' ? raw.replace(' ', 'T') : raw;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Scoping-mode side panel — epic scope workbench with flowchart / manage / spec tabs.
 */
export default function SessionScopingModePane({
  sessionId,
  projectId,
  linkedEpicId,
  agent,
  sessionEngine,
  sessionModel,
  onLinkEpic,
  onOpenEpic,
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
  const [assigningTicketId, setAssigningTicketId] = useState<string | null>(null);
  const [phaseRunError, setPhaseRunError] = useState<string | null>(null);
  const [modelConfig, setModelConfig] = useState<any>(null);

  const { width, isResizing, handleProps } = useResizablePaneWidth({
    storageKey: `session-scoping-pane-width:${sessionId || 'none'}`,
    defaultWidth: DEFAULT_DESIGN_PANE_WIDTH,
    min: MIN_DESIGN_PANE_WIDTH,
    max: MAX_DESIGN_PANE_WIDTH,
  });

  // Track the latest reload token so a settled board can be stamped with the
  // (projectId, token) it was fetched for. The auto-select effect below trusts
  // a board only when that stamp matches the *current* props — otherwise a
  // stale pre-refetch board (old project or previous token) races ahead and
  // corrupts the "new epic" diff during a project/session switch.
  const reloadTokenRef = useRef(reloadToken);
  reloadTokenRef.current = reloadToken;

  const fetchBoard = useCallback(async () => {
    if (!projectId) return;
    const token = reloadTokenRef.current;
    setLoading(true);
    try {
      const data = await api.getBoard(projectId);
      setBoard({ ...data, __projectId: projectId, __token: token });
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

  useEffect(() => {
    if (typeof api.getModelConfig !== 'function') return;
    api
      .getModelConfig()
      .then(setModelConfig)
      .catch(() => setModelConfig(null));
  }, []);

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
    () => (epic ? ticketsForEpic(cards, epic.id, columns) : []),
    [cards, epic, columns],
  );

  // Auto-select a newly created epic. When the agent (or user) creates an epic
  // during scoping mode, the board refetches via `reloadToken` but the panel
  // would otherwise stay on "Select epic…". Diff the epic set against the
  // previous board snapshot for THIS session and, when a fresh epic appears
  // while nothing is linked yet, link it so its phases/spec show immediately.
  //
  // The baseline is keyed by `projectId:sessionId`. The first settled board for
  // a given key seeds the baseline WITHOUT selecting (so opening the panel over
  // pre-existing epics is a no-op), and switching project or session re-seeds —
  // that is why we never auto-link a foreign context's epics. Crucially, we
  // only act on a board whose stamp matches the current (projectId, token): a
  // stale board from before a switch is skipped, so the re-seed baselines
  // against the fresh board rather than a pre-refetch snapshot.
  //
  // Authorship caveat: `kanban_update` is board-wide, so an epic created by a
  // *different* session/user on the same project also surfaces here on the next
  // refetch and would be auto-linked. We can't distinguish authorship from the
  // board payload. This is deliberately tolerated — it only fires while nothing
  // is linked, and the link is one click to change — but if the distinction
  // ever matters, gate on a session-authored signal from the server instead.
  const baselineRef = useRef<{ key: string; ids: Set<string> } | null>(null);
  useEffect(() => {
    if (!board || board.__projectId !== projectId || board.__token !== reloadToken) return;
    const key = `${projectId}:${sessionId}`;
    const ids: Set<string> = new Set(epics.map((e: any) => e.id));
    const base = baselineRef.current;
    if (!base || base.key !== key) {
      baselineRef.current = { key, ids };
      return;
    }
    const added = epics.filter((e: any) => !base.ids.has(e.id));
    baselineRef.current = { key, ids };
    if (linkedEpicId || added.length === 0) return;
    // Prefer the most recently created epic when several appear at once.
    const newest = added.reduce((a: any, b: any) => (epicCreatedMs(b) >= epicCreatedMs(a) ? b : a));
    if (newest?.id) onLinkEpic?.(newest.id);
  }, [board, projectId, reloadToken, sessionId, epics, linkedEpicId, onLinkEpic]);

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
        next[phase.id] = prev[phase.id] || autonomousFormFromRow(phase);
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

  const handlePhaseFormChange = (phaseId: string, patch: any) => {
    // Build the next form synchronously from the current render's state so the
    // persist payload below is always the FULL merged form, never the bare
    // patch (reading `merged` out of the functional updater closure was racy —
    // a deferred updater could reset unrelated phase settings to defaults).
    const merged = { ...(phaseForms[phaseId] || {}), ...patch };
    setPhaseForms((prev) => ({ ...prev, [phaseId]: { ...(prev[phaseId] || {}), ...patch } }));
    // Auto-persist the auto-dispatch toggle so it sticks across remounts/reloads
    // (e.g. switching sessions or relinking the epic). Other fields still
    // persist via "Save phase settings" / "Run phase".
    if ('autonomous' in patch && projectId) {
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
      const autonomousModel = defaultAutonomousModel(modelConfig, {
        agent,
        engine: sessionEngine,
        model: sessionModel,
      });
      await api.createPhase(projectId, {
        epicId: linkedEpicId,
        name,
        ...(agent?.id ? { agentId: agent.id } : {}),
        ...(autonomousModel ? { autonomousModel } : {}),
      });
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

  const handleAssignTicketToPhase = async (ticketId: string, phaseId: string) => {
    if (!projectId || !phaseId || assigningTicketId) return;
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
        {linkedEpicId && typeof onOpenEpic === 'function' && (
          <button
            type="button"
            onClick={() => onOpenEpic(linkedEpicId)}
            className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300 focus:outline-none flex-shrink-0"
            title="Open the epic's main page"
            aria-label="Open the epic's main page"
            data-testid="scoping-open-epic"
          >
            <ExternalLink size={12} className="flex-shrink-0" />
            <span>Open epic</span>
          </button>
        )}
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
            modelConfig={modelConfig}
            onPhaseFormChange={handlePhaseFormChange}
            onSavePhase={handleSavePhase}
            phaseSavingId={phaseSavingId}
            onAddTicket={handleAddTicket}
            addingTicketPhaseId={addingTicketPhaseId}
            onAddPhase={handleAddPhase}
            creatingPhase={creatingPhase}
            onRunPhase={handleRunPhase}
            onStopPhase={handleStopPhase}
            phaseStoppingId={phaseStoppingId}
            assigningTicketId={assigningTicketId}
            onAssignTicket={handleAssignTicketToPhase}
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
