import { describe, expect, it, vi } from 'vitest';

vi.mock('../theme/colors', () => ({ colors: new Proxy({}, { get: (_t, k) => String(k) }) }));

import {
  caseEditPatch,
  caseListLockReason,
  createQaUpdateHub,
  filterCardOptions,
  groupPlansByStatus,
  latestRunLabel,
  moveCaseIds,
  orderRunResults,
  parseMaxIterations,
  planCounts,
  qaEventMatches,
  rerunButtonStates,
  targetHost,
  validateQaPlanDraft,
  type QaPlanListItem,
} from './qa';

function plan(over: Partial<QaPlanListItem> & { id: string }): QaPlanListItem {
  return {
    projectId: 'p1',
    title: over.id,
    goal: '',
    targetUrl: 'https://staging.example.com/app',
    epicId: null,
    cardId: null,
    status: 'new',
    approved: false,
    signedOffAt: null,
    createdAt: '',
    updatedAt: '',
    summary: { caseCount: 0, latestRun: null, epic: null, card: null },
    ...over,
  };
}

const verdicts = (v: Partial<Record<'pass' | 'fail' | 'needs_change' | 'blocked', number>>) => ({
  pass: 0,
  fail: 0,
  needs_change: 0,
  blocked: 0,
  ...v,
});

describe('QA list filtering', () => {
  it('buckets plans by status and keeps the server order inside each bucket', () => {
    const grouped = groupPlansByStatus([
      plan({ id: 'a', status: 'in_progress' }),
      plan({ id: 'b', status: 'new' }),
      plan({ id: 'c', status: 'in_progress' }),
      plan({ id: 'd', status: 'done' }),
    ]);
    expect(grouped.new.map((p) => p.id)).toEqual(['b']);
    expect(grouped.in_progress.map((p) => p.id)).toEqual(['a', 'c']);
    expect(grouped.done.map((p) => p.id)).toEqual(['d']);
  });

  it('drops plans with an unknown status instead of throwing', () => {
    const grouped = groupPlansByStatus([plan({ id: 'x', status: 'weird' as any })]);
    expect(grouped.new.length + grouped.in_progress.length + grouped.done.length).toBe(0);
  });

  it('uses server counts and falls back to bucket sizes', () => {
    const grouped = groupPlansByStatus([plan({ id: 'a' }), plan({ id: 'b', status: 'done' })]);
    expect(planCounts(grouped, { new: 7, in_progress: 2, done: 1 })).toEqual({
      new: 7,
      in_progress: 2,
      done: 1,
    });
    expect(planCounts(grouped, null)).toEqual({ new: 1, in_progress: 0, done: 1 });
  });

  it('labels the latest run with its nonzero verdicts', () => {
    expect(latestRunLabel(plan({ id: 'a' }))).toBe('Not run');
    const p = plan({
      id: 'a',
      summary: {
        caseCount: 3,
        epic: null,
        card: null,
        latestRun: {
          id: 'r',
          iteration: 2,
          status: 'failed',
          scope: 'full',
          finishedAt: null,
          verdicts: verdicts({ pass: 2, needs_change: 1 }),
        },
      },
    });
    expect(latestRunLabel(p)).toBe('Run 2 failed · 2 pass, 1 needs change');
  });

  it('shows the target host, or the raw text when it is not a URL', () => {
    expect(targetHost('https://staging.example.com/app')).toBe('staging.example.com');
    expect(targetHost('not a url')).toBe('not a url');
  });

  it('matches qa_update events to the open project and plan', () => {
    expect(qaEventMatches(null, 'p1')).toBe(false);
    expect(qaEventMatches({ projectId: 'p1' }, 'p1')).toBe(true);
    expect(qaEventMatches({ projectId: 'p2' }, 'p1')).toBe(false);
    expect(qaEventMatches({ projectId: 'p1', planId: 'x' }, 'p1', 'y')).toBe(false);
    expect(qaEventMatches({ projectId: 'p1', planId: 'y' }, 'p1', 'y')).toBe(true);
  });
});

describe('QA plan detail rules', () => {
  const basePlan = { approved: true, status: 'in_progress' as const } as any;
  const passCase = {
    id: 'c1',
    latestVerdict: { verdict: 'pass', current: true, caseVersion: 1, runId: 'r', iteration: 1 },
  } as any;
  const failCase = {
    id: 'c2',
    latestVerdict: { verdict: 'fail', current: true, caseVersion: 1, runId: 'r', iteration: 1 },
  } as any;

  it('blocks runs on unapproved plans and while a run is active', () => {
    expect(
      rerunButtonStates({ plan: { ...basePlan, approved: false }, runs: [], cases: [passCase] })
        .full.enabled,
    ).toBe(false);
    const running = rerunButtonStates({
      plan: basePlan,
      runs: [{ iteration: 3, status: 'running' } as any],
      cases: [failCase],
    });
    expect(running.full).toEqual({ enabled: false, title: 'Run 3 is running' });
  });

  it('disables failed-only rerun once every case passed on its current version', () => {
    const allPass = rerunButtonStates({ plan: basePlan, runs: [], cases: [passCase] });
    expect(allPass.full.enabled).toBe(true);
    expect(allPass.failedOnly.enabled).toBe(false);
    const mixed = rerunButtonStates({ plan: basePlan, runs: [], cases: [passCase, failCase] });
    expect(mixed.failedOnly).toEqual({
      enabled: true,
      title: 'Run the 1 case(s) without a current pass',
    });
  });

  it('locks the case list when signed off or a run is queued', () => {
    expect(caseListLockReason({ plan: { status: 'done' } as any, runs: [] })).toMatch(/Signed off/);
    expect(
      caseListLockReason({ plan: basePlan, runs: [{ iteration: 1, status: 'queued' } as any] }),
    ).toMatch(/Run 1 is queued/);
    expect(caseListLockReason({ plan: basePlan, runs: [] })).toBeNull();
  });

  it('moves case ids within bounds', () => {
    expect(moveCaseIds(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveCaseIds(['a', 'b'], 0, -1)).toBeNull();
  });

  it('sends only changed case fields with their opening text as the precondition', () => {
    const base = { title: 'T', steps: 's', expected: 'e' };
    expect(caseEditPatch(base, { ...base, title: ' T ' })).toBeNull();
    expect(caseEditPatch(base, { ...base, expected: 'e2' })).toEqual({
      patch: { expected: 'e2' },
      expectedBase: { expected: 'e' },
    });
  });

  it('orders results by case and keeps results for deleted cases', () => {
    const r = (caseId: string) => ({ id: `r-${caseId}`, caseId }) as any;
    const rows = orderRunResults(
      [r('gone'), r('b'), r('a')],
      [
        { id: 'a', title: 'A', expected: '', version: 1 },
        { id: 'b', title: 'B', expected: '', version: 1 },
      ],
    );
    expect(rows.map((x) => x.result.caseId)).toEqual(['a', 'b', 'gone']);
    expect(rows[2]!.qaCase).toBeNull();
  });

  it('accepts max runs 1-100 only', () => {
    expect(parseMaxIterations('5')).toBe(5);
    expect(parseMaxIterations('0')).toBeNull();
    expect(parseMaxIterations('101')).toBeNull();
    expect(parseMaxIterations('5x')).toBeNull();
  });
});

describe('New QA plan form', () => {
  it('requires a title and a full http(s) target URL', () => {
    const draft = { title: '', targetUrl: 'ftp://x', goal: '', epicId: '', cardId: '' };
    expect(validateQaPlanDraft(draft)).toEqual({
      title: 'Title is required',
      targetUrl: 'Enter a full http:// or https:// URL',
    });
    expect(
      validateQaPlanDraft({ ...draft, title: 'Login', targetUrl: 'https://a.example' }),
    ).toEqual({});
  });

  it('filters card options by epic, title, and #number, newest first', () => {
    const cards = [
      { id: '1', title: 'Login page', shortId: 10, epicId: 'e1' },
      { id: '2', title: 'Signup', shortId: 12, epicId: 'e2' },
      { id: '3', title: 'Logout', shortId: 120, epicId: 'e1' },
    ];
    expect(filterCardOptions(cards, 'e1', '').map((c) => c.id)).toEqual(['3', '1']);
    expect(filterCardOptions(cards, '', 'log').map((c) => c.id)).toEqual(['3', '1']);
    expect(filterCardOptions(cards, '', '#12').map((c) => c.id)).toEqual(['3', '2']);
  });
});

describe('createQaUpdateHub', () => {
  it('delivers every event in a burst to every listener', () => {
    const hub = createQaUpdateHub();
    const seen: Array<string | null> = [];
    const off = hub.subscribe((e) => seen.push(e.planId));
    hub.emit({ projectId: 'p1', planId: 'a' });
    hub.emit({ projectId: 'p1', planId: 'b' });
    hub.emit({ projectId: 'p1' });
    expect(seen).toEqual(['a', 'b', null]);
    off();
    hub.emit({ projectId: 'p1', planId: 'c' });
    expect(seen).toHaveLength(3);
  });
});
