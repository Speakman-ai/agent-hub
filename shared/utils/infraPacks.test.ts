import { describe, it, expect } from 'vitest';
import {
  findServicePack,
  findPackMetric,
  metricCaveats,
  notesPackFor,
  summarizeDefaultRule,
  type InfraPackMetricWire,
  type InfraServicePackWire,
} from './infraPacks.js';

function metric(overrides: Partial<InfraPackMetricWire> = {}): InfraPackMetricWire {
  return {
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    dimension: 'InstanceId',
    metricType: 'gauge',
    stat: 'Average',
    validStatistics: ['Average', 'Minimum', 'Maximum'],
    minPeriodSeconds: 300,
    availability: 'either',
    appliesTo: { universal: true, condition: '' },
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
