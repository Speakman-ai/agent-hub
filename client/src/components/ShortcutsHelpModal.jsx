import { useEffect, useMemo } from 'react';
import { Keyboard, X } from 'lucide-react';
import { DEFAULT_SHORTCUTS, formatShortcut, getPlatform } from '../utils/shortcuts.js';

// Lists every registered shortcut grouped by category, with a formatted key
// badge. Opens via the global `show-help` shortcut (default: `?` or Mod+/)
// and also via UI entry points that set `isOpen`.
export default function ShortcutsHelpModal({ isOpen, onClose, shortcuts = DEFAULT_SHORTCUTS }) {
  const platform = getPlatform();

  // Close on Escape.
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const grouped = useMemo(() => {
    const groups = new Map();
    for (const s of shortcuts) {
      const key = s.group || 'Other';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    return Array.from(groups.entries());
  }, [shortcuts]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <Keyboard size={18} className="text-gray-400" />
            <h2 className="text-sm font-semibold text-gray-200">Keyboard shortcuts</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-gray-500 hover:text-gray-300 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="max-h-[65vh] overflow-y-auto p-5 space-y-5">
          {grouped.map(([group, items]) => (
            <div key={group}>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                {group}
              </div>
              <ul className="space-y-1">
                {items.map((s) => (
                  <li key={s.id} className="flex items-center justify-between py-1.5">
                    <div className="min-w-0 pr-4">
                      <div className="text-sm text-gray-200">{s.label}</div>
                      {s.description && (
                        <div className="text-xs text-gray-500">{s.description}</div>
                      )}
                    </div>
                    <kbd className="flex-shrink-0 font-mono text-xs bg-gray-800 border border-gray-700 text-gray-300 px-2 py-1 rounded">
                      {formatShortcut(s.binding, platform)}
                    </kbd>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="px-5 py-2.5 border-t border-gray-800 text-xs text-gray-500">
          Press{' '}
          <kbd className="font-mono bg-gray-800 border border-gray-700 text-gray-300 px-1.5 py-0.5 rounded">
            Esc
          </kbd>{' '}
          to close
        </div>
      </div>
    </div>
  );
}
