// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import { sortTickets, resolveReplayUrl, resolveUploadUrl, performTicketDelete, performTicketLink, releaseStateLabel, mergeTicketDetail, } from './supportTickets';
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
describe('mergeTicketDetail', () => {
    it('merges detail-only release notifications into the selected support ticket', () => {
        const current = { id: 'tkt-1', subject: 'Bug', release_notifications: undefined };
        const detail = {
            id: 'tkt-1',
            subject: 'Bug',
            release_notifications: [
                {
                    id: 'note-1',
                    status: 'failed',
                    recipient_type: 'reporter',
                    error_summary: 'send_failed',
                    can_retry: true,
                },
            ],
        };
        expect(mergeTicketDetail(current, detail)).toEqual({
            ...current,
            release_notifications: detail.release_notifications,
        });
    });
    it('ignores stale detail responses for a different selected ticket', () => {
        const current = { id: 'tkt-2', subject: 'Current' };
        const detail = { id: 'tkt-1', subject: 'Old', release_notifications: [{ id: 'note-1' }] };
        expect(mergeTicketDetail(current, detail)).toBe(current);
    });
    it('leaves a closed modal empty when a detail response arrives late', () => {
        expect(mergeTicketDetail(null, { id: 'tkt-1' })).toBeNull();
    });
    // The screen reconciles an open detail sheet through this helper on every
    // mutation (optimistic write, server row, rollback), so a re-rated severity
    // has to land on the sheet without blanking the notifications it loaded
    // separately — a PATCH response doesn't carry them.
    it('applies a re-rated severity to the open sheet without dropping loaded detail', () => {
        const selected = {
            id: 'tkt-1',
            severity: 'low',
            release_notifications: [{ id: 'note-1' }],
        };
        const patched = { id: 'tkt-1', severity: 'critical' };
        expect(mergeTicketDetail(selected, patched)).toEqual({
            id: 'tkt-1',
            severity: 'critical',
            release_notifications: [{ id: 'note-1' }],
        });
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

describe('performTicketLink', () => {
    function makeHarness({ linkCard, item }: any) {
        const calls: any = { setLinking: [], setLinkError: [], onConverted: [] };
        return {
            args: {
                projectId: 'proj-1',
                ticketId: 'tkt-9',
                cardId: 'card-3',
                comment: 'already fixed',
                item: item ?? { id: 'tkt-9', status: 'new' },
                linkCard,
                setLinking: (v: any) => calls.setLinking.push(v),
                setLinkError: (v: any) => calls.setLinkError.push(v),
                onConverted: (t: any) => calls.onConverted.push(t),
            },
            calls,
        };
    }
    it('on success: flips the ticket to converted locally without waiting on a WS event', async () => {
        const linkCard = vi.fn().mockResolvedValue({
            linked: true,
            card: { id: 'card-3' },
            ticket: { id: 'tkt-9', status: 'converted', converted_card_id: 'card-3' },
        });
        const { args, calls } = makeHarness({ linkCard });
        const ok = await performTicketLink(args);
        expect(ok).toBe(true);
        expect(linkCard).toHaveBeenCalledWith('proj-1', 'tkt-9', {
            cardId: 'card-3',
            comment: 'already fixed',
        });
        // Spinner on then off — action re-enabled, never stuck on "Linking…".
        expect(calls.setLinking).toEqual([true, false]);
        // Local state updated immediately from the server's converted ticket.
        expect(calls.onConverted).toEqual([
            { id: 'tkt-9', status: 'converted', converted_card_id: 'card-3' },
        ]);
        expect(calls.setLinkError).toEqual([null]);
    });
    it('falls back to stamping the local row converted when the response omits the ticket', async () => {
        const linkCard = vi.fn().mockResolvedValue({ linked: true, card: { id: 'card-7' } });
        const { args, calls } = makeHarness({
            linkCard,
            item: { id: 'tkt-9', status: 'investigating', subject: 'x' },
        });
        await performTicketLink(args);
        // Uses the returned card id, marks the row converted so it leaves the open queue.
        expect(calls.onConverted).toEqual([
            { id: 'tkt-9', status: 'converted', subject: 'x', converted_card_id: 'card-7' },
        ]);
    });
    it('falls back to the requested cardId when neither ticket nor card is returned', async () => {
        const linkCard = vi.fn().mockResolvedValue({});
        const { args, calls } = makeHarness({ linkCard, item: { id: 'tkt-9', status: 'new' } });
        await performTicketLink(args);
        expect(calls.onConverted).toEqual([
            { id: 'tkt-9', status: 'converted', converted_card_id: 'card-3' },
        ]);
    });
    it('on failure: surfaces the error, re-enables the action, and does NOT convert the row', async () => {
        const linkCard = vi.fn().mockRejectedValue(new Error('Card is already linked to another support ticket'));
        const { args, calls } = makeHarness({ linkCard });
        const ok = await performTicketLink(args);
        expect(ok).toBe(false);
        expect(calls.setLinking).toEqual([true, false]);
        expect(calls.setLinkError).toEqual([null, 'Card is already linked to another support ticket']);
        expect(calls.onConverted).toEqual([]);
    });
    it('falls back to a generic message when the error has none', async () => {
        const linkCard = vi.fn().mockRejectedValue({});
        const { args, calls } = makeHarness({ linkCard });
        await performTicketLink(args);
        expect(calls.setLinkError).toEqual([null, 'Failed to link']);
        expect(calls.onConverted).toEqual([]);
    });
    it('tolerates a missing onConverted callback on success', async () => {
        const linkCard = vi.fn().mockResolvedValue({ ticket: { id: 'tkt-9', status: 'converted' } });
        const { args } = makeHarness({ linkCard });
        args.onConverted = undefined;
        await expect(performTicketLink(args)).resolves.toBe(true);
    });
});
