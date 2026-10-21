// Customer Support queue helpers.
import { getServerBaseUrl } from './config';
// Severity → sort rank (most urgent first). Mirrors the server ORDER BY so
// WebSocket-inserted rows land in the right place without a refetch.
export const SEVERITY_RANK: Record<string, any> = { critical: 0, high: 1, medium: 2, low: 3 };
export const RELEASE_STATE_LABEL: Record<string, any> = {
  fixed_pending_release: 'Fixed, pending release',
  released_to_prod: 'Released',
  customer_notified: 'Customer notified',
};
export function releaseStateLabel(state: any) {
  return state ? RELEASE_STATE_LABEL[state] || String(state) : null;
}
// Sort the queue. Default `mode` is 'priority' — severity (critical → low) then
// newest first, mirroring the server's ORDER BY. `mode: 'date'` ignores severity
// and sorts purely by `created_at` (newest first). The default arg keeps existing
// callers/tests (which pass a single argument) unchanged.
export function sortTickets(list: any, mode: 'priority' | 'date' = 'priority') {
  return [...list].sort((a: any, b: any) => {
    if (mode !== 'date') {
      const sa = SEVERITY_RANK[a.severity] ?? 4;
      const sb = SEVERITY_RANK[b.severity] ?? 4;
      if (sa !== sb) return sa - sb;
    }
    // Newest first (within a severity for priority mode; overall for date
    // mode), matching the server's created_at DESC.
    return (b.created_at || '').localeCompare(a.created_at || '');
  });
}
export function mergeTicketDetail(current: any, detail: any) {
  if (!current || !detail || current.id !== detail.id) return current;
  return { ...current, ...detail };
}
// Resolve a server-stored reference (replay or screenshot) to an openable URL.
// Absolute URLs pass through; server-relative paths (e.g. /uploads/...) are
// prefixed with the server base.
export function resolveUploadUrl(ref: any) {
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref)) return ref;
  const base = getServerBaseUrl();
  if (ref.startsWith('/')) return `${base}${ref}`;
  return `${base}/${ref}`;
}
// Back-compat alias: replay and screenshot refs share the same resolution.
export const resolveReplayUrl = resolveUploadUrl;
// Delete-flow state machine for a support-ticket card, factored out of the RN
// component so vitest can cover the optimistic-removal and error paths without
// mounting the component tree.
//
//   - On a successful DELETE: clear the `deleting` flag and remove the row via
//     `onDeleted(ticketId)` immediately, WITHOUT waiting for the
//     support_ticket_deleted WebSocket echo (a dropped/missed event would
//     otherwise strand a deleted ticket on screen behind a disabled
//     "Deleting…" button). The WebSocket event remains for cross-client sync.
//   - On a failed DELETE: surface the error and re-enable the action by
//     clearing the `deleting` flag, so the user can retry.
//
// `deleteTicket` is injected (the api.deleteSupportTicket wrapper) to keep this
// pure. Returns true when the delete succeeded, false otherwise.
export async function performTicketDelete({
  projectId,
  ticketId,
  deleteTicket,
  setDeleting,
  setDeleteError,
  onDeleted,
}: any) {
  setDeleting(true);
  setDeleteError(null);
  try {
    await deleteTicket(projectId, ticketId);
    // Clear the pending flag first in case the parent keeps this row mounted.
    setDeleting(false);
    onDeleted?.(ticketId);
    return true;
  } catch (err: any) {
    setDeleteError(err?.message || 'Failed to delete');
    setDeleting(false);
    return false;
  }
}
// Convert-flow state machine for a support-ticket card, with the optional
// "assign an agent now" step (mobile parity with the web ConvertControl).
//
// The comment is assignment instructions. With an agent chosen it rides only on
// the /assign call, so a failed assign never leaves it on an unassigned card
// looking like it reached someone. With no agent it is stored as a card note by
// convert.
//
//   - Convert fails: surface the error, re-enable the button.
//   - Convert lands but assign fails: the card exists and the ticket is already
//     converted server-side, so the row will leave the open queue on the WS
//     echo and take the inline error with it. Raise `notify` too, so the
//     partial failure is still seen. `onConverted` is not called.
//   - Full success: hand the converted ticket to `onConverted` right away
//     instead of waiting on the support_ticket_updated echo.
//
// `convertTicket` / `assignCard` are injected api wrappers to keep this pure.
export async function performTicketConvert({
  projectId,
  ticketId,
  agentId,
  autoMerge,
  comment,
  item,
  convertTicket,
  assignCard,
  setConverting,
  setConvertError,
  onConverted,
  notify,
}: any) {
  setConverting(true);
  setConvertError(null);
  const note = typeof comment === 'string' && comment.trim() ? comment.trim() : undefined;
  let res: any;
  try {
    res = await convertTicket(projectId, ticketId, {
      autoMerge,
      comment: agentId ? undefined : note,
    });
  } catch (err: any) {
    setConvertError(err?.message || 'Failed to convert');
    setConverting(false);
    return false;
  }
  const cardId = res?.card?.id;
  if (agentId && cardId) {
    try {
      await assignCard(projectId, cardId, agentId, { autoMerge, comment: note });
    } catch (err: any) {
      const msg = `Converted to a card, but assigning the agent failed: ${
        err?.message || 'unknown error'
      }. You can assign it (and re-add your note) on the board.`;
      setConvertError(msg);
      setConverting(false);
      notify?.(msg);
      return false;
    }
  }
  setConverting(false);
  onConverted?.(res?.ticket ?? { ...item, status: 'converted', converted_card_id: cardId ?? null });
  return true;
}
// Link-flow state machine for a support-ticket card, factored out of the RN
// component (same rationale as performTicketDelete).
//
//   - On a successful link: clear the `linking` flag and update local state via
//     `onConverted(<converted ticket>)` immediately, WITHOUT waiting for the
//     support_ticket_updated WebSocket echo. A delayed/dropped socket would
//     otherwise leave the ticket looking open, letting the operator tap Link
//     again and hit a confusing 409. Mirrors the web path's onConverted call;
//     the WebSocket echo still reconciles other clients.
//   - On a failed link: surface the error and re-enable the action.
//
// The linked ticket handed to onConverted is the server's returned `ticket`
// (already flagged `converted`), falling back to the local row stamped
// converted + converted_card_id when the response omits it. `linkCard` is
// injected (the api.linkSupportTicketToCard wrapper) to keep this pure.
// Pass `sessionId` instead of `cardId` to link through a session.
export async function performTicketLink({
  projectId,
  ticketId,
  cardId,
  sessionId,
  comment,
  item,
  linkCard,
  setLinking,
  setLinkError,
  onConverted,
}: any) {
  setLinking(true);
  setLinkError(null);
  try {
    const res: any = await linkCard(
      projectId,
      ticketId,
      sessionId ? { sessionId, comment } : { cardId, comment },
    );
    setLinking(false);
    const linkedTicket = res?.ticket ?? {
      ...item,
      status: 'converted',
      converted_card_id: res?.card?.id ?? cardId ?? null,
    };
    onConverted?.(linkedTicket);
    return true;
  } catch (err: any) {
    setLinkError(err?.message || 'Failed to link');
    setLinking(false);
    return false;
  }
}

// Flatten a link-targets search response into one pickable list: cards first,
// then sessions (which link through their card, or get one created).
export function linkTargetOptions(targets: any) {
  const out: { kind: 'card' | 'session'; id: string; label: string; detail: string }[] = [];
  for (const c of targets?.cards || []) {
    out.push({
      kind: 'card',
      id: c.id,
      label: `${c.short_id != null ? `#${c.short_id} · ` : ''}${c.title}`,
      detail: c.column_name || '',
    });
  }
  for (const s of targets?.sessions || []) {
    const card =
      s.card_id != null
        ? `card ${s.card_short_id != null ? `#${s.card_short_id}` : 'linked'}`
        : 'no card yet, one will be created';
    out.push({ kind: 'session', id: s.id, label: s.name, detail: `${s.agent_name} · ${card}` });
  }
  return out;
}

// Options for the current query only. Results tagged with an older query are
// dropped so a stale row can't be picked while the replacement search runs.
export function freshLinkTargetOptions(
  results: { query: string; targets: any } | null,
  query: string,
) {
  if (!results || results.query !== query) return [];
  return linkTargetOptions(results.targets);
}
