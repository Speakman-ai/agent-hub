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
import { DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import type { DescribeInstancesCommandOutput, Instance, Reservation } from '@aws-sdk/client-ec2';
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
  type Ec2DescribeClient,
  type EcsDescribeClient,
  type InfraScopeRow,
} from './inventory-sync.js';
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
