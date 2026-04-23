import { describe, it, expect } from 'vitest';
import { workflowFromApi, workflowDraftSnapshot, draftToPutBody } from './workflowDraft.js';

describe('workflowDraft', () => {
  it('workflowFromApi maps steps and default payload', () => {
    const d = workflowFromApi({
      id: 'w1',
      name: 'Test',
      trigger_type: 'manual',
      default_payload: { a: 1 },
      steps: [
        { id: 's2', agent_id: 'ag', title: 'B', role_prompt: 'do', step_order: 1 },
        { id: 's1', agent_id: 'ag', title: 'A', role_prompt: 'go', step_order: 0 },
      ],
    });
    expect(d.name).toBe('Test');
    expect(d.trigger_type).toBe('manual');
    expect(d.default_payload_str).toContain('"a"');
    expect(d.default_payload_str).toContain('1');
    expect(d.steps.map((s) => s.title)).toEqual(['A', 'B']);
    expect(d.steps[0].step_order).toBe(0);
    expect(d.steps[1].step_order).toBe(1);
  });

  it('workflowDraftSnapshot is stable for reorder-independent step_order', () => {
    const a = {
      name: 'X',
      trigger_type: 'manual',
      default_payload_str: '{}',
      steps: [
        {
          id: '1',
          agent_id: 'a',
          title: 't',
          role_prompt: 'r',
          step_order: 1,
          timeout_ms: null,
          on_failure: 'abort',
        },
        {
          id: '2',
          agent_id: 'a',
          title: 'u',
          role_prompt: 's',
          step_order: 0,
          timeout_ms: null,
          on_failure: 'abort',
        },
      ],
    };
    const b = { ...a, steps: [...a.steps].reverse() };
    expect(workflowDraftSnapshot(a)).toBe(workflowDraftSnapshot(b));
  });

  it('draftToPutBody maps invalid timeout to null', () => {
    const body = draftToPutBody({
      name: 'X',
      trigger_type: 'manual',
      default_payload_str: '{}',
      kanban_trigger_column_id: '',
      steps: [
        {
          id: 's',
          agent_id: 'a',
          title: 't',
          role_prompt: 'r',
          step_order: 0,
          timeout_ms: 'not-a-number',
          on_failure: 'abort',
        },
      ],
    });
    expect(body.steps[0].timeoutMs).toBe(null);
  });

  it('draftToPutBody includes cron and webhook for automation', () => {
    const body = draftToPutBody({
      name: 'A',
      trigger_type: 'manual',
      default_payload_str: '{}',
      cron_mode: 'every_hour',
      cron_expr: '',
      webhook_enabled: true,
      kanban_trigger_column_id: '',
      steps: [
        {
          id: 's1',
          agent_id: 'ag',
          title: 'S',
          role_prompt: 'r',
          step_order: 0,
          timeout_ms: null,
          on_failure: 'abort',
        },
      ],
    });
    expect(body.cronPreset).toBe('every_hour');
    expect(body.cronExpr).toBeUndefined();
    expect(body.webhookEnabled).toBe(true);
    expect(body.triggerColumnId).toBe(null);
  });

  it('draftToPutBody sends triggerColumnId when kanban column is selected', () => {
    const body = draftToPutBody({
      name: 'K',
      trigger_type: 'manual',
      default_payload_str: '{}',
      cron_mode: 'off',
      cron_expr: '',
      webhook_enabled: false,
      kanban_trigger_column_id: 'col-uuid-1',
      steps: [],
    });
    expect(body.triggerColumnId).toBe('col-uuid-1');
  });

  it('draftToPutBody emits camelCase for API', () => {
    const body = draftToPutBody({
      name: ' N ',
      trigger_type: 'manual',
      default_payload_str: '{"x":true}',
      kanban_trigger_column_id: '',
      steps: [
        {
          id: 'sid',
          agent_id: 'ag1',
          title: 'Step',
          role_prompt: 'Hello',
          step_order: 3,
          timeout_ms: null,
          on_failure: 'continue',
        },
      ],
    });
    expect(body.name).toBe('N');
    expect(body.defaultPayload).toEqual({ x: true });
    expect(body.steps[0]).toMatchObject({
      agentId: 'ag1',
      title: 'Step',
      rolePrompt: 'Hello',
      stepOrder: 0,
      timeoutMs: null,
      onFailure: 'continue',
      id: 'sid',
    });
  });
});
