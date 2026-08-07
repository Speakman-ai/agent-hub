import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import InfraSpendPanel from './InfraSpendPanel';
import { api } from '../../utils/api';

(vi as any).mock('../../utils/api.js', () => ({
  api: {
    getInfraSpend: vi.fn(),
    updateInfraSpendConfig: vi.fn(),
  },
}));

const getInfraSpend = vi.mocked(api.getInfraSpend);
const updateInfraSpendConfig = vi.mocked(api.updateInfraSpendConfig);

const disabled = {
  enabled: false,
  syncedAt: null,
  windowStartDay: '2026-07-09',
  windowEndDay: '2026-08-08',
  days: [],
  topServices: [],
  accounts: [],
  totalUsd: 0,
  unit: null,
  fetchedAt: null,
  lastRun: null,
};

const populated = {
  ...disabled,
  enabled: true,
  syncedAt: Date.now() - 4 * 60 * 60 * 1000,
  fetchedAt: Date.now() - 4 * 60 * 60 * 1000,
  unit: 'USD',
  days: [
    { day: '2026-08-05', amountUsd: 10, estimated: false },
    { day: '2026-08-06', amountUsd: 14, estimated: false },
    { day: '2026-08-07', amountUsd: 6, estimated: true },
  ],
  topServices: [
    { service: 'AmazonEC2', amountUsd: 18 },
    { service: 'AmazonRDS', amountUsd: 9 },
  ],
  accounts: [{ linkedAccount: '111122223333', amountUsd: 30 }],
  // Deliberately more than the listed services: the truncated tail has to
  // surface, or the ranked list understates the bill.
  totalUsd: 30,
};

describe('InfraSpendPanel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getInfraSpend.mockResolvedValue(disabled as any);
    updateInfraSpendConfig.mockResolvedValue(disabled as any);
  });

  it('states the price and the polling cadence before offering the opt-in', async () => {
    render(<InfraSpendPanel projectId="project-1" />);

    const card = await screen.findByTestId('infra-spend-optin');
    expect(card).toHaveTextContent('$0.01 per paginated request');
    expect(card).toHaveTextContent('no free tier');
    expect(card).toHaveTextContent('at most 3 times a day');
    // No chart is drawn for a project that never opted in; an empty plot would
    // read as "you have no AWS spend".
    expect(screen.queryByTestId('infra-spend-chart')).toBeNull();
  });

  it('opts the project in through the config endpoint and repaints from the response', async () => {
    updateInfraSpendConfig.mockResolvedValue(populated as any);
    render(<InfraSpendPanel projectId="project-1" />);

    fireEvent.click(await screen.findByTestId('infra-spend-enable'));

    await waitFor(() =>
      expect(updateInfraSpendConfig).toHaveBeenCalledWith('project-1', { enabled: true }),
    );
    // Repainted from the PUT response rather than a second billed-cache read.
    expect(await screen.findByTestId('infra-spend-chart')).toBeTruthy();
    expect(getInfraSpend).toHaveBeenCalledTimes(1);
  });

  it('renders the trend and the ranked services once enabled', async () => {
    getInfraSpend.mockResolvedValue(populated as any);
    render(<InfraSpendPanel projectId="project-1" />);

    expect(await screen.findByTestId('infra-spend-total')).toHaveTextContent('$30.00');
    expect(screen.getAllByTestId('infra-spend-service-row')).toHaveLength(2);
    expect(screen.getByTestId('infra-spend-services')).toHaveTextContent('AmazonEC2');
    expect(screen.getByTestId('infra-spend-services')).toHaveTextContent('$18.00');
    // The most recent day is always an AWS estimate, and the distinction is
    // stated in words rather than left to the fill colour.
    expect(screen.getAllByTestId('infra-spend-bar-estimated')).toHaveLength(1);
    expect(screen.getByTestId('infra-spend-legend')).toHaveTextContent('estimates');
  });

  it('shows the truncated tail so the list cannot understate the bill', async () => {
    getInfraSpend.mockResolvedValue(populated as any);
    render(<InfraSpendPanel projectId="project-1" />);

    const other = await screen.findByTestId('infra-spend-other');
    expect(other).toHaveTextContent('Other services');
    expect(other).toHaveTextContent('$3.00');
  });

  it('omits the Other row when the ranked list is the whole bill', async () => {
    getInfraSpend.mockResolvedValue({ ...populated, totalUsd: 27 } as any);
    render(<InfraSpendPanel projectId="project-1" />);

    await screen.findByTestId('infra-spend-services');
    expect(screen.queryByTestId('infra-spend-other')).toBeNull();
  });

  it('reports cache age as a statement rather than as an error', async () => {
    getInfraSpend.mockResolvedValue(populated as any);
    render(<InfraSpendPanel projectId="project-1" />);

    const staleness = await screen.findByTestId('infra-spend-staleness');
    expect(staleness).toHaveTextContent('Updated 4h ago');
    // Staleness is normal at a 3x daily sync, so it must not be an alert.
    expect(screen.queryByTestId('infra-spend-error')).toBeNull();
    expect(screen.queryByTestId('infra-spend-failed')).toBeNull();
  });

  it('surfaces the reason the last sync failed', async () => {
    getInfraSpend.mockResolvedValue({
      ...populated,
      lastRun: {
        startedAt: 1,
        finishedAt: 2,
        status: 'failed',
        pages: 0,
        estimatedCostUsd: 0,
        errorMessage: 'AccessDeniedException: ce:GetCostAndUsage is not authorized',
      },
    } as any);
    render(<InfraSpendPanel projectId="project-1" />);

    const failure = await screen.findByTestId('infra-spend-failed');
    expect(failure).toHaveTextContent('ce:GetCostAndUsage is not authorized');
    // No IAM hint here: this message already names the missing grant.
    expect(screen.queryByTestId('infra-spend-data-unavailable')).toBeNull();
  });

  it('explains that DataUnavailable is a console action, not a permission', async () => {
    getInfraSpend.mockResolvedValue({
      ...populated,
      lastRun: {
        startedAt: 1,
        finishedAt: 2,
        status: 'failed',
        pages: 1,
        estimatedCostUsd: 0.01,
        errorMessage: 'DataUnavailableException: Cost Explorer is not enabled',
      },
    } as any);
    render(<InfraSpendPanel projectId="project-1" />);

    const hint = await screen.findByTestId('infra-spend-data-unavailable');
    expect(hint).toHaveTextContent('Billing console');
    expect(hint).toHaveTextContent('No IAM permission change will fix this');
  });

  it('labels amounts in the payer account currency rather than always in dollars', async () => {
    getInfraSpend.mockResolvedValue({ ...populated, unit: 'EUR' } as any);
    render(<InfraSpendPanel projectId="project-1" />);

    expect(await screen.findByTestId('infra-spend-total')).toHaveTextContent('30.00 EUR');
  });

  it('says nothing is cached yet rather than drawing an empty plot', async () => {
    getInfraSpend.mockResolvedValue({ ...disabled, enabled: true } as any);
    render(<InfraSpendPanel projectId="project-1" />);

    expect(await screen.findByTestId('infra-spend-empty')).toHaveTextContent('No charges cached');
    expect(screen.queryByTestId('infra-spend-chart')).toBeNull();
  });

  it('reports a failed read without claiming the project has no spend', async () => {
    getInfraSpend.mockRejectedValue(new Error('spend read blew up'));
    render(<InfraSpendPanel projectId="project-1" />);

    expect(await screen.findByTestId('infra-spend-error')).toHaveTextContent('spend read blew up');
    expect(screen.queryByTestId('infra-spend-total')).toBeNull();
    expect(screen.queryByTestId('infra-spend-optin')).toBeNull();
  });
});

describe('InfraSpendPanel project switching', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getInfraSpend.mockResolvedValue(disabled as any);
    updateInfraSpendConfig.mockResolvedValue(disabled as any);
  });

  it('re-enables the opt-in button when the project changes mid-save', async () => {
    // The regression this pins. `saving` is local widget state, not fetched
    // data, so the generation guard that stops one project's figures landing
    // under another project's header must not also be what clears it: an
    // in-flight write whose project changes never reaches a matching
    // generation, its `finally` is skipped, and the new project's buttons stay
    // disabled forever with no way back.
    let settleSave: (value: unknown) => void = () => {};
    updateInfraSpendConfig.mockReturnValue(
      new Promise((resolve) => {
        settleSave = resolve;
      }) as any,
    );

    const { rerender } = render(<InfraSpendPanel projectId="project-1" />);
    const enable = await screen.findByTestId('infra-spend-enable');
    fireEvent.click(enable);
    await waitFor(() => expect(screen.getByTestId('infra-spend-enable')).toBeDisabled());

    rerender(<InfraSpendPanel projectId="project-2" />);

    await waitFor(() => expect(screen.getByTestId('infra-spend-enable')).not.toBeDisabled());

    // The abandoned request settling afterwards must stay inert.
    settleSave(disabled);
    await waitFor(() => expect(screen.getByTestId('infra-spend-enable')).not.toBeDisabled());
  });

  it('lets the new project save after a switch stranded the previous one', async () => {
    let settleFirst: (value: unknown) => void = () => {};
    updateInfraSpendConfig.mockReturnValueOnce(
      new Promise((resolve) => {
        settleFirst = resolve;
      }) as any,
    );

    const { rerender } = render(<InfraSpendPanel projectId="project-1" />);
    fireEvent.click(await screen.findByTestId('infra-spend-enable'));
    rerender(<InfraSpendPanel projectId="project-2" />);
    await waitFor(() => expect(screen.getByTestId('infra-spend-enable')).not.toBeDisabled());

    updateInfraSpendConfig.mockResolvedValue({ ...disabled, enabled: true } as any);
    fireEvent.click(screen.getByTestId('infra-spend-enable'));

    await waitFor(() =>
      expect(updateInfraSpendConfig).toHaveBeenLastCalledWith('project-2', { enabled: true }),
    );
    // The new project's save completed on its own, which the stranded flag
    // would have prevented from ever starting.
    await screen.findByTestId('infra-spend-disable');
    settleFirst(disabled);
  });

  it('does not show one project’s figures under another project’s header', async () => {
    getInfraSpend.mockResolvedValueOnce(populated as any);
    const { rerender } = render(<InfraSpendPanel projectId="project-1" />);
    await screen.findByTestId('infra-spend-total');

    getInfraSpend.mockResolvedValue(disabled as any);
    rerender(<InfraSpendPanel projectId="project-2" />);

    await waitFor(() => expect(screen.queryByTestId('infra-spend-total')).toBeNull());
  });
});
