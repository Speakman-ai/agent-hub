import { describe, expect, it } from 'vitest';
import {
  recipientStatusLabel,
  recipientTypeLabel,
  summarizeRecipientCounts,
  summarizeRecipients,
} from './deployRecipients';

describe('deployRecipients helpers', () => {
  describe('recipientTypeLabel', () => {
    it('labels reporter and release_digest recipients', () => {
      expect(recipientTypeLabel({ recipient_type: 'reporter' })).toBe('Reporter');
      expect(recipientTypeLabel({ recipient_type: 'release_digest' })).toBe('Release digest');
    });

    it('falls back to notification_type then a generic label', () => {
      expect(recipientTypeLabel({ notification_type: 'ticket_release' })).toBe('ticket_release');
      expect(recipientTypeLabel({})).toBe('Recipient');
    });
  });

  describe('recipientStatusLabel', () => {
    it('humanizes underscored statuses and defaults to pending', () => {
      expect(recipientStatusLabel({ status: 'sent' })).toBe('sent');
      expect(recipientStatusLabel({ status: 'next_attempt' })).toBe('next attempt');
      expect(recipientStatusLabel({})).toBe('pending');
    });
  });

  describe('summarizeRecipients', () => {
    it('tallies by delivery status, treating sending/pending as pending', () => {
      const counts = summarizeRecipients([
        { status: 'sent' },
        { status: 'sent' },
        { status: 'error' },
        { status: 'pending' },
        { status: 'sending' },
      ]);
      expect(counts).toEqual({ total: 5, sent: 2, pending: 2, error: 1 });
    });

    it('returns zeroes for empty/nullish input', () => {
      expect(summarizeRecipients([])).toEqual({ total: 0, sent: 0, pending: 0, error: 0 });
      expect(summarizeRecipients(null)).toEqual({ total: 0, sent: 0, pending: 0, error: 0 });
    });
  });

  describe('summarizeRecipientCounts', () => {
    it('builds a one-line summary with pluralization', () => {
      expect(summarizeRecipientCounts([{ status: 'sent' }])).toBe('1 recipient (1 sent)');
      expect(
        summarizeRecipientCounts([{ status: 'sent' }, { status: 'error' }, { status: 'pending' }]),
      ).toBe('3 recipients (1 sent, 1 pending, 1 failed)');
    });

    it('reports nothing recorded for an empty list', () => {
      expect(summarizeRecipientCounts([])).toBe('No recipients recorded');
    });
  });
});
