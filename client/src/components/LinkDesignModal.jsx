import { useState, useMemo } from 'react';
import { Palette, X, Search } from 'lucide-react';

/**
 * LinkDesignModal — pick a Design Studio design to embed as a live preview
 * pane beside the current chat session. The selected design's id is sent to
 * `PUT /api/sessions/:id/linked-design` by the caller.
 *
 * Props:
 *   - designs:        array of { id, name, linkedProjects?: [{id,name}] }.
 *   - currentDesignId: id currently linked (highlighted), or null.
 *   - onClose():      dismiss without changing the link.
 *   - onSelect(id):   link the chosen design.
 *   - onUnlink():     clear the link (only shown when one is set).
 */
export default function LinkDesignModal({
  designs = [],
  currentDesignId = null,
  onClose,
  onSelect,
  onUnlink,
}) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return designs;
    return designs.filter((d) => (d.name || '').toLowerCase().includes(q));
  }, [designs, query]);

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
      data-testid="link-design-modal"
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <Palette size={16} className="text-purple-400" />
            <h2 className="text-sm font-semibold text-gray-100">Link a design</h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-200 transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <p className="px-4 pt-3 text-xs text-gray-500">
          The design&apos;s live canvas renders beside this chat so you can iterate on the UI with
          the agent before implementation.
        </p>

        <div className="px-4 py-3">
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600 pointer-events-none"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search designs…"
              autoFocus
              className="w-full bg-gray-950 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-500"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-2 min-h-0">
          {filtered.length === 0 ? (
            <div className="text-center text-xs text-gray-600 py-10">
              {designs.length === 0
                ? 'No designs yet. Create one in Design Studio first.'
                : 'No designs match your search.'}
            </div>
          ) : (
            filtered.map((d) => {
              const isCurrent = d.id === currentDesignId;
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => onSelect?.(d.id)}
                  disabled={isCurrent}
                  data-testid={`link-design-option-${d.id}`}
                  className={`w-full text-left px-3 py-2.5 rounded-lg flex items-center justify-between gap-3 transition-colors ${
                    isCurrent
                      ? 'bg-purple-500/10 border border-purple-500/40 cursor-default'
                      : 'hover:bg-gray-800 border border-transparent'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="text-sm text-gray-200 truncate">{d.name}</div>
                    {d.linkedProjects?.length > 0 && (
                      <div className="text-[11px] text-gray-600 truncate">
                        {d.linkedProjects.map((p) => p.name).join(', ')}
                      </div>
                    )}
                  </div>
                  {isCurrent && (
                    <span className="text-[10px] uppercase tracking-wider text-purple-300 flex-shrink-0">
                      Linked
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>

        {currentDesignId && onUnlink && (
          <div className="px-4 py-3 border-t border-gray-800">
            <button
              type="button"
              onClick={onUnlink}
              className="text-xs text-red-400 hover:text-red-300 transition-colors"
              data-testid="link-design-unlink"
            >
              Unlink current design
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
