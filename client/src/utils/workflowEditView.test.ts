import { describe, it, expect } from 'vitest';
import {
  toWorkflowEditView,
  parseWorkflowEditView,
  WORKFLOW_EDIT_PREFIX,
} from './workflowEditView';

describe('workflowEditView', () => {
  it('round-trips project and workflow ids', () => {
    const v = toWorkflowEditView('proj-1', 'new');
    expect(v.startsWith(WORKFLOW_EDIT_PREFIX)).toBe(true);
    expect(parseWorkflowEditView(v)).toEqual({ projectId: 'proj-1', workflowId: 'new' });
  });

  it('parses uuid workflow id', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const v = toWorkflowEditView('agent-hub', id);
    expect(parseWorkflowEditView(v)).toEqual({ projectId: 'agent-hub', workflowId: id });
  });

  it('returns null for unrelated views', () => {
    expect(parseWorkflowEditView('workflows:p1')).toBeNull();
    expect(parseWorkflowEditView('workflow-edit:noslash')).toBeNull();
    expect(parseWorkflowEditView(null)).toBeNull();
  });
});
