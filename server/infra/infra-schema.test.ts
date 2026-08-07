/**
 * `infra.db` DDL — table shapes, keys, CHECKs, indexes and migration
 * idempotency, migrated into an isolated in-memory SQLite handle with no app
 * bootstrap (same pattern as `deployment-env-config-schema.test.ts`).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { INFRA_SCHEMA } from './infra-schema.js';

type NamedRow = { name: string };

let db: Database.Database;

function freshDb(): Database.Database {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  d.exec(INFRA_SCHEMA);
  return d;
}

function colNames(table: string): string[] {
  return (db.pragma(`table_info(${table})`) as NamedRow[]).map((c) => c.name).sort();
}

function indexNames(table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as NamedRow[])
    .map((r) => r.name)
    .filter((n) => n.startsWith('idx_'));
}

function insertScope(over: Partial<Record<string, string | number | null>> = {}): void {
  const row = {
    id: 'sc-1',
    project_id: 'proj-a',
    profile_name: 'monitoring',
    account_id: '111122223333',
    region: 'us-east-1',
    service: 'ec2',
    tag_filter_json: null,
    enabled: 1,
    created_at: 1_800_000_000_000,
    updated_at: 1_800_000_000_000,
    ...over,
  };
  db.prepare(
    `INSERT INTO infra_scopes
       (id, project_id, profile_name, account_id, region, service, tag_filter_json, enabled, created_at, updated_at)
     VALUES (@id, @project_id, @profile_name, @account_id, @region, @service, @tag_filter_json, @enabled, @created_at, @updated_at)`,
  ).run(row);
}

function insertResource(over: Partial<Record<string, string | number | null>> = {}): void {
  const row = {
    resource_key: 'proj-a|111122223333|us-east-1|ec2|i-abc',
    project_id: 'proj-a',
    account_id: '111122223333',
    region: 'us-east-1',
    service: 'ec2',
    resource_id: 'i-abc',
    name: 'web-1',
    tags_json: '{"Name":"web-1"}',
    environment: 'production',
    state: 'running',
    first_seen: 1_800_000_000_000,
    last_seen: 1_800_000_000_000,
    ...over,
  };
  db.prepare(
    `INSERT INTO infra_resources
       (resource_key, project_id, account_id, region, service, resource_id, name, tags_json, environment, state, first_seen, last_seen)
     VALUES (@resource_key, @project_id, @account_id, @region, @service, @resource_id, @name, @tags_json, @environment, @state, @first_seen, @last_seen)`,
  ).run(row);
}

function insertPoint(over: Partial<Record<string, string | number | null>> = {}): void {
  const row = {
    project_id: 'proj-a',
    resource_key: 'proj-a|111122223333|us-east-1|ec2|i-abc',
    namespace: 'AWS/EC2',
    metric_name: 'CPUUtilization',
    dimensions_hash: '-',
    dimensions_json: null,
    stat: 'Average',
    period_s: 60,
    ts_ms: 1_800_000_000_000,
    value: 12.5,
    ...over,
  };
  db.prepare(
    `INSERT INTO infra_metric_points
       (project_id, resource_key, namespace, metric_name, dimensions_hash, dimensions_json, stat, period_s, ts_ms, value)
     VALUES (@project_id, @resource_key, @namespace, @metric_name, @dimensions_hash, @dimensions_json, @stat, @period_s, @ts_ms, @value)`,
  ).run(row);
}

beforeEach(() => {
  db = freshDb();
});

afterEach(() => {
  db.close();
});

describe('infra_scopes', () => {
  it('has the columns the scope editor and collector read', () => {
    expect(colNames('infra_scopes')).toEqual(
      [
        'id',
        'project_id',
        'profile_name',
        'account_id',
        'region',
        'service',
        'tag_filter_json',
        'enabled',
        'created_at',
        'updated_at',
      ].sort(),
    );
  });

  it('defaults enabled to 1 so a freshly-added scope collects', () => {
    db.prepare(
      `INSERT INTO infra_scopes (id, project_id, profile_name, region, service, created_at, updated_at)
       VALUES ('sc-d','proj-a','monitoring','us-east-1','ec2',1,1)`,
    ).run();
    expect(db.prepare('SELECT enabled FROM infra_scopes WHERE id = ?').get('sc-d')).toMatchObject({
      enabled: 1,
    });
  });

  it('constrains enabled to 0/1 via CHECK', () => {
    expect(() => insertScope({ id: 'sc-bad', enabled: 2 })).toThrow(/CHECK/i);
  });

  it('allows a NULL account_id so scope creation never blocks on a live AWS call', () => {
    expect(() => insertScope({ id: 'sc-null', account_id: null })).not.toThrow();
  });

  it('enforces UNIQUE(project_id, profile_name, region, service)', () => {
    insertScope();
    expect(() => insertScope({ id: 'sc-dup' })).toThrow(/UNIQUE/i);
    // The same triple under a different project is a different scope.
    expect(() => insertScope({ id: 'sc-other', project_id: 'proj-b' })).not.toThrow();
    // Same profile+region, different service is also distinct.
    expect(() => insertScope({ id: 'sc-rds', service: 'rds' })).not.toThrow();
  });

  it('indexes lead with project_id', () => {
    expect(indexNames('infra_scopes')).toEqual(
      expect.arrayContaining(['idx_infra_scopes_project', 'idx_infra_scopes_project_enabled']),
    );
    for (const idx of indexNames('infra_scopes')) {
      const cols = (db.prepare(`PRAGMA index_info(${idx})`).all() as NamedRow[]).map((c) => c.name);
      expect(cols[0]).toBe('project_id');
    }
  });
});

describe('infra_resources', () => {
  it('has the inventory columns from INFRA-STORE including the environment join key', () => {
    expect(colNames('infra_resources')).toEqual(
      [
        'resource_key',
        'project_id',
        'account_id',
        'region',
        'service',
        'resource_id',
        'name',
        'tags_json',
        'environment',
        'state',
        'metric_dimensions_json',
        'features_json',
        'first_seen',
        'last_seen',
      ].sort(),
    );
  });

  it('enforces UNIQUE(project_id, account_id, region, service, resource_id)', () => {
    insertResource();
    // A different derived key over the same natural tuple must still be
    // rejected — the constraint is what stops two rows becoming one chart.
    expect(() => insertResource({ resource_key: 'other-key' })).toThrow(/UNIQUE/i);
    // The same instance id in another region/account/project is a distinct row.
    expect(() => insertResource({ resource_key: 'k-west', region: 'us-west-2' })).not.toThrow();
    expect(() =>
      insertResource({ resource_key: 'k-acct', account_id: '999988887777' }),
    ).not.toThrow();
    expect(() => insertResource({ resource_key: 'k-proj', project_id: 'proj-b' })).not.toThrow();
  });

  it('rejects a duplicate resource_key', () => {
    insertResource();
    expect(() => insertResource({ resource_id: 'i-def' })).toThrow(/UNIQUE/i);
  });

  it('leaves name, tags, environment and state optional', () => {
    expect(() =>
      insertResource({
        resource_key: 'k-sparse',
        resource_id: 'i-sparse',
        name: null,
        tags_json: null,
        environment: null,
        state: null,
      }),
    ).not.toThrow();
  });

  it('indexes project reads with project_id first and keeps a global last_seen scan', () => {
    const idx = indexNames('infra_resources');
    expect(idx).toEqual(
      expect.arrayContaining([
        'idx_infra_resources_project_service',
        'idx_infra_resources_project_region',
        'idx_infra_resources_project_environment',
        'idx_infra_resources_last_seen',
      ]),
    );
    for (const name of idx.filter((n) => n.includes('_project_'))) {
      const cols = (db.prepare(`PRAGMA index_info(${name})`).all() as NamedRow[]).map(
        (c) => c.name,
      );
      expect(cols[0]).toBe('project_id');
    }
    // The reaper's aging pass walks oldest-first across every project, so this
    // one is deliberately NOT project-scoped.
    const reaperCols = (
      db.prepare('PRAGMA index_info(idx_infra_resources_last_seen)').all() as NamedRow[]
    ).map((c) => c.name);
    expect(reaperCols).toEqual(['last_seen']);
  });
});

describe('infra_metric_points', () => {
  it('has the time-series columns from INFRA-STORE with value as REAL', () => {
    expect(colNames('infra_metric_points')).toEqual([
      'dimensions_hash',
      'dimensions_json',
      'id',
      'metric_name',
      'namespace',
      'period_s',
      'project_id',
      'resource_key',
      'stat',
      'ts_ms',
      'value',
    ]);
    const value = (
      db.pragma('table_info(infra_metric_points)') as { name: string; type: string }[]
    ).find((c) => c.name === 'value');
    expect(value?.type).toBe('REAL');
  });

  it('enforces the natural series key so an overlapping re-collection cannot duplicate', () => {
    insertPoint();
    expect(() => insertPoint()).toThrow(/UNIQUE/i);
  });

  it('treats stat, period and dimensions as part of the series identity', () => {
    insertPoint();
    expect(() => insertPoint({ stat: 'Maximum' })).not.toThrow();
    expect(() => insertPoint({ period_s: 300 })).not.toThrow();
    expect(() => insertPoint({ dimensions_hash: 'abc123' })).not.toThrow();
    expect(() => insertPoint({ ts_ms: 1_800_000_060_000 })).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM infra_metric_points').get()).toMatchObject({ c: 5 });
  });

  it('indexes chart reads project-first and keeps a global ts_ms scan for the reaper', () => {
    const idx = indexNames('infra_metric_points');
    expect(idx).toEqual(
      expect.arrayContaining([
        'idx_infra_metric_points_series',
        'idx_infra_metric_points_chart',
        'idx_infra_metric_points_ts',
      ]),
    );

    const chartCols = (
      db.prepare('PRAGMA index_info(idx_infra_metric_points_chart)').all() as NamedRow[]
    ).map((c) => c.name);
    expect(chartCols).toEqual(['project_id', 'resource_key', 'metric_name', 'ts_ms']);

    // The chart read is newest-first; a plain ASC index would force a sort.
    const chartDdl = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_infra_metric_points_chart'")
      .get() as { sql: string };
    expect(chartDdl.sql).toMatch(/ts_ms DESC/i);

    // The reaper's aging pass walks oldest-first across every project.
    const reaperCols = (
      db.prepare('PRAGMA index_info(idx_infra_metric_points_ts)').all() as NamedRow[]
    ).map((c) => c.name);
    expect(reaperCols).toEqual(['ts_ms']);
  });

  it('uses the chart index for a bounded range read', () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT value FROM infra_metric_points
          WHERE project_id = ? AND resource_key = ? AND metric_name = ?
            AND ts_ms >= ? AND ts_ms <= ?
          ORDER BY ts_ms DESC LIMIT 100`,
      )
      .all('proj-a', 'rk', 'CPUUtilization', 0, 1) as { detail: string }[];
    expect(plan.map((r) => r.detail).join(' ')).toMatch(/idx_infra_metric_points_(chart|series)/);
  });

  it('leaves dimensions_json optional for an undimensioned metric', () => {
    expect(() => insertPoint({ dimensions_json: null })).not.toThrow();
  });
});

describe('infra_collect_runs', () => {
  it('has the per-tick audit columns INFRA-COST reads', () => {
    expect(colNames('infra_collect_runs')).toEqual([
      'account_id',
      'datapoints_returned',
      'duration_ms',
      'error_message',
      'errors',
      'estimated_cost_usd',
      'finished_at',
      'id',
      'kind',
      'metrics_requested',
      'points_written',
      'project_id',
      'queries_issued',
      'region',
      'started_at',
      'status',
      'throttles',
    ]);
  });

  it('defaults kind to metrics, which is what every row predating the column is', () => {
    db.prepare(
      `INSERT INTO infra_collect_runs (id, project_id, started_at)
       VALUES ('run-kind-default', 'proj-a', 1)`,
    ).run();
    const row = db
      .prepare('SELECT kind FROM infra_collect_runs WHERE id = ?')
      .get('run-kind-default') as { kind: string };
    expect(row.kind).toBe('metrics');
  });

  it('accepts an unrecognised kind, because the column deliberately carries no CHECK', () => {
    // A CHECK on a column that schema-reconcile.ts adds cannot be widened later
    // without rebuilding the table, and this enum grows every time a ticket adds
    // a billed API. Readers normalize instead.
    expect(() =>
      db
        .prepare(
          `INSERT INTO infra_collect_runs (id, project_id, started_at, kind)
           VALUES ('run-kind-future', 'proj-a', 1, 'some_future_api')`,
        )
        .run(),
    ).not.toThrow();
  });

  it('opens as running with zeroed counters and constrains status', () => {
    db.prepare(
      `INSERT INTO infra_collect_runs (id, project_id, started_at)
       VALUES ('run-1', 'proj-a', 1)`,
    ).run();
    expect(
      db.prepare('SELECT status, queries_issued, estimated_cost_usd FROM infra_collect_runs').get(),
    ).toMatchObject({ status: 'running', queries_issued: 0, estimated_cost_usd: 0 });

    expect(() =>
      db
        .prepare(
          `INSERT INTO infra_collect_runs (id, project_id, started_at, status)
           VALUES ('run-2', 'proj-a', 1, 'done')`,
        )
        .run(),
    ).toThrow(/CHECK/i);
  });

  it('indexes the per-project run history newest-first', () => {
    expect(indexNames('infra_collect_runs')).toContain('idx_infra_collect_runs_project');
    const cols = (
      db.prepare('PRAGMA index_info(idx_infra_collect_runs_project)').all() as NamedRow[]
    ).map((c) => c.name);
    expect(cols).toEqual(['project_id', 'started_at']);
  });
});

describe('infra_health_events', () => {
  function insertHealthEvent(over: Partial<Record<string, string | number | null>> = {}): void {
    const row = {
      id: 'he-1',
      project_id: 'proj-a',
      event_arn: 'arn:aws:health:us-east-1::event/EC2/AWS_EC2_OPERATIONAL_ISSUE/abc',
      communication_id: 'comm-1',
      affected_account: '111122223333',
      account_id: '111122223333',
      delivery_region: 'us-east-1',
      event_region: 'us-east-1',
      detail_type: 'AWS Health Event',
      service: 'EC2',
      event_type_code: 'AWS_EC2_OPERATIONAL_ISSUE',
      event_type_category: 'issue',
      event_scope_code: 'PUBLIC',
      status_code: 'open',
      severity: 'critical',
      start_time_ms: 1000,
      end_time_ms: null,
      last_updated_ms: null,
      description: 'trouble',
      affected_entities_json: null,
      affected_entity_count: 0,
      backup_event: 0,
      page: 1,
      total_pages: 1,
      event_time_ms: null,
      received_at_ms: 2000,
      notification_delivered_at_ms: null,
      ...over,
    };
    db.prepare(
      `INSERT INTO infra_health_events (
         id, project_id, event_arn, communication_id, affected_account, account_id,
         delivery_region, event_region, detail_type, service, event_type_code,
         event_type_category, event_scope_code, status_code, severity,
         start_time_ms, end_time_ms, last_updated_ms, description,
         affected_entities_json, affected_entity_count, backup_event,
         page, total_pages, event_time_ms, received_at_ms, notification_delivered_at_ms
       ) VALUES (
         @id, @project_id, @event_arn, @communication_id, @affected_account, @account_id,
         @delivery_region, @event_region, @detail_type, @service, @event_type_code,
         @event_type_category, @event_scope_code, @status_code, @severity,
         @start_time_ms, @end_time_ms, @last_updated_ms, @description,
         @affected_entities_json, @affected_entity_count, @backup_event,
         @page, @total_pages, @event_time_ms, @received_at_ms, @notification_delivered_at_ms
       )`,
    ).run(row);
  }

  it('has the expected columns', () => {
    expect(colNames('infra_health_events')).toContain('communication_id');
    expect(colNames('infra_health_events')).toContain('affected_account');
    expect(colNames('infra_health_events')).toContain('notification_delivered_at_ms');
  });

  it('rejects a duplicate (project, arn, communication, account, page)', () => {
    // This constraint IS the at-least-once dedupe guarantee.
    insertHealthEvent();
    expect(() => insertHealthEvent({ id: 'he-2' })).toThrow(/UNIQUE/i);
  });

  it('allows the same arn+communication for a different affected account', () => {
    insertHealthEvent();
    expect(() => insertHealthEvent({ id: 'he-2', affected_account: '999988887777' })).not.toThrow();
  });

  it('allows separate pages of one paginated event', () => {
    insertHealthEvent();
    expect(() => insertHealthEvent({ id: 'he-2', page: 2, total_pages: 2 })).not.toThrow();
  });

  it('constrains severity to the routing vocabulary', () => {
    expect(() => insertHealthEvent({ id: 'he-x', severity: 'bogus' })).toThrow(/CHECK/i);
  });

  it('does NOT constrain event_type_category, so a new AWS category is storable', () => {
    expect(() =>
      insertHealthEvent({ id: 'he-y', communication_id: 'c2', event_type_category: 'brandNew' }),
    ).not.toThrow();
  });

  it('indexes the timeline, incident-collapse and pending-notification reads', () => {
    expect(indexNames('infra_health_events').sort()).toEqual([
      'idx_infra_health_events_arn',
      'idx_infra_health_events_pending',
      'idx_infra_health_events_project',
    ]);
  });
});

describe('infra_health_ingest_tokens', () => {
  it('is keyed by project and stores only a hash plus a prefix', () => {
    const cols = colNames('infra_health_ingest_tokens');
    expect(cols).toContain('token_hash');
    expect(cols).toContain('token_prefix');
    expect(cols).not.toContain('token');
    db.prepare(
      `INSERT INTO infra_health_ingest_tokens
         (project_id, token_hash, token_prefix, created_at)
       VALUES ('proj-a', 'hash', 'ahhealth_abc', 1)`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO infra_health_ingest_tokens
             (project_id, token_hash, token_prefix, created_at)
           VALUES ('proj-a', 'hash2', 'ahhealth_def', 2)`,
        )
        .run(),
    ).toThrow(/UNIQUE|PRIMARY/i);
  });
});

describe('migration idempotency', () => {
  it('re-executing the DDL preserves existing rows and throws nothing', () => {
    insertScope();
    insertResource();
    insertPoint();
    expect(() => db.exec(INFRA_SCHEMA)).not.toThrow();
    expect(() => db.exec(INFRA_SCHEMA)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM infra_scopes').get()).toMatchObject({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM infra_resources').get()).toMatchObject({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM infra_metric_points').get()).toMatchObject({ c: 1 });
  });

  it('is entirely IF NOT EXISTS — no unguarded CREATE in the DDL', () => {
    const creates = INFRA_SCHEMA.match(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)[\s\S]*?\(/gi) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const stmt of creates) {
      expect(stmt).toMatch(/IF NOT EXISTS/i);
    }
  });
});
