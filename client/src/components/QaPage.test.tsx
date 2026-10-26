import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import type { QaPlanListItemWire, QaPlanListWire } from '../utils/api';

const listQaPlans = vi.fn<(projectId: string) => Promise<QaPlanListWire>>();
const getQaPlan = vi.fn();
vi.mock('../utils/api', () => ({
  api: {
    listQaPlans: (id: string) => listQaPlans(id),
    getQaPlan: (projectId: string, planId: string) => getQaPlan(projectId, planId),
  },
}));

import QaPage, { groupPlansByStatus, latestRunLabel, targetHost } from './QaPage';

function plan(
  id: string,
  status: QaPlanListItemWire['status'],
  summary: Partial<QaPlanListItemWire['summary']> = {},
): QaPlanListItemWire {
  return {
    id,
    projectId: 'proj',
    title: `Plan ${id}`,
    goal: '',
    targetUrl: `https://${id}.example.com/app?x=1`,
    epicId: summary.epic?.id ?? null,
    cardId: summary.card?.id ?? null,
    status,
    approved: true,
    signedOffAt: null,
    createdAt: '2026-10-26 00:00:00',
    updatedAt: '2026-10-26 00:00:00',
    summary: { caseCount: 2, latestRun: null, epic: null, card: null, ...summary },
  };
}

const PLANS: QaPlanListItemWire[] = [
  plan('a', 'new', { epic: { id: 'e1', name: 'Checkout epic' } }),
  plan('b', 'in_progress', {
    card: { id: 'c1', title: 'Fix login' },
    latestRun: {
      id: 'r2',
      iteration: 2,
      status: 'failed',
      scope: 'full',
      finishedAt: '2026-10-26 01:00:00',
      verdicts: { pass: 1, fail: 1, needs_change: 0, blocked: 0 },
    },
  }),
  plan('c', 'in_progress'),
  plan('d', 'done'),
];

function respond(plans = PLANS) {
  const counts = { new: 0, in_progress: 0, done: 0 };
  for (const p of plans) counts[p.status] += 1;
  listQaPlans.mockResolvedValue({ plans, counts });
}

beforeEach(() => {
  listQaPlans.mockReset();
  getQaPlan.mockReset();
  localStorage.clear();
  respond();
});

describe('QaPage helpers', () => {
  it('groups plans by status, keeping order', () => {
    const g = groupPlansByStatus(PLANS);
    expect(g.new.map((p) => p.id)).toEqual(['a']);
    expect(g.in_progress.map((p) => p.id)).toEqual(['b', 'c']);
    expect(g.done.map((p) => p.id)).toEqual(['d']);
  });

  it('extracts the target host and falls back to the raw string', () => {
    expect(targetHost('https://app.example.com:8080/x')).toBe('app.example.com:8080');
    expect(targetHost('not a url')).toBe('not a url');
  });

  it('summarizes the latest run', () => {
    expect(latestRunLabel(PLANS[0])).toBe('Not run');
    expect(latestRunLabel(PLANS[1])).toBe('Run 2 failed · 1 pass, 1 fail');
  });
});

describe('QaPage', () => {
  it('shows counts on tabs and filters rows by the selected tab', async () => {
    render(<QaPage projectId="proj" />);
    await screen.findByTestId('qa-plan-row-a');
    expect(screen.getByTestId('qa-tab-new')).toHaveTextContent('New1');
    expect(screen.getByTestId('qa-tab-in_progress')).toHaveTextContent('In progress2');
    expect(screen.getByTestId('qa-tab-done')).toHaveTextContent('Done1');
    expect(screen.queryByTestId('qa-plan-row-b')).toBeNull();

    fireEvent.click(screen.getByTestId('qa-tab-in_progress'));
    expect(screen.getByTestId('qa-tab-in_progress')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('qa-plan-row-b')).toBeInTheDocument();
    expect(screen.getByTestId('qa-plan-row-c')).toBeInTheDocument();
    expect(screen.queryByTestId('qa-plan-row-a')).toBeNull();

    const row = screen.getByTestId('qa-plan-row-b');
    expect(row).toHaveTextContent('Plan b');
    expect(row).toHaveTextContent('b.example.com');
    expect(row).toHaveTextContent('Run 2 failed');
    expect(row).toHaveTextContent('1 fail');
    expect(within(row).getByTitle('Card: Fix login')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('qa-tab-done'));
    expect(screen.getByTestId('qa-plan-row-d')).toBeInTheDocument();
  });

  it('groups plans into three read-only board columns', async () => {
    render(<QaPage projectId="proj" />);
    await screen.findByTestId('qa-plan-row-a');
    fireEvent.click(screen.getByTestId('qa-view-board'));

    const col = (k: string) => screen.getByTestId(`qa-column-${k}`);
    expect(within(col('new')).getByTestId('qa-plan-card-a')).toBeInTheDocument();
    expect(within(col('in_progress')).getByTestId('qa-plan-card-b')).toBeInTheDocument();
    expect(within(col('in_progress')).getByTestId('qa-plan-card-c')).toBeInTheDocument();
    expect(within(col('done')).getByTestId('qa-plan-card-d')).toBeInTheDocument();
    expect(col('in_progress')).toHaveTextContent('In progress2');
    expect(screen.getByTestId('qa-plan-card-a')).not.toHaveAttribute('draggable', 'true');
    expect(localStorage.getItem('agenthub.qa.viewMode')).toBe('board');
  });

  it('opens linked epic and card from the chips', async () => {
    const onOpenEpic = vi.fn();
    const onOpenCard = vi.fn();
    render(<QaPage projectId="proj" onOpenEpic={onOpenEpic} onOpenCard={onOpenCard} />);
    fireEvent.click(await screen.findByTitle('Epic: Checkout epic'));
    expect(onOpenEpic).toHaveBeenCalledWith('e1');
    fireEvent.click(screen.getByTestId('qa-tab-in_progress'));
    fireEvent.click(screen.getByTitle('Card: Fix login'));
    expect(onOpenCard).toHaveBeenCalledWith('c1');
  });

  it('opens a plan from its row or board card and returns to the list', async () => {
    getQaPlan.mockImplementation((_p: string, planId: string) => {
      const p = PLANS.find((x) => x.id === planId)!;
      return Promise.resolve({
        plan: {
          ...p,
          deployEnvironment: null,
          approvedAt: null,
          approvedBy: null,
          approvalSeq: 1,
          signedOffBy: null,
          autoRerun: true,
          maxIterations: 5,
          createdBy: null,
        },
        links: { epic: p.summary.epic, card: p.summary.card },
        cases: [],
        runs: [],
        signOffBlocker: null,
      });
    });
    render(<QaPage projectId="proj" />);
    fireEvent.click(await screen.findByTestId('qa-plan-open-a'));
    await screen.findByTestId('qa-plan-detail');
    expect(getQaPlan).toHaveBeenLastCalledWith('proj', 'a');
    expect(await screen.findByText('Plan a')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('qa-detail-back'));
    expect(await screen.findByTestId('qa-plan-row-a')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('qa-view-board'));
    fireEvent.click(screen.getByTestId('qa-plan-open-d'));
    await screen.findByTestId('qa-plan-detail');
    expect(getQaPlan).toHaveBeenLastCalledWith('proj', 'd');
  });

  it('opens straight into the plan passed by an epic or card badge', async () => {
    getQaPlan.mockResolvedValue({
      plan: {
        ...PLANS[1],
        deployEnvironment: null,
        approvalSeq: 1,
        autoRerun: true,
        maxIterations: 5,
      },
      links: { epic: null, card: PLANS[1].summary.card },
      cases: [],
      runs: [],
      signOffBlocker: null,
    });
    const consumed = vi.fn();
    render(<QaPage projectId="proj" initialPlanId="b" onInitialPlanConsumed={consumed} />);
    await screen.findByTestId('qa-plan-detail');
    expect(getQaPlan).toHaveBeenLastCalledWith('proj', 'b');
    expect(consumed).toHaveBeenCalled();
    expect(screen.queryByTestId('qa-page')).toBeNull();
  });

  it('refetches on qa_update for this project only', async () => {
    render(<QaPage projectId="proj" />);
    await screen.findByTestId('qa-plan-row-a');
    expect(listQaPlans).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new CustomEvent('qa_update', { detail: { projectId: 'other' } }));
    });
    expect(listQaPlans).toHaveBeenCalledTimes(1);

    respond([...PLANS, plan('e', 'new')]);
    act(() => {
      window.dispatchEvent(new CustomEvent('qa_update', { detail: { projectId: 'proj' } }));
    });
    await screen.findByTestId('qa-plan-row-e');
    expect(listQaPlans).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByTestId('qa-tab-new')).toHaveTextContent('New2'));
  });

  it('ignores a stale response for the previous project', async () => {
    const deferred = () => {
      let resolve!: (v: QaPlanListWire) => void;
      const promise = new Promise<QaPlanListWire>((r) => (resolve = r));
      return { promise, resolve };
    };
    const a = deferred();
    const b = deferred();
    listQaPlans.mockImplementation((id) => (id === 'proj-a' ? a.promise : b.promise));

    const { rerender } = render(<QaPage projectId="proj-a" />);
    rerender(<QaPage projectId="proj-b" />);

    const one = (p: QaPlanListItemWire): QaPlanListWire => ({
      plans: [p],
      counts: { new: 1, in_progress: 0, done: 0 },
    });
    await act(async () => b.resolve(one({ ...plan('bee', 'new'), projectId: 'proj-b' })));
    await screen.findByTestId('qa-plan-row-bee');
    await act(async () => a.resolve(one({ ...plan('ay', 'new'), projectId: 'proj-a' })));

    expect(screen.getByTestId('qa-plan-row-bee')).toBeInTheDocument();
    expect(screen.queryByTestId('qa-plan-row-ay')).toBeNull();
  });

  it('keeps the newest qa_update refresh when an older one resolves last', async () => {
    render(<QaPage projectId="proj" />);
    await screen.findByTestId('qa-plan-row-a');

    let resolveOld!: (v: QaPlanListWire) => void;
    listQaPlans.mockImplementationOnce(() => new Promise((r) => (resolveOld = r)));
    act(() => {
      window.dispatchEvent(new CustomEvent('qa_update', { detail: { projectId: 'proj' } }));
    });
    respond([plan('fresh', 'new')]);
    act(() => {
      window.dispatchEvent(new CustomEvent('qa_update', { detail: { projectId: 'proj' } }));
    });
    await screen.findByTestId('qa-plan-row-fresh');
    await act(async () =>
      resolveOld({ plans: [plan('old', 'new')], counts: { new: 1, in_progress: 0, done: 0 } }),
    );
    expect(screen.getByTestId('qa-plan-row-fresh')).toBeInTheDocument();
    expect(screen.queryByTestId('qa-plan-row-old')).toBeNull();
  });
});
