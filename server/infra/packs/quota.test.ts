import { describe, it, expect } from 'vitest';

import {
  DEFAULT_QUOTA_UTILIZATION_THRESHOLD,
  QUOTA_USAGE_DIMENSIONS,
  QUOTA_USAGE_NAMESPACE,
} from '../quota-catalog.js';
import { getServiceMetricPack, servicePollTierSeconds } from '../service-metric-packs.js';
import {
  QUOTA_DERIVED_NAMESPACE,
  QUOTA_PACK,
  QUOTA_UTILIZATION_METRIC_NAME,
  QUOTA_UTILIZATION_STAT,
  quotaUsageFeatureKey,
} from './quota.js';

function metric(name: string) {
  const found = QUOTA_PACK.metrics.find((m) => m.metricName === name);
  expect(found, `quota pack declares no metric named ${name}`).toBeDefined();
  return found!;
}

const rule = (name: string) => {
  const found = QUOTA_PACK.defaultAlertRules.find((r) => r.name === name);
  expect(found, `quota pack declares no default rule named ${name}`).toBeDefined();
  return found!;
};

describe('quota pack shape', () => {
  it('declares exactly the three AWS/Usage metrics plus the derived utilization', () => {
    // Adding a metric should fail this deliberately: each collected entry is a
    // billed GetMetricData query per quota per tick.
    expect(QUOTA_PACK.metrics.map((m) => m.metricName).sort()).toEqual([
      'CallCount',
      'QuotaUtilization',
      'ResourceCount',
      'ThrottleCount',
    ]);
  });

  it('keys every metric on the one dimension set AWS/Usage publishes', () => {
    // This is the property that lets a quota be modelled as a resource at all:
    // a pack metric declares exactly one dimension-name set, and the whole
    // AWS/Usage namespace has exactly one.
    for (const m of QUOTA_PACK.metrics) {
      expect([...m.dimensions]).toEqual([...QUOTA_USAGE_DIMENSIONS]);
    }
  });

  it('collects at 1-minute, which is the rate AWS publishes usage metrics at', () => {
    for (const m of QUOTA_PACK.metrics) {
      expect(m.minPeriodSeconds).toBe(60);
    }
    expect(servicePollTierSeconds(QUOTA_PACK.service)).toBe(60);
  });

  it('measures a resource count on Maximum, not Average', () => {
    // An Average across the period smooths away the peak, which is precisely
    // the moment you could not launch. Headroom is a question about the peak.
    const resourceCount = metric('ResourceCount');
    expect(resourceCount.stat).toBe('Maximum');
    expect(resourceCount.metricType).toBe('gauge');
    expect(resourceCount.namespace).toBe(QUOTA_USAGE_NAMESPACE);
  });

  it('measures call and throttle rates on Sum', () => {
    // "How many happened" is the only question a rate quota is expressed in.
    for (const name of ['CallCount', 'ThrottleCount']) {
      expect(metric(name).stat).toBe('Sum');
      expect(metric(name).metricType).toBe('counter');
    }
  });
});

describe('per-quota feature gating', () => {
  it('gates each collected usage metric on the flag naming it', () => {
    // A quota's UsageMetric names one metric, but all three declarations share
    // a dimension set, so without gating all three would bind to every quota
    // and two of them would be billed to return nothing forever.
    for (const name of ['CallCount', 'ResourceCount', 'ThrottleCount']) {
      expect(metric(name).requiresFeature).toBe(quotaUsageFeatureKey(name));
    }
    expect(quotaUsageFeatureKey('ResourceCount')).toBe('usage:ResourceCount');
  });

  it('declares a feature for every gate, and no metric gated on an undeclared one', () => {
    const declared = new Set(QUOTA_PACK.features.map((f) => f.key));
    expect([...declared].sort()).toEqual([
      'usage:CallCount',
      'usage:ResourceCount',
      'usage:ThrottleCount',
    ]);
    for (const m of QUOTA_PACK.metrics) {
      if (m.requiresFeature) expect(declared.has(m.requiresFeature)).toBe(true);
    }
  });

  it('says plainly that these flags cost nothing to turn on, unlike every other pack feature', () => {
    // Elsewhere a feature is a paid AWS option (Container Insights, S3 request
    // metrics) and the UI tells the operator what enabling it costs. Here it
    // records which metric AWS publishes, which is not an operator choice at
    // all. Saying otherwise would invite someone to go hunting for a switch.
    for (const f of QUOTA_PACK.features) {
      expect(f.costNote).toMatch(/^None\./);
      expect(f.costNote).toMatch(/not a paid AWS feature/i);
    }
  });

  it('leaves the derived utilization ungated so it applies to every quota', () => {
    const utilization = metric(QUOTA_UTILIZATION_METRIC_NAME);
    expect(utilization.requiresFeature).toBeNull();
    expect(utilization.appliesTo.universal).toBe(true);
  });
});

describe('the derived utilization series', () => {
  it('is marked derived and lives in a Hub-owned namespace', () => {
    const utilization = metric(QUOTA_UTILIZATION_METRIC_NAME);
    expect(utilization.derived).toBe(true);
    expect(utilization.namespace).toBe(QUOTA_DERIVED_NAMESPACE);
    // Not an `AWS/` name: AWS does not publish this, we compute it, and a
    // namespace that looked like AWS's would be a lie in the chart picker.
    expect(QUOTA_DERIVED_NAMESPACE.startsWith('AWS/')).toBe(false);
  });

  it('is never sent to CloudWatch', () => {
    // The concrete failure being prevented: a billed GetMetricData entry
    // against a namespace AWS does not publish, returning nothing every tick.
    const collected = getServiceMetricPack(QUOTA_PACK.service);
    expect(collected.map((s) => s.metricName).sort()).toEqual([
      'CallCount',
      'ResourceCount',
      'ThrottleCount',
    ]);
    expect(collected.some((s) => s.namespace === QUOTA_DERIVED_NAMESPACE)).toBe(false);
  });

  it('cites the AWS expression it reproduces, so the two can be diffed', () => {
    expect(metric(QUOTA_UTILIZATION_METRIC_NAME).description).toContain('m1/SERVICE_QUOTA(m1)*100');
    expect(metric(QUOTA_UTILIZATION_METRIC_NAME).description).toMatch(/ListServiceQuotas/);
  });

  it('carries one statistic regardless of the underlying usage statistic', () => {
    // A quota measured on Sum of calls and one measured on Maximum of resources
    // both yield a percentage that means the same thing. If the derived stat
    // varied per quota, one default rule could not cover both.
    expect(QUOTA_UTILIZATION_STAT).toBe('Maximum');
    expect(metric(QUOTA_UTILIZATION_METRIC_NAME).stat).toBe(QUOTA_UTILIZATION_STAT);
  });
});

describe('default alert rules', () => {
  it('alarms utilization above the 80 percent AWS’s own walkthrough uses', () => {
    const r = rule('Quota utilization above 80%');
    expect(r.threshold).toBe(DEFAULT_QUOTA_UTILIZATION_THRESHOLD);
    expect(r.threshold).toBe(80);
    // "Greater", not "GreaterThanOrEqualTo" — AWS's walkthrough says Greater
    // than 80, and the banding in quota-catalog agrees that 80.0 is still ok.
    expect(r.comparisonOperator).toBe('GreaterThanThreshold');
    expect(r.metricName).toBe(QUOTA_UTILIZATION_METRIC_NAME);
    expect(r.namespace).toBe(QUOTA_DERIVED_NAMESPACE);
  });

  it('treats unknown utilization as insufficient data, not as healthy', () => {
    // Utilization is undefined only when we could not read the quota or the
    // usage. notBreaching there would report headroom we never measured.
    expect(rule('Quota utilization above 80%').treatMissingData).toBe('missing');
  });

  it('treats absent throttling as not breaching, because the metric is absent when fine', () => {
    // AWS/Usage publishes ThrottleCount only when a throttle happened. Under
    // `missing` a perfectly healthy account would sit in INSUFFICIENT_DATA
    // permanently, which trains operators to ignore the alert.
    const r = rule('Quota throttling');
    expect(r.treatMissingData).toBe('notBreaching');
    expect(r.metricName).toBe('ThrottleCount');
    // Zero rather than a round number: any throttle is the quota being enforced.
    expect(r.threshold).toBe(0);
    expect(r.comparisonOperator).toBe('GreaterThanThreshold');
  });

  it('requires several datapoints so a lone spike does not page', () => {
    for (const r of QUOTA_PACK.defaultAlertRules) {
      expect(r.datapointsToAlarm).toBeGreaterThan(1);
      expect(r.datapointsToAlarm).toBeLessThanOrEqual(r.evaluationPeriods);
      expect(r.periodS).toBe(60);
    }
  });

  it('rates 80 percent as a warning, since the point is to act before it is critical', () => {
    expect(rule('Quota utilization above 80%').severity).toBe('warning');
  });
});

describe('documented omissions', () => {
  it('says why most quotas have no headroom at all', () => {
    // The single most likely operator question on first look at the panel.
    const absent = QUOTA_PACK.absentMetrics.find((a) => /publish no usage metrics/i.test(a.label));
    expect(absent).toBeDefined();
    expect(absent!.reason).toMatch(/17 AWS services/);
    expect(absent!.reason).toMatch(/no UsageMetric/);
    // And that this shows as undefined rather than as zero, which would read as
    // "plenty of headroom" — the exact opposite of the truth.
    expect(absent!.remedy).toMatch(/undefined rather than zero/i);
  });

  it('records why utilization is not a CloudWatch metric-math series', () => {
    const absent = QUOTA_PACK.absentMetrics.find((a) => /metric-math/i.test(a.label));
    expect(absent).toBeDefined();
    expect(absent!.reason).toMatch(/MetricStat-only/);
    expect(absent!.reason).toMatch(/cross-account/);
    // The compensating benefit, so the trade reads as a trade and not a loss.
    expect(absent!.remedy).toMatch(/absolute headroom/i);
  });

  it('records that resource-level quotas are deliberately not inventoried', () => {
    const absent = QUOTA_PACK.absentMetrics.find((a) => /per-resource/i.test(a.label));
    expect(absent).toBeDefined();
    // The failure this avoids: measuring usage against the wrong applied value.
    expect(absent!.remedy).toMatch(/account-level/);
  });

  it('leaves a null remedy where there genuinely is none', () => {
    const absent = QUOTA_PACK.absentMetrics.find((a) => /Sub-minute/i.test(a.label));
    expect(absent!.remedy).toBeNull();
  });
});
