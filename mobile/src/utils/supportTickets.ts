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
