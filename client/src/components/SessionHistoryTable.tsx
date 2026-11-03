import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { History, RefreshCw } from 'lucide-react';
import { api } from '../utils/api';
import { cardShortLabel } from '../utils/kanbanCard';
import { formatShipDuration } from '@shared/utils/shipDuration';

export interface SessionHistoryRow {
  session_id: string;
  agent_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  card: { id: string; short_id: number | null; card_prefix: string | null; title: string } | null;
  pr: { number: number | null; url: string; title: string | null; status: string | null } | null;
  review_rounds: number;
  finalize_review_rounds: number;
  pr_reviews: number;
  ci_rounds: number;
  ship_seconds: number | null;
  shipped_via: 'merged' | 'pushed' | null;
  shipped_at: string | null;
}

const PR_STATUS_CLASS: Record<string, string> = {
  merged: 'text-violet-300',
  open: 'text-emerald-300',
  closed: 'text-gray-400',
};

function isExternalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

const POPOVER_GAP = 4;
const VIEWPORT_MARGIN = 8;

/**
 * Viewport position for a fixed popover anchored to a trigger. Prefers below
 * the trigger, flips above when it would run off the bottom and there is more
 * room above, and clamps horizontally so the whole popover stays on screen.
 */
export function placePopover(
  trigger: { left: number; top: number; bottom: number },
  popover: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const spaceBelow = viewport.height - trigger.bottom - POPOVER_GAP - VIEWPORT_MARGIN;
  const spaceAbove = trigger.top - POPOVER_GAP - VIEWPORT_MARGIN;
  const below = popover.height <= spaceBelow || spaceBelow >= spaceAbove;
  let top = below ? trigger.bottom + POPOVER_GAP : trigger.top - POPOVER_GAP - popover.height;
  top = Math.max(
    VIEWPORT_MARGIN,
    Math.min(top, viewport.height - VIEWPORT_MARGIN - popover.height),
  );
  const maxLeft = viewport.width - VIEWPORT_MARGIN - popover.width;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(trigger.left, maxLeft));
  return { left, top };
}

/**
 * Ticket id only, so the row has room for the numeric columns. The title and
 * the rest of the card detail live in a hover/focus popover. The popover is
 * position: fixed because the table's scroll container would clip an
 * absolutely positioned one.
 */
function TicketCell({
  label,
  card,
  onOpen,
}: {
  label: string;
  card: NonNullable<SessionHistoryRow['card']>;
  onOpen?: () => void;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const show = () => setOpen(true);
  const hide = useCallback(() => {
    setOpen(false);
    setPosition(null);
  }, []);
  // Measure after render so placement uses the popover's real height, which
  // depends on how long the ticket title wraps.
  useLayoutEffect(() => {
    if (!open || !ref.current || !popoverRef.current) return;
    const trigger = ref.current.getBoundingClientRect();
    const size = popoverRef.current.getBoundingClientRect();
    setPosition(
      placePopover(trigger, size, { width: window.innerWidth, height: window.innerHeight }),
    );
  }, [open]);
  // A fixed popover does not follow its trigger, so dismiss it when anything
  // scrolls (including the table's own scroll container) or the window resizes.
  // Escape dismisses it too, so it never sits over content the user wants.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, hide]);
  // The popover must stay reachable when the ticket is not navigable, so the
  // trigger is never a disabled button (disabled buttons get neither focus nor
  // mouseenter). Without a click target it is a focusable span instead.
  const triggerProps = {
    'aria-describedby': open ? popoverId : undefined,
    'data-testid': 'session-history-ticket',
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hide,
  };
  return (
    <>
      {onOpen ? (
        <button
          ref={(el) => {
            ref.current = el;
          }}
          type="button"
          className="text-sky-300 hover:underline"
          onClick={onOpen}
          {...triggerProps}
        >
          {label}
        </button>
      ) : (
        <span
          ref={(el) => {
            ref.current = el;
          }}
          tabIndex={0}
          className="text-gray-300 cursor-default"
          {...triggerProps}
        >
          {label}
        </span>
      )}
      {open && (
        <div
          id={popoverId}
          role="tooltip"
          data-testid="session-history-ticket-popover"
          className="fixed z-50 w-72 rounded-lg border border-gray-700 bg-gray-900 p-3 text-xs shadow-xl whitespace-normal pointer-events-none"
          ref={popoverRef}
          style={
            position
              ? { left: position.left, top: position.top }
              : { left: 0, top: 0, visibility: 'hidden' }
          }
        >
          <div className="font-medium text-sky-300">{label}</div>
          <div className="mt-1 text-gray-200 break-words">{card.title}</div>
          {onOpen && <div className="mt-2 text-gray-500">Click to open the ticket</div>}
        </div>
      )}
    </>
  );
}

export default function SessionHistoryTable({
  projectId,
  onOpenSession,
  onOpenPr,
  onOpenCard,
}: {
  projectId: string;
  onOpenSession?: (agentId: string, sessionId: string) => void;
  onOpenPr?: (projectId: string, prNumber: number) => void;
  onOpenCard?: (projectId: string, cardId: string) => void;
}) {
  const [rows, setRows] = useState<SessionHistoryRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = (await api.getProjectSessionHistory(projectId)) as {
        sessions: SessionHistoryRow[];
      };
      setRows(data?.sessions ?? []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load session history');
      setRows(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mb-6 rounded-xl border border-gray-800 bg-gray-900/40 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm text-gray-300">
          <History size={16} className="text-indigo-400" />
          Session history
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="p-1.5 rounded-md text-gray-400 hover:bg-gray-800 disabled:opacity-50"
          title="Refresh session history"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && <div className="text-xs text-red-300">{error}</div>}
      {!rows && loading && <div className="text-xs text-gray-500">Loading sessions…</div>}
      {rows && rows.length === 0 && (
        <div className="text-xs text-gray-500">
          No sessions with a linked ticket, PR, or Finalize run yet.
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="overflow-x-auto max-h-96 overflow-y-auto">
          <table className="w-full text-xs" data-testid="session-history-table">
            <thead className="sticky top-0 bg-gray-900 text-gray-500">
              <tr className="text-left">
                <th className="py-1.5 pr-3 font-medium">Session</th>
                <th className="py-1.5 pr-3 font-medium">Ticket</th>
                <th className="py-1.5 pr-3 font-medium">PR</th>
                <th className="py-1.5 pr-3 font-medium text-right">Review rounds</th>
                <th className="py-1.5 pr-3 font-medium text-right">CI rounds</th>
                <th
                  className="py-1.5 font-medium text-right"
                  title="First prompt to merge, or to the latest push if not merged"
                >
                  Time to ship
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const cardLabel = row.card
                  ? cardShortLabel(row.card.card_prefix, row.card.short_id) || 'Card'
                  : null;
                const prLabel = row.pr
                  ? row.pr.number != null
                    ? `#${row.pr.number}`
                    : 'PR'
                  : null;
                return (
                  <tr key={row.session_id} className="border-t border-gray-800 align-top">
                    <td className="py-1.5 pr-3 max-w-[18rem]">
                      {onOpenSession ? (
                        <button
                          type="button"
                          className="text-left text-gray-200 hover:text-indigo-300 truncate max-w-full block"
                          title={row.title}
                          onClick={() => onOpenSession(row.agent_id, row.session_id)}
                        >
                          {row.title}
                        </button>
                      ) : (
                        <span className="text-gray-200 truncate block" title={row.title}>
                          {row.title}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      {row.card ? (
                        <TicketCell
                          label={cardLabel ?? 'Card'}
                          card={row.card}
                          onOpen={
                            onOpenCard ? () => onOpenCard(projectId, row.card!.id) : undefined
                          }
                        />
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      {row.pr ? (
                        row.pr.number != null && !isExternalUrl(row.pr.url) && onOpenPr ? (
                          <button
                            type="button"
                            className="text-sky-300 hover:underline"
                            title={row.pr.title ?? undefined}
                            onClick={() => onOpenPr(projectId, row.pr!.number as number)}
                          >
                            {prLabel}
                          </button>
                        ) : !isExternalUrl(row.pr.url) ? (
                          <span className="text-gray-300" title={row.pr.url}>
                            {prLabel}
                          </span>
                        ) : (
                          <a
                            href={row.pr.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sky-300 hover:underline"
                            title={row.pr.title ?? undefined}
                          >
                            {prLabel}
                          </a>
                        )
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                      {row.pr?.status && (
                        <span
                          className={`ml-1.5 ${PR_STATUS_CLASS[row.pr.status] ?? 'text-gray-400'}`}
                        >
                          {row.pr.status}
                        </span>
                      )}
                    </td>
                    <td
                      className="py-1.5 pr-3 text-right text-gray-200 tabular-nums"
                      title={`${row.finalize_review_rounds} Finalize review round(s), ${row.pr_reviews} PR review(s)`}
                    >
                      {row.review_rounds}
                    </td>
                    <td className="py-1.5 pr-3 text-right text-gray-200 tabular-nums">
                      {row.ci_rounds}
                    </td>
                    <td
                      className="py-1.5 text-right text-gray-200 tabular-nums whitespace-nowrap"
                      data-testid="session-history-ship-time"
                      title={
                        row.shipped_at
                          ? `${row.shipped_via === 'merged' ? 'Merged' : 'Pushed'} ${new Date(row.shipped_at).toLocaleString()}`
                          : undefined
                      }
                    >
                      {formatShipDuration(row.ship_seconds)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
