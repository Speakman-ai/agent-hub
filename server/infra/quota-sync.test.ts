/**
 * Quota discovery: ListServiceQuotas → inventory rows plus applied limits.
 *
 * The behaviours worth pinning are all about what is *not* inventoried, and why
 * each omission is or is not a problem.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

import {
  ListServiceQuotasCommand,
  type ListServiceQuotasCommandOutput,
  type ServiceQuota,
} from '@aws-sdk/client-service-quotas';

import { initInfraDb, closeInfraDb, infraResourceKey } from './infra-db.js';
import { QUOTA_SERVICE_TOKEN } from './quota-catalog.js';
import { listInfraServiceQuotas } from './quota-store.js';
import {
  QUOTA_PAGE_SIZE,
  describeQuotaScope,
  mapServiceQuota,
  quotaResourceId,
  type QuotaScope,
  type ServiceQuotasDescribeClient,
} from './quota-sync.js';

let dir: string;
const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);

const SCOPE: QuotaScope = {
  project_id: 'proj',
  profile_name: 'monitor',
  account_id: '123456789012',
  region: 'us-east-1',
  service: QUOTA_SERVICE_TOKEN,
};

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'infra-quota-sync-'));
  initInfraDb(dir);
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
});

/** A measurable EC2 vCPU quota. */
function quota(overrides: Partial<ServiceQuota> = {}): ServiceQuota {
  return {
    ServiceCode: 'ec2',
    QuotaCode: 'L-1216C47A',
    QuotaName: 'Running On-Demand Standard instances',
    QuotaArn: 'arn:aws:servicequotas:us-east-1:123456789012:ec2/L-1216C47A',
    Value: 640,
    Unit: 'None',
    Adjustable: true,
    GlobalQuota: false,
    UsageMetric: {
      MetricNamespace: 'AWS/Usage',
      MetricName: 'ResourceCount',
      MetricDimensions: {
        Service: 'EC2',
        Class: 'Standard/OnDemand',
        Type: 'Resource',
        Resource: 'vCPU',
      },
      MetricStatisticRecommendation: 'Maximum',
    },
    ...overrides,
  } as ServiceQuota;
}

/** Stub client returning a fixed page list per service code. */
function stubQuotas(
  pagesByService: Record<string, Array<Partial<ListServiceQuotasCommandOutput>>>,
  errors: Record<string, Error> = {},
): ServiceQuotasDescribeClient & { calls: ListServiceQuotasCommand[] } {
  const calls: ListServiceQuotasCommand[] = [];
  const cursor: Record<string, number> = {};
  return {
    calls,
    async send(command: ListServiceQuotasCommand) {
      calls.push(command);
      const code = String(command.input.ServiceCode);
      if (errors[code]) throw errors[code];
      const pages = pagesByService[code] ?? [];
      const i = cursor[code] ?? 0;
      cursor[code] = i + 1;
      return (pages[i] ?? {}) as ListServiceQuotasCommandOutput;
    },
  };
}

describe('mapServiceQuota', () => {
  it('maps a measurable quota into an inventory row and a stored limit', () => {
    const mapped = mapServiceQuota(quota(), SCOPE);
    expect(typeof mapped).not.toBe('string');
    if (typeof mapped === 'string') throw new Error('unreachable');

    expect(mapped.resource.resourceId).toBe('ec2/L-1216C47A');
    // The dimension set the collector binds the pack metric on.
    expect(mapped.resource.metricDimensions).toEqual({
      Service: 'EC2',
      Class: 'Standard/OnDemand',
      Type: 'Resource',
      Resource: 'vCPU',
    });
    // The gate that stops CallCount and ThrottleCount also binding to this
    // quota and billing two queries that could only ever return nothing.
    expect(mapped.resource.features).toEqual({ 'usage:ResourceCount': true });
    expect(mapped.quota.value).toBe(640);
    expect(mapped.quota.adjustable).toBe(true);
  });

  it('reports "no usage metric" for the common case, distinctly from a failure', () => {
    // Most quotas carry no UsageMetric. This must be an ordinary outcome the
    // sweep counts, never something logged or retried.
    expect(mapServiceQuota(quota({ UsageMetric: undefined }), SCOPE)).toBe('no-usage-metric');
  });

  it('distinguishes a usage metric this pack cannot query from one that is absent', () => {
    // A shape we do not understand means AWS extended the namespace and we have
    // not caught up — rare, and worth counting separately so it is visible.
    const unsupported = mapServiceQuota(
      quota({
        UsageMetric: {
          MetricNamespace: 'AWS/Usage',
          MetricName: 'SomeFutureCount',
          MetricDimensions: { Service: 'EC2', Class: 'None', Type: 'API', Resource: 'X' },
        },
      }),
      SCOPE,
    );
    expect(unsupported).toBe('unsupported-usage-metric');
  });

  it('keys the resource id on service and quota code together', () => {
    // Quota codes are only unique within a service. Keying on the code alone
    // would collide two unrelated quotas into one row and merge their charts.
    expect(quotaResourceId('ec2', 'L-1216C47A')).toBe('ec2/L-1216C47A');
    const dynamo = mapServiceQuota(quota({ ServiceCode: 'dynamodb' }), SCOPE);
    if (typeof dynamo === 'string') throw new Error('unreachable');
    expect(dynamo.resource.resourceId).toBe('dynamodb/L-1216C47A');
  });

  it('prefers the account id in the quota ARN over the scope’s', () => {
    const mapped = mapServiceQuota(
      quota({ QuotaArn: 'arn:aws:servicequotas:us-east-1:999988887777:ec2/L-1216C47A' }),
      SCOPE,
    );
    if (typeof mapped === 'string') throw new Error('unreachable');
    expect(mapped.resource.accountId).toBe('999988887777');
  });

  it('falls back to the scope account when the ARN carries none', () => {
    const mapped = mapServiceQuota(quota({ QuotaArn: undefined }), SCOPE);
    if (typeof mapped === 'string') throw new Error('unreachable');
    expect(mapped.resource.accountId).toBe('123456789012');
  });

  it('refuses to key a row when no account id resolves at all', () => {
    // Writing one would produce a resource_key nothing else could join to.
    const mapped = mapServiceQuota(quota({ QuotaArn: undefined }), {
      ...SCOPE,
      account_id: null,
    });
    expect(mapped).toBe('unidentifiable');
  });

  it('stores an unavailable applied value as null, never as zero', () => {
    // AWS documents that for some quotas only the default value is available.
    // Zero would compute as 0% utilization, which reads as "plenty of
    // headroom" — the opposite of "we do not know".
    const mapped = mapServiceQuota(quota({ Value: undefined }), SCOPE);
    if (typeof mapped === 'string') throw new Error('unreachable');
    expect(mapped.quota.value).toBeNull();
  });

  it('carries no tags and no lifecycle state, because a quota has neither', () => {
    const mapped = mapServiceQuota(quota(), SCOPE);
    if (typeof mapped === 'string') throw new Error('unreachable');
    expect(mapped.resource.tagsJson).toBeNull();
    // A state value would invite the collector's terminal-state check to act on
    // something that means nothing for a quota.
    expect(mapped.resource.state).toBeNull();
  });
});

describe('describeQuotaScope', () => {
  it('asks for account-level quotas at the documented maximum page size', () => {
    // ACCOUNT is explicit rather than defaulted: a RESOURCE-level quota keys on
    // a context AWS/Usage dimensions do not carry, so measuring usage against
    // it would compare against a limit that does not apply.
    const client = stubQuotas({ ec2: [{ Quotas: [quota()] }] });
    return describeQuotaScope(client, SCOPE, {
      serviceCodes: ['ec2'],
      maxPagesPerService: 5,
      nowMs: NOW,
    }).then(() => {
      expect(client.calls[0]!.input.QuotaAppliedAtLevel).toBe('ACCOUNT');
      expect(client.calls[0]!.input.MaxResults).toBe(QUOTA_PAGE_SIZE);
      expect(QUOTA_PAGE_SIZE).toBe(100);
    });
  });

  it('inventories only measurable quotas and counts the rest without warning', async () => {
    const warn = vi.fn();
    const client = stubQuotas({
      ec2: [
        {
          Quotas: [
            quota(),
            quota({ QuotaCode: 'L-NOUSAGE', UsageMetric: undefined }),
            quota({ QuotaCode: 'L-NOUSAGE2', UsageMetric: undefined }),
          ],
        },
      ],
    });

    const out = await describeQuotaScope(client, SCOPE, {
      serviceCodes: ['ec2'],
      maxPagesPerService: 5,
      nowMs: NOW,
      warn,
    });

    expect(out.resources).toHaveLength(1);
    expect(out.counters.withoutUsageMetric).toBe(2);
    // Not skipped: a quota with no usage metric is not lost inventory, it is a
    // quota that cannot be measured at any price.
    expect(out.skipped).toBe(0);
    // And emphatically not a warning — this is the majority case.
    expect(warn).not.toHaveBeenCalled();
  });

  it('persists the applied limit alongside the inventory row', async () => {
    const client = stubQuotas({ ec2: [{ Quotas: [quota()] }] });
    await describeQuotaScope(client, SCOPE, {
      serviceCodes: ['ec2'],
      maxPagesPerService: 5,
      nowMs: NOW,
    });

    const stored = listInfraServiceQuotas('proj');
    expect(stored).toHaveLength(1);
    expect(stored[0]!.value).toBe(640);
    expect(stored[0]!.quotaName).toBe('Running On-Demand Standard instances');
    // The pointer round-trips, so the collector knows which metric to query.
    expect(stored[0]!.usageMetric.metricName).toBe('ResourceCount');
    expect(stored[0]!.resourceKey).toBe(
      infraResourceKey({
        projectId: 'proj',
        accountId: '123456789012',
        region: 'us-east-1',
        service: QUOTA_SERVICE_TOKEN,
        resourceId: 'ec2/L-1216C47A',
      }),
    );
  });

  it('says how many quotas publish no usage metric, so the count is not a mystery', async () => {
    // The first question this feature provokes is "why only 2 quotas when the
    // account has hundreds?". Without this line the answer is invisible and an
    // operator reasonably concludes the sweep is broken.
    const info = vi.fn();
    const client = stubQuotas({
      ec2: [
        {
          Quotas: [
            quota(),
            quota({ QuotaCode: 'L-A', UsageMetric: undefined }),
            quota({ QuotaCode: 'L-B', UsageMetric: undefined }),
            quota({ QuotaCode: 'L-C', UsageMetric: undefined }),
          ],
        },
      ],
    });

    await describeQuotaScope(client, SCOPE, {
      serviceCodes: ['ec2'],
      maxPagesPerService: 5,
      nowMs: NOW,
      info,
    });

    const line = String(info.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('1 measurable quota(s)');
    expect(line).toContain('3 quota(s) publish no usage metric');
    // Info, not warn: a large no-usage-metric count is the expected steady
    // state. Logging it as a warning would train operators to ignore warnings.
    expect(line).not.toMatch(/fail|error/i);
  });

  it('mentions an unqueryable usage metric only when there is one', async () => {
    // Rare and worth seeing when it happens; noise on every sweep otherwise.
    const quiet = vi.fn();
    await describeQuotaScope(stubQuotas({ ec2: [{ Quotas: [quota()] }] }), SCOPE, {
      serviceCodes: ['ec2'],
      maxPagesPerService: 5,
      nowMs: NOW,
      info: quiet,
    });
    expect(String(quiet.mock.calls[0]?.[0])).not.toMatch(/cannot query/);

    const loud = vi.fn();
    await describeQuotaScope(
      stubQuotas({
        ec2: [
          {
            Quotas: [
              quota({
                QuotaCode: 'L-FUTURE',
                UsageMetric: {
                  MetricNamespace: 'AWS/Usage',
                  MetricName: 'SomeFutureCount',
                  MetricDimensions: { Service: 'EC2', Class: 'None', Type: 'API', Resource: 'X' },
                },
              }),
            ],
          },
        ],
      }),
      SCOPE,
      { serviceCodes: ['ec2'], maxPagesPerService: 5, nowMs: NOW, info: loud },
    );
    expect(String(loud.mock.calls[0]?.[0])).toMatch(/1 publish one this build cannot query/);
  });

  it('does not let one service code’s failure abort the sweep', async () => {
    // Service Quotas answers an unknown ServiceCode with NoSuchResourceException.
    // A code AWS renames must not take the other thirteen down with it.
    const warn = vi.fn();
    const client = stubQuotas(
      { ec2: [{ Quotas: [quota()] }], dynamodb: [{ Quotas: [] }] },
      { retired: new Error('NoSuchResourceException') },
    );

    const out = await describeQuotaScope(client, SCOPE, {
      serviceCodes: ['retired', 'ec2', 'dynamodb'],
      maxPagesPerService: 5,
      nowMs: NOW,
      warn,
    });

    expect(out.resources).toHaveLength(1);
    expect(out.counters.servicesFailed).toBe(1);
    expect(out.counters.servicesQueried).toBe(3);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("'retired'"))).toBe(true);
  });

  it('follows NextToken and stops at the page cap with a warning', async () => {
    const warn = vi.fn();
    const client = stubQuotas({
      ec2: [
        { Quotas: [quota({ QuotaCode: 'L-1' })], NextToken: 'p2' },
        { Quotas: [quota({ QuotaCode: 'L-2' })], NextToken: 'p3' },
      ],
    });

    const out = await describeQuotaScope(client, SCOPE, {
      serviceCodes: ['ec2'],
      maxPagesPerService: 2,
      nowMs: NOW,
      warn,
    });

    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]!.input.NextToken).toBeUndefined();
    expect(client.calls[1]!.input.NextToken).toBe('p2');
    expect(out.resources).toHaveLength(2);
    // Truncation must be audible: a silent cap reads as "that is all of them".
    expect(warn.mock.calls.some((c) => String(c[0]).includes('page cap'))).toBe(true);
  });

  it('does not prune limits when every service call failed', async () => {
    // A sweep that learned nothing must not delete what the last one learned.
    // Pruning here would blank the panel on a transient outage.
    const seed = stubQuotas({ ec2: [{ Quotas: [quota()] }] });
    await describeQuotaScope(seed, SCOPE, {
      serviceCodes: ['ec2'],
      maxPagesPerService: 5,
      nowMs: NOW,
    });
    expect(listInfraServiceQuotas('proj')).toHaveLength(1);

    const broken = stubQuotas({}, { ec2: new Error('ThrottlingException') });
    await describeQuotaScope(broken, SCOPE, {
      serviceCodes: ['ec2'],
      maxPagesPerService: 5,
      nowMs: NOW + 3_600_000,
      warn: vi.fn(),
    });

    expect(listInfraServiceQuotas('proj')).toHaveLength(1);
  });

  it('prunes a quota AWS no longer reports once a sweep succeeds', async () => {
    const seed = stubQuotas({
      ec2: [{ Quotas: [quota(), quota({ QuotaCode: 'L-GONE' })] }],
    });
    await describeQuotaScope(seed, SCOPE, {
      serviceCodes: ['ec2'],
      maxPagesPerService: 5,
      nowMs: NOW,
    });
    expect(listInfraServiceQuotas('proj')).toHaveLength(2);

    const later = stubQuotas({ ec2: [{ Quotas: [quota()] }] });
    await describeQuotaScope(later, SCOPE, {
      serviceCodes: ['ec2'],
      maxPagesPerService: 5,
      nowMs: NOW + 3_600_000,
    });

    // A stale limit is deleted rather than kept, because showing a limit that
    // no longer applies is worse than showing nothing.
    const remaining = listInfraServiceQuotas('proj');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.quotaCode).toBe('L-1216C47A');
  });

  it('deduplicates a quota reported under two service codes', async () => {
    const client = stubQuotas({
      ec2: [{ Quotas: [quota()] }],
      fargate: [{ Quotas: [quota()] }],
    });
    const out = await describeQuotaScope(client, SCOPE, {
      serviceCodes: ['ec2', 'fargate'],
      maxPagesPerService: 5,
      nowMs: NOW,
    });
    // Two upserts of one key in a single transaction would double-count the
    // inventory without changing the stored row.
    expect(out.resources).toHaveLength(1);
    expect(listInfraServiceQuotas('proj')).toHaveLength(1);
  });
});
