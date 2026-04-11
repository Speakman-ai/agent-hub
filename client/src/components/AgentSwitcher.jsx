import { useState, useEffect, useRef } from 'react';

export default function AgentSwitcher({ agents, onSelect, onClose }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = agents.filter(
    (a) => a.active !== false && a.name.toLowerCase().includes(query.toLowerCase()),
  );

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') onClose();
    if (e.key === 'Enter' && filtered.length > 0) {
      onSelect(filtered[0].id);
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Switch agent... (type to filter)"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-gray-600"
          />
        </div>
        <div className="max-h-64 overflow-y-auto pb-2">
          {filtered.map((agent) => (
            <button
              key={agent.id}
              onClick={() => {
                onSelect(agent.id);
                onClose();
              }}
              className="w-full text-left px-6 py-2.5 flex items-center gap-3 hover:bg-gray-800 transition-colors"
            >
              <span
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: agent.color }}
              />
              <div>
                <span className="text-sm font-medium text-gray-200">{agent.name}</span>
                <span className="text-xs text-gray-500 ml-2">{agent.engine}</span>
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="text-sm text-gray-500 px-6 py-3">No agents found</p>
          )}
        </div>
        <div className="px-4 py-2 border-t border-gray-800 text-xs text-gray-600">
          ↵ Select · Esc Close
        </div>
      </div>
    </div>
  );
}
