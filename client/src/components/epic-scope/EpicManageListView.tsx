import { Plus, Zap } from 'lucide-react';
import {
  countDoneTickets,
  columnNameById,
  epicAutonomousSummary,
  phasesForEpic,
  ticketsForEpic,
} from '../../utils/epicScopeStats';

/** Manage epics list — card grid with phase pills and open-flow links. */
export default function EpicManageListView({
  epics,
  phases,
  cards,
  columns,
  projectName,
  activeEpicId,
  onOpenEpic,
  onCreateEpic,
  creating,
}: any) {
  const colMap = columnNameById(columns);

  return (
    <div data-testid="epic-manage-list">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h3 className="text-sm font-semibold text-gray-200">Epics in {projectName || 'project'}</h3>
        {onCreateEpic && (
          <button
            type="button"
            onClick={onCreateEpic}
            disabled={creating}
            className="inline-flex items-center gap-1 text-xs font-medium text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/15 px-2.5 py-1.5 rounded-lg transition-colors"
          >
            <Plus size={12} />
            New epic
          </button>
        )}
      </div>

      {epics.length === 0 ? (
        <p className="text-sm text-gray-500 py-8 text-center">No epics yet.</p>
      ) : (
        <div className="space-y-3">
          {epics.map((epic: any) => {
            const epicPhases = phasesForEpic(phases, epic.id);
            const epicTickets = ticketsForEpic(cards, epic.id);
            const done = countDoneTickets(epicTickets, colMap);
            const auto = epicAutonomousSummary(epicPhases);
            const isActive = epic.id === activeEpicId;

            return (
              <button
                key={epic.id}
                type="button"
                onClick={() => onOpenEpic?.(epic.id)}
                className={`w-full text-left rounded-xl border p-4 transition-colors cursor-pointer ${
                  isActive
                    ? 'border-indigo-500/40 bg-indigo-500/[0.06]'
                    : 'border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/[0.12]'
                }`}
                data-testid={`manage-epic-${epic.id}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: epic.color || '#6366f1' }}
                      />
                      <h4 className="text-sm font-semibold text-gray-100">{epic.name}</h4>
                      {auto.label && (
                        <span
                          className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                            auto.label === 'ALL AUTO'
                              ? 'text-emerald-300 bg-emerald-500/15'
                              : 'text-teal-300 bg-teal-500/15'
                          }`}
                        >
                          {auto.label}
                        </span>
                      )}
                    </div>
                    {epic.description ? (
                      <p className="text-xs text-gray-500 mt-1.5 line-clamp-2">
                        {epic.description}
                      </p>
                    ) : null}

                    {epicPhases.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-3">
                        {epicPhases.map((phase: any, i: number) => (
                          <span
                            key={phase.id}
                            className="inline-flex items-center gap-1 text-[10px] text-gray-400 bg-white/[0.04] border border-white/[0.06] px-2 py-0.5 rounded-full"
                          >
                            {i + 1}. {phase.name}
                            {phase.autonomous === 1 && (
                              <Zap size={9} className="text-emerald-400" />
                            )}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="text-right shrink-0 space-y-2">
                    <div className="w-20 h-1 rounded-full bg-white/[0.06] overflow-hidden ml-auto">
                      <div
                        className="h-full bg-emerald-500/70 rounded-full"
                        style={{
                          width: `${
                            epicTickets.length ? Math.round((done / epicTickets.length) * 100) : 0
                          }%`,
                        }}
                      />
                    </div>
                    <p className="text-[10px] text-gray-500">
                      {done}/{epicTickets.length}
                      {auto.autoCount > 0 && ` · ${auto.autoCount} auto`}
                    </p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
