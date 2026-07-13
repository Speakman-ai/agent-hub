import MermaidDiagram from './MermaidDiagram';
import { buildEpicFlowchartMermaid } from '../utils/epicFlowchart';

/** Read-only flowchart of Epic → Phase → Ticket hierarchy with blocker edges. */
export default function EpicFlowchart({ epic, phases, cards, columns, className = '' }: any) {
  if (!epic) {
    return (
      <div
        className={`rounded-xl border border-white/[0.08] bg-white/[0.02] p-8 text-center text-sm text-gray-500 ${className}`}
      >
        Select an epic to view its flowchart.
      </div>
    );
  }

  const columnNameById = Object.fromEntries((columns || []).map((c: any) => [c.id, c.name]));
  const source = buildEpicFlowchartMermaid({
    epic,
    phases: phases || [],
    cards: cards || [],
    columnNameById,
  });

  return (
    <div
      className={`rounded-xl border border-white/[0.08] bg-white/[0.02] overflow-hidden ${className}`}
      data-testid="epic-flowchart"
    >
      <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-100">Scope flowchart</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Feature → Phases → Tickets with blocker dependencies
          </p>
        </div>
      </div>
      <div className="p-4 overflow-x-auto min-h-[200px]">
        <MermaidDiagram source={source} />
      </div>
    </div>
  );
}
