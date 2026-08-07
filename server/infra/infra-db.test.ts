/**
 * `infra.db` bootstrap — file placement, WAL, isolation from the operational
 * databases, handle lifecycle, additive drift repair, and the derived resource
 * key metric points join on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  initInfraDb,
  getInfraDb,
  closeInfraDb,
  isInfraDbInitialized,
  infraResourceKey,
  parseInfraResourceKey,
} from './infra-db.js';
import { INFRA_DB_FILENAME, INFRA_SCHEMA } from './infra-schema.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'infra-db-test-'));
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('initInfraDb', () => {
  it('creates infra.db under the data dir with WAL and the expected tables', () => {
    initInfraDb(dir);
    expect(existsSync(path.join(dir, INFRA_DB_FILENAME))).toBe(true);

    const db = getInfraDb();
    expect(String(db.pragma('journal_mode', { simple: true }))).toBe('wal');

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toContain('infra_resources');
    expect(tables).toContain('infra_scopes');
  });

  it('never creates agent-hub.db or orgs.db (infra writes stay isolated)', () => {
    initInfraDb(dir);
    getInfraDb()
      .prepare(
        `INSERT INTO infra_scopes (id, project_id, profile_name, region, service, created_at, updated_at)
         VALUES ('s1','proj-a','monitoring','us-east-1','ec2',1,1)`,
      )
      .run();
    const files = readdirSync(dir);
    expect(files.some((f) => f.startsWith('agent-hub.db'))).toBe(false);
    expect(files.some((f) => f.startsWith('orgs.db'))).toBe(false);
  });

  it('is a no-op on repeat calls for the same dir and keeps the cached handle', () => {
    const first = initInfraDb(dir);
    const second = initInfraDb(dir);
    expect(second).toBe(first);
  });

  it('reopens an existing infra.db without losing rows', () => {
    initInfraDb(dir);
    getInfraDb()
      .prepare(
        `INSERT INTO infra_resources
           (resource_key, project_id, account_id, region, service, resource_id, first_seen, last_seen)
         VALUES ('k1','proj-a','111122223333','us-east-1','ec2','i-abc',1,1)`,
      )
      .run();
    closeInfraDb();

    initInfraDb(dir);
    expect(getInfraDb().prepare('SELECT COUNT(*) c FROM infra_resources').get()).toMatchObject({
      c: 1,
    });
  });

  it('repairs additive column drift on an infra.db that predates a schema edit', () => {
    // Simulate an older install: the table exists with a narrower body, so the
    // CREATE TABLE IF NOT EXISTS in INFRA_SCHEMA is a no-op for it.
    const dbPath = path.join(dir, INFRA_DB_FILENAME);
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE infra_resources (
        resource_key TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL,
        account_id   TEXT NOT NULL,
        region       TEXT NOT NULL,
        service      TEXT NOT NULL,
        resource_id  TEXT NOT NULL,
        first_seen   INTEGER NOT NULL,
        last_seen    INTEGER NOT NULL
      );
    `);
    legacy
      .prepare(
        `INSERT INTO infra_resources
           (resource_key, project_id, account_id, region, service, resource_id, first_seen, last_seen)
         VALUES ('k1','proj-a','111122223333','us-east-1','ec2','i-abc',1,1)`,
      )
      .run();
    legacy.close();

    initInfraDb(dir);
    const cols = (getInfraDb().pragma('table_info(infra_resources)') as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual(expect.arrayContaining(['name', 'tags_json', 'environment', 'state']));
    // Additive only — the pre-existing row survives.
    expect(getInfraDb().prepare('SELECT COUNT(*) c FROM infra_resources').get()).toMatchObject({
      c: 1,
    });
    // Indexes are created after reconciliation, so one over a freshly repaired
    // column (environment) exists rather than having thrown mid-DDL.
    const idx = (
      getInfraDb().prepare('PRAGMA index_list(infra_resources)').all() as { name: string }[]
    ).map((r) => r.name);
    expect(idx).toContain('idx_infra_resources_project_environment');
  });
});

/**
 * Upgrading a database that predates a column.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on a table that already exists —
 * SQLite does not diff the body against the live table — so adding a column to
 * the CREATE body reaches new installs only. `initInfraDb` runs
 * `reconcileSchema` immediately afterwards to close that gap, and this suite is
 * what proves it for `infra_resources`, whose newest columns the collector and
 * the alert sweep both reference by name.
 *
 * The failure this prevents is not subtle: `better-sqlite3` validates column
 * names at *prepare* time, so a drifted column takes down inventory sync and
 * every read that names it, on exactly the installs that have data worth
 * keeping.
 */
describe('initInfraDb — upgrading a pre-existing infra.db', () => {
  /** Write an `infra_resources` exactly as it looked before this change. */
  function seedLegacyDb(): void {
    const legacy = new Database(path.join(dir, INFRA_DB_FILENAME));
    legacy.exec(`
      CREATE TABLE infra_resources (
        resource_key TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL,
        account_id   TEXT NOT NULL,
        region       TEXT NOT NULL,
        service      TEXT NOT NULL,
        resource_id  TEXT NOT NULL,
        name         TEXT,
        tags_json    TEXT,
        environment  TEXT,
        state        TEXT,
        first_seen   INTEGER NOT NULL,
        last_seen    INTEGER NOT NULL,
        UNIQUE (project_id, account_id, region, service, resource_id)
      );
    `);
    legacy
      .prepare(
        `INSERT INTO infra_resources
           (resource_key, project_id, account_id, region, service, resource_id,
            name, tags_json, environment, state, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'legacy-key',
        'proj',
        '111122223333',
        'us-east-1',
        'ec2',
        'i-legacy',
        'web-1',
        null,
        null,
        'running',
        1,
        2,
      );
    legacy.close();
  }

  it('adds the columns the collector and alert sweep name', () => {
    seedLegacyDb();
    initInfraDb(dir);

    const columns = (
      getInfraDb().prepare("PRAGMA table_info('infra_resources')").all() as { name: string }[]
    ).map((c) => c.name);
    expect(columns).toContain('metric_dimensions_json');
    expect(columns).toContain('features_json');
  });

  it('keeps the rows that were already there', () => {
    // Additive only: reconciliation must never rewrite or drop data. A row that
    // predates the column reads back with NULL in it, which the collector
    // treats as "nothing recorded" rather than as an error.
    seedLegacyDb();
    initInfraDb(dir);

    const row = getInfraDb()
      .prepare('SELECT * FROM infra_resources WHERE resource_key = ?')
      .get('legacy-key') as Record<string, unknown>;
    expect(row.resource_id).toBe('i-legacy');
    expect(row.name).toBe('web-1');
    expect(row.first_seen).toBe(1);
    expect(row.metric_dimensions_json).toBeNull();
    expect(row.features_json).toBeNull();
  });

  it('accepts the inventory upsert that writes them', () => {
    // The concrete runtime failure a missing column produces: this statement is
    // the one inventory sync prepares every sweep, and better-sqlite3 rejects
    // it at prepare time if either column is absent.
    seedLegacyDb();
    initInfraDb(dir);

    const upsert = getInfraDb().prepare(`
      INSERT INTO infra_resources (
        resource_key, project_id, account_id, region, service, resource_id,
        name, tags_json, environment, state, metric_dimensions_json, features_json,
        first_seen, last_seen
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(resource_key) DO UPDATE SET
        metric_dimensions_json = excluded.metric_dimensions_json,
        features_json = excluded.features_json,
        last_seen = excluded.last_seen
    `);
    expect(() =>
      upsert.run(
        'legacy-key',
        'proj',
        '111122223333',
        'us-east-1',
        'ec2',
        'i-legacy',
        'web-1',
        null,
        null,
        'running',
        JSON.stringify({ InstanceId: 'i-legacy' }),
        null,
        1,
        99,
      ),
    ).not.toThrow();

    const row = getInfraDb()
      .prepare('SELECT * FROM infra_resources WHERE resource_key = ?')
      .get('legacy-key') as Record<string, unknown>;
    expect(JSON.parse(String(row.metric_dimensions_json))).toEqual({ InstanceId: 'i-legacy' });
    expect(row.last_seen).toBe(99);
  });

  it('is idempotent across restarts', () => {
    seedLegacyDb();
    initInfraDb(dir);
    closeInfraDb();
    // A second boot must not attempt the ALTER again — SQLite errors on a
    // duplicate column name, which would crash-loop every subsequent start.
    expect(() => initInfraDb(dir)).not.toThrow();
    const columns = (
      getInfraDb().prepare("PRAGMA table_info('infra_resources')").all() as { name: string }[]
    ).map((c) => c.name);
    expect(columns.filter((c) => c === 'metric_dimensions_json')).toHaveLength(1);
  });
});

describe('getInfraDb', () => {
  it('throws before init rather than opening a database implicitly', () => {
    expect(isInfraDbInitialized()).toBe(false);
    expect(() => getInfraDb()).toThrow(/not initialized/i);
  });

  it('closeInfraDb releases the handle', () => {
    initInfraDb(dir);
    expect(isInfraDbInitialized()).toBe(true);
    closeInfraDb();
    expect(isInfraDbInitialized()).toBe(false);
    expect(() => getInfraDb()).toThrow(/not initialized/i);
  });

  it('tolerates a double close', () => {
    initInfraDb(dir);
    closeInfraDb();
    expect(() => closeInfraDb()).not.toThrow();
  });
});

describe('infraResourceKey', () => {
  const base = {
    projectId: 'proj-a',
    accountId: '111122223333',
    region: 'us-east-1',
    service: 'ec2',
    resourceId: 'i-abc',
  };

  it('is deterministic for the same identity', () => {
    expect(infraResourceKey(base)).toBe(infraResourceKey({ ...base }));
  });

  it('changes when any component of the natural key changes', () => {
    const keys = new Set([
      infraResourceKey(base),
      infraResourceKey({ ...base, projectId: 'proj-b' }),
      infraResourceKey({ ...base, accountId: '999988887777' }),
      infraResourceKey({ ...base, region: 'us-west-2' }),
      infraResourceKey({ ...base, service: 'rds' }),
      infraResourceKey({ ...base, resourceId: 'i-def' }),
    ]);
    expect(keys.size).toBe(6);
  });

  it('stays injective for ARN resource ids and separator-bearing components', () => {
    const arn = infraResourceKey({
      ...base,
      service: 'elbv2',
      resourceId: 'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/web/abc123',
    });
    expect(arn).not.toContain(':');
    expect(arn).not.toContain('/');

    // Components carrying the separator itself must not be able to shift a
    // boundary and collide with a different identity.
    const a = infraResourceKey({ ...base, service: 'ec2|x', resourceId: 'i-abc' });
    const b = infraResourceKey({ ...base, service: 'ec2', resourceId: 'x|i-abc' });
    expect(a).not.toBe(b);
  });

  it('round-trips through parseInfraResourceKey, separators and ARNs included', () => {
    for (const identity of [
      base,
      { ...base, service: 'ec2|x', resourceId: 'x|i-abc' },
      {
        ...base,
        service: 'elbv2',
        resourceId: 'arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/web/abc',
      },
    ]) {
      expect(parseInfraResourceKey(infraResourceKey(identity))).toEqual(identity);
    }
  });

  it('parses back to null for a key it did not mint', () => {
    // Wrong arity, a malformed percent-escape, and an empty component. Each
    // would otherwise hand a caller a resource id that matches no series.
    expect(parseInfraResourceKey('not-a-key')).toBeNull();
    expect(parseInfraResourceKey('a|b|c|d|e|f')).toBeNull();
    expect(parseInfraResourceKey('a|b|c|d|%zz')).toBeNull();
    expect(parseInfraResourceKey('a|b|c|d|')).toBeNull();
  });

  it('produces a key the schema accepts as the primary key', () => {
    initInfraDb(dir);
    const key = infraResourceKey(base);
    getInfraDb()
      .prepare(
        `INSERT INTO infra_resources
           (resource_key, project_id, account_id, region, service, resource_id, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
      )
      .run(key, base.projectId, base.accountId, base.region, base.service, base.resourceId);
    expect(getInfraDb().prepare('SELECT resource_key FROM infra_resources').get()).toMatchObject({
      resource_key: key,
    });
  });
});

describe('INFRA_SCHEMA export', () => {
  it('is the single source of truth the store executes', () => {
    initInfraDb(dir);
    const isolated = new Database(':memory:');
    isolated.exec(INFRA_SCHEMA);
    const tableSet = (d: Database.Database) =>
      new Set(
        (
          d
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .all() as { name: string }[]
        ).map((r) => r.name),
      );
    expect(tableSet(getInfraDb())).toEqual(tableSet(isolated));
    isolated.close();
  });
});
