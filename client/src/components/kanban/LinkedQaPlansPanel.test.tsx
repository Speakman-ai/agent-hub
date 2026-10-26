import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { QaPlanListItemWire, QaPlanListWire } from '../../utils/api';

const listQaPlans = vi.fn<(projectId: string) => Promise<QaPlanListWire>>();
vi.mock('../../utils/api', () => ({
  api: { listQaPlans: (id: string) => listQaPlans(id) },
}));

import LinkedQaPlansPanel from './LinkedQaPlansPanel';
import { useProjectQaPlans } from '../../hooks/useProjectQaPlans';

function plan(
  id: string,
  status: QaPlanListItemWire['status'],
  cardId: string | null,
  epicId: string | null,
) {
  const p: QaPlanListItemWire = {
    id,
    projectId: 'proj',
    title: `Plan ${id}`,
    goal: '',
    targetUrl: 'https://example.com',
    epicId,
    cardId,
    status,
    approved: true,
    signedOffAt: null,
    createdAt: '',
    updatedAt: '',
    summary: { caseCount: 2, latestRun: null, epic: null, card: null },
  };
  if (status === 'in_progress') {
    p.summary.latestRun = {
      id: `r-${id}`,
      iteration: 2,
      status: 'failed',
      scope: 'full',
      finishedAt: null,
      verdicts: { pass: 1, fail: 1, needs_change: 0, blocked: 0 },
    };
  }
  return p;
}

/** Mirrors how the card modal and epic view read the hook's index. */
function Harness({
  cardId,
  epicId,
  onOpenPlan,
}: {
  cardId?: string;
  epicId?: string;
  onOpenPlan: (id: string) => void;
}) {
  const idx = useProjectQaPlans('proj');
  const plans = cardId ? idx.byCard.get(cardId) : epicId ? idx.byEpic.get(epicId) : undefined;
  return <LinkedQaPlansPanel plans={plans} onOpenPlan={onOpenPlan} />;
}

beforeEach(() => {
  listQaPlans.mockReset();
  listQaPlans.mockResolvedValue({
    plans: [plan('a', 'in_progress', 'c1', 'e1'), plan('b', 'done', null, 'e1')],
    counts: { new: 0, in_progress: 1, done: 1 },
  });
});

describe('LinkedQaPlansPanel', () => {
  it('lists plans linked to a card with status and opens the plan detail', async () => {
    const onOpenPlan = vi.fn();
    render(<Harness cardId="c1" onOpenPlan={onOpenPlan} />);
    const rows = await screen.findAllByTestId('linked-qa-plan');
    expect(rows).toHaveLength(1);
    expect(screen.getByTestId('linked-qa-plan-status')).toHaveTextContent('Failing');
    expect(rows[0]).toHaveTextContent('#2 · 1/2 pass');
    fireEvent.click(rows[0]);
    expect(onOpenPlan).toHaveBeenCalledWith('a');
  });

  it('lists every plan linked to an epic', async () => {
    render(<Harness epicId="e1" onOpenPlan={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByTestId('linked-qa-plan')).toHaveLength(2));
    expect(screen.getAllByTestId('linked-qa-plan-status').map((n) => n.textContent)).toEqual([
      'Failing',
      'Done',
    ]);
  });

  it('renders nothing when no plan links here, and survives a failed load', async () => {
    listQaPlans.mockRejectedValueOnce(new Error('boom'));
    const { container } = render(<Harness cardId="c1" onOpenPlan={vi.fn()} />);
    await waitFor(() => expect(listQaPlans).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('refetches on qa_update for this project', async () => {
    render(<Harness cardId="c1" onOpenPlan={vi.fn()} />);
    await screen.findByTestId('linked-qa-plan');
    listQaPlans.mockResolvedValue({ plans: [], counts: { new: 0, in_progress: 0, done: 0 } });
    act(() => {
      window.dispatchEvent(new CustomEvent('qa_update', { detail: { projectId: 'other' } }));
    });
    expect(listQaPlans).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new CustomEvent('qa_update', { detail: { projectId: 'proj' } }));
    });
    await waitFor(() => expect(screen.queryByTestId('linked-qa-plan')).toBeNull());
  });
});
