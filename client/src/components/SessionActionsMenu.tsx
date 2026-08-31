import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, MoreHorizontal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  SESSION_ACTION_MENU_ITEM_CLASS,
  SESSION_ACTION_MENU_ITEM_PRESSED_CLASS,
  SESSION_ACTION_TOOLBAR_BUTTON_CLASS,
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
 *
 * With `inline`, the surviving items render as flat toolbar buttons instead of
 * a dropdown. Workflow (no-code) sessions gate most items off, so the few that
 * remain don't warrant hiding behind an extra click.
 */
export default function SessionActionsMenu({
  items = [],
  children,
  inline = false,
}: {
  items?: SessionActionMenuItem[];
  children?: any;
  inline?: boolean;
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

  if (inline) {
    return (
      <div className="contents" data-testid="session-actions-menu" data-inline="true" ref={rootRef}>
        {visibleItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={Boolean(item.pressed)}
              data-testid={item.testId}
              title={item.title}
              disabled={item.disabled}
              onClick={() => item.onSelect()}
              className={`${SESSION_ACTION_TOOLBAR_BUTTON_CLASS} disabled:opacity-50 disabled:cursor-not-allowed ${
                item.pressed
                  ? 'bg-slate-700/70 text-slate-50 border-slate-500'
                  : 'bg-gray-800/70 hover:bg-gray-700/70 text-gray-200 border-gray-700'
              }`}
            >
              <Icon size={13} className="shrink-0 text-gray-400" aria-hidden />
              <span className="truncate">{item.label}</span>
              {item.badge != null && item.badge !== '' && Number(item.badge) !== 0 ? (
                <span className="text-[10px] tabular-nums opacity-80">{item.badge}</span>
              ) : null}
              {item.pressed ? <Check size={12} className="text-emerald-400 shrink-0" /> : null}
            </button>
          );
        })}
        {children}
      </div>
    );
  }

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
