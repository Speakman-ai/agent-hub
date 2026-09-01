import { useState, useEffect, useMemo, useRef, forwardRef, useImperativeHandle } from 'react';
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
  Mail,
  RefreshCw,
  Link2,
  ThumbsUp,
  ThumbsDown,
  MessageCircle,
} from 'lucide-react';
import { convertedCardId, convertedCardLabel } from '@shared/utils/convertedCardLabel';
import { api } from '../utils/api';
import { getVoterKey, computeOptimisticVote } from '../utils/voting';
import { getServerBase } from '../utils/connection';
import ReplayPlayerModal from './ReplayPlayerModal';
import { parseReplayIdFromRef } from '../utils/replayPlayer';
import { MarkdownContent } from './MarkdownRenderer';

function relativeTime(ts: any) {
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
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as Record<string, any>;

const SEVERITY_BADGE = {
  critical: 'bg-red-500/20 text-red-300 border-red-500/40',
  high: 'bg-orange-500/20 text-orange-300 border-orange-500/40',
  medium: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  low: 'bg-gray-600/30 text-gray-300 border-gray-600/50',
} as Record<string, any>;

const SEVERITY_OPTIONS = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

const TYPE_META = {
  bug: { label: 'Bug', Icon: Bug, className: 'text-rose-400' },
  feature_request: { label: 'Feature request', Icon: Lightbulb, className: 'text-emerald-400' },
  question: { label: 'Question', Icon: HelpCircle, className: 'text-sky-400' },
  incident: { label: 'Incident', Icon: Flame, className: 'text-red-400' },
  other: { label: 'Other', Icon: MessageSquare, className: 'text-gray-400' },
} as Record<string, any>;

// Human labels per lifecycle status. `closed` reads as "Done" (an operator
// resolving a ticket); `converted` is the auto-state a ticket lands in when
// promoted to a card.
const STATUS_LABEL = {
  new: 'New',
  investigating: 'Investigating',
  converted: 'Converted',
  closed: 'Done',
  duplicate: 'Duplicate',
  wont_do: "Won't do",
} as Record<string, any>;

const RELEASE_STATE_LABEL = {
  fixed_pending_release: 'Fixed, pending release',
  released_to_prod: 'Released',
  customer_notified: 'Customer notified',
} as Record<string, any>;

const RELEASE_STATE_BADGE = {
  fixed_pending_release: 'bg-sky-500/10 text-sky-300 border-sky-500/30',
  released_to_prod: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  customer_notified: 'bg-teal-500/10 text-teal-300 border-teal-500/30',
} as Record<string, any>;

const ALL_STATUSES = ['new', 'investigating', 'converted', 'closed', 'duplicate', 'wont_do'];

function reporterText(ticket: any) {
  const parts = [ticket.reporter, ticket.reporter_email].filter(Boolean);
  return parts.length ? `Reported by ${parts.join(' · ')}` : '';
}

function ReleaseStateBadge({ ticket }: { ticket: any }) {
  const state = ticket.release_state;
  if (!state) return null;
  return (
    <span
      data-testid="ticket-release-state"
      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
        RELEASE_STATE_BADGE[state] || RELEASE_STATE_BADGE.fixed_pending_release
      }`}
      title={RELEASE_STATE_LABEL[state] || state}
    >
      {RELEASE_STATE_LABEL[state] || state}
    </span>
  );
}

function notificationRecipientLabel(notification: any) {
  if (notification?.recipient_type === 'reporter') return 'Reporter';
  if (notification?.recipient_type === 'release_digest') return 'Release digest';
  return String(notification?.recipient_type || notification?.notification_type || 'Recipient');
}

function notificationStatusLabel(notification: any) {
  return String(notification?.status || 'pending').replaceAll('_', ' ');
}

function notificationDate(value: any) {
  if (!value) return '';
  const d = String(value).includes('T') ? new Date(value) : new Date(`${value}Z`);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

// Filter groups. The default ("Open") shows only the working states; the
// terminal states each get their own filter so resolved tickets are retained
// but stay out of the way until explicitly requested.
const STATUS_FILTERS = [
  { key: 'open', label: 'Open', statuses: ['new', 'investigating'] },
  { key: 'done', label: 'Done', statuses: ['converted', 'closed'] },
  { key: 'duplicate', label: 'Duplicate', statuses: ['duplicate'] },
  { key: 'wont_do', label: "Won't do", statuses: ['wont_do'] },
  { key: 'all', label: 'All', statuses: ALL_STATUSES },
];

const TYPE_FILTERS = [
  { key: 'all', label: 'All types' },
  { key: 'bug', label: 'Bug' },
  { key: 'feature_request', label: 'Feature' },
  { key: 'question', label: 'Question' },
  { key: 'incident', label: 'Incident' },
  { key: 'other', label: 'Other' },
];

const TYPE_OPTIONS = TYPE_FILTERS.filter((f: any) => f.key !== 'all').map((f: any) => ({
  value: f.key,
  label: f.label,
}));

// Queue ordering toggle. "Priority" is the default (severity first, then newest);
// "Date" ignores severity and orders purely by creation date (newest first).
const SORT_MODES = [
  { key: 'priority', label: 'Priority', title: 'Sort by severity, then newest first' },
  { key: 'date', label: 'Date', title: 'Sort by date only (newest first), ignoring severity' },
] as const;

function pickMainDevAgent(agents: any[]) {
  const active = (agent: any) => agent?.active !== false;
  return (
    agents.find((agent: any) => active(agent) && agent.role === 'lead') ||
    agents.find((agent: any) => active(agent) && agent.role === 'dev') ||
    agents.find(
      (agent: any) =>
        active(agent) &&
        agent.role !== 'docs' &&
        agent.role !== 'reviewer' &&
        agent.role !== 'skill-builder',
    ) ||
    null
  );
}

// Sort the queue. Default `mode` is 'priority' — severity (critical → low) then
// newest first, matching the server's ORDER BY. `mode: 'date'` ignores severity
// entirely and sorts purely by `created_at` (newest first). The default arg
// keeps existing callers/tests (which pass a single argument) unchanged.
function sortTickets(list: any, mode: 'priority' | 'date' = 'priority') {
  return [...list].sort((a: any, b: any) => {
    if (mode !== 'date') {
      const sa = SEVERITY_RANK[a.severity] ?? 4;
      const sb = SEVERITY_RANK[b.severity] ?? 4;
      if (sa !== sb) return sa - sb;
    }
    // Newest first (within a severity for priority mode; overall for date mode),
    // matching the server's created_at DESC.
    return (b.created_at || '').localeCompare(a.created_at || '');
  });
}

// Sort the voting feed: highest score first, ties broken by newest first —
// matching the server's ORDER BY so a WebSocket-patched row lands in the right
// place without a refetch.
function sortVotingItems(list: any[]) {
  return [...list].sort((a: any, b: any) => {
    const sa = Number(a?.voting?.score) || 0;
    const sb = Number(b?.voting?.score) || 0;
    if (sa !== sb) return sb - sa;
    return (b.created_at || '').localeCompare(a.created_at || '');
  });
}

// Resolve a server-stored reference to a clickable URL. Absolute URLs pass
// through; server-relative paths (e.g. an /uploads/... attachment) are prefixed
// with the active server origin so remote-mode clients hit the right host.
function resolveUploadUrl(ref: any) {
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
function DeleteTicketButton({ projectId, ticketId, stretched = false, onDeleted }: any) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<any>(null);
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
    } catch (err: any) {
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
// absent — conversion is an action (it promotes the ticket to a card), not a
// status a human picks from a dropdown. "Won't do" requires a reason, captured
// inline before the change is sent.
const STATUS_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'investigating', label: 'Investigating' },
  { value: 'closed', label: 'Done' },
  { value: 'duplicate', label: 'Duplicate' },
  { value: 'wont_do', label: "Won't do" },
];

// Inline status changer. Replaces the old read-only status badge so an operator
// can move a ticket through its lifecycle (New → Investigating → Closed)
// without leaving the queue. Optimistically reflects the change via `onUpdated`
// (the parent's upsert), then reconciles with the server's returned row; a
// failed PATCH reverts to the original ticket. `stretched` re-enables pointer
// events for use over the card's full-card overlay button.
function StatusSelect({ projectId, ticket, stretched = false, onUpdated }: any) {
  const [saving, setSaving] = useState(false);
  // Non-null while capturing a "won't do" reason (the status isn't committed
  // until the operator supplies one).
  const [reasonDraft, setReasonDraft] = useState<any>(null);
  const pe = stretched ? 'pointer-events-auto relative' : '';
  // A legacy/automatic state (e.g. a `converted` row) isn't in the manual option
  // list — surface it as the current value so the control still renders a
  // sensible label, but don't offer it as a pickable choice.
  const isLegacy = !STATUS_OPTIONS.some((o: any) => o.value === ticket.status);

  const applyStatus = async (next: any, reason: any) => {
    setSaving(true);
    onUpdated?.({
      ...ticket,
      status: next,
      wont_do_reason: next === 'wont_do' ? reason : null,
    }); // optimistic
    try {
      const updated = await api.setSupportTicketStatus(projectId, ticket.id, next, reason);
      if (updated) onUpdated?.(updated);
    } catch {
      onUpdated?.(ticket); // revert on failure
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (e: any) => {
    const next = e.target.value;
    if (next === ticket.status || saving) return;
    // "Won't do" requires a reason — switch to the inline capture form instead
    // of committing immediately.
    if (next === 'wont_do') {
      setReasonDraft(ticket.wont_do_reason || '');
      return;
    }
    applyStatus(next, undefined);
  };

  if (reasonDraft !== null) {
    const submit = async () => {
      const reason = reasonDraft.trim();
      if (!reason || saving) return;
      await applyStatus('wont_do', reason);
      setReasonDraft(null);
    };
    return (
      <span className={`${pe} inline-flex items-center gap-1.5`} data-testid="wont-do-reason-form">
        <input
          autoFocus
          value={reasonDraft}
          onChange={(e: any) => setReasonDraft(e.target.value)}
          onKeyDown={(e: any) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') setReasonDraft(null);
          }}
          placeholder="Why won't this be done?"
          aria-label="Won't do reason"
          data-testid="wont-do-reason-input"
          className={`${pe} text-[11px] bg-gray-800/60 border border-gray-700 rounded px-1.5 py-0.5 text-gray-200 focus:outline-none focus:border-gray-600 w-44`}
        />
        <button
          onClick={submit}
          disabled={saving || !reasonDraft.trim()}
          className={`${pe} text-[11px] px-1.5 py-0.5 rounded border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          Save
        </button>
        <button
          onClick={() => setReasonDraft(null)}
          disabled={saving}
          className={`${pe} text-[11px] px-1.5 py-0.5 rounded border border-gray-700 text-gray-500 hover:text-gray-300 disabled:opacity-50`}
        >
          Cancel
        </button>
      </span>
    );
  }

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
      {isLegacy ? (
        <option value={ticket.status}>{STATUS_LABEL[ticket.status] || ticket.status}</option>
      ) : null}
      {STATUS_OPTIONS.map((o: any) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function TypeSelect({ projectId, ticket, stretched = false, onUpdated }: any) {
  const [saving, setSaving] = useState(false);
  const pe = stretched ? 'pointer-events-auto relative' : '';
  const current = TYPE_OPTIONS.some((o: any) => o.value === ticket.type) ? ticket.type : 'other';

  const handleChange = async (e: any) => {
    const next = e.target.value;
    if (next === ticket.type || saving) return;
    setSaving(true);
    onUpdated?.({ ...ticket, type: next });
    try {
      const updated = await api.setSupportTicketType(projectId, ticket.id, next);
      if (updated) onUpdated?.(updated);
    } catch {
      onUpdated?.(ticket);
    } finally {
      setSaving(false);
    }
  };

  return (
    <select
      value={current}
      onChange={handleChange}
      disabled={saving}
      aria-label="Reclassify ticket"
      title="Reclassify ticket"
      data-testid="ticket-type-select"
      className={`${pe} text-[10px] uppercase tracking-wide bg-gray-800/60 border border-gray-700 rounded px-1.5 py-0.5 text-gray-300 focus:outline-none focus:border-gray-600 disabled:opacity-50 disabled:cursor-not-allowed`}
    >
      {TYPE_OPTIONS.map((o: any) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// Severity picker. Severity is set at intake (by the reporter or the AI triage
// pass) and is often wrong, so it stays operator-editable: it drives the queue
// ordering and the priority a converted kanban card inherits. Rendered with the
// same colour coding as the read-only badge it replaces.
function SeveritySelect({ projectId, ticket, stretched = false, onUpdated }: any) {
  const [saving, setSaving] = useState(false);
  const pe = stretched ? 'pointer-events-auto relative' : '';
  const current = SEVERITY_OPTIONS.some((o: any) => o.value === ticket.severity)
    ? ticket.severity
    : 'low';
  const severityClass = SEVERITY_BADGE[current] || SEVERITY_BADGE.low;

  const handleChange = async (e: any) => {
    const next = e.target.value;
    if (next === ticket.severity || saving) return;
    setSaving(true);
    onUpdated?.({ ...ticket, severity: next });
    try {
      const updated = await api.setSupportTicketSeverity(projectId, ticket.id, next);
      if (updated) onUpdated?.(updated);
    } catch {
      onUpdated?.(ticket);
    } finally {
      setSaving(false);
    }
  };

  return (
    <select
      value={current}
      onChange={handleChange}
      disabled={saving}
      aria-label="Ticket severity"
      title="Change ticket severity"
      data-testid="ticket-severity-select"
      className={`${pe} text-[10px] font-semibold uppercase tracking-wide border rounded px-1.5 py-0.5 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed ${severityClass}`}
    >
      {SEVERITY_OPTIONS.map((o: any) => (
        <option key={o.value} value={o.value} className="bg-gray-900 text-gray-200">
          {o.label}
        </option>
      ))}
    </select>
  );
}

// Small inline note rendering a ticket's "won't do" reason. Shown on the card
// and in the detail modal so the rationale is visible at a glance.
function WontDoReason({ ticket }: any) {
  if (ticket.status !== 'wont_do' || !ticket.wont_do_reason) return null;
  return (
    <div
      data-testid="wont-do-reason"
      className="mt-2 text-[11px] text-gray-400 border-l-2 border-gray-700 pl-2"
    >
      <span className="text-gray-500 font-medium">Won&apos;t do:</span> {ticket.wont_do_reason}
    </div>
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
}: any) {
  const [agentId, setAgentId] = useState('');
  // Tri-state auto-merge: the checkbox shows a boolean, but we only send an
  // explicit preference once the user actually toggles it. Left untouched, the
  // field is omitted so the server falls back to the project's auto-merge
  // default (per the API contract) instead of stamping an explicit `false`.
  const [autoMerge, setAutoMerge] = useState(false);
  const [autoMergeTouched, setAutoMergeTouched] = useState(false);
  const [comment, setComment] = useState('');
  const [converting, setConverting] = useState(false);
  const [error, setError] = useState<any>(null);
  // undefined → omit (use project default); boolean → explicit override.
  const autoMergePref = autoMergeTouched ? autoMerge : undefined;
  const pe = stretched ? 'pointer-events-auto relative' : '';
  const btnPad = size === 'md' ? 'px-2.5 py-1.5' : 'px-2 py-1';

  const handleConvert = async () => {
    if (converting) return;
    setConverting(true);
    setError(null);

    const trimmedComment = comment.trim();
    // The comment is *assignment instructions* for the agent. Where it's
    // attached depends on whether an agent is being assigned now:
    //   - Agent selected → attach it to the /assign call only, so it reaches
    //     the assignee (threaded into their task context + recorded as a card
    //     comment by the assign handler). If /assign fails, the note is never
    //     persisted, so it can't sit on an unassigned card masquerading as
    //     instructions that already reached someone.
    //   - No agent → there's no assignee yet, so persist it as a plain card
    //     note via convert for whoever picks the card up later.
    let result: any;
    try {
      result = await api.convertSupportTicketToCard(projectId, ticketId, {
        autoMerge: autoMergePref,
        comment: agentId ? undefined : trimmedComment || undefined,
      });
    } catch (err: any) {
      setError(err.message || 'Failed to convert');
      setConverting(false);
      return;
    }

    const cardId = result?.card?.id;
    if (agentId && cardId) {
      try {
        // Pass autoMerge so the spawned session's finalize automation level is
        // correct even if it raced the card stamp, and the comment so it lands
        // as an assignment note threaded into the agent's task context.
        await api.assignCard(projectId, cardId, agentId, {
          autoMerge: autoMergePref,
          comment: trimmedComment || undefined,
        });
      } catch (err: any) {
        // Conversion landed the card, but the agent assignment failed. The note
        // was carried in the /assign call, so it was NOT persisted — surface a
        // durable warning telling the user to re-assign (with their note) on
        // the board. DON'T remove the ticket optimistically.
        const msg = `Converted to a card, but assigning the agent failed: ${
          err.message || 'unknown error'
        }. You can assign it (and re-add your note) on the board.`;
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
    <span className={`${pe} inline-flex flex-col gap-1.5 items-start`}>
      <span className="inline-flex items-center gap-2 flex-wrap">
        {agents.length > 0 ? (
          <select
            value={agentId}
            onChange={(e: any) => setAgentId(e.target.value)}
            disabled={converting}
            aria-label="Assign an agent to the new card"
            title="Optionally assign an agent to the new card"
            data-testid="convert-assign-agent"
            className={`${pe} text-xs bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-gray-300 focus:outline-none focus:border-gray-600 disabled:opacity-50`}
          >
            <option value="">No agent</option>
            {agents.map((a: any) => (
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
      </span>
      <label
        className={`${pe} inline-flex items-center gap-1.5 text-[11px] text-gray-400 cursor-pointer select-none`}
        title="Leave unchecked to use the project's auto-merge default. Check to force Auto Merge on the new card — build, review, test, push, and auto-merge."
      >
        <input
          type="checkbox"
          checked={autoMerge}
          onChange={(e: any) => {
            setAutoMerge(e.target.checked);
            setAutoMergeTouched(true);
          }}
          disabled={converting}
          data-testid="convert-auto-merge"
          className={`${pe} h-3 w-3 rounded border-gray-600 bg-gray-950 accent-indigo-500`}
        />
        Auto-merge
      </label>
      <textarea
        value={comment}
        onChange={(e: any) => setComment(e.target.value)}
        disabled={converting}
        rows={2}
        maxLength={4000}
        placeholder="Comments / instructions (optional)"
        aria-label="Comments for the new card"
        data-testid="convert-comment"
        className={`${pe} w-full min-w-[12rem] text-xs bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-600 disabled:opacity-50 resize-y`}
      />
      {error ? <span className="text-[11px] text-red-400">{error}</span> : null}
    </span>
  );
}

// Link-to-existing-card control: the sibling of ConvertControl. Instead of
// creating a fresh card, it attaches the ticket to a card that already exists
// (e.g. the card whose fix already addressed the reported bug). Collapsed until
// the operator opens it, at which point it lazily loads the board's cards into
// a picker. On success the ticket flips to `converted` server-side and leaves
// the open queue, so we reuse the same `onConverted(ticketId)` drop handler.
function LinkToCardControl({
  projectId,
  ticketId,
  stretched = false,
  size = 'sm',
  onConverted,
}: any) {
  const [open, setOpen] = useState(false);
  const [cards, setCards] = useState<any[]>([]);
  const [loadingCards, setLoadingCards] = useState(false);
  const [cardId, setCardId] = useState('');
  const [comment, setComment] = useState('');
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<any>(null);
  const pe = stretched ? 'pointer-events-auto relative' : '';
  const btnPad = size === 'md' ? 'px-2.5 py-1.5' : 'px-2 py-1';

  const loadCards = async () => {
    setLoadingCards(true);
    setError(null);
    try {
      // Pull a generous page per column so the picker covers the whole board.
      const board: any = await api.getBoard(projectId, { limit: 200 });
      const flat: any[] = [];
      for (const col of board?.columns || []) {
        for (const c of col?.cards || []) {
          flat.push({ id: c.id, title: c.title, shortId: c.short_id, column: col.name });
        }
      }
      setCards(flat);
    } catch (err: any) {
      setError(err?.message || 'Failed to load board cards');
    } finally {
      setLoadingCards(false);
    }
  };

  const handleOpen = () => {
    setOpen(true);
    if (!cards.length) void loadCards();
  };

  const handleLink = async () => {
    if (linking || !cardId) return;
    setLinking(true);
    setError(null);
    try {
      await api.linkSupportTicketToCard(projectId, ticketId, {
        cardId,
        comment: comment.trim() || undefined,
      });
    } catch (err: any) {
      setError(err?.message || 'Failed to link');
      setLinking(false);
      return;
    }
    onConverted?.(ticketId);
  };

  if (!open) {
    return (
      <button
        onClick={handleOpen}
        title="Link this ticket to an existing kanban card"
        className={`${pe} inline-flex items-center gap-1.5 text-xs ${btnPad} rounded border border-gray-700 text-gray-300 hover:text-gray-100 hover:border-gray-600 hover:bg-gray-800 transition-colors`}
      >
        <Link2 size={13} />
        Link to card
      </button>
    );
  }

  return (
    <span className={`${pe} inline-flex flex-col gap-1.5 items-start min-w-[14rem]`}>
      <select
        value={cardId}
        onChange={(e: any) => setCardId(e.target.value)}
        disabled={linking || loadingCards}
        aria-label="Existing card to link the ticket to"
        data-testid="link-card-select"
        className={`${pe} w-full text-xs bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-gray-300 focus:outline-none focus:border-gray-600 disabled:opacity-50`}
      >
        <option value="">{loadingCards ? 'Loading cards…' : 'Select a card…'}</option>
        {cards.map((c: any) => (
          <option key={c.id} value={c.id}>
            {c.shortId ? `#${c.shortId} · ` : ''}
            {c.title} ({c.column})
          </option>
        ))}
      </select>
      <textarea
        value={comment}
        onChange={(e: any) => setComment(e.target.value)}
        disabled={linking}
        rows={2}
        maxLength={4000}
        placeholder="Note for the card (optional)"
        aria-label="Note recorded on the linked card"
        data-testid="link-card-comment"
        className={`${pe} w-full text-xs bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-600 disabled:opacity-50 resize-y`}
      />
      <span className="inline-flex items-center gap-2">
        <button
          onClick={handleLink}
          disabled={linking || !cardId}
          data-testid="link-card-submit"
          className={`${pe} inline-flex items-center gap-1.5 text-xs ${btnPad} rounded border border-gray-700 text-gray-300 hover:text-gray-100 hover:border-gray-600 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors`}
        >
          <Link2 size={13} />
          {linking ? 'Linking…' : 'Link'}
        </button>
        <button
          onClick={() => setOpen(false)}
          disabled={linking}
          className={`${pe} text-xs ${btnPad} rounded border border-gray-800 text-gray-500 hover:text-gray-300 disabled:opacity-50`}
        >
          Cancel
        </button>
      </span>
      {error ? <span className="text-[11px] text-red-400">{error}</span> : null}
    </span>
  );
}

/**
 * The "this ticket became a card" affordance. The ticket row only stores an
 * opaque card id, which matches nothing an operator can search for on the
 * board — cards are identified there by `#short_id` and title. So render the
 * card's actual name and make it open that card, falling back to the plain
 * status text when the server couldn't resolve the card (deleted, or an older
 * payload without `converted_card`).
 */
function ConvertedCardLink({ ticket, onOpenCard }: any) {
  const card = ticket?.converted_card;
  const cardId = convertedCardId(ticket);
  const label = convertedCardLabel(ticket);

  if (!label || !cardId || typeof onOpenCard !== 'function') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
        <Check size={13} />
        Converted to card
      </span>
    );
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-emerald-400">
      <Check size={13} className="flex-shrink-0" />
      <span className="flex-shrink-0">Converted to</span>
      <button
        type="button"
        onClick={() => onOpenCard(cardId)}
        title={card.column_name ? `Open card in ${card.column_name}` : 'Open card on the board'}
        data-testid="converted-card-link"
        className="pointer-events-auto relative min-w-0 truncate text-emerald-300 underline decoration-emerald-500/40 underline-offset-2 hover:text-emerald-200"
      >
        {label}
      </button>
    </span>
  );
}

function TicketScreenshot({ src, scrollRoot }: any) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [shouldLoad, setShouldLoad] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (shouldLoad) return;
    const image = imageRef.current;
    if (!image || typeof IntersectionObserver === 'undefined') {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { root: scrollRoot?.current ?? null, rootMargin: '256px 0px' },
    );
    observer.observe(image);
    return () => observer.disconnect();
  }, [scrollRoot, shouldLoad]);

  return (
    <img
      ref={imageRef}
      src={shouldLoad ? src : undefined}
      alt="Reporter screenshot"
      className="h-32 w-48 rounded border border-gray-700 object-contain"
      // Only images near the queue viewport use eager loading. Off-screen
      // tickets do not receive a src until the observer brings them near view.
      loading={shouldLoad ? 'eager' : 'lazy'}
    />
  );
}

function SupportTicketCard({
  ticket,
  projectId,
  agents,
  screenshotRoot,
  onOpen,
  onDeleted,
  onConverted,
  onUpdated,
  onNotify,
  onOpenCard,
}: any) {
  const type = TYPE_META[ticket.type] || TYPE_META.other;
  const { Icon } = type;
  const replayId = ticket.type === 'bug' ? parseReplayIdFromRef(ticket.replay_ref) : null;
  const screenshotUrl = resolveUploadUrl(ticket.screenshot_ref);
  const title = ticket.subject?.trim() || ticket.body?.trim() || '(no subject)';
  // Unread = the server hasn't stamped read_at yet. Drives the visual accent
  // and the dot; opening the ticket flips it (see onOpen in the list).
  const isUnread = !ticket.read_at;
  const reporterLabel = reporterText(ticket);

  const [watchingReplay, setWatchingReplay] = useState(false);
  // A ticket is "converted" only for legacy rows that still carry the old
  // converted state — conversion now removes the ticket outright, so this
  // branch is just back-compat for any pre-existing converted row.
  const isConverted = ticket.status === 'converted' || !!ticket.converted_card_id;

  const handleOpen = () => onOpen?.(ticket);

  // Keep the open control around only non-interactive ticket content. This
  // avoids relying on an invisible overlay button for browser hit testing.
  return (
    <>
      <div
        data-testid="support-ticket-card"
        data-unread={isUnread ? 'true' : 'false'}
        className={`relative bg-gray-900 border rounded-lg p-4 hover:border-gray-700 transition-colors focus-within:ring-1 focus-within:ring-blue-500/50 ${
          isUnread ? 'border-gray-800 border-l-2 border-l-blue-500' : 'border-gray-800'
        }`}
      >
        <div className="flex items-start gap-3">
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
              <SeveritySelect
                projectId={projectId}
                ticket={ticket}
                stretched
                onUpdated={onUpdated}
              />
              <TypeSelect projectId={projectId} ticket={ticket} stretched onUpdated={onUpdated} />
              <StatusSelect projectId={projectId} ticket={ticket} stretched onUpdated={onUpdated} />
              <ReleaseStateBadge ticket={ticket} />
              <span className="text-[11px] text-gray-600 ml-auto">
                {relativeTime(ticket.created_at)}
              </span>
            </div>

            <button
              type="button"
              onClick={handleOpen}
              aria-label={`Open support ticket: ${title}`}
              className={`block w-full text-left text-sm mt-1.5 break-words focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500 rounded ${
                isUnread ? 'text-gray-50 font-semibold' : 'text-gray-200 font-medium'
              }`}
            >
              {/* line-clamp sets display:-webkit-box; keep these spans free of a
                  sibling `block`/`flex` display class or the clamp is silently
                  overridden and the full body renders (grows the card to the
                  whole viewport). */}
              <span className="line-clamp-2 break-words">{title}</span>
              {ticket.subject?.trim() && ticket.body?.trim() ? (
                <span className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-xs font-normal text-gray-500">
                  {ticket.body}
                </span>
              ) : null}
              {reporterLabel ? (
                <span className="block text-[11px] text-gray-600 mt-1.5 font-normal">
                  {reporterLabel}
                </span>
              ) : null}
              {ticket.ai_summary ? (
                <span className="mt-2 flex items-start gap-2 rounded-md bg-violet-500/10 border border-violet-500/20 px-2.5 py-2 font-normal">
                  <Sparkles size={13} className="text-violet-300 flex-shrink-0 mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-[10px] font-semibold uppercase tracking-wide text-violet-300/80">
                      AI investigation
                    </span>
                    <span className="block text-xs text-gray-300 mt-0.5 whitespace-pre-wrap break-words">
                      {ticket.ai_summary}
                    </span>
                  </span>
                </span>
              ) : null}
            </button>

            {screenshotUrl ? (
              <a
                href={screenshotUrl}
                target="_blank"
                rel="noreferrer"
                className="relative block mt-2 w-fit"
                data-testid="ticket-screenshot-thumb"
              >
                <TicketScreenshot src={screenshotUrl} scrollRoot={screenshotRoot} />
              </a>
            ) : null}

            {replayId ? (
              <button
                type="button"
                onClick={() => setWatchingReplay(true)}
                className="relative inline-flex items-center gap-1.5 mt-2 text-xs text-blue-400 hover:text-blue-300"
                data-testid="watch-replay-button"
              >
                <PlayCircle size={13} />
                Watch replay
              </button>
            ) : null}

            <WontDoReason ticket={ticket} />

            <div className="mt-2.5 flex items-center gap-2 flex-wrap">
              {isConverted ? (
                <ConvertedCardLink ticket={ticket} onOpenCard={onOpenCard} />
              ) : (
                <>
                  <ConvertControl
                    projectId={projectId}
                    ticketId={ticket.id}
                    agents={agents}
                    stretched
                    onConverted={onConverted}
                    onNotify={onNotify}
                  />
                  <LinkToCardControl
                    projectId={projectId}
                    ticketId={ticket.id}
                    stretched
                    onConverted={onConverted}
                  />
                </>
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

function TicketInvestigationControl({ projectId, ticket, agents, onUpdated, onNotify }: any) {
  const mainDevAgent = pickMainDevAgent(agents || []);
  const [running, setRunning] = useState(false);

  if (!mainDevAgent) return null;

  const run = async () => {
    if (!mainDevAgent || running) return;
    setRunning(true);
    try {
      const response = await api.runSupportTicketInvestigation(projectId, ticket.id);
      if (response?.ticket) onUpdated?.(response.ticket);
      onNotify?.(`AI investigation queued with ${mainDevAgent.name}`, 'success');
    } catch (err: any) {
      onNotify?.(err?.message || 'Could not start AI investigation', 'error');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      className="rounded-md border border-gray-800 bg-gray-950/50 px-3 py-2.5"
      data-testid="ticket-investigation-control"
    >
      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-2">
        Run AI investigation with {mainDevAgent.name}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={run}
          disabled={running}
          className="inline-flex items-center justify-center rounded border border-violet-500/40 px-2.5 py-1 text-xs text-violet-200 hover:bg-violet-500/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? 'Queueing…' : 'Run'}
        </button>
      </div>
    </div>
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
  onOpenCard,
}: any) {
  // Only the *fetched enrichment* is held locally — the complete
  // ai_investigation the list rows truncate to ai_summary. Every other field is
  // read straight from the live `liveTicket` prop (which the parent recomputes
  // from its WebSocket-updated list), so same-ticket updates — status,
  // converted_card_id, refreshed AI fields — propagate into the open modal
  // instead of going stale.
  const [enrichment, setEnrichment] = useState<any>(null);
  const [watchingReplay, setWatchingReplay] = useState(false);
  const [retryingNotificationId, setRetryingNotificationId] = useState<any>(null);

  // Fetch the full ticket from the dedicated detail endpoint for this id. Reset
  // the enrichment first so a previous ticket's investigation can't bleed
  // through while the new fetch is in flight.
  useEffect(() => {
    let cancelled = false;
    setEnrichment(null);
    api
      .getSupportTicket(projectId, liveTicket.id)
      .then((full: any) => {
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
    const onKey = (e: any) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Merge: the live prop wins for every volatile field; only the AI
  // investigation fields are backfilled from the fetched enrichment (and only
  // when it is for this ticket, guarding an in-flight id change).
  const fetched = enrichment && enrichment.id === liveTicket.id ? enrichment : null;
  const ticket: Record<string, any> = {
    ...liveTicket,
    ai_investigation: fetched?.ai_investigation ?? liveTicket.ai_investigation,
    ai_investigated_at: fetched?.ai_investigated_at ?? liveTicket.ai_investigated_at,
    release_notifications: fetched?.release_notifications ?? liveTicket.release_notifications ?? [],
  };

  const type = TYPE_META[ticket.type] || TYPE_META.other;
  const { Icon } = type;
  const replayId = ticket.type === 'bug' ? parseReplayIdFromRef(ticket.replay_ref) : null;
  const screenshotUrl = resolveUploadUrl(ticket.screenshot_ref);
  const title = ticket.subject?.trim() || ticket.body?.trim() || '(no subject)';
  const isConverted = ticket.status === 'converted' || !!ticket.converted_card_id;
  const investigation = ticket.ai_investigation?.trim() || ticket.ai_summary?.trim() || null;
  const releaseNotifications = ticket.release_notifications || [];

  const retryNotification = async (notification: any) => {
    if (!notification?.id || !notification?.deployment_id || retryingNotificationId) return;
    setRetryingNotificationId(notification.id);
    try {
      const res = await api.retryReleaseNotification(
        projectId,
        notification.deployment_id,
        notification.id,
      );
      const updatedNotification = res?.notification || {
        ...notification,
        status: 'pending',
        error_summary: null,
        can_retry: false,
      };
      const nextNotifications = releaseNotifications.map((item: any) =>
        item.id === notification.id ? updatedNotification : item,
      );
      setEnrichment((cur: any) =>
        cur && cur.id === ticket.id ? { ...cur, release_notifications: nextNotifications } : cur,
      );
      onUpdated?.({ ...ticket, release_notifications: nextNotifications });
      onNotify?.('Release notification queued for retry', 'success');
    } catch (err: any) {
      onNotify?.(err?.message || 'Failed to retry release notification', 'error');
    } finally {
      setRetryingNotificationId(null);
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
          onClick={(e: any) => e.stopPropagation()}
          className="w-full max-w-2xl my-auto rounded-xl border border-gray-800 bg-gray-900 shadow-2xl"
        >
          {/* Header */}
          <div className="flex items-start gap-3 border-b border-gray-800 px-5 py-4">
            <Icon size={18} className={`flex-shrink-0 mt-0.5 ${type.className}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <SeveritySelect projectId={projectId} ticket={ticket} onUpdated={onUpdated} />
                <TypeSelect projectId={projectId} ticket={ticket} onUpdated={onUpdated} />
                {isConverted ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800/60 text-gray-500">
                    {STATUS_LABEL[ticket.status] || ticket.status}
                  </span>
                ) : (
                  <StatusSelect projectId={projectId} ticket={ticket} onUpdated={onUpdated} />
                )}
              </div>
              <h2 className="text-base text-gray-100 font-semibold mt-2 break-words">{title}</h2>
              <div className="text-[11px] text-gray-600 mt-1 flex items-center gap-1.5 flex-wrap">
                <span>Opened {relativeTime(ticket.created_at)}</span>
                {reporterText(ticket) ? <span>· {reporterText(ticket)}</span> : null}
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

            <WontDoReason ticket={ticket} />

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

            <TicketInvestigationControl
              projectId={projectId}
              ticket={ticket}
              agents={agents}
              onUpdated={onUpdated}
              onNotify={onNotify}
            />

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

            <div>
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                <Mail size={12} />
                Notifications
              </div>
              {releaseNotifications.length === 0 ? (
                <div className="rounded-md border border-dashed border-gray-800 p-3 text-xs text-gray-500">
                  No release notifications recorded.
                </div>
              ) : (
                <div className="space-y-2">
                  {releaseNotifications.map((notification: any) => (
                    <div
                      key={notification.id}
                      className="rounded-md border border-gray-800 bg-gray-950/60 p-3"
                    >
                      <div className="flex flex-wrap items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-medium text-gray-200">
                              {notificationRecipientLabel(notification)}
                            </span>
                            <span className="rounded border border-gray-700 bg-gray-800/70 px-1.5 py-0.5 text-[10px] text-gray-300">
                              {notificationStatusLabel(notification)}
                            </span>
                            <span className="text-[11px] text-gray-500">
                              {notification.attempts || 0} attempts
                            </span>
                          </div>
                          <div className="mt-1 truncate text-xs text-gray-400">
                            {notification.subject || 'Release notification'}
                          </div>
                          {notification.sent_at ? (
                            <div className="mt-1 text-[11px] text-gray-500">
                              Sent {notificationDate(notification.sent_at)}
                            </div>
                          ) : null}
                          {notification.error_summary ? (
                            <div className="mt-2 rounded border border-red-500/20 bg-red-500/10 px-2 py-1 text-xs text-red-200">
                              {notification.error_summary}
                            </div>
                          ) : null}
                        </div>
                        {notification.can_retry ? (
                          <button
                            type="button"
                            onClick={() => retryNotification(notification)}
                            disabled={retryingNotificationId === notification.id}
                            className="inline-flex min-h-[28px] items-center gap-1.5 rounded-md border border-gray-700 px-2 text-xs text-gray-300 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <RefreshCw
                              size={12}
                              className={
                                retryingNotificationId === notification.id ? 'animate-spin' : ''
                              }
                            />
                            Retry
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Footer actions */}
          <div className="flex items-center gap-2 flex-wrap border-t border-gray-800 px-5 py-3">
            {isConverted ? (
              <ConvertedCardLink ticket={ticket} onOpenCard={onOpenCard} />
            ) : (
              <>
                <ConvertControl
                  projectId={projectId}
                  ticketId={ticket.id}
                  agents={agents}
                  size="md"
                  onNotify={onNotify}
                  onConverted={(id: any) => {
                    // Full success — drop the ticket from the list and close this
                    // modal (it has nothing left to show). On a partial failure
                    // (assign failed) ConvertControl does NOT call this, so the
                    // modal stays open with the inline error.
                    if (onConverted) onConverted(id);
                    onClose?.();
                  }}
                />
                <LinkToCardControl
                  projectId={projectId}
                  ticketId={ticket.id}
                  size="md"
                  onConverted={(id: any) => {
                    // Linking flips the ticket to converted server-side, so drop
                    // it from the list and close the modal on success.
                    if (onConverted) onConverted(id);
                    onClose?.();
                  }}
                />
              </>
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

// A single votable item: score with up/down controls. The current voter's
// choice (`myVote`) highlights the matching arrow. Votes are optimistic —
// applied locally, then reconciled with the server aggregate (and the
// support_ticket_vote_updated WebSocket echo for cross-client sync).
function VotingItemCard({ item, onVote }: any) {
  const voting = item.voting || { score: 0, upvotes: 0, downvotes: 0, myVote: null };
  const myVote = voting.myVote;
  const commentCount = Number(voting.comment_count) || 0;
  return (
    <div
      data-testid="voting-item"
      data-ticket-id={item.id}
      className="flex items-start gap-3 rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-3"
    >
      {/* Vote control column */}
      <div className="flex flex-col items-center gap-1 flex-shrink-0">
        <button
          type="button"
          data-testid={`vote-up-${item.id}`}
          aria-pressed={myVote === 1}
          aria-label="Upvote"
          onClick={() => onVote(item, 'up')}
          className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
            myVote === 1
              ? 'border-emerald-500/50 bg-emerald-500/20 text-emerald-300'
              : 'border-gray-700 text-gray-500 hover:text-gray-200 hover:border-gray-600'
          }`}
        >
          <ThumbsUp size={14} />
        </button>
        <span
          data-testid={`vote-score-${item.id}`}
          className="text-sm font-semibold tabular-nums text-gray-200"
        >
          {Number(voting.score) || 0}
        </span>
        <button
          type="button"
          data-testid={`vote-down-${item.id}`}
          aria-pressed={myVote === -1}
          aria-label="Downvote"
          onClick={() => onVote(item, 'down')}
          className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
            myVote === -1
              ? 'border-rose-500/50 bg-rose-500/20 text-rose-300'
              : 'border-gray-700 text-gray-500 hover:text-gray-200 hover:border-gray-600'
          }`}
        >
          <ThumbsDown size={14} />
        </button>
      </div>

      {/* Item body */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Lightbulb size={13} className="flex-shrink-0 text-emerald-400" />
          <h3 className="truncate text-sm font-medium text-gray-100">{item.subject}</h3>
        </div>
        {item.body?.trim() ? (
          <p className="mt-1 line-clamp-2 text-xs text-gray-400 break-words">{item.body}</p>
        ) : null}
        <div className="mt-1.5 flex items-center gap-3 text-[11px] text-gray-600">
          <span>Opened {relativeTime(item.created_at)}</span>
          <span className="inline-flex items-center gap-1">
            <MessageCircle size={11} />
            {commentCount}
          </span>
        </div>
      </div>
    </div>
  );
}

// The Voting tab: score-ranked feature requests with anonymous up/down votes.
// Reads the page's project, mints a per-browser voter token, and reconciles
// live from the support_ticket_vote_updated WebSocket event (dispatched by
// App.tsx as an `agenthub-support-ticket-vote` window event).
function VotingTab({ projectId, onNotify }: any) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const voterKey = useMemo(() => getVoterKey(), []);
  // Per-ticket vote queue. Only ONE castVote PUT is ever in flight per ticket:
  // rapid clicks update `desired` (the latest target value) and the in-flight
  // worker resends it once the current request settles. Serializing on the
  // client forces the server to process votes in click order — a client-side
  // revision guard alone can't, because two concurrent PUTs can be applied
  // server-side in reverse, and the WS aggregate can't repair voter-specific
  // `myVote`. `base` snapshots the tally at the batch start for error revert.
  const voteQueueRef = useRef<
    Record<string, { desired: 1 | -1 | null; inFlight: boolean; base: any; lastGood: any }>
  >({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getVotingItems(projectId, voterKey)
      .then((data: any) => {
        if (!cancelled) setItems(sortVotingItems(Array.isArray(data) ? data : []));
      })
      .catch((err: any) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, voterKey]);

  // Patch a single item's tally in place, then re-sort so a score change bumps
  // the row to its new rank without a refetch. `patch` overrides tally fields;
  // untouched fields (e.g. myVote on a cross-client WS echo) are preserved.
  const patchTally = (ticketId: any, patch: any) => {
    setItems((prev: any) =>
      sortVotingItems(
        prev.map((it: any) =>
          it.id === ticketId ? { ...it, voting: { ...it.voting, ...patch } } : it,
        ),
      ),
    );
  };

  // Live cross-client reconcile: the WS event carries score/upvotes/downvotes
  // but not this device's myVote (a peer's vote never changes ours), so we
  // patch only the aggregate and keep the local myVote.
  useEffect(() => {
    const onWsVote = (e: any) => {
      const d = e?.detail;
      if (!d || d.projectId !== projectId || !d.ticketId) return;
      patchTally(d.ticketId, {
        score: Number(d.score) || 0,
        upvotes: Number(d.upvotes) || 0,
        downvotes: Number(d.downvotes) || 0,
      });
    };
    window.addEventListener('agenthub-support-ticket-vote', onWsVote as any);
    return () => window.removeEventListener('agenthub-support-ticket-vote', onWsVote as any);
  }, [projectId]);

  // Drain a ticket's vote queue: send the latest desired value, and if the user
  // changed it while the request was in flight, send again — one request at a
  // time. Reconcile with the authoritative aggregate only once the sent value
  // matches the final desired value, so the UI settles to the true server state.
  const flushVotes = async (ticketId: any) => {
    const st = voteQueueRef.current[ticketId];
    if (!st || st.inFlight) return;
    st.inFlight = true;
    try {
      for (;;) {
        const sentValue = st.desired;
        const aggregate = await api.castVote(projectId, ticketId, voterKey, sentValue);
        // This request WAS applied server-side, so its aggregate is the newest
        // authoritative state — remember it even if we loop to send a newer
        // value. On a later failure this is what we revert to, so a succeeded
        // earlier vote in the batch is never rolled back to the pre-vote guess.
        const applied = {
          score: Number(aggregate?.score) || 0,
          upvotes: Number(aggregate?.upvotes) || 0,
          downvotes: Number(aggregate?.downvotes) || 0,
          myVote: aggregate?.myVote === 1 || aggregate?.myVote === -1 ? aggregate.myVote : null,
        };
        st.lastGood = applied;
        // The user moved on while this was in flight — send the newer value
        // next (the server has already applied `sentValue`, so ordering holds).
        if (st.desired !== sentValue) continue;
        patchTally(ticketId, applied);
        break;
      }
    } catch (err: any) {
      // Trust the server on failure: revert to the last request that DID apply
      // in this batch (authoritative), falling back to the pre-vote snapshot
      // only when nothing succeeded (server never changed).
      const revertTo = st.lastGood ?? st.base;
      if (revertTo) patchTally(ticketId, revertTo);
      onNotify?.(err?.message || 'Could not record your vote', 'error');
    } finally {
      st.inFlight = false;
      st.base = null;
      st.lastGood = null;
    }
  };

  const handleVote = (item: any, direction: 'up' | 'down') => {
    const { value, tally } = computeOptimisticVote(item.voting, direction);
    const existing = voteQueueRef.current[item.id];
    if (existing) {
      existing.desired = value;
    } else {
      voteQueueRef.current[item.id] = {
        desired: value,
        inFlight: false,
        base: null,
        lastGood: null,
      };
    }
    const st = voteQueueRef.current[item.id];
    // Snapshot the pre-vote tally at the start of a fresh batch for error revert.
    if (!st.inFlight && !st.base) st.base = { ...item.voting };
    // Optimistic: apply the computed tally immediately, then drain the queue.
    patchTally(item.id, tally);
    void flushVotes(item.id);
  };

  return (
    <div className="flex-1 overflow-y-auto" data-testid="voting-tab-body">
      {loading ? (
        <div className="flex h-full items-center justify-center text-gray-500">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-gray-300" />
        </div>
      ) : error ? (
        <div className="flex h-full items-center justify-center text-gray-500">
          <div className="text-center">
            <AlertCircle size={32} className="mx-auto mb-2 text-red-400" />
            <p className="text-sm text-red-400">{error}</p>
          </div>
        </div>
      ) : items.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center py-20 text-gray-600">
          <Lightbulb size={36} className="mb-3 text-gray-700" />
          <p className="text-sm">No feature requests to vote on</p>
          <p className="mt-1 text-xs text-gray-700">
            Feature requests appear here, most upvoted first.
          </p>
        </div>
      ) : (
        <div className="mx-auto max-w-5xl space-y-2 p-3">
          {items.map((item: any) => (
            <VotingItemCard key={item.id} item={item} onVote={handleVote} />
          ))}
        </div>
      )}
    </div>
  );
}

function CustomerSupportPageInner(
  { projectId, agents = [], onNotify, initialTicketId, onOpenCard }: any,
  ref: any,
) {
  // Which surface is showing: the issue queue or the score-ranked Voting feed.
  // Both live under the Customer Support page (spec `ui-placement`).
  const [activeTab, setActiveTab] = useState<'issues' | 'voting'>('issues');
  const [tickets, setTickets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  // Default to the "Open" group: terminal tickets (converted/closed/duplicate/
  // wont_do) are retained but hidden until their filter is selected.
  const [statusFilter, setStatusFilter] = useState('open');
  const [typeFilter, setTypeFilter] = useState('all');
  // Queue ordering. 'priority' (default) sorts severity-first then newest;
  // 'date' ignores severity and sorts purely by creation date (newest first).
  const [sortMode, setSortMode] = useState<'priority' | 'date'>('priority');
  // The ticket whose detail modal is open (null = closed), held independently of
  // the filtered list so a status-filter change never drops the modal out from
  // under the user. It's kept fresh by the same WebSocket upsert/remove path
  // that drives the list (see upsertTicket / removeTicket), so it still tracks
  // live updates and closes if the ticket is deleted.
  const [openTicket, setOpenTicket] = useState<any>(null);
  const screenshotScrollRef = useRef<HTMLDivElement | null>(null);

  // Resolve the active filter group to the set of statuses it covers (the API
  // takes a comma-separated list); always send an explicit set so the server's
  // default-open behaviour never surprises the chosen view.
  const activeStatusFilter =
    STATUS_FILTERS.find((f: any) => f.key === statusFilter) || STATUS_FILTERS[0];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .getSupportTickets(
        projectId,
        activeStatusFilter.statuses.join(','),
        typeFilter === 'all' ? undefined : typeFilter,
      )
      .then((data: any) => {
        if (!cancelled) setTickets(sortTickets(Array.isArray(data) ? data : []));
      })
      .catch((err: any) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, statusFilter, typeFilter, activeStatusFilter]);

  // ── WebSocket-driven live updates (pushed from App.jsx via the ref) ──
  const matchesFilter = (ticket: any) =>
    activeStatusFilter.statuses.includes(ticket.status) &&
    (typeFilter === 'all' || ticket.type === typeFilter);

  const upsertTicket = (ticket: any) => {
    if (!ticket) return;
    setTickets((prev: any) => {
      const without = prev.filter((t: any) => t.id !== ticket.id);
      // Respect the active status filter: a status change can move a ticket
      // out of the current view.
      if (!matchesFilter(ticket)) return without;
      return sortTickets([...without, ticket]);
    });
    // Keep the open detail modal in sync even when the update would filter the
    // ticket out of the list — the modal lives until explicitly closed.
    setOpenTicket((cur: any) => (cur && cur.id === ticket.id ? ticket : cur));
  };

  const removeTicket = (ticketId: any) => {
    setTickets((prev: any) => prev.filter((t: any) => t.id !== ticketId));
    // A deleted ticket has nothing to show — close its modal if open.
    setOpenTicket((cur: any) => (cur && cur.id === ticketId ? null : cur));
  };

  // Flag a loaded row read locally (optimistic) so the unread dot/accent clears
  // the instant the user acts — the server's support_ticket_updated echo
  // confirms it and refreshes the sidebar badge.
  const markReadLocally = (ticketId: any, readAt: any) => {
    setTickets((prev: any) =>
      prev.map((t: any) => (t.id === ticketId && !t.read_at ? { ...t, read_at: readAt } : t)),
    );
    setOpenTicket((cur: any) =>
      cur && cur.id === ticketId && !cur.read_at ? { ...cur, read_at: readAt } : cur,
    );
  };

  const markAllReadLocally = () => {
    const stamp = new Date().toISOString();
    setTickets((prev: any) => prev.map((t: any) => (t.read_at ? t : { ...t, read_at: stamp })));
    setOpenTicket((cur: any) => (cur && !cur.read_at ? { ...cur, read_at: stamp } : cur));
  };

  // Open a ticket's detail view and mark it read. Optimistic locally; the POST
  // is fire-and-forget (the WebSocket echo is the source of truth).
  const handleOpenTicket = (ticket: any) => {
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

  const hasUnread = tickets.some((t: any) => !t.read_at);

  // The list is re-sorted for display whenever the sort mode changes. The write
  // paths (load / WebSocket upsert) keep `tickets` in priority order; this memo
  // applies the pure-date ordering on top when the toggle selects it, so
  // switching modes never needs a refetch.
  const sortedTickets = useMemo(() => sortTickets(tickets, sortMode), [tickets, sortMode]);

  // Deep-link focus: when the page is opened with an `initialTicketId` (e.g. a
  // Deployments release-item link), open that ticket's detail on arrival. We
  // fetch it by id rather than scanning the loaded list because the target is
  // often a terminal ticket (e.g. `converted`) that the default "Open" filter
  // hides, so it isn't in `tickets`. Guarded by a ref so closing the modal
  // doesn't immediately reopen it, and so re-renders don't refetch.
  const focusedTicketIdRef = useRef<string | null>(null);
  useEffect(() => {
    const targetId = typeof initialTicketId === 'string' ? initialTicketId.trim() : '';
    if (!targetId || focusedTicketIdRef.current === targetId) return;
    focusedTicketIdRef.current = targetId;
    let cancelled = false;
    api
      .getSupportTicket(projectId, targetId)
      .then((ticket: any) => {
        if (cancelled || !ticket?.id) return;
        handleOpenTicket(ticket);
      })
      .catch((err: any) => {
        if (cancelled) return;
        // Allow a later navigation to retry this same id.
        focusedTicketIdRef.current = null;
        onNotify?.(err?.message || 'Could not open the linked support ticket', 'error');
      });
    return () => {
      cancelled = true;
    };
    // handleOpenTicket is stable enough for this one-shot focus; deps are kept
    // to the deep-link inputs so it fires once per distinct target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTicketId, projectId]);

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
    // statusFilter/typeFilter are read inside upsertTicket (via matchesFilter);
    // rebuild the handle when either changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [statusFilter, typeFilter],
  );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header with status filter */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 bg-gray-900/50">
        <LifeBuoy size={16} className="text-blue-400" />
        <h2 className="text-sm font-medium text-gray-200">Customer Support</h2>
        {/* Issues | Voting tab switcher */}
        <div className="flex items-center gap-0.5 rounded-md border border-gray-800 bg-gray-900/60 p-0.5">
          {[
            { key: 'issues', label: 'Issues' },
            { key: 'voting', label: 'Voting' },
          ].map((t: any) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              data-testid={`support-tab-${t.key}`}
              aria-pressed={activeTab === t.key}
              className={`text-[11px] px-2.5 py-1 rounded transition-colors ${
                activeTab === t.key
                  ? 'bg-gray-700 text-gray-200'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div
          className={`flex items-center gap-1 ml-auto flex-wrap justify-end ${
            activeTab === 'voting' ? 'hidden' : ''
          }`}
        >
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
          {STATUS_FILTERS.map((f: any) => (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              data-testid={`status-filter-${f.key}`}
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

      {activeTab === 'voting' ? (
        <VotingTab projectId={projectId} onNotify={onNotify} />
      ) : (
        <>
          {/* Type filter + sort toggle */}
          <div className="flex items-center gap-1 px-4 py-2 border-b border-gray-800 bg-gray-900/30 flex-wrap">
            <span className="text-[11px] text-gray-600 mr-1">Type</span>
            {TYPE_FILTERS.map((f: any) => (
              <button
                key={f.key}
                onClick={() => setTypeFilter(f.key)}
                data-testid={`type-filter-${f.key}`}
                className={`text-[11px] px-2 py-1 rounded transition-colors ${
                  typeFilter === f.key
                    ? 'bg-gray-700 text-gray-200'
                    : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
                }`}
              >
                {f.label}
              </button>
            ))}
            <div className="flex items-center gap-1 ml-auto">
              <span className="text-[11px] text-gray-600 mr-1">Sort</span>
              {SORT_MODES.map((s: any) => (
                <button
                  key={s.key}
                  onClick={() => setSortMode(s.key)}
                  data-testid={`sort-mode-${s.key}`}
                  title={s.title}
                  className={`text-[11px] px-2 py-1 rounded transition-colors ${
                    sortMode === s.key
                      ? 'bg-gray-700 text-gray-200'
                      : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Body */}
          <div ref={screenshotScrollRef} className="flex-1 overflow-y-auto">
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
                {sortedTickets.map((ticket: any) => (
                  <SupportTicketCard
                    key={ticket.id}
                    ticket={ticket}
                    projectId={projectId}
                    agents={agents}
                    screenshotRoot={screenshotScrollRef}
                    onOpen={handleOpenTicket}
                    onDeleted={removeTicket}
                    onConverted={removeTicket}
                    onUpdated={upsertTicket}
                    onNotify={onNotify}
                    onOpenCard={onOpenCard}
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
              onOpenCard={onOpenCard}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

const CustomerSupportPage = forwardRef(CustomerSupportPageInner);
CustomerSupportPage.displayName = 'CustomerSupportPage';
export default CustomerSupportPage;
export { sortTickets, resolveReplayUrl };
