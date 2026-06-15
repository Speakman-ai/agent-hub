import { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import {
  LifeBuoy,
  AlertCircle,
  Bug,
  Lightbulb,
  HelpCircle,
  Flame,
  MessageSquare,
  Sparkles,
  PlayCircle,
  SquareKanban,
  Check,
  X,
} from 'lucide-react';
import { api } from '../utils/api.js';
import { getServerBase } from '../utils/connection.js';
import ReplayPlayerModal from './ReplayPlayerModal.jsx';
import { parseReplayIdFromRef } from '../utils/replayPlayer.js';

function relativeTime(ts) {
  if (!ts) return '';
  const d = ts.includes('T') ? new Date(ts) : new Date(ts + 'Z');
  const diffMs = Date.now() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHrs < 24) return `${diffHrs}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

// Severity → sort rank (most urgent first). Matches the server's ORDER BY so
// WebSocket-inserted rows land in the right place without a refetch.
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

const SEVERITY_BADGE = {
  critical: 'bg-red-500/20 text-red-300 border-red-500/40',
  high: 'bg-orange-500/20 text-orange-300 border-orange-500/40',
  medium: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  low: 'bg-gray-600/30 text-gray-300 border-gray-600/50',
};

const TYPE_META = {
  bug: { label: 'Bug', Icon: Bug, className: 'text-rose-400' },
  feature_request: { label: 'Feature request', Icon: Lightbulb, className: 'text-emerald-400' },
  question: { label: 'Question', Icon: HelpCircle, className: 'text-sky-400' },
  incident: { label: 'Incident', Icon: Flame, className: 'text-red-400' },
  other: { label: 'Other', Icon: MessageSquare, className: 'text-gray-400' },
};

const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'new', label: 'New' },
  { key: 'investigating', label: 'Investigating' },
  { key: 'converted', label: 'Converted' },
  { key: 'closed', label: 'Closed' },
];

function sortTickets(list) {
  return [...list].sort((a, b) => {
    const sa = SEVERITY_RANK[a.severity] ?? 4;
    const sb = SEVERITY_RANK[b.severity] ?? 4;
    if (sa !== sb) return sa - sb;
    // Newest first within a severity, matching the server's created_at DESC.
    return (b.created_at || '').localeCompare(a.created_at || '');
  });
}

// Resolve a replay reference to a clickable URL. Absolute URLs pass through;
// server-relative paths (e.g. an /uploads/... attachment) are prefixed with the
// active server origin so remote-mode clients hit the right host.
function resolveReplayUrl(ref) {
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref)) return ref;
  const base = getServerBase();
  if (ref.startsWith('/')) return `${base}${ref}`;
  return `${base}/${ref}`;
}

function SupportTicketCard({ ticket, projectId, onOpen }) {
  const type = TYPE_META[ticket.type] || TYPE_META.other;
  const { Icon } = type;
  const severityClass = SEVERITY_BADGE[ticket.severity] || SEVERITY_BADGE.low;
  const replayId = ticket.type === 'bug' ? parseReplayIdFromRef(ticket.replay_ref) : null;
  const title = ticket.subject?.trim() || ticket.body?.trim() || '(no subject)';

  const [watchingReplay, setWatchingReplay] = useState(false);
  const [converting, setConverting] = useState(false);
  const [convertError, setConvertError] = useState(null);
  // A ticket is "converted" once its status flips (the WebSocket-pushed row
  // carries the new status + converted_card_id, so the button reflects the
  // result without a manual refetch).
  const isConverted = ticket.status === 'converted' || !!ticket.converted_card_id;

  const handleConvert = async () => {
    if (converting || isConverted) return;
    setConverting(true);
    setConvertError(null);
    try {
      await api.convertSupportTicketToCard(projectId, ticket.id);
      // The support_ticket_updated WebSocket event re-renders this card as
      // converted; no local state mutation needed.
    } catch (err) {
      setConvertError(err.message || 'Failed to convert');
    } finally {
      setConverting(false);
    }
  };

  const handleOpen = () => onOpen?.(ticket);

  // Accessible "stretched button" layout: the card container is a plain,
  // non-interactive element. A single dedicated <button> is absolutely
  // positioned to cover the whole card (the full-card open affordance, with
  // native keyboard/Enter/Space support), and the real inner actions (Watch
  // replay, Convert) sit ABOVE it as siblings — never nested inside another
  // interactive control. The content layer is pointer-events-none so a click on
  // empty card space falls through to the overlay button; the action buttons
  // re-enable pointer events for themselves.
  return (
    <>
      <div
        data-testid="support-ticket-card"
        className="relative bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-700 transition-colors focus-within:ring-1 focus-within:ring-blue-500/50"
      >
        <button
          type="button"
          onClick={handleOpen}
          aria-label={`Open support ticket: ${title}`}
          className="absolute inset-0 z-0 rounded-lg cursor-pointer focus:outline-none"
        />

        <div className="pointer-events-none relative z-10 flex items-start gap-3">
          <Icon size={16} className={`flex-shrink-0 mt-0.5 ${type.className}`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${severityClass}`}
              >
                {ticket.severity}
              </span>
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">
                {type.label}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800/60 text-gray-500">
                {ticket.status}
              </span>
              <span className="text-[11px] text-gray-600 ml-auto">
                {relativeTime(ticket.created_at)}
              </span>
            </div>

            <div className="text-sm text-gray-200 font-medium mt-1.5 break-words">{title}</div>

            {ticket.subject?.trim() && ticket.body?.trim() ? (
              <div className="text-xs text-gray-500 mt-1 line-clamp-3 whitespace-pre-wrap break-words">
                {ticket.body}
              </div>
            ) : null}

            {ticket.reporter ? (
              <div className="text-[11px] text-gray-600 mt-1.5">Reported by {ticket.reporter}</div>
            ) : null}

            {ticket.ai_summary ? (
              <div className="mt-2 flex items-start gap-2 rounded-md bg-violet-500/10 border border-violet-500/20 px-2.5 py-2">
                <Sparkles size={13} className="text-violet-300 flex-shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-300/80">
                    AI investigation
                  </div>
                  <div className="text-xs text-gray-300 mt-0.5 whitespace-pre-wrap break-words">
                    {ticket.ai_summary}
                  </div>
                </div>
              </div>
            ) : null}

            {replayId ? (
              <button
                type="button"
                onClick={() => setWatchingReplay(true)}
                className="pointer-events-auto relative inline-flex items-center gap-1.5 mt-2 text-xs text-blue-400 hover:text-blue-300"
                data-testid="watch-replay-button"
              >
                <PlayCircle size={13} />
                Watch replay
              </button>
            ) : null}

            <div className="mt-2.5 flex items-center gap-2 flex-wrap">
              {isConverted ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
                  <Check size={13} />
                  Converted to card
                </span>
              ) : (
                <button
                  onClick={handleConvert}
                  disabled={converting}
                  title="Create a To Do kanban card from this ticket"
                  className="pointer-events-auto relative inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded border border-gray-700 text-gray-300 hover:text-gray-100 hover:border-gray-600 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <SquareKanban size={13} />
                  {converting ? 'Converting…' : 'Convert to card'}
                </button>
              )}
              {convertError ? (
                <span className="text-[11px] text-red-400">{convertError}</span>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {watchingReplay && replayId ? (
        <ReplayPlayerModal
          replayId={replayId}
          title={`Replay · ${title}`}
          onClose={() => setWatchingReplay(false)}
        />
      ) : null}
    </>
  );
}

function SupportTicketDetailModal({ ticket: liveTicket, projectId, onClose }) {
  // Only the *fetched enrichment* is held locally — the complete
  // ai_investigation the list rows truncate to ai_summary. Every other field is
  // read straight from the live `liveTicket` prop (which the parent recomputes
  // from its WebSocket-updated list), so same-ticket updates — status,
  // converted_card_id, refreshed AI fields — propagate into the open modal
  // instead of going stale.
  const [enrichment, setEnrichment] = useState(null);
  const [watchingReplay, setWatchingReplay] = useState(false);
  const [converting, setConverting] = useState(false);
  const [convertError, setConvertError] = useState(null);

  // Fetch the full ticket from the dedicated detail endpoint for this id. Reset
  // the enrichment first so a previous ticket's investigation can't bleed
  // through while the new fetch is in flight.
  useEffect(() => {
    let cancelled = false;
    setEnrichment(null);
    api
      .getSupportTicket(projectId, liveTicket.id)
      .then((full) => {
        if (!cancelled && full) setEnrichment(full);
      })
      .catch(() => {
        // Keep the live prop — the detail view still works without enrichment.
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, liveTicket.id]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Merge: the live prop wins for every volatile field; only the AI
  // investigation fields are backfilled from the fetched enrichment (and only
  // when it is for this ticket, guarding an in-flight id change).
  const fetched = enrichment && enrichment.id === liveTicket.id ? enrichment : null;
  const ticket = {
    ...liveTicket,
    ai_investigation: fetched?.ai_investigation ?? liveTicket.ai_investigation,
    ai_investigated_at: fetched?.ai_investigated_at ?? liveTicket.ai_investigated_at,
  };

  const type = TYPE_META[ticket.type] || TYPE_META.other;
  const { Icon } = type;
  const severityClass = SEVERITY_BADGE[ticket.severity] || SEVERITY_BADGE.low;
  const replayId = ticket.type === 'bug' ? parseReplayIdFromRef(ticket.replay_ref) : null;
  const title = ticket.subject?.trim() || ticket.body?.trim() || '(no subject)';
  const isConverted = ticket.status === 'converted' || !!ticket.converted_card_id;
  const investigation = ticket.ai_investigation?.trim() || ticket.ai_summary?.trim() || null;

  const handleConvert = async () => {
    if (converting || isConverted) return;
    setConverting(true);
    setConvertError(null);
    try {
      await api.convertSupportTicketToCard(projectId, ticket.id);
      // The support_ticket_updated WebSocket event updates the parent list,
      // which flows back through the `liveTicket` prop and re-renders this
      // modal as converted — no local ticket copy to keep in sync.
    } catch (err) {
      setConvertError(err.message || 'Failed to convert');
    } finally {
      setConverting(false);
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8"
        onClick={onClose}
        data-testid="support-ticket-detail-modal"
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Support ticket: ${title}`}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-2xl my-auto rounded-xl border border-gray-800 bg-gray-900 shadow-2xl"
        >
          {/* Header */}
          <div className="flex items-start gap-3 border-b border-gray-800 px-5 py-4">
            <Icon size={18} className={`flex-shrink-0 mt-0.5 ${type.className}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${severityClass}`}
                >
                  {ticket.severity}
                </span>
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">
                  {type.label}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800/60 text-gray-500">
                  {ticket.status}
                </span>
              </div>
              <h2 className="text-base text-gray-100 font-semibold mt-2 break-words">{title}</h2>
              <div className="text-[11px] text-gray-600 mt-1 flex items-center gap-1.5 flex-wrap">
                <span>Opened {relativeTime(ticket.created_at)}</span>
                {ticket.reporter ? <span>· Reported by {ticket.reporter}</span> : null}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex-shrink-0 text-gray-500 hover:text-gray-200 transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          {/* Body */}
          <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
            {ticket.body?.trim() ? (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-1">
                  Description
                </div>
                <div className="text-sm text-gray-300 whitespace-pre-wrap break-words">
                  {ticket.body}
                </div>
              </div>
            ) : null}

            {investigation ? (
              <div className="rounded-md bg-violet-500/10 border border-violet-500/20 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <Sparkles size={13} className="text-violet-300" />
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-300/80">
                    AI investigation
                  </div>
                </div>
                <div className="text-xs text-gray-300 mt-1.5 whitespace-pre-wrap break-words">
                  {investigation}
                </div>
                {ticket.ai_investigated_at ? (
                  <div className="text-[10px] text-gray-600 mt-1.5">
                    Investigated {relativeTime(ticket.ai_investigated_at)}
                  </div>
                ) : null}
              </div>
            ) : null}

            {replayId ? (
              <button
                type="button"
                onClick={() => setWatchingReplay(true)}
                className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300"
                data-testid="detail-watch-replay-button"
              >
                <PlayCircle size={14} />
                Watch replay
              </button>
            ) : null}
          </div>

          {/* Footer actions */}
          <div className="flex items-center gap-2 flex-wrap border-t border-gray-800 px-5 py-3">
            {isConverted ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
                <Check size={13} />
                Converted to card{ticket.converted_card_id ? ` · ${ticket.converted_card_id}` : ''}
              </span>
            ) : (
              <button
                onClick={handleConvert}
                disabled={converting}
                title="Create a To Do kanban card from this ticket"
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border border-gray-700 text-gray-300 hover:text-gray-100 hover:border-gray-600 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <SquareKanban size={13} />
                {converting ? 'Converting…' : 'Convert to card'}
              </button>
            )}
            {convertError ? <span className="text-[11px] text-red-400">{convertError}</span> : null}
          </div>
        </div>
      </div>

      {watchingReplay && replayId ? (
        <ReplayPlayerModal
          replayId={replayId}
          title={`Replay · ${title}`}
          onClose={() => setWatchingReplay(false)}
        />
      ) : null}
    </>
  );
}

function CustomerSupportPageInner({ projectId }, ref) {
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  // The ticket whose detail modal is open (null = closed), held independently of
  // the filtered list so a status-filter change never drops the modal out from
  // under the user. It's kept fresh by the same WebSocket upsert/remove path
  // that drives the list (see upsertTicket / removeTicket), so it still tracks
  // live updates and closes if the ticket is deleted.
  const [openTicket, setOpenTicket] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .getSupportTickets(projectId, statusFilter === 'all' ? undefined : statusFilter)
      .then((data) => {
        if (!cancelled) setTickets(sortTickets(Array.isArray(data) ? data : []));
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, statusFilter]);

  // ── WebSocket-driven live updates (pushed from App.jsx via the ref) ──
  const matchesFilter = (ticket) => statusFilter === 'all' || ticket.status === statusFilter;

  const upsertTicket = (ticket) => {
    if (!ticket) return;
    setTickets((prev) => {
      const without = prev.filter((t) => t.id !== ticket.id);
      // Respect the active status filter: a status change can move a ticket
      // out of the current view.
      if (!matchesFilter(ticket)) return without;
      return sortTickets([...without, ticket]);
    });
    // Keep the open detail modal in sync even when the update would filter the
    // ticket out of the list — the modal lives until explicitly closed.
    setOpenTicket((cur) => (cur && cur.id === ticket.id ? ticket : cur));
  };

  const removeTicket = (ticketId) => {
    setTickets((prev) => prev.filter((t) => t.id !== ticketId));
    // A deleted ticket has nothing to show — close its modal if open.
    setOpenTicket((cur) => (cur && cur.id === ticketId ? null : cur));
  };

  useImperativeHandle(
    ref,
    () => ({
      addTicket: upsertTicket,
      updateTicket: upsertTicket,
      removeTicket,
    }),
    // statusFilter is read inside upsertTicket; rebuild the handle when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [statusFilter],
  );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header with status filter */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 bg-gray-900/50">
        <LifeBuoy size={16} className="text-blue-400" />
        <h2 className="text-sm font-medium text-gray-200">Customer Support</h2>
        <div className="flex items-center gap-1 ml-auto flex-wrap justify-end">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              className={`text-[11px] px-2 py-1 rounded transition-colors ${
                statusFilter === f.key
                  ? 'bg-gray-700 text-gray-200'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            <div className="animate-spin w-5 h-5 border-2 border-gray-600 border-t-gray-300 rounded-full" />
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            <div className="text-center">
              <AlertCircle size={32} className="mx-auto mb-2 text-red-400" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          </div>
        ) : tickets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-600 py-20">
            <LifeBuoy size={36} className="mb-3 text-gray-700" />
            <p className="text-sm">No support requests</p>
            <p className="text-xs text-gray-700 mt-1">
              Incoming requests appear here, most urgent first.
            </p>
          </div>
        ) : (
          <div className="p-3 space-y-2 max-w-3xl mx-auto">
            {tickets.map((ticket) => (
              <SupportTicketCard
                key={ticket.id}
                ticket={ticket}
                projectId={projectId}
                onOpen={(t) => setOpenTicket(t)}
              />
            ))}
          </div>
        )}
      </div>

      {openTicket ? (
        <SupportTicketDetailModal
          ticket={openTicket}
          projectId={projectId}
          onClose={() => setOpenTicket(null)}
        />
      ) : null}
    </div>
  );
}

const CustomerSupportPage = forwardRef(CustomerSupportPageInner);
CustomerSupportPage.displayName = 'CustomerSupportPage';
export default CustomerSupportPage;
export { sortTickets, resolveReplayUrl };
