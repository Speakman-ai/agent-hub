/**
 * ECS pack-definition tests.
 *
 * Same contract as `ec2.test.ts`: not tests of behaviour — a pack has none —
 * but a machine-read of the AWS documentation the pack claims to encode. The
 * cross-pack invariants (statistics legal for the metric type, valid periods,
 * rules pointing at declared metrics, features fully explained) live in
 * `ec2.test.ts`'s `describe.each` and already cover this pack. What is here is
 * the ECS-specific facts, the ones a future edit is most likely to get wrong.
 */

import { describe, it, expect } from 'vitest';
import { ECS_PACK, ECS_CONTAINER_INSIGHTS_FEATURE } from './ecs.js';
import { getServiceMetricPack, servicePollTierSeconds } from '../service-metric-packs.js';

/** A pack metric is identified by name *and* dimension set, never by name alone. */
function metric(name: string, ...dimensions: string[]) {
  const found = ECS_PACK.metrics.find(
    (m) =>
      m.metricName === name &&
      m.dimensions.length === dimensions.length &&
      dimensions.every((d) => m.dimensions.includes(d)),
  );
  expect(found, `${name} by ${dimensions.join('+')} is not declared`).toBeDefined();
  return found!;
}

const rule = (name: string) => {
  const found = ECS_PACK.defaultAlertRules.find((r) => r.name === name);
  expect(found, `no default rule named ${name}`).toBeDefined();
  return found!;
};

describe('ecs pack — the AWS facts it claims to encode', () => {
  it('collects both namespaces and nothing else', () => {
    expect(new Set(ECS_PACK.metrics.map((m) => m.namespace))).toEqual(
      new Set(['AWS/ECS', 'ECS/ContainerInsights']),
    );
  });

  it('asks for everything at the 1-minute rate ECS publishes at', () => {
    // "Amazon ECS metric data is automatically sent to CloudWatch in 1-minute
    // periods." Nothing in either namespace is slower, so nothing is floored
    // higher — and the service tier says the same.
    for (const m of ECS_PACK.metrics) expect(m.minPeriodSeconds).toBe(60);
    expect(servicePollTierSeconds('ecs')).toBe(60);
  });

  describe('AWS/ECS — free, no opt-in', () => {
    it('gates nothing in the free namespace behind a feature', () => {
      for (const m of ECS_PACK.metrics.filter((m) => m.namespace === 'AWS/ECS')) {
        expect(m.requiresFeature, `${m.metricName} should be free`).toBeNull();
      }
    });

    it('declares cluster CPU and memory utilization on ClusterName alone', () => {
      for (const name of ['CPUUtilization', 'MemoryUtilization']) {
        const m = metric(name, 'ClusterName');
        expect(m.namespace).toBe('AWS/ECS');
        expect(m.stat).toBe('Average');
      }
    });

    it('declares service CPU and memory utilization on ClusterName + ServiceName', () => {
      for (const name of ['CPUUtilization', 'MemoryUtilization']) {
        const m = metric(name, 'ClusterName', 'ServiceName');
        expect(m.namespace).toBe('AWS/ECS');
        expect(m.stat).toBe('Average');
        // "The service-level metric is supported for tasks hosted on Amazon EC2
        // instances and Fargate." Nothing conditional about it.
        expect(m.appliesTo.universal).toBe(true);
      }
    });

    it.each(['CPUUtilization', 'MemoryUtilization', 'CPUReservation', 'MemoryReservation'])(
      'scopes cluster-level %s to EC2 launch type',
      (name) => {
        // "These metrics are only available for clusters with tasks or services
        // hosted on Amazon EC2 instances. They're not supported on clusters
        // with tasks hosted on AWS Fargate."
        const m = metric(name, 'ClusterName');
        expect(m.appliesTo.universal).toBe(false);
        expect(m.appliesTo.condition).toMatch(/Fargate/i);
      },
    );

    it('keeps LiveTaskCount free and stores it on the trough', () => {
      const m = metric('LiveTaskCount', 'ClusterName', 'ServiceName');
      expect(m.namespace).toBe('AWS/ECS');
      expect(m.requiresFeature).toBeNull();
      // A service that dropped to one task for a minute dropped to one task,
      // whatever the five-minute average says.
      expect(m.stat).toBe('Minimum');
    });
  });

  describe('ECS/ContainerInsights — gated behind the paid feature', () => {
    it('gates every Container Insights metric on the cluster setting', () => {
      const gated = ECS_PACK.metrics.filter((m) => m.namespace === 'ECS/ContainerInsights');
      expect(gated.length).toBeGreaterThan(0);
      for (const m of gated) {
        expect(m.requiresFeature, `${m.metricName} is not gated`).toBe(
          ECS_CONTAINER_INSIGHTS_FEATURE,
        );
      }
    });

    it('declares the task-count metrics at the service level only', () => {
      // "DesiredTaskCount / PendingTaskCount / RunningTaskCount — Dimensions:
      // ServiceName, ClusterName." They are never published at ClusterName
      // alone, in either Container Insights mode.
      for (const name of ['RunningTaskCount', 'PendingTaskCount', 'DesiredTaskCount']) {
        const m = metric(name, 'ClusterName', 'ServiceName');
        expect(m.namespace).toBe('ECS/ContainerInsights');
        expect(
          ECS_PACK.metrics.some(
            (other) => other.metricName === name && other.dimensions.length === 1,
          ),
          `${name} must not be declared at the cluster level`,
        ).toBe(false);
      }
    });

    it('declares the cluster-wide counts at the cluster level only', () => {
      // "ServiceCount / TaskCount — Dimensions: ClusterName."
      for (const name of ['TaskCount', 'ServiceCount']) {
        const m = metric(name, 'ClusterName');
        expect(m.namespace).toBe('ECS/ContainerInsights');
      }
    });

    it('treats the network byte metrics as a rate, not a total', () => {
      // AWS publishes NetworkRxBytes / NetworkTxBytes with unit Bytes/Second
      // despite the name. Summing a rate produces a number with no unit.
      for (const name of ['NetworkRxBytes', 'NetworkTxBytes']) {
        const m = metric(name, 'ClusterName', 'ServiceName');
        expect(m.metricType).toBe('gauge');
        expect(m.stat).toBe('Average');
        expect(m.description).toMatch(/per second/i);
      }
    });

    it('sums the storage byte metrics, which really are totals', () => {
      for (const name of ['StorageReadBytes', 'StorageWriteBytes']) {
        const m = metric(name, 'ClusterName', 'ServiceName');
        expect(m.metricType).toBe('counter');
        expect(m.stat).toBe('Sum');
      }
    });

    it('scopes RestartCount to containers with a restart policy', () => {
      // "This metric is collected only for containers that have a restart
      // policy enabled." Most task definitions have none, so the metric is
      // absent rather than zero.
      const m = metric('RestartCount', 'ClusterName', 'ServiceName');
      expect(m.metricType).toBe('counter');
      expect(m.stat).toBe('Sum');
      expect(m.appliesTo.universal).toBe(false);
      expect(m.appliesTo.condition).toMatch(/restart policy/i);
    });

    it('scopes the ephemeral storage metrics to Fargate 1.4.0 and later', () => {
      for (const name of ['EphemeralStorageUtilized', 'EphemeralStorageReserved']) {
        const m = metric(name, 'ClusterName', 'ServiceName');
        expect(m.appliesTo.universal).toBe(false);
        expect(m.appliesTo.condition).toMatch(/1\.4\.0/);
      }
    });

    it('pairs every utilized metric with its reserved denominator', () => {
      // CpuUtilized and MemoryUtilized are absolute units, not percentages.
      // Without the reservation there is nothing to read them against.
      for (const [used, reserved] of [
        ['CpuUtilized', 'CpuReserved'],
        ['MemoryUtilized', 'MemoryReserved'],
        ['EphemeralStorageUtilized', 'EphemeralStorageReserved'],
      ]) {
        metric(used, 'ClusterName', 'ServiceName');
        metric(reserved, 'ClusterName', 'ServiceName');
      }
    });

    it('does not collect the per-task or per-family dimension sets', () => {
      // Declared on the pack so the UI can explain them, deliberately not
      // collected: a TaskId series is a new billed custom metric on every
      // deployment, so the cardinality grows without bound.
      const declared = new Set(ECS_PACK.dimensions.map((d) => d.name));
      expect(declared).toContain('TaskId');
      expect(declared).toContain('TaskDefinitionFamily');
      for (const m of ECS_PACK.metrics) {
        expect(m.dimensions).not.toContain('TaskId');
        expect(m.dimensions).not.toContain('TaskDefinitionFamily');
      }
    });
  });

  describe('Container Insights feature declaration', () => {
    const feature = ECS_PACK.features.find((f) => f.key === ECS_CONTAINER_INSIGHTS_FEATURE)!;

    it('is the only feature this pack gates on', () => {
      expect(ECS_PACK.features).toHaveLength(1);
      expect(feature.label).toBe('Container Insights');
    });

    it('states plainly that AWS bills it as custom metrics', () => {
      // Decision INFRA-COST: paid AWS features we can recommend but not incur
      // on the operator's behalf must be surfaced with what they cost. AWS's
      // own boxed Important: "Metrics collected by CloudWatch Container
      // Insights are charged as custom metrics."
      expect(feature.costNote).toMatch(/custom metric/i);
      expect(feature.whenOff).toMatch(/ECS\/ContainerInsights/);
    });
  });

  describe('default alert rules', () => {
    it('encodes AWS’s recommended RunningTaskCount alarm', () => {
      // "RunningTaskCount, threshold 0.0, LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      // period 60, 5 datapoints of 5." The doc's justification: "If the running
      // task count is 0, the Amazon ECS service will be unavailable."
      const r = rule('ECS service has no running tasks');
      expect(r.metricName).toBe('RunningTaskCount');
      expect(r.threshold).toBe(0);
      expect(r.comparisonOperator).toBe('LessThanOrEqualToThreshold');
      expect(r.periodS).toBe(60);
      expect(r.evaluationPeriods).toBe(5);
      expect(r.datapointsToAlarm).toBe(5);
      expect(r.severity).toBe('critical');
      // Not `breaching`, even though ECS publishes nothing at zero tasks: an
      // unpinned rule matches cluster rows and Container-Insights-off services
      // too, and every one of them would page immediately.
      expect(r.treatMissingData).toBe('missing');
    });

    it('covers the task deficit with a pending-task rule and says why', () => {
      // CloudWatch publishes no desired-minus-running metric and this rule
      // engine evaluates no metric-math expressions, so the deficit itself is
      // not expressible. The pending count is the evaluable form of it.
      const r = rule('ECS service cannot place tasks');
      expect(r.metricName).toBe('PendingTaskCount');
      expect(r.comparisonOperator).toBe('GreaterThanOrEqualToThreshold');
      expect(r.threshold).toBe(1);
      expect(r.rationale).toMatch(/metric[- ]math/i);
      // Most services have nothing pending and publish nothing here.
      expect(r.treatMissingData).toBe('notBreaching');

      const absent = ECS_PACK.absentMetrics.find((a) => /deficit/i.test(a.label));
      expect(absent, 'the deficit gap must be documented, not merely worked around').toBeDefined();
      expect(absent!.reason).toMatch(/metric[- ]math/i);
    });

    it('alarms sustained memory reservation at AWS’s published 80%', () => {
      const r = rule('ECS cluster memory reservation saturated');
      expect(r.namespace).toBe('AWS/ECS');
      expect(r.metricName).toBe('MemoryReservation');
      expect(r.stat).toBe('Average');
      expect(r.threshold).toBe(80);
      expect(r.comparisonOperator).toBe('GreaterThanThreshold');
      expect(r.periodS).toBe(60);
      expect(r.evaluationPeriods).toBe(5);
      expect(r.datapointsToAlarm).toBe(5);
      // Cluster reservation is EC2-launch-type only; a Fargate-only cluster
      // publishes nothing and must not sit in INSUFFICIENT_DATA forever.
      expect(r.treatMissingData).toBe('notBreaching');
    });

    it('fires on a single non-zero RestartCount period', () => {
      const r = rule('ECS container restarts');
      expect(r.metricName).toBe('RestartCount');
      expect(r.stat).toBe('Sum');
      expect(r.threshold).toBe(1);
      expect(r.comparisonOperator).toBe('GreaterThanOrEqualToThreshold');
      // 1 of 1: RestartCount is a per-period count, so requiring five
      // consecutive breaching periods would demand a restart every minute for
      // five minutes and miss the single crash-loop restart entirely.
      expect(r.evaluationPeriods).toBe(1);
      expect(r.datapointsToAlarm).toBe(1);
      expect(r.treatMissingData).toBe('notBreaching');
    });

    it('keeps every cluster-keyed rule off `missing`', () => {
      // Every cluster-level series in this pack is either EC2-launch-type only
      // or behind a paid feature, so `missing` would park a Fargate or
      // Insights-off deployment in INSUFFICIENT_DATA permanently.
      for (const r of ECS_PACK.defaultAlertRules) {
        if (r.dimensions.length === 1) expect(r.treatMissingData).not.toBe('missing');
      }
    });
  });

  it('projects into the collector query list with its gates intact', () => {
    const specs = getServiceMetricPack('ecs');
    expect(specs).toHaveLength(ECS_PACK.metrics.length);
    const gated = specs.filter((s) => s.requiresFeature === ECS_CONTAINER_INSIGHTS_FEATURE);
    expect(gated.length).toBe(
      ECS_PACK.metrics.filter((m) => m.namespace === 'ECS/ContainerInsights').length,
    );
  });
});
