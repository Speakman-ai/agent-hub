import { describe, it, expect } from 'vitest';
import {
  buildWorkflowRunTimeline,
  isWorkflowRunActive,
  isStepTerminalStatus,
} from './workflowRunTimeline';

describe('isWorkflowRunActive', () => {
  it('is true for pending and running', () => {
    expect(isWorkflowRunActive({ status: 'pending' })).toBe(true);
    expect(isWorkflowRunActive({ status: 'running' })).toBe(true);
  });
  it('is false for terminal states', () => {
    expect(isWorkflowRunActive({ status: 'success' })).toBe(false);
    expect(isWorkflowRunActive({ status: 'error' })).toBe(false);
    expect(isWorkflowRunActive(null)).toBe(false);
  });
});

describe('isStepTerminalStatus', () => {
  it('recognizes terminal step statuses', () => {
    expect(isStepTerminalStatus('success')).toBe(true);
    expect(isStepTerminalStatus('error')).toBe(true);
    expect(isStepTerminalStatus('running')).toBe(false);
  });
});

describe('buildWorkflowRunTimeline', () => {
  const wf = {
    steps: [
      { id: 'a', title: 'First', step_order: 0 },
      { id: 'b', title: 'Second', step_order: 1 },
    ],
  };

  it('marks upcoming steps queued while run is active', () => {
    const t = buildWorkflowRunTimeline(
      wf,
      [{ workflow_step_id: 'a', status: 'running', output: null, step_title: 'First' }],
      { status: 'running' },
    );
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0].displayStatus).toBe('running');
    expect(t.rows[1].displayStatus).toBe('queued');
    expect(t.runningRow?.step.id).toBe('a');
    expect(t.completedSteps).toBe(0);
  });

  it('marks future definition steps not_run when run finished early', () => {
    const t = buildWorkflowRunTimeline(
      wf,
      [{ workflow_step_id: 'a', status: 'error', error: 'boom', step_title: 'First' }],
      { status: 'error' },
    );
    expect(t.rows[0].displayStatus).toBe('error');
    expect(t.rows[1].displayStatus).toBe('not_run');
    expect(t.completedSteps).toBe(1);
    expect(t.runningRow).toBeNull();
  });

  it('appends orphan step_runs not in current definition', () => {
    const t = buildWorkflowRunTimeline(
      { steps: [{ id: 'a', title: 'Only', step_order: 0 }] },
      [
        { workflow_step_id: 'a', status: 'success', output: 'ok', step_order: 0 },
        {
          workflow_step_id: 'legacy',
          status: 'success',
          output: 'x',
          step_order: 1,
          step_title: 'Old',
        },
      ],
      { status: 'success' },
    );
    expect(t.rows).toHaveLength(2);
    expect(t.rows[1].orphan).toBe(true);
    expect(t.rows[1].key).toBe('legacy');
    expect(t.completedSteps).toBe(2);
    expect(t.progressPct).toBe(100);
  });
});
