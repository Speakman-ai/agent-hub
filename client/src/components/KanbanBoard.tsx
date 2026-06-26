import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Plus,
  GripVertical,
  X,
  MessageSquare,
  ExternalLink,
  Trash2,
  Search,
  GitPullRequest,
  Target,
  Lock,
  AlertTriangle,
  Zap,
  PlayCircle,
  Check,
  Eye,
  Unlink,
  CheckSquare,
  Square,
} from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  closestCorners,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { columnDroppableId, resolveDropTarget, computeMoveUpdates } from '../utils/kanbanReorder';
import { api } from '../utils/api';
import { useVisibleIntervalRefresh } from '../hooks/useVisibleIntervalRefresh';
import { epicFormToUpdateBody } from '../utils/epics';
import { hasUnresolvedBlockers, shouldConfirmMove } from '../utils/blockers';
import { cardShortLabel, assigneeInitials, assigneeColorClass } from '../utils/kanbanCard';
import {
  toggleKanbanCardSelection,
  setKanbanColumnSelection,
  pruneKanbanSelection,
  isKanbanColumnFullySelected,
} from '../utils/kanbanSelection';
import { shortDate, formatDateTime } from '../utils/time';
import { filterAgentsByProject } from '../utils/kanbanAgents';
import { MarkdownContent } from './MarkdownRenderer';
import FinalizeCardBadge from './finalize/CardBadge';
import EpicFilterDropdown from './EpicFilterDropdown';
import EpicAutonomousDialog from './EpicAutonomousDialog';
import { epicToAutonomousForm } from './EpicAutonomousPanel';
import CardContextMenu from './CardContextMenu';
import KanbanCardDetailModal from './kanban/KanbanCardDetailModal';
import { useKanbanCardDetail } from '../hooks/useKanbanCardDetail';

const PRIORITY_ACCENT = {
  urgent: 'border-l-red-500',
  high: 'border-l-orange-500',
  medium: 'border-l-sky-500',
  low: 'border-l-gray-600',
} as Record<string, any>;

const PRIORITIES = ['urgent', 'high', 'medium', 'low'];

const PRIORITY_BAR_COLOR = {
  high: 'bg-orange-400',
  medium: 'bg-sky-400',
  low: 'bg-gray-400',
} as Record<string, any>;

/**
 * Linear-style priority glyph. Urgent renders a filled warning square; the
 * other levels render an ascending three-bar signal with `filled` bars lit.
 */
function PriorityIcon({ priority }: any) {
  const p = priority || 'medium';
  const label = `${p[0].toUpperCase()}${p.slice(1)} priority`;
  if (p === 'urgent') {
    return (
      <span
        title={label}
        aria-label={label}
        data-testid="card-priority-icon"
        data-priority="urgent"
        className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-[3px] bg-red-500/90 text-white flex-shrink-0"
      >
        <AlertTriangle size={9} strokeWidth={3} />
      </span>
    );
  }
  const filled = p === 'high' ? 3 : p === 'low' ? 1 : 2;
  const onClass = PRIORITY_BAR_COLOR[p] || PRIORITY_BAR_COLOR.medium;
  return (
    <span
      title={label}
      aria-label={label}
      data-testid="card-priority-icon"
      data-priority={p}
      className="inline-flex items-end gap-[2px] h-3.5 flex-shrink-0"
    >
      {[0, 1, 2].map((i: any) => (
        <span
          key={i}
          className={`w-[3px] rounded-[1px] ${i < filled ? onClass : 'bg-gray-600/50'}`}
          style={{ height: `${5 + i * 3}px` }}
        />
      ))}
    </span>
  );
}

const REVIEW_GLYPHS = {
  approved: { Icon: Check, cls: 'text-emerald-300', label: 'Approved' },
  reviewing: { Icon: Eye, cls: 'text-amber-300 animate-pulse', label: 'Reviewing…' },
  changes_requested: { Icon: AlertTriangle, cls: 'text-red-300', label: 'Changes requested' },
  awaiting_review: { Icon: Eye, cls: 'text-sky-300', label: 'Awaiting review' },
} as Record<string, any>;

/** Compact review-status glyph (icon + tooltip) replacing the old text badge. */
function ReviewGlyph({ status }: any) {
  const m = REVIEW_GLYPHS[status];
  if (!m) return null;
  const { Icon } = m;
  return (
    <span
      className={`inline-flex items-center ${m.cls}`}
      title={m.label}
      aria-label={m.label}
      data-testid="card-review-glyph"
      data-review-status={status}
    >
      <Icon size={12} />
    </span>
  );
}

/**
 * Assignee avatar: initials over a stable hashed colour (kanban assignees are
 * free-text names, not agent rows, so there's no uploaded image). A small
 * indigo dot + ring marks an active linked session.
 */
function CardAvatar({ name, active }: any) {
  const initials = assigneeInitials(name);
  if (!initials) return null;
  return (
    <span
      title={active ? `${name} · session active` : name}
      data-testid="card-assignee-avatar"
      className={`relative inline-flex items-center justify-center w-5 h-5 rounded-full text-[9px] font-semibold flex-shrink-0 ${assigneeColorClass(
        name,
      )} ${active ? 'ring-2 ring-indigo-400/70' : ''}`}
    >
      {initials}
      {active && (
        <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-indigo-400 ring-2 ring-gray-900" />
      )}
    </span>
  );
}

/**
 * Per-column page size for infinite scroll. The board opens by loading only
 * the first PAGE_SIZE cards per column (via GET /board?limit=PAGE_SIZE) so a
 * 700-card column doesn't block first paint; the rest stream in as the user
 * scrolls each column to its bottom.
 */
const PAGE_SIZE = 50;

/**
 * An invisible sentinel rendered at the bottom of a column's scroll container.
 * When it scrolls into view (observed against the column's own
 * `.kanban-column-scroll` element as the IntersectionObserver root) it calls
 * `onLoadMore(columnId)` to append the next page. The observer is rebuilt only
 * when `columnId` / `onLoadMore` change, so a stable `onLoadMore` keeps it
 * cheap. `rootMargin` pre-fetches slightly before the sentinel is fully
 * visible for a smoother scroll.
 */
function ColumnLoadMoreSentinel({ columnId, onLoadMore }: any) {
  const ref = useRef<any>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const root = el.closest('.kanban-column-scroll') || null;
    const observer = new IntersectionObserver(
      (entries: any) => {
        if (entries.some((e: any) => e.isIntersecting)) onLoadMore(columnId);
      },
      { root, rootMargin: '160px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [columnId, onLoadMore]);
  return (
    <div
      ref={ref}
      data-testid={`column-load-more-sentinel-${columnId}`}
      aria-hidden="true"
      className="h-1 w-full"
    />
  );
}

/**
 * Presentational card body. Pure markup (no drag wiring) so the same visual is
 * shared between the in-place sortable card and the floating <DragOverlay> clone
 * that follows the cursor during a drag. `overlay` lifts it with a shadow/scale
 * so the dragged card visibly "pops" off the board.
 */
function KanbanCard({
  card,
  board,
  epics,
  dragging = false,
  overlay = false,
  selected = false,
  showCheckbox = false,
  onToggleSelect,
}: any) {
  const cardEpic = card.epic_id ? epics.find((e: any) => e.id === card.epic_id) : null;
  const shortLabel = cardShortLabel(board?.card_prefix, card.short_id);
  const cardLabels = card.labels ? card.labels.split(',').filter(Boolean) : [];
  return (
    <div
      className={`group w-full rounded-xl border bg-white/[0.03] hover:bg-white/[0.05] hover:border-white/[0.12] hover:shadow-lg hover:shadow-black/25 cursor-grab active:cursor-grabbing transition-colors border-l-[3px] ${
        selected
          ? 'border-indigo-400/60 ring-1 ring-indigo-400/30 bg-indigo-500/[0.08]'
          : 'border-white/[0.08]'
      } ${PRIORITY_ACCENT[card.priority] || PRIORITY_ACCENT.medium} ${dragging ? 'opacity-40' : ''} ${
        overlay
          ? 'shadow-2xl shadow-black/60 ring-1 ring-indigo-400/40 rotate-[1.5deg] scale-[1.02]'
          : ''
      }`}
      data-selected={selected ? 'true' : undefined}
    >
      <div className="p-3">
        {/* Header: priority glyph + short id (left) · status glyphs (right). */}
        <div className="flex items-center gap-1.5">
          {showCheckbox ? (
            <button
              type="button"
              aria-label={selected ? 'Deselect card' : 'Select card'}
              aria-pressed={selected}
              data-testid={`card-select-${card.id}`}
              onClick={(e: any) => {
                e.stopPropagation();
                onToggleSelect?.(card.id, { shiftKey: e.shiftKey });
              }}
              onPointerDown={(e: any) => e.stopPropagation()}
              className={`inline-flex items-center justify-center w-4 h-4 rounded flex-shrink-0 transition-colors ${
                selected
                  ? 'text-indigo-300'
                  : 'text-gray-600 opacity-0 group-hover:opacity-100 hover:text-gray-400'
              }`}
            >
              {selected ? <CheckSquare size={14} /> : <Square size={14} />}
            </button>
          ) : null}
          <PriorityIcon priority={card.priority} />
          {shortLabel && (
            <span
              className="text-[11px] font-mono text-gray-500 tabular-nums tracking-tight"
              data-testid="card-short-id"
            >
              {shortLabel}
            </span>
          )}
          <div className="flex-1 min-w-0" />
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {hasUnresolvedBlockers(card) && (
              <span
                className="inline-flex items-center gap-0.5 text-[10px] font-medium text-red-300"
                title={`Blocked by ${card.blockers.filter((b: any) => !b.done).length} unresolved card(s)`}
                data-testid="card-blocker-badge"
              >
                <Lock size={11} />
                {card.blockers.filter((b: any) => !b.done).length}
              </span>
            )}
            {card.orphaned_at && (
              <span
                className="inline-flex items-center gap-0.5 text-[10px] font-medium text-amber-300/90"
                title="Orphaned — this card's working session was closed. Review or reassign it."
                data-testid="card-orphaned-badge"
              >
                <Unlink size={11} />
              </span>
            )}
            {card.pr_url &&
              (/^https?:\/\//i.test(card.pr_url) ? (
                <a
                  href={card.pr_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e: any) => e.stopPropagation()}
                  className="text-[11px] text-gray-500 hover:text-indigo-300 flex items-center gap-0.5 transition-colors"
                  title={card.pr_url}
                >
                  <GitPullRequest size={12} />
                  {card.pr_url.match(/\d+$/)?.[0] || 'PR'}
                </a>
              ) : (
                <span
                  onClick={(e: any) => e.stopPropagation()}
                  className="text-[11px] text-gray-500 flex items-center gap-0.5"
                  title={card.pr_url}
                >
                  <GitPullRequest size={12} />
                  {card.pr_url.match(/\d+$/)?.[0] || 'PR'}
                </span>
              ))}
            <ReviewGlyph status={card.review_status} />
            {card.session_id && (
              <FinalizeCardBadge
                sessionId={card.session_id}
                prefetchedRun={card.finalize_run ?? null}
              />
            )}
            <GripVertical
              size={13}
              className="text-gray-600 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
            />
          </div>
        </div>

        {/* Title */}
        <span
          className="block text-[13px] font-medium text-gray-100 leading-snug mt-1.5 break-words"
          data-testid="card-title"
        >
          {card.title}
        </span>

        {/* Footer: epic + labels (left) · created date + assignee avatar (right). */}
        {(cardEpic || card.assignee || card.created_at || cardLabels.length > 0) && (
          <div className="flex items-center justify-between gap-2 mt-2.5">
            <div className="flex items-center gap-1 flex-wrap min-w-0">
              {cardEpic && (
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-md max-w-full"
                  style={{
                    backgroundColor: `${cardEpic.color}18`,
                    color: cardEpic.color,
                    boxShadow: `inset 0 0 0 1px ${cardEpic.color}30`,
                  }}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: cardEpic.color }}
                  />
                  <span className="truncate">{cardEpic.name}</span>
                </span>
              )}
              {cardLabels.map((label: any) => (
                <span
                  key={label}
                  className="text-[10px] font-medium bg-white/[0.06] text-gray-400 px-1.5 py-0.5 rounded-md"
                >
                  {label.trim()}
                </span>
              ))}
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {card.created_at && (
                <span
                  className="text-[10px] text-gray-500 tabular-nums whitespace-nowrap"
                  data-testid="card-created-date"
                  title={`Created ${card.created_at}`}
                >
                  {shortDate(card.created_at)}
                </span>
              )}
              <CardAvatar name={card.assignee} active={!!card.session_id} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One sortable card. `useSortable` provides the transform/transition that makes
 * siblings glide aside as a drag passes over them, plus keyboard drag handling
 * (Space to pick up, arrows to move, Space to drop) and ARIA wiring. The
 * PointerSensor's distance activation (see KanbanBoard) means a plain click
 * still falls through to `onOpen` instead of starting a drag.
 */
function SortableCard({
  card,
  board,
  epics,
  onOpen,
  onContextMenu,
  selected,
  showCheckbox,
  onToggleSelect,
  selectionMode,
  selectedCount,
  dragDisabled,
  onClearSelection,
}: any) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    disabled: dragDisabled,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const handleClick = (e: any) => {
    const modifier = e.metaKey || e.ctrlKey || e.shiftKey;
    if (selectionMode || modifier) {
      onToggleSelect(card.id, { shiftKey: e.shiftKey });
      return;
    }
    if (selectedCount > 0) {
      onClearSelection?.();
    }
    onOpen(card);
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`card-draggable-${card.id}`}
      className="w-full touch-none"
      {...attributes}
      {...listeners}
      onClick={handleClick}
      onContextMenu={(e: any) => onContextMenu(e, card)}
    >
      <KanbanCard
        card={card}
        board={board}
        epics={epics}
        dragging={isDragging}
        selected={selected}
        showCheckbox={showCheckbox}
        onToggleSelect={onToggleSelect}
      />
    </div>
  );
}

/** Floating toolbar for bulk actions on selected cards. */
function KanbanBulkActionBar({
  count,
  columns,
  onMove,
  onSetPriority,
  onDelete,
  onClear,
  busy,
}: any) {
  return (
    <div
      data-testid="kanban-bulk-bar"
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-3 py-2 rounded-xl border border-white/[0.1] bg-gray-900/95 backdrop-blur-md shadow-2xl shadow-black/50"
    >
      <span className="text-xs font-medium text-gray-200 tabular-nums px-1">{count} selected</span>
      <span className="w-px h-5 bg-white/[0.08]" aria-hidden="true" />
      <label className="sr-only" htmlFor="kanban-bulk-move">
        Move selected cards
      </label>
      <select
        id="kanban-bulk-move"
        disabled={busy}
        defaultValue=""
        onChange={(e: any) => {
          const colId = e.target.value;
          e.target.value = '';
          if (colId) onMove(colId);
        }}
        className="h-8 px-2 rounded-lg text-xs bg-white/[0.06] border border-white/[0.08] text-gray-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 disabled:opacity-50"
      >
        <option value="" disabled>
          Move to…
        </option>
        {columns.map((col: any) => (
          <option key={col.id} value={col.id}>
            {col.name}
          </option>
        ))}
      </select>
      <label className="sr-only" htmlFor="kanban-bulk-priority">
        Set priority
      </label>
      <select
        id="kanban-bulk-priority"
        disabled={busy}
        defaultValue=""
        onChange={(e: any) => {
          const priority = e.target.value;
          e.target.value = '';
          if (priority) onSetPriority(priority);
        }}
        className="h-8 px-2 rounded-lg text-xs bg-white/[0.06] border border-white/[0.08] text-gray-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 disabled:opacity-50"
      >
        <option value="" disabled>
          Priority…
        </option>
        {PRIORITIES.map((p: any) => (
          <option key={p} value={p}>
            {p[0].toUpperCase()}
            {p.slice(1)}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={busy}
        onClick={onDelete}
        className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg text-xs font-medium text-red-300 hover:text-red-200 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 transition-colors disabled:opacity-50"
      >
        <Trash2 size={13} />
        Delete
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onClear}
        className="h-8 px-2.5 rounded-lg text-xs font-medium text-gray-400 hover:text-gray-200 hover:bg-white/[0.06] transition-colors disabled:opacity-50"
      >
        Clear
      </button>
    </div>
  );
}

/**
 * Droppable wrapper around a column's scroll area so drops into empty space (or
 * past the last card) resolve to the column itself rather than a card. `isOver`
 * tints the column while a drag hovers it.
 */
function ColumnDropZone({ columnId, className, children }: any) {
  const { setNodeRef, isOver } = useDroppable({ id: columnDroppableId(columnId) });
  return (
    <div
      ref={setNodeRef}
      data-column-dropzone={columnId}
      className={`${className} ${isOver ? 'bg-indigo-500/[0.05]' : ''}`}
    >
      {children}
    </div>
  );
}

export default function KanbanBoard({
  projectId,
  project,
  agents = [],
  refreshKey,
  onNavigateToSession,
  onOpenEpics,
}: any) {
  // The assignment dropdown must only offer agents that belong to this
  // project — agents are loaded app-wide and flattened across every visible
  // project, so scope them to `projectId` before rendering options.
  const projectAgents = useMemo(
    () => filterAgentsByProject(agents, projectId),
    [agents, projectId],
  );

  const [board, setBoard] = useState<any>(null);
  const [columns, setColumns] = useState<any[]>([]);
  const [cards, setCards] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);

  // Per-column infinite-scroll state, keyed by column id:
  //   { nextCursor, hasMore, loading, total }
  // `cards` above holds only the cards loaded so far across all columns; this
  // map tracks how far each column has paged and how many cards it really has.
  const [columnPaging, setColumnPaging] = useState<Record<string, any>>({});

  // Refs mirroring async-read state so the IntersectionObserver callback and
  // loadMore guard always see live values without re-subscribing on every
  // render. `inflightRef` is a synchronous double-fetch guard (state updates
  // are async, so a second intersect could fire before `loading:true` commits).
  const cardsRef = useRef(cards);
  const columnPagingRef = useRef(columnPaging);
  const inflightRef = useRef<Set<any>>(new Set());
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);
  useEffect(() => {
    columnPagingRef.current = columnPaging;
  }, [columnPaging]);

  // Inline add card state: columnId that has the form open
  const [addingInColumn, setAddingInColumn] = useState<any>(null);
  const [newCardTitle, setNewCardTitle] = useState('');
  const [newCardPriority, setNewCardPriority] = useState('medium');

  // Drag state: the id of the card currently being dragged. Drives the
  // <DragOverlay> floating clone; null when no drag is in flight.
  const [activeId, setActiveId] = useState<any>(null);

  // Search
  const [searchQuery, setSearchQuery] = useState('');

  // Epics (filter, badges, autonomous dispatch)
  const [epics, setEpics] = useState<any[]>([]);
  const [selectedEpicId, setSelectedEpicId] = useState<any>(null);
  const [showAutonomousDialog, setShowAutonomousDialog] = useState(false);
  const [autonomousForm, setAutonomousForm] = useState<any>(null);
  const [autonomousSaving, setAutonomousSaving] = useState(false);

  const [pendingMove, setPendingMove] = useState<any>(null); // { card, targetColumn, position }
  const [pendingBulkMove, setPendingBulkMove] = useState<any>(null); // { cards, targetColumn }

  // Multi-select: Cmd/Ctrl+click, Shift+range, or pinned "Select" mode.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(() => new Set());
  const selectionAnchorRef = useRef<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const selectedCount = selectedCardIds.size;
  const showSelectionUi = selectionMode || selectedCount > 0;

  const clearSelection = useCallback(() => {
    setSelectedCardIds(new Set());
    selectionAnchorRef.current = null;
    setSelectionMode(false);
  }, []);

  // Right-click quick-actions menu: { card, x, y } or null.
  const [contextMenu, setContextMenu] = useState<any>(null);

  /** Engine→valid models map from GET /api/config/models (optional model on card assign + epic autonomous). */
  const [modelConfig, setModelConfig] = useState<any>(null);

  const addTitleRef = useRef<any>(null);

  useEffect(() => {
    if (typeof api.getModelConfig !== 'function') return;
    api
      .getModelConfig()
      .then(setModelConfig)
      .catch((err: any) => {
        console.warn('[KanbanBoard] getModelConfig failed — session model picker disabled:', err);
        setModelConfig(null);
      });
  }, []);

  // Load the board's first page per column (one request), then page forward on
  // any column where the caller asks us to preserve a deeper scroll position
  // (`preserveDepth[colId]` = number of cards previously loaded). Returns the
  // assembled `{ data, allCards, paging }`. Used by both the initial load
  // (preserveDepth=null) and WebSocket reconciliation (preserveDepth=current
  // loaded counts) so a background refresh doesn't collapse columns the user
  // already scrolled.
  const loadBoardPaged = useCallback(
    async (preserveDepth: any) => {
      const data = await api.getBoard(projectId, { limit: PAGE_SIZE });
      const counts = data.counts || {};
      const cursors = data.cursors || {};
      const allCards = [...(data.cards || [])];
      const paging: Record<string, any> = {};
      for (const col of data.columns) {
        let loaded = allCards.filter((c: any) => c.column_id === col.id).length;
        let nextCursor = cursors[col.id] ?? null;
        const total = counts[col.id] ?? loaded;
        // Re-page forward until we've reloaded at least as deep as the user had
        // scrolled before the refresh (bounded by the real total / cursor end).
        const want = preserveDepth ? (preserveDepth[col.id] ?? 0) : 0;
        while (nextCursor && loaded < want) {
          const res = await api.getColumnCards(projectId, col.id, {
            cursor: nextCursor,
            limit: PAGE_SIZE,
          });
          const page = res.cards || [];
          if (page.length === 0) {
            nextCursor = null;
            break;
          }
          allCards.push(...page);
          loaded += page.length;
          nextCursor = res.nextCursor ?? null;
        }
        paging[col.id] = {
          nextCursor,
          hasMore: nextCursor != null,
          loading: false,
          total,
        };
      }
      return { data, allCards, paging };
    },
    [projectId],
  );

  // Initial load / project switch: reset every column to its first page.
  const fetchBoard = useCallback(async () => {
    if (!projectId) return undefined;
    try {
      const { data, allCards, paging } = await loadBoardPaged(null);
      setBoard(data.board);
      setColumns(data.columns);
      setEpics(data.epics || []);
      setColumnPaging(paging);
      setCards(allCards);
      setError(null);
      return allCards;
    } catch (err: any) {
      setError(err.message);
      return undefined;
    } finally {
      setLoading(false);
    }
  }, [projectId, loadBoardPaged]);

  // WebSocket / interval reconciliation. A `kanban_update` event doesn't say
  // which column changed, so we reload the first page of every column and
  // re-page each one up to its previously-loaded depth. This keeps the board
  // correct after a create / move / delete (counts, positions, and
  // cross-column moves all re-resolve) without yanking the user back to the
  // top of a column they'd scrolled. A card moved into a not-yet-loaded region
  // simply waits there until scrolled — `counts` still reflect the truth.
  // Returns the reconciled card array so callers can re-pick the open card.
  const reconcileBoard = useCallback(async () => {
    if (!projectId) return undefined;
    const preserve: Record<string, any> = {};
    for (const c of cardsRef.current) {
      preserve[c.column_id] = (preserve[c.column_id] || 0) + 1;
    }
    try {
      const { data, allCards, paging } = await loadBoardPaged(preserve);
      setBoard(data.board);
      setColumns(data.columns);
      setEpics(data.epics || []);
      setColumnPaging(paging);
      setCards(allCards);
      setError(null);
      return allCards;
    } catch (err: any) {
      setError(err.message);
      return undefined;
    }
  }, [projectId, loadBoardPaged]);

  const cardDetail = useKanbanCardDetail({
    projectId,
    agents,
    epics,
    cards,
    modelConfig,
    onRefresh: reconcileBoard,
    onNavigateToSession,
  });
  const { openDetail } = cardDetail;

  // Append the next keyset page for one column. Guarded against double-fetch
  // (sync `inflightRef`) and against fetching past the end (`hasMore` /
  // `nextCursor`). Deduped by id so a racing reconcile can't double-insert.
  const loadMoreColumn = useCallback(
    async (columnId: any) => {
      const p = columnPagingRef.current[columnId];
      if (!p || !p.hasMore || !p.nextCursor) return;
      if (inflightRef.current.has(columnId)) return;
      inflightRef.current.add(columnId);
      setColumnPaging((prev: any) => ({
        ...prev,
        [columnId]: { ...prev[columnId], loading: true },
      }));
      try {
        const res = await api.getColumnCards(projectId, columnId, {
          cursor: p.nextCursor,
          limit: PAGE_SIZE,
        });
        const page = res.cards || [];
        setCards((prev: any) => {
          const seen = new Set(prev.map((c: any) => c.id));
          const fresh = page.filter((c: any) => !seen.has(c.id));
          return fresh.length ? [...prev, ...fresh] : prev;
        });
        const nextCursor = res.nextCursor ?? null;
        setColumnPaging((prev: any) => ({
          ...prev,
          [columnId]: {
            nextCursor,
            hasMore: nextCursor != null,
            loading: false,
            total: res.total ?? prev[columnId]?.total ?? 0,
          },
        }));
      } catch (err: any) {
        console.error('Failed to load more cards:', err);
        setColumnPaging((prev: any) => ({
          ...prev,
          [columnId]: { ...prev[columnId], loading: false },
        }));
      } finally {
        inflightRef.current.delete(columnId);
      }
    },
    [projectId],
  );

  // Page a single column all the way to its end, appending every remaining
  // card. Used when a search / epic filter is active: filters run client-side
  // over the loaded `cards`, so with pagination we must load the column in
  // full or matches living past the first page would be invisible (and the
  // load-more sentinel is suppressed while filtering). Shares the per-column
  // `inflightRef` guard with loadMoreColumn so the two can't race the same
  // column, and dedups appended cards by id.
  const drainColumn = useCallback(
    async (columnId: any) => {
      let cursor = columnPagingRef.current[columnId]?.nextCursor ?? null;
      if (!cursor) return;
      if (inflightRef.current.has(columnId)) return;
      inflightRef.current.add(columnId);
      setColumnPaging((prev: any) => ({
        ...prev,
        [columnId]: { ...prev[columnId], loading: true },
      }));
      try {
        const collected: any[] = [];
        let total: any;
        while (cursor) {
          const res = await api.getColumnCards(projectId, columnId, {
            cursor,
            limit: PAGE_SIZE,
          });
          const page = res.cards || [];
          collected.push(...page);
          total = res.total ?? total;
          cursor = page.length ? (res.nextCursor ?? null) : null;
        }
        if (collected.length) {
          setCards((prev: any) => {
            const seen = new Set(prev.map((c: any) => c.id));
            const fresh = collected.filter((c: any) => !seen.has(c.id));
            return fresh.length ? [...prev, ...fresh] : prev;
          });
        }
        setColumnPaging((prev: any) => ({
          ...prev,
          [columnId]: {
            nextCursor: null,
            hasMore: false,
            loading: false,
            total: total ?? prev[columnId]?.total ?? 0,
          },
        }));
      } catch (err: any) {
        console.error('Failed to load remaining cards for filter:', err);
        setColumnPaging((prev: any) => ({
          ...prev,
          [columnId]: { ...prev[columnId], loading: false },
        }));
      } finally {
        inflightRef.current.delete(columnId);
      }
    },
    [projectId],
  );

  // Optimistically adjust per-column totals when a card moves across columns
  // so the "X of Y" header stays right before the reconcile lands.
  const adjustColumnTotals = useCallback((fromCol: any, toCol: any) => {
    if (fromCol === toCol) return;
    setColumnPaging((prev: any) => {
      const next = { ...prev };
      if (next[fromCol]) {
        next[fromCol] = { ...next[fromCol], total: Math.max(0, (next[fromCol].total || 0) - 1) };
      }
      if (next[toCol]) {
        next[toCol] = { ...next[toCol], total: (next[toCol].total || 0) + 1 };
      }
      return next;
    });
  }, []);

  // Initial load / project switch — show loading spinner
  useEffect(() => {
    setLoading(true);
    fetchBoard();
  }, [fetchBoard, projectId]);

  // Background refresh triggered by WebSocket events (card moves, updates,
  // comments, etc). Deliberately does NOT toggle `loading`, so the UI updates
  // in place without flashing the full "Loading board..." screen. Skip the
  // very first render — the initial-load effect above handles that.
  const isFirstRefresh = useRef(true);
  useEffect(() => {
    if (isFirstRefresh.current) {
      isFirstRefresh.current = false;
      return;
    }
    if (!projectId) return;
    reconcileBoard();
  }, [refreshKey, projectId, reconcileBoard]);

  // WebSocket-driven `refreshKey` covers most edits; this catches long idle periods
  // or missed events without toggling `loading` (reconcileBoard leaves loading false).
  useVisibleIntervalRefresh(
    () => {
      if (!projectId) return;
      void reconcileBoard();
    },
    180_000,
    { enabled: Boolean(projectId) },
  );

  // Focus title input when add form opens
  useEffect(() => {
    if (addingInColumn && addTitleRef.current) {
      addTitleRef.current.focus();
    }
  }, [addingInColumn]);

  // Drop deleted / reconciled cards from the selection set.
  useEffect(() => {
    const existing = new Set(cards.map((c: any) => c.id));
    setSelectedCardIds((prev) => {
      const pruned = pruneKanbanSelection(prev, existing);
      return pruned.size === prev.size ? prev : pruned;
    });
  }, [cards]);

  // Escape clears selection.
  useEffect(() => {
    if (!showSelectionUi) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showSelectionUi, clearSelection]);

  const cardsForColumn = (columnId: any) => {
    const q = searchQuery.toLowerCase().trim();
    return cards
      .filter((c: any) => c.column_id === columnId)
      .filter((c: any) => !selectedEpicId || c.epic_id === selectedEpicId)
      .filter(
        (c: any) =>
          !q ||
          c.title.toLowerCase().includes(q) ||
          (c.description || '').toLowerCase().includes(q) ||
          (c.labels || '').toLowerCase().includes(q) ||
          (c.assignee || '').toLowerCase().includes(q),
      )
      .sort((a: any, b: any) => a.position - b.position);
  };

  const orderedVisibleCardIds = useMemo(() => {
    const ids: string[] = [];
    for (const col of columns) {
      for (const c of cardsForColumn(col.id)) ids.push(c.id);
    }
    return ids;
  }, [columns, cards, searchQuery, selectedEpicId]);

  const handleToggleCardSelect = useCallback(
    (cardId: string, opts: { shiftKey?: boolean } = {}) => {
      setSelectedCardIds((prev) => {
        const { selected, anchorId } = toggleKanbanCardSelection(prev, cardId, {
          shiftKey: opts.shiftKey,
          anchorId: selectionAnchorRef.current,
          orderedVisibleIds: orderedVisibleCardIds,
        });
        selectionAnchorRef.current = anchorId;
        return selected;
      });
    },
    [orderedVisibleCardIds],
  );

  const handleToggleColumnSelect = (columnId: string, colCardIds: string[]) => {
    const fullySelected = isKanbanColumnFullySelected(selectedCardIds, colCardIds);
    setSelectedCardIds(setKanbanColumnSelection(selectedCardIds, colCardIds, !fullySelected));
    if (colCardIds.length > 0) selectionAnchorRef.current = colCardIds[0]!;
  };

  const selectedCards = useMemo(
    () => cards.filter((c: any) => selectedCardIds.has(c.id)),
    [cards, selectedCardIds],
  );

  // --- Drag and Drop (@dnd-kit) ---
  //
  // Goals (unchanged from the native-HTML5 version this replaced):
  //   * Cross-column moves AND within-column reordering, dropping BETWEEN cards.
  //   * The server's `/cards/:id/move` endpoint updates one card at a time and
  //     does NOT renumber siblings — so we compute the new ordering on the
  //     client and issue one `api.moveCard` per card whose position/column
  //     actually changed. Tiny N (human-paced drags); Promise.all is fine.
  //   * Optimistic: `cards` is updated locally before the round-trip; on any
  //     failure we reconcile against the server's truth.
  //
  // dnd-kit gives us the animated lift (<DragOverlay>), the glide-aside of
  // siblings (SortableContext + verticalListSortingStrategy), edge auto-scroll
  // (DndContext autoScroll, default on), and keyboard dragging (KeyboardSensor).
  // The reorder/drop-target math lives in utils/kanbanReorder.js so it's pure
  // and unit-tested. This component is the thin wiring layer.
  //
  // Pagination note: like the previous implementation, the math runs over the
  // loaded `cards` slice only — a column paged only partway in renumbers its
  // loaded cards from 0. The subsequent reconcile re-resolves against the full
  // server ordering.
  const sensors = useSensors(
    // distance activation: a click that moves < 6px never starts a drag, so
    // tapping a card still opens its detail modal.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const applyUpdatesOptimistic = (updates: any) => {
    if (updates.length === 0) return;
    setCards((prev: any) =>
      prev.map((c: any) => {
        const u = updates.find((x: any) => x.id === c.id);
        return u ? { ...c, column_id: u.columnId, position: u.position } : c;
      }),
    );
  };

  const commitUpdates = async (updates: any) => {
    if (updates.length === 0) return;
    try {
      await Promise.all(
        updates.map((u: any) =>
          api.moveCard(projectId, u.id, { columnId: u.columnId, position: u.position }),
        ),
      );
    } catch {
      reconcileBoard();
    }
  };

  // Apply a resolved move (already past the blocker check): optimistic local
  // reorder, then persist. `overCardId` is the card the drop lands relative to
  // (null = append to the end); `after` true = insert below the hovered card.
  const applyResolvedMove = async (
    card: any,
    targetColumnId: any,
    overCardId: any,
    after: any = false,
  ) => {
    adjustColumnTotals(card.column_id, targetColumnId);
    const updates = computeMoveUpdates(cards, card.id, targetColumnId, overCardId, after);
    applyUpdatesOptimistic(updates);
    await commitUpdates(updates);
  };

  // Move entry point. Soft-warns before moving a blocked card into a
  // blocker-sensitive column (the API still allows it; the user confirms).
  const requestMove = (card: any, targetColumnId: any, overCardId: any, after: any = false) => {
    const targetColumn = columns.find((c: any) => c.id === targetColumnId);
    if (!targetColumn) return;
    if (shouldConfirmMove(card, card.column_id, targetColumn)) {
      setPendingMove({ card, targetColumn, overCardId, after });
      return;
    }
    void applyResolvedMove(card, targetColumnId, overCardId, after);
  };

  // Back-compat helper used by the quick-actions context menu and the
  // pendingMove confirm dialog: append `card` to the end of a target column.
  const commitMove = async (
    card: any,
    targetColumnId: any,
    overCardId: any = null,
    after: any = false,
  ) => {
    await applyResolvedMove(card, targetColumnId, overCardId, after);
  };

  const commitBulkMove = async (toMove: any[], targetColumnId: string) => {
    if (toMove.length === 0) return;
    setBulkBusy(true);
    try {
      const columnIndex = (id: string) => columns.findIndex((c: any) => c.id === id);
      const sorted = [...toMove].sort((a, b) => {
        const colDiff = columnIndex(a.column_id) - columnIndex(b.column_id);
        if (colDiff !== 0) return colDiff;
        return a.position - b.position;
      });

      let workingCards = [...cards];
      const allUpdates: any[] = [];
      for (const card of sorted) {
        adjustColumnTotals(card.column_id, targetColumnId);
        const updates = computeMoveUpdates(workingCards, card.id, targetColumnId, null, true);
        allUpdates.push(...updates);
        workingCards = workingCards.map((c: any) => {
          const u = updates.find((x: any) => x.id === c.id);
          return u ? { ...c, column_id: u.columnId, position: u.position } : c;
        });
      }

      const deduped = Array.from(new Map(allUpdates.map((u) => [u.id, u])).values());
      applyUpdatesOptimistic(deduped);
      await commitUpdates(deduped);
      clearSelection();
      reconcileBoard();
    } catch (err: any) {
      console.error('Bulk move failed:', err);
      reconcileBoard();
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkMoveToColumn = async (targetColumnId: string) => {
    const targetColumn = columns.find((c: any) => c.id === targetColumnId);
    if (!targetColumn || selectedCards.length === 0) return;

    const needsConfirm = selectedCards.some((card: any) =>
      shouldConfirmMove(card, card.column_id, targetColumn),
    );
    if (needsConfirm) {
      setPendingBulkMove({ cards: selectedCards, targetColumn });
      return;
    }
    await commitBulkMove(selectedCards, targetColumnId);
  };

  const bulkSetPriority = async (priority: string) => {
    const ids = [...selectedCardIds];
    if (ids.length === 0) return;
    setBulkBusy(true);
    setCards((prev: any) =>
      prev.map((c: any) => (selectedCardIds.has(c.id) ? { ...c, priority } : c)),
    );
    try {
      await Promise.all(ids.map((id) => api.updateCard(projectId, id, { priority })));
      clearSelection();
      reconcileBoard();
    } catch (err: any) {
      console.error('Bulk priority update failed:', err);
      reconcileBoard();
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkDelete = async () => {
    const ids = [...selectedCardIds];
    if (ids.length === 0) return;
    if (
      !window.confirm(
        `Delete ${ids.length} card${ids.length === 1 ? '' : 's'}? This cannot be undone.`,
      )
    ) {
      return;
    }
    setBulkBusy(true);
    setCards((prev: any) => prev.filter((c: any) => !selectedCardIds.has(c.id)));
    try {
      await Promise.all(ids.map((id) => api.deleteCard(projectId, id)));
      clearSelection();
      reconcileBoard();
    } catch (err: any) {
      console.error('Bulk delete failed:', err);
      reconcileBoard();
    } finally {
      setBulkBusy(false);
    }
  };

  const handleDragStart = (event: any) => {
    setActiveId(event.active?.id ?? null);
  };

  const handleDragEnd = (event: any) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over) return;
    // Pass dnd-kit's `over` object + the dragged clone's translated rect so the
    // resolver can recover the top-half/bottom-half (before/after) distinction
    // that collision detection alone doesn't give us for cross-column drops.
    const resolved = resolveDropTarget(active.id, over, cards, active.rect?.current?.translated);
    if (!resolved) return;
    const card = cards.find((c: any) => c.id === active.id);
    if (!card) return;
    requestMove(card, resolved.targetColumnId, resolved.overCardId, resolved.after);
  };

  const handleDragCancel = () => setActiveId(null);

  // --- Card CRUD ---
  const handleAddCard = async (columnId: any) => {
    if (!newCardTitle.trim()) return;
    try {
      const payload: Record<string, any> = {
        title: newCardTitle.trim(),
        priority: newCardPriority,
        columnId,
        createdBy: 'user',
      };
      if (selectedEpicId) {
        payload.epicId = selectedEpicId;
      }
      await api.createCard(projectId, payload);
      setNewCardTitle('');
      setNewCardPriority('medium');
      setAddingInColumn(null);
      reconcileBoard();
    } catch (err: any) {
      console.error('Failed to create card:', err);
    }
  };

  // --- Right-click quick actions (no detail panel) ---
  // Each handler operates on an explicit card (the right-clicked one), applies
  // an optimistic update, persists, then reconciles against the eventual
  // `kanban_update` broadcast. Failures fall back to a reconcile so the board
  // re-syncs with the server's truth.

  const openCardContextMenu = (e: any, card: any) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ card, x: e.clientX, y: e.clientY });
  };
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const quickPatchCard = async (card: any, patch: any) => {
    setCards((prev: any) => prev.map((c: any) => (c.id === card.id ? { ...c, ...patch } : c)));
    try {
      await api.updateCard(projectId, card.id, patch);
      reconcileBoard();
    } catch (err: any) {
      console.error('Quick update failed:', err);
      reconcileBoard();
    }
  };

  const quickSetPriority = (card: any, priority: any) => quickPatchCard(card, { priority });

  const quickToggleLabel = (card: any, label: any) => {
    const current = (card.labels ? String(card.labels).split(',') : [])
      .map((l: any) => l.trim())
      .filter(Boolean);
    const next = current.includes(label)
      ? current.filter((l: any) => l !== label)
      : [...current, label];
    quickPatchCard(card, { labels: next.join(',') });
  };

  const quickMove = (card: any, columnId: any) => {
    if (card.column_id === columnId) return;
    // Quick-move appends to the end of the target column (overCardId = null);
    // requestMove handles the blocker-confirm gate.
    requestMove(card, columnId, null);
  };

  const quickAssign = async (card: any, agent: any) => {
    if (!agent) return;
    try {
      const result = await api.assignCard(projectId, card.id, agent.id);
      reconcileBoard();
      if (onNavigateToSession && result?.sessionId) {
        onNavigateToSession(agent.id, result.sessionId);
      }
    } catch (err: any) {
      console.error('Quick assign failed:', err);
    }
  };

  const quickUnassign = async (card: any) => {
    try {
      await api.unassignCard(projectId, card.id);
      reconcileBoard();
    } catch (err: any) {
      console.error('Quick unassign failed:', err);
    }
  };

  const quickLinkEpic = async (card: any, epicId: any) => {
    setCards((prev: any) =>
      prev.map((c: any) => (c.id === card.id ? { ...c, epic_id: epicId || null } : c)),
    );
    try {
      await api.linkCardToEpic(projectId, card.id, epicId || null);
      reconcileBoard();
    } catch (err: any) {
      console.error('Quick epic link failed:', err);
      reconcileBoard();
    }
  };

  const quickDelete = async (card: any) => {
    setCards((prev: any) => prev.filter((c: any) => c.id !== card.id));
    try {
      await api.deleteCard(projectId, card.id);
      reconcileBoard();
    } catch (err: any) {
      console.error('Quick delete failed:', err);
      reconcileBoard();
    }
  };

  const copyToClipboard = (text: any) => {
    try {
      navigator.clipboard?.writeText(text);
    } catch (err: any) {
      console.error('Clipboard write failed:', err);
    }
  };

  // Distinct labels across all loaded cards — drives the Labels submenu toggle.
  const allLabels = useMemo(() => {
    const set = new Set();
    for (const c of cards) {
      if (!c.labels) continue;
      for (const l of String(c.labels).split(',')) {
        const t = l.trim();
        if (t) set.add(t);
      }
    }
    return Array.from(set).sort((a: any, b: any) => a.localeCompare(b));
  }, [cards]);

  const doneColumnIds = new Set(
    columns.filter((c: any) => c.name.toLowerCase() === 'done').map((c: any) => c.id),
  );
  const epicCardCount = (epicId: any) =>
    cards.filter((c: any) => c.epic_id === epicId && !doneColumnIds.has(c.column_id)).length;

  const selectedEpic = selectedEpicId ? epics.find((e: any) => e.id === selectedEpicId) : null;

  // Board-wide card total from per-column counts (falls back to loaded count
  // before the first paged response lands). With pagination `cards` is only the
  // loaded slice, so summing `total` keeps the header honest.
  const pagingTotals = Object.values(columnPaging);
  const totalCardCount = pagingTotals.length
    ? pagingTotals.reduce((sum: any, p: any) => sum + (p.total || 0), 0)
    : cards.length;

  // A search query or epic filter is active. Filtering happens client-side
  // over the loaded `cards`, so when a filter is on we must hold the complete
  // board in memory — otherwise matches beyond the first page silently vanish.
  const filterActive = Boolean(searchQuery.trim()) || Boolean(selectedEpicId);

  // While a filter is active, eagerly drain every not-fully-loaded column so
  // the filter searches the whole board (the pre-pagination behavior), not
  // just the first page. This runs once when the filter flips on; each column
  // drains to completion (hasMore→false), so it won't re-fire. The fast
  // first-paint path (no filter) is unaffected. `columnPagingRef` is read
  // inside the loop rather than as a dep so appends mid-drain don't retrigger.
  const anyColumnHasMore = pagingTotals.some((p: any) => p.hasMore);
  useEffect(() => {
    if (!filterActive || !anyColumnHasMore) return;
    for (const col of columns) {
      if (columnPagingRef.current[col.id]?.hasMore) {
        void drainColumn(col.id);
      }
    }
  }, [filterActive, anyColumnHasMore, columns, drainColumn]);

  const openAutonomousDialog = () => {
    if (!selectedEpic) return;
    setAutonomousForm(epicToAutonomousForm(selectedEpic));
    setShowAutonomousDialog(true);
  };

  const closeAutonomousDialog = () => {
    if (autonomousSaving) return;
    setShowAutonomousDialog(false);
    setAutonomousForm(null);
  };

  const handleAutonomousFormChange = (patch: any) => {
    setAutonomousForm((prev: any) => ({ ...prev, ...patch }));
  };

  const handleSaveAutonomous = async () => {
    if (!selectedEpic || !autonomousForm || autonomousSaving) return;
    setAutonomousSaving(true);
    try {
      await api.updateEpic(
        projectId,
        selectedEpic.id,
        epicFormToUpdateBody({
          name: selectedEpic.name,
          description: selectedEpic.description || '',
          color: selectedEpic.color,
          ...autonomousForm,
        }),
      );
      setShowAutonomousDialog(false);
      setAutonomousForm(null);
      reconcileBoard();
    } catch (err: any) {
      console.error('Failed to save autonomous settings:', err);
    } finally {
      setAutonomousSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-gray-950 text-gray-500">
        <div className="h-8 w-8 rounded-full border-2 border-gray-700 border-t-indigo-500 animate-spin" />
        <p className="text-sm">Loading board…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-950 text-gray-400">
        <div className="text-center max-w-sm px-6">
          <p className="mb-1 text-base font-medium text-gray-200">Failed to load board</p>
          <p className="text-sm text-gray-500">{error}</p>
          <button
            onClick={() => {
              setLoading(true);
              fetchBoard();
            }}
            className="mt-5 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm text-gray-200 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-gray-950 min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.06] bg-gray-950/90 backdrop-blur-sm">
        <div className="flex items-center gap-3 min-w-0">
          {project?.color && (
            <span
              className="w-2.5 h-2.5 rounded-full block flex-shrink-0 ring-2 ring-white/10"
              style={{ backgroundColor: project.color }}
            />
          )}
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-gray-100 truncate">
              {project?.name || 'Project'}
            </h1>
            <p className="text-xs text-gray-500">
              {totalCardCount} card{totalCardCount !== 1 ? 's' : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onOpenEpics ? (
            <button
              type="button"
              onClick={onOpenEpics}
              className="flex items-center gap-1.5 h-9 px-3 rounded-lg text-xs font-medium text-gray-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] transition-colors"
              data-testid="open-epics-screen"
            >
              <Target size={14} />
              Epics
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              if (selectionMode) clearSelection();
              else setSelectionMode(true);
            }}
            className={`flex items-center gap-1.5 h-9 px-3 rounded-lg text-xs font-medium border transition-colors ${
              selectionMode
                ? 'border-indigo-500/40 bg-indigo-500/15 text-indigo-200 hover:bg-indigo-500/20'
                : 'text-gray-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border-white/[0.06]'
            }`}
            data-testid="kanban-select-mode"
            aria-pressed={selectionMode}
          >
            <CheckSquare size={14} />
            Select
          </button>
          <button
            onClick={() => {
              const target =
                columns.find((c: any) => c.name.toLowerCase() !== 'backlog') || columns[0];
              if (target) setAddingInColumn(target.id);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium transition-colors shadow-sm shadow-indigo-900/30"
          >
            <Plus size={14} />
            Add card
          </button>
        </div>
      </div>

      {/* Search + epic filter */}
      <div className="px-5 py-2.5 border-b border-white/[0.06] bg-gray-950/60 flex items-center gap-3 flex-wrap">
        <div className="relative max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e: any) => setSearchQuery(e.target.value)}
            placeholder="Search cards…"
            className="bg-white/[0.04] border border-white/[0.08] text-sm text-gray-100 rounded-lg pl-9 pr-8 h-9 w-52 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 focus:border-indigo-500/50 placeholder-gray-500 transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
            >
              <X size={12} />
            </button>
          )}
        </div>

        <EpicFilterDropdown
          epics={epics}
          selectedEpicId={selectedEpicId}
          onSelect={setSelectedEpicId}
          epicCardCount={epicCardCount}
        />

        {selectedEpic ? (
          <button
            type="button"
            onClick={openAutonomousDialog}
            data-testid="open-autonomous-dialog"
            className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-xs font-medium border transition-colors ${
              selectedEpic.autonomous === 1
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15'
                : 'border-white/[0.08] bg-white/[0.04] text-gray-400 hover:text-gray-200 hover:bg-white/[0.06]'
            }`}
          >
            <Zap size={14} className={selectedEpic.autonomous === 1 ? 'text-emerald-400' : ''} />
            Autonomous
          </button>
        ) : null}
      </div>

      <EpicAutonomousDialog
        open={showAutonomousDialog}
        epic={selectedEpic}
        form={autonomousForm || epicToAutonomousForm(selectedEpic || {})}
        onChange={handleAutonomousFormChange}
        modelConfig={modelConfig}
        saving={autonomousSaving}
        onSave={handleSaveAutonomous}
        onClose={closeAutonomousDialog}
      />

      {/* Board */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="flex-1 overflow-x-auto overflow-y-hidden p-5 min-w-0">
          <div className="flex gap-3.5 h-full w-full min-w-0 pb-1">
            {columns.map((col: any) => {
              const colCards = cardsForColumn(col.id);
              const columnColor = col.color || '#6b7280';
              const paging = columnPaging[col.id];
              // Unfiltered count of cards loaded so far for this column (the
              // header "X of Y" is about pagination depth, not the search/epic
              // filter — `colCards` is already filtered).
              const loadedInColumn = cards.filter((c: any) => c.column_id === col.id).length;
              const columnTotal = paging?.total ?? loadedInColumn;
              // `filterActive` is derived once at the component top (it also
              // drives the drain-on-filter effect). When a filter is on, show
              // the filtered count. Otherwise show
              // "loaded of total" while more remain, or the plain total when the
              // whole column is loaded.
              const countLabel = filterActive
                ? String(colCards.length)
                : columnTotal > loadedInColumn
                  ? `${loadedInColumn} of ${columnTotal}`
                  : String(columnTotal);
              const colCardIds = colCards.map((c: any) => c.id);
              const columnFullySelected = isKanbanColumnFullySelected(selectedCardIds, colCardIds);

              return (
                <div
                  key={col.id}
                  className="flex flex-col flex-1 min-w-[220px] h-full min-h-0 rounded-xl border border-white/[0.06] bg-white/[0.02]"
                >
                  {/* Column header */}
                  <div className="px-3.5 py-3 border-b border-white/[0.05]">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {showSelectionUi && colCards.length > 0 ? (
                          <button
                            type="button"
                            aria-label={
                              columnFullySelected
                                ? `Deselect all in ${col.name}`
                                : `Select all in ${col.name}`
                            }
                            aria-pressed={columnFullySelected}
                            data-testid={`column-select-all-${col.id}`}
                            onClick={() => handleToggleColumnSelect(col.id, colCardIds)}
                            className={`inline-flex items-center justify-center w-4 h-4 rounded flex-shrink-0 transition-colors ${
                              columnFullySelected
                                ? 'text-indigo-300'
                                : 'text-gray-600 hover:text-gray-400'
                            }`}
                          >
                            {columnFullySelected ? <CheckSquare size={14} /> : <Square size={14} />}
                          </button>
                        ) : null}
                        <span
                          className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{ backgroundColor: columnColor }}
                        />
                        <span className="text-xs font-semibold uppercase tracking-wide text-gray-300 truncate">
                          {col.name}
                        </span>
                      </div>
                      <span
                        className="text-[11px] font-medium text-gray-500 bg-white/[0.05] px-2 py-0.5 rounded-full tabular-nums flex-shrink-0"
                        data-testid={`column-count-${col.id}`}
                      >
                        {countLabel}
                      </span>
                    </div>
                  </div>

                  {/* Cards — the scroll area is the column droppable (drops into
                      empty space / past the last card resolve to the column). */}
                  <ColumnDropZone
                    columnId={col.id}
                    className="flex-1 overflow-y-auto kanban-column-scroll px-2.5 py-2 space-y-2"
                  >
                    <SortableContext items={colCardIds} strategy={verticalListSortingStrategy}>
                      {colCards.map((card: any) => (
                        <SortableCard
                          key={card.id}
                          card={card}
                          board={board}
                          epics={epics}
                          onOpen={openDetail}
                          onContextMenu={openCardContextMenu}
                          selected={selectedCardIds.has(card.id)}
                          showCheckbox={showSelectionUi}
                          onToggleSelect={handleToggleCardSelect}
                          selectionMode={selectionMode}
                          selectedCount={selectedCount}
                          dragDisabled={
                            selectionMode || (selectedCount > 1 && selectedCardIds.has(card.id))
                          }
                          onClearSelection={clearSelection}
                        />
                      ))}
                    </SortableContext>

                    {/* Infinite-scroll loading row + sentinel. The sentinel sits
                        at the bottom of the scroll container and triggers
                        loadMoreColumn when scrolled into view. Hidden while a
                        search/epic filter is active (the filter runs over loaded
                        cards only; paging more in wouldn't change the matched
                        set predictably, so we don't auto-fetch during a filter). */}
                    {paging?.loading && (
                      <div
                        data-testid={`column-loading-${col.id}`}
                        className="flex items-center justify-center gap-2 py-3 text-[11px] text-gray-500"
                      >
                        <div className="h-3.5 w-3.5 rounded-full border-2 border-gray-700 border-t-indigo-500 animate-spin" />
                        Loading more…
                      </div>
                    )}
                    {paging?.hasMore && !filterActive && (
                      <ColumnLoadMoreSentinel columnId={col.id} onLoadMore={loadMoreColumn} />
                    )}

                    {/* Inline add form */}
                    {addingInColumn === col.id && (
                      <div className="w-full rounded-xl p-3 bg-white/[0.04] border border-indigo-500/30">
                        <input
                          ref={addTitleRef}
                          type="text"
                          value={newCardTitle}
                          onChange={(e: any) => setNewCardTitle(e.target.value)}
                          onKeyDown={(e: any) => {
                            if (e.key === 'Enter') handleAddCard(col.id);
                            if (e.key === 'Escape') {
                              setAddingInColumn(null);
                              setNewCardTitle('');
                            }
                          }}
                          placeholder="Card title…"
                          className="w-full bg-gray-950/80 border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500/50 mb-2.5"
                        />
                        <div className="flex items-center gap-2">
                          <select
                            value={newCardPriority}
                            onChange={(e: any) => setNewCardPriority(e.target.value)}
                            className="bg-gray-950/80 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-gray-200 focus:outline-none"
                          >
                            {PRIORITIES.map((p: any) => (
                              <option key={p} value={p}>
                                {p}
                              </option>
                            ))}
                          </select>
                          <button
                            onClick={() => handleAddCard(col.id)}
                            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg transition-colors"
                          >
                            Add
                          </button>
                          <button
                            onClick={() => {
                              setAddingInColumn(null);
                              setNewCardTitle('');
                            }}
                            className="p-1.5 text-gray-500 hover:text-gray-200 rounded-md hover:bg-white/[0.06]"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      </div>
                    )}
                  </ColumnDropZone>

                  {/* Add button at bottom */}
                  {addingInColumn !== col.id && (
                    <button
                      onClick={() => {
                        setAddingInColumn(col.id);
                        setNewCardTitle('');
                        setNewCardPriority('medium');
                      }}
                      className="flex items-center gap-1.5 mx-2.5 mb-2.5 px-2.5 py-2 text-xs font-medium text-gray-500 hover:text-gray-300 hover:bg-white/[0.04] rounded-lg transition-colors"
                    >
                      <Plus size={12} />
                      Add card
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Floating clone that follows the cursor during a drag — the visible
            "lift". Renders nothing when no drag is in flight. */}
        <DragOverlay dropAnimation={{ duration: 200, easing: 'cubic-bezier(0.18,0.67,0.6,1.22)' }}>
          {activeId != null
            ? (() => {
                const activeCard = cards.find((c: any) => c.id === activeId);
                return activeCard ? (
                  <KanbanCard card={activeCard} board={board} epics={epics} overlay />
                ) : null;
              })()
            : null}
        </DragOverlay>
      </DndContext>

      <KanbanCardDetailModal detail={cardDetail} agents={agents} />

      {/* Confirm move — blocked-card → blocker-sensitive column */}
      {pendingMove && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          data-testid="confirm-move-dialog"
        >
          <div className="absolute inset-0 bg-black/60" onClick={() => setPendingMove(null)} />
          <div className="relative w-full max-w-md bg-gray-900 border border-red-900/60 rounded-xl shadow-2xl p-5">
            <div className="flex items-start gap-3 mb-3">
              <AlertTriangle size={20} className="text-red-400 mt-0.5 flex-shrink-0" />
              <div>
                <h3 className="text-sm font-semibold text-white mb-1">Card is still blocked</h3>
                <p className="text-xs text-gray-400 leading-relaxed">
                  &ldquo;{pendingMove.card.title}&rdquo; is blocked by{' '}
                  {pendingMove.card.blockers.filter((b: any) => !b.done).length} unresolved card(s).
                  Move it into{' '}
                  <span className="text-gray-200">{pendingMove.targetColumn.name}</span> anyway?
                </p>
              </div>
            </div>
            <ul className="mb-4 pl-8 space-y-1">
              {pendingMove.card.blockers
                .filter((b: any) => !b.done)
                .map((b: any) => (
                  <li key={b.id} className="text-xs text-red-300 truncate" title={b.title}>
                    • {b.title}
                  </li>
                ))}
            </ul>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingMove(null)}
                className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const { card, targetColumn, overCardId, after } = pendingMove;
                  setPendingMove(null);
                  await commitMove(card, targetColumn.id, overCardId, after);
                }}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded text-xs font-medium transition-colors"
              >
                Move anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingBulkMove && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          data-testid="confirm-bulk-move-dialog"
        >
          <div className="absolute inset-0 bg-black/60" onClick={() => setPendingBulkMove(null)} />
          <div className="relative w-full max-w-md bg-gray-900 border border-red-900/60 rounded-xl shadow-2xl p-5">
            <div className="flex items-start gap-3 mb-3">
              <AlertTriangle size={20} className="text-red-400 mt-0.5 flex-shrink-0" />
              <div>
                <h3 className="text-sm font-semibold text-white mb-1">
                  {pendingBulkMove.cards.length} blocked card
                  {pendingBulkMove.cards.length === 1 ? '' : 's'} selected
                </h3>
                <p className="text-xs text-gray-400 leading-relaxed">
                  At least one selected card still has unresolved blockers. Move{' '}
                  {pendingBulkMove.cards.length === 1 ? 'it' : 'them'} into{' '}
                  <span className="text-gray-200">{pendingBulkMove.targetColumn.name}</span> anyway?
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingBulkMove(null)}
                className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const { cards: toMove, targetColumn } = pendingBulkMove;
                  setPendingBulkMove(null);
                  await commitBulkMove(toMove, targetColumn.id);
                }}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded text-xs font-medium transition-colors"
              >
                Move anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedCount > 0 ? (
        <KanbanBulkActionBar
          count={selectedCount}
          columns={columns}
          onMove={bulkMoveToColumn}
          onSetPriority={bulkSetPriority}
          onDelete={bulkDelete}
          onClear={clearSelection}
          busy={bulkBusy}
        />
      ) : null}

      {/* Right-click quick-actions menu. `contextCard` re-reads the live card
          from state so submenus reflect optimistic priority/epic changes. */}
      {contextMenu &&
        (() => {
          const live = cards.find((c: any) => c.id === contextMenu.card.id) || contextMenu.card;
          const cardUrl = `${window.location.origin}/projects/${projectId}/board?card=${live.id}`;
          const idLabel = cardShortLabel(board?.card_prefix, live.short_id) || String(live.id);
          return (
            <CardContextMenu
              card={live}
              x={contextMenu.x}
              y={contextMenu.y}
              columns={columns}
              epics={epics}
              agents={projectAgents}
              labels={allLabels}
              onClose={closeContextMenu}
              onMove={(columnId: any) => {
                closeContextMenu();
                quickMove(live, columnId);
              }}
              onSetPriority={(priority: any) => {
                closeContextMenu();
                quickSetPriority(live, priority);
              }}
              onAssign={(agent: any) => {
                closeContextMenu();
                quickAssign(live, agent);
              }}
              onUnassign={() => {
                closeContextMenu();
                quickUnassign(live);
              }}
              onToggleLabel={(label: any) => quickToggleLabel(live, label)}
              onLinkEpic={(epicId: any) => {
                closeContextMenu();
                quickLinkEpic(live, epicId);
              }}
              onCopyId={() => copyToClipboard(idLabel)}
              onCopyLink={() => copyToClipboard(cardUrl)}
              onDelete={() => quickDelete(live)}
            />
          );
        })()}
    </div>
  );
}
