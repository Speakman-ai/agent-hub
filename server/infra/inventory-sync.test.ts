/**
 * Inventory sync — the describe-API sweep that seeds `infra_resources`.
 *
 * The behaviours pinned here are the ones the epic depends on and that a
 * refactor would plausibly break: `first_seen` surviving a re-sync, a
 * disappeared resource ageing out instead of being deleted, the tag filter
 * reaching AWS rather than being applied client-side, and one failing scope not
 * taking the tick down with it.
 *
 * No AWS SDK client is ever constructed — every test injects an
 * `ec2ClientFactory`, so nothing here can reach the network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { DescribeInstancesCommand, DescribeNatGatewaysCommand } from '@aws-sdk/client-ec2';
import type {
  DescribeInstancesCommandOutput,
  DescribeNatGatewaysCommandOutput,
  Instance,
  NatGateway,
  Reservation,
} from '@aws-sdk/client-ec2';
import {
  DescribeLoadBalancersCommand,
  DescribeTagsCommand,
  DescribeTargetGroupsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import type {
  DescribeLoadBalancersCommandOutput,
  DescribeTagsCommandOutput,
  DescribeTargetGroupsCommandOutput,
  LoadBalancer,
  TargetGroup,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  DescribeClustersCommand,
  DescribeServicesCommand,
  ListAccountSettingsCommand,
  ListClustersCommand,
  ListServicesCommand,
} from '@aws-sdk/client-ecs';
import { initInfraDb, getInfraDb, closeInfraDb, infraResourceKey } from './infra-db.js';
import {
  runInfraInventorySync,
  buildEc2TagFilters,
  accountIdFromArn,
  clusterHasContainerInsights,
  isContainerInsightsOnValue,
  ECS_CONTAINER_INSIGHTS_ON_VALUES,
  INFRA_INVENTORY_SYNC_CRON,
  INFRA_SYNCABLE_SERVICES,
  MAX_PAGES_PER_SCOPE,
  isAwsAuthorizationError,
  isElbTagNotFoundError,
  loadBalancerDimensionValue,
  targetGroupDimensionValue,
  type Ec2DescribeClient,
  type EcsDescribeClient,
  type ElbDescribeClient,
  type InfraScopeRow,
} from './inventory-sync.js';
import { infraPackedServices } from './packs/index.js';
import { estimateIntervalSeconds } from '../cron-tick.js';
// The collector's own planner, so "is it collected" is answered by the code
// that decides it rather than by re-reading the feature flag in the test.
import { planQueries, type CollectableResource } from './metric-collector.js';

let dir: string;

const T0 = 1_700_000_000_000;
const T1 = T0 + 3_600_000;

interface ResourceRow {
  resource_key: string;
  project_id: string;
  account_id: string;
  region: string;
  service: string;
  resource_id: string;
  name: string | null;
  tags_json: string | null;
  environment: string | null;
  state: string | null;
  metric_dimensions_json: string | null;
  features_json: string | null;
  first_seen: number;
  last_seen: number;
}

function insertScope(overrides: Partial<InfraScopeRow> & { id: string }): void {
  const row = {
    project_id: 'proj',
    profile_name: 'monitor',
    account_id: null as string | null,
    region: 'us-east-1',
    service: 'ec2',
    tag_filter_json: null as string | null,
    ...overrides,
  };
  getInfraDb()
    .prepare(
      `INSERT INTO infra_scopes
         (id, project_id, profile_name, account_id, region, service, tag_filter_json,
          enabled, created_at, updated_at)
       VALUES (@id, @project_id, @profile_name, @account_id, @region, @service,
               @tag_filter_json, @enabled, @created_at, @updated_at)`,
    )
    .run({
      ...row,
      enabled: (overrides as { enabled?: number }).enabled ?? 1,
      created_at: T0,
      updated_at: T0,
    });
}

/** An EC2 stub that answers with the given pages in order. */
function stubEc2(
  pages: Array<Partial<DescribeInstancesCommandOutput>>,
): Ec2DescribeClient & { calls: DescribeInstancesCommand[] } {
  const calls: DescribeInstancesCommand[] = [];
  let index = 0;
  return {
    calls,
    async send(command: DescribeInstancesCommand) {
      calls.push(command);
      const page = pages[index] ?? {};
      index += 1;
      return page as DescribeInstancesCommandOutput;
    },
  };
}

function instance(id: string, extra: Partial<Instance> = {}): Instance {
  return { InstanceId: id, State: { Name: 'running' }, ...extra };
}

function reservation(ownerId: string | undefined, instances: Instance[]): Reservation {
  return { OwnerId: ownerId, Instances: instances };
}

function allResources(): ResourceRow[] {
  return getInfraDb()
    .prepare('SELECT * FROM infra_resources ORDER BY resource_id')
    .all() as ResourceRow[];
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'infra-inventory-test-'));
  initInfraDb(dir);
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('INFRA_INVENTORY_SYNC_CRON', () => {
  it('is hourly, and slow enough that defaultTickOptions adds no jitter', () => {
    expect(estimateIntervalSeconds(INFRA_INVENTORY_SYNC_CRON)).toBe(3600);
  });
});

describe('runInfraInventorySync — first sync', () => {
  it('upserts every described instance with first_seen and last_seen at now', async () => {
    insertScope({ id: 's1' });
    const ec2 = stubEc2([
      {
        Reservations: [
          reservation('111122223333', [
            instance('i-aaa', {
              Tags: [
                { Key: 'Name', Value: 'web-1' },
                { Key: 'Environment', Value: 'prod' },
              ],
            }),
            instance('i-bbb', { State: { Name: 'stopped' } }),
          ]),
        ],
      },
    ]);

    const result = await runInfraInventorySync({ nowMs: T0, ec2ClientFactory: () => ec2 });

    expect(result).toEqual({ scopes: 1, synced: 1, failed: 0, upserted: 2, skipped: 0 });
    const rows = allResources();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      resource_id: 'i-aaa',
      project_id: 'proj',
      account_id: '111122223333',
      region: 'us-east-1',
      service: 'ec2',
      name: 'web-1',
      environment: 'prod',
      state: 'running',
      first_seen: T0,
      last_seen: T0,
    });
    expect(rows[0]!.resource_key).toBe(
      infraResourceKey({
        projectId: 'proj',
        accountId: '111122223333',
        region: 'us-east-1',
        service: 'ec2',
        resourceId: 'i-aaa',
      }),
    );
    expect(rows[1]).toMatchObject({ resource_id: 'i-bbb', state: 'stopped', environment: null });
  });

  it('follows NextToken pagination', async () => {
    insertScope({ id: 's1' });
    const ec2 = stubEc2([
      { Reservations: [reservation('111122223333', [instance('i-aaa')])], NextToken: 'page2' },
      { Reservations: [reservation('111122223333', [instance('i-bbb')])] },
    ]);

    const result = await runInfraInventorySync({ nowMs: T0, ec2ClientFactory: () => ec2 });

    expect(result.upserted).toBe(2);
    expect(ec2.calls).toHaveLength(2);
    expect(ec2.calls[1]!.input.NextToken).toBe('page2');
  });

  it('does not poll anything when no scope row exists', async () => {
    const factory = vi.fn();
    const result = await runInfraInventorySync({ nowMs: T0, ec2ClientFactory: factory });
    expect(result).toEqual({ scopes: 0, synced: 0, failed: 0, upserted: 0, skipped: 0 });
    expect(factory).not.toHaveBeenCalled();
  });

  it('ignores disabled scopes and scopes for services this sweep does not describe', async () => {
    insertScope({ id: 'disabled', enabled: 0 } as Partial<InfraScopeRow> & { id: string });
    insertScope({ id: 'rds', service: 'rds' });
    const factory = vi.fn();

    const result = await runInfraInventorySync({ nowMs: T0, ec2ClientFactory: factory });

    expect(result.scopes).toBe(0);
    expect(factory).not.toHaveBeenCalled();
  });

  it('falls back to the scope account id when the reservation carries no OwnerId, and counts what it cannot key', async () => {
    insertScope({ id: 's1', account_id: '999988887777' });
    insertScope({ id: 's2', region: 'eu-west-1' });
    const withFallback = stubEc2([{ Reservations: [reservation(undefined, [instance('i-aaa')])] }]);
    const withNothing = stubEc2([{ Reservations: [reservation(undefined, [instance('i-ccc')])] }]);

    const result = await runInfraInventorySync({
      nowMs: T0,
      ec2ClientFactory: (scope) => (scope.id === 's1' ? withFallback : withNothing),
    });

    expect(result).toMatchObject({ scopes: 2, synced: 2, failed: 0, upserted: 1, skipped: 1 });
    const rows = allResources();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resource_id: 'i-aaa', account_id: '999988887777' });
  });
});

describe('runInfraInventorySync — re-sync', () => {
  it('is idempotent: a second sweep refreshes last_seen and preserves first_seen', async () => {
    insertScope({ id: 's1' });
    const page = {
      Reservations: [
        reservation('111122223333', [
          instance('i-aaa', { Tags: [{ Key: 'Name', Value: 'web-1' }] }),
        ]),
      ],
    };

    await runInfraInventorySync({ nowMs: T0, ec2ClientFactory: () => stubEc2([page]) });
    const second = await runInfraInventorySync({
      nowMs: T1,
      ec2ClientFactory: () => stubEc2([page]),
    });

    expect(second.upserted).toBe(1);
    const rows = allResources();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ first_seen: T0, last_seen: T1 });
  });

  it('refreshes mutable fields when an instance is renamed, re-tagged or changes state', async () => {
    insertScope({ id: 's1' });
    await runInfraInventorySync({
      nowMs: T0,
      ec2ClientFactory: () =>
        stubEc2([
          {
            Reservations: [
              reservation('111122223333', [
                instance('i-aaa', {
                  Tags: [
                    { Key: 'Name', Value: 'old-name' },
                    { Key: 'Environment', Value: 'staging' },
                  ],
                }),
              ]),
            ],
          },
        ]),
    });

    await runInfraInventorySync({
      nowMs: T1,
      ec2ClientFactory: () =>
        stubEc2([
          {
            Reservations: [
              reservation('111122223333', [
                instance('i-aaa', {
                  State: { Name: 'stopped' },
                  Tags: [
                    { Key: 'Name', Value: 'new-name' },
                    { Key: 'Environment', Value: 'prod' },
                  ],
                }),
              ]),
            ],
          },
        ]),
    });

    const rows = allResources();
    expect(rows[0]).toMatchObject({
      name: 'new-name',
      environment: 'prod',
      state: 'stopped',
      first_seen: T0,
      last_seen: T1,
    });
  });
});

describe('runInfraInventorySync — resource disappearance', () => {
  it('ages a vanished resource out by a stale last_seen instead of deleting the row', async () => {
    insertScope({ id: 's1' });
    await runInfraInventorySync({
      nowMs: T0,
      ec2ClientFactory: () =>
        stubEc2([
          {
            Reservations: [reservation('111122223333', [instance('i-aaa'), instance('i-bbb')])],
          },
        ]),
    });
    expect(allResources()).toHaveLength(2);

    // i-bbb was terminated and is no longer returned at all.
    await runInfraInventorySync({
      nowMs: T1,
      ec2ClientFactory: () =>
        stubEc2([{ Reservations: [reservation('111122223333', [instance('i-aaa')])] }]),
    });

    const rows = allResources();
    expect(rows.map((r) => r.resource_id)).toEqual(['i-aaa', 'i-bbb']);
    expect(rows[0]).toMatchObject({ resource_id: 'i-aaa', last_seen: T1 });
    // The subject of any open chart survives; it is simply stale.
    expect(rows[1]).toMatchObject({ resource_id: 'i-bbb', last_seen: T0, first_seen: T0 });
  });

  it('records a still-visible terminated instance with its real state', async () => {
    insertScope({ id: 's1' });
    await runInfraInventorySync({
      nowMs: T0,
      ec2ClientFactory: () =>
        stubEc2([{ Reservations: [reservation('111122223333', [instance('i-aaa')])] }]),
    });

    await runInfraInventorySync({
      nowMs: T1,
      ec2ClientFactory: () =>
        stubEc2([
          {
            Reservations: [
              reservation('111122223333', [instance('i-aaa', { State: { Name: 'terminated' } })]),
            ],
          },
        ]),
    });

    expect(allResources()[0]).toMatchObject({ state: 'terminated', last_seen: T1 });
  });
});

describe('runInfraInventorySync — tag filter', () => {
  it('pushes the scope tag filter into DescribeInstances rather than filtering client-side', async () => {
    insertScope({
      id: 's1',
      tag_filter_json: JSON.stringify({ Environment: ['prod', 'staging'], Team: 'platform' }),
    });
    const ec2 = stubEc2([{ Reservations: [] }]);

    await runInfraInventorySync({ nowMs: T0, ec2ClientFactory: () => ec2 });

    expect(ec2.calls[0]!.input.Filters).toEqual([
      { Name: 'tag:Environment', Values: ['prod', 'staging'] },
      { Name: 'tag:Team', Values: ['platform'] },
    ]);
  });

  it('sends no Filters key at all when the scope has no tag filter', async () => {
    insertScope({ id: 's1' });
    const ec2 = stubEc2([{ Reservations: [] }]);

    await runInfraInventorySync({ nowMs: T0, ec2ClientFactory: () => ec2 });

    expect(ec2.calls[0]!.input.Filters).toBeUndefined();
  });

  it('skips a scope with a malformed tag filter rather than widening it to the whole region', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    insertScope({ id: 's1', tag_filter_json: '{not json' });
    const ec2 = stubEc2([{ Reservations: [reservation('111122223333', [instance('i-aaa')])] }]);

    const result = await runInfraInventorySync({ nowMs: T0, ec2ClientFactory: () => ec2 });

    expect(result).toMatchObject({ scopes: 1, synced: 0, failed: 1, upserted: 0 });
    expect(ec2.calls).toHaveLength(0);
    expect(allResources()).toHaveLength(0);
  });
});

describe('buildEc2TagFilters', () => {
  it('returns no filters for a null or blank filter', () => {
    expect(buildEc2TagFilters(null)).toEqual([]);
    expect(buildEc2TagFilters('   ')).toEqual([]);
  });

  it('accepts a bare string as a single accepted value', () => {
    expect(buildEc2TagFilters('{"Team":"platform"}')).toEqual([
      { Name: 'tag:Team', Values: ['platform'] },
    ]);
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['a JSON array', '["Environment"]'],
    ['a JSON scalar', '"Environment"'],
    ['an empty value list', '{"Environment":[]}'],
    ['a non-string value', '{"Environment":[1]}'],
    ['an empty tag key', '{"":["prod"]}'],
  ])('throws on %s so the caller skips the scope', (_label, json) => {
    expect(() => buildEc2TagFilters(json)).toThrow();
  });
});

describe('runInfraInventorySync — failure isolation', () => {
  it('logs and swallows a per-scope failure, and keeps syncing the other scopes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    insertScope({ id: 'bad', region: 'us-east-1' });
    insertScope({ id: 'good', region: 'eu-west-1' });

    const result = await runInfraInventorySync({
      nowMs: T0,
      ec2ClientFactory: (scope) => {
        if (scope.region === 'us-east-1') {
          return {
            async send() {
              throw new Error(
                'ExpiredToken: the security token included in the request is expired',
              );
            },
          };
        }
        return stubEc2([{ Reservations: [reservation('111122223333', [instance('i-aaa')])] }]);
      },
    });

    expect(result).toMatchObject({ scopes: 2, synced: 1, failed: 1, upserted: 1 });
    expect(allResources().map((r) => r.region)).toEqual(['eu-west-1']);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('proj/monitor/us-east-1/ec2'))).toBe(
      true,
    );
  });

  it('survives a scope whose client cannot be constructed at all', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    insertScope({ id: 'bad' });
    insertScope({ id: 'good', region: 'eu-west-1' });

    const result = await runInfraInventorySync({
      nowMs: T0,
      ec2ClientFactory: (scope) => {
        if (scope.id === 'bad') throw new Error('no monitoring profile is designated');
        return stubEc2([{ Reservations: [reservation('111122223333', [instance('i-aaa')])] }]);
      },
    });

    expect(result).toMatchObject({ synced: 1, failed: 1, upserted: 1 });
  });
});

// ─── ECS ────────────────────────────────────────────────────────────────────

/**
 * An ECS stub built from a plain description of an account.
 *
 * Answers the four inventory calls plus the account-settings probe, and records
 * every command so a test can assert on the pagination and batching the AWS API
 * limits force (`ListServices` defaults to 10 per page, `DescribeServices`
 * hard-caps at 10 per call).
 */
function stubEcs(account: {
  clusters: Array<{
    name: string;
    containerInsights?: string | null;
    status?: string;
    tags?: Array<{ key: string; value: string }>;
    services?: Array<{
      name: string;
      status?: string;
      tags?: Array<{ key: string; value: string }>;
    }>;
  }>;
  accountDefault?: string | null;
  accountSettingsThrows?: boolean;
}): EcsDescribeClient & { calls: unknown[] } {
  const arn = (kind: string, tail: string) => `arn:aws:ecs:us-east-1:111122223333:${kind}/${tail}`;
  const calls: unknown[] = [];

  return {
    calls,
    async send(command: unknown): Promise<never> {
      calls.push(command);

      if (command instanceof ListAccountSettingsCommand) {
        if (account.accountSettingsThrows) throw new Error('AccessDeniedException');
        return {
          settings:
            account.accountDefault === undefined || account.accountDefault === null
              ? []
              : [{ name: 'containerInsights', value: account.accountDefault }],
        } as never;
      }

      if (command instanceof ListClustersCommand) {
        return { clusterArns: account.clusters.map((c) => arn('cluster', c.name)) } as never;
      }

      if (command instanceof DescribeClustersCommand) {
        const wanted = new Set(command.input.clusters ?? []);
        return {
          clusters: account.clusters
            .filter((c) => wanted.has(arn('cluster', c.name)))
            .map((c) => ({
              clusterArn: arn('cluster', c.name),
              clusterName: c.name,
              status: c.status ?? 'ACTIVE',
              settings:
                c.containerInsights === undefined || c.containerInsights === null
                  ? []
                  : [{ name: 'containerInsights', value: c.containerInsights }],
              tags: c.tags ?? [],
            })),
        } as never;
      }

      if (command instanceof ListServicesCommand) {
        const cluster = account.clusters.find(
          (c) => arn('cluster', c.name) === command.input.cluster,
        );
        return {
          serviceArns: (cluster?.services ?? []).map((s) =>
            arn('service', `${cluster!.name}/${s.name}`),
          ),
        } as never;
      }

      if (command instanceof DescribeServicesCommand) {
        const cluster = account.clusters.find(
          (c) => arn('cluster', c.name) === command.input.cluster,
        );
        const wanted = new Set(command.input.services ?? []);
        return {
          services: (cluster?.services ?? [])
            .filter((s) => wanted.has(arn('service', `${cluster!.name}/${s.name}`)))
            .map((s) => ({
              serviceArn: arn('service', `${cluster!.name}/${s.name}`),
              serviceName: s.name,
              status: s.status ?? 'ACTIVE',
              tags: s.tags ?? [],
            })),
        } as never;
      }

      throw new Error(`unexpected ECS command ${String(command)}`);
    },
  } as EcsDescribeClient & { calls: unknown[] };
}

describe('accountIdFromArn', () => {
  it('reads the account out of an ECS ARN', () => {
    expect(accountIdFromArn('arn:aws:ecs:eu-west-1:111122223333:cluster/prod')).toBe(
      '111122223333',
    );
    expect(accountIdFromArn('arn:aws-us-gov:ecs:us-gov-west-1:999988887777:service/a/b')).toBe(
      '999988887777',
    );
  });

  it('returns null for anything that is not an ARN, so the caller can fall back', () => {
    expect(accountIdFromArn(undefined)).toBeNull();
    expect(accountIdFromArn('prod')).toBeNull();
    expect(accountIdFromArn('arn:aws:ecs')).toBeNull();
  });
});

describe('isContainerInsightsOnValue', () => {
  it('accepts both values AWS documents as on', () => {
    // `enhanced` is a superset of `enabled` — it adds per-task and
    // per-container series on top of everything `enabled` publishes — so a
    // cluster on the richer mode has every metric this pack collects.
    expect(ECS_CONTAINER_INSIGHTS_ON_VALUES).toEqual(['enabled', 'enhanced']);
    expect(isContainerInsightsOnValue('enabled')).toBe(true);
    expect(isContainerInsightsOnValue('enhanced')).toBe(true);
  });

  it('is case-insensitive, because the value is echoed account configuration', () => {
    expect(isContainerInsightsOnValue('ENHANCED')).toBe(true);
    expect(isContainerInsightsOnValue('Enabled')).toBe(true);
  });

  it('fails closed on anything else', () => {
    // The direction matters: reading an unknown value as *on* would issue
    // billed GetMetricData for a namespace that may publish nothing, which is
    // exactly the implicit spend INFRA-COST forbids. Reading it as off costs
    // nothing and the UI says the feature is off.
    expect(isContainerInsightsOnValue('disabled')).toBe(false);
    expect(isContainerInsightsOnValue('someFutureMode')).toBe(false);
    expect(isContainerInsightsOnValue('')).toBe(false);
    expect(isContainerInsightsOnValue(null)).toBe(false);
    expect(isContainerInsightsOnValue(undefined)).toBe(false);
  });
});

describe('clusterHasContainerInsights', () => {
  it('treats enhanced as on, because enhanced is a superset of enabled', () => {
    // An equality check against 'enabled' would report a cluster paying for the
    // richer mode as having the feature off, and silently stop collecting.
    expect(
      clusterHasContainerInsights(
        { settings: [{ name: 'containerInsights', value: 'enhanced' }] },
        null,
      ),
    ).toBe(true);
    expect(
      clusterHasContainerInsights(
        { settings: [{ name: 'containerInsights', value: 'enabled' }] },
        null,
      ),
    ).toBe(true);
    expect(
      clusterHasContainerInsights(
        { settings: [{ name: 'containerInsights', value: 'disabled' }] },
        null,
      ),
    ).toBe(false);
  });

  it('falls back to the account default when the cluster sets nothing', () => {
    // AWS returns an empty settings list for a cluster that was never
    // configured; such a cluster inherits the account setting.
    expect(clusterHasContainerInsights({ settings: [] }, 'enabled')).toBe(true);
    expect(clusterHasContainerInsights({ settings: [] }, 'disabled')).toBe(false);
    expect(clusterHasContainerInsights({ settings: undefined }, null)).toBe(false);
  });

  it('resolves enhanced from the account default too, not just from the cluster', () => {
    // The inherit path is a separate branch from the explicit-setting one, and
    // an account-wide `enhanced` default is how a fleet is usually configured.
    expect(clusterHasContainerInsights({ settings: [] }, 'enhanced')).toBe(true);
    expect(clusterHasContainerInsights({ settings: undefined }, 'enhanced')).toBe(true);
  });

  it('treats a value it does not recognise as off, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      clusterHasContainerInsights(
        { settings: [{ name: 'containerInsights', value: 'someFutureMode' }] },
        null,
      ),
    ).toBe(false);
    // Diagnosable rather than mysterious: without this, a future AWS value
    // would present as "Container Insights is off" with no way to tell that
    // the Hub simply did not understand the answer.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('someFutureMode'));
  });

  it('does not warn about the ordinary disabled case', () => {
    // 'disabled' is the account default and the overwhelmingly common answer.
    // Logging it would bury the value that actually needs attention.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    clusterHasContainerInsights(
      { settings: [{ name: 'containerInsights', value: 'disabled' }] },
      null,
    );
    clusterHasContainerInsights({ settings: [] }, 'disabled');
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores a setting for a different cluster option', () => {
    // `settings` is a list and a future non-containerInsights entry must not be
    // read as the Container Insights answer. The SDK types `name` as the single
    // literal it knows today, so the cast is the point: the type is a
    // compile-time claim about a JSON payload the service controls.
    expect(
      clusterHasContainerInsights(
        { settings: [{ name: 'somethingElse' as 'containerInsights', value: 'enabled' }] },
        null,
      ),
    ).toBe(false);
  });

  it('lets an explicit cluster setting override the account default', () => {
    // "If a cluster value is specified, it will override the containerInsights
    // value set with PutAccountSetting."
    expect(
      clusterHasContainerInsights(
        { settings: [{ name: 'containerInsights', value: 'disabled' }] },
        'enabled',
      ),
    ).toBe(false);
    expect(
      clusterHasContainerInsights(
        { settings: [{ name: 'containerInsights', value: 'enabled' }] },
        'disabled',
      ),
    ).toBe(true);
  });
});

describe('runInfraInventorySync — ECS', () => {
  it('records clusters and services as separate rows with their own dimension sets', async () => {
    insertScope({ id: 'ecs1', service: 'ecs' });
    const ecs = stubEcs({
      clusters: [
        {
          name: 'prod',
          containerInsights: 'enabled',
          tags: [{ key: 'Environment', value: 'production' }],
          services: [{ name: 'api' }, { name: 'worker' }],
        },
      ],
    });

    const result = await runInfraInventorySync({ nowMs: T0, ecsClientFactory: () => ecs });
    expect(result).toMatchObject({ scopes: 1, synced: 1, failed: 0, upserted: 3, skipped: 0 });

    const rows = allResources();
    expect(rows.map((r) => r.resource_id)).toEqual(['prod', 'prod/api', 'prod/worker']);

    const cluster = rows.find((r) => r.resource_id === 'prod')!;
    expect(cluster.account_id).toBe('111122223333');
    expect(cluster.environment).toBe('production');
    expect(JSON.parse(cluster.metric_dimensions_json!)).toEqual({ ClusterName: 'prod' });

    // A service is keyed on both dimensions, which is what stops the collector
    // billing a cluster row for the service-level query and vice versa.
    const api = rows.find((r) => r.resource_id === 'prod/api')!;
    expect(api.name).toBe('api');
    expect(JSON.parse(api.metric_dimensions_json!)).toEqual({
      ClusterName: 'prod',
      ServiceName: 'api',
    });
  });

  it('copies the cluster’s Container Insights setting onto its services', async () => {
    // A service inherits the flag because Container Insights is a cluster-level
    // switch. Copying it onto the row means the collector never has to join
    // back to the cluster while planning queries.
    insertScope({ id: 'ecs1', service: 'ecs' });
    const ecs = stubEcs({
      clusters: [
        { name: 'on', containerInsights: 'enhanced', services: [{ name: 'api' }] },
        { name: 'off', containerInsights: 'disabled', services: [{ name: 'batch' }] },
      ],
    });

    await runInfraInventorySync({ nowMs: T0, ecsClientFactory: () => ecs });
    const features = new Map(
      allResources().map((r) => [r.resource_id, JSON.parse(r.features_json ?? '{}')]),
    );
    expect(features.get('on')).toEqual({ containerInsights: true });
    expect(features.get('on/api')).toEqual({ containerInsights: true });
    expect(features.get('off')).toEqual({ containerInsights: false });
    expect(features.get('off/batch')).toEqual({ containerInsights: false });
  });

  it('collects the paid metrics for an enhanced cluster, end to end', async () => {
    // The failure this guards against is the whole point of the feature gate:
    // a cluster on `enhanced` is paying the most for Container Insights, and
    // reading it as off would skip every ECS/ContainerInsights metric for it.
    insertScope({ id: 'ecs1', service: 'ecs' });
    const ecs = stubEcs({
      clusters: [{ name: 'prod', containerInsights: 'enhanced', services: [{ name: 'api' }] }],
    });
    await runInfraInventorySync({ nowMs: T0, ecsClientFactory: () => ecs });

    const rows = getInfraDb()
      .prepare(
        `SELECT resource_key, account_id, resource_id, service, tags_json,
                metric_dimensions_json, features_json
           FROM infra_resources ORDER BY resource_id`,
      )
      .all() as CollectableResource[];

    const planned = planQueries(rows, T0 - 900_000, T0);
    const insightsMetrics = new Set(
      planned.filter((p) => p.namespace === 'ECS/ContainerInsights').map((p) => p.metricName),
    );
    expect(insightsMetrics).toContain('RunningTaskCount');
    expect(insightsMetrics).toContain('RestartCount');
    // And the cluster-keyed paid metrics land on the cluster row.
    expect(insightsMetrics).toContain('TaskCount');
  });

  it('skips the paid metrics for a disabled cluster, end to end', async () => {
    insertScope({ id: 'ecs1', service: 'ecs' });
    const ecs = stubEcs({
      clusters: [{ name: 'prod', containerInsights: 'disabled', services: [{ name: 'api' }] }],
    });
    await runInfraInventorySync({ nowMs: T0, ecsClientFactory: () => ecs });

    const rows = getInfraDb()
      .prepare(
        `SELECT resource_key, account_id, resource_id, service, tags_json,
                metric_dimensions_json, features_json
           FROM infra_resources ORDER BY resource_id`,
      )
      .all() as CollectableResource[];

    const planned = planQueries(rows, T0 - 900_000, T0);
    expect(planned.every((p) => p.namespace === 'AWS/ECS')).toBe(true);
    // The free metrics are still collected — the gate removes, it does not
    // disable the service.
    expect(planned.length).toBeGreaterThan(0);
  });

  it('resolves an unset cluster setting from the account default', async () => {
    insertScope({ id: 'ecs1', service: 'ecs' });
    const ecs = stubEcs({
      accountDefault: 'enabled',
      clusters: [{ name: 'inherits', containerInsights: null, services: [] }],
    });

    await runInfraInventorySync({ nowMs: T0, ecsClientFactory: () => ecs });
    const row = allResources()[0]!;
    expect(JSON.parse(row.features_json!)).toEqual({ containerInsights: true });
  });

  it('falls back to off when the account settings probe is denied', async () => {
    // ListAccountSettings is a separate IAM action. A role without it should
    // still produce an inventory: under-collecting is the safe direction,
    // because the alternative is billing for a namespace that may not exist.
    insertScope({ id: 'ecs1', service: 'ecs' });
    const ecs = stubEcs({
      accountSettingsThrows: true,
      clusters: [{ name: 'unknown', containerInsights: null, services: [] }],
    });

    const result = await runInfraInventorySync({ nowMs: T0, ecsClientFactory: () => ecs });
    expect(result.failed).toBe(0);
    expect(JSON.parse(allResources()[0]!.features_json!)).toEqual({ containerInsights: false });
  });

  it('batches DescribeServices at the API’s 10-per-call ceiling', async () => {
    insertScope({ id: 'ecs1', service: 'ecs' });
    const services = Array.from({ length: 23 }, (_, i) => ({ name: `svc-${i}` }));
    const ecs = stubEcs({ clusters: [{ name: 'big', containerInsights: 'enabled', services }] });

    await runInfraInventorySync({ nowMs: T0, ecsClientFactory: () => ecs });

    const describes = ecs.calls.filter(
      (c): c is DescribeServicesCommand => c instanceof DescribeServicesCommand,
    );
    // "You may specify up to 10 services to describe in a single operation."
    expect(describes.map((c) => c.input.services!.length)).toEqual([10, 10, 3]);
    for (const call of describes) expect(call.input.include).toEqual(['TAGS']);
    expect(allResources()).toHaveLength(24);
  });

  it('asks DescribeClusters for the settings it needs and ListServices for a full page', async () => {
    insertScope({ id: 'ecs1', service: 'ecs' });
    const ecs = stubEcs({ clusters: [{ name: 'prod', services: [{ name: 'api' }] }] });

    await runInfraInventorySync({ nowMs: T0, ecsClientFactory: () => ecs });

    const describeClusters = ecs.calls.find(
      (c): c is DescribeClustersCommand => c instanceof DescribeClustersCommand,
    )!;
    // SETTINGS is what carries the Container Insights flag; without it the
    // response omits it entirely and every cluster reads as off.
    expect(describeClusters.input.include).toEqual(['SETTINGS', 'TAGS']);

    const listServices = ecs.calls.find(
      (c): c is ListServicesCommand => c instanceof ListServicesCommand,
    )!;
    // ListServices defaults to 10 results per page where every other ECS list
    // defaults to 100, so the page size has to be explicit.
    expect(listServices.input.maxResults).toBe(100);
  });

  it('applies the scope tag filter client-side, since the ECS APIs take none', async () => {
    insertScope({
      id: 'ecs1',
      service: 'ecs',
      tag_filter_json: JSON.stringify({ Team: ['payments'] }),
    });
    const ecs = stubEcs({
      clusters: [
        {
          name: 'prod',
          tags: [{ key: 'Team', value: 'platform' }],
          services: [
            { name: 'api', tags: [{ key: 'Team', value: 'payments' }] },
            { name: 'worker', tags: [{ key: 'Team', value: 'platform' }] },
          ],
        },
      ],
    });

    await runInfraInventorySync({ nowMs: T0, ecsClientFactory: () => ecs });

    // The cluster itself is filtered out, but its services are still walked —
    // an operator who tags services and not clusters would otherwise get an
    // empty inventory.
    expect(allResources().map((r) => r.resource_id)).toEqual(['prod/api']);
  });

  it('records an INACTIVE service so the collector stops paying for it', async () => {
    // ECS's INACTIVE is the equivalent of a terminated instance. The row is
    // kept (a chart must keep its subject) but the state is what the collector
    // reads to stop issuing billed queries for it.
    insertScope({ id: 'ecs1', service: 'ecs' });
    const ecs = stubEcs({
      clusters: [{ name: 'prod', services: [{ name: 'gone', status: 'INACTIVE' }] }],
    });

    await runInfraInventorySync({ nowMs: T0, ecsClientFactory: () => ecs });
    expect(allResources().find((r) => r.resource_id === 'prod/gone')!.state).toBe('INACTIVE');
  });

  it('refreshes the feature flag when an operator turns Container Insights on', async () => {
    insertScope({ id: 'ecs1', service: 'ecs' });
    const off = stubEcs({
      clusters: [{ name: 'prod', containerInsights: 'disabled', services: [{ name: 'api' }] }],
    });
    await runInfraInventorySync({ nowMs: T0, ecsClientFactory: () => off });

    const on = stubEcs({
      clusters: [{ name: 'prod', containerInsights: 'enabled', services: [{ name: 'api' }] }],
    });
    await runInfraInventorySync({ nowMs: T1, ecsClientFactory: () => on });

    const api = allResources().find((r) => r.resource_id === 'prod/api')!;
    expect(JSON.parse(api.features_json!)).toEqual({ containerInsights: true });
    // The identity of the row is unchanged — it is the same service.
    expect(api.first_seen).toBe(T0);
    expect(api.last_seen).toBe(T1);
  });

  it('syncs EC2 and ECS scopes in the same tick without either affecting the other', async () => {
    insertScope({ id: 'ec2-scope' });
    insertScope({ id: 'ecs-scope', service: 'ecs' });
    const ec2 = stubEc2([{ Reservations: [reservation('111122223333', [instance('i-aaa')])] }]);
    const ecs = stubEcs({ clusters: [{ name: 'prod', services: [{ name: 'api' }] }] });

    const result = await runInfraInventorySync({
      nowMs: T0,
      ec2ClientFactory: () => ec2,
      ecsClientFactory: () => ecs,
    });

    expect(result).toMatchObject({ scopes: 2, synced: 2, failed: 0, upserted: 3 });
    expect(allResources().map((r) => `${r.service}:${r.resource_id}`)).toEqual([
      'ec2:i-aaa',
      'ecs:prod',
      'ecs:prod/api',
    ]);
    // An EC2 row still carries its single-dimension map, unchanged by ECS
    // arriving alongside it.
    const ec2Row = allResources().find((r) => r.service === 'ec2')!;
    expect(JSON.parse(ec2Row.metric_dimensions_json!)).toEqual({ InstanceId: 'i-aaa' });
  });

  it('counts an ECS scope that throws as failed without taking the tick down', async () => {
    insertScope({ id: 'ecs1', service: 'ecs' });
    insertScope({ id: 'ecs2', service: 'ecs', region: 'us-west-2' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const good = stubEcs({ clusters: [{ name: 'prod', services: [] }] });
    const result = await runInfraInventorySync({
      nowMs: T0,
      ecsClientFactory: (scope) => {
        if (scope.region === 'us-west-2') {
          return {
            async send() {
              throw new Error('ExpiredTokenException');
            },
          } as unknown as EcsDescribeClient;
        }
        return good;
      },
    });

    expect(result).toMatchObject({ scopes: 2, synced: 1, failed: 1, upserted: 1 });
  });
});

// ─── Networking services (ALB, NLB, NAT Gateway) ────────────────────────────

const ELB_ARN_PREFIX = 'arn:aws:elasticloadbalancing:us-east-1:111122223333';

function loadBalancer(
  kind: 'app' | 'net',
  name: string,
  id: string,
  extra: Partial<LoadBalancer> = {},
): LoadBalancer {
  return {
    LoadBalancerArn: `${ELB_ARN_PREFIX}:loadbalancer/${kind}/${name}/${id}`,
    LoadBalancerName: name,
    Type: kind === 'app' ? 'application' : 'network',
    State: { Code: 'active' },
    ...extra,
  };
}

function targetGroup(name: string, id: string, loadBalancerArns: string[]): TargetGroup {
  return {
    TargetGroupArn: `${ELB_ARN_PREFIX}:targetgroup/${name}/${id}`,
    TargetGroupName: name,
    LoadBalancerArns: loadBalancerArns,
  };
}

/**
 * An ELBv2 stub. Answers the three commands the walk issues and records them,
 * so a test can assert on pagination and batching rather than only on rows.
 *
 * Load balancers and target groups are served as *pages*, each consumed in
 * order, so a test can drive `NextMarker` and the page cap. The `loadBalancers`
 * / `targetGroups` shorthands are a single page with no marker.
 */
function stubElb(opts: {
  loadBalancers?: LoadBalancer[];
  loadBalancerPages?: Array<Partial<DescribeLoadBalancersCommandOutput>>;
  targetGroups?: TargetGroup[];
  targetGroupPages?: Array<Partial<DescribeTargetGroupsCommandOutput>>;
  tags?: Record<string, Array<{ Key: string; Value: string }>>;
  /** Thrown by every `DescribeTags` call when set. */
  tagsError?: unknown;
  /**
   * ARNs that were deleted between the describe walk and the tag call. Any
   * `DescribeTags` request containing one fails wholesale, which is exactly how
   * AWS behaves: the call is all-or-nothing per batch.
   */
  notFoundArns?: string[];
}): ElbDescribeClient & {
  calls: unknown[];
  lbCalls: DescribeLoadBalancersCommand[];
  tgCalls: DescribeTargetGroupsCommand[];
  tagCalls: DescribeTagsCommand[];
} {
  const calls: unknown[] = [];
  const lbCalls: DescribeLoadBalancersCommand[] = [];
  const tgCalls: DescribeTargetGroupsCommand[] = [];
  const tagCalls: DescribeTagsCommand[] = [];
  const lbPages = opts.loadBalancerPages ?? [{ LoadBalancers: opts.loadBalancers ?? [] }];
  const tgPages = opts.targetGroupPages ?? [{ TargetGroups: opts.targetGroups ?? [] }];
  let lbIndex = 0;
  let tgIndex = 0;

  return {
    calls,
    lbCalls,
    tgCalls,
    tagCalls,
    async send(command: unknown) {
      calls.push(command);
      if (command instanceof DescribeLoadBalancersCommand) {
        lbCalls.push(command);
        const page = lbPages[lbIndex] ?? {};
        lbIndex += 1;
        return page as DescribeLoadBalancersCommandOutput;
      }
      if (command instanceof DescribeTargetGroupsCommand) {
        tgCalls.push(command);
        const page = tgPages[tgIndex] ?? {};
        tgIndex += 1;
        return page as DescribeTargetGroupsCommandOutput;
      }
      if (command instanceof DescribeTagsCommand) {
        tagCalls.push(command);
        if (opts.tagsError) throw opts.tagsError;
        const arns = (command.input.ResourceArns ?? []) as string[];
        if (opts.notFoundArns?.some((arn) => arns.includes(arn))) {
          throw awsError('LoadBalancerNotFoundException');
        }
        return {
          TagDescriptions: arns.map((ResourceArn) => ({
            ResourceArn,
            Tags: opts.tags?.[ResourceArn] ?? [],
          })),
        } as DescribeTagsCommandOutput;
      }
      throw new Error('unexpected command');
    },
  } as ElbDescribeClient & {
    calls: unknown[];
    lbCalls: DescribeLoadBalancersCommand[];
    tgCalls: DescribeTargetGroupsCommand[];
    tagCalls: DescribeTagsCommand[];
  };
}

/** An AWS-shaped error, so the classifiers are exercised as they will be live. */
function awsError(name: string, httpStatusCode?: number): Error {
  const err = new Error(name);
  err.name = name;
  if (httpStatusCode !== undefined) {
    (err as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode };
  }
  return err;
}

/** An EC2 stub that answers `DescribeNatGateways`. */
function stubNatGateways(
  pages: Array<Partial<DescribeNatGatewaysCommandOutput>>,
): Ec2DescribeClient & { calls: DescribeNatGatewaysCommand[] } {
  const calls: DescribeNatGatewaysCommand[] = [];
  let index = 0;
  return {
    calls,
    async send(command: DescribeNatGatewaysCommand) {
      calls.push(command);
      const page = pages[index] ?? {};
      index += 1;
      return page as DescribeNatGatewaysCommandOutput;
    },
  } as Ec2DescribeClient & { calls: DescribeNatGatewaysCommand[] };
}

function natGateway(id: string, extra: Partial<NatGateway> = {}): NatGateway {
  return { NatGatewayId: id, State: 'available', ...extra };
}

/** The stored rows in the shape the collector reads them. */
function collectableRows(): CollectableResource[] {
  return getInfraDb()
    .prepare(
      `SELECT resource_key, account_id, resource_id, service, tags_json,
              metric_dimensions_json, features_json
         FROM infra_resources ORDER BY resource_id`,
    )
    .all() as CollectableResource[];
}

describe('syncable services cover every pack', () => {
  it('can inventory every service that has a metric pack', () => {
    // The failure this guards against, caught in review: packs were registered
    // and served to the UI while the sync allowlist still read ['ec2','ecs'],
    // so ALB, NLB and NAT Gateway had metrics and default rules with no
    // resource rows to collect against. A pack with no describer is inert.
    expect([...INFRA_SYNCABLE_SERVICES].sort()).toEqual(infraPackedServices());
  });
});

describe('ELBv2 ARN → CloudWatch dimension value', () => {
  it('keeps the app/ and net/ discriminator, which is all that separates them', () => {
    // The dimension *name* is `LoadBalancer` on both namespaces, so the value's
    // prefix is the only thing saying which service a series belongs to.
    expect(
      loadBalancerDimensionValue(`${ELB_ARN_PREFIX}:loadbalancer/app/web/50dc6c495c0c9188`),
    ).toBe('app/web/50dc6c495c0c9188');
    expect(
      loadBalancerDimensionValue(`${ELB_ARN_PREFIX}:loadbalancer/net/ingest/50dc6c495c0c9188`),
    ).toBe('net/ingest/50dc6c495c0c9188');
  });

  it('keeps the literal targetgroup/ prefix AWS documents as part of the value', () => {
    expect(targetGroupDimensionValue(`${ELB_ARN_PREFIX}:targetgroup/api/73e2d6bc24d8a067`)).toBe(
      'targetgroup/api/73e2d6bc24d8a067',
    );
  });

  it('returns null rather than a wrong dimension for anything unparseable', () => {
    for (const bad of [undefined, '', 'not-an-arn', `${ELB_ARN_PREFIX}:loadbalancer/`]) {
      expect(loadBalancerDimensionValue(bad)).toBeNull();
    }
    expect(targetGroupDimensionValue('arn:aws:ecs:us-east-1:1:cluster/prod')).toBeNull();
  });
});

describe('runInfraInventorySync — ALB and NLB', () => {
  it('writes a load balancer row and its target group row', async () => {
    insertScope({ id: 'alb1', service: 'alb', account_id: '111122223333' });
    const alb = loadBalancer('app', 'web', '50dc6c495c0c9188');
    const tg = targetGroup('api', '73e2d6bc24d8a067', [alb.LoadBalancerArn!]);
    const elb = stubElb({
      loadBalancers: [alb],
      targetGroups: [tg],
      tags: {
        [alb.LoadBalancerArn!]: [
          { Key: 'Name', Value: 'web-lb' },
          { Key: 'Environment', Value: 'prod' },
        ],
      },
    });

    const result = await runInfraInventorySync({ nowMs: T0, elbClientFactory: () => elb });
    expect(result.failed).toBe(0);
    expect(result.upserted).toBe(2);

    const rows = allResources();
    const lbRow = rows.find((r) => r.resource_id === 'app/web/50dc6c495c0c9188')!;
    expect(lbRow.service).toBe('alb');
    expect(lbRow.name).toBe('web');
    expect(lbRow.state).toBe('active');
    expect(lbRow.environment).toBe('prod');
    expect(JSON.parse(lbRow.metric_dimensions_json!)).toEqual({
      LoadBalancer: 'app/web/50dc6c495c0c9188',
    });

    // The target group carries BOTH dimensions: AWS publishes the host counts
    // only at LoadBalancer + TargetGroup, so a row with one of them collects
    // nothing.
    const tgRow = rows.find((r) => r.resource_id.includes('targetgroup/'))!;
    expect(JSON.parse(tgRow.metric_dimensions_json!)).toEqual({
      LoadBalancer: 'app/web/50dc6c495c0c9188',
      TargetGroup: 'targetgroup/api/73e2d6bc24d8a067',
    });
  });

  it('partitions on Type so an NLB never lands in an alb scope', async () => {
    // One DescribeLoadBalancers API returns every type. Without the filter an
    // `alb` scope would write NLB rows and the collector would issue
    // AWS/ApplicationELB queries against them — billed, and empty forever.
    insertScope({ id: 'alb1', service: 'alb', account_id: '111122223333' });
    const elb = stubElb({
      loadBalancers: [
        loadBalancer('app', 'web', 'aaaa'),
        loadBalancer('net', 'ingest', 'bbbb'),
        { ...loadBalancer('app', 'gw', 'cccc'), Type: 'gateway' },
      ],
    });

    await runInfraInventorySync({ nowMs: T0, elbClientFactory: () => elb });
    expect(allResources().map((r) => r.resource_id)).toEqual(['app/web/aaaa']);
  });

  it('writes network load balancers for an nlb scope', async () => {
    insertScope({ id: 'nlb1', service: 'nlb', account_id: '111122223333' });
    const elb = stubElb({
      loadBalancers: [loadBalancer('app', 'web', 'aaaa'), loadBalancer('net', 'ingest', 'bbbb')],
    });

    await runInfraInventorySync({ nowMs: T0, elbClientFactory: () => elb });
    const rows = allResources();
    expect(rows.map((r) => r.resource_id)).toEqual(['net/ingest/bbbb']);
    expect(rows[0]!.service).toBe('nlb');
  });

  it('drops target groups attached to an out-of-scope load balancer', async () => {
    insertScope({ id: 'alb1', service: 'alb', account_id: '111122223333' });
    const alb = loadBalancer('app', 'web', 'aaaa');
    const nlb = loadBalancer('net', 'ingest', 'bbbb');
    const elb = stubElb({
      loadBalancers: [alb, nlb],
      targetGroups: [
        targetGroup('api', 'tg1', [alb.LoadBalancerArn!]),
        targetGroup('stream', 'tg2', [nlb.LoadBalancerArn!]),
        // Unattached: publishes no host counts, so it is not worth a row.
        targetGroup('orphan', 'tg3', []),
      ],
    });

    await runInfraInventorySync({ nowMs: T0, elbClientFactory: () => elb });
    const ids = allResources().map((r) => r.resource_id);
    expect(ids).toContain('app/web/aaaa/targetgroup/api/tg1');
    expect(ids.some((id) => id.includes('tg2'))).toBe(false);
    expect(ids.some((id) => id.includes('tg3'))).toBe(false);
  });

  it('survives a DescribeTags failure with untagged rows rather than no rows', async () => {
    // DescribeTags is all-or-nothing per batch of 20, so one ARN deleted
    // between the describe and the tag call 400s the whole batch. Losing tags
    // costs a Name; failing the scope costs the region its inventory.
    insertScope({ id: 'alb1', service: 'alb', account_id: '111122223333' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const elb = stubElb({
      loadBalancers: [loadBalancer('app', 'web', 'aaaa')],
      tagsError: awsError('LoadBalancerNotFoundException'),
    });

    const result = await runInfraInventorySync({ nowMs: T0, elbClientFactory: () => elb });
    expect(result.failed).toBe(0);
    expect(result.upserted).toBe(1);
    expect(allResources()[0]!.tags_json).toBeNull();
  });

  it('applies the tag filter client-side, since no ELBv2 describe accepts one', async () => {
    insertScope({
      id: 'alb1',
      service: 'alb',
      account_id: '111122223333',
      tag_filter_json: JSON.stringify({ Environment: ['prod'] }),
    });
    const keep = loadBalancer('app', 'web', 'aaaa');
    const drop = loadBalancer('app', 'staging', 'bbbb');
    const elb = stubElb({
      loadBalancers: [keep, drop],
      tags: { [keep.LoadBalancerArn!]: [{ Key: 'Environment', Value: 'prod' }] },
    });

    await runInfraInventorySync({ nowMs: T0, elbClientFactory: () => elb });
    expect(allResources().map((r) => r.resource_id)).toEqual(['app/web/aaaa']);
  });

  it('produces rows the collector actually binds pack metrics to, end to end', async () => {
    // The reviewer's concern, answered by the code that decides it: registering
    // a pack is worthless unless a described resource yields real queries.
    insertScope({ id: 'alb1', service: 'alb', account_id: '111122223333' });
    const alb = loadBalancer('app', 'web', 'aaaa');
    const elb = stubElb({
      loadBalancers: [alb],
      targetGroups: [targetGroup('api', 'tg1', [alb.LoadBalancerArn!])],
    });
    await runInfraInventorySync({ nowMs: T0, elbClientFactory: () => elb });

    const planned = planQueries(collectableRows(), T0 - 900_000, T0);
    const names = new Set(planned.map((p) => p.metricName));
    expect(planned.every((p) => p.namespace === 'AWS/ApplicationELB')).toBe(true);
    // Load-balancer-keyed metrics.
    expect(names).toContain('RequestCount');
    expect(names).toContain('HTTPCode_ELB_5XX_Count');
    // The percentile series, which only exist because the target latency
    // metric is declared three times.
    expect(planned.filter((p) => p.metricName === 'TargetResponseTime').map((p) => p.stat)).toEqual(
      expect.arrayContaining(['Average', 'p50', 'p99']),
    );
    // Target-group-keyed metrics — the ones with no load-balancer-only series.
    expect(names).toContain('HealthyHostCount');
    expect(names).toContain('UnHealthyHostCount');
    expect(names).toContain('RequestCountPerTarget');
  });
});

describe('runInfraInventorySync — NAT Gateway', () => {
  it('writes a zonal gateway on NatGatewayId alone', async () => {
    insertScope({ id: 'nat1', service: 'natgw', account_id: '111122223333' });
    const ec2 = stubNatGateways([
      {
        NatGateways: [
          natGateway('nat-aaa', {
            AvailabilityMode: 'zonal',
            Tags: [
              { Key: 'Name', Value: 'egress' },
              { Key: 'Environment', Value: 'prod' },
            ],
          }),
        ],
      },
    ]);

    await runInfraInventorySync({ nowMs: T0, ec2ClientFactory: () => ec2 });
    const row = allResources()[0]!;
    expect(row.service).toBe('natgw');
    expect(row.resource_id).toBe('nat-aaa');
    expect(row.name).toBe('egress');
    expect(row.state).toBe('available');
    expect(row.environment).toBe('prod');
    expect(JSON.parse(row.metric_dimensions_json!)).toEqual({ NatGatewayId: 'nat-aaa' });
  });

  it('treats an absent availabilityMode as zonal', async () => {
    // The field postdates the regional feature, so every gateway older than it
    // is zonal — and zonal is the arm that collects. Guessing "regional" would
    // silently stop collecting a gateway that works.
    insertScope({ id: 'nat1', service: 'natgw', account_id: '111122223333' });
    const ec2 = stubNatGateways([{ NatGateways: [natGateway('nat-aaa')] }]);

    await runInfraInventorySync({ nowMs: T0, ec2ClientFactory: () => ec2 });
    expect(JSON.parse(allResources()[0]!.metric_dimensions_json!)).toEqual({
      NatGatewayId: 'nat-aaa',
    });
  });

  it('pushes the tag filter into the API, as the instance walk does', async () => {
    insertScope({
      id: 'nat1',
      service: 'natgw',
      account_id: '111122223333',
      tag_filter_json: JSON.stringify({ Environment: ['prod'] }),
    });
    const ec2 = stubNatGateways([{ NatGateways: [] }]);
    await runInfraInventorySync({ nowMs: T0, ec2ClientFactory: () => ec2 });

    expect(ec2.calls[0]!.input.Filter).toEqual([{ Name: 'tag:Environment', Values: ['prod'] }]);
  });

  it('gives a regional gateway one row per AZ, keyed so it cannot be billed', async () => {
    // A regional gateway publishes at NatGatewayId + AvailabilityZone, which no
    // pack metric declares. Recording both names makes bindMetricDimensions
    // refuse the row — so it is visible in inventory and costs nothing. Writing
    // NatGatewayId alone would look right and bill a GetMetricData entry per
    // metric per tick, forever, for a series AWS does not publish.
    insertScope({ id: 'nat1', service: 'natgw', account_id: '111122223333' });
    const ec2 = stubNatGateways([
      {
        NatGateways: [
          natGateway('nat-reg', {
            AvailabilityMode: 'regional',
            NatGatewayAddresses: [
              { AvailabilityZone: 'us-east-1a' },
              { AvailabilityZone: 'us-east-1b' },
              // Same zone twice: two EIPs in one AZ is one series.
              { AvailabilityZone: 'us-east-1a' },
            ],
          }),
        ],
      },
    ]);

    await runInfraInventorySync({ nowMs: T0, ec2ClientFactory: () => ec2 });
    const rows = allResources();
    expect(rows.map((r) => r.resource_id)).toEqual(['nat-reg@us-east-1a', 'nat-reg@us-east-1b']);
    expect(JSON.parse(rows[0]!.metric_dimensions_json!)).toEqual({
      NatGatewayId: 'nat-reg',
      AvailabilityZone: 'us-east-1a',
    });

    // The load-bearing half: no billed query is planned for it.
    expect(planQueries(collectableRows(), T0 - 900_000, T0)).toEqual([]);
  });

  it('skips a regional gateway whose zones cannot be resolved', async () => {
    insertScope({ id: 'nat1', service: 'natgw', account_id: '111122223333' });
    const ec2 = stubNatGateways([
      { NatGateways: [natGateway('nat-reg', { AvailabilityMode: 'regional' })] },
    ]);

    const result = await runInfraInventorySync({ nowMs: T0, ec2ClientFactory: () => ec2 });
    // Counted rather than guessed at: there is no dimension map for it that is
    // both honest and non-billing.
    expect(result.skipped).toBe(1);
    expect(allResources()).toEqual([]);
  });

  it('follows NextToken across NAT gateway pages', async () => {
    // Same class of gap the ELB walk had: a stub that never returns a token
    // lets a broken loop look correct while omitting every gateway past the
    // first page. EC2 pages on NextToken, not the Marker ELBv2 uses.
    insertScope({ id: 'nat1', service: 'natgw', account_id: '111122223333' });
    const ec2 = stubNatGateways([
      { NatGateways: [natGateway('nat-aaa')], NextToken: 'page2' },
      { NatGateways: [natGateway('nat-bbb')] },
    ]);

    const result = await runInfraInventorySync({ nowMs: T0, ec2ClientFactory: () => ec2 });

    expect(result.upserted).toBe(2);
    expect(ec2.calls).toHaveLength(2);
    expect(ec2.calls[0]!.input.NextToken).toBeUndefined();
    expect(ec2.calls[1]!.input.NextToken).toBe('page2');
    expect(ec2.calls[0]!.input.MaxResults).toBe(1000);
  });

  it('stops the NAT walk at the page cap and warns', async () => {
    insertScope({ id: 'nat1', service: 'natgw', account_id: '111122223333' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ec2 = stubNatGateways(
      Array.from({ length: MAX_PAGES_PER_SCOPE + 5 }, (_, i) => ({
        NatGateways: [natGateway(`nat-${i}`)],
        NextToken: `page${i + 2}`,
      })),
    );

    const result = await runInfraInventorySync({ nowMs: T0, ec2ClientFactory: () => ec2 });

    expect(ec2.calls).toHaveLength(MAX_PAGES_PER_SCOPE);
    expect(result.upserted).toBe(MAX_PAGES_PER_SCOPE);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/inventory may be incomplete/i);
  });

  it('produces rows the collector binds every NAT metric to, end to end', async () => {
    insertScope({ id: 'nat1', service: 'natgw', account_id: '111122223333' });
    const ec2 = stubNatGateways([
      { NatGateways: [natGateway('nat-aaa', { AvailabilityMode: 'zonal' })] },
    ]);
    await runInfraInventorySync({ nowMs: T0, ec2ClientFactory: () => ec2 });

    const planned = planQueries(collectableRows(), T0 - 900_000, T0);
    const names = new Set(planned.map((p) => p.metricName));
    expect(planned.every((p) => p.namespace === 'AWS/NATGateway')).toBe(true);
    expect(names).toContain('ErrorPortAllocation');
    expect(names).toContain('PacketsDropCount');
    // Both denominators of AWS's documented drop-ratio formula.
    expect(names).toContain('PacketsInFromSource');
    expect(names).toContain('PacketsInFromDestination');
  });
});

describe('ELBv2 pagination', () => {
  it('follows NextMarker across load balancer pages', async () => {
    // ELBv2 pages on Marker/NextMarker where EC2 and ECS use NextToken. A stub
    // that never returns a marker would let a broken loop look correct while
    // silently omitting every resource past the first page of a large region.
    insertScope({ id: 'alb1', service: 'alb', account_id: '111122223333' });
    const elb = stubElb({
      loadBalancerPages: [
        { LoadBalancers: [loadBalancer('app', 'web', 'aaaa')], NextMarker: 'page2' },
        { LoadBalancers: [loadBalancer('app', 'api', 'bbbb')], NextMarker: 'page3' },
        { LoadBalancers: [loadBalancer('app', 'admin', 'cccc')] },
      ],
    });

    const result = await runInfraInventorySync({ nowMs: T0, elbClientFactory: () => elb });

    expect(result.upserted).toBe(3);
    expect(elb.lbCalls).toHaveLength(3);
    // The first request carries no marker; each subsequent one carries the
    // marker the previous page returned.
    expect(elb.lbCalls[0]!.input.Marker).toBeUndefined();
    expect(elb.lbCalls[1]!.input.Marker).toBe('page2');
    expect(elb.lbCalls[2]!.input.Marker).toBe('page3');
    expect(allResources().map((r) => r.resource_id)).toEqual([
      'app/admin/cccc',
      'app/api/bbbb',
      'app/web/aaaa',
    ]);
  });

  it('follows NextMarker across target group pages', async () => {
    insertScope({ id: 'alb1', service: 'alb', account_id: '111122223333' });
    const alb = loadBalancer('app', 'web', 'aaaa');
    const elb = stubElb({
      loadBalancers: [alb],
      targetGroupPages: [
        { TargetGroups: [targetGroup('api', 'tg1', [alb.LoadBalancerArn!])], NextMarker: 'tgp2' },
        { TargetGroups: [targetGroup('worker', 'tg2', [alb.LoadBalancerArn!])] },
      ],
    });

    await runInfraInventorySync({ nowMs: T0, elbClientFactory: () => elb });

    expect(elb.tgCalls).toHaveLength(2);
    expect(elb.tgCalls[1]!.input.Marker).toBe('tgp2');
    const ids = allResources().map((r) => r.resource_id);
    expect(ids).toContain('app/web/aaaa/targetgroup/api/tg1');
    expect(ids).toContain('app/web/aaaa/targetgroup/worker/tg2');
  });

  it('requests the documented 400-item page size on both walks', async () => {
    // PageSize maxes at 400. Omitting it would silently fall back to the API
    // default and multiply the round trips for a large region.
    insertScope({ id: 'alb1', service: 'alb', account_id: '111122223333' });
    const elb = stubElb({ loadBalancers: [loadBalancer('app', 'web', 'aaaa')] });
    await runInfraInventorySync({ nowMs: T0, elbClientFactory: () => elb });

    expect(elb.lbCalls[0]!.input.PageSize).toBe(400);
    expect(elb.tgCalls[0]!.input.PageSize).toBe(400);
  });

  it('stops at the page cap and says the inventory may be incomplete', async () => {
    // A malformed or looping NextMarker must not spin a tick forever holding a
    // client open. The cap is the backstop, and it has to be loud: silently
    // truncating an inventory reads as "these resources do not exist".
    insertScope({ id: 'alb1', service: 'alb', account_id: '111122223333' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const elb = stubElb({
      // Every page returns a marker, so only the cap can end the loop.
      loadBalancerPages: Array.from({ length: MAX_PAGES_PER_SCOPE + 5 }, (_, i) => ({
        LoadBalancers: [loadBalancer('app', `lb-${i}`, `id${i}`)],
        NextMarker: `page${i + 2}`,
      })),
    });

    const result = await runInfraInventorySync({ nowMs: T0, elbClientFactory: () => elb });

    expect(elb.lbCalls).toHaveLength(MAX_PAGES_PER_SCOPE);
    expect(result.upserted).toBe(MAX_PAGES_PER_SCOPE);
    expect(result.failed).toBe(0);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/inventory may be incomplete/i);
  });

  it('stops at the page cap on the target group walk too', async () => {
    insertScope({ id: 'alb1', service: 'alb', account_id: '111122223333' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const alb = loadBalancer('app', 'web', 'aaaa');
    const elb = stubElb({
      loadBalancers: [alb],
      targetGroupPages: Array.from({ length: MAX_PAGES_PER_SCOPE + 5 }, (_, i) => ({
        TargetGroups: [targetGroup(`tg-${i}`, `id${i}`, [alb.LoadBalancerArn!])],
        NextMarker: `page${i + 2}`,
      })),
    });

    await runInfraInventorySync({ nowMs: T0, elbClientFactory: () => elb });

    expect(elb.tgCalls).toHaveLength(MAX_PAGES_PER_SCOPE);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/stopped listing target groups/i);
  });
});

describe('DescribeTags failure classification', () => {
  it('recognises the documented not-found race in both spellings', () => {
    // The wire code is `LoadBalancerNotFound`; the SDK suffixes the modelled
    // exception with `Exception`. Both have to match.
    expect(isElbTagNotFoundError(awsError('LoadBalancerNotFound'))).toBe(true);
    expect(isElbTagNotFoundError(awsError('LoadBalancerNotFoundException'))).toBe(true);
    expect(isElbTagNotFoundError(awsError('TargetGroupNotFoundException'))).toBe(true);
    expect(isElbTagNotFoundError(awsError('AccessDeniedException'))).toBe(false);
    expect(isElbTagNotFoundError(undefined)).toBe(false);
  });

  it('recognises a permissions failure by name or by 403', () => {
    expect(isAwsAuthorizationError(awsError('AccessDeniedException'))).toBe(true);
    expect(isAwsAuthorizationError(awsError('UnauthorizedOperation'))).toBe(true);
    expect(isAwsAuthorizationError(awsError('AuthFailure'))).toBe(true);
    // AWS is inconsistent about the status, so an unfamiliar name on a 403
    // still counts.
    expect(isAwsAuthorizationError(awsError('SomethingElse', 403))).toBe(true);
    expect(isAwsAuthorizationError(awsError('ThrottlingException'))).toBe(false);
    expect(isAwsAuthorizationError(undefined)).toBe(false);
  });

  it('fails the scope when DescribeTags is denied, rather than reporting success', async () => {
    // The upgrade hazard: elasticloadbalancing:DescribeTags was added to the
    // published policy after the packs shipped, so a role built against the
    // older document has the describe grants and not this one. Degrading would
    // present an inventory with no names — and, on a tag-filtered scope, no
    // resources at all — while the sweep reported success.
    insertScope({ id: 'alb1', service: 'alb', account_id: '111122223333' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const elb = stubElb({
      loadBalancers: [loadBalancer('app', 'web', 'aaaa')],
      tagsError: awsError('AccessDeniedException'),
    });

    const result = await runInfraInventorySync({ nowMs: T0, elbClientFactory: () => elb });

    expect(result.failed).toBe(1);
    expect(result.synced).toBe(0);
    expect(result.upserted).toBe(0);
    // Nothing half-written: the scope threw before any upsert.
    expect(allResources()).toEqual([]);
    // And the log names the action to grant, since that is the whole fix.
    expect(warn.mock.calls.flat().join(' ')).toMatch(/elasticloadbalancing:DescribeTags/);
  });

  it('does not silently empty a tag-filtered scope when tags cannot be read', async () => {
    // The sharpest form of the same bug: with a tag filter, no tags means no
    // matches, so a swallowed error yields zero resources and a green sync.
    insertScope({
      id: 'alb1',
      service: 'alb',
      account_id: '111122223333',
      tag_filter_json: JSON.stringify({ Environment: ['prod'] }),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const elb = stubElb({
      loadBalancers: [loadBalancer('app', 'web', 'aaaa')],
      tagsError: awsError('AccessDeniedException'),
    });

    const result = await runInfraInventorySync({ nowMs: T0, elbClientFactory: () => elb });

    expect(result.failed).toBe(1);
    expect(allResources()).toEqual([]);
  });

  it('fails the scope on an unrecognised tag error rather than guessing', async () => {
    insertScope({ id: 'alb1', service: 'alb', account_id: '111122223333' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const elb = stubElb({
      loadBalancers: [loadBalancer('app', 'web', 'aaaa')],
      tagsError: awsError('ThrottlingException'),
    });

    const result = await runInfraInventorySync({ nowMs: T0, elbClientFactory: () => elb });

    // A transient failure is retried by the next hourly sweep, and one failed
    // scope never costs the others their inventory.
    expect(result.failed).toBe(1);
    expect(allResources()).toEqual([]);
  });
});

describe('DescribeTags deletion race — recovering the survivors', () => {
  it('re-asks per ARN so a deleted resource does not cost the batch its tags', async () => {
    // DescribeTags is all-or-nothing per batch of 20, so one load balancer
    // deleted between the describe walk and the tag call would otherwise strip
    // tags from every other resource in that batch.
    insertScope({ id: 'alb1', service: 'alb', account_id: '111122223333' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const live = loadBalancer('app', 'web', 'aaaa');
    const gone = loadBalancer('app', 'ghost', 'bbbb');
    const elb = stubElb({
      loadBalancers: [live, gone],
      notFoundArns: [gone.LoadBalancerArn!],
      tags: { [live.LoadBalancerArn!]: [{ Key: 'Name', Value: 'web-lb' }] },
    });

    const result = await runInfraInventorySync({ nowMs: T0, elbClientFactory: () => elb });

    expect(result.failed).toBe(0);
    // One batch call that failed, then one retry per ARN.
    expect(elb.tagCalls).toHaveLength(3);
    expect(elb.tagCalls[0]!.input.ResourceArns).toHaveLength(2);
    expect(elb.tagCalls.slice(1).every((c) => c.input.ResourceArns!.length === 1)).toBe(true);

    // The survivor keeps its tags; only the deleted one goes untagged.
    const rows = allResources();
    expect(JSON.parse(rows.find((r) => r.resource_id === 'app/web/aaaa')!.tags_json!)).toEqual([
      { Key: 'Name', Value: 'web-lb' },
    ]);
    expect(rows.find((r) => r.resource_id === 'app/ghost/bbbb')!.tags_json).toBeNull();
    expect(warn.mock.calls.flat().join(' ')).toMatch(/1 of 2 resource\(s\) disappeared/);
  });

  it('keeps tag-filtered survivors that the batch failure would have excluded', async () => {
    // The reviewer's scenario, and the reason the retry is not just tidiness:
    // with a tag filter, a resource whose tags could not be read does not match,
    // so absorbing the batch failure silently drops every live load balancer
    // that happened to share a batch with a deleted one.
    insertScope({
      id: 'alb1',
      service: 'alb',
      account_id: '111122223333',
      tag_filter_json: JSON.stringify({ Environment: ['prod'] }),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const live = loadBalancer('app', 'web', 'aaaa');
    const alsoLive = loadBalancer('app', 'api', 'cccc');
    const gone = loadBalancer('app', 'ghost', 'bbbb');
    const elb = stubElb({
      loadBalancers: [live, alsoLive, gone],
      notFoundArns: [gone.LoadBalancerArn!],
      tags: {
        [live.LoadBalancerArn!]: [{ Key: 'Environment', Value: 'prod' }],
        [alsoLive.LoadBalancerArn!]: [{ Key: 'Environment', Value: 'prod' }],
      },
    });

    await runInfraInventorySync({ nowMs: T0, elbClientFactory: () => elb });

    expect(allResources().map((r) => r.resource_id)).toEqual(['app/api/cccc', 'app/web/aaaa']);
  });

  it('recovers target group tags too, not just load balancer ones', async () => {
    // Load balancers and target groups share one batch, so the race affects
    // both — and target group rows are what the host-count rules evaluate on.
    insertScope({
      id: 'alb1',
      service: 'alb',
      account_id: '111122223333',
      tag_filter_json: JSON.stringify({ Environment: ['prod'] }),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const alb = loadBalancer('app', 'web', 'aaaa');
    const gone = loadBalancer('app', 'ghost', 'bbbb');
    const tg = targetGroup('api', 'tg1', [alb.LoadBalancerArn!]);
    const elb = stubElb({
      loadBalancers: [alb, gone],
      targetGroups: [tg],
      notFoundArns: [gone.LoadBalancerArn!],
      tags: {
        [alb.LoadBalancerArn!]: [{ Key: 'Environment', Value: 'prod' }],
        [tg.TargetGroupArn!]: [{ Key: 'Environment', Value: 'prod' }],
      },
    });

    await runInfraInventorySync({ nowMs: T0, elbClientFactory: () => elb });

    expect(allResources().map((r) => r.resource_id)).toEqual([
      'app/web/aaaa',
      'app/web/aaaa/targetgroup/api/tg1',
    ]);
  });

  it('does not retry a single-ARN batch that is genuinely gone', async () => {
    insertScope({ id: 'alb1', service: 'alb', account_id: '111122223333' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gone = loadBalancer('app', 'ghost', 'bbbb');
    const elb = stubElb({
      loadBalancers: [gone],
      notFoundArns: [gone.LoadBalancerArn!],
    });

    const result = await runInfraInventorySync({ nowMs: T0, elbClientFactory: () => elb });

    expect(result.failed).toBe(0);
    // One call, no pointless retry of a batch that is already a single ARN.
    expect(elb.tagCalls).toHaveLength(1);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/disappeared before its tags/);
  });

  it('still fails the scope when a per-ARN retry is denied', async () => {
    // A permissions failure must not be able to hide inside the race handling:
    // the retry loop classifies its own errors rather than assuming every
    // failure on the second attempt is another deletion.
    insertScope({ id: 'alb1', service: 'alb', account_id: '111122223333' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = loadBalancer('app', 'web', 'aaaa');
    const b = loadBalancer('app', 'api', 'cccc');
    let call = 0;
    const elb: ElbDescribeClient = {
      async send(command: unknown) {
        if (command instanceof DescribeLoadBalancersCommand) {
          return { LoadBalancers: [a, b] } as unknown as DescribeLoadBalancersCommandOutput;
        }
        if (command instanceof DescribeTargetGroupsCommand) {
          return { TargetGroups: [] } as unknown as DescribeTargetGroupsCommandOutput;
        }
        call += 1;
        // The batch races, then the role turns out to lack the permission.
        throw call === 1 ? awsError('LoadBalancerNotFoundException') : awsError('AccessDenied');
      },
    } as ElbDescribeClient;

    const result = await runInfraInventorySync({ nowMs: T0, elbClientFactory: () => elb });

    expect(result.failed).toBe(1);
    expect(allResources()).toEqual([]);
  });
});
