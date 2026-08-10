/**
 * Headline catalog: every declared ref resolves against its pack, the ECS
 * cluster/service split lands on the right resource, and a Container Insights
 * headline stays off a cluster that does not have the feature.
 */
import { describe, it, expect } from 'vitest';
import {
  INFRA_FLEET_SERVICES,
  INFRA_HEADLINE_METRIC_REFS,
  allHeadlineMetrics,
  headlineMetricsForResource,
  headlineMetricsForService,
} from './headline-metrics.js';
import { getInfraServicePack, ECS_CONTAINER_INSIGHTS_FEATURE } from './packs/index.js';

describe('headline metric catalog', () => {
  it('resolves every declared ref to a metric that exists in its pack', () => {
    for (const ref of INFRA_HEADLINE_METRIC_REFS) {
      const pack = getInfraServicePack(ref.service);
      expect(pack, `no pack for ${ref.service}`).not.toBeNull();
      const match = pack?.metrics.find(
        (m) =>
          m.namespace === ref.namespace &&
          m.metricName === ref.metricName &&
          m.dimensions.length === ref.dimensions.length &&
          m.dimensions.every((d) => ref.dimensions.includes(d)),
      );
      expect(
        match,
        `${ref.namespace}/${ref.metricName} missing from ${ref.service} pack`,
      ).toBeTruthy();
    }
  });

  it('takes statistic and feature gate from the pack rather than restating them', () => {
    // The collector stored what the pack declared. A headline naming its own
    // stat would query a series that was never written, and the empty chart
    // would be indistinguishable from a resource that stopped reporting.
    for (const metric of allHeadlineMetrics()) {
      const packMetric = getInfraServicePack(metric.service)?.metrics.find(
        (m) =>
          m.namespace === metric.namespace &&
          m.metricName === metric.metricName &&
          m.dimensions.length === metric.dimensions.length &&
          m.dimensions.every((d) => metric.dimensions.includes(d)),
      );
      expect(packMetric).toBeTruthy();
      expect(metric.stat).toBe(packMetric?.stat);
      expect(metric.requiresFeature).toBe(packMetric?.requiresFeature);
      expect(metric.description).toBe(packMetric?.description);
    }
  });

  it('only declares headlines for dashboard services', () => {
    for (const ref of INFRA_HEADLINE_METRIC_REFS) {
      expect(INFRA_FLEET_SERVICES).toContain(ref.service);
    }
  });

  it('gives every dashboard service at least two headlines', () => {
    for (const service of INFRA_FLEET_SERVICES) {
      expect(headlineMetricsForService(service).length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('headlineMetricsForResource', () => {
  it('gives an EC2 instance its instance-keyed headlines', () => {
    const metrics = headlineMetricsForResource('ec2', ['InstanceId']);
    expect(metrics.map((m) => m.metricName)).toEqual([
      'CPUUtilization',
      'StatusCheckFailed',
      'NetworkIn',
    ]);
  });

  it('splits ECS cluster headlines from service headlines', () => {
    const cluster = headlineMetricsForResource('ecs', ['ClusterName']);
    const service = headlineMetricsForResource('ecs', ['ClusterName', 'ServiceName'], {
      [ECS_CONTAINER_INSIGHTS_FEATURE]: true,
    });

    // AWS/ECS CPUUtilization exists at both dimension sets and the two numbers
    // are not comparable; a cluster tile must never draw the service series.
    expect(cluster.map((m) => m.metricName)).toEqual(['CPUReservation', 'MemoryReservation']);
    expect(service.map((m) => m.metricName)).toContain('CPUUtilization');
    expect(service.every((m) => m.dimensions.includes('ServiceName'))).toBe(true);
  });

  it('is order-insensitive about dimension names', () => {
    const a = headlineMetricsForResource('ecs', ['ClusterName', 'ServiceName']);
    const b = headlineMetricsForResource('ecs', ['ServiceName', 'ClusterName']);
    expect(a.map((m) => m.metricName)).toEqual(b.map((m) => m.metricName));
  });

  it('drops a Container Insights headline when the feature is off', () => {
    const without = headlineMetricsForResource('ecs', ['ClusterName', 'ServiceName'], {});
    const withFeature = headlineMetricsForResource('ecs', ['ClusterName', 'ServiceName'], {
      [ECS_CONTAINER_INSIGHTS_FEATURE]: true,
    });

    // Not "no data yet" — the collector never asked CloudWatch for it, so the
    // tile could only ever be empty.
    expect(without.map((m) => m.metricName)).not.toContain('RunningTaskCount');
    expect(withFeature.map((m) => m.metricName)).toContain('RunningTaskCount');
  });

  it('falls back to single-dimension headlines for a row with no recorded dimensions', () => {
    // Rows written before metric_dimensions_json existed. The collector binds
    // them to the single-dimension metric; the dashboard has to agree.
    const metrics = headlineMetricsForResource('rds', []);
    expect(metrics.map((m) => m.metricName)).toEqual([
      'CPUUtilization',
      'FreeableMemory',
      'DatabaseConnections',
    ]);
  });

  it('returns nothing for a service with no headlines declared', () => {
    expect(headlineMetricsForResource('s3', ['BucketName'])).toEqual([]);
    expect(headlineMetricsForResource('nonsense', ['Whatever'])).toEqual([]);
  });
});
