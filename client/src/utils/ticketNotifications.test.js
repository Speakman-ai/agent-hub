import { describe, it, expect } from 'vitest';
import {
  awaitingInputNotification,
  cardStartedNotification,
  cardReviewNotification,
  prMergedNotification,
  prReadyNotification,
  sessionCompleteNotification,
  threadCreatedNotification,
  threadEntryNotification,
} from './ticketNotifications.js';

describe('awaitingInputNotification', () => {
  it('names the agent and session when both are known', () => {
    const result = awaitingInputNotification({
      agentName: 'Hub Lead Dev',
      sessionName: 'Refactor sidebar',
      askCount: 1,
    });
    expect(result.title).toBe('Agent Waiting for You');
    expect(result.body).toBe('Hub Lead Dev — "Refactor sidebar" is waiting on your input');
  });

  it('pluralises when multiple questions are pending', () => {
    const result = awaitingInputNotification({
      agentName: 'Hub Lead Dev',
      sessionName: 'Refactor sidebar',
      askCount: 3,
    });
    expect(result.body).toBe('Hub Lead Dev — "Refactor sidebar" 3 questions need answers');
  });

  it('falls back to a generic body when agent/session are unknown', () => {
    const result = awaitingInputNotification({});
    expect(result.body).toBe('An agent is waiting on your input');
  });
});

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

describe('prReadyNotification', () => {
  it('formats with agent, session, and branch', () => {
    const result = prReadyNotification({
      agentName: 'Hub Frontend',
      sessionName: 'Fix sidebar bug',
      branch: 'feature/sidebar',
    });
    expect(result.title).toBe('Changes Ready — Create PR?');
    expect(result.body).toBe(
      'Hub Frontend — "Fix sidebar bug" has changes on `feature/sidebar` awaiting PR creation',
    );
  });

  it('formats without a branch', () => {
    const result = prReadyNotification({
      agentName: 'Hub Backend',
      sessionName: 'Add route',
    });
    expect(result.title).toBe('Changes Ready — Create PR?');
    expect(result.body).toBe('Hub Backend — "Add route" has changes awaiting PR creation');
  });

  it('formats with only a branch', () => {
    const result = prReadyNotification({ branch: 'feature/x' });
    expect(result.body).toBe('An agent has changes on `feature/x` awaiting PR creation');
  });

  it('falls back when no fields provided', () => {
    const result = prReadyNotification({});
    expect(result.title).toBe('Changes Ready — Create PR?');
    expect(result.body).toBe('An agent has changes awaiting PR creation');
  });
});

describe('sessionCompleteNotification', () => {
  it('formats with agent name, session name, and preview', () => {
    const result = sessionCompleteNotification({
      agentName: 'Hub Frontend',
      sessionName: 'Fix sidebar bug',
      preview: 'I fixed the sidebar overflow issue by adding overflow-hidden.',
    });
    expect(result.title).toBe('Hub Frontend — Done');
    expect(result.body).toBe(
      '"Fix sidebar bug" — I fixed the sidebar overflow issue by adding overflow-hidden.',
    );
  });

  it('formats with only agent name', () => {
    const result = sessionCompleteNotification({ agentName: 'Hub Backend' });
    expect(result.title).toBe('Hub Backend — Done');
    expect(result.body).toBe('Session completed');
  });

  it('formats with agent name and session name only', () => {
    const result = sessionCompleteNotification({
      agentName: 'Hub Frontend',
      sessionName: 'Add notifications',
    });
    expect(result.title).toBe('Hub Frontend — Done');
    expect(result.body).toBe('"Add notifications"');
  });

  it('formats with agent name and preview only', () => {
    const result = sessionCompleteNotification({
      agentName: 'Hub Backend',
      preview: 'Deployed to production successfully.',
    });
    expect(result.title).toBe('Hub Backend — Done');
    expect(result.body).toBe('Deployed to production successfully.');
  });

  it('truncates long previews to last 120 characters', () => {
    const longPreview = 'A'.repeat(80) + 'B'.repeat(120);
    const result = sessionCompleteNotification({
      agentName: 'Agent',
      preview: longPreview,
    });
    expect(result.body).toBe('…' + 'B'.repeat(120));
  });

  it('does not truncate previews at exactly 120 characters', () => {
    const exact = 'B'.repeat(120);
    const result = sessionCompleteNotification({ agentName: 'Agent', preview: exact });
    expect(result.body).toBe(exact);
  });
});

describe('threadCreatedNotification', () => {
  it('formats heartbeat thread', () => {
    const result = threadCreatedNotification({
      threadName: 'Daily Check',
      threadType: 'heartbeat',
    });
    expect(result.title).toBe('Thread Created');
    expect(result.body).toBe('New Heartbeat thread: "Daily Check"');
  });

  it('formats cron thread', () => {
    const result = threadCreatedNotification({
      threadName: 'Dependabot Merge',
      threadType: 'cron',
    });
    expect(result.title).toBe('Thread Created');
    expect(result.body).toBe('New Cron thread: "Dependabot Merge"');
  });
});

describe('threadEntryNotification', () => {
  it('formats a normal entry with preview', () => {
    const result = threadEntryNotification({
      threadName: 'Daily Check',
      threadType: 'heartbeat',
      preview: 'All systems operational',
    });
    expect(result.title).toBe('Heartbeat Update');
    expect(result.body).toBe('Daily Check: All systems operational');
  });

  it('formats an error entry', () => {
    const result = threadEntryNotification({
      threadName: 'Build Runner',
      threadType: 'cron',
      preview: 'ERROR: Build failed',
      isError: true,
    });
    expect(result.title).toBe('Cron Error');
    expect(result.body).toBe('Build Runner: ERROR: Build failed');
  });

  it('falls back when no preview', () => {
    const result = threadEntryNotification({
      threadName: 'Daily Check',
      threadType: 'heartbeat',
    });
    expect(result.body).toBe('New entry in "Daily Check"');
  });

  it('truncates long previews to 120 characters', () => {
    const longPreview = 'X'.repeat(200);
    const result = threadEntryNotification({
      threadName: 'Thread',
      threadType: 'cron',
      preview: longPreview,
    });
    expect(result.body).toBe('Thread: ' + 'X'.repeat(120) + '…');
  });

  it('does not truncate previews at exactly 120 characters', () => {
    const exact = 'Y'.repeat(120);
    const result = threadEntryNotification({
      threadName: 'Thread',
      threadType: 'cron',
      preview: exact,
    });
    expect(result.body).toBe('Thread: ' + exact);
  });
});
