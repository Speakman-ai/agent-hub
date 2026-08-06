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
