import { describe, expect, it } from 'vitest';
import {
  answerErrorMessage,
  approvalIdFromNotification,
  describeApproval,
  formatApprovalExpiry,
  groupApprovalRules,
  pushActionDecision,
  pushCategoryIdFor,
  reconcilePendingApprovals,
  sortPendingApprovals,
  withoutApproval,
  type ApprovalRuleWire,
  type ApprovalWire,
} from './approvals';

function approval(id: string, over: Partial<ApprovalWire> = {}): ApprovalWire {
  return {
    id,
    sessionId: 's1',
    agentId: 'a1',
    projectId: 'p1',
    action: 'send',
    target: 'email to ann',
    domain: 'mail.example.com',
    details: '',
    status: 'pending',
    resolution: null,
    ruleId: null,
    canRemember: true,
    requestedAt: 1,
    expiresAt: 2,
    resolvedAt: null,
    ...over,
  };
}

function rule(id: string, profileId: string, domain: string, action = 'send'): ApprovalRuleWire {
  return {
    id,
    profileId,
    userId: 'u1',
    domain,
    action,
    effect: 'allow',
    sourceRequestId: null,
    createdAt: '2026-10-15 00:00:00',
  };
}

describe('approval notification helpers', () => {
  it('reads the approval id from an approval bell row only', () => {
    expect(
      approvalIdFromNotification({ category: 'approval_requested', data: { approvalId: 'ap1' } }),
    ).toBe('ap1');
    expect(
      approvalIdFromNotification({ data: { type: 'approval_requested', approvalId: 'ap2' } }),
    ).toBe('ap2');
    expect(
      approvalIdFromNotification({ category: 'awaiting_feedback', data: { approvalId: 'x' } }),
    ).toBeNull();
    expect(
      approvalIdFromNotification({
        data: { type: 'approval_requested', approval: { id: 'ap3' } },
      }),
    ).toBe('ap3');
    expect(approvalIdFromNotification({ category: 'approval_requested', data: null })).toBeNull();
  });

  it('maps push action buttons to decisions and ignores the default tap', () => {
    expect(pushActionDecision('allow_once')).toBe('allow_once');
    expect(pushActionDecision('deny')).toBe('deny');
    expect(pushActionDecision('always_allow')).toBeNull();
    expect(pushActionDecision('expo.modules.notifications.actions.DEFAULT')).toBeNull();
  });

  it('only approval pushes get a category id', () => {
    expect(pushCategoryIdFor('approval_requested')).toBe('approval_requested');
    expect(pushCategoryIdFor('awaiting_feedback')).toBeUndefined();
    expect(pushCategoryIdFor(undefined)).toBeUndefined();
  });
});

describe('pending list helpers', () => {
  it('sorts pending oldest first and drops settled rows', () => {
    const list = [
      approval('b', { requestedAt: 5 }),
      approval('a', { requestedAt: 2 }),
      approval('c', { status: 'denied' }),
    ];
    expect(sortPendingApprovals(list).map((a) => a.id)).toEqual(['a', 'b']);
    expect(withoutApproval(list, 'b').map((a) => a.id)).toEqual(['a', 'c']);
  });

  it('drops settled ids from a late snapshot', () => {
    const list = [approval('a', { requestedAt: 3 }), approval('b', { requestedAt: 1 })];
    expect(reconcilePendingApprovals(list, new Set(['a'])).map((a) => a.id)).toEqual(['b']);
    expect(reconcilePendingApprovals(list, new Set()).map((a) => a.id)).toEqual(['b', 'a']);
  });

  it('formats expiry and description', () => {
    expect(formatApprovalExpiry(1000, 2000)).toBe('expired');
    expect(formatApprovalExpiry(30_000, 0)).toBe('expires in under a minute');
    expect(formatApprovalExpiry(12 * 60_000, 0)).toBe('expires in 12m');
    expect(formatApprovalExpiry(3 * 3_600_000 + 5, 0)).toBe('expires in 3h');
    expect(describeApproval({ action: 'delete', target: 'row 4' })).toBe('delete row 4');
    expect(describeApproval({ action: 'publish', target: '' })).toBe('publish');
    expect(describeApproval({ action: 'send', target: 'x'.repeat(200) }).length).toBe(145);
  });

  it('explains a 409 as no longer waiting', () => {
    expect(answerErrorMessage({ status: 409, message: '' })).toMatch(/no longer waiting/);
    expect(answerErrorMessage(new Error('boom'))).toBe('boom');
    expect(answerErrorMessage(null)).toBe('Could not send your answer.');
  });
});

describe('groupApprovalRules', () => {
  it('groups by profile with readable labels and keeps unknown profiles', () => {
    const groups = groupApprovalRules(
      [rule('r1', 'p2', 'z.com'), rule('r2', 'p1', 'b.com'), rule('r3', 'p2', 'a.com')],
      [{ id: 'p2', agentName: 'Researcher', projectName: 'Hub' }],
    );
    expect(groups.map((g) => g.label)).toEqual(['Browser profile', 'Researcher · Hub']);
    expect(groups[1].rules.map((r) => r.id)).toEqual(['r3', 'r1']);
  });
});
