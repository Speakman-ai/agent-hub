import { Trash2, Zap } from 'lucide-react';
import {
  countDoneTickets,
  columnNameById,
  phasesForEpic,
  ticketsForEpic,
} from '../../utils/epicScopeStats';
import { parseCardLabels } from '../../utils/kanbanLabels';
import { usernameForUserId } from '../../utils/kanbanUserFilter';
import { groupEpicsByState, type EpicBoardColumnKey } from '../../utils/epicBoard';

const COLUMN_ACCENT: Record<EpicBoardColumnKey, string> = {
  not_started: 'bg-gray-500',
  in_progress: 'bg-sky-400',
  done: 'bg-emerald-400',
};

/**
 * Read-only kanban board of epics grouped by lifecycle state (Not started /
 * In progress / Done). Columns are fixed and non-droppable — cards open the
 * epic on click but cannot be dragged between columns (an epic's state is
 * derived from its tickets, not set directly here).
 */
export default function EpicBoardView({
  epics,
  phases,
  cards,
  columns,
  onOpenEpic,
  onDeleteEpic,
  deleteBusyEpicId,
  assignableUsers = [],
  emptyMessage = 'No epics yet.',
}: any) {
  const colMap = columnNameById(columns);
  const boardColumns = groupEpicsByState(epics as any[]);

  if ((epics || []).length === 0) {
    return (
      <p className="text-sm text-gray-500 py-8 text-center" data-testid="epic-board-empty">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-3 items-start" data-testid="epic-board">
      {boardColumns.map((column) => (
        <div
          key={column.key}
          className="rounded-xl border border-white/[0.06] bg-white/[0.015] flex flex-col min-h-[8rem]"
          data-testid={`epic-board-column-${column.key}`}
        >
          <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-white/[0.06]">
            <span className={`w-2 h-2 rounded-full ${COLUMN_ACCENT[column.key]}`} />
            <h3 className="text-xs font-semibold text-gray-200">{column.label}</h3>
            <span className="ml-auto rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium text-gray-400">
              {column.epics.length}
            </span>
          </div>

          <div className="p-2.5 space-y-2.5">
            {column.epics.length === 0 ? (
              <p className="text-[11px] text-gray-600 px-1 py-4 text-center">No epics</p>
            ) : (
              column.epics.map((epic: any) => {
                const epicPhases = phasesForEpic(phases, epic.id);
                const epicTickets = ticketsForEpic(cards, epic.id);
                const done = countDoneTickets(epicTickets, colMap);
                const epicLabels = parseCardLabels(epic.labels);
                const leadUser = usernameForUserId(assignableUsers, epic.assigned_user_id);
                const deleting = deleteBusyEpicId === epic.id;
                const pct = epicTickets.length ? Math.round((done / epicTickets.length) * 100) : 0;

                return (
                  <div
                    key={epic.id}
                    className="rounded-lg border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/[0.12] transition-colors"
                    data-testid={`epic-board-card-${epic.id}`}
                  >
                    <button
                      type="button"
                      onClick={() => onOpenEpic?.(epic.id)}
                      className="block w-full text-left p-3 cursor-pointer"
                      data-testid={`epic-board-open-${epic.id}`}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: epic.color || '#6366f1' }}
                        />
                        <h4 className="text-sm font-semibold text-gray-100 min-w-0 truncate">
                          {epic.name}
                        </h4>
                      </div>

                      {epic.description ? (
                        <p className="text-xs text-gray-500 mt-1.5 line-clamp-2">
                          {epic.description}
                        </p>
                      ) : null}

                      {leadUser ? (
                        <span className="inline-block mt-2 rounded bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-medium text-sky-300">
                          @{leadUser}
                        </span>
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

                      {epicPhases.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5 mt-2.5">
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
                      ) : null}

                      <div className="flex items-center gap-2 mt-3">
                        <div className="flex-1 h-1 rounded-full bg-white/[0.06] overflow-hidden">
                          <div
                            className="h-full bg-emerald-500/70 rounded-full"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-gray-500 shrink-0">
                          {done}/{epicTickets.length}
                        </span>
                      </div>
                    </button>

                    {onDeleteEpic ? (
                      <div className="px-3 pb-2.5 -mt-1 flex justify-end">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onDeleteEpic(epic);
                          }}
                          disabled={deleting}
                          className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] px-2 py-1 text-[10px] font-medium text-red-400 hover:border-red-500/30 hover:bg-red-500/10 disabled:opacity-50"
                          data-testid={`epic-board-delete-${epic.id}`}
                          aria-label={`Delete epic ${epic.name}`}
                        >
                          <Trash2 size={10} />
                          {deleting ? 'Deleting…' : 'Delete'}
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
