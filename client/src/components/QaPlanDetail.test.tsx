import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import type { QaCaseWire, QaPlanDetailWire, QaRunWire } from '../utils/api';

const getQaPlan = vi.fn<(projectId: string, planId: string) => Promise<QaPlanDetailWire>>();
vi.mock('../utils/api', () => ({
  api: { getQaPlan: (p: string, id: string) => getQaPlan(p, id) },
}));

import QaPlanDetail, { VerdictCell, caseVerdictLabel, runDuration } from './QaPlanDetail';

function qaCase(id: string, latestVerdict: QaCaseWire['latestVerdict'] = null): QaCaseWire {
  return {
    id,
    planId: 'p1',
    position: 0,
    title: `Case ${id}`,
    steps: 'Open the page',
    expected: 'It loads',
    version: 1,
    createdAt: '2026-10-26 00:00:00',
    updatedAt: '2026-10-26 00:00:00',
    latestVerdict,
  };
}

function run(id: string, extra: Partial<QaRunWire> = {}): QaRunWire {
  return {
    id,
    planId: 'p1',
    iteration: 1,
    scope: 'full',
    status: 'passed',
    approvalSeq: 1,
    sessionId: null,
    sessionAgentId: null,
    startedBy: 'u1',
    startedAt: '2026-10-26 10:00:00',
    finishedAt: '2026-10-26 10:03:12',
    createdAt: '2026-10-26 10:00:00',
    ...extra,
  };
}

function detail(over: Partial<QaPlanDetailWire> & { approved?: boolean } = {}): QaPlanDetailWire {
  const { approved = true, ...rest } = over;
  return {
    plan: {
      id: 'p1',
      projectId: 'proj',
      title: 'Checkout plan',
      goal: 'Buy a thing',
      targetUrl: 'https://shop.example.com/cart',
      epicId: 'e1',
      cardId: null,
      deployEnvironment: null,
      status: 'in_progress',
      approved,
      approvedAt: approved ? '2026-10-26 09:00:00' : null,
      approvedBy: approved ? 'u1' : null,
      approvalSeq: 1,
      signedOffAt: null,
      signedOffBy: null,
      autoRerun: true,
      maxIterations: 5,
      createdBy: 'u1',
      createdAt: '2026-10-26 00:00:00',
      updatedAt: '2026-10-26 00:00:00',
    },
    links: { epic: { id: 'e1', name: 'Checkout epic' }, card: null },
    cases: [],
    runs: [],
    signOffBlocker: 'never run',
    ...rest,
  };
}

beforeEach(() => {
  getQaPlan.mockReset();
});

describe('caseVerdictLabel', () => {
  it('labels not-run, current, and stale verdicts', () => {
    expect(caseVerdictLabel(null)).toBe('Not run');
    expect(
      caseVerdictLabel({
        verdict: 'needs_change',
        caseVersion: 1,
        current: true,
        runId: 'r',
        iteration: 2,
      }),
    ).toBe('needs change (run 2)');
    expect(
      caseVerdictLabel({
        verdict: 'pass',
        caseVersion: 1,
        current: false,
        runId: 'r',
        iteration: 1,
      }),
    ).toBe('pass (run 1, case edited since)');
  });
});

describe('runDuration', () => {
  it('formats finished, in-flight, and unstarted runs', () => {
    expect(runDuration(run('a'))).toBe('3m 12s');
    expect(runDuration(run('b', { finishedAt: null }), new Date('2026-10-26T11:30:00Z'))).toBe(
      '1h 30m',
    );
    expect(runDuration(run('c', { startedAt: null, finishedAt: null }))).toBeNull();
  });
});

describe('VerdictCell', () => {
  it('renders each verdict with its colour and run iteration', () => {
    const cases = [
      ['pass', 'text-emerald-400', 'pass'],
      ['fail', 'text-red-400', 'fail'],
      ['needs_change', 'text-amber-400', 'needs change'],
      ['blocked', 'text-gray-400', 'blocked'],
    ] as const;
    for (const [verdict, cls, label] of cases) {
      const { unmount } = render(
        <VerdictCell
          latest={{ verdict, caseVersion: 1, current: true, runId: 'r', iteration: 3 }}
        />,
      );
      const cell = screen.getByTestId('qa-verdict');
      expect(cell.dataset.verdict).toBe(verdict);
      expect(within(cell).getByText(label).className).toContain(cls);
      expect(within(cell).getByText('run 3')).toBeTruthy();
      expect(within(cell).queryByText('stale')).toBeNull();
      unmount();
    }
  });

  it('marks a verdict from an older case version as stale and drops its colour', () => {
    render(
      <VerdictCell
        latest={{ verdict: 'fail', caseVersion: 1, current: false, runId: 'r', iteration: 1 }}
      />,
    );
    const cell = screen.getByTestId('qa-verdict');
    expect(cell.dataset.current).toBe('false');
    expect(within(cell).getByText('stale')).toBeTruthy();
    expect(within(cell).getByText('fail').className).not.toContain('text-red-400');
  });

  it('shows Not run when the case has no verdict', () => {
    render(<VerdictCell latest={null} />);
    expect(screen.getByTestId('qa-verdict').textContent).toBe('Not run');
  });
});

describe('QaPlanDetail', () => {
  it('shows target, chips, status, approval, cases with verdicts, and run history', async () => {
    const onOpenEpic = vi.fn();
    const onOpenSession = vi.fn();
    getQaPlan.mockResolvedValue(
      detail({
        cases: [
          qaCase('a', {
            verdict: 'pass',
            caseVersion: 1,
            current: true,
            runId: 'r2',
            iteration: 2,
          }),
          qaCase('b', {
            verdict: 'fail',
            caseVersion: 1,
            current: true,
            runId: 'r2',
            iteration: 2,
          }),
          qaCase('c'),
        ],
        runs: [
          run('r2', {
            iteration: 2,
            scope: 'failed_only',
            status: 'failed',
            sessionId: 's2',
            sessionAgentId: 'qa-agent',
          }),
          run('r1'),
        ],
      }),
    );
    render(
      <QaPlanDetail
        projectId="proj"
        planId="p1"
        onBack={() => {}}
        onOpenEpic={onOpenEpic}
        onOpenSession={onOpenSession}
      />,
    );

    await screen.findByText('Checkout plan');
    expect(getQaPlan).toHaveBeenCalledWith('proj', 'p1');
    const target = screen.getByTestId('qa-detail-target') as HTMLAnchorElement;
    expect(target.href).toBe('https://shop.example.com/cart');
    expect(screen.getByTestId('qa-detail-status').textContent).toBe('In progress');
    expect(screen.getByTestId('qa-detail-approval').textContent).toBe('Approved');
    expect(screen.queryByTestId('qa-detail-unapproved')).toBeNull();

    fireEvent.click(screen.getByText('Checkout epic'));
    expect(onOpenEpic).toHaveBeenCalledWith('e1');

    const verdictOf = (id: string) =>
      within(screen.getByTestId(`qa-case-row-${id}`)).getByTestId('qa-verdict');
    expect(verdictOf('a').dataset.verdict).toBe('pass');
    expect(verdictOf('b').dataset.verdict).toBe('fail');
    expect(verdictOf('c').textContent).toBe('Not run');

    const newest = screen.getByTestId('qa-run-row-r2');
    expect(within(newest).getByText('Run 2')).toBeTruthy();
    expect(within(newest).getByText('Failed only')).toBeTruthy();
    expect(within(newest).getByTestId('qa-run-status').textContent).toBe('failed');
    expect(within(newest).getByText(/3m 12s/)).toBeTruthy();
    fireEvent.click(within(newest).getByTestId('qa-run-session'));
    expect(onOpenSession).toHaveBeenCalledWith('qa-agent', 's2');
    expect(within(screen.getByTestId('qa-run-row-r1')).queryByTestId('qa-run-session')).toBeNull();
  });

  it('shows empty states for an unapproved plan with no cases and no runs', async () => {
    getQaPlan.mockResolvedValue(detail({ approved: false }));
    render(<QaPlanDetail projectId="proj" planId="p1" onBack={() => {}} />);

    await screen.findByText('Checkout plan');
    expect(screen.getByTestId('qa-detail-approval').textContent).toBe('Not approved');
    expect(screen.getByTestId('qa-detail-unapproved')).toBeTruthy();
    expect(screen.getByTestId('qa-cases-empty').textContent).toMatch(/approve the plan/);
    expect(screen.getByTestId('qa-runs-empty').textContent).toMatch(/once the plan is approved/);
  });

  it('shows a never-run empty state for an approved plan', async () => {
    getQaPlan.mockResolvedValue(detail({ cases: [qaCase('a')] }));
    render(<QaPlanDetail projectId="proj" planId="p1" onBack={() => {}} />);

    await screen.findByText('Checkout plan');
    expect(screen.getByTestId('qa-runs-empty').textContent).toMatch(/Start a run/);
    expect(screen.queryByTestId('qa-cases-empty')).toBeNull();
  });

  it('refreshes on a qa_update for this plan and ignores other plans', async () => {
    getQaPlan.mockResolvedValue(detail());
    render(<QaPlanDetail projectId="proj" planId="p1" onBack={() => {}} />);
    await screen.findByText('Checkout plan');
    expect(getQaPlan).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(
        new CustomEvent('qa_update', { detail: { projectId: 'proj', planId: 'other' } }),
      );
    });
    expect(getQaPlan).toHaveBeenCalledTimes(1);

    getQaPlan.mockResolvedValue(detail({ cases: [qaCase('new')] }));
    act(() => {
      window.dispatchEvent(
        new CustomEvent('qa_update', { detail: { projectId: 'proj', planId: 'p1' } }),
      );
    });
    await screen.findByTestId('qa-case-row-new');
  });

  it('shows the load error', async () => {
    getQaPlan.mockRejectedValue(new Error('QA plan not found'));
    render(<QaPlanDetail projectId="proj" planId="p1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('QA plan not found')).toBeTruthy());
  });
});
