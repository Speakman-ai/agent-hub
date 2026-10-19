import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { getOrgsDb, initOrgsDb, setOrgsDbPathForTests } from './orgs.js';

let directory: string;
let dbPath: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'business-organizations-schema-'));
  dbPath = path.join(directory, 'orgs.db');
  setOrgsDbPathForTests(dbPath);
  initOrgsDb();
});

afterEach(() => {
  setOrgsDbPathForTests(null);
  rmSync(directory, { recursive: true, force: true });
});

describe('business organization migration', () => {
  it('upgrades a legacy database without changing Servers, users, or project ACLs', () => {
    const db = getOrgsDb();
    db.exec(`
      DROP TABLE business_organization_members;
      DROP TABLE business_organization_projects;
      DROP TABLE business_organizations;
      INSERT INTO users (id, username, password_hash) VALUES ('u', 'legacy', 'unused');
      INSERT INTO memberships (user_id, org_id, role) VALUES ('u', 'default', 'Owner');
      INSERT INTO project_member_restrictions (project_id) VALUES ('private');
      INSERT INTO project_members (project_id, user_id) VALUES ('private', 'u');
    `);
    const servers = db.prepare('SELECT * FROM orgs').all();
    const memberships = db.prepare('SELECT * FROM memberships').all();
    const projects = db.prepare('SELECT * FROM project_members').all();
    setOrgsDbPathForTests(dbPath);
    initOrgsDb();
    expect(getOrgsDb().prepare('SELECT * FROM orgs').all()).toEqual(servers);
    expect(getOrgsDb().prepare('SELECT * FROM memberships').all()).toEqual(memberships);
    expect(getOrgsDb().prepare('SELECT * FROM project_members').all()).toEqual(projects);
    expect(getOrgsDb().prepare('SELECT * FROM business_organizations').all()).toEqual([]);
  });

  it('adds empty organization tables without converting legacy Server partitions', () => {
    const db = getOrgsDb();
    expect(db.prepare('SELECT id FROM orgs WHERE id = ?').get('default')).toBeTruthy();
    for (const table of [
      'business_organizations',
      'business_organization_projects',
      'business_organization_members',
    ]) {
      expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    }
  });

  it('preserves organization identity and links across migration reruns', () => {
    getOrgsDb().exec(`
      INSERT INTO business_organizations (server_id, id, name) VALUES ('default', 'o', 'Org');
      INSERT INTO business_organization_projects (server_id, organization_id, project_id)
        VALUES ('default', 'o', 'p');
    `);
    setOrgsDbPathForTests(dbPath);
    initOrgsDb();
    expect(getOrgsDb().prepare('SELECT id, name FROM business_organizations').all()).toEqual([
      { id: 'o', name: 'Org' },
    ]);
    expect(
      getOrgsDb().prepare('SELECT project_id FROM business_organization_projects').all(),
    ).toEqual([{ project_id: 'p' }]);
    expect(getOrgsDb().pragma('foreign_key_check')).toEqual([]);
  });

  it('backfills a link generation ID for legacy links and keeps it across reruns', () => {
    const db = getOrgsDb();
    db.exec(`
      DROP TABLE business_organization_projects;
      CREATE TABLE business_organization_projects (
        server_id TEXT NOT NULL, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (server_id, organization_id, project_id)
      );
      INSERT INTO business_organizations (server_id, id, name) VALUES ('default', 'o', 'Org');
      INSERT INTO business_organization_projects (server_id, organization_id, project_id)
        VALUES ('default', 'o', 'p');
    `);
    setOrgsDbPathForTests(dbPath);
    initOrgsDb();
    const first = getOrgsDb()
      .prepare('SELECT link_id FROM business_organization_projects')
      .get() as { link_id: string };
    expect(first.link_id).toMatch(/^[0-9a-f]{32}$/);
    setOrgsDbPathForTests(dbPath);
    initOrgsDb();
    expect(getOrgsDb().prepare('SELECT link_id FROM business_organization_projects').get()).toEqual(
      first,
    );
  });

  it('enforces uniqueness and Server-scoped foreign keys with indexes in both link directions', () => {
    const db = getOrgsDb();
    db.exec(`
      INSERT INTO orgs (id, name) VALUES ('other', 'Other');
      INSERT INTO business_organizations (server_id, id, name) VALUES ('default', 'o', 'Org');
      INSERT INTO business_organization_projects (server_id, organization_id, project_id)
        VALUES ('default', 'o', 'p');
    `);
    const insert = db.prepare(`INSERT INTO business_organization_projects
      (server_id, organization_id, project_id) VALUES (?, ?, ?)`);
    expect(() => insert.run('default', 'o', 'p')).toThrow(/UNIQUE/);
    expect(() => insert.run('other', 'o', 'p')).toThrow(/FOREIGN KEY/);
    expect(() =>
      db
        .prepare('INSERT INTO business_organizations (server_id, id, name) VALUES (?, ?, ?)')
        .run('missing', 'o', 'Invalid'),
    ).toThrow(/FOREIGN KEY/);
    const indexes = db.pragma('index_list(business_organization_projects)') as Array<{
      name: string;
    }>;
    const indexedColumns = indexes.map(({ name }) =>
      (db.pragma(`index_info(${name})`) as Array<{ name: string }>).map((column) => column.name),
    );
    expect(indexedColumns).toContainEqual(['server_id', 'organization_id', 'project_id']);
    expect(indexedColumns).toContainEqual(['server_id', 'project_id', 'organization_id']);
  });
});
