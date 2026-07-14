import { useState } from 'react';
import {
  ArrowRight,
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  Play,
  Plus,
  Square,
  Zap,
} from 'lucide-react';
import {
  columnDotStyle,
  columnNameById,
  columnStatusStyle,
  phaseComplete,
  phaseProgress,
  priorityStyle,
  ticketHasBlockers,
  ticketsForPhase,
} from '../../utils/epicScopeStats';
import { autonomousModelOptions } from '../../utils/epics';
import { AddPhaseForm, AddTicketForm } from './ScopeForms';

function Toggle({ checked, onChange, label }: any) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border border-transparent transition-colors ${
        checked ? 'bg-emerald-600' : 'bg-white/10'
      }`}
    >
      <span
        className={`pointer-events-none absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

function PhaseColumn({
  phase,
  index,
  tickets,
  columns,
  phaseForm,
  onPhaseFormChange,
  onSavePhase,
  saving,
  onAddTicket,
  addingTicketPhaseId,
  onRunPhase,
  onStopPhase,
  onOpenCard,
  onMoveLeft,
  onMoveRight,
  running,
  stopping,
  modelConfig,
}: any) {
  const colMap = columnNameById(columns);
  const phaseTickets = ticketsForPhase(tickets, phase.id);
  const progress = phaseProgress(phaseTickets, colMap);
  const complete = phaseComplete(phaseTickets, colMap);
  const autonomous = !!phaseForm?.autonomous;
  const autoMerge = phaseForm?.autonomous_send_it === 1;
  const maxConcurrent = phaseForm?.autonomous_max_concurrent ?? 1;
  const selectedModel = phaseForm?.autonomous_model ?? '';
  const modelOptions = autonomousModelOptions(modelConfig);
  const addingTicket = addingTicketPhaseId === phase.id;
  const [showTicketForm, setShowTicketForm] = useState(false);

  return (
    <div
      className={`flex shrink-0 w-[260px] flex-col rounded-xl border overflow-hidden transition-colors ${
        complete
          ? 'border-emerald-500/40 bg-emerald-950/40 ring-1 ring-emerald-500/20'
          : 'border-white/[0.08] bg-[#0d1117]/80'
      }`}
      data-testid={`phase-column-${phase.id}`}
      data-complete={complete ? 'true' : 'false'}
    >
      <div
        className={`px-3 pt-3 pb-2 border-b ${
          complete ? 'border-emerald-500/20' : 'border-white/[0.06]'
        }`}
      >
        <div className="flex items-start gap-2">
          <span
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-bold ${
              complete ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/[0.06] text-gray-300'
            }`}
          >
            {complete ? <Check size={13} strokeWidth={3} /> : index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <h3 className="text-sm font-semibold text-gray-100 truncate">{phase.name}</h3>
              {complete && (
                <span className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-300 bg-emerald-500/20 px-1.5 py-0.5 rounded">
                  <Check size={9} strokeWidth={3} />
                  Done
                </span>
              )}
              {autonomous && (
                <span className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-300 bg-emerald-500/15 px-1.5 py-0.5 rounded">
                  <Zap size={9} />
                  Auto
                </span>
              )}
            </div>
            {phase.description ? (
              <p className="text-[11px] text-gray-500 mt-1 line-clamp-2 leading-snug">
                {phase.description}
              </p>
            ) : null}
          </div>
          {(onMoveLeft || onMoveRight) && (
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onClick={onMoveLeft}
                disabled={!onMoveLeft}
                title="Move phase earlier"
                aria-label={`Move phase ${phase.name} earlier`}
                data-testid={`phase-move-left-${phase.id}`}
                className="flex h-5 w-5 items-center justify-center rounded text-gray-500 hover:text-gray-200 hover:bg-white/[0.08] disabled:opacity-25 disabled:hover:bg-transparent"
              >
                <ChevronLeft size={13} />
              </button>
              <button
                type="button"
                onClick={onMoveRight}
                disabled={!onMoveRight}
                title="Move phase later"
                aria-label={`Move phase ${phase.name} later`}
                data-testid={`phase-move-right-${phase.id}`}
                className="flex h-5 w-5 items-center justify-center rounded text-gray-500 hover:text-gray-200 hover:bg-white/[0.08] disabled:opacity-25 disabled:hover:bg-transparent"
              >
                <ChevronRight size={13} />
              </button>
            </div>
          )}
        </div>
        <div className="mt-2.5 h-1 rounded-full bg-white/[0.06] overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              complete ? 'bg-emerald-400' : 'bg-emerald-500/70'
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <div className="px-3 py-2 space-y-2 border-b border-white/[0.04] bg-white/[0.01]">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-gray-500 uppercase tracking-wide">Auto-dispatch</span>
            <Toggle
              checked={autonomous}
              label={`Auto-dispatch for ${phase.name}`}
              onChange={(on: boolean) => onPhaseFormChange?.({ autonomous: on ? 1 : 0 })}
            />
          </div>
          {running ? (
            <div className="flex items-center gap-1.5">
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-300 bg-emerald-500/15 px-2 py-1 rounded-md">
                <Play size={10} fill="currentColor" />
                Running
              </span>
              <button
                type="button"
                onClick={() => onStopPhase?.(phase.id)}
                disabled={stopping}
                data-testid={`stop-phase-${phase.id}`}
                className="inline-flex items-center gap-1 text-[10px] font-medium text-red-300 hover:text-red-200 bg-red-500/10 hover:bg-red-500/15 disabled:opacity-50 px-2 py-1 rounded-md transition-colors"
              >
                <Square size={10} fill="currentColor" />
                {stopping ? 'Stopping…' : 'Stop'}
              </button>
            </div>
          ) : autonomous ? (
            <button
              type="button"
              onClick={() => onRunPhase?.(phase.id)}
              className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-300 hover:text-emerald-200 bg-emerald-500/10 hover:bg-emerald-500/15 px-2 py-1 rounded-md transition-colors"
            >
              <Play size={10} fill="currentColor" />
              Run phase
            </button>
          ) : null}
        </div>
        <div className="space-y-1">
          <label
            htmlFor={`phase-model-${phase.id}`}
            className="text-[10px] text-gray-500 uppercase tracking-wide"
          >
            Session model
          </label>
          <select
            id={`phase-model-${phase.id}`}
            value={selectedModel}
            onChange={(e: any) => onPhaseFormChange?.({ autonomous_model: e.target.value })}
            data-testid={`phase-model-${phase.id}`}
            className="w-full rounded-md border border-white/[0.08] bg-[#10151d] px-2 py-1.5 text-[11px] text-gray-200 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
          >
            <option value="">Each agent&apos;s default</option>
            {selectedModel && !modelOptions.includes(selectedModel) ? (
              <option value={selectedModel}>{selectedModel}</option>
            ) : null}
            {modelConfig?.engineValidModels
              ? Object.entries(modelConfig.engineValidModels).map(([engine, models]: any) => (
                  <optgroup key={engine} label={engine}>
                    {(models || []).map((model: any) => (
                      <option key={`${engine}:${model}`} value={model}>
                        {model}
                      </option>
                    ))}
                  </optgroup>
                ))
              : modelOptions.map((model: any) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
          </select>
        </div>
        {autonomous && (
          <div className="flex items-center justify-between gap-2">
            <label className="text-[10px] text-gray-500 uppercase tracking-wide">
              Tickets at once
            </label>
            <input
              type="number"
              min={1}
              max={10}
              value={maxConcurrent}
              onChange={(e: any) => {
                const n = Math.min(10, Math.max(1, parseInt(e.target.value, 10) || 1));
                onPhaseFormChange?.({ autonomous_max_concurrent: n });
              }}
              className="w-14 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[11px] text-gray-200 text-center focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
              data-testid={`phase-max-concurrent-${phase.id}`}
            />
          </div>
        )}
        {autonomous && (
          <div
            className="flex items-center justify-between gap-2"
            data-testid={`phase-auto-merge-${phase.id}`}
          >
            <span
              className="text-[10px] text-gray-500 uppercase tracking-wide"
              title="Dispatched tickets run at Auto Merge — build, review, test, push, and auto-merge once gates pass. Keep this on so PRs don't stack and stall the next phase."
            >
              Auto Merge
            </span>
            <Toggle
              checked={autoMerge}
              label={`Auto Merge for ${phase.name}`}
              onChange={(on: boolean) => onPhaseFormChange?.({ autonomous_send_it: on ? 1 : 0 })}
            />
          </div>
        )}
        {!running && autonomous && (
          <p className="text-[10px] text-gray-600 leading-snug">
            Run phase dispatches implementation tickets as build sessions after all spec decisions
            are locked, each at Auto Merge so the next phase starts automatically when this one
            finishes. Save settings first, then click Run phase.
          </p>
        )}
      </div>

      <ul className="flex-1 overflow-y-auto px-2 py-2 space-y-1.5 min-h-[120px] max-h-[280px]">
        {phaseTickets.length === 0 ? (
          <li className="text-[11px] text-gray-600 text-center py-4 px-2">No tickets yet</li>
        ) : (
          phaseTickets.map((ticket: any) => {
            const col = colMap[ticket.column_id] || 'To Do';
            const blocked = ticketHasBlockers(ticket);
            return (
              <li key={ticket.id}>
                <button
                  type="button"
                  onClick={() => onOpenCard?.(ticket)}
                  className="w-full text-left rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 hover:bg-white/[0.05] hover:border-white/[0.12] transition-colors cursor-pointer"
                  data-testid={`phase-ticket-${ticket.id}`}
                >
                  <div className="flex items-start gap-2">
                    <span
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${columnDotStyle(col)}`}
                      title={col}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-gray-200 leading-snug line-clamp-2">
                        {ticket.title}
                      </p>
                      <div className="flex flex-wrap items-center gap-1 mt-1.5">
                        {(ticket.card_kind === 'spike' || ticket.title?.startsWith('Spike:')) && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide text-violet-300 bg-violet-500/15 px-1.5 py-0.5 rounded">
                            <Zap size={9} />
                            spike
                          </span>
                        )}
                        <span
                          className={`text-[9px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded ring-1 ring-inset ${columnStatusStyle(col)}`}
                        >
                          {col}
                        </span>
                        {ticket.priority && (
                          <span
                            className={`text-[9px] font-medium ${priorityStyle(ticket.priority)}`}
                          >
                            {ticket.priority}
                          </span>
                        )}
                        {blocked && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] text-red-400">
                            <Ban size={9} />
                            blocked
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </button>
              </li>
            );
          })
        )}
      </ul>

      <div className="border-t border-white/[0.06]">
        {showTicketForm ? (
          <AddTicketForm
            saving={addingTicket}
            onCancel={() => setShowTicketForm(false)}
            onSubmit={(title: string) => {
              onAddTicket?.(phase.id, title);
              setShowTicketForm(false);
            }}
          />
        ) : (
          <button
            type="button"
            disabled={addingTicket}
            onClick={() => setShowTicketForm(true)}
            className="w-full flex items-center justify-center gap-1 text-[11px] text-gray-500 hover:text-gray-300 py-2 rounded-lg hover:bg-white/[0.04] transition-colors disabled:opacity-40"
          >
            <Plus size={12} />
            Add ticket
          </button>
        )}
      </div>

      {onSavePhase && (
        <div className="px-2 pb-2">
          <button
            type="button"
            onClick={onSavePhase}
            disabled={saving}
            className="w-full text-[10px] py-1 text-gray-500 hover:text-emerald-300 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save phase settings'}
          </button>
        </div>
      )}
    </div>
  );
}

/** Horizontal phase columns with sequential connectors — primary flowchart view. */
export default function PhaseFlowchartView({
  phases,
  tickets,
  columns,
  phaseForms,
  onPhaseFormChange,
  onSavePhase,
  phaseSavingId,
  onAddTicket,
  addingTicketPhaseId,
  onAddPhase,
  creatingPhase,
  onRunPhase,
  onStopPhase,
  onReorderPhases,
  phaseStoppingId,
  onOpenCard,
  modelConfig,
}: any) {
  const movePhase = (index: number, delta: number) => {
    const ids = phases.map((p: any) => p.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    onReorderPhases?.(ids);
  };
  const [showEmptyPhaseForm, setShowEmptyPhaseForm] = useState(false);
  const [showTrailingPhaseForm, setShowTrailingPhaseForm] = useState(false);

  if (phases.length === 0) {
    return (
      <div
        className="rounded-xl border border-dashed border-white/[0.1] bg-white/[0.01] px-6 py-8"
        data-testid="phase-flowchart-view"
      >
        {showEmptyPhaseForm ? (
          <AddPhaseForm
            saving={creatingPhase}
            autoFocus
            onCancel={() => setShowEmptyPhaseForm(false)}
            onSubmit={(name: string) => {
              onAddPhase?.(name);
              setShowEmptyPhaseForm(false);
            }}
          />
        ) : (
          <div className="text-center">
            <p className="text-sm font-medium text-gray-300 mb-1">No phases yet</p>
            <p className="text-xs text-gray-500 max-w-md mx-auto mb-4">
              Add phases to group implementation tickets. Spike tickets from spec decisions land in
              To Do until assigned.
            </p>
            <button
              type="button"
              onClick={() => setShowEmptyPhaseForm(true)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-300 bg-emerald-600/20 hover:bg-emerald-600/30 px-3 py-2 rounded-lg"
            >
              <Plus size={14} />
              Add first phase
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto pb-2" data-testid="phase-flowchart-view">
      <div className="flex items-stretch gap-0 min-w-min px-1">
        {phases.map((phase: any, index: number) => (
          <div key={phase.id} className="flex items-stretch">
            <PhaseColumn
              phase={phase}
              index={index}
              tickets={tickets}
              columns={columns}
              phaseForm={phaseForms?.[phase.id]}
              onPhaseFormChange={(patch: any) => onPhaseFormChange?.(phase.id, patch)}
              onSavePhase={() => onSavePhase?.(phase, phaseForms?.[phase.id])}
              saving={phaseSavingId === phase.id}
              onAddTicket={onAddTicket}
              addingTicketPhaseId={addingTicketPhaseId}
              onRunPhase={onRunPhase}
              onStopPhase={onStopPhase}
              onOpenCard={onOpenCard}
              onMoveLeft={onReorderPhases && index > 0 ? () => movePhase(index, -1) : undefined}
              onMoveRight={
                onReorderPhases && index < phases.length - 1 ? () => movePhase(index, 1) : undefined
              }
              running={!!phase.autonomous_running}
              stopping={phaseStoppingId === phase.id}
              modelConfig={modelConfig}
            />
            {index < phases.length - 1 && (
              <div className="flex items-center px-1 self-center" aria-hidden>
                <ArrowRight size={18} className="text-emerald-500/50" strokeDasharray="4 3" />
              </div>
            )}
          </div>
        ))}

        {showTrailingPhaseForm ? (
          <div className="flex shrink-0 w-[260px] mx-2">
            <AddPhaseForm
              saving={creatingPhase}
              submitLabel="Add"
              onCancel={() => setShowTrailingPhaseForm(false)}
              onSubmit={(name: string) => {
                onAddPhase?.(name);
                setShowTrailingPhaseForm(false);
              }}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowTrailingPhaseForm(true)}
            disabled={creatingPhase}
            className="flex shrink-0 w-[200px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/[0.12] bg-white/[0.01] hover:bg-white/[0.03] hover:border-emerald-500/30 text-gray-500 hover:text-gray-300 transition-colors mx-2 min-h-[200px]"
            data-testid="add-phase-column"
          >
            <Plus size={20} className="opacity-60" />
            <span className="text-xs font-medium">{creatingPhase ? 'Adding…' : 'Add phase'}</span>
          </button>
        )}
      </div>
    </div>
  );
}
