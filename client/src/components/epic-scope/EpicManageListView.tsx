import { Plus, Trash2, Zap } from 'lucide-react';
import {
  countDoneTickets,
  columnNameById,
  phasesForEpic,
  ticketsForEpic,
} from '../../utils/epicScopeStats';
import { parseCardLabels } from '../../utils/kanbanLabels';
import { usernameForUserId } from '../../utils/kanbanUserFilter';
import { epicStateLabel } from '../../utils/epics';

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
  onDeleteEpic,
  deleteBusyEpicId,
  assignableUsers = [],
  emptyMessage = 'No features yet.',
}: any) {
  const colMap = columnNameById(columns);

  return (
    <div data-testid="epic-manage-list">
      {(projectName || onCreateEpic) && (
        <div className="flex items-center justify-between gap-3 mb-4">
          {projectName ? (
            <h3 className="text-sm font-semibold text-gray-200">Features in {projectName}</h3>
          ) : (
            <span />
          )}
          {onCreateEpic ? (
            <button
              type="button"
              onClick={onCreateEpic}
              disabled={creating}
              className="inline-flex items-center gap-1 text-xs font-medium text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/15 px-2.5 py-1.5 rounded-lg transition-colors"
            >
              <Plus size={12} />
              New feature
            </button>
          ) : null}
        </div>
      )}

      {epics.length === 0 ? (
        <p className="text-sm text-gray-500 py-8 text-center" data-testid="epic-manage-empty">
          {emptyMessage}
        </p>
      ) : (
        <div className="space-y-3">
          {epics.map((epic: any) => {
            const epicPhases = phasesForEpic(phases, epic.id);
            const epicTickets = ticketsForEpic(cards, epic.id);
            const done = countDoneTickets(epicTickets, colMap);
            const isActive = epic.id === activeEpicId;
            const isEmpty = epicTickets.length === 0;
            const deleting = deleteBusyEpicId === epic.id;
            const epicLabels = parseCardLabels(epic.labels);
            const leadUser = usernameForUserId(assignableUsers, epic.assigned_user_id);
            const stateLabel = epicStateLabel(epic.state);

            return (
              <div
                key={epic.id}
                className={`rounded-xl border p-4 transition-colors ${
                  isActive
                    ? 'border-indigo-500/40 bg-indigo-500/[0.06]'
                    : isEmpty
                      ? 'border-white/[0.06] bg-white/[0.015] opacity-90'
                      : 'border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/[0.12]'
                }`}
                data-testid={`manage-epic-${epic.id}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => onOpenEpic?.(epic.id)}
                    className="min-w-0 flex-1 text-left cursor-pointer"
                    data-testid={`epic-manage-open-${epic.id}`}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: epic.color || '#6366f1' }}
                      />
                      <h4 className="text-sm font-semibold text-gray-100">{epic.name}</h4>
                      {isEmpty ? (
                        <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-medium text-gray-500">
                          Empty
                        </span>
                      ) : null}
                      {stateLabel ? (
                        <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-medium text-gray-400">
                          {stateLabel}
                        </span>
                      ) : null}
                      {leadUser ? (
                        <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-medium text-sky-300">
                          @{leadUser}
                        </span>
                      ) : null}
                    </div>
                    {epic.description ? (
                      <p className="text-xs text-gray-500 mt-1.5 line-clamp-2">
                        {epic.description}
                      </p>
                    ) : null}

                    {epicLabels.length > 0 ? (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {epicLabels.map((label) => (
                          <span
                            key={label}
                            className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-[10px] text-gray-400"
                          >
                            {label}
                          </span>
                        ))}
                      </div>
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
                  </button>

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
                    </p>
                    {onDeleteEpic ? (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onDeleteEpic(epic);
                        }}
                        disabled={deleting}
                        className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] px-2 py-1 text-[10px] font-medium text-red-400 hover:border-red-500/30 hover:bg-red-500/10 disabled:opacity-50"
                        data-testid={`epic-manage-delete-${epic.id}`}
                        aria-label={`Delete epic ${epic.name}`}
                      >
                        <Trash2 size={10} />
                        {deleting ? 'Deleting…' : 'Delete'}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
