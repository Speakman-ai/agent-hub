import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import { api } from '../../utils/api.js';
import type { QuotaHeadroomResponse, QuotaHeadroomWire } from '@shared/utils/quotaHeadroom';
import InfraQuotaHeadroomPanel from './InfraQuotaHeadroomPanel';

(vi as any).mock('../../utils/api.js', () => ({
  api: { getInfraQuotas: vi.fn() },
}));

function quota(overrides: Partial<QuotaHeadroomWire> = {}): QuotaHeadroomWire {
  return {
    resourceKey: `key-${overrides.quotaCode ?? 'L-VCPU'}`,
    accountId: '123456789012',
    region: 'us-east-1',
    serviceCode: 'ec2',
    quotaCode: 'L-VCPU',
    quotaName: 'Running On-Demand Standard instances',
    limit: 640,
    unit: 'None',
    adjustable: true,
    usage: 512,
    usageAtMs: 1_700_000_000_000,
    metricName: 'ResourceCount',
    utilizationPercent: 80,
    headroom: 128,
    band: 'ok',
    ...overrides,
  };
}

function body(quotas: QuotaHeadroomWire[]): QuotaHeadroomResponse {
  const summary = { critical: 0, warning: 0, ok: 0, unknown: 0, total: quotas.length };
  for (const q of quotas) summary[q.band] += 1;
  return {
    quotas,
    summary,
    thresholds: { warning: 80, critical: 100 },
    expression: 'm1/SERVICE_QUOTA(m1)*100',
    staleAfterMs: 1_800_000,
  };
}

const empty = body([]);

beforeEach(() => {
  vi.resetAllMocks();
  // Fake timers so the 60s poll can be driven deterministically; the stale
  // banner only appears on a *refresh* failure, which needs a second tick.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.mocked(api.getInfraQuotas).mockResolvedValue(empty);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('InfraQuotaHeadroomPanel', () => {
  it('says no quotas are watched rather than drawing an empty list', async () => {
    render(<InfraQuotaHeadroomPanel projectId="project-1" />);
    expect(await screen.findByTestId('infra-quota-empty')).toBeTruthy();
    expect(screen.queryByTestId('infra-quota-list')).toBeNull();
  });

  it('explains in the empty state that most quotas cannot be measured', async () => {
    // Otherwise an operator who adds a quota scope and sees three rows out of
    // hundreds of quotas reasonably concludes the feature is broken.
    render(<InfraQuotaHeadroomPanel projectId="project-1" />);
    const el = await screen.findByTestId('infra-quota-empty');
    expect(el.textContent).toMatch(/minority/i);
    expect(el.textContent).toMatch(/AWS\/Usage/);
  });

  it('renders utilization and remaining headroom for a measured quota', async () => {
    vi.mocked(api.getInfraQuotas).mockResolvedValue(body([quota()]));
    render(<InfraQuotaHeadroomPanel projectId="project-1" />);

    expect((await screen.findByTestId('infra-quota-utilization')).textContent).toBe('80%');
    // The absolute number the percentage cannot give.
    expect(screen.getByTestId('infra-quota-remaining').textContent).toBe('128 left');
  });

  it('shows an over-quota reading rather than capping the number at 100%', async () => {
    vi.mocked(api.getInfraQuotas).mockResolvedValue(
      body([quota({ utilizationPercent: 140, headroom: 0, band: 'critical' })]),
    );
    render(<InfraQuotaHeadroomPanel projectId="project-1" />);
    expect((await screen.findByTestId('infra-quota-utilization')).textContent).toBe('140%');
    expect((await screen.findByTestId('infra-quota-row')).getAttribute('data-band')).toBe(
      'critical',
    );
  });

  it('explains an unmeasured quota instead of showing a bare dash', async () => {
    // A dash with no explanation reads as a bug. The two causes need different
    // actions, so the row says which one applies.
    vi.mocked(api.getInfraQuotas).mockResolvedValue(
      body([quota({ limit: null, utilizationPercent: null, headroom: null, band: 'unknown' })]),
    );
    render(<InfraQuotaHeadroomPanel projectId="project-1" />);

    expect((await screen.findByTestId('infra-quota-utilization')).textContent).toBe('—');
    expect((await screen.findByTestId('infra-quota-unknown-reason')).textContent).toMatch(
      /no applied value/i,
    );
    // And no "0 left", which would claim headroom we never measured.
    expect(screen.queryByTestId('infra-quota-remaining')).toBeNull();
  });

  it('leads the summary with what needs action', async () => {
    vi.mocked(api.getInfraQuotas).mockResolvedValue(
      body([
        quota({ quotaCode: 'L-A', utilizationPercent: 140, band: 'critical' }),
        quota({ quotaCode: 'L-B', utilizationPercent: 92, band: 'warning' }),
        quota({ quotaCode: 'L-C' }),
      ]),
    );
    render(<InfraQuotaHeadroomPanel projectId="project-1" />);
    expect((await screen.findByTestId('infra-quota-summary')).textContent).toBe(
      '1 at or over quota, 1 near quota of 3 watched',
    );
  });

  it('cites the AWS expression so the number can be diffed against the console', async () => {
    vi.mocked(api.getInfraQuotas).mockResolvedValue(body([quota()]));
    render(<InfraQuotaHeadroomPanel projectId="project-1" />);
    const legend = await screen.findByTestId('infra-quota-legend');
    expect(legend.textContent).toContain('m1/SERVICE_QUOTA(m1)*100');
    // And that over-100% is expected rather than a rendering fault.
    expect(legend.textContent).toMatch(/over\s*\n?\s*100%/);
  });

  it('collapses a long list but says how many it hid', async () => {
    // A silent truncation reads as "that is all of them".
    const many = Array.from({ length: 12 }, (_, i) => quota({ quotaCode: `L-${i}` }));
    vi.mocked(api.getInfraQuotas).mockResolvedValue(body(many));
    render(<InfraQuotaHeadroomPanel projectId="project-1" />);

    expect(await screen.findAllByTestId('infra-quota-row')).toHaveLength(8);
    const more = screen.getByTestId('infra-quota-show-all');
    expect(more.textContent).toBe('Show 4 more');

    fireEvent.click(more);
    await waitFor(() => expect(screen.getAllByTestId('infra-quota-row')).toHaveLength(12));
  });

  it('survives a synchronous throw from the API layer', async () => {
    // This panel sits last on the Overview tab beside the scope editor and the
    // spend panel. A synchronous throw escapes the promise chain and unmounts
    // the whole tab, so the least critical panel would take the others down.
    vi.mocked(api.getInfraQuotas).mockImplementation(() => {
      throw new Error('api unavailable');
    });
    render(<InfraQuotaHeadroomPanel projectId="project-1" />);
    expect((await screen.findByTestId('infra-quota-error')).textContent).toBe('api unavailable');
  });

  it('flags retained readings as stale when a refresh fails', async () => {
    // The reviewer-caught regression, and the one this panel is least allowed
    // to have: after a successful load, a failed poll left the previous
    // readings rendered exactly like fresh ones. During an outage the panel
    // would show reassuring capacity figures with no hint they had frozen —
    // undoing, client-side, the staleness bound the server enforces.
    vi.mocked(api.getInfraQuotas).mockResolvedValueOnce(body([quota()]));
    render(<InfraQuotaHeadroomPanel projectId="project-1" />);
    expect((await screen.findByTestId('infra-quota-utilization')).textContent).toBe('80%');
    expect(screen.queryByTestId('infra-quota-stale')).toBeNull();

    // Second poll fails.
    vi.mocked(api.getInfraQuotas).mockRejectedValue(new Error('network down'));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    const stale = await screen.findByTestId('infra-quota-stale');
    expect(stale.textContent).toContain('Refresh failed: network down');
    // The readings stay — a last-known value beats a blank panel, and the
    // operator is the one who can judge whether it is still good enough.
    expect(screen.getByTestId('infra-quota-utilization').textContent).toBe('80%');
  });

  it('clears the stale banner once a refresh succeeds again', async () => {
    vi.mocked(api.getInfraQuotas).mockResolvedValueOnce(body([quota()]));
    render(<InfraQuotaHeadroomPanel projectId="project-1" />);
    await screen.findByTestId('infra-quota-utilization');

    vi.mocked(api.getInfraQuotas).mockRejectedValueOnce(new Error('blip'));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await screen.findByTestId('infra-quota-stale');

    vi.mocked(api.getInfraQuotas).mockResolvedValue(
      body([quota({ utilizationPercent: 92, band: 'warning' })]),
    );
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    await waitFor(() => expect(screen.queryByTestId('infra-quota-stale')).toBeNull());
    expect(screen.getByTestId('infra-quota-utilization').textContent).toBe('92%');
  });

  it('surfaces a read failure as an error rather than an empty panel', async () => {
    vi.mocked(api.getInfraQuotas).mockRejectedValue(new Error('boom'));
    render(<InfraQuotaHeadroomPanel projectId="project-1" />);
    expect((await screen.findByTestId('infra-quota-error')).textContent).toBe('boom');
    expect(screen.queryByTestId('infra-quota-list')).toBeNull();
  });
});

describe('InfraQuotaHeadroomPanel project switching', () => {
  it('does not paint a stale project’s quotas over the current one', async () => {
    // The failure this prevents: a slow read for project-1 resolving after the
    // operator switched to project-2, showing another account's quotas.
    let settleFirst: (value: QuotaHeadroomResponse) => void = () => {};
    vi.mocked(api.getInfraQuotas).mockReturnValueOnce(
      new Promise<QuotaHeadroomResponse>((resolve) => {
        settleFirst = resolve;
      }),
    );

    const { rerender } = render(<InfraQuotaHeadroomPanel projectId="project-1" />);

    vi.mocked(api.getInfraQuotas).mockResolvedValue(body([quota({ quotaName: 'Project two' })]));
    rerender(<InfraQuotaHeadroomPanel projectId="project-2" />);
    await screen.findByText('Project two');

    // Now let the abandoned project-1 read land.
    settleFirst(body([quota({ quotaName: 'Project one' })]));
    await waitFor(() => expect(screen.queryByText('Project one')).toBeNull());
    expect(screen.getByText('Project two')).toBeTruthy();
  });

  it('clears the expanded state when the project changes', async () => {
    // Otherwise project B opens pre-expanded because project A was, which
    // silently changes how much of B's list the operator thinks exists.
    const many = Array.from({ length: 12 }, (_, i) => quota({ quotaCode: `L-${i}` }));
    vi.mocked(api.getInfraQuotas).mockResolvedValue(body(many));

    const { rerender } = render(<InfraQuotaHeadroomPanel projectId="project-1" />);
    fireEvent.click(await screen.findByTestId('infra-quota-show-all'));
    await waitFor(() => expect(screen.getAllByTestId('infra-quota-row')).toHaveLength(12));

    rerender(<InfraQuotaHeadroomPanel projectId="project-2" />);
    await waitFor(() => expect(screen.getAllByTestId('infra-quota-row')).toHaveLength(8));
    expect(screen.getByTestId('infra-quota-show-all')).toBeTruthy();
  });
});
