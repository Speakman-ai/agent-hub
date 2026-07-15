import { useState } from 'react';
import { ArrowDownWideNarrow, GitBranch, Plus, ScrollText } from 'lucide-react';
import EpicScopeHeader from './EpicScopeHeader';
import PhaseFlowchartView from './PhaseFlowchartView';
import EpicManageListView from './EpicManageListView';
import EpicSpecView from './EpicSpecView';
import UnassignedTicketsView from './UnassignedTicketsView';
import { AddPhaseForm } from './ScopeForms';
import { specProgress } from '../../utils/epicScopeStats';

export type EpicScopeTab = 'flowchart' | 'manage' | 'spec';
export type EpicScopeVariant = 'page' | 'compact';

const COMPACT_TABS: { id: EpicScopeTab; label: string }[] = [
  { id: 'flowchart', label: 'Flowchart' },
  { id: 'manage', label: 'Manage epics' },
  { id: 'spec', label: 'Spec' },
];

function SectionLabel({ step, title, icon: Icon, action }: any) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      <div className="flex items-center gap-2 min-w-0">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/[0.06] text-[11px] font-bold text-gray-400">
          {step}
        </span>
        {Icon && <Icon size={14} className="text-gray-500 shrink-0" />}
        <h3 className="text-sm font-semibold text-gray-100">{title}</h3>
      </div>
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

/**
 * Epic scope workbench.
 * - `page` (epic page): spec-first stacked layout — decisions always visible, flowchart below.
 * - `compact` (scoping panel): tabbed layout for narrow side pane.
 */
export default function EpicScopeWorkbench({
  epic,
  epics,
  phases,
  tickets,
  allCards,
  columns,
  projectName,
  phaseForms,
  onPhaseFormChange,
  onSavePhase,
  autoSavePhaseSettings,
  phaseSavingId,
  onAddTicket,
  addingTicketPhaseId,
  onAddPhase,
  creatingPhase,
  onRunPhase,
  onStopPhase,
  onReorderPhases,
  onAutoSortPhases,
  phaseStoppingId,
  onOpenEpic,
  onCreateEpic,
  creatingEpic,
  specItems = [],
  onAddSpecItem,
  onUpdateSpecItem,
  onDecideForMe,
  specSavingId,
  onOpenCard,
  onAssignTicket,
  assigningTicketId,
  modelConfig,
  variant = 'page',
  defaultTab = 'flowchart',
  showManageTab = true,
}: any) {
  const [tab, setTab] = useState<EpicScopeTab>(defaultTab);
  const [showPhaseForm, setShowPhaseForm] = useState(false);
  const [showSpecForm, setShowSpecForm] = useState(false);
  const epicPhases = phases.filter((p: any) => p.epic_id === epic?.id);
  const epicSpecItems = specItems.filter((s: any) => s.epic_id === epic?.id);
  const spec = specProgress(epicSpecItems);
  const cardPool = allCards || tickets;

  const phaseSection = epic && (
    <PhaseFlowchartView
      phases={epicPhases}
      tickets={tickets}
      columns={columns}
      phaseForms={phaseForms}
      onPhaseFormChange={onPhaseFormChange}
      onSavePhase={onSavePhase}
      autoSavePhaseSettings={autoSavePhaseSettings}
      phaseSavingId={phaseSavingId}
      onAddTicket={onAddTicket}
      addingTicketPhaseId={addingTicketPhaseId}
      onAddPhase={(name: string) => {
        onAddPhase?.(name);
        setShowPhaseForm(false);
      }}
      creatingPhase={creatingPhase}
      onRunPhase={onRunPhase}
      onStopPhase={onStopPhase}
      onReorderPhases={onReorderPhases}
      phaseStoppingId={phaseStoppingId}
      onOpenCard={onOpenCard}
      modelConfig={modelConfig}
    />
  );

  // ── Epic page: spec-first layout ──────────────────────────────────
  if (variant === 'page' && epic) {
    return (
      <div className="space-y-8" data-testid="epic-scope-workbench">
        <EpicScopeHeader
          epic={epic}
          phases={epicPhases}
          tickets={tickets}
          columns={columns}
          specItems={epicSpecItems}
        />

        <div>
          <SectionLabel
            step={1}
            title="Spec decisions"
            icon={ScrollText}
            action={
              !showSpecForm && epicSpecItems.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowSpecForm(true)}
                  disabled={specSavingId === 'new'}
                  className="inline-flex items-center gap-1 text-xs font-medium text-emerald-300 bg-emerald-600/20 hover:bg-emerald-600/30 px-2.5 py-1.5 rounded-lg"
                >
                  <Plus size={12} />
                  Spec decision
                </button>
              ) : null
            }
          />
          <EpicSpecView
            specItems={epicSpecItems}
            cards={cardPool}
            columns={columns}
            onAddSpecItem={onAddSpecItem}
            onUpdateSpecItem={onUpdateSpecItem}
            onDecideForMe={onDecideForMe}
            onOpenCard={onOpenCard}
            savingId={specSavingId}
            layout="grid"
            showHeader={false}
            addFormOpen={showSpecForm || epicSpecItems.length === 0}
            onAddFormOpenChange={setShowSpecForm}
          />
        </div>

        <div>
          <SectionLabel
            step={2}
            title="Phases & tickets"
            icon={GitBranch}
            action={
              !showPhaseForm && epicPhases.length > 0 ? (
                <div className="flex items-center gap-2">
                  {onAutoSortPhases && epicPhases.length > 1 && (
                    <button
                      type="button"
                      onClick={() => onAutoSortPhases()}
                      title="Reorder phases so blocker prerequisites come first"
                      className="inline-flex items-center gap-1 text-xs font-medium text-gray-300 bg-white/[0.06] hover:bg-white/[0.1] px-2.5 py-1.5 rounded-lg"
                      data-testid="phases-auto-sort"
                    >
                      <ArrowDownWideNarrow size={12} />
                      Auto-order
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowPhaseForm(true)}
                    disabled={creatingPhase}
                    className="inline-flex items-center gap-1 text-xs font-medium text-emerald-300 bg-emerald-600/20 hover:bg-emerald-600/30 px-2.5 py-1.5 rounded-lg"
                  >
                    <Plus size={12} />
                    Phase
                  </button>
                </div>
              ) : null
            }
          />
          {showPhaseForm && epicPhases.length > 0 && (
            <div className="mb-3 max-w-md">
              <AddPhaseForm
                saving={creatingPhase}
                inline
                onCancel={() => setShowPhaseForm(false)}
                onSubmit={(name: string) => {
                  onAddPhase?.(name);
                  setShowPhaseForm(false);
                }}
              />
            </div>
          )}
          {spec.open > 0 && (
            <p className="text-[11px] text-gray-500 mb-3">
              You can draft phases and tickets now — autonomous runs unlock once all spec decisions
              are locked.
            </p>
          )}
          <UnassignedTicketsView
            tickets={tickets}
            phases={epicPhases}
            columns={columns}
            assigningTicketId={assigningTicketId}
            onAssignTicket={onAssignTicket}
            onOpenCard={onOpenCard}
          />
          {phaseSection}
        </div>
      </div>
    );
  }

  // ── Epic list (no epic selected) ────────────────────────────────────
  if (variant === 'page' && !epic) {
    return (
      <div className="space-y-6" data-testid="epic-scope-workbench">
        <EpicManageListView
          epics={epics}
          phases={phases}
          cards={cardPool}
          columns={columns}
          projectName={projectName}
          onOpenEpic={onOpenEpic}
          onCreateEpic={onCreateEpic}
          creating={creatingEpic}
        />
      </div>
    );
  }

  // ── Compact: scoping side panel (tabbed) ──────────────────────────
  return (
    <div className="space-y-4" data-testid="epic-scope-workbench">
      {epic && (
        <EpicScopeHeader
          epic={epic}
          phases={epicPhases}
          tickets={tickets}
          columns={columns}
          specItems={epicSpecItems}
          compact
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {COMPACT_TABS.filter((t) => t.id !== 'manage' || showManageTab).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${
              tab === t.id
                ? 'bg-white/[0.1] text-gray-100 ring-1 ring-white/[0.12]'
                : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.04]'
            }`}
            data-testid={`scope-tab-${t.id}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {spec.open > 0 && tab === 'flowchart' && (
        <p className="text-[11px] text-amber-400/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
          {spec.open} open spec decision{spec.open !== 1 ? 's' : ''} — lock them before autonomous
          runs.
        </p>
      )}

      {tab === 'flowchart' && epic && (
        <UnassignedTicketsView
          tickets={tickets}
          phases={epicPhases}
          columns={columns}
          assigningTicketId={assigningTicketId}
          onAssignTicket={onAssignTicket}
          onOpenCard={onOpenCard}
        />
      )}
      {tab === 'flowchart' && epic && phaseSection}
      {tab === 'flowchart' && !epic && (
        <p className="text-sm text-gray-500 py-6 text-center">
          Select an epic to view its flowchart.
        </p>
      )}

      {tab === 'manage' && (
        <EpicManageListView
          epics={epics}
          phases={phases}
          cards={cardPool}
          columns={columns}
          projectName={projectName}
          activeEpicId={epic?.id}
          onOpenEpic={(id: string) => {
            onOpenEpic?.(id);
            setTab('flowchart');
          }}
          onCreateEpic={onCreateEpic}
          creating={creatingEpic}
        />
      )}

      {tab === 'spec' && epic && (
        <EpicSpecView
          specItems={epicSpecItems}
          cards={cardPool}
          columns={columns}
          onAddSpecItem={onAddSpecItem}
          onUpdateSpecItem={onUpdateSpecItem}
          onDecideForMe={onDecideForMe}
          savingId={specSavingId}
          layout="stack"
        />
      )}

      {tab === 'spec' && !epic && (
        <p className="text-sm text-gray-500 py-6 text-center">
          Select an epic to view spec decisions.
        </p>
      )}
    </div>
  );
}
