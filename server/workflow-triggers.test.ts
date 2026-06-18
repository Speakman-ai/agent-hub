import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import {
  resolveCronExpr,
  verifyWorkflowWebhookSignature,
  getCronNextRunPreview,
  kanbanCardTriggerPayload,
} from './workflow-triggers.js';
import type { KanbanCardRow } from './types.js';

describe('workflow-triggers', () => {
  it('resolveCronExpr: preset wins over raw expr', () => {
    expect(resolveCronExpr('every_hour', '0 0 * * *')).toBe('0 * * * *');
  });

  it('resolveCronExpr: uses expr when no matching preset', () => {
    expect(resolveCronExpr(undefined, '15 2 * * *')).toBe('15 2 * * *');
  });

  it('getCronNextRunPreview returns an ISO time for a valid schedule', () => {
    const next = getCronNextRunPreview('0 * * * *');
    expect(next).toBeTruthy();
    if (next) {
      expect(() => new Date(next).toISOString()).not.toThrow();
    }
  });

  it('verifyWorkflowWebhookSignature accepts a matching sha256 HMAC', () => {
    const secret = 'testsecret';
    const body = Buffer.from('{"a":1}', 'utf8');
    const expectedHex = createHmac('sha256', secret).update(body).digest('hex');
    const ok = verifyWorkflowWebhookSignature(body, secret, `sha256=${expectedHex}`);
    expect(ok).toBe(true);
  });

  it('verifyWorkflowWebhookSignature rejects a bad signature', () => {
    const body = Buffer.from('{"a":1}', 'utf8');
    expect(verifyWorkflowWebhookSignature(body, 'a', 'sha256=abc')).toBe(false);
  });

  it('kanbanCardTriggerPayload copies card fields for workflow triggers', () => {
    const card = {
      id: 'c1',
      column_id: 'col1',
      board_id: 'b1',
      title: 'T',
      description: null,
      priority: 'high' as const,
      assignee: null,
      labels: null,
      session_id: null,
      github_issue_url: null,
      pr_url: null,
      review_status: null,
      created_by: null,
      short_id: 1,
      position: 0,
      epic_id: null,
      documented: 0,
      dispatched_by_autonomous: 0,
      assign_model: 'opus',
      created_at: 'x',
      updated_at: 'y',
    } satisfies KanbanCardRow;
    const o = kanbanCardTriggerPayload(card);
    expect(o.id).toBe('c1');
    expect(o.title).toBe('T');
    expect(o.assign_model).toBe('opus');
  });
});
