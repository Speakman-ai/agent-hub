/**
 * Pack-definition tests.
 *
 * These are not tests of behaviour — a pack has none. They are a machine-read
 * of the AWS documentation the pack claims to encode, so that a future edit
 * that quietly stores a 0/1 status check on `Average`, or asks for a 60-second
 * period on a 5-minute-only metric, fails here rather than in a chart nobody
 * checks.
 */

import { describe, it, expect } from 'vitest';
import { EC2_PACK } from './ec2.js';
import { INFRA_SERVICE_PACKS, getInfraServicePack, infraPackedServices } from './index.js';
import { STATISTICS_BY_METRIC_TYPE, type InfraServicePack } from './types.js';
import { getServiceMetricPack, collectableServices } from '../service-metric-packs.js';
import { isValidCloudWatchPeriod } from '../infra-metric-store.js';
import { INFRA_COMPARISON_OPERATORS, INFRA_TREAT_MISSING_DATA_MODES } from '../alert-evaluator.js';
import { INFRA_ALERT_SEVERITIES } from '../infra-schema.js';

const ALL_PACKS: InfraServicePack[] = Object.values(INFRA_SERVICE_PACKS);

describe('service pack registry', () => {
  it('keys every pack by its own service token', () => {
    for (const [token, pack] of Object.entries(INFRA_SERVICE_PACKS)) {
      expect(pack.service).toBe(token);
    }
  });

  it('resolves a pack by token and reports the packed services', () => {
    expect(getInfraServicePack('ec2')).toBe(EC2_PACK);
    expect(getInfraServicePack('nope')).toBeNull();
    expect(infraPackedServices()).toEqual(['ec2']);
  });

  it('projects every pack metric into the collector query list', () => {
    // The whole point of deriving the collector view: a metric declared in a
    // pack is a metric that gets polled. A pack entry that never reaches the
    // collector is documentation of a series that will never exist.
    for (const pack of ALL_PACKS) {
      const specs = getServiceMetricPack(pack.service);
      expect(specs).toHaveLength(pack.metrics.length);
      expect(specs.map((s) => s.metricName)).toEqual(pack.metrics.map((m) => m.metricName));
      for (const [i, spec] of specs.entries()) {
        const metric = pack.metrics[i]!;
        expect(spec).toEqual({
          namespace: metric.namespace,
          metricName: metric.metricName,
          stat: metric.stat,
          dimension: metric.dimension,
          minPeriodSeconds: metric.minPeriodSeconds,
        });
      }
    }
    expect(collectableServices()).toEqual(infraPackedServices());
  });
});

describe.each(ALL_PACKS.map((pack) => [pack.service, pack] as const))(
  '%s pack definition',
  (_service, pack) => {
    it('declares a statistic that is valid for the metric type', () => {
      for (const metric of pack.metrics) {
        expect(
          STATISTICS_BY_METRIC_TYPE[metric.metricType],
          `${metric.metricName} is a ${metric.metricType} stored on ${metric.stat}`,
        ).toContain(metric.stat);
      }
    });

    it('declares a statistic AWS documents as meaningful for the metric', () => {
      for (const metric of pack.metrics) {
        expect(metric.validStatistics.length).toBeGreaterThan(0);
        expect(
          metric.validStatistics,
          `${metric.metricName} stores ${metric.stat}, which AWS does not list as meaningful`,
        ).toContain(metric.stat);
      }
    });

    it('names every metric uniquely within the pack', () => {
      const keys = pack.metrics.map((m) => `${m.namespace}/${m.metricName}/${m.stat}`);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('declares a period CloudWatch can actually return', () => {
      for (const metric of pack.metrics) {
        expect(
          isValidCloudWatchPeriod(metric.minPeriodSeconds),
          `${metric.metricName} floors at ${metric.minPeriodSeconds}s`,
        ).toBe(true);
      }
    });

    it('explains every metric that does not apply to the whole service', () => {
      for (const metric of pack.metrics) {
        if (metric.appliesTo.universal) {
          expect(metric.appliesTo.condition).toBe('');
        } else {
          expect(metric.appliesTo.condition.length).toBeGreaterThan(0);
        }
        expect(metric.description.length).toBeGreaterThan(0);
      }
    });

    it('binds every metric to a dimension the pack declares', () => {
      const names = new Set(pack.dimensions.map((d) => d.name));
      for (const metric of pack.metrics) {
        expect(names).toContain(metric.dimension);
      }
    });

    it('binds collected series to a dimension that survives basic monitoring', () => {
      // A detailed-monitoring-only dimension is unpopulated on a default fleet,
      // so keying a collected series on one would return nothing for every
      // instance that has not paid for the upgrade.
      const detailedOnly = new Set(
        pack.dimensions.filter((d) => d.detailedMonitoringOnly).map((d) => d.name),
      );
      for (const metric of pack.metrics) {
        expect(detailedOnly).not.toContain(metric.dimension);
      }
    });

    it('explains every absent metric and stays honest about the remedy', () => {
      for (const absent of pack.absentMetrics) {
        expect(absent.label.length).toBeGreaterThan(0);
        expect(absent.reason.length).toBeGreaterThan(0);
        // `null` is a legal remedy; an empty string is a half-written one.
        expect(absent.remedy === null || absent.remedy.length > 0).toBe(true);
      }
    });

    it('declares default rules the alert store would accept', () => {
      for (const rule of pack.defaultAlertRules) {
        expect(INFRA_COMPARISON_OPERATORS).toContain(rule.comparisonOperator);
        expect(INFRA_TREAT_MISSING_DATA_MODES).toContain(rule.treatMissingData);
        expect(INFRA_ALERT_SEVERITIES).toContain(rule.severity);
        expect(Number.isInteger(rule.evaluationPeriods) && rule.evaluationPeriods >= 1).toBe(true);
        expect(Number.isInteger(rule.datapointsToAlarm) && rule.datapointsToAlarm >= 1).toBe(true);
        expect(rule.datapointsToAlarm).toBeLessThanOrEqual(rule.evaluationPeriods);
        expect(isValidCloudWatchPeriod(rule.periodS)).toBe(true);
        expect(Number.isFinite(rule.threshold)).toBe(true);
        expect(rule.rationale.length).toBeGreaterThan(0);
      }
    });

    it('points every default rule at a series the pack actually collects', () => {
      // A rule on an uncollected metric sits in INSUFFICIENT_DATA forever, which
      // is worse than no rule: it teaches operators that the state column lies.
      for (const rule of pack.defaultAlertRules) {
        const metric = pack.metrics.find(
          (m) => m.namespace === rule.namespace && m.metricName === rule.metricName,
        );
        expect(metric, `${rule.name} targets an undeclared metric`).toBeDefined();
        expect(rule.stat).toBe(metric!.stat);
        expect(rule.periodS).toBeGreaterThanOrEqual(metric!.minPeriodSeconds);
      }
    });

    it('names every default rule uniquely', () => {
      const names = pack.defaultAlertRules.map((r) => r.name);
      expect(new Set(names).size).toBe(names.length);
    });
  },
);

describe('ec2 pack — the AWS facts it claims to encode', () => {
  const byName = new Map(EC2_PACK.metrics.map((m) => [m.metricName, m]));

  it('declares every metric the module is responsible for', () => {
    expect([...byName.keys()].sort()).toEqual(
      [
        'CPUCreditBalance',
        'CPUUtilization',
        'EBSByteBalance%',
        'EBSIOBalance%',
        'EBSReadBytes',
        'EBSReadOps',
        'EBSWriteBytes',
        'EBSWriteOps',
        'InstanceEBSIOPSExceededCheck',
        'InstanceEBSThroughputExceededCheck',
        'NetworkIn',
        'NetworkOut',
        'StatusCheckFailed',
        'StatusCheckFailed_AttachedEBS',
        'StatusCheckFailed_Instance',
        'StatusCheckFailed_System',
      ].sort(),
    );
  });

  it.each([
    'StatusCheckFailed',
    'StatusCheckFailed_Instance',
    'StatusCheckFailed_System',
    'StatusCheckFailed_AttachedEBS',
  ])('stores %s on Maximum at the free 1-minute resolution', (name) => {
    const metric = byName.get(name)!;
    expect(metric.metricType).toBe('flag');
    expect(metric.stat).toBe('Maximum');
    expect(metric.minPeriodSeconds).toBe(60);
    // "By default, status check metrics are available at a 1-minute frequency
    // at no charge" — they do not depend on the monitoring mode.
    expect(metric.availability).toBe('either');
    // AWS lists Average/Minimum/Maximum for these; Sum is not meaningful.
    expect(metric.validStatistics).not.toContain('Sum');
  });

  it.each(['EBSIOBalance%', 'EBSByteBalance%'])(
    'declares %s as basic-monitoring-only with Sum invalid',
    (name) => {
      const metric = byName.get(name)!;
      // "The Sum statistic is not applicable to this metric."
      expect(metric.validStatistics).toEqual(['Minimum', 'Maximum']);
      expect(metric.stat).toBe('Minimum');
      // "This metric is available for basic monitoring only."
      expect(metric.availability).toBe('basic-only');
      expect(metric.appliesTo.universal).toBe(false);
    },
  );

  it('floors CPUCreditBalance at 5 minutes and scopes it to burstable instances', () => {
    const metric = byName.get('CPUCreditBalance')!;
    // "CPU credit metrics are available at a 5-minute frequency only."
    expect(metric.minPeriodSeconds).toBe(300);
    expect(metric.appliesTo.universal).toBe(false);
    expect(metric.appliesTo.condition).toMatch(/T-family/i);
  });

  it.each(['InstanceEBSIOPSExceededCheck', 'InstanceEBSThroughputExceededCheck'])(
    'treats %s as a 1-minute Nitro-only flag',
    (name) => {
      const metric = byName.get(name)!;
      expect(metric.metricType).toBe('flag');
      expect(metric.stat).toBe('Maximum');
      expect(metric.minPeriodSeconds).toBe(60);
      expect(metric.appliesTo.universal).toBe(false);
      expect(metric.appliesTo.condition).toMatch(/Nitro/i);
    },
  );

  it.each(['EBSReadOps', 'EBSWriteOps', 'EBSReadBytes', 'EBSWriteBytes'])(
    'sums %s over the period',
    (name) => {
      const metric = byName.get(name)!;
      expect(metric.metricType).toBe('counter');
      expect(metric.stat).toBe('Sum');
      expect(metric.minPeriodSeconds).toBe(300);
    },
  );

  it('marks ImageId and InstanceType as detailed-monitoring-only', () => {
    const byDimension = new Map(EC2_PACK.dimensions.map((d) => [d.name, d]));
    expect(byDimension.get('ImageId')!.detailedMonitoringOnly).toBe(true);
    expect(byDimension.get('InstanceType')!.detailedMonitoringOnly).toBe(true);
    // Available under basic monitoring as well, per the dimension table.
    expect(byDimension.get('AutoScalingGroupName')!.detailedMonitoringOnly).toBe(false);
    expect(byDimension.get('InstanceId')!.detailedMonitoringOnly).toBe(false);
  });

  it('states why memory and disk usage are absent and points at the CloudWatch agent', () => {
    const labels = EC2_PACK.absentMetrics.map((a) => a.label).join(' | ');
    expect(labels).toMatch(/Memory/i);
    expect(labels).toMatch(/Disk-space/i);

    const memory = EC2_PACK.absentMetrics.find((a) => /Memory/i.test(a.label))!;
    expect(memory.reason).toMatch(/hypervisor/i);
    expect(memory.remedy).toMatch(/CloudWatch agent/i);
    expect(memory.remedy).toMatch(/CWAgent/);

    const diskIo = EC2_PACK.absentMetrics.find((a) => /DiskReadOps/.test(a.label))!;
    // The Disk* family is instance-store only, which is the reason it is absent
    // rather than merely unpopular.
    expect(diskIo.reason).toMatch(/instance store/i);
  });

  it('alarms the status check on Maximum, as AWS recommends', () => {
    const rule = EC2_PACK.defaultAlertRules.find((r) => r.metricName === 'StatusCheckFailed')!;
    expect(rule.stat).toBe('Maximum');
    expect(rule.threshold).toBe(1);
    expect(rule.comparisonOperator).toBe('GreaterThanOrEqualToThreshold');
    expect(rule.evaluationPeriods).toBe(2);
    expect(rule.datapointsToAlarm).toBe(2);
    expect(rule.severity).toBe('critical');
  });

  it('alarms sustained CPU on three consecutive 5-minute periods above 80', () => {
    const rule = EC2_PACK.defaultAlertRules.find((r) => r.metricName === 'CPUUtilization')!;
    expect(rule.stat).toBe('Average');
    expect(rule.threshold).toBe(80);
    expect(rule.comparisonOperator).toBe('GreaterThanThreshold');
    expect(rule.periodS).toBe(300);
    expect(rule.evaluationPeriods).toBe(3);
    expect(rule.datapointsToAlarm).toBe(3);
  });

  it.each(['EBSIOBalance%', 'EBSByteBalance%'])(
    'alarms %s depletion before the bucket is empty',
    (name) => {
      const rule = EC2_PACK.defaultAlertRules.find((r) => r.metricName === name)!;
      expect(rule.stat).toBe('Minimum');
      expect(rule.comparisonOperator).toBe('LessThanThreshold');
      expect(rule.threshold).toBeGreaterThan(0);
      // Most instances have no burst bucket at all. Under 'missing' every one of
      // them would sit in INSUFFICIENT_DATA forever.
      expect(rule.treatMissingData).toBe('notBreaching');
    },
  );
});
