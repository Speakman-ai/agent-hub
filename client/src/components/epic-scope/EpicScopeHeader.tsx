import { countDoneTickets, columnNameById, specProgress } from '../../utils/epicScopeStats';

/** Epic banner with ticket + spec progress — top of the epic page. */
export default function EpicScopeHeader({
  epic,
  phases,
  tickets,
  columns,
  specItems = [],
  compact = false,
}: any) {
  if (!epic) return null;

  const colMap = columnNameById(columns);
  const done = countDoneTickets(tickets, colMap);
  const total = tickets.length;
  const ticketProgress = total > 0 ? Math.round((done / total) * 100) : 0;
  const spec = specProgress(specItems);

  return (
    <div
      className={`rounded-xl border border-white/[0.08] bg-gradient-to-br from-white/[0.03] to-transparent ${
        compact ? 'p-3' : 'p-5'
      }`}
      data-testid="epic-scope-header"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            <span
              className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{
                color: epic.color || '#818cf8',
                backgroundColor: `${epic.color || '#6366f1'}22`,
              }}
            >
              Feature
            </span>
            <h2
              className={`font-semibold text-gray-100 truncate ${compact ? 'text-sm' : 'text-lg'}`}
            >
              {epic.name}
            </h2>
          </div>
          {epic.description ? (
            <p
              className={`text-gray-500 leading-snug max-w-3xl ${compact ? 'text-xs line-clamp-2' : 'text-sm'}`}
            >
              {epic.description}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-4 shrink-0 text-right">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-gray-600 mb-0.5">Spec</p>
            <p className="text-sm text-gray-200 font-medium">
              {spec.chosen}/{spec.total || '—'}
              <span className="text-gray-500 font-normal text-xs ml-1">locked</span>
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-gray-600 mb-0.5">Tickets</p>
            <p className="text-sm text-gray-200 font-medium">
              {done}/{total}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-gray-600 mb-0.5">Phases</p>
            <p className="text-sm text-gray-200 font-medium">{phases.length}</p>
          </div>
        </div>
      </div>

      <div className={`grid gap-3 ${compact ? 'mt-3' : 'mt-4 sm:grid-cols-2'}`}>
        <div>
          <div className="flex items-center justify-between text-[10px] text-gray-500 mb-1">
            <span>Spec decisions</span>
            <span>{spec.pct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-violet-600 to-violet-400 transition-all"
              style={{ width: `${spec.pct}%` }}
            />
          </div>
        </div>
        {!compact && (
          <div>
            <div className="flex items-center justify-between text-[10px] text-gray-500 mb-1">
              <span>Implementation tickets</span>
              <span>{ticketProgress}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all"
                style={{ width: `${ticketProgress}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {!compact && spec.total > 0 && !spec.readyForImplementation && (
        <p className="text-[11px] text-amber-400/80 mt-3">
          Lock all open spec decisions (write them yourself or use Decide for me) before autonomous
          implementation runs.
        </p>
      )}
    </div>
  );
}
