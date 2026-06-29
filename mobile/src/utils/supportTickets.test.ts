// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import { sortTickets, resolveReplayUrl, resolveUploadUrl, performTicketDelete, releaseStateLabel, } from './supportTickets';
vi.mock('./config', () => ({
    getServerBaseUrl: () => 'https://hub.example.com',
}));
function ticket(o: any) {
    return { id: o.id, severity: o.severity, created_at: o.created_at };
}
describe('sortTickets', () => {
    it('orders by severity (critical → low) then newest first', () => {
        const sorted = sortTickets([
            ticket({ id: 'low', severity: 'low', created_at: '2026-06-14 12:00:00' }),
            ticket({ id: 'crit', severity: 'critical', created_at: '2026-06-14 09:00:00' }),
            ticket({ id: 'high', severity: 'high', created_at: '2026-06-14 11:00:00' }),
            ticket({ id: 'med-old', severity: 'medium', created_at: '2026-06-14 08:00:00' }),
            ticket({ id: 'med-new', severity: 'medium', created_at: '2026-06-14 13:00:00' }),
        ]);
        expect(sorted.map((t: any) => t.id)).toEqual(['crit', 'high', 'med-new', 'med-old', 'low']);
    });
    it('does not mutate the input array', () => {
        const input = [
            ticket({ id: 'a', severity: 'low', created_at: '1' }),
            ticket({ id: 'b', severity: 'critical', created_at: '2' }),
        ];
        sortTickets(input);
        expect(input.map((t: any) => t.id)).toEqual(['a', 'b']);
    });
    it('treats unknown severities as least urgent', () => {
        const sorted = sortTickets([
            ticket({ id: 'weird', severity: 'bogus', created_at: '2' }),
            ticket({ id: 'low', severity: 'low', created_at: '1' }),
        ]);
        expect(sorted.map((t: any) => t.id)).toEqual(['low', 'weird']);
    });
});
describe('resolveReplayUrl', () => {
    it('passes absolute URLs through unchanged', () => {
        expect(resolveReplayUrl('https://x.test/r.json')).toBe('https://x.test/r.json');
        expect(resolveReplayUrl('http://x.test/r.json')).toBe('http://x.test/r.json');
    });
    it('prefixes server-relative paths with the server base', () => {
        expect(resolveReplayUrl('/uploads/r.json')).toBe('https://hub.example.com/uploads/r.json');
        expect(resolveReplayUrl('uploads/r.json')).toBe('https://hub.example.com/uploads/r.json');
    });
    it('returns null for an empty ref', () => {
        expect(resolveReplayUrl(null)).toBe(null);
        expect(resolveReplayUrl('')).toBe(null);
    });
});
describe('resolveUploadUrl', () => {
    it('resolves screenshot refs the same way (and is what resolveReplayUrl aliases)', () => {
        expect(resolveUploadUrl('/uploads/support-screenshot-abc.png')).toBe('https://hub.example.com/uploads/support-screenshot-abc.png');
        expect(resolveUploadUrl('https://cdn.test/shot.png')).toBe('https://cdn.test/shot.png');
        expect(resolveUploadUrl(null)).toBe(null);
        expect(resolveReplayUrl).toBe(resolveUploadUrl);
    });
});
describe('releaseStateLabel', () => {
    it('maps release-facing support-ticket states to compact queue labels', () => {
        expect(releaseStateLabel('fixed_pending_release')).toBe('Fixed, pending release');
        expect(releaseStateLabel('released_to_prod')).toBe('Released');
        expect(releaseStateLabel('customer_notified')).toBe('Customer notified');
    });
    it('returns null for empty state and falls back for forward-compatible states', () => {
        expect(releaseStateLabel(null)).toBeNull();
        expect(releaseStateLabel('future_state')).toBe('future_state');
    });
});
describe('performTicketDelete', () => {
    function makeHarness({ deleteTicket }: any) {
        const calls = { setDeleting: [], setDeleteError: [], onDeleted: [] };
        return {
            args: {
                projectId: 'proj-1',
                ticketId: 'tkt-9',
                deleteTicket,
                setDeleting: (v: any) => calls.setDeleting.push(v),
                setDeleteError: (v: any) => calls.setDeleteError.push(v),
                onDeleted: (id: any) => calls.onDeleted.push(id),
            },
            calls,
        };
    }
    it('on success: removes the row optimistically and clears deleting without a WS event', async () => {
        const deleteTicket = vi.fn().mockResolvedValue(undefined);
        const { args, calls } = makeHarness({ deleteTicket });
        const ok = await performTicketDelete(args);
        expect(ok).toBe(true);
        expect(deleteTicket).toHaveBeenCalledWith('proj-1', 'tkt-9');
        // Spinner turns on then off — the action is re-enabled, not left stuck.
        expect(calls.setDeleting).toEqual([true, false]);
        // Row dropped locally via onDeleted, independent of any WebSocket echo.
        expect(calls.onDeleted).toEqual(['tkt-9']);
        // Error cleared on entry, never set on the happy path.
        expect(calls.setDeleteError).toEqual([null]);
    });
    it('on failure: surfaces the error, re-enables the action, and does NOT remove the row', async () => {
        const deleteTicket = vi.fn().mockRejectedValue(new Error('network boom'));
        const { args, calls } = makeHarness({ deleteTicket });
        const ok = await performTicketDelete(args);
        expect(ok).toBe(false);
        // Spinner turns on then off so the user can retry — never stuck on "Deleting…".
        expect(calls.setDeleting).toEqual([true, false]);
        // Error message surfaced; row left in place (onDeleted not called).
        expect(calls.setDeleteError).toEqual([null, 'network boom']);
        expect(calls.onDeleted).toEqual([]);
    });
    it('falls back to a generic message when the error has none', async () => {
        const deleteTicket = vi.fn().mockRejectedValue({});
        const { args, calls } = makeHarness({ deleteTicket });
        await performTicketDelete(args);
        expect(calls.setDeleteError).toEqual([null, 'Failed to delete']);
        expect(calls.onDeleted).toEqual([]);
    });
    it('tolerates a missing onDeleted callback on success', async () => {
        const deleteTicket = vi.fn().mockResolvedValue(undefined);
        const { args } = makeHarness({ deleteTicket });
        args.onDeleted = undefined;
        await expect(performTicketDelete(args)).resolves.toBe(true);
    });
});
