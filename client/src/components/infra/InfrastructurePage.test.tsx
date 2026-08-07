import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import InfrastructurePage from './InfrastructurePage';
import { api } from '../../utils/api';

// The Overview tab embeds the scope editor, which loads from the API on mount.
(vi as any).mock('../../utils/api.js', () => ({
  api: {
    getInfraScopes: vi.fn(),
    updateInfraScopes: vi.fn(),
    projectInfraCost: vi.fn(),
    // The Overview tab also embeds the spend panel, which reads the cached
    // Cost Explorer trend on mount and polls it.
    getInfraSpend: vi.fn(),
    updateInfraSpendConfig: vi.fn(),
    // The Resources tab embeds the inventory browser, which polls on mount.
    listInfraResources: vi.fn(),
    listInfraMetricSeries: vi.fn(),
    getInfraMetricRange: vi.fn(),
    getInfraMetricPacks: vi.fn(),
  },
}));

const getInfraScopes = vi.mocked(api.getInfraScopes);
const listInfraResources = vi.mocked(api.listInfraResources);
const getInfraMetricPacks = vi.mocked(api.getInfraMetricPacks);
const getInfraSpend = vi.mocked(api.getInfraSpend);

const ec2Pack = {
  service: 'ec2',
  label: 'EC2',
  metrics: [
    {
      namespace: 'AWS/EC2',
      metricName: 'CPUUtilization',
      dimensions: ['InstanceId'],
      metricType: 'gauge' as const,
      stat: 'Average',
      validStatistics: ['Average', 'Minimum', 'Maximum'],
      minPeriodSeconds: 300,
      availability: 'either' as const,
      appliesTo: { universal: true, condition: '' },
      requiresFeature: null,
      description: 'Percentage of physical CPU time the instance used.',
    },
    {
      namespace: 'AWS/EC2',
      metricName: 'CPUCreditBalance',
      dimensions: ['InstanceId'],
      metricType: 'balance' as const,
      stat: 'Minimum',
      validStatistics: ['Sum', 'Average', 'Minimum', 'Maximum'],
      minPeriodSeconds: 300,
      availability: 'either' as const,
      appliesTo: {
        universal: false,
        condition: 'Burstable performance (T-family) instances only.',
      },
      requiresFeature: null,
      description: 'CPU credits accrued and unspent.',
    },
  ],
  dimensions: [
    { name: 'InstanceId', detailedMonitoringOnly: false, description: 'One instance.' },
    { name: 'ImageId', detailedMonitoringOnly: true, description: 'Every instance on one AMI.' },
  ],
  features: [],
  absentMetrics: [
    {
      label: 'Memory utilization',
      reason: 'EC2 has no memory metric. The hypervisor cannot see inside the guest.',
      remedy: 'Install the CloudWatch agent; it publishes memory to the CWAgent namespace.',
    },
  ],
  defaultAlertRules: [
    {
      name: 'EC2 status check failed',
      description: 'The instance failed a status check in two consecutive minutes.',
      namespace: 'AWS/EC2',
      metricName: 'StatusCheckFailed',
      stat: 'Maximum',
      dimensions: ['InstanceId'],
      periodS: 60,
      threshold: 1,
      comparisonOperator: 'GreaterThanOrEqualToThreshold' as const,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: 'missing' as const,
      severity: 'critical' as const,
      rationale: 'AWS best-practice alarm.',
    },
  ],
};

const emptyResources = {
  resources: [],
  nextCursor: null,
  facets: {
    services: [],
    regions: [],
    accounts: [],
    environments: [],
    states: [],
    tagKeys: [],
    total: 0,
  },
  staleAfterMs: 24 * 60 * 60 * 1000,
};

/** A project that never opted into the billed Cost Explorer poll. */
const optedOutSpend = {
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

const emptyScopes = {
  scopes: [],
  projection: { metricsRequestedPerMonth: 0, estimatedMonthlyCostUsd: 0, perScope: [] },
  collectableServices: ['ec2'],
  uncollectableServices: [],
  monthlyCeilingUsd: null,
  degradation: 'normal',
  maxScopes: 200,
  configured: false,
};

describe('InfrastructurePage', () => {
  beforeEach(() => {
    // resetAllMocks, not clearAllMocks: `clear` leaves queued `…Once` values
    // in place, which makes the suite order-dependent.
    vi.resetAllMocks();
    getInfraScopes.mockResolvedValue(emptyScopes as any);
    listInfraResources.mockResolvedValue(emptyResources as any);
    getInfraMetricPacks.mockResolvedValue({ packs: [ec2Pack] } as any);
    getInfraSpend.mockResolvedValue(optedOutSpend as any);
  });
  const readyStatus = { profile: 'monitoring', region: 'us-east-1', reachable: true };

  it('switches between Overview, Resources, Metrics, and Alerts tabs', () => {
    render(
      <InfrastructurePage
        projectId="project-1"
        projectName="Demo"
        monitoringStatus={readyStatus}
        scopeConfigured
      />,
    );

    expect(screen.getByRole('tabpanel')).toHaveTextContent('Monitoring profile ready');
    fireEvent.click(screen.getByRole('tab', { name: 'Resources' }));
    expect(screen.getByTestId('infra-resource-browser')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    expect(screen.getByTestId('infra-metrics-no-resource')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Alerts' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('No infrastructure alert rules');
  });

  it('renders the no monitoring profile state distinctly', () => {
    render(
      <InfrastructurePage
        projectId="project-1"
        monitoringStatus={{
          reachable: false,
          code: 'monitoring_profile_required',
          reason: 'not_designated',
        }}
      />,
    );
    expect(screen.getByTestId('infra-empty-monitoring-profile')).toHaveTextContent(
      'no monitoring profile designated',
    );
  });

  it('renders the no scope state distinctly', () => {
    render(
      <InfrastructurePage
        projectId="project-1"
        monitoringStatus={readyStatus}
        scopeConfigured={false}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Resources' }));
    expect(screen.getByTestId('infra-empty-scope')).toHaveTextContent('no scope configured');
  });

  it('does not carry one project’s live scope state into the next project', async () => {
    // Regression: liveScopeConfigured survived a project switch, so project-b's
    // Resources/Metrics/Alerts tabs were gated on project-a's answer until the
    // new request settled.
    const scoped = {
      ...emptyScopes,
      scopes: [{ id: 's1', enabled: true, profileName: 'm', region: 'us-east-2', service: 'ec2' }],
      configured: true,
    };
    getInfraScopes.mockResolvedValueOnce(scoped as any).mockImplementationOnce(
      () => new Promise(() => {}), // project-b's load never settles
    );

    const { rerender } = render(
      <InfrastructurePage projectId="project-a" monitoringStatus={readyStatus} />,
    );
    // project-a has a scope, so the Resources tab shows inventory, not the
    // empty state.
    fireEvent.click(screen.getByRole('tab', { name: 'Resources' }));
    await waitFor(() => expect(screen.getByTestId('infra-resource-browser')).toBeTruthy());

    rerender(
      <InfrastructurePage
        projectId="project-b"
        monitoringStatus={readyStatus}
        scopeConfigured={false}
      />,
    );

    // While project-b is still unknown, its own props decide — not project-a's
    // stale answer.
    expect(screen.getByTestId('infra-empty-scope')).toHaveTextContent('no scope configured');
  });

  /**
   * The scope editor is authoritative once its load settles, so a test that
   * awaits anything must hand it a configured scope or the tab falls back to
   * the no-scope empty state mid-assertion.
   */
  const scopedScopes = {
    ...emptyScopes,
    scopes: [{ id: 's1', enabled: true, profileName: 'm', region: 'us-east-2', service: 'ec2' }],
    configured: true,
  };

  it('states on the Alerts tab why memory and disk usage are absent, and what to do about it', async () => {
    getInfraScopes.mockResolvedValue(scopedScopes as any);
    render(
      <InfrastructurePage projectId="project-1" monitoringStatus={readyStatus} scopeConfigured />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Alerts' }));

    const notes = await screen.findByTestId('infra-service-notes');
    expect(notes).toHaveTextContent('Memory utilization');
    expect(notes).toHaveTextContent('hypervisor cannot see inside the guest');
    // The remedy is the paid custom-metric path, and naming it is the point.
    expect(notes).toHaveTextContent('CloudWatch agent');
    expect(notes).toHaveTextContent('CWAgent');
  });

  it('lists metrics only some resources publish, with the condition', async () => {
    getInfraScopes.mockResolvedValue(scopedScopes as any);
    render(
      <InfrastructurePage projectId="project-1" monitoringStatus={readyStatus} scopeConfigured />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Alerts' }));

    const conditional = await screen.findByTestId('infra-service-notes-conditional');
    expect(conditional).toHaveTextContent('CPUCreditBalance');
    expect(conditional).toHaveTextContent('T-family');
    // A universally published metric earns no caveat — otherwise every metric
    // carries a warning and none of them mean anything.
    expect(conditional).not.toHaveTextContent('CPUUtilization');
  });

  it('offers the recommended alert rules on the Alerts tab, marked as not yet active', async () => {
    getInfraScopes.mockResolvedValue(scopedScopes as any);
    render(
      <InfrastructurePage projectId="project-1" monitoringStatus={readyStatus} scopeConfigured />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Alerts' }));

    const rules = await screen.findByTestId('infra-service-default-rules');
    expect(rules).toHaveTextContent('EC2 status check failed');
    expect(rules).toHaveTextContent('StatusCheckFailed Maximum >= 1 for 2 × 60s');
    expect(rules).toHaveTextContent('critical');
    expect(rules).toHaveTextContent('Nothing here is active until you create it as a rule.');
  });

  it('does not show the recommended rules on the Metrics tab', async () => {
    getInfraScopes.mockResolvedValue(scopedScopes as any);
    render(
      <InfrastructurePage projectId="project-1" monitoringStatus={readyStatus} scopeConfigured />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Alerts' }));
    await screen.findByTestId('infra-service-default-rules');

    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    expect(screen.queryByTestId('infra-service-default-rules')).toBeNull();
  });

  it('says on the Metrics tab which metrics a disabled AWS feature is hiding', async () => {
    // The concrete replacement for the old blanket "some paid feature is off"
    // banner: named metrics, the reason, and what AWS charges to turn it on.
    // Decision INFRA-COST — the operator has to be able to weigh the trade.
    const ecsPack = {
      service: 'ecs',
      label: 'ECS',
      metrics: [
        {
          namespace: 'ECS/ContainerInsights',
          metricName: 'RunningTaskCount',
          dimensions: ['ClusterName', 'ServiceName'],
          metricType: 'gauge' as const,
          stat: 'Minimum',
          validStatistics: ['Average', 'Minimum', 'Maximum'],
          minPeriodSeconds: 60,
          availability: 'either' as const,
          appliesTo: { universal: true, condition: '' },
          requiresFeature: 'containerInsights',
          description: 'Tasks running.',
        },
      ],
      dimensions: [],
      features: [
        {
          key: 'containerInsights',
          label: 'Container Insights',
          whenOff: 'The ECS/ContainerInsights metrics are not published for this cluster.',
          costNote: 'AWS charges Container Insights metrics as CloudWatch custom metrics.',
          docsUrl: 'https://docs.aws.amazon.com/AmazonECS/latest/developerguide/x.html',
        },
      ],
      absentMetrics: [],
      defaultAlertRules: [],
    };
    getInfraMetricPacks.mockResolvedValue({ packs: [ecsPack] } as any);
    getInfraScopes.mockResolvedValue(scopedScopes as any);
    // Nothing is stored for a gated series, which is the point — the panel has
    // to explain the empty picker rather than the chart explaining itself.
    vi.mocked(api.listInfraMetricSeries).mockResolvedValue({ series: [] } as any);
    listInfraResources.mockResolvedValue({
      ...emptyResources,
      resources: [
        {
          resourceKey: 'k-api',
          accountId: '111122223333',
          region: 'us-east-1',
          service: 'ecs',
          resourceId: 'prod/api',
          name: 'api',
          environment: null,
          state: 'ACTIVE',
          tags: {},
          metricDimensions: { ClusterName: 'prod', ServiceName: 'api' },
          features: { containerInsights: false },
          firstSeen: 1,
          lastSeen: Date.now(),
        },
      ],
    } as any);

    render(
      <InfrastructurePage projectId="project-1" monitoringStatus={readyStatus} scopeConfigured />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Resources' }));
    fireEvent.click(await screen.findByTestId('infra-resource-row'));

    const panel = await screen.findByTestId('infra-feature-off-containerInsights');
    expect(panel).toHaveTextContent('Container Insights is off for this resource');
    expect(panel).toHaveTextContent('custom metrics');
    expect(panel).toHaveTextContent('RunningTaskCount');
  });

  it('renders the module normally when the pack catalog cannot be loaded', async () => {
    // A missing caveat is a worse chart, not a broken one.
    getInfraMetricPacks.mockRejectedValue(new Error('nope'));
    getInfraScopes.mockResolvedValue(scopedScopes as any);
    render(
      <InfrastructurePage projectId="project-1" monitoringStatus={readyStatus} scopeConfigured />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Alerts' }));

    await waitFor(() => expect(getInfraMetricPacks).toHaveBeenCalled());
    expect(screen.getByRole('tabpanel')).toHaveTextContent('No infrastructure alert rules');
    expect(screen.queryByTestId('infra-service-notes')).toBeNull();
  });
});
