import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Clock3 } from 'lucide-react';

function formatTime(ts) {
  if (!Number.isFinite(ts)) return '';
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

/**
 * Lightweight session orchestration timeline: phase + host loop + progress + delegation.
 */
export default function OrchestrationTimelinePanel({ entries }) {
  const [open, setOpen] = useState(true);
  const visible = useMemo(
    () =>
      (Array.isArray(entries) ? entries : [])
        .filter((e) => e && typeof e.summary === 'string' && e.summary.trim())
        .slice(-20),
    [entries],
  );
  if (visible.length === 0) return null;

  return (
    <div className="px-3 md:px-0 mb-3 max-w-[95%] sm:max-w-[90%] mx-auto">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 text-left text-xs font-semibold text-gray-300 hover:text-white border border-gray-700/80 rounded-lg px-3 py-2 bg-gray-900/40"
      >
        {open ? (
          <ChevronDown className="w-4 h-4 shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 shrink-0" />
        )}
        <Clock3 className="w-4 h-4 text-amber-400 shrink-0" />
        <span>Orchestration timeline</span>
        <span className="text-gray-500 font-normal ml-auto">{visible.length} events</span>
      </button>
      {open && (
        <div className="mt-2 rounded-lg border border-gray-700/80 bg-gray-950/50 p-3 space-y-1.5">
          {visible.map((entry) => (
            <div key={entry.id} className="text-xs text-gray-300 flex items-start gap-2">
              <span className="text-[10px] text-gray-500 shrink-0 pt-0.5 w-16">
                {formatTime(entry.ts)}
              </span>
              <span className="text-gray-400 shrink-0">{entry.kind}</span>
              <span className="text-gray-200">{entry.summary}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
