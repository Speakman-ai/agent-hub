import { describe, it, expect } from 'vitest';
import {
  WORKFLOW_TEMPLATE_CATALOG,
  blankWorkflowDraft,
  instantiateWorkflowTemplate,
  getWorkflowTemplateMetaList,
} from './workflowTemplateLibrary.js';

describe('workflowTemplateLibrary', () => {
  it('exports three catalog seeds with stable ids', () => {
    expect(WORKFLOW_TEMPLATE_CATALOG.map((s) => s.id)).toEqual([
      'dev-review',
      'content',
      'onboarding',
    ]);
  });

  it('getWorkflowTemplateMetaList omits draft payloads', () => {
    const meta = getWorkflowTemplateMetaList();
    expect(meta[0]).toEqual({
      id: 'dev-review',
      label: 'Dev Review',
      description: expect.stringContaining('Technical review'),
    });
    expect(meta.every((m) => !('draft' in m))).toBe(true);
  });

  it('instantiateWorkflowTemplate assigns ids and expands <<<n>>> refs', () => {
    const seq = ['id-step-0', 'id-step-1', 'id-step-2'];
    let i = 0;
    const d = instantiateWorkflowTemplate('dev-review', 'agent-1', {
      generateId: () => seq[i++],
    });
    expect(d.name).toBe('Dev Review');
    expect(d.steps).toHaveLength(3);
    expect(d.steps[0].id).toBe('id-step-0');
    expect(d.steps[0].agent_id).toBe('agent-1');
    expect(d.steps[1].role_prompt).toContain('{{steps.id-step-0.output}}');
    expect(d.steps[2].role_prompt).toContain('{{steps.id-step-0.output}}');
    expect(d.steps[2].role_prompt).toContain('{{steps.id-step-1.output}}');
    expect(d.steps[2].role_prompt).not.toContain('<<<');
    expect(JSON.parse(d.default_payload_str)).toMatchObject({ prUrl: '' });
  });

  it('throws for unknown template id', () => {
    expect(() => instantiateWorkflowTemplate('nope', 'a')).toThrow(/Unknown workflow template/);
  });

  it('blankWorkflowDraft matches builder empty shape', () => {
    const b = blankWorkflowDraft();
    expect(b.steps).toEqual([]);
    expect(b.cron_mode).toBe('off');
    expect(b.webhook_enabled).toBe(false);
  });
});
