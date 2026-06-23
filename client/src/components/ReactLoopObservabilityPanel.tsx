import { useState } from 'react';
import { Activity } from 'lucide-react';

/**
 * Collapsible host ReAct / auto-continuation step log (from WebSocket `react_loop_step`).
 */
export default function ReactLoopObservabilityPanel({ steps, streaming }: any) {
  const [open, setOpen] = useState(false);
  if (!steps?.length) return null;
  const visible = steps.slice(-16);
  return (
    <div className="px-3 md:px-0 mb-2 max-w-[95%] sm:max-w-[90%] mx-auto">
      <button
        type="button"
        onClick={() => setOpen((o: any) => !o)}
        className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-400 font-mono w-full text-left"
      >
        <Activity size={14} className="shrink-0 text-cyan-600/80" />
        <span>
          Loop steps ({steps.length}){streaming ? ' · live' : ''}
        </span>
      </button>
      {(open || streaming) && (
        <ul className="mt-1.5 ml-5 space-y-0.5 text-[11px] font-mono text-gray-500 border-l border-gray-700/80 pl-2 max-h-40 overflow-y-auto">
          {visible.map((s: any, idx: any) => (
            <li key={`${s.stepId}-${idx}`} className="leading-tight">
              <span className="text-gray-400">{s.phase}</span>{' '}
              <span className="text-cyan-700/90">{s.tool}</span> · exit {s.exitCode} ·{' '}
              {s.durationMs}
              ms
              {s.continuationDepth > 0 ? (
                <span className="text-gray-600"> · d{s.continuationDepth}</span>
              ) : null}
              {s.detail ? <span className="text-gray-600"> · {s.detail}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
