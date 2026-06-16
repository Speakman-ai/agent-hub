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
  Trash2,
} from 'lucide-react';
import { api } from '../utils/api.js';
import { getServerBase } from '../utils/connection.js';
import ReplayPlayerModal from './ReplayPlayerModal.jsx';
import { parseReplayIdFromRef } from '../utils/replayPlayer.js';
import { MarkdownContent } from './MarkdownRenderer.jsx';

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

// Resolve a server-stored reference to a clickable URL. Absolute URLs pass
// through; server-relative paths (e.g. an /uploads/... attachment) are prefixed
// with the active server origin so remote-mode clients hit the right host.
function resolveUploadUrl(ref) {
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref)) return ref;
  const base = getServerBase();
  if (ref.startsWith('/')) return `${base}${ref}`;
  return `${base}/${ref}`;
}

// Back-compat alias: the replay ref and screenshot ref share the same upload
// origin-resolution. Kept as a named export for existing consumers/tests.
const resolveReplayUrl = resolveUploadUrl;

// Two-step delete control shared by the card and the detail modal. The first
// click arms a "Confirm" / "Cancel" pair so a single misclick can't destroy a
// ticket. On a successful DELETE the initiating client removes the row itself
// via `onDeleted` (optimistic update) — the support_ticket_deleted WebSocket
// event is only cross-client synchronization, so a dropped/disconnected socket
// can't leave a deleted ticket stranded in this client's list. `stretched`
// re-enables pointer events for use over the card's full-card overlay button.
function DeleteTicketButton({ projectId, ticketId, stretched = false, onDeleted }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const pe = stretched ? 'pointer-events-auto relative' : '';

  const handleDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteSupportTicket(projectId, ticketId);
      // Remove locally on success rather than waiting on the WebSocket echo —
      // the parent drops the row (and closes the modal) immediately.
      onDeleted?.();
    } catch (err) {
      setDeleteError(err.message || 'Failed to delete');
      setDeleting(false);
      setConfirming(false);
    }
  };

  if (confirming) {
    return (
      <span className={`${pe} inline-flex items-center gap-1.5`}>
        <span className="text-[11px] text-gray-400">Delete?</span>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className={`${pe} inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-red-600/60 text-red-300 hover:bg-red-600/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors`}
        >
          {deleting ? 'Deleting…' : 'Confirm'}
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={deleting}
          className={`${pe} text-xs px-2 py-1 rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 disabled:opacity-50 transition-colors`}
        >
          Cancel
        </button>
        {deleteError ? <span className="text-[11px] text-red-400">{deleteError}</span> : null}
      </span>
    );
  }

  return (
    <span className={`${pe} inline-flex items-center gap-2`}>
      <button
        onClick={() => setConfirming(true)}
        title="Delete this support ticket"
        className={`${pe} inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded border border-gray-700 text-gray-400 hover:text-red-300 hover:border-red-600/60 hover:bg-red-600/10 transition-colors`}
      >
        <Trash2 size={13} />
        Delete
      </button>
      {deleteError ? <span className="text-[11px] text-red-400">{deleteError}</span> : null}
    </span>
  );
}

// Manually-settable ticket lifecycle states. `converted` is intentionally
// absent — conversion is an action (it promotes the ticket to a card and
// removes it), not a status a human picks from a dropdown.
const STATUS_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'investigating', label: 'Investigating' },
  { value: 'closed', label: 'Closed' },
];

// Inline status changer. Replaces the old read-only status badge so an operator
// can move a ticket through its lifecycle (New → Investigating → Closed)
// without leaving the queue. Optimistically reflects the change via `onUpdated`
// (the parent's upsert), then reconciles with the server's returned row; a
// failed PATCH reverts to the original ticket. `stretched` re-enables pointer
// events for use over the card's full-card overlay button.
function StatusSelect({ projectId, ticket, stretched = false, onUpdated }) {
  const [saving, setSaving] = useState(false);
  const pe = stretched ? 'pointer-events-auto relative' : '';
  // A legacy/automatic state (e.g. an old `converted` row) isn't in the manual
  // option list — surface it as the current value so the control still renders
  // a sensible label, but don't offer it as a pickable choice.
  const isLegacy = !STATUS_OPTIONS.some((o) => o.value === ticket.status);

  const handleChange = async (e) => {
    const next = e.target.value;
    if (next === ticket.status || saving) return;
    setSaving(true);
    onUpdated?.({ ...ticket, status: next }); // optimistic
    try {
      const updated = await api.setSupportTicketStatus(projectId, ticket.id, next);
      if (updated) onUpdated?.(updated);
    } catch {
      onUpdated?.(ticket); // revert on failure
    } finally {
      setSaving(false);
    }
  };

  return (
    <select
      value={ticket.status}
      onChange={handleChange}
      disabled={saving}
      aria-label="Ticket status"
      title="Change ticket status"
      data-testid="ticket-status-select"
      className={`${pe} text-[10px] uppercase tracking-wide bg-gray-800/60 border border-gray-700 rounded px-1.5 py-0.5 text-gray-300 focus:outline-none focus:border-gray-600 disabled:opacity-50 disabled:cursor-not-allowed`}
    >
      {isLegacy ? <option value={ticket.status}>{ticket.status}</option> : null}
      {STATUS_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// Convert-to-card control with an optional "assign an agent now" picker.
// Converting promotes the ticket to a To Do kanban card AND removes the source
// ticket, so the assign choice has to be made at convert time — there's no
// converted ticket to act on afterwards. When an agent is chosen, the new card
// is assigned (which spawns a session) right after it's created.
//
// On full success the ticket is dropped locally via `onConverted` (the server
// also broadcasts support_ticket_deleted for cross-client sync). If the assign
// step fails, conversion still landed the card, but the assignment is treated
// as a FAILED action: we do NOT optimistically remove the ticket/close the
// modal here — instead we keep the inline error visible AND raise a durable
// `onNotify` toast, so the failure can't be swallowed by the control vanishing.
// The server already removed the ticket during conversion, so the
// support_ticket_deleted WebSocket echo reconciles the list; the toast is the
// user-visible record of the partial failure. `stretched` re-enables pointer
// events for use over the card's full-card overlay button.
function ConvertControl({
  projectId,
  ticketId,
  agents = [],
  stretched = false,
  size = 'sm',
  onConverted,
  onNotify,
}) {
  const [agentId, setAgentId] = useState('');
  const [converting, setConverting] = useState(false);
  const [error, setError] = useState(null);
  const pe = stretched ? 'pointer-events-auto relative' : '';
  const btnPad = size === 'md' ? 'px-2.5 py-1.5' : 'px-2 py-1';

  const handleConvert = async () => {
    if (converting) return;
    setConverting(true);
    setError(null);

    let result;
    try {
      result = await api.convertSupportTicketToCard(projectId, ticketId);
    } catch (err) {
      setError(err.message || 'Failed to convert');
      setConverting(false);
      return;
    }

    const cardId = result?.card?.id;
    if (agentId && cardId) {
      try {
        await api.assignCard(projectId, cardId, agentId);
      } catch (err) {
        // Conversion landed the card, but the agent assignment failed. Surface
        // a durable warning and DON'T remove the ticket optimistically — leave
        // the inline error up so the user sees it (and can assign on the board).
        const msg = `Converted to a card, but assigning the agent failed: ${
          err.message || 'unknown error'
        }. You can assign it on the board.`;
        setError(msg);
        setConverting(false);
        onNotify?.(msg, 'warning');
        return;
      }
    }

    // Convert (and assign, if requested) fully succeeded — drop the ticket
    // locally without waiting on the support_ticket_deleted WebSocket echo.
    onConverted?.(ticketId);
  };

  return (
    <span className={`${pe} inline-flex items-center gap-2 flex-wrap`}>
      {agents.length > 0 ? (
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          disabled={converting}
          aria-label="Assign an agent to the new card"
          title="Optionally assign an agent to the new card"
          data-testid="convert-assign-agent"
          className={`${pe} text-xs bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-gray-300 focus:outline-none focus:border-gray-600 disabled:opacity-50`}
        >
          <option value="">No agent</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name || a.id}
            </option>
          ))}
        </select>
      ) : null}
      <button
        onClick={handleConvert}
        disabled={converting}
        title={
          agentId
            ? 'Create a To Do card and assign the chosen agent'
            : 'Create a To Do kanban card from this ticket'
        }
        className={`${pe} inline-flex items-center gap-1.5 text-xs ${btnPad} rounded border border-gray-700 text-gray-300 hover:text-gray-100 hover:border-gray-600 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors`}
      >
        <SquareKanban size={13} />
        {converting ? 'Converting…' : agentId ? 'Convert & assign' : 'Convert to card'}
      </button>
      {error ? <span className="text-[11px] text-red-400">{error}</span> : null}
    </span>
  );
}

function SupportTicketCard({
  ticket,
  projectId,
  agents,
  onOpen,
  onDeleted,
  onConverted,
  onUpdated,
  onNotify,
}) {
  const type = TYPE_META[ticket.type] || TYPE_META.other;
  const { Icon } = type;
  const severityClass = SEVERITY_BADGE[ticket.severity] || SEVERITY_BADGE.low;
  const replayId = ticket.type === 'bug' ? parseReplayIdFromRef(ticket.replay_ref) : null;
  const screenshotUrl = resolveUploadUrl(ticket.screenshot_ref);
  const title = ticket.subject?.trim() || ticket.body?.trim() || '(no subject)';
  // Unread = the server hasn't stamped read_at yet. Drives the visual accent
  // and the dot; opening the ticket flips it (see onOpen in the list).
  const isUnread = !ticket.read_at;

  const [watchingReplay, setWatchingReplay] = useState(false);
  // A ticket is "converted" only for legacy rows that still carry the old
  // converted state — conversion now removes the ticket outright, so this
  // branch is just back-compat for any pre-existing converted row.
  const isConverted = ticket.status === 'converted' || !!ticket.converted_card_id;

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
        data-unread={isUnread ? 'true' : 'false'}
        className={`relative bg-gray-900 border rounded-lg p-4 hover:border-gray-700 transition-colors focus-within:ring-1 focus-within:ring-blue-500/50 ${
          isUnread ? 'border-gray-800 border-l-2 border-l-blue-500' : 'border-gray-800'
        }`}
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
              {isUnread ? (
                <span
                  data-testid="unread-dot"
                  title="Unread"
                  className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0"
                />
              ) : null}
              <span
                className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${severityClass}`}
              >
                {ticket.severity}
              </span>
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">
                {type.label}
              </span>
              <StatusSelect projectId={projectId} ticket={ticket} stretched onUpdated={onUpdated} />
              <span className="text-[11px] text-gray-600 ml-auto">
                {relativeTime(ticket.created_at)}
              </span>
            </div>

            <div
              className={`text-sm mt-1.5 break-words ${
                isUnread ? 'text-gray-50 font-semibold' : 'text-gray-200 font-medium'
              }`}
            >
              {title}
            </div>

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

            {screenshotUrl ? (
              <a
                href={screenshotUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="pointer-events-auto relative block mt-2 w-fit"
                data-testid="ticket-screenshot-thumb"
              >
                <img
                  src={screenshotUrl}
                  alt="Reporter screenshot"
                  className="max-h-32 rounded border border-gray-700 object-contain"
                  loading="lazy"
                />
              </a>
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
                <ConvertControl
                  projectId={projectId}
                  ticketId={ticket.id}
                  agents={agents}
                  stretched
                  onConverted={onConverted}
                  onNotify={onNotify}
                />
              )}
              <DeleteTicketButton
                projectId={projectId}
                ticketId={ticket.id}
                stretched
                onDeleted={() => onDeleted?.(ticket.id)}
              />
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

function SupportTicketDetailModal({
  ticket: liveTicket,
  projectId,
  agents,
  onClose,
  onDeleted,
  onConverted,
  onUpdated,
  onNotify,
}) {
  // Only the *fetched enrichment* is held locally — the complete
  // ai_investigation the list rows truncate to ai_summary. Every other field is
  // read straight from the live `liveTicket` prop (which the parent recomputes
  // from its WebSocket-updated list), so same-ticket updates — status,
  // converted_card_id, refreshed AI fields — propagate into the open modal
  // instead of going stale.
  const [enrichment, setEnrichment] = useState(null);
  const [watchingReplay, setWatchingReplay] = useState(false);

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
  const screenshotUrl = resolveUploadUrl(ticket.screenshot_ref);
  const title = ticket.subject?.trim() || ticket.body?.trim() || '(no subject)';
  const isConverted = ticket.status === 'converted' || !!ticket.converted_card_id;
  const investigation = ticket.ai_investigation?.trim() || ticket.ai_summary?.trim() || null;

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
                {isConverted ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800/60 text-gray-500">
                    {ticket.status}
                  </span>
                ) : (
                  <StatusSelect projectId={projectId} ticket={ticket} onUpdated={onUpdated} />
                )}
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
                <div className="markdown-content text-sm text-gray-300 break-words">
                  <MarkdownContent content={ticket.body} />
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
                <div className="markdown-content text-xs text-gray-300 mt-1.5 break-words">
                  <MarkdownContent content={investigation} />
                </div>
                {ticket.ai_investigated_at ? (
                  <div className="text-[10px] text-gray-600 mt-1.5">
                    Investigated {relativeTime(ticket.ai_investigated_at)}
                  </div>
                ) : null}
              </div>
            ) : null}

            {screenshotUrl ? (
              <div data-testid="detail-screenshot">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-1">
                  Screenshot
                </div>
                <a href={screenshotUrl} target="_blank" rel="noreferrer" className="block w-fit">
                  <img
                    src={screenshotUrl}
                    alt="Reporter screenshot"
                    className="max-h-80 rounded-md border border-gray-700 object-contain"
                  />
                </a>
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
              <ConvertControl
                projectId={projectId}
                ticketId={ticket.id}
                agents={agents}
                size="md"
                onNotify={onNotify}
                onConverted={(id) => {
                  // Full success — drop the ticket from the list and close this
                  // modal (it has nothing left to show). On a partial failure
                  // (assign failed) ConvertControl does NOT call this, so the
                  // modal stays open with the inline error.
                  if (onConverted) onConverted(id);
                  onClose?.();
                }}
              />
            )}
            <div className="ml-auto">
              <DeleteTicketButton
                projectId={projectId}
                ticketId={ticket.id}
                onDeleted={() => {
                  // Drop the row from the parent list; fall back to just
                  // closing the modal if no removal handler was supplied.
                  if (onDeleted) onDeleted(ticket.id);
                  else onClose?.();
                }}
              />
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

function CustomerSupportPageInner({ projectId, agents = [], onNotify }, ref) {
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

  // Flag a loaded row read locally (optimistic) so the unread dot/accent clears
  // the instant the user acts — the server's support_ticket_updated echo
  // confirms it and refreshes the sidebar badge.
  const markReadLocally = (ticketId, readAt) => {
    setTickets((prev) =>
      prev.map((t) => (t.id === ticketId && !t.read_at ? { ...t, read_at: readAt } : t)),
    );
    setOpenTicket((cur) =>
      cur && cur.id === ticketId && !cur.read_at ? { ...cur, read_at: readAt } : cur,
    );
  };

  const markAllReadLocally = () => {
    const stamp = new Date().toISOString();
    setTickets((prev) => prev.map((t) => (t.read_at ? t : { ...t, read_at: stamp })));
    setOpenTicket((cur) => (cur && !cur.read_at ? { ...cur, read_at: stamp } : cur));
  };

  // Open a ticket's detail view and mark it read. Optimistic locally; the POST
  // is fire-and-forget (the WebSocket echo is the source of truth).
  const handleOpenTicket = (ticket) => {
    setOpenTicket(ticket);
    if (ticket && !ticket.read_at) {
      markReadLocally(ticket.id, new Date().toISOString());
      api.markSupportTicketRead(projectId, ticket.id).catch(() => {
        /* best-effort; the badge stays accurate via the next WebSocket event */
      });
    }
  };

  const handleMarkAllRead = () => {
    markAllReadLocally();
    api.markAllSupportTicketsRead(projectId).catch(() => {
      /* best-effort; cross-client sync still arrives via WebSocket */
    });
  };

  const hasUnread = tickets.some((t) => !t.read_at);

  useImperativeHandle(
    ref,
    () => ({
      addTicket: upsertTicket,
      updateTicket: upsertTicket,
      removeTicket,
      // Cross-client read-all: another client (or the sidebar) cleared the
      // queue; flag our loaded rows read without a refetch.
      markAllRead: markAllReadLocally,
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
          {hasUnread ? (
            <button
              onClick={handleMarkAllRead}
              data-testid="mark-all-read"
              title="Mark every request in this project read"
              className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 hover:bg-gray-800 transition-colors mr-1"
            >
              <Check size={12} />
              Mark all read
            </button>
          ) : null}
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
          <div className="p-3 space-y-2 max-w-5xl mx-auto">
            {tickets.map((ticket) => (
              <SupportTicketCard
                key={ticket.id}
                ticket={ticket}
                projectId={projectId}
                agents={agents}
                onOpen={handleOpenTicket}
                onDeleted={removeTicket}
                onConverted={removeTicket}
                onUpdated={upsertTicket}
                onNotify={onNotify}
              />
            ))}
          </div>
        )}
      </div>

      {openTicket ? (
        <SupportTicketDetailModal
          ticket={openTicket}
          projectId={projectId}
          agents={agents}
          onClose={() => setOpenTicket(null)}
          onDeleted={removeTicket}
          onConverted={removeTicket}
          onUpdated={upsertTicket}
          onNotify={onNotify}
        />
      ) : null}
    </div>
  );
}

const CustomerSupportPage = forwardRef(CustomerSupportPageInner);
CustomerSupportPage.displayName = 'CustomerSupportPage';
export default CustomerSupportPage;
export { sortTickets, resolveReplayUrl };
