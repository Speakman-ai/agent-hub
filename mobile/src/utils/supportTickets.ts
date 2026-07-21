// Pure helpers for the Customer Support queue, factored out of the screen so
// they're unit-testable without pulling in react-native.
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
export function sortTickets(list: any) {
    return [...list].sort((a: any, b: any) => {
        const sa = SEVERITY_RANK[a.severity] ?? 4;
        const sb = SEVERITY_RANK[b.severity] ?? 4;
        if (sa !== sb)
            return sa - sb;
        // Newest first within a severity, matching the server's created_at DESC.
        return (b.created_at || '').localeCompare(a.created_at || '');
    });
}
export function mergeTicketDetail(current: any, detail: any) {
    if (!current || !detail || current.id !== detail.id)
        return current;
    return { ...current, ...detail };
}
// Resolve a server-stored reference (replay or screenshot) to an openable URL.
// Absolute URLs pass through; server-relative paths (e.g. /uploads/...) are
// prefixed with the server base.
export function resolveUploadUrl(ref: any) {
    if (!ref)
        return null;
    if (/^https?:\/\//i.test(ref))
        return ref;
    const base = getServerBaseUrl();
    if (ref.startsWith('/'))
        return `${base}${ref}`;
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
export async function performTicketDelete({ projectId, ticketId, deleteTicket, setDeleting, setDeleteError, onDeleted, }: any) {
    setDeleting(true);
    setDeleteError(null);
    try {
        await deleteTicket(projectId, ticketId);
        // Clear the pending flag first in case the parent keeps this row mounted.
        setDeleting(false);
        onDeleted?.(ticketId);
        return true;
    }
    catch (err: any) {
        setDeleteError(err?.message || 'Failed to delete');
        setDeleting(false);
        return false;
    }
}
// Link-flow state machine for a support-ticket card, factored out of the RN
// component (same rationale as performTicketDelete) so the success-path local
// state update is unit-testable without mounting the tree.
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
export async function performTicketLink({ projectId, ticketId, cardId, comment, item, linkCard, setLinking, setLinkError, onConverted, }: any) {
    setLinking(true);
    setLinkError(null);
    try {
        const res: any = await linkCard(projectId, ticketId, { cardId, comment });
        setLinking(false);
        const linkedTicket = res?.ticket ?? {
            ...item,
            status: 'converted',
            converted_card_id: res?.card?.id ?? cardId,
        };
        onConverted?.(linkedTicket);
        return true;
    }
    catch (err: any) {
        setLinkError(err?.message || 'Failed to link');
        setLinking(false);
        return false;
    }
}
