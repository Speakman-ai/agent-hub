/**
 * What the notes panel says when a chart cannot say it.
 *
 * The paid-feature section is the load-bearing part here (decision INFRA-COST:
 * "The UI states plainly which panels are empty because a paid AWS feature is
 * off, rather than rendering a broken chart"). A gated metric is never
 * requested for a resource without the feature, so those charts are not merely
 * empty — the series does not exist — and the only useful thing to render is
 * why, and what turning it on would cost.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import InfraServiceNotes from './InfraServiceNotes';
import type { InfraPackMetricWire, InfraServicePackWire } from '@shared/utils/infraPacks';

function metric(overrides: Partial<InfraPackMetricWire> = {}): InfraPackMetricWire {
  return {
    namespace: 'AWS/ECS',
    metricName: 'CPUUtilization',
    dimensions: ['ClusterName', 'ServiceName'],
    metricType: 'gauge',
    stat: 'Average',
    validStatistics: ['Average', 'Minimum', 'Maximum'],
    minPeriodSeconds: 60,
    availability: 'either',
    appliesTo: { universal: true, condition: '' },
    requiresFeature: null,
    description: 'CPU.',
    ...overrides,
  };
}

const ecsPack: InfraServicePackWire = {
  service: 'ecs',
  label: 'ECS',
  metrics: [
    metric(),
    metric({
      namespace: 'ECS/ContainerInsights',
      metricName: 'RunningTaskCount',
      requiresFeature: 'containerInsights',
    }),
    metric({
      namespace: 'ECS/ContainerInsights',
      metricName: 'RestartCount',
      requiresFeature: 'containerInsights',
    }),
  ],
  dimensions: [],
  absentMetrics: [],
  features: [
    {
      key: 'containerInsights',
      label: 'Container Insights',
      whenOff: 'The ECS/ContainerInsights metrics are not published for this cluster.',
      costNote: 'AWS charges Container Insights metrics as CloudWatch custom metrics.',
      docsUrl: 'https://docs.aws.amazon.com/AmazonECS/latest/developerguide/x.html',
    },
  ],
  defaultAlertRules: [],
};

const service = (features: Record<string, boolean>) => ({ service: 'ecs', features });

describe('InfraServiceNotes — paid feature notices', () => {
  it('says the feature is off, what it hides, and what it costs', () => {
    render(<InfraServiceNotes pack={ecsPack} resource={service({ containerInsights: false })} />);

    const panel = screen.getByTestId('infra-feature-off-containerInsights');
    expect(panel).toHaveTextContent('Container Insights is off for this resource');
    expect(panel).toHaveTextContent('not published for this cluster');
    // The cost claim is the whole reason the panel exists — an operator cannot
    // weigh "turn it on" without it.
    expect(panel).toHaveTextContent('custom metrics');
    expect(panel).toHaveTextContent('RestartCount, RunningTaskCount');
  });

  it('links AWS’s own page, so the cost claim is checkable', () => {
    render(<InfraServiceNotes pack={ecsPack} resource={service({ containerInsights: false })} />);

    const link = screen.getByRole('link', { name: 'AWS documentation' });
    expect(link).toHaveAttribute('href', ecsPack.features[0].docsUrl);
    // Opened out of the app, and `noreferrer` so the target cannot reach back
    // through `window.opener`.
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('says nothing once the feature is on', () => {
    render(<InfraServiceNotes pack={ecsPack} resource={service({ containerInsights: true })} />);
    expect(screen.queryByTestId('infra-feature-off-containerInsights')).toBeNull();
  });

  it('treats an unrecorded feature as off, matching the collector', () => {
    // The collector refuses to spend on a feature it cannot confirm, so the UI
    // must not imply the charts are merely late.
    render(<InfraServiceNotes pack={ecsPack} resource={{ service: 'ecs' }} />);
    expect(screen.getByTestId('infra-feature-off-containerInsights')).toBeInTheDocument();
  });

  it('claims nothing with no resource selected', () => {
    // Container Insights is a property of one cluster, not of the project.
    render(<InfraServiceNotes pack={ecsPack} />);
    expect(screen.queryByTestId('infra-feature-off-containerInsights')).toBeNull();
  });

  it('renders no feature section for a pack that gates nothing', () => {
    const ec2: InfraServicePackWire = {
      ...ecsPack,
      service: 'ec2',
      label: 'EC2',
      features: [],
      metrics: [metric({ namespace: 'AWS/EC2', dimensions: ['InstanceId'] })],
    };
    render(<InfraServiceNotes pack={ec2} resource={{ service: 'ec2' }} />);
    expect(screen.queryByTestId('infra-feature-off-containerInsights')).toBeNull();
  });
});
