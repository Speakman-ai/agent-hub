/**
 * S3 pack-definition tests.
 *
 * The cross-pack invariants live in `ec2.test.ts`'s `describe.each`. What is
 * here is the S3-specific facts, and three of them are load-bearing in a way no
 * previous pack's were:
 *
 *   - the two storage metrics live at the same dimension *names* and disjoint
 *     dimension *values*, which is the whole reason `dimensionValues` exists;
 *   - the free half and the paid half of one namespace need opposite polling
 *     cadences, so the per-metric floor rather than the service tier has to be
 *     what decides;
 *   - `4xxErrors` / `5xxErrors` mean different things on `Average` and on `Sum`,
 *     and AWS's recommended alarm is only correct on one of them.
 */

import { describe, it, expect } from 'vitest';
import { S3_ALL_STORAGE_TYPES, S3_PACK, S3_REQUEST_METRICS_FEATURE } from './s3.js';
import { PERCENTILE_STATISTIC_TOKEN, type InfraPackMetric } from './types.js';
import {
  getServiceMetricPack,
  servicePollTierSeconds,
  effectiveServicePollIntervalSeconds,
} from '../service-metric-packs.js';
import { bindMetricDimensions } from '../metric-collector.js';
import { featureNotices, type InfraServicePackWire } from '../../../shared/utils/infraPacks.js';

const ONE_DAY = 86_400;

function metric(name: string, stat?: string): InfraPackMetric {
  const found = S3_PACK.metrics.find(
    (m) => m.metricName === name && (stat === undefined || m.stat === stat),
  );
  expect(found, `${name}${stat ? ` (${stat})` : ''} is not declared`).toBeDefined();
  return found!;
}

const rule = (name: string) => {
  const found = S3_PACK.defaultAlertRules.find((r) => r.name === name);
  expect(found, `no default rule named ${name}`).toBeDefined();
  return found!;
};

const absent = (pattern: RegExp) => {
  const found = S3_PACK.absentMetrics.find((a) => pattern.test(a.label));
  expect(found, `nothing in absentMetrics matches ${pattern}`).toBeDefined();
  return found!;
};

/** A resource row as inventory sync writes it, for the binding assertions. */
function bucketRow(features: Record<string, boolean> = {}) {
  return { features_json: JSON.stringify(features) };
}

describe('s3 pack — the AWS facts it claims to encode', () => {
  it('collects only the AWS/S3 namespace', () => {
    // Storage Lens (AWS/S3/Storage-Lens) and the replication metrics are
    // deliberately elsewhere; both are indexed in absentMetrics.
    expect(new Set(S3_PACK.metrics.map((m) => m.namespace))).toEqual(new Set(['AWS/S3']));
  });

  it('declares every metric the card requires', () => {
    expect([...new Set(S3_PACK.metrics.map((m) => m.metricName))].sort()).toEqual([
      '4xxErrors',
      '5xxErrors',
      'AllRequests',
      'BucketSizeBytes',
      'BytesDownloaded',
      'BytesUploaded',
      'FirstByteLatency',
      'GetRequests',
      'NumberOfObjects',
      'PutRequests',
      'TotalRequestLatency',
    ]);
  });

  describe('free daily storage metrics', () => {
    it('stores both on Average, AWS’s only valid statistic for them', () => {
      for (const name of ['BucketSizeBytes', 'NumberOfObjects']) {
        const m = metric(name);
        expect(m.stat).toBe('Average');
        expect(m.validStatistics).toEqual(['Average']);
        expect(m.requiresFeature, `${name} must be free`).toBeNull();
      }
    });

    it('floors both at a day, so they are polled once a day and not every tick', () => {
      // "These storage metrics for Amazon S3 are reported once per day." The
      // floor is what turns decision INFRA-COST's "S3 daily storage metrics are
      // polled at most a few times a day" into a property of the code: at the
      // 300s service tier, asking every tick would be 288 billed requests a day
      // for one datapoint.
      for (const name of ['BucketSizeBytes', 'NumberOfObjects']) {
        const spec = getServiceMetricPack('s3').find((s) => s.metricName === name)!;
        expect(spec.minPeriodSeconds).toBe(ONE_DAY);
        expect(effectiveServicePollIntervalSeconds('s3', spec)).toBe(ONE_DAY);
      }
    });

    it('keys both on BucketName + StorageType', () => {
      for (const name of ['BucketSizeBytes', 'NumberOfObjects']) {
        expect(metric(name).dimensions).toEqual(['BucketName', 'StorageType']);
      }
    });

    it('pins NumberOfObjects to AllStorageTypes and leaves BucketSizeBytes open', () => {
      // AWS lists AllStorageTypes as NumberOfObjects' only valid storage-type
      // filter, and does not list it among BucketSizeBytes'. The asymmetry in
      // how the pack encodes that is deliberate: pinning the byte total to a
      // transcribed list of storage classes would silently stop collecting the
      // next class AWS ships.
      expect(metric('NumberOfObjects').dimensionValues).toEqual({
        StorageType: S3_ALL_STORAGE_TYPES,
      });
      expect(metric('BucketSizeBytes').dimensionValues).toBeUndefined();
    });

    it('never asks a storage-class row for an object count', () => {
      // The concrete payoff of the pin. Without it every storage-class row would
      // carry a permanently empty NumberOfObjects chart and a billed
      // GetMetricData entry to go with it.
      const specs = getServiceMetricPack('s3');
      const objectCount = specs.find((s) => s.metricName === 'NumberOfObjects')!;
      const classRow = { BucketName: 'logs', StorageType: 'StandardStorage' };
      expect(bindMetricDimensions(objectCount, bucketRow(), classRow)).toBeNull();

      const bucketDims = { BucketName: 'logs', StorageType: S3_ALL_STORAGE_TYPES };
      expect(bindMetricDimensions(objectCount, bucketRow(), bucketDims)).toEqual(bucketDims);
    });

    it('explains, rather than hides, the one empty series that costs', () => {
      // BucketSizeBytes is unpinned, so it *is* requested on the bucket's own
      // AllStorageTypes row and returns nothing. That trade is stated where the
      // UI renders it, beside the chart, rather than left as a mystery.
      const m = metric('BucketSizeBytes');
      expect(m.appliesTo.universal).toBe(false);
      expect(m.appliesTo.condition).toMatch(/no AllStorageTypes total for bytes/i);
      expect(m.appliesTo.condition).toMatch(/object-count row/i);
    });
  });

  describe('paid request metrics', () => {
    const requestMetrics = () =>
      S3_PACK.metrics.filter((m) => m.requiresFeature === S3_REQUEST_METRICS_FEATURE);

    it('gates every one of them on a metrics configuration existing', () => {
      // "Metrics configurations are necessary only to enable request metrics."
      // A bucket without one publishes nothing, so a collected series there
      // would be a billed request for data AWS never emits.
      expect(requestMetrics()).toHaveLength(11);
      for (const m of requestMetrics()) {
        expect(m.dimensions).toEqual(['BucketName', 'FilterId']);
        expect(m.minPeriodSeconds).toBe(60);
      }
      // And nothing free is gated, so turning the feature off never costs an
      // operator their storage charts.
      for (const name of ['BucketSizeBytes', 'NumberOfObjects']) {
        expect(metric(name).requiresFeature).toBeNull();
      }
    });

    it('is skipped entirely for a bucket with no metrics configuration', () => {
      const spec = getServiceMetricPack('s3').find(
        (s) => s.metricName === 'AllRequests' && s.stat === 'Sum',
      )!;
      const dims = { BucketName: 'logs', FilterId: 'EntireBucket' };
      expect(bindMetricDimensions(spec, bucketRow({ requestMetrics: false }), dims)).toBeNull();
      // An unrecorded flag reads as off too — the fail-closed direction.
      expect(bindMetricDimensions(spec, bucketRow(), dims)).toBeNull();
      expect(bindMetricDimensions(spec, bucketRow({ requestMetrics: true }), dims)).toEqual(dims);
    });

    it('describes the feature as an AWS-side charge with a source', () => {
      const feature = S3_PACK.features.find((f) => f.key === S3_REQUEST_METRICS_FEATURE)!;
      expect(feature.label).toBe('S3 request metrics');
      // "These CloudWatch metrics are billed at the same rate as the Amazon
      // CloudWatch custom metrics." The claim is the point of the panel.
      expect(feature.costNote).toMatch(/custom metrics/i);
      expect(feature.whenOff).toMatch(/metrics configuration/i);
      // Storage metrics survive the feature being off, and an operator staring
      // at an empty Requests panel needs to be told that before they go looking.
      expect(feature.whenOff).toMatch(/storage metrics are unaffected/i);
    });

    it('gives the UI a notice that says "not configured", not "no data"', () => {
      // The acceptance criterion, driven through the same helper web and mobile
      // render with. A bucket row whose flag is false must produce a notice
      // naming the eleven metrics it is hiding; a bucket with a configuration
      // must produce none, so the panel is not crying wolf on a working bucket.
      const wire = S3_PACK as unknown as InfraServicePackWire;

      const off = featureNotices(wire, {
        service: 's3',
        metricDimensions: { BucketName: 'logs', StorageType: S3_ALL_STORAGE_TYPES },
        features: { requestMetrics: false },
      });
      expect(off).toHaveLength(1);
      expect(off[0].feature.key).toBe(S3_REQUEST_METRICS_FEATURE);
      expect(off[0].gatedMetricNames).toEqual([
        '4xxErrors',
        '5xxErrors',
        'AllRequests',
        'BytesDownloaded',
        'BytesUploaded',
        'FirstByteLatency',
        'GetRequests',
        'PutRequests',
        'TotalRequestLatency',
      ]);

      const on = featureNotices(wire, {
        service: 's3',
        metricDimensions: { BucketName: 'logs', FilterId: 'EntireBucket' },
        features: { requestMetrics: true },
      });
      expect(on).toEqual([]);
    });

    it('polls them at the collector tick, not at the daily storage cadence', () => {
      // The reason the floor is per-metric rather than per-service: one S3 scope
      // carries a 1-minute signal and a 1-day signal at once, and a single
      // service tier could serve neither.
      expect(servicePollTierSeconds('s3')).toBe(300);
      const spec = getServiceMetricPack('s3').find((s) => s.metricName === 'FirstByteLatency')!;
      expect(effectiveServicePollIntervalSeconds('s3', spec)).toBe(300);
    });
  });

  describe('4xxErrors and 5xxErrors, both ways', () => {
    it.each(['4xxErrors', '5xxErrors'])('collects %s as a rate and as a count', (name) => {
      // AWS: "The Average statistic shows the error rate, and the Sum statistic
      // shows the count of that type of error, during each period." Two
      // statistics is two stored series, and neither is derivable from the
      // other without the request total.
      const rate = metric(name, 'Average');
      const count = metric(name, 'Sum');
      expect(rate.metricType).toBe('gauge');
      expect(count.metricType).toBe('counter');
      expect(rate.description).toMatch(/rate/i);
      expect(count.description).toMatch(/count/i);
      for (const m of [rate, count]) {
        expect(m.validStatistics).toEqual(['Average', 'Sum', 'Minimum', 'Maximum', 'SampleCount']);
      }
    });

    it('collects the denominator the rate is a share of', () => {
      // A rate with no volume beside it cannot distinguish a 5% failure on ten
      // requests from one on ten million.
      expect(metric('AllRequests').stat).toBe('Sum');
      expect(metric('AllRequests').description).toMatch(/denominator/i);
    });

    it.each([
      ['S3 bucket 4xxErrors', '4xxErrors', 'S3 bucket 4xx error rate', 'warning'],
      ['S3 bucket 5xxErrors', '5xxErrors', 'S3 bucket 5xx error rate', 'critical'],
    ])('encodes AWS’s recommended %s alarm verbatim', (_label, metricName, ruleName, severity) => {
      // The CloudWatch recommended-alarms page, Amazon S3 section: Average,
      // threshold 0.05, GREATER_THAN_THRESHOLD, period 60, 15 datapoints of 15,
      // dimensions BucketName + FilterId.
      const r = rule(ruleName);
      expect(r.metricName).toBe(metricName);
      expect(r.stat).toBe('Average');
      expect(r.dimensions).toEqual(['BucketName', 'FilterId']);
      expect(r.threshold).toBe(0.05);
      expect(r.comparisonOperator).toBe('GreaterThanThreshold');
      expect(r.periodS).toBe(60);
      expect(r.evaluationPeriods).toBe(15);
      expect(r.datapointsToAlarm).toBe(15);
      expect(r.severity).toBe(severity);
      expect(r.rationale).toMatch(/5% of total requests/i);
    });

    it('alarms on the rate rather than the count, and says why that matters', () => {
      // 0.05 is five percent on Average and five *errors* on Sum. A rule that
      // kept the threshold and swapped the statistic would look identical and
      // page on a bucket serving a million clean requests a minute.
      expect(rule('S3 bucket 5xx error rate').rationale).toMatch(/0 or 1 per request/i);
      expect(
        S3_PACK.defaultAlertRules.some(
          (r) => r.metricName.endsWith('xxErrors') && r.stat === 'Sum',
        ),
      ).toBe(false);
    });
  });

  describe('storage rules and the growth gap', () => {
    it('ships a level rule whose threshold is labelled a placeholder, not guidance', () => {
      // AWS publishes no alarm for S3 storage and no threshold could be right
      // for every workload, so the rule is a form pre-fill. Saying so in the
      // rationale is what keeps it from reading as a recommendation — decision
      // INFRA-ALERT's "AWS's own published guidance rather than round numbers".
      const r = rule('S3 bucket size above a baseline you set');
      expect(r.metricName).toBe('BucketSizeBytes');
      expect(r.stat).toBe('Average');
      expect(r.dimensions).toEqual(['BucketName', 'StorageType']);
      expect(r.periodS).toBe(ONE_DAY);
      expect(r.severity).toBe('info');
      expect(r.rationale).toMatch(/No AWS-published alarm exists/i);
      expect(r.rationale).toMatch(/unit standing in for the number you have to supply/i);
    });

    it('documents that growth itself needs metric math it cannot evaluate', () => {
      const gap = absent(/storage-growth alarm/i);
      expect(gap.reason).toMatch(/metric-math/i);
      // The remedy has to point at what does work, or an operator reads
      // "unsupported" and stops looking.
      expect(gap.remedy).toMatch(/daily BucketSizeBytes series/i);
    });

    it('treats missing data as not breaching on every rule, and explains the divergence', () => {
      // An unpinned rule matches all three kinds of S3 row, of which only one
      // publishes any given series. Under the CloudWatch default of `missing`
      // the other two would sit in INSUFFICIENT_DATA forever.
      for (const r of S3_PACK.defaultAlertRules) {
        expect(r.treatMissingData, `${r.name}`).toBe('notBreaching');
      }
    });
  });

  describe('what it deliberately does not collect', () => {
    it('indexes the request-metrics opt-in as the reason a panel is empty', () => {
      const gap = absent(/no metrics configuration/i);
      expect(gap.reason).toMatch(/detected rather than assumed/i);
      expect(gap.remedy).toMatch(/put-bucket-metrics-configuration/);
    });

    it('records the two-week ListMetrics blind spot for a brand-new storage class', () => {
      const gap = absent(/only just started using/i);
      expect(gap.reason).toMatch(/past two weeks/i);
      expect(gap.remedy).toMatch(/hourly/i);
    });

    it('excludes replication metrics and hands over AWS’s alarm shape for them', () => {
      const gap = absent(/replication/i);
      expect(gap.reason).toMatch(/RuleId/);
      // AWS's recommended alarm, plus the S3 docs' specific instruction to treat
      // missing data as ignore — the metric emits nothing during an idle minute.
      expect(gap.remedy).toMatch(/5 datapoints of 5/);
      expect(gap.remedy).toMatch(/ignore/i);
    });

    it('excludes per-prefix storage size on AWS’s own grounds', () => {
      const gap = absent(/per-prefix/i);
      expect(gap.reason).toMatch(/filtered subset of objects/i);
      expect(gap.remedy).toMatch(/Storage Lens/i);
    });

    it('excludes directory buckets because ListBuckets cannot see them', () => {
      const gap = absent(/directory buckets/i);
      expect(gap.reason).toMatch(/not supported for directory buckets/i);
    });

    it('names the request counters it left out and why they would cost forever', () => {
      const gap = absent(/remaining request counters/i);
      expect(gap.reason).toMatch(/only if there are requests of that type/i);
    });
  });

  it('declares the three dimensions it keys series on', () => {
    expect(S3_PACK.dimensions.map((d) => d.name).sort()).toEqual([
      'BucketName',
      'FilterId',
      'StorageType',
    ]);
  });

  it('records percentiles as legal on the latency and byte metrics', () => {
    // AWS lists "any percentile between p0.0 and p100" for the latency metrics
    // and "any percentile between p0.0 and p99.9" for the byte counters. The
    // token stands for the whole family; storing Average and Sum is a separate
    // choice from what is documented as meaningful.
    for (const name of ['FirstByteLatency', 'TotalRequestLatency', 'BytesDownloaded']) {
      expect(metric(name).validStatistics).toContain(PERCENTILE_STATISTIC_TOKEN);
    }
  });

  it('projects into the collector query list', () => {
    const specs = getServiceMetricPack('s3');
    expect(specs).toHaveLength(S3_PACK.metrics.length);
    expect(specs.filter((s) => s.requiresFeature === S3_REQUEST_METRICS_FEATURE)).toHaveLength(11);
  });
});
