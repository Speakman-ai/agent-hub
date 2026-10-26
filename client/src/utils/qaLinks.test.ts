import { describe, it, expect } from 'vitest';
import type { QaPlanListItemWire, QaRunStatus, QaVerdict } from './api';
import { indexQaPlansByLink, qaBoardIndicator, qaPlanTone } from './qaLinks';

function plan(
  id: string,
  status: QaPlanListItemWire['status'],
  opts: {
    epicId?: string;
    cardId?: string;
    run?: QaRunStatus;
    verdicts?: Partial<Record<QaVerdict, number>>;
  } = {},
): QaPlanListItemWire {
  return {
    id,
    projectId: 'proj',
    title: `Plan ${id}`,
    goal: '',
    targetUrl: 'https://example.com',
    epicId: opts.epicId ?? null,
    cardId: opts.cardId ?? null,
    status,
    approved: true,
    signedOffAt: null,
    createdAt: '',
    updatedAt: '',
    summary: {
      caseCount: 3,
      latestRun: opts.run
        ? {
            id: `r-${id}`,
            iteration: 1,
            status: opts.run,
            scope: 'full',
            finishedAt: null,
            verdicts: { pass: 0, fail: 0, needs_change: 0, blocked: 0, ...opts.verdicts },
          }
        : null,
      epic: null,
      card: null,
    },
  };
}

describe('qaPlanTone', () => {
  it('reads new and done plans by status', () => {
    expect(qaPlanTone(plan('a', 'new'))).toBe('new');
    expect(qaPlanTone(plan('a', 'done', { run: 'passed' }))).toBe('done');
  });

  it('flags a failed run or recorded fail/needs_change verdicts as failing', () => {
    expect(qaPlanTone(plan('a', 'in_progress', { run: 'failed' }))).toBe('failing');
    expect(
      qaPlanTone(plan('a', 'in_progress', { run: 'passed', verdicts: { needs_change: 1 } })),
    ).toBe('failing');
  });

  it('shows a queued or running pass as running, ahead of partial fails', () => {
    expect(qaPlanTone(plan('a', 'in_progress', { run: 'queued' }))).toBe('running');
    expect(qaPlanTone(plan('a', 'in_progress', { run: 'running', verdicts: { fail: 1 } }))).toBe(
      'running',
    );
  });

  it('falls back to in progress for a passed or cancelled run awaiting sign-off', () => {
    expect(qaPlanTone(plan('a', 'in_progress', { run: 'passed', verdicts: { pass: 3 } }))).toBe(
      'in_progress',
    );
    expect(qaPlanTone(plan('a', 'in_progress', { run: 'cancelled' }))).toBe('in_progress');
  });
});

describe('indexQaPlansByLink', () => {
  it('groups plans under their card and epic, skipping unlinked plans', () => {
    const idx = indexQaPlansByLink([
      plan('a', 'new', { epicId: 'e1', cardId: 'c1' }),
      plan('b', 'new', { cardId: 'c1' }),
      plan('c', 'new'),
    ]);
    expect(idx.byCard.get('c1')?.map((p) => p.id)).toEqual(['a', 'b']);
    expect(idx.byEpic.get('e1')?.map((p) => p.id)).toEqual(['a']);
    expect(idx.byCard.size).toBe(1);
    expect(idx.byEpic.size).toBe(1);
  });
});

describe('qaBoardIndicator', () => {
  it('stays quiet without linked plans or with only new / done plans', () => {
    expect(qaBoardIndicator(undefined)).toBeNull();
    expect(qaBoardIndicator([])).toBeNull();
    expect(qaBoardIndicator([plan('a', 'new'), plan('b', 'done', { run: 'passed' })])).toBeNull();
  });

  it('flags an in-progress plan', () => {
    expect(qaBoardIndicator([plan('a', 'in_progress', { run: 'passed' })])).toMatchObject({
      tone: 'in_progress',
      count: 1,
    });
  });

  it('picks the most severe tone and counts only active plans', () => {
    const indicator = qaBoardIndicator([
      plan('a', 'in_progress', { run: 'running' }),
      plan('b', 'in_progress', { run: 'failed' }),
      plan('c', 'done', { run: 'passed' }),
    ]);
    expect(indicator).toMatchObject({ tone: 'failing', count: 2 });
    expect(indicator?.title).toContain('Plan b: failing');
    expect(indicator?.title).not.toContain('Plan c');
  });
});
