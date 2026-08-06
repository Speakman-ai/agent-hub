/**
 * Inventory browser reads: the filter set behind the Resources tab, the facet
 * values that populate its controls, keyset paging, and the series catalog the
 * metric picker is built from.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { initInfraDb, getInfraDb, closeInfraDb, infraResourceKey } from './infra-db.js';
import { insertInfraMetricPoints } from './infra-metric-store.js';
import {
  listInfraResources,
  listInfraResourceFacets,
  listInfraResourceSeries,
  getInfraResource,
  parseResourceTags,
  serializeInfraResource,
  INFRA_RESOURCE_NO_ENVIRONMENT,
} from './infra-resource-store.js';

let dir: string;

const PROJECT = 'proj-a';
const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

interface SeedResource {
  resourceId: string;
  service?: string;
  region?: string;
  accountId?: string;
  name?: string | null;
  environment?: string | null;
  state?: string | null;
  tags?: Array<{ Key: string; Value: string }> | null;
  lastSeen?: number;
  projectId?: string;
}

function seed(r: SeedResource): string {
  const service = r.service ?? 'ec2';
  const region = r.region ?? 'us-east-1';
  const accountId = r.accountId ?? '111122223333';
  const projectId = r.projectId ?? PROJECT;
  const key = infraResourceKey({
    projectId,
    accountId,
    region,
    service,
    resourceId: r.resourceId,
  });
  getInfraDb()
    .prepare(
      `INSERT INTO infra_resources (
         resource_key, project_id, account_id, region, service, resource_id,
         name, tags_json, environment, state, first_seen, last_seen
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      key,
      projectId,
      accountId,
      region,
      service,
      r.resourceId,
      r.name ?? null,
      r.tags ? JSON.stringify(r.tags) : null,
      r.environment ?? null,
      r.state ?? 'running',
      NOW - 10 * HOUR,
      r.lastSeen ?? NOW,
    );
  return key;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'infra-resource-store-test-'));
  initInfraDb(dir);
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('listInfraResources', () => {
  it('returns a project’s inventory most-recently-seen first', () => {
    seed({ resourceId: 'i-old', lastSeen: NOW - 5 * HOUR });
    seed({ resourceId: 'i-new', lastSeen: NOW });

    const page = listInfraResources({ projectId: PROJECT });
    expect(page.resources.map((r) => r.resource_id)).toEqual(['i-new', 'i-old']);
    expect(page.nextCursor).toBeNull();
  });

  it('never leaks another project’s rows', () => {
    seed({ resourceId: 'i-mine' });
    seed({ resourceId: 'i-theirs', projectId: 'proj-b' });

    const page = listInfraResources({ projectId: PROJECT });
    expect(page.resources.map((r) => r.resource_id)).toEqual(['i-mine']);
  });

  it('filters by service, region, account and lifecycle state', () => {
    seed({ resourceId: 'i-ec2' });
    seed({ resourceId: 'db-1', service: 'rds' });
    seed({ resourceId: 'i-west', region: 'us-west-2' });
    seed({ resourceId: 'i-other-acct', accountId: '999988887777' });
    seed({ resourceId: 'i-stopped', state: 'stopped' });

    expect(
      listInfraResources({ projectId: PROJECT, service: 'rds' }).resources.map(
        (r) => r.resource_id,
      ),
    ).toEqual(['db-1']);
    expect(
      listInfraResources({ projectId: PROJECT, region: 'us-west-2' }).resources.map(
        (r) => r.resource_id,
      ),
    ).toEqual(['i-west']);
    expect(
      listInfraResources({ projectId: PROJECT, accountId: '999988887777' }).resources.map(
        (r) => r.resource_id,
      ),
    ).toEqual(['i-other-acct']);
    expect(
      listInfraResources({ projectId: PROJECT, state: 'stopped' }).resources.map(
        (r) => r.resource_id,
      ),
    ).toEqual(['i-stopped']);
  });

  it('filters by environment, and by its absence', () => {
    seed({ resourceId: 'i-prod', environment: 'prod' });
    seed({ resourceId: 'i-staging', environment: 'staging' });
    seed({ resourceId: 'i-unlabelled', environment: null });

    expect(
      listInfraResources({ projectId: PROJECT, environment: 'prod' }).resources.map(
        (r) => r.resource_id,
      ),
    ).toEqual(['i-prod']);
    // The unlabelled case is the interesting one when hunting for what is not
    // yet joined to a deployment, and an equality filter cannot express it.
    expect(
      listInfraResources({
        projectId: PROJECT,
        environment: INFRA_RESOURCE_NO_ENVIRONMENT,
      }).resources.map((r) => r.resource_id),
    ).toEqual(['i-unlabelled']);
  });

  it('filters by tag key and by an exact tag value', () => {
    seed({
      resourceId: 'i-team-a',
      tags: [
        { Key: 'Team', Value: 'platform' },
        { Key: 'Name', Value: 'web-1' },
      ],
    });
    seed({ resourceId: 'i-team-b', tags: [{ Key: 'Team', Value: 'data' }] });
    seed({ resourceId: 'i-untagged', tags: null });

    expect(
      listInfraResources({ projectId: PROJECT, tagKey: 'Team' }).resources.map(
        (r) => r.resource_id,
      ),
    ).toEqual(expect.arrayContaining(['i-team-a', 'i-team-b']));
    expect(listInfraResources({ projectId: PROJECT, tagKey: 'Team' }).resources).toHaveLength(2);
    expect(
      listInfraResources({ projectId: PROJECT, tagKey: 'Team', tagValue: 'data' }).resources.map(
        (r) => r.resource_id,
      ),
    ).toEqual(['i-team-b']);
  });

  it('treats a tag key as data, not as a JSON path', () => {
    // Tag keys are third-party-controlled text. A path built by concatenation
    // would let a crafted key reach into the document; a bound parameter
    // matches it literally and finds nothing.
    seed({ resourceId: 'i-tagged', tags: [{ Key: 'Team', Value: 'platform' }] });
    expect(
      listInfraResources({ projectId: PROJECT, tagKey: 'Team"]["Value' }).resources,
    ).toHaveLength(0);
  });

  it('matches resource id or name on a substring search', () => {
    seed({ resourceId: 'i-0abc123', name: 'web-server' });
    seed({ resourceId: 'i-0def456', name: 'db-primary' });

    expect(
      listInfraResources({ projectId: PROJECT, search: '0abc' }).resources.map(
        (r) => r.resource_id,
      ),
    ).toEqual(['i-0abc123']);
    expect(
      listInfraResources({ projectId: PROJECT, search: 'primary' }).resources.map(
        (r) => r.resource_id,
      ),
    ).toEqual(['i-0def456']);
  });

  it('does not let a search term act as a LIKE wildcard', () => {
    seed({ resourceId: 'i-literal%pct', name: null });
    seed({ resourceId: 'i-plain', name: null });

    // Unescaped, `%` would match both rows.
    expect(
      listInfraResources({ projectId: PROJECT, search: '%' }).resources.map((r) => r.resource_id),
    ).toEqual(['i-literal%pct']);
  });

  it('drops rows not described since the staleness bound', () => {
    // Rows are never deleted (INFRA-SCOPE), so without this filter a terminated
    // instance stays on the browser forever.
    seed({ resourceId: 'i-fresh', lastSeen: NOW - HOUR });
    seed({ resourceId: 'i-gone', lastSeen: NOW - 48 * HOUR });

    expect(
      listInfraResources({ projectId: PROJECT, seenSinceMs: NOW - 24 * HOUR }).resources.map(
        (r) => r.resource_id,
      ),
    ).toEqual(['i-fresh']);
  });

  it('pages with a keyset cursor and does not repeat or skip a row', () => {
    for (let i = 0; i < 5; i += 1) seed({ resourceId: `i-${i}`, lastSeen: NOW - i * HOUR });

    const first = listInfraResources({ projectId: PROJECT, limit: 2 });
    expect(first.resources).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = listInfraResources({
      projectId: PROJECT,
      limit: 2,
      cursor: first.nextCursor as string,
    });
    const third = listInfraResources({
      projectId: PROJECT,
      limit: 2,
      cursor: second.nextCursor as string,
    });

    const seen = [...first.resources, ...second.resources, ...third.resources].map(
      (r) => r.resource_id,
    );
    expect(seen).toEqual(['i-0', 'i-1', 'i-2', 'i-3', 'i-4']);
    expect(third.nextCursor).toBeNull();
  });

  it('pages rows that share a last_seen without dropping any', () => {
    // The tie-break on resource_key is what stops a keyset cursor from
    // skipping siblings that landed in the same describe sweep.
    for (let i = 0; i < 4; i += 1) seed({ resourceId: `i-tie-${i}`, lastSeen: NOW });

    const first = listInfraResources({ projectId: PROJECT, limit: 2 });
    const second = listInfraResources({
      projectId: PROJECT,
      limit: 2,
      cursor: first.nextCursor as string,
    });
    const ids = [...first.resources, ...second.resources].map((r) => r.resource_id).sort();
    expect(ids).toEqual(['i-tie-0', 'i-tie-1', 'i-tie-2', 'i-tie-3']);
  });

  it('reads a malformed cursor as the first page rather than throwing', () => {
    seed({ resourceId: 'i-only' });
    expect(
      listInfraResources({ projectId: PROJECT, cursor: 'nonsense' }).resources.map(
        (r) => r.resource_id,
      ),
    ).toEqual(['i-only']);
  });
});

describe('getInfraResource', () => {
  it('scopes the lookup to the project', () => {
    const mine = seed({ resourceId: 'i-mine' });
    expect(getInfraResource(PROJECT, mine)?.resource_id).toBe('i-mine');
    expect(getInfraResource('proj-b', mine)).toBeNull();
  });
});

describe('listInfraResourceFacets', () => {
  it('offers every distinct value in the project, not just the filtered ones', () => {
    // A service dropdown that hides every service except the one already
    // selected cannot be used to change the selection.
    seed({ resourceId: 'i-1', service: 'ec2', region: 'us-east-1', environment: 'prod' });
    seed({ resourceId: 'db-1', service: 'rds', region: 'eu-west-1', environment: 'staging' });

    const facets = listInfraResourceFacets({ projectId: PROJECT, service: 'ec2' });
    expect(facets.services).toEqual(['ec2', 'rds']);
    expect(facets.regions).toEqual(['eu-west-1', 'us-east-1']);
    expect(facets.environments).toEqual(['prod', 'staging']);
    expect(facets.states).toEqual(['running']);
  });

  it('counts what the current filters match, ignoring paging', () => {
    seed({ resourceId: 'i-1', service: 'ec2' });
    seed({ resourceId: 'i-2', service: 'ec2' });
    seed({ resourceId: 'db-1', service: 'rds' });

    expect(listInfraResourceFacets({ projectId: PROJECT, limit: 1 }).total).toBe(3);
    expect(listInfraResourceFacets({ projectId: PROJECT, service: 'rds' }).total).toBe(1);
  });

  it('lists tag keys across the project’s resources', () => {
    seed({ resourceId: 'i-1', tags: [{ Key: 'Team', Value: 'platform' }] });
    seed({
      resourceId: 'i-2',
      tags: [
        { Key: 'Team', Value: 'data' },
        { Key: 'Owner', Value: 'ops' },
      ],
    });
    seed({ resourceId: 'i-3', tags: null });

    expect(listInfraResourceFacets({ projectId: PROJECT }).tagKeys).toEqual(['Owner', 'Team']);
  });
});

describe('listInfraResourceSeries', () => {
  function point(over: Record<string, unknown> = {}) {
    return {
      projectId: PROJECT,
      resourceKey: 'placeholder',
      namespace: 'AWS/EC2',
      metricName: 'CPUUtilization',
      stat: 'Average',
      periodSeconds: 60,
      tsMs: NOW,
      value: 10,
      ...over,
    } as Parameters<typeof insertInfraMetricPoints>[0][number];
  }

  it('catalogs what was actually collected, keyed by the full series identity', () => {
    const key = seed({ resourceId: 'i-1' });
    insertInfraMetricPoints([
      point({ resourceKey: key, tsMs: NOW - 2 * 60_000 }),
      point({ resourceKey: key, tsMs: NOW - 60_000 }),
      point({ resourceKey: key, metricName: 'NetworkIn', stat: 'Sum' }),
      // Same metric at a coarser tier is a different series, not a duplicate:
      // a chart that does not pin the period interleaves the two.
      point({ resourceKey: key, periodSeconds: 300 }),
    ]);

    const series = listInfraResourceSeries(PROJECT, key);
    expect(series).toHaveLength(3);
    const cpu60 = series.find((s) => s.metricName === 'CPUUtilization' && s.periodSeconds === 60);
    expect(cpu60).toMatchObject({
      namespace: 'AWS/EC2',
      stat: 'Average',
      pointCount: 2,
      firstTsMs: NOW - 2 * 60_000,
      lastTsMs: NOW - 60_000,
    });
    expect(series.some((s) => s.metricName === 'NetworkIn' && s.stat === 'Sum')).toBe(true);
  });

  it('is empty for a resource nothing has been collected for', () => {
    const key = seed({ resourceId: 'i-quiet' });
    expect(listInfraResourceSeries(PROJECT, key)).toEqual([]);
  });

  it('does not catalog another project’s points', () => {
    const key = seed({ resourceId: 'i-1' });
    insertInfraMetricPoints([point({ resourceKey: key, projectId: 'proj-b' })]);
    expect(listInfraResourceSeries(PROJECT, key)).toEqual([]);
  });
});

describe('parseResourceTags', () => {
  it('flattens AWS’s tag array into a map', () => {
    expect(
      parseResourceTags(JSON.stringify([{ Key: 'Name', Value: 'web-1' }, { Key: 'Team' }])),
    ).toEqual({ Name: 'web-1', Team: '' });
  });

  it('never throws on untrusted text', () => {
    // One malformed tag blob must not take the whole inventory page down.
    expect(parseResourceTags('not json')).toEqual({});
    expect(parseResourceTags('{"Key":"not-an-array"}')).toEqual({});
    expect(parseResourceTags(null)).toEqual({});
  });
});

describe('serializeInfraResource', () => {
  it('emits identifiers and parsed tags, and nothing else', () => {
    const key = seed({
      resourceId: 'i-1',
      name: 'web-1',
      environment: 'prod',
      tags: [{ Key: 'Name', Value: 'web-1' }],
    });
    const wire = serializeInfraResource(getInfraResource(PROJECT, key)!);
    expect(wire).toMatchObject({
      resourceKey: key,
      resourceId: 'i-1',
      service: 'ec2',
      region: 'us-east-1',
      environment: 'prod',
      state: 'running',
      tags: { Name: 'web-1' },
    });
    expect(wire).not.toHaveProperty('tags_json');
  });
});
