import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Layers, Zap } from 'lucide-react';

/**
 * Custom epic filter for the kanban toolbar — styled menu with epic colors,
 * autonomous badges, and active card counts.
 */
export default function EpicFilterDropdown({
  epics = [],
  selectedEpicId,
  onSelect,
  epicCardCount,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  const selectedEpic = selectedEpicId ? epics.find((e) => e.id === selectedEpicId) : null;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  const select = (epicId) => {
    onSelect(epicId);
    setOpen(false);
  };

  const activeTotal = epics.reduce((sum, epic) => sum + epicCardCount(epic.id), 0);

  return (
    <div ref={rootRef} className="relative" data-testid="epic-filter-dropdown">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={`inline-flex items-center gap-2.5 h-9 min-w-[200px] max-w-[280px] pl-2.5 pr-2 rounded-lg border text-sm text-gray-100 transition-all ${
          open || selectedEpicId
            ? 'border-indigo-500/40 bg-indigo-500/10 ring-1 ring-indigo-500/30'
            : 'border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.06] hover:border-white/[0.12]'
        }`}
      >
        {selectedEpic ? (
          <span
            className="w-2.5 h-2.5 rounded-full flex-shrink-0 ring-1 ring-white/20"
            style={{ backgroundColor: selectedEpic.color }}
          />
        ) : (
          <Layers size={15} className="text-gray-500 flex-shrink-0" />
        )}
        <span className="truncate flex-1 text-left">
          {selectedEpic ? selectedEpic.name : 'All epics'}
        </span>
        {selectedEpic?.autonomous === 1 ? (
          <Zap size={13} className="text-emerald-400 flex-shrink-0" aria-hidden />
        ) : null}
        {selectedEpicId ? (
          <span className="text-[10px] font-medium tabular-nums px-1.5 py-0.5 rounded-md bg-white/[0.08] text-gray-400">
            {epicCardCount(selectedEpicId)}
          </span>
        ) : (
          <span className="text-[10px] font-medium tabular-nums px-1.5 py-0.5 rounded-md bg-white/[0.08] text-gray-500">
            {activeTotal}
          </span>
        )}
        <ChevronDown
          size={14}
          className={`text-gray-500 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open ? (
        <div
          role="listbox"
          className="absolute left-0 top-full z-50 mt-1.5 w-[min(100vw-2rem,320px)] overflow-hidden rounded-xl border border-white/[0.1] bg-gray-900/95 shadow-2xl shadow-black/50 backdrop-blur-md"
        >
          <div className="max-h-72 overflow-y-auto kanban-column-scroll py-1">
            <button
              type="button"
              role="option"
              aria-selected={!selectedEpicId}
              onClick={() => select(null)}
              className={`w-full flex h-11 items-center gap-2.5 px-3 text-left text-sm transition-colors ${
                !selectedEpicId
                  ? 'bg-indigo-500/10 text-indigo-100'
                  : 'text-gray-200 hover:bg-white/[0.04]'
              }`}
            >
              <Layers size={15} className="text-gray-500 flex-shrink-0" />
              <span className="flex-1 truncate">All epics</span>
              <span className="text-[10px] tabular-nums text-gray-500">{activeTotal}</span>
              {!selectedEpicId ? (
                <Check size={14} className="text-indigo-400 flex-shrink-0" />
              ) : null}
            </button>

            {epics.map((epic) => {
              const count = epicCardCount(epic.id);
              const isSelected = selectedEpicId === epic.id;
              return (
                <button
                  key={epic.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => select(epic.id)}
                  className={`w-full flex h-11 items-center gap-2.5 px-3 text-left text-sm transition-colors ${
                    isSelected
                      ? 'bg-indigo-500/10 text-indigo-100'
                      : 'text-gray-200 hover:bg-white/[0.04]'
                  }`}
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0 ring-1 ring-white/10"
                    style={{ backgroundColor: epic.color }}
                  />
                  <span className="flex-1 min-w-0 truncate">{epic.name}</span>
                  {epic.autonomous === 1 ? (
                    <Zap size={13} className="text-emerald-400 flex-shrink-0" aria-hidden />
                  ) : null}
                  <span className="text-[10px] tabular-nums text-gray-500">{count}</span>
                  {isSelected ? (
                    <Check size={14} className="text-indigo-400 flex-shrink-0" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
