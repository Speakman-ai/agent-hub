import { describe, it, expect } from 'vitest';
import {
  cardStartedNotification,
  cardReviewNotification,
  prMergedNotification,
} from './ticketNotifications.js';

describe('cardStartedNotification', () => {
  it('formats with assignee', () => {
    const result = cardStartedNotification({ cardTitle: 'Add login', assignee: 'hub-frontend' });
    expect(result.title).toBe('Ticket Started');
    expect(result.body).toBe('"Add login" started by hub-frontend');
  });

  it('formats without assignee', () => {
    const result = cardStartedNotification({ cardTitle: 'Fix bug' });
    expect(result.title).toBe('Ticket Started');
    expect(result.body).toBe('"Fix bug" started');
  });

  it('handles empty assignee string', () => {
    const result = cardStartedNotification({ cardTitle: 'Task', assignee: '' });
    expect(result.body).toBe('"Task" started');
  });
});

describe('cardReviewNotification', () => {
  it('formats with assignee', () => {
    const result = cardReviewNotification({ cardTitle: 'Add login', assignee: 'hub-frontend' });
    expect(result.title).toBe('PR Ready for Review');
    expect(result.body).toBe('"Add login" moved to Review (hub-frontend)');
  });

  it('formats without assignee', () => {
    const result = cardReviewNotification({ cardTitle: 'Fix bug' });
    expect(result.title).toBe('PR Ready for Review');
    expect(result.body).toBe('"Fix bug" moved to Review');
  });
});

describe('prMergedNotification', () => {
  it('formats with mergedBy', () => {
    const result = prMergedNotification({
      cardTitle: 'Add login',
      prNumber: 42,
      mergedBy: 'alice',
    });
    expect(result.title).toBe('PR Merged');
    expect(result.body).toBe('PR #42 merged by alice: "Add login"');
  });

  it('formats without mergedBy', () => {
    const result = prMergedNotification({ cardTitle: 'Fix bug', prNumber: 99 });
    expect(result.title).toBe('PR Merged');
    expect(result.body).toBe('PR #99 merged: "Fix bug"');
  });

  it('handles empty mergedBy string', () => {
    const result = prMergedNotification({ cardTitle: 'Task', prNumber: 1, mergedBy: '' });
    expect(result.body).toBe('PR #1 merged: "Task"');
  });
});
