import { useMemo } from 'react';
import { ArrowRight, Ban, LoaderCircle } from 'lucide-react';
import {
  columnDotStyle,
  columnNameById,
  columnStatusStyle,
  priorityStyle,
  ticketHasBlockers,
} from '../../utils/epicScopeStats';

export default function UnassignedTicketsView({
  tickets = [],
  phases = [],
  columns = [],
  assigningTicketId,
  onAssignTicket,
  onOpenCard,
}: any) {
  const unassignedTickets = useMemo(
    () => (tickets || []).filter((ticket: any) => !ticket.phase_id),
    [tickets],
  );
  const colMap = columnNameById(columns);

  if (unassignedTickets.length === 0) return null;

  return (
    <section
      className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] overflow-hidden"
      data-testid="unassigned-tickets"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/15 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-amber-100">Unassigned tickets</h3>
          <p className="mt-0.5 text-xs text-amber-200/60">
            These tickets are linked to this epic but not included in a phase.
          </p>
        </div>
        <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-200">
          {unassignedTickets.length}
        </span>
      </div>

      <ul className="divide-y divide-amber-500/10">
        {unassignedTickets.map((ticket: any) => {
          const column = colMap[ticket.column_id] || 'To Do';
          const assigning = assigningTicketId === ticket.id;
          const blocked = ticketHasBlockers(ticket);
          return (
            <li
              key={ticket.id}
              className="flex flex-wrap items-center gap-3 px-4 py-3"
              data-testid={`unassigned-ticket-${ticket.id}`}
            >
              <button
                type="button"
                onClick={() => onOpenCard?.(ticket)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="flex items-start gap-2">
                  <span
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${columnDotStyle(column)}`}
                    title={column}
                  />
                  <div className="min-w-0">
                    <p className="text-xs font-medium leading-snug text-gray-200">{ticket.title}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      <span
                        className={`text-[9px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded ring-1 ring-inset ${columnStatusStyle(column)}`}
                      >
                        {column}
                      </span>
                      {ticket.priority ? (
                        <span
                          className={`text-[9px] font-medium ${priorityStyle(ticket.priority)}`}
                        >
                          {ticket.priority}
                        </span>
                      ) : null}
                      {blocked ? (
                        <span className="inline-flex items-center gap-0.5 text-[9px] text-red-400">
                          <Ban size={9} />
                          blocked
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              </button>

              <div className="flex shrink-0 items-center gap-2">
                <ArrowRight size={14} className="text-amber-300/50" aria-hidden />
                <label className="sr-only" htmlFor={`assign-phase-${ticket.id}`}>
                  Assign {ticket.title} to a phase
                </label>
                <div className="relative">
                  {assigning ? (
                    <LoaderCircle
                      size={13}
                      className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 animate-spin text-amber-200"
                      aria-hidden
                    />
                  ) : null}
                  <select
                    id={`assign-phase-${ticket.id}`}
                    value=""
                    disabled={Boolean(assigningTicketId) || phases.length === 0}
                    onChange={(event) => {
                      const phaseId = event.target.value;
                      if (phaseId) onAssignTicket?.(ticket.id, phaseId);
                    }}
                    data-testid={`assign-phase-${ticket.id}`}
                    className="max-w-[190px] rounded-lg border border-amber-500/20 bg-[#17140d] px-2.5 py-1.5 pr-7 text-[11px] text-amber-100 focus:outline-none focus:ring-1 focus:ring-amber-400/40 disabled:opacity-50"
                  >
                    <option value="">Assign to phase</option>
                    {phases.map((phase: any, index: number) => (
                      <option key={phase.id} value={phase.id}>
                        {index + 1}. {phase.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
