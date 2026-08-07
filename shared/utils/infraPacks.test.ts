import { describe, it, expect } from 'vitest';
import {
  featureNotices,
  findServicePack,
  findPackMetric,
  metricCaveats,
  notesPackFor,
  resourceHasFeature,
  sameDimensionSet,
  summarizeDefaultRule,
  type InfraPackMetricWire,
  type InfraServicePackWire,
} from './infraPacks.js';

function metric(overrides: Partial<InfraPackMetricWire> = {}): InfraPackMetricWire {
  return {
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    dimensions: ['InstanceId'],
    metricType: 'gauge',
    stat: 'Average',
    validStatistics: ['Average', 'Minimum', 'Maximum'],
    minPeriodSeconds: 300,
    availability: 'either',
    appliesTo: { universal: true, condition: '' },
    requiresFeature: null,
    description: 'CPU.',
    ...overrides,
  };
}

const pack: InfraServicePackWire = {
  service: 'ec2',
  label: 'EC2',
  metrics: [
    metric(),
    metric({ metricName: 'StatusCheckFailed', metricType: 'flag', stat: 'Maximum' }),
    metric({
      metricName: 'EBSIOBalance%',
      metricType: 'balance',
      stat: 'Minimum',
      availability: 'basic-only',
      appliesTo: { universal: false, condition: 'Instances with an EBS burst bucket.' },
    }),
  ],
  dimensions: [],
  absentMetrics: [],
  features: [],
  defaultAlertRules: [],
};

describe('findServicePack', () => {
  it('resolves by service token and tolerates a missing catalog', () => {
    expect(findServicePack([pack], 'ec2')).toBe(pack);
    expect(findServicePack([pack], 'rds')).toBeNull();
    expect(findServicePack(null, 'ec2')).toBeNull();
    expect(findServicePack([pack], null)).toBeNull();
  });
});

describe('notesPackFor', () => {
  const rds: InfraServicePackWire = { ...pack, service: 'rds', label: 'RDS' };

  it('follows the charted resource when there is one', () => {
    expect(notesPackFor([pack, rds], { service: 'rds' })).toBe(rds);
  });

  it('falls back to the only pack when nothing is selected', () => {
    // The Alerts tab has no resource, and a single-service deployment still
    // deserves its caveats.
    expect(notesPackFor([pack], null)).toBe(pack);
    expect(notesPackFor([pack], { service: null })).toBe(pack);
  });

  it('picks nothing rather than guessing among several packs', () => {
    // Presenting EC2's caveats as an RDS project's would be worse than silence.
    expect(notesPackFor([pack, rds], null)).toBeNull();
  });

  it('is null for an unknown service or an empty catalog', () => {
    expect(notesPackFor([pack, rds], { service: 'lambda' })).toBeNull();
    expect(notesPackFor([], { service: 'ec2' })).toBeNull();
    expect(notesPackFor(null, null)).toBeNull();
  });
});

describe('findPackMetric', () => {
  it('matches on the full series identity, not the metric name', () => {
    // The same metric on two statistics is two series, and only the declared
    // one is the one the pack describes.
    const found = findPackMetric(pack, {
      namespace: 'AWS/EC2',
      metricName: 'StatusCheckFailed',
      stat: 'Maximum',
    });
    expect(found?.metricType).toBe('flag');

    expect(
      findPackMetric(pack, {
        namespace: 'AWS/EC2',
        metricName: 'StatusCheckFailed',
        stat: 'Average',
      }),
    ).toBeNull();
    expect(
      findPackMetric(pack, { namespace: 'CWAgent', metricName: 'CPUUtilization', stat: 'Average' }),
    ).toBeNull();
  });

  it('returns null rather than throwing on a missing pack or series', () => {
    expect(findPackMetric(null, { namespace: 'a', metricName: 'b', stat: 'c' })).toBeNull();
    expect(findPackMetric(pack, null)).toBeNull();
  });
});

describe('metricCaveats', () => {
  it('says nothing about a metric every resource publishes either way', () => {
    expect(metricCaveats(metric())).toEqual([]);
    expect(metricCaveats(null)).toEqual([]);
  });

  it('leads with the applicability condition and warns that detailed monitoring removes basic-only metrics', () => {
    const caveats = metricCaveats(
      metric({
        availability: 'basic-only',
        appliesTo: { universal: false, condition: 'Instances with an EBS burst bucket.' },
      }),
    );
    expect(caveats[0]).toBe('Instances with an EBS burst bucket.');
    expect(caveats[1]).toMatch(/Detailed monitoring removes this metric/);
  });

  it('flags a detailed-only metric as needing the paid mode', () => {
    expect(metricCaveats(metric({ availability: 'detailed-only' }))[0]).toMatch(
      /detailed monitoring is enabled/,
    );
  });
});

describe('summarizeDefaultRule', () => {
  const base = {
    name: 'r',
    description: 'd',
    namespace: 'AWS/EC2',
    metricName: 'StatusCheckFailed',
    dimensions: ['InstanceId'],
    treatMissingData: 'missing' as const,
    severity: 'critical' as const,
    rationale: 'because',
  };

  it('collapses M-of-N to N when they are equal', () => {
    expect(
      summarizeDefaultRule({
        ...base,
        stat: 'Maximum',
        periodS: 60,
        threshold: 1,
        comparisonOperator: 'GreaterThanOrEqualToThreshold',
        evaluationPeriods: 2,
        datapointsToAlarm: 2,
      }),
    ).toBe('Maximum >= 1 for 2 × 60s');
  });

  it('spells out M of N when they differ', () => {
    expect(
      summarizeDefaultRule({
        ...base,
        stat: 'Minimum',
        periodS: 300,
        threshold: 20,
        comparisonOperator: 'LessThanThreshold',
        evaluationPeriods: 5,
        datapointsToAlarm: 3,
      }),
    ).toBe('Minimum < 20 for 3 of 5 × 300s');
  });
});

describe('sameDimensionSet', () => {
  it('compares dimension names as a set, not as a list', () => {
    expect(sameDimensionSet(['ClusterName', 'ServiceName'], ['ServiceName', 'ClusterName'])).toBe(
      true,
    );
    expect(sameDimensionSet(['ClusterName'], ['ClusterName', 'ServiceName'])).toBe(false);
    expect(sameDimensionSet([], [])).toBe(true);
  });
});

describe('findPackMetric with two declarations of one metric', () => {
  // The ECS shape: `AWS/ECS` CPUUtilization exists at the cluster level and at
  // the service level, and they are different numbers about different things.
  const clusterCpu = metric({
    namespace: 'AWS/ECS',
    dimensions: ['ClusterName'],
    description: 'cluster',
  });
  const serviceCpu = metric({
    namespace: 'AWS/ECS',
    dimensions: ['ClusterName', 'ServiceName'],
    description: 'service',
  });
  const ecs: InfraServicePackWire = { ...pack, service: 'ecs', metrics: [clusterCpu, serviceCpu] };
  const series = { namespace: 'AWS/ECS', metricName: 'CPUUtilization', stat: 'Average' };

  it('picks the declaration whose dimension set matches the resource', () => {
    expect(findPackMetric(ecs, series, ['ClusterName'])).toBe(clusterCpu);
    expect(findPackMetric(ecs, series, ['ServiceName', 'ClusterName'])).toBe(serviceCpu);
  });

  it('falls back to the first declaration when the caller knows no dimensions', () => {
    // Better a description that is right for one of the two than none at all,
    // and every caller that has a resource in hand does know them.
    expect(findPackMetric(ecs, series)).toBe(clusterCpu);
    expect(findPackMetric(ecs, series, ['SomethingElse'])).toBe(clusterCpu);
  });

  it('still resolves a metric declared only once, dimensions or not', () => {
    expect(findPackMetric(pack, { ...series, namespace: 'AWS/EC2' })).toBe(pack.metrics[0]);
  });
});

describe('resourceHasFeature', () => {
  it('requires an explicit true, so absent and false both read as off', () => {
    expect(resourceHasFeature({ features: { containerInsights: true } }, 'containerInsights')).toBe(
      true,
    );
    expect(
      resourceHasFeature({ features: { containerInsights: false } }, 'containerInsights'),
    ).toBe(false);
    expect(resourceHasFeature({ features: {} }, 'containerInsights')).toBe(false);
    expect(resourceHasFeature({}, 'containerInsights')).toBe(false);
    expect(resourceHasFeature(null, 'containerInsights')).toBe(false);
    // A truthy non-boolean is not a flag. Fail closed, same as the collector.
    expect(
      resourceHasFeature({ features: { containerInsights: 'yes' } }, 'containerInsights'),
    ).toBe(false);
  });
});

describe('featureNotices', () => {
  const containerInsights = {
    key: 'containerInsights',
    label: 'Container Insights',
    whenOff: 'The ECS/ContainerInsights metrics are not published.',
    costNote: 'Charged as CloudWatch custom metrics.',
    docsUrl: 'https://docs.aws.amazon.com/x',
  };
  const ecs: InfraServicePackWire = {
    ...pack,
    service: 'ecs',
    features: [containerInsights],
    metrics: [
      metric({ namespace: 'AWS/ECS', metricName: 'CPUUtilization' }),
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
  };

  it('names what is not collected when the feature is off', () => {
    const notices = featureNotices(ecs, { service: 'ecs', features: { containerInsights: false } });
    expect(notices).toHaveLength(1);
    expect(notices[0].feature).toBe(containerInsights);
    // Sorted and de-duplicated, so the list reads the same on every render.
    expect(notices[0].gatedMetricNames).toEqual(['RestartCount', 'RunningTaskCount']);
  });

  it('says nothing once the feature is on', () => {
    expect(featureNotices(ecs, { service: 'ecs', features: { containerInsights: true } })).toEqual(
      [],
    );
  });

  it('treats an unrecorded feature as off, matching the collector', () => {
    expect(featureNotices(ecs, { service: 'ecs' })).toHaveLength(1);
  });

  it('says nothing with no resource selected', () => {
    // A feature belongs to one cluster, not to a project. With nothing selected
    // there is no honest claim to make.
    expect(featureNotices(ecs, null)).toEqual([]);
  });

  it('ignores a feature no metric is gated on', () => {
    const orphan: InfraServicePackWire = { ...ecs, metrics: [ecs.metrics[0]] };
    expect(featureNotices(orphan, { service: 'ecs' })).toEqual([]);
  });

  it('says nothing for a pack that declares no features at all', () => {
    expect(featureNotices(pack, { service: 'ec2' })).toEqual([]);
    expect(featureNotices(null, { service: 'ec2' })).toEqual([]);
  });
});
