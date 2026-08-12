import { describe, it, expect, beforeEach } from 'vitest';

import {
  createSupportTicket,
  getSupportTicket,
  listSupportTickets,
  maskReporterEmail,
  normalizeReporterEmail,
  updateSupportTicketStatus,
  updateSupportTicketType,
  updateSupportTicketSeverity,
  recordSupportTicketInvestigation,
  setSupportTicketReplayRef,
  convertSupportTicketToCard,
  getConvertedCardSummary,
  getConvertedCardSummaries,
  deleteSupportTicket,
  markSupportTicketRead,
  markSupportTicketUnread,
  markAllSupportTicketsRead,
  countUnreadSupportTickets,
  deriveSupportTicketReleaseState,
  markSupportTicketsCustomerNotified,
  markSupportTicketsReleasedToProd,
  SUPPORT_TICKET_SEVERITIES,
} from './support-tickets-store.js';
import { getDb } from './db.js';
import { wipeTables } from './test/destructive-db.js';

// The DB is initialized once by test/setup.ts via AGENT_HUB_DATA_DIR (a fresh
// per-process tmp dir). Wipe support_tickets between tests so rows don't leak
// across cases / files that share the setup DB.
beforeEach(() => {
  // wipeTables enforces the scratch-DB check (server/test/destructive-db.ts).
  wipeTables(getDb(), ['support_tickets']);
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
    expect(t.reporter_email).toBeNull();
    expect(t.replay_ref).toBeNull();
    expect(t.converted_card_id).toBeNull();
    expect(t.ai_investigated_at).toBeNull();
    expect(t.fixed_at).toBeNull();
    expect(t.released_to_prod_at).toBeNull();
    expect(t.release_deployment_id).toBeNull();
    expect(t.customer_notified_at).toBeNull();
    expect(deriveSupportTicketReleaseState(t)).toBeNull();
  });

  it('persists explicit type, severity, subject, reporter, reporterEmail, replayRef', () => {
    const t = createSupportTicket({
      projectId: 'p1',
      type: 'bug',
      severity: 'critical',
      subject: 'Checkout 500',
      body: 'Stripe webhook fails',
      reporter: 'Alice',
      reporterEmail: ' Alice@Example.COM ',
      replayRef: 'replay-abc',
    });
    expect(t.type).toBe('bug');
    expect(t.severity).toBe('critical');
    expect(t.subject).toBe('Checkout 500');
    expect(t.reporter).toBe('Alice');
    expect(t.reporter_email).toBe('alice@example.com');
    expect(t.replay_ref).toBe('replay-abc');
  });

  it('keeps reporterEmail optional for backwards-compatible tickets and rejects invalid emails', () => {
    expect(
      createSupportTicket({ projectId: 'p1', body: 'legacy ticket' }).reporter_email,
    ).toBeNull();
    expect(() =>
      createSupportTicket({ projectId: 'p1', body: 'x', reporterEmail: 'not-an-email' }),
    ).toThrow(/reporter_email must be a valid email address/);
  });

  it('normalizes and masks reporter email values', () => {
    expect(normalizeReporterEmail(' Bob@Example.COM ')).toBe('bob@example.com');
    expect(normalizeReporterEmail('')).toBeNull();
    expect(maskReporterEmail('alice@example.com')).toBe('al***@example.com');
    expect(maskReporterEmail('a@example.com')).toBe('a***@example.com');
    expect(maskReporterEmail(null)).toBeNull();
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

    const investigating = listSupportTickets('p1', { statuses: ['investigating'] });
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

  it('reclassifies a ticket type and rejects an invalid type', () => {
    const t = createSupportTicket({ projectId: 'p1', body: 'b', type: 'question' });
    expect(updateSupportTicketType(t.id, 'feature_request')!.type).toBe('feature_request');
    expect(getSupportTicket(t.id)!.type).toBe('feature_request');

    expect(() => updateSupportTicketType(t.id, 'nope' as never)).toThrow(/type must be one of/);
  });

  it('re-rates a ticket severity and rejects an invalid severity', () => {
    const t = createSupportTicket({ projectId: 'p1', body: 'b', severity: 'low' });
    expect(updateSupportTicketSeverity(t.id, 'critical')!.severity).toBe('critical');
    expect(getSupportTicket(t.id)!.severity).toBe('critical');

    expect(() => updateSupportTicketSeverity(t.id, 'urgent' as never)).toThrow(
      /severity must be one of/,
    );
    expect(getSupportTicket(t.id)!.severity).toBe('critical');
  });

  it('returns null when updating a missing ticket', () => {
    expect(updateSupportTicketStatus('missing', 'closed')).toBeNull();
    expect(updateSupportTicketType('missing', 'bug')).toBeNull();
    expect(updateSupportTicketSeverity('missing', 'high')).toBeNull();
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

  it('derives release-facing state from fixed, released, and notified timestamps', () => {
    const t = createSupportTicket({ projectId: 'p1', body: 'b' });

    const released = markSupportTicketsReleasedToProd({
      projectId: 'p1',
      deploymentId: 'dep-1',
      supportTicketIds: [t.id],
    })[0]!;
    expect(released.fixed_at).toBeTruthy();
    expect(released.released_to_prod_at).toBeTruthy();
    expect(released.release_deployment_id).toBe('dep-1');
    expect(deriveSupportTicketReleaseState(released)).toBe('released_to_prod');

    const notified = markSupportTicketsCustomerNotified([t.id])[0]!;
    expect(notified.customer_notified_at).toBeTruthy();
    expect(deriveSupportTicketReleaseState(notified)).toBe('customer_notified');
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

describe('support-tickets-store — converted card summaries', () => {
  /** Minimal board/column/card rows so the summary join has something to read. */
  function seedCard(id: string, title: string, shortId: number): void {
    const db = getDb();
    db.prepare(
      "INSERT OR IGNORE INTO kanban_boards (id, project_id, name) VALUES ('b-sum', 'p1', 'Board')",
    ).run();
    db.prepare(
      "INSERT OR IGNORE INTO kanban_columns (id, board_id, name, position) VALUES ('col-sum', 'b-sum', 'To Do', 0)",
    ).run();
    db.prepare(
      'INSERT INTO kanban_cards (id, column_id, board_id, title, short_id, position) VALUES (?, ?, ?, ?, ?, 0)',
    ).run(id, 'col-sum', 'b-sum', title, shortId);
  }

  beforeEach(() => {
    wipeTables(getDb(), ['kanban_cards', 'kanban_columns', 'kanban_boards']);
  });

  it('resolves a single card to its board-facing identity', () => {
    seedCard('card-a', 'Cant find linked card', 1768);
    expect(getConvertedCardSummary('card-a')).toEqual({
      id: 'card-a',
      short_id: 1768,
      title: 'Cant find linked card',
      column_name: 'To Do',
    });
    expect(getConvertedCardSummary('card-gone')).toBeNull();
    expect(getConvertedCardSummary(null)).toBeNull();
  });

  it('batches many ids into one keyed map, skipping blanks and missing cards', () => {
    // The batch path is what keeps list responses off an N+1 — every id in the
    // page resolves through this single call.
    seedCard('card-a', 'First', 1);
    seedCard('card-b', 'Second', 2);

    const summaries = getConvertedCardSummaries([
      'card-a',
      'card-b',
      'card-a', // duplicate
      'card-missing',
      null,
      undefined,
      '  ',
    ]);

    expect([...summaries.keys()].sort()).toEqual(['card-a', 'card-b']);
    expect(summaries.get('card-b')).toEqual({
      id: 'card-b',
      short_id: 2,
      title: 'Second',
      column_name: 'To Do',
    });
    expect(getConvertedCardSummaries([]).size).toBe(0);
  });
});
