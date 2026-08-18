import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, MoreHorizontal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  SESSION_ACTION_MENU_ITEM_CLASS,
  SESSION_ACTION_MENU_ITEM_PRESSED_CLASS,
} from '../utils/sessionActionMenu';

export type SessionActionMenuItem = {
  id: string;
  testId: string;
  label: string;
  icon: LucideIcon;
  title?: string;
  pressed?: boolean;
  badge?: number | string | null;
  hidden?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

/**
 * Single session-toolbar dropdown that hosts pane toggles (timeline, changes,
 * artifacts, terminal) plus nested controls passed as children (preview, AWS).
 */
export default function SessionActionsMenu({
  items = [],
  children,
}: {
  items?: SessionActionMenuItem[];
  children?: any;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const visibleItems = items.filter((item) => !item.hidden);
  const hasChildren = Boolean(children);
  const pressedCount = visibleItems.filter((item) => item.pressed).length;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  if (visibleItems.length === 0 && !hasChildren) return null;

  return (
    <div className="relative shrink-0" ref={rootRef} data-testid="session-actions-menu">
      <button
        type="button"
        data-testid="session-actions-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Session actions"
        className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border ${
          open || pressedCount > 0
            ? 'bg-slate-700/70 text-slate-50 border-slate-500'
            : 'bg-gray-800/70 hover:bg-gray-700/70 text-gray-200 border-gray-700'
        }`}
      >
        <MoreHorizontal size={13} aria-hidden />
        Actions
        {pressedCount > 0 ? (
          <span
            data-testid="session-actions-open-count"
            className="rounded-full bg-slate-500/30 text-slate-100 px-1.5 text-[10px] font-semibold"
          >
            {pressedCount}
          </span>
        ) : null}
        <ChevronDown size={12} className={`opacity-70 ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>

      {open ? (
        <div
          role="menu"
          data-testid="session-actions-dropdown"
          className="absolute z-40 bottom-full mb-1 left-0 w-64 max-h-[min(70vh,28rem)] overflow-y-auto overscroll-contain rounded-lg border border-gray-700 bg-gray-950 shadow-xl p-1"
        >
          {visibleItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                role="menuitemcheckbox"
                data-testid={item.testId}
                title={item.title}
                disabled={item.disabled}
                aria-checked={Boolean(item.pressed)}
                onClick={() => item.onSelect()}
                className={`${SESSION_ACTION_MENU_ITEM_CLASS} ${
                  item.pressed ? SESSION_ACTION_MENU_ITEM_PRESSED_CLASS : ''
                }`}
              >
                <Icon size={13} className="shrink-0 text-gray-400" aria-hidden />
                <span className="flex-1 truncate">{item.label}</span>
                {item.badge != null && item.badge !== '' && Number(item.badge) !== 0 ? (
                  <span className="text-[10px] tabular-nums text-gray-400">{item.badge}</span>
                ) : null}
                {item.pressed ? <Check size={12} className="text-emerald-400 shrink-0" /> : null}
              </button>
            );
          })}
          {visibleItems.length > 0 && hasChildren ? (
            <div className="my-1 border-t border-gray-800" />
          ) : null}
          {hasChildren ? <div className="flex flex-col gap-0.5">{children}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
