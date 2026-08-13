import { describe, it, expect } from 'vitest';
import { buildAssignedCardSessionContext } from './assign-card-context.js';
import type { KanbanCardRow } from './types.js';

function makeCard(overrides: Partial<KanbanCardRow> = {}): KanbanCardRow {
  return {
    id: 'card-123',
    title: 'Fix the widget',
    description: 'The widget is broken.',
    priority: 'high',
    labels: 'bug',
    github_issue_url: null,
    ...overrides,
  } as KanbanCardRow;
}

describe('buildAssignedCardSessionContext', () => {
  it('includes the card task header, description and links', () => {
    const ctx = buildAssignedCardSessionContext({ card: makeCard(), projectId: 'agent-hub' });
    expect(ctx).toContain('# Task: Fix the widget');
    expect(ctx).toContain('## Description\nThe widget is broken.');
    expect(ctx).toContain('**This session is already linked to kanban card `card-123`.**');
    expect(ctx).toContain('/api/projects/agent-hub/board/cards/card-123/comments');
  });

  it('does NOT encourage spawning follow-up / child cards', () => {
    const ctx = buildAssignedCardSessionContext({ card: makeCard(), projectId: 'agent-hub' });
    expect(ctx).not.toContain('child cards');
    expect(ctx).not.toContain('follow-up');
    expect(ctx).not.toContain('canonical ticket');
    expect(ctx).not.toMatch(/create.*cards? in To Do/i);
  });

  it('threads an assignment note and replay context when present', () => {
    const ctx = buildAssignedCardSessionContext({
      card: makeCard(),
      projectId: 'agent-hub',
      assignmentNote: 'Repro on staging first.',
      replayContext: '## Session replay\nUser clicked X.',
    });
    expect(ctx).toContain('## Assignment Note\nRepro on staging first.');
    expect(ctx).toContain('## Session replay');
  });

  it('omits optional sections when absent', () => {
    const ctx = buildAssignedCardSessionContext({
      card: makeCard({ description: null, labels: null, github_issue_url: null }),
      projectId: 'agent-hub',
    });
    expect(ctx).not.toContain('## Description');
    expect(ctx).not.toContain('**Labels:**');
    expect(ctx).not.toContain('**GitHub:**');
    expect(ctx).not.toContain('## Assignment Note');
  });
});
