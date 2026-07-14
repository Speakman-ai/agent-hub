import { describe, it, expect } from 'vitest';
import {
  STATUS_TABS,
  issueDisplayTitle,
  mergeIssuePage,
  applyIssueUpdate,
  applyTransitionToList,
  transitionRemovesFromTab,
  availableActions,
  type LogIssue,
} from './logIssues';

function issue(overrides: Partial<LogIssue> & { id: string }): LogIssue {
  return {
    projectId: 'p1',
    fingerprint: 'fp-abcdef012345',
    title: null,
    service: null,
    environment: null,
    exceptionType: null,
    messageTemplate: null,
    firstSeen: 1,
    lastSeen: 2,
    eventCount: 1,
    status: 'open',
    statusUpdatedAt: null,
    statusUpdatedBy: null,
    ...overrides,
  };
}

describe('STATUS_TABS', () => {
  it('exposes open/resolved/ignored plus an All tab with an empty key', () => {
    expect(STATUS_TABS.map((t) => t.key)).toEqual(['open', 'resolved', 'ignored', '']);
  });
});

describe('issueDisplayTitle', () => {
  it('prefers title, falls back to message template, then a placeholder', () => {
    expect(issueDisplayTitle({ title: 'Boom', messageTemplate: 'x' })).toBe('Boom');
    expect(issueDisplayTitle({ title: null, messageTemplate: 'template' })).toBe('template');
    expect(issueDisplayTitle({ title: null, messageTemplate: null })).toBe('(no message)');
  });
});

describe('mergeIssuePage — pagination vs refresh', () => {
  it('replaces the list on a fresh load', () => {
    const prev = [issue({ id: 'a' })];
    const merged = mergeIssuePage(prev, [issue({ id: 'b' })], false);
    expect(merged.map((i) => i.id)).toEqual(['b']);
  });
  it('appends on pagination', () => {
    const prev = [issue({ id: 'a' })];
    const merged = mergeIssuePage(prev, [issue({ id: 'b' })], true);
    expect(merged.map((i) => i.id)).toEqual(['a', 'b']);
  });
  it('collapses non-array inputs to [] instead of throwing', () => {
    expect(mergeIssuePage(undefined, undefined, false)).toEqual([]);
    expect(mergeIssuePage(null as any, { not: 'array' } as any, true)).toEqual([]);
  });
});

describe('applyIssueUpdate — optimistic transition apply', () => {
  it('shallow-merges updated fields onto the matching row only', () => {
    const list = [
      issue({ id: 'a', status: 'open', eventCount: 5 }),
      issue({ id: 'b', status: 'open' }),
    ];
    const next = applyIssueUpdate(list, 'a', { status: 'resolved' });
    expect(next.find((i) => i.id === 'a')?.status).toBe('resolved');
    expect(next.find((i) => i.id === 'a')?.eventCount).toBe(5); // untouched field survives
    expect(next.find((i) => i.id === 'b')?.status).toBe('open');
  });
  it('is a no-op when the id is absent', () => {
    const list = [issue({ id: 'a' })];
    expect(applyIssueUpdate(list, 'z', { status: 'ignored' })).toEqual(list);
  });
});

describe('applyTransitionToList / transitionRemovesFromTab — filtered-tab reconcile', () => {
  const list = [
    issue({ id: 'a', status: 'open' }),
    issue({ id: 'b', status: 'open' }),
  ];

  it('removes a row from a filtered tab when its new status no longer matches', () => {
    // Resolving on the Open tab must drop the row, not leave it with a stale chip.
    expect(transitionRemovesFromTab({ status: 'resolved' }, 'open')).toBe(true);
    const next = applyTransitionToList(list, 'a', { status: 'resolved' }, 'open');
    expect(next.map((i) => i.id)).toEqual(['b']);
  });

  it('updates in place on a filtered tab when the new status still matches', () => {
    // Reopen on the Open tab keeps the row (status still open); e.g. count bump.
    expect(transitionRemovesFromTab({ status: 'open', eventCount: 9 }, 'open')).toBe(false);
    const next = applyTransitionToList(list, 'a', { status: 'open', eventCount: 9 }, 'open');
    expect(next.map((i) => i.id)).toEqual(['a', 'b']);
    expect(next.find((i) => i.id === 'a')?.eventCount).toBe(9);
  });

  it('keeps and updates the row in place on the All tab regardless of new status', () => {
    expect(transitionRemovesFromTab({ status: 'ignored' }, '')).toBe(false);
    const next = applyTransitionToList(list, 'a', { status: 'ignored' }, '');
    expect(next.map((i) => i.id)).toEqual(['a', 'b']);
    expect(next.find((i) => i.id === 'a')?.status).toBe('ignored');
  });

  it('updates in place when the server omits a status (defensive, no drop)', () => {
    expect(transitionRemovesFromTab({ eventCount: 3 }, 'open')).toBe(false);
    const next = applyTransitionToList(list, 'a', { eventCount: 3 }, 'open');
    expect(next.map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('availableActions — lifecycle buttons by status', () => {
  it('open issues can be resolved or ignored, not reopened', () => {
    expect(availableActions('open')).toEqual(['resolve', 'ignore']);
  });
  it('resolved issues can be ignored or reopened', () => {
    expect(availableActions('resolved')).toEqual(['ignore', 'reopen']);
  });
  it('ignored issues can be resolved or reopened', () => {
    expect(availableActions('ignored')).toEqual(['resolve', 'reopen']);
  });
});
