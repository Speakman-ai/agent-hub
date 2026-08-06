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

describe('migration idempotency', () => {
  it('re-executing the DDL preserves existing rows and throws nothing', () => {
    insertScope();
    insertResource();
    expect(() => db.exec(INFRA_SCHEMA)).not.toThrow();
    expect(() => db.exec(INFRA_SCHEMA)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM infra_scopes').get()).toMatchObject({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM infra_resources').get()).toMatchObject({ c: 1 });
  });

  it('is entirely IF NOT EXISTS — no unguarded CREATE in the DDL', () => {
    const creates = INFRA_SCHEMA.match(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)[\s\S]*?\(/gi) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const stmt of creates) {
      expect(stmt).toMatch(/IF NOT EXISTS/i);
    }
  });
});
