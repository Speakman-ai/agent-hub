import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeftRight,
  Flag,
  User,
  Tag,
  Target,
  Copy,
  Trash2,
  ChevronRight,
  Check,
} from 'lucide-react';

const PRIORITY_OPTIONS = ['urgent', 'high', 'medium', 'low'];
const cap = (s) => (s ? `${s[0].toUpperCase()}${s.slice(1)}` : s);

const MENU_WIDTH = 220;
const SUBMENU_WIDTH = 220;

/**
 * Right-click quick-actions menu for a kanban card. Rendered in a portal,
 * positioned at the cursor, and closes on outside-click, Escape, scroll, or
 * window resize. Each action is wired to a parent callback that performs an
 * optimistic update and reconciles against the eventual `kanban_update`
 * broadcast — the menu itself only decides *what* the user picked.
 *
 * Keyboard a11y: ArrowUp/Down move the highlight, ArrowRight/Enter open a
 * submenu (or activate a leaf), ArrowLeft/Escape close the submenu (Escape at
 * the top level closes the whole menu). Submenus also open on hover + focus.
 */
export default function CardContextMenu({
  card,
  x,
  y,
  columns = [],
  epics = [],
  agents = [],
  labels = [],
  onClose,
  onMove,
  onSetPriority,
  onAssign,
  onUnassign,
  onToggleLabel,
  onLinkEpic,
  onCopyId,
  onCopyLink,
  onDelete,
}) {
  const rootRef = useRef(null);
  const [openKey, setOpenKey] = useState(null);
  const [active, setActive] = useState(0);
  const [subActive, setSubActive] = useState(0);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const cardLabelSet = useMemo(
    () =>
      new Set(
        (card.labels ? String(card.labels).split(',') : []).map((l) => l.trim()).filter(Boolean),
      ),
    [card.labels],
  );

  // Build the menu model from props. Leaves carry an `onSelect`; branches carry
  // a `submenu` array. `__delete__` is special-cased so it can show an inline
  // confirm step rather than firing immediately.
  const items = useMemo(() => {
    const assigneeChildren = agents.map((a) => ({
      key: `agent-${a.id}`,
      label: a.name,
      checked: card.assignee === a.name,
      onSelect: () => onAssign(a),
    }));
    if (card.assignee || card.session_id) {
      assigneeChildren.push({
        key: '__unassign',
        label: 'Unassign',
        onSelect: () => onUnassign(),
      });
    }

    const labelChildren = labels.length
      ? labels.map((l) => ({
          key: `label-${l}`,
          label: l,
          checked: cardLabelSet.has(l),
          keepOpen: true,
          onSelect: () => onToggleLabel(l),
        }))
      : [{ key: '__nolabels', label: 'No labels yet', disabled: true }];

    return [
      {
        key: 'status',
        label: 'Status',
        icon: ArrowLeftRight,
        submenu: columns.map((col) => ({
          key: `col-${col.id}`,
          label: col.name,
          checked: col.id === card.column_id,
          onSelect: () => onMove(col.id),
        })),
      },
      {
        key: 'priority',
        label: 'Priority',
        icon: Flag,
        submenu: PRIORITY_OPTIONS.map((p) => ({
          key: `pri-${p}`,
          label: cap(p),
          checked: (card.priority || 'medium') === p,
          onSelect: () => onSetPriority(p),
        })),
      },
      {
        key: 'assignee',
        label: 'Assignee',
        icon: User,
        submenu: assigneeChildren.length
          ? assigneeChildren
          : [{ key: '__noagents', label: 'No agents', disabled: true }],
      },
      {
        key: 'labels',
        label: 'Labels',
        icon: Tag,
        submenu: labelChildren,
      },
      {
        key: 'epic',
        label: 'Epic',
        icon: Target,
        submenu: [
          {
            key: '__noepic',
            label: 'No epic',
            checked: !card.epic_id,
            onSelect: () => onLinkEpic(null),
          },
          ...epics.map((e) => ({
            key: `epic-${e.id}`,
            label: e.name,
            checked: card.epic_id === e.id,
            color: e.color,
            onSelect: () => onLinkEpic(e.id),
          })),
        ],
      },
      {
        key: 'copy',
        label: 'Copy',
        icon: Copy,
        submenu: [
          { key: 'copy-id', label: 'Copy ID', onSelect: () => onCopyId() },
          { key: 'copy-link', label: 'Copy link', onSelect: () => onCopyLink() },
        ],
      },
      {
        key: 'delete',
        label: 'Delete',
        icon: Trash2,
        danger: true,
        onSelect: '__delete__',
      },
    ];
  }, [
    card,
    columns,
    epics,
    agents,
    labels,
    cardLabelSet,
    onMove,
    onSetPriority,
    onAssign,
    onUnassign,
    onToggleLabel,
    onLinkEpic,
    onCopyId,
    onCopyLink,
  ]);

  const openItem = openKey ? items.find((i) => i.key === openKey) : null;
  const submenu = openItem?.submenu || null;

  // Close on outside interaction. Scroll/resize also dismiss because the menu
  // is absolutely positioned and would otherwise float away from the card.
  useEffect(() => {
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [onClose]);

  // Focus the menu on mount so keyboard navigation works immediately.
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const activateLeaf = useCallback(
    (child) => {
      if (!child || child.disabled) return;
      child.onSelect?.();
      if (!child.keepOpen) onClose();
    },
    [onClose],
  );

  const activateTop = useCallback(
    (item) => {
      if (item.submenu) {
        setOpenKey(item.key);
        setSubActive(0);
        return;
      }
      if (item.onSelect === '__delete__') {
        setConfirmingDelete(true);
        return;
      }
      item.onSelect?.();
      onClose();
    },
    [onClose],
  );

  const onKeyDown = (e) => {
    if (confirmingDelete) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setConfirmingDelete(false);
      }
      return;
    }
    if (submenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSubActive((i) => Math.min(i + 1, submenu.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSubActive((i) => Math.max(i - 1, 0));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setOpenKey(null);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activateLeaf(submenu[subActive]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setOpenKey(null);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activateTop(items[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  // Keep the menu on screen: flip left/up when the cursor is near an edge.
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const left = x + MENU_WIDTH + SUBMENU_WIDTH > vw ? Math.max(8, x - MENU_WIDTH) : x;
  const estHeight = items.length * 34 + 12;
  const top = y + estHeight > vh ? Math.max(8, vh - estHeight - 8) : y;
  const submenuOnLeft = left + MENU_WIDTH + SUBMENU_WIDTH > vw;

  return createPortal(
    <div
      ref={rootRef}
      role="menu"
      aria-label="Card actions"
      tabIndex={-1}
      data-testid="card-context-menu"
      onKeyDown={onKeyDown}
      className="fixed z-[60] outline-none"
      style={{ left, top, width: MENU_WIDTH }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="rounded-lg border border-white/10 bg-gray-900/95 backdrop-blur shadow-2xl shadow-black/50 py-1 text-sm">
        {confirmingDelete ? (
          <div className="px-3 py-2" data-testid="ctx-delete-confirm">
            <p className="text-xs text-gray-300 mb-2">Delete this card?</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className="flex-1 px-2 py-1 text-xs text-gray-400 hover:text-gray-200 rounded border border-white/10"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="ctx-confirm-delete"
                onClick={() => {
                  onDelete();
                  onClose();
                }}
                className="flex-1 px-2 py-1 text-xs font-medium text-white bg-red-600 hover:bg-red-500 rounded"
              >
                Delete
              </button>
            </div>
          </div>
        ) : (
          items.map((item, idx) => {
            const Icon = item.icon;
            const isOpen = openKey === item.key;
            const highlighted = active === idx && !submenu;
            return (
              <div
                key={item.key}
                className="relative"
                onMouseEnter={() => {
                  setActive(idx);
                  if (item.submenu) {
                    setOpenKey(item.key);
                    setSubActive(0);
                  } else {
                    setOpenKey(null);
                  }
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  aria-haspopup={item.submenu ? 'menu' : undefined}
                  aria-expanded={item.submenu ? isOpen : undefined}
                  data-testid={`ctx-item-${item.key}`}
                  onClick={() => activateTop(item)}
                  className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors ${
                    item.danger
                      ? 'text-red-300 hover:bg-red-500/10'
                      : 'text-gray-200 hover:bg-white/[0.06]'
                  } ${highlighted || isOpen ? (item.danger ? 'bg-red-500/10' : 'bg-white/[0.06]') : ''}`}
                >
                  {Icon && <Icon size={14} className="flex-shrink-0 opacity-80" />}
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.submenu && <ChevronRight size={13} className="opacity-50 flex-shrink-0" />}
                </button>

                {item.submenu && isOpen && (
                  <div
                    role="menu"
                    data-testid={`ctx-submenu-${item.key}`}
                    className="absolute top-0 rounded-lg border border-white/10 bg-gray-900/95 backdrop-blur shadow-2xl shadow-black/50 py-1 max-h-72 overflow-y-auto"
                    style={{
                      width: SUBMENU_WIDTH,
                      [submenuOnLeft ? 'right' : 'left']: '100%',
                    }}
                  >
                    {item.submenu.map((child, ci) => (
                      <button
                        key={child.key}
                        type="button"
                        role="menuitem"
                        disabled={child.disabled}
                        data-testid={`ctx-sub-${child.key}`}
                        onMouseEnter={() => setSubActive(ci)}
                        onClick={() => activateLeaf(child)}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                          child.disabled
                            ? 'text-gray-600 cursor-default'
                            : 'text-gray-200 hover:bg-white/[0.06]'
                        } ${subActive === ci && !child.disabled ? 'bg-white/[0.06]' : ''}`}
                      >
                        {child.color != null && (
                          <span
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: child.color }}
                          />
                        )}
                        <span className="flex-1 truncate">{child.label}</span>
                        {child.checked && (
                          <Check size={13} className="text-indigo-300 flex-shrink-0" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>,
    document.body,
  );
}
