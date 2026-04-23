import { describe, it, expect } from 'vitest';
import {
  orderedStepsFromWorkflow,
  stepRunMapByStepId,
  buildWorkflowStepDots,
  dotKindForStep,
} from './workflowProgressDots.js';

describe('workflowProgressDots', () => {
  it('orders steps by step_order', () => {
    const wf = {
      steps: [
        { id: 'b', title: 'B', step_order: 2 },
        { id: 'a', title: 'A', step_order: 0 },
      ],
    };
    expect(orderedStepsFromWorkflow(wf).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('builds stepRun map by workflow_step_id', () => {
    const m = stepRunMapByStepId([
      { workflow_step_id: 's1', status: 'running' },
      { workflow_step_id: 's2', status: 'pending' },
    ]);
    expect(m.get('s1')?.status).toBe('running');
    expect(m.get('s2')?.status).toBe('pending');
  });

  it('dotKindForStep respects status and hasRun', () => {
    expect(dotKindForStep(undefined, false)).toBe('inactive');
    expect(dotKindForStep(undefined, true)).toBe('pending');
    expect(dotKindForStep({ status: 'running' }, true)).toBe('running');
    expect(dotKindForStep({ status: 'success' }, true)).toBe('success');
    expect(dotKindForStep({ status: 'error' }, true)).toBe('error');
    expect(dotKindForStep({ status: 'cancelled' }, true)).toBe('cancelled');
    expect(dotKindForStep({ status: 'skipped' }, true)).toBe('skipped');
  });

  it('buildWorkflowStepDots aligns runs with ordered steps', () => {
    const wf = {
      steps: [
        { id: 's1', title: 'One', step_order: 0 },
        { id: 's2', title: 'Two', step_order: 1 },
      ],
    };
    const dots = buildWorkflowStepDots(wf, [{ workflow_step_id: 's1', status: 'success' }], true);
    expect(dots.map((d) => d.kind)).toEqual(['success', 'pending']);
    expect(dots.map((d) => d.title)).toEqual(['One', 'Two']);
  });
});
