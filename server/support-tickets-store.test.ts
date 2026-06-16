import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'os';

import {
  createSupportTicket,
  getSupportTicket,
  listSupportTickets,
  updateSupportTicketStatus,
  recordSupportTicketInvestigation,
  setSupportTicketReplayRef,
  convertSupportTicketToCard,
  deleteSupportTicket,
  markSupportTicketRead,
  markSupportTicketUnread,
  markAllSupportTicketsRead,
  countUnreadSupportTickets,
  SUPPORT_TICKET_SEVERITIES,
} from './support-tickets-store.js';
import { getDb } from './db.js';

// The DB is initialized once by test/setup.ts via AGENT_HUB_DATA_DIR (a fresh
// per-process tmp dir). Wipe support_tickets between tests so rows don't leak
// across cases / files that share the setup DB.
beforeEach(() => {
  const db = getDb();
  // Last line of defence against ever wiping a non-test DB.
  if (!db.name.startsWith(tmpdir())) {
    throw new Error(`Refusing to wipe support_tickets in non-tmp DB at ${db.name}`);
  }
  db.exec('DELETE FROM support_tickets;');
});

/** Force a deterministic created_at so DESC tiebreaks are testable. */
function backdate(id: string, isoSeconds: string): void {
  getDb().prepare('UPDATE support_tickets SET created_at = ? WHERE id = ?').run(isoSeconds, id);
}

describe('support-tickets-store — create', () => {
  it('creates a ticket with sane defaults and status new', () => {
    const t = createSupportTicket({ projectId: 'p1', body: 'login is broken' });
    expect(t.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.project_id).toBe('p1');
    expect(t.type).toBe('other');
    expect(t.severity).toBe('medium');
    expect(t.status).toBe('new');
    expect(t.body).toBe('login is broken');
    expect(t.reporter).toBeNull();
    expect(t.replay_ref).toBeNull();
    expect(t.converted_card_id).toBeNull();
    expect(t.ai_investigated_at).toBeNull();
  });

  it('persists explicit type, severity, subject, reporter, replayRef', () => {
    const t = createSupportTicket({
      projectId: 'p1',
      type: 'bug',
      severity: 'critical',
      subject: 'Checkout 500',
      body: 'Stripe webhook fails',
      reporter: 'alice@example.com',
      replayRef: 'replay-abc',
    });
    expect(t.type).toBe('bug');
    expect(t.severity).toBe('critical');
    expect(t.subject).toBe('Checkout 500');
    expect(t.reporter).toBe('alice@example.com');
    expect(t.replay_ref).toBe('replay-abc');
  });

  it('rejects an empty body', () => {
    expect(() => createSupportTicket({ projectId: 'p1', body: '   ' })).toThrow(/body is required/);
  });

  it('rejects an invalid type or severity', () => {
    expect(() =>
      createSupportTicket({ projectId: 'p1', body: 'x', type: 'nope' as never }),
    ).toThrow(/type must be one of/);
    expect(() =>
      createSupportTicket({ projectId: 'p1', body: 'x', severity: 'sev0' as never }),
    ).toThrow(/severity must be one of/);
  });
});

describe('support-tickets-store — list ordering by severity', () => {
  it('orders tickets critical → high → medium → low', () => {
    // Insert in scrambled order.
    createSupportTicket({ projectId: 'p1', body: 'b', severity: 'low' });
    createSupportTicket({ projectId: 'p1', body: 'b', severity: 'critical' });
    createSupportTicket({ projectId: 'p1', body: 'b', severity: 'medium' });
    createSupportTicket({ projectId: 'p1', body: 'b', severity: 'high' });

    const ordered = listSupportTickets('p1').map((t) => t.severity);
    expect(ordered).toEqual(['critical', 'high', 'medium', 'low']);
  });

  it('covers every defined severity rank deterministically', () => {
    for (const sev of [...SUPPORT_TICKET_SEVERITIES].reverse()) {
      createSupportTicket({ projectId: 'p1', body: 'b', severity: sev });
    }
    expect(listSupportTickets('p1').map((t) => t.severity)).toEqual([
      'critical',
      'high',
      'medium',
      'low',
    ]);
  });

  it('breaks severity ties by newest created_at first', () => {
    const older = createSupportTicket({ projectId: 'p1', body: 'older', severity: 'high' });
    const newer = createSupportTicket({ projectId: 'p1', body: 'newer', severity: 'high' });
    backdate(older.id, '2026-01-01 00:00:00');
    backdate(newer.id, '2026-06-01 00:00:00');

    const ids = listSupportTickets('p1').map((t) => t.id);
    expect(ids).toEqual([newer.id, older.id]);
  });

  it('deterministically orders same-severity, same-second tickets newest-insert first', () => {
    // No backdating: these rows share a created_at second, so created_at alone
    // can't order them — the rowid tie-breaker must return newest-insert first.
    const first = createSupportTicket({ projectId: 'p1', body: '1', severity: 'medium' });
    const second = createSupportTicket({ projectId: 'p1', body: '2', severity: 'medium' });
    const third = createSupportTicket({ projectId: 'p1', body: '3', severity: 'medium' });
    // Force an identical created_at so only the tie-breaker can decide order.
    for (const t of [first, second, third]) backdate(t.id, '2026-03-03 03:03:03');

    const ids = listSupportTickets('p1').map((t) => t.id);
    expect(ids).toEqual([third.id, second.id, first.id]);
  });

  it('scopes the list to a single project', () => {
    createSupportTicket({ projectId: 'p1', body: 'mine', severity: 'high' });
    createSupportTicket({ projectId: 'p2', body: 'theirs', severity: 'critical' });

    const p1 = listSupportTickets('p1');
    expect(p1).toHaveLength(1);
    expect(p1[0]!.body).toBe('mine');
  });

  it('filters by status while preserving severity ordering', () => {
    const a = createSupportTicket({ projectId: 'p1', body: 'a', severity: 'low' });
    createSupportTicket({ projectId: 'p1', body: 'b', severity: 'critical' });
    const c = createSupportTicket({ projectId: 'p1', body: 'c', severity: 'high' });
    updateSupportTicketStatus(a.id, 'investigating');
    updateSupportTicketStatus(c.id, 'investigating');

    const investigating = listSupportTickets('p1', { status: 'investigating' });
    expect(investigating.map((t) => t.severity)).toEqual(['high', 'low']);
  });
});

describe('support-tickets-store — lifecycle & mutations', () => {
  it('transitions status through the support lifecycle', () => {
    const t = createSupportTicket({ projectId: 'p1', body: 'b' });
    expect(updateSupportTicketStatus(t.id, 'investigating')!.status).toBe('investigating');
    expect(updateSupportTicketStatus(t.id, 'closed')!.status).toBe('closed');
  });

  it('rejects an invalid status transition', () => {
    const t = createSupportTicket({ projectId: 'p1', body: 'b' });
    expect(() => updateSupportTicketStatus(t.id, 'done' as never)).toThrow(/status must be one of/);
  });

  it('returns null when updating a missing ticket', () => {
    expect(updateSupportTicketStatus('missing', 'closed')).toBeNull();
  });

  it('records an AI investigation and stamps ai_investigated_at', () => {
    const t = createSupportTicket({ projectId: 'p1', body: 'b' });
    const updated = recordSupportTicketInvestigation(t.id, {
      summary: 'Likely a webhook signature mismatch',
      details: '{"root_cause":"clock skew"}',
    })!;
    expect(updated.ai_summary).toBe('Likely a webhook signature mismatch');
    expect(updated.ai_investigation).toBe('{"root_cause":"clock skew"}');
    expect(updated.ai_investigated_at).not.toBeNull();
  });

  it('partially updates the investigation: omitted fields are preserved, null clears', () => {
    const t = createSupportTicket({ projectId: 'p1', body: 'b' });
    recordSupportTicketInvestigation(t.id, { summary: 's1', details: 'd1' });

    // Sending only summary must NOT wipe the existing details.
    const afterSummary = recordSupportTicketInvestigation(t.id, { summary: 's2' })!;
    expect(afterSummary.ai_summary).toBe('s2');
    expect(afterSummary.ai_investigation).toBe('d1');

    // Sending only details must NOT wipe the existing summary.
    const afterDetails = recordSupportTicketInvestigation(t.id, { details: 'd2' })!;
    expect(afterDetails.ai_summary).toBe('s2');
    expect(afterDetails.ai_investigation).toBe('d2');

    // An explicit null is the clear signal.
    const cleared = recordSupportTicketInvestigation(t.id, { summary: null })!;
    expect(cleared.ai_summary).toBeNull();
    expect(cleared.ai_investigation).toBe('d2');
  });

  it('attaches a replay reference', () => {
    const t = createSupportTicket({ projectId: 'p1', body: 'b' });
    expect(setSupportTicketReplayRef(t.id, 'replay-xyz')!.replay_ref).toBe('replay-xyz');
    expect(setSupportTicketReplayRef(t.id, null)!.replay_ref).toBeNull();
  });

  it('converts a ticket to a kanban card and flips status to converted', () => {
    const t = createSupportTicket({ projectId: 'p1', body: 'b' });
    const converted = convertSupportTicketToCard(t.id, 'card-123')!;
    expect(converted.converted_card_id).toBe('card-123');
    expect(converted.status).toBe('converted');
  });

  it('deletes a ticket and reports whether a row was removed', () => {
    const t = createSupportTicket({ projectId: 'p1', body: 'b' });
    expect(deleteSupportTicket(t.id)).toBe(true);
    expect(getSupportTicket(t.id)).toBeNull();
    expect(deleteSupportTicket(t.id)).toBe(false);
  });
});

describe('support-tickets-store — read/unread', () => {
  it('new tickets are unread (read_at null) and count as unread', () => {
    const t = createSupportTicket({ projectId: 'p1', body: 'b' });
    expect(t.read_at).toBeNull();
    expect(countUnreadSupportTickets('p1')).toBe(1);
  });

  it('markSupportTicketRead stamps read_at and is idempotent', () => {
    const t = createSupportTicket({ projectId: 'p1', body: 'b' });
    const read = markSupportTicketRead(t.id)!;
    expect(read.read_at).not.toBeNull();
    expect(countUnreadSupportTickets('p1')).toBe(0);

    // Re-reading does not change the original timestamp.
    const again = markSupportTicketRead(t.id)!;
    expect(again.read_at).toBe(read.read_at);
  });

  it('markSupportTicketUnread clears read_at', () => {
    const t = createSupportTicket({ projectId: 'p1', body: 'b' });
    markSupportTicketRead(t.id);
    const unread = markSupportTicketUnread(t.id)!;
    expect(unread.read_at).toBeNull();
    expect(countUnreadSupportTickets('p1')).toBe(1);
  });

  it('mark helpers return null for an unknown ticket', () => {
    expect(markSupportTicketRead('nope')).toBeNull();
    expect(markSupportTicketUnread('nope')).toBeNull();
  });

  it('markAllSupportTicketsRead clears the project and returns the marked count', () => {
    createSupportTicket({ projectId: 'p1', body: 'a' });
    createSupportTicket({ projectId: 'p1', body: 'b' });
    const other = createSupportTicket({ projectId: 'p2', body: 'c' });

    expect(markAllSupportTicketsRead('p1')).toBe(2);
    expect(countUnreadSupportTickets('p1')).toBe(0);
    // A second pass marks nothing.
    expect(markAllSupportTicketsRead('p1')).toBe(0);
    // Other projects are untouched.
    expect(countUnreadSupportTickets('p2')).toBe(1);
    expect(getSupportTicket(other.id)!.read_at).toBeNull();
  });

  it('counts unread per project independently', () => {
    createSupportTicket({ projectId: 'p1', body: 'a' });
    const b = createSupportTicket({ projectId: 'p1', body: 'b' });
    createSupportTicket({ projectId: 'p2', body: 'c' });

    markSupportTicketRead(b.id);
    expect(countUnreadSupportTickets('p1')).toBe(1);
    expect(countUnreadSupportTickets('p2')).toBe(1);
    expect(countUnreadSupportTickets('p3')).toBe(0);
  });
});
