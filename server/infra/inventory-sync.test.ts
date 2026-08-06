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
import { initInfraDb, getInfraDb, closeInfraDb, infraResourceKey } from './infra-db.js';
import {
  runInfraInventorySync,
  buildEc2TagFilters,
  INFRA_INVENTORY_SYNC_CRON,
  type Ec2DescribeClient,
  type InfraScopeRow,
} from './inventory-sync.js';
import { estimateIntervalSeconds } from '../cron-tick.js';

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
