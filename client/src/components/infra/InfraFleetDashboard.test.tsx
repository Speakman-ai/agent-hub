import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import { api } from '../../utils/api.js';
import type {
  InfraFleetMetricWire,
  InfraFleetResourceWire,
  InfraFleetWire,
} from '@shared/utils/infraFleet';
import InfraFleetDashboard from './InfraFleetDashboard';

(vi as any).mock('../../utils/api.js', () => ({
  api: { getInfraFleet: vi.fn() },
}));

const NOW = 1_700_000_000_000;

function metric(overrides: Partial<InfraFleetMetricWire> = {}): InfraFleetMetricWire {
  return {
    metricName: 'CPUUtilization',
    namespace: 'AWS/EC2',
    stat: 'Average',
    label: 'CPU',
    unit: 'percent',
    description: 'Percentage of physical CPU time the instance used.',
    latest: 42,
    latestTsMs: NOW,
    min: 10,
    max: 60,
    points: [
      { tsMs: NOW - 600_000, value: 10 },
      { tsMs: NOW - 300_000, value: 60 },
      { tsMs: NOW, value: 42 },
    ],
    ...overrides,
  };
}

function resource(overrides: Partial<InfraFleetResourceWire> = {}): InfraFleetResourceWire {
  return {
    resourceKey: 'key-i-0abc',
    service: 'ec2',
    resourceId: 'i-0abc',
    name: 'web-1',
    region: 'us-east-1',
    accountId: '123456789012',
    environment: 'prod',
    state: 'running',
    lastSeen: NOW,
    metricDimensions: { InstanceId: 'i-0abc' },
    features: null,
    metrics: [metric()],
    ...overrides,
  };
}

function body(overrides: Partial<InfraFleetWire> = {}): InfraFleetWire {
  return {
    fromMs: NOW - 3 * 60 * 60 * 1000,
    toMs: NOW,
    bucketSeconds: 300,
    services: ['ec2', 'ecs', 'rds'],
    resources: [resource()],
    truncated: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(api.getInfraFleet).mockReset();
  // Fake timers so the 60s poll can be driven deterministically; a refresh
  // failure only shows up on a second tick.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.mocked(api.getInfraFleet).mockResolvedValue(body());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('InfraFleetDashboard', () => {
  it('renders each headline metric without the operator clicking anything', async () => {
    // The whole point of the surface: the value and its trend are on screen
    // from the first paint, not behind a row click and a metric dropdown.
    render(<InfraFleetDashboard projectId="project-1" />);

    const tile = await screen.findByTestId('infra-fleet-metric-CPUUtilization');
    expect(tile.textContent).toContain('CPU');
    expect(tile.textContent).toContain('42%');
    expect(tile.querySelector('polyline')).toBeTruthy();
  });

  it('fills the whole grid from one request', async () => {
    vi.mocked(api.getInfraFleet).mockResolvedValue(
      body({
        resources: [
          resource({ resourceKey: 'k1', resourceId: 'i-1' }),
          resource({ resourceKey: 'k2', resourceId: 'i-2' }),
          resource({ resourceKey: 'k3', resourceId: 'i-3', service: 'rds' }),
        ],
      }),
    );

    render(<InfraFleetDashboard projectId="project-1" />);

    await screen.findByTestId('infra-fleet-card-k1');
    expect(screen.getByTestId('infra-fleet-card-k2')).toBeTruthy();
    expect(screen.getByTestId('infra-fleet-card-k3')).toBeTruthy();
    // Three resources with a metric each, one fetch. Building this out of the
    // per-metric endpoint would be one request per tile.
    expect(vi.mocked(api.getInfraFleet)).toHaveBeenCalledTimes(1);
  });

  it('shows a metric that reported nothing as an em-dash, never as zero', async () => {
    // A stopped instance and an idle one call for different responses; drawing
    // both as 0 hides the one worth acting on.
    vi.mocked(api.getInfraFleet).mockResolvedValue(
      body({
        resources: [
          resource({ metrics: [metric({ latest: null, latestTsMs: null, points: [] })] }),
        ],
      }),
    );

    render(<InfraFleetDashboard projectId="project-1" />);

    const tile = await screen.findByTestId('infra-fleet-metric-CPUUtilization');
    expect(tile.textContent).toContain('—');
    expect(tile.textContent).not.toContain('0%');
    // One value is not a trend, so no line is drawn through it.
    expect(tile.querySelector('polyline')).toBeNull();
  });

  it('hands the full selection to the Metrics tab when a card is clicked', async () => {
    const onSelect = vi.fn();
    render(<InfraFleetDashboard projectId="project-1" onSelectResource={onSelect} />);

    fireEvent.click(await screen.findByTestId('infra-fleet-card-key-i-0abc'));

    // Everything the chart and its availability notices read, so the tab does
    // not have to refetch the row the dashboard already had.
    expect(onSelect).toHaveBeenCalledWith({
      resourceKey: 'key-i-0abc',
      resourceId: 'i-0abc',
      name: 'web-1',
      service: 'ec2',
      region: 'us-east-1',
      metricDimensions: { InstanceId: 'i-0abc' },
      features: null,
    });
  });

  it('refetches with the chosen window', async () => {
    render(<InfraFleetDashboard projectId="project-1" />);
    await screen.findByTestId('infra-fleet-dashboard');

    fireEvent.click(screen.getByText('24h'));

    await waitFor(() => {
      expect(vi.mocked(api.getInfraFleet)).toHaveBeenLastCalledWith('project-1', {
        windowMs: 24 * 60 * 60 * 1000,
      });
    });
  });

  it('says nothing is being polled rather than drawing an empty grid', async () => {
    vi.mocked(api.getInfraFleet).mockResolvedValue(body({ resources: [] }));
    render(<InfraFleetDashboard projectId="project-1" />);

    expect((await screen.findByTestId('infra-fleet-empty')).textContent).toContain(
      'No EC2, ECS or RDS resources',
    );
  });

  it('does not claim the fleet is empty when the first read failed', async () => {
    // Never having heard from the server is not the same as the server saying
    // there is nothing. Presenting the second as the first sends an operator to
    // audit a collection scope that may be perfectly correct.
    vi.mocked(api.getInfraFleet).mockRejectedValue(new Error('gateway blew up'));

    render(<InfraFleetDashboard projectId="project-1" />);

    await screen.findByTestId('infra-fleet-error');
    expect(screen.queryByTestId('infra-fleet-empty')).toBeNull();
  });

  it('still claims nothing is polled when the server says so', async () => {
    // The other side of the same gate: an actual empty response must keep
    // producing the guidance, or the fix would have traded one silence for
    // another.
    vi.mocked(api.getInfraFleet).mockResolvedValue(body({ resources: [] }));

    render(<InfraFleetDashboard projectId="project-1" />);

    await screen.findByTestId('infra-fleet-empty');
    expect(screen.queryByTestId('infra-fleet-error')).toBeNull();
  });

  it('withdraws the empty state when a later read fails', async () => {
    // The empty claim was true when it was made; once the connection drops it
    // is no longer supported by anything, and the switch discards `data`.
    vi.mocked(api.getInfraFleet).mockResolvedValueOnce(body({ resources: [] }));
    const view = render(<InfraFleetDashboard projectId="project-1" />);
    await screen.findByTestId('infra-fleet-empty');

    vi.mocked(api.getInfraFleet).mockRejectedValue(new Error('gateway blew up'));
    view.rerender(<InfraFleetDashboard projectId="project-2" />);

    await screen.findByTestId('infra-fleet-error');
    expect(screen.queryByTestId('infra-fleet-empty')).toBeNull();
  });

  it('says more resources exist instead of silently truncating', async () => {
    vi.mocked(api.getInfraFleet).mockResolvedValue(body({ truncated: true }));
    render(<InfraFleetDashboard projectId="project-1" />);

    await screen.findByTestId('infra-fleet-dashboard');
    expect(screen.getByText(/more exist/)).toBeTruthy();
  });

  it('does not warn about a healthy ECS resource', async () => {
    // ECS reports `ACTIVE` (uppercase) for a normal cluster and service. A
    // predicate accepting only `running`/`available` painted the entire
    // happy-path ECS fleet amber.
    vi.mocked(api.getInfraFleet).mockResolvedValue(
      body({
        resources: [
          resource({ resourceKey: 'ecs-1', service: 'ecs', state: 'ACTIVE' }),
          resource({ resourceKey: 'lb-1', service: 'alb', state: 'active' }),
          resource({ resourceKey: 'ec2-1', service: 'ec2', state: 'running' }),
          resource({ resourceKey: 'rds-1', service: 'rds', state: 'available' }),
        ],
      }),
    );

    render(<InfraFleetDashboard projectId="project-1" />);

    await screen.findByTestId('infra-fleet-card-ecs-1');
    expect(screen.queryByTestId('infra-fleet-state-unhealthy')).toBeNull();
    expect(screen.queryByTestId('infra-fleet-state-unknown')).toBeNull();
  });

  it('warns about a genuinely stopped resource', async () => {
    vi.mocked(api.getInfraFleet).mockResolvedValue(
      body({ resources: [resource({ state: 'stopped' })] }),
    );

    render(<InfraFleetDashboard projectId="project-1" />);

    const badge = await screen.findByTestId('infra-fleet-state-unhealthy');
    expect(badge.textContent).toBe('stopped');
    expect(badge.className).toContain('amber');
  });

  it('shows an unrecognised state plainly instead of calling it a fault', async () => {
    // RDS has no closed enum for DBInstanceStatus, so an unknown value must not
    // be dressed up as an incident.
    vi.mocked(api.getInfraFleet).mockResolvedValue(
      body({ resources: [resource({ service: 'rds', state: 'storage-config-upgrade' })] }),
    );

    render(<InfraFleetDashboard projectId="project-1" />);

    const badge = await screen.findByTestId('infra-fleet-state-unknown');
    expect(badge.textContent).toBe('storage-config-upgrade');
    expect(badge.className).not.toContain('amber');
  });

  it('does not carry one project’s failure over to the next', async () => {
    // The replacement request never settles, which is the case that makes this
    // matter: a leftover banner would attribute project-1's failure to
    // project-2 and keep saying so indefinitely.
    vi.mocked(api.getInfraFleet)
      .mockRejectedValueOnce(new Error('project-1 is down'))
      .mockReturnValue(new Promise<InfraFleetWire>(() => {}) as any);

    const view = render(<InfraFleetDashboard projectId="project-1" />);
    expect((await screen.findByTestId('infra-fleet-error')).textContent).toContain(
      'project-1 is down',
    );

    view.rerender(<InfraFleetDashboard projectId="project-2" />);

    await waitFor(() => expect(screen.queryByTestId('infra-fleet-error')).toBeNull());
  });

  it('does not carry one window’s failure over to the next', async () => {
    vi.mocked(api.getInfraFleet)
      .mockRejectedValueOnce(new Error('3h read failed'))
      .mockReturnValue(new Promise<InfraFleetWire>(() => {}) as any);

    render(<InfraFleetDashboard projectId="project-1" />);
    expect((await screen.findByTestId('infra-fleet-error')).textContent).toContain(
      '3h read failed',
    );

    fireEvent.click(screen.getByText('24h'));

    await waitFor(() => expect(screen.queryByTestId('infra-fleet-error')).toBeNull());
  });

  it('ignores an overlapping poll that resolves after a newer one', async () => {
    // The 60s interval fires whether or not the previous read came back, so a
    // slow request can still be in flight when the next starts. If the stale
    // response is allowed to land last, the dashboard silently shows the past.
    let resolveSlow: (value: InfraFleetWire) => void = () => {};
    let resolveFresh: (value: InfraFleetWire) => void = () => {};
    const slow = new Promise<InfraFleetWire>((resolve) => {
      resolveSlow = resolve;
    });
    const fresh = new Promise<InfraFleetWire>((resolve) => {
      resolveFresh = resolve;
    });

    vi.mocked(api.getInfraFleet)
      .mockReturnValueOnce(slow as any)
      .mockReturnValueOnce(fresh as any);

    render(<InfraFleetDashboard projectId="project-1" />);

    // Second poll starts while the first is still outstanding.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(vi.mocked(api.getInfraFleet)).toHaveBeenCalledTimes(2);

    // The newer request wins the race.
    await act(async () => {
      resolveFresh(body({ resources: [resource({ metrics: [metric({ latest: 99 })] })] }));
      await fresh;
    });
    expect(screen.getByTestId('infra-fleet-metric-CPUUtilization').textContent).toContain('99%');

    // …and the older one, landing afterwards, must not undo it.
    await act(async () => {
      resolveSlow(body({ resources: [resource({ metrics: [metric({ latest: 11 })] })] }));
      await slow;
    });
    expect(screen.getByTestId('infra-fleet-metric-CPUUtilization').textContent).toContain('99%');
    expect(screen.getByTestId('infra-fleet-metric-CPUUtilization').textContent).not.toContain(
      '11%',
    );
  });

  it('drops an in-flight response for a window the operator has left', async () => {
    let resolveStale: (value: InfraFleetWire) => void = () => {};
    const stale = new Promise<InfraFleetWire>((resolve) => {
      resolveStale = resolve;
    });
    vi.mocked(api.getInfraFleet)
      .mockReturnValueOnce(stale as any)
      .mockResolvedValue(body({ resources: [resource({ metrics: [metric({ latest: 77 })] })] }));

    render(<InfraFleetDashboard projectId="project-1" />);
    fireEvent.click(screen.getByText('24h'));

    await waitFor(() =>
      expect(screen.getByTestId('infra-fleet-metric-CPUUtilization').textContent).toContain('77%'),
    );

    // The 3h request finally answers. It describes a window that is no longer
    // on screen, so it must be discarded rather than painted under the 24h tab.
    await act(async () => {
      resolveStale(body({ resources: [resource({ metrics: [metric({ latest: 5 })] })] }));
      await stale;
    });
    expect(screen.getByTestId('infra-fleet-metric-CPUUtilization').textContent).toContain('77%');
  });

  it('keeps the last readings on a failed refresh and says so', async () => {
    render(<InfraFleetDashboard projectId="project-1" />);
    await screen.findByTestId('infra-fleet-metric-CPUUtilization');

    vi.mocked(api.getInfraFleet).mockRejectedValue(new Error('gateway blew up'));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    // Blanking the grid on a blip throws away a still-useful last-known value;
    // the banner is what stops it reading as current.
    expect((await screen.findByTestId('infra-fleet-error')).textContent).toContain(
      'gateway blew up',
    );
    expect(screen.getByTestId('infra-fleet-metric-CPUUtilization').textContent).toContain('42%');
  });
});
