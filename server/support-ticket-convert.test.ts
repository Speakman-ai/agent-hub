import { describe, it, expect } from 'vitest';
import {
  buildCardFieldsFromTicket,
  severityToPriority,
  SEVERITY_TO_PRIORITY,
} from './support-ticket-convert.js';
import type { SupportTicketRow } from './types.js';

function ticket(overrides: Partial<SupportTicketRow> = {}): SupportTicketRow {
  return {
    id: 'tkt-1234567890',
    project_id: 'p1',
    type: 'bug',
    severity: 'high',
    status: 'new',
    subject: 'Login broken',
    body: 'Users cannot log in after the deploy.',
    reporter: null,
    ai_summary: null,
    ai_investigation: null,
    ai_investigated_at: null,
    replay_ref: null,
    screenshot_ref: null,
    converted_card_id: null,
    wont_do_reason: null,
    read_at: null,
    created_at: '2026-06-14 00:00:00',
    updated_at: '2026-06-14 00:00:00',
    ...overrides,
  };
}

describe('severityToPriority', () => {
  it('maps every severity, critical → urgent', () => {
    expect(SEVERITY_TO_PRIORITY).toEqual({
      critical: 'urgent',
      high: 'high',
      medium: 'medium',
      low: 'low',
    });
    expect(severityToPriority('critical')).toBe('urgent');
    expect(severityToPriority('low')).toBe('low');
  });

  it('falls back to medium for an unknown severity', () => {
    expect(severityToPriority('bogus')).toBe('medium');
  });
});

describe('buildCardFieldsFromTicket', () => {
  it('carries over subject, body, priority and labels', () => {
    const f = buildCardFieldsFromTicket(ticket({ severity: 'critical', type: 'bug' }));
    expect(f.title).toBe('Login broken');
    expect(f.priority).toBe('urgent');
    expect(f.labels).toBe('support,bug');
    expect(f.description).toContain('Users cannot log in after the deploy.');
    expect(f.description).toContain('tkt-1234567890');
  });

  it('falls back to the first body line when there is no subject', () => {
    const f = buildCardFieldsFromTicket(
      ticket({ subject: '', body: '  \n  First real line\nsecond line' }),
    );
    expect(f.title).toBe('First real line');
  });

  it('falls back to a stable placeholder when subject and body are empty', () => {
    const f = buildCardFieldsFromTicket(ticket({ subject: '   ', body: '   ' }));
    expect(f.title).toBe('Support ticket tkt-1234');
    // Description is just the back-link footer when there is no body.
    expect(f.description).toContain('tkt-1234567890');
  });

  it('appends a back-link footer referencing the source ticket', () => {
    const f = buildCardFieldsFromTicket(ticket({ type: 'incident', severity: 'high' }));
    expect(f.description).toMatch(
      /Converted from support ticket `tkt-1234567890` \(incident, high\)\./,
    );
  });

  it('preserves an attached screenshot as a markdown image in the card body', () => {
    const f = buildCardFieldsFromTicket(
      ticket({ screenshot_ref: '/uploads/support-screenshot-abc.png' }),
    );
    expect(f.description).toContain('![screenshot](/uploads/support-screenshot-abc.png)');
  });

  it('omits the screenshot line when no screenshot is attached', () => {
    const f = buildCardFieldsFromTicket(ticket({ screenshot_ref: null }));
    expect(f.description).not.toContain('![screenshot]');
  });
});
