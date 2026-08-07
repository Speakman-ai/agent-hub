/**
 * RDS pack-definition tests.
 *
 * The shared invariants every pack must satisfy live in `ec2.test.ts`'s
 * `describe.each(ALL_PACKS)` block and cover this pack automatically. What is
 * here is the RDS-specific half: a machine-read of the AWS facts this pack
 * claims to encode, so an edit that quietly stores a storage-full metric on
 * Average, drops the seconds-versus-milliseconds distinction out of the latency
 * thresholds, or lets an engine-specific rule sit in INSUFFICIENT_DATA on every
 * other engine in the scope, fails here rather than in a chart nobody checks.
 */

import { describe, it, expect } from 'vitest';
import { RDS_PACK } from './rds.js';
import { PERCENTILE_STATISTIC_TOKEN, isPercentileStatistic } from './types.js';
import {
  getServiceMetricPack,
  effectiveServicePollIntervalSeconds,
} from '../service-metric-packs.js';

const byName = new Map(RDS_PACK.metrics.map((m) => [m.metricName, m]));
const ruleFor = (metricName: string) =>
  RDS_PACK.defaultAlertRules.find((r) => r.metricName === metricName)!;

describe('rds pack — the AWS facts it claims to encode', () => {
  it('declares every metric the card is responsible for, and no more', () => {
    expect([...byName.keys()].sort()).toEqual(
      [
        'BurstBalance',
        'CPUUtilization',
        'DatabaseConnections',
        'DiskQueueDepth',
        'FreeStorageSpace',
        'FreeableMemory',
        'MaximumUsedTransactionIDs',
        'ReadLatency',
        'ReplicaLag',
        'WriteLatency',
      ].sort(),
    );
  });

  it('floors every metric at the free 1-minute publication rate', () => {
    // "By default, Amazon RDS automatically sends metric data to CloudWatch in
    // 1-minute periods." Unlike EC2 there is no basic-vs-detailed split, so
    // nothing here is conditional on a paid monitoring mode.
    for (const metric of RDS_PACK.metrics) {
      expect(metric.minPeriodSeconds, `${metric.metricName} floors elsewhere`).toBe(60);
      expect(metric.availability).toBe('either');
    }
  });

  it('polls at the 1-minute tier INFRA-COST names RDS in, with nothing raising the floor', () => {
    // The tier and every metric's own emission floor agree at 60 for this
    // service, which is what makes RDS the cheapest thing in the epic to
    // monitor at full resolution. A metric that raised the effective interval
    // would mean the pack had picked up a coarser series without saying so.
    for (const spec of getServiceMetricPack('rds')) {
      expect(effectiveServicePollIntervalSeconds('rds', spec)).toBe(60);
    }
  });

  it('never stores a Sum, because nothing in this pack accrues', () => {
    // Every metric here is a level sampled at the end of a period. A sum of
    // sixty samples of "how much memory is free" has no referent.
    for (const metric of RDS_PACK.metrics) {
      expect(metric.stat).not.toBe('Sum');
      expect(metric.validStatistics, `${metric.metricName} lists Sum`).not.toContain('Sum');
      expect(metric.metricType).not.toBe('counter');
    }
  });

  it('takes the low-water mark for storage, not the average', () => {
    // AWS's recommended alarm uses Minimum, and it is the only honest choice: a
    // 60-second Average that briefly touched zero reads as comfortable.
    const metric = byName.get('FreeStorageSpace')!;
    expect(metric.stat).toBe('Minimum');
    expect(ruleFor('FreeStorageSpace').stat).toBe('Minimum');
    expect(ruleFor('FreeStorageSpace').comparisonOperator).toBe('LessThanThreshold');
  });

  it.each(['ReadLatency', 'WriteLatency'])(
    'stores %s as a p90 distribution and thresholds it in seconds',
    (name) => {
      const metric = byName.get(name)!;
      expect(metric.metricType).toBe('latency');
      expect(metric.stat).toBe('p90');
      expect(isPercentileStatistic(metric.stat)).toBe(true);
      // The percentile arm of validStatistics is what makes p90 documented
      // rather than merely legal — AWS's own recommended alarm evaluates it.
      expect(metric.validStatistics).toContain(PERCENTILE_STATISTIC_TOKEN);

      // AWS documents the unit as Seconds and its justification in
      // milliseconds: "Read latencies higher than 20 milliseconds are likely a
      // cause for investigation." A threshold of 20 here would alarm at twenty
      // seconds per operation, which is an outage long past needing an alarm.
      const rule = ruleFor(name);
      expect(rule.threshold).toBe(0.02);
      expect(rule.threshold).toBeLessThan(1);
    },
  );

  it('scopes the wraparound predictor to PostgreSQL and alarms it at AWS’s billion', () => {
    const metric = byName.get('MaximumUsedTransactionIDs')!;
    expect(metric.appliesTo.universal).toBe(false);
    expect(metric.appliesTo.condition).toMatch(/PostgreSQL/);
    // "The age of the oldest unvacuumed transaction ID... If this value reaches
    // 2,146,483,648 (2^31 - 1,000,000), the database is forced into read-only
    // mode." The description has to carry the number, because it is the reason
    // the rule is critical rather than a warning.
    expect(metric.description).toContain('2,146,483,648');

    const rule = ruleFor('MaximumUsedTransactionIDs');
    expect(rule.threshold).toBe(1_000_000_000);
    expect(rule.comparisonOperator).toBe('GreaterThanThreshold');
    expect(rule.evaluationPeriods).toBe(1);
    expect(rule.datapointsToAlarm).toBe(1);
    expect(rule.severity).toBe('critical');
    expect(rule.rationale).toMatch(/autovacuum_freeze_max_age/);
  });

  it('alarms replica lag on Maximum at AWS’s sixty seconds over ten periods', () => {
    const rule = ruleFor('ReplicaLag');
    expect(rule.stat).toBe('Maximum');
    expect(rule.threshold).toBe(60);
    expect(rule.evaluationPeriods).toBe(10);
    expect(rule.datapointsToAlarm).toBe(10);
  });

  it('alarms sustained CPU on five consecutive minutes above ninety', () => {
    const rule = ruleFor('CPUUtilization');
    expect(rule.stat).toBe('Average');
    expect(rule.threshold).toBe(90);
    expect(rule.periodS).toBe(60);
    expect(rule.evaluationPeriods).toBe(5);
    expect(rule.datapointsToAlarm).toBe(5);
  });

  it('treats missing data as not breaching exactly for the series not every row publishes', () => {
    // A rule with no resourceKey matches every rds row in the project, and an
    // rds scope holds provisioned instances, Aurora members and every engine at
    // once. Under `missing`, the rows that structurally cannot publish a series
    // would sit in INSUFFICIENT_DATA forever and teach operators that the state
    // column is noise. The converse matters too: a universal metric on
    // `notBreaching` would hide a genuinely stopped instance.
    for (const rule of RDS_PACK.defaultAlertRules) {
      const metric = RDS_PACK.metrics.find(
        (m) => m.metricName === rule.metricName && m.stat === rule.stat,
      )!;
      expect(
        rule.treatMissingData,
        `${rule.name} treats missing data as ${rule.treatMissingData} for a ${
          metric.appliesTo.universal ? 'universal' : 'non-universal'
        } metric`,
      ).toBe(metric.appliesTo.universal ? 'missing' : 'notBreaching');
    }
  });

  it('labels every invented threshold as a unit rather than a recommendation', () => {
    // AWS answers "depends on your situation" for four of these, and a template
    // that ships a number with no provenance is how a round number becomes
    // policy. Each such rule has to say in its own rationale that the number is
    // a placeholder and give AWS's arithmetic for the real one.
    for (const name of ['FreeStorageSpace', 'FreeableMemory', 'DatabaseConnections']) {
      const rule = ruleFor(name);
      expect(rule.rationale, `${rule.name} does not label its stand-in`).toMatch(
        /unit standing in/i,
      );
    }
  });

  it('cites AWS in every default rule rationale', () => {
    for (const rule of RDS_PACK.defaultAlertRules) {
      expect(rule.rationale, `${rule.name} cites no source`).toMatch(/AWS/);
    }
  });

  it('collects only the instance dimension while documenting the four it does not', () => {
    const names = RDS_PACK.dimensions.map((d) => d.name);
    expect(names).toEqual([
      'DBInstanceIdentifier',
      'DatabaseClass',
      'EngineName',
      'SourceRegion',
      'VolumeName',
    ]);
    for (const metric of RDS_PACK.metrics) {
      expect(metric.dimensions).toEqual(['DBInstanceIdentifier']);
    }
  });

  it('declares no paid feature, because RDS metrics have none', () => {
    // Enhanced Monitoring and Performance Insights are paid, but they publish
    // outside this namespace rather than gating a metric in it — so they belong
    // in absentMetrics, not in a feature gate that would imply the series
    // appears once you pay.
    expect(RDS_PACK.features).toEqual([]);
    const labels = RDS_PACK.absentMetrics.map((a) => a.label).join(' | ');
    expect(labels).toMatch(/Memory breakdown/i);
    expect(labels).toMatch(/DBLoad/);

    const os = RDS_PACK.absentMetrics.find((a) => /Memory breakdown/i.test(a.label))!;
    expect(os.reason).toMatch(/Enhanced Monitoring/);
    // The load-bearing half: it is not a CloudWatch metric even once enabled.
    expect(os.reason).toMatch(/CloudWatch Logs/);
  });

  it('explains that Aurora is in the same scope and does not publish the same series', () => {
    const storage = byName.get('FreeStorageSpace')!;
    expect(storage.appliesTo.universal).toBe(false);
    expect(storage.appliesTo.condition).toMatch(/Aurora/);
    const labels = RDS_PACK.absentMetrics.map((a) => a.label).join(' | ');
    expect(labels).toMatch(/AuroraVolumeBytesLeftTotal/);
  });
});
