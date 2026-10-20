import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  getActiveOrgId,
  getOrgsDb,
  initOrgsDb,
  orgDataDir,
  setOrgsDbPathForTests,
} from './orgs.js';
import { findProjectForServer, getProjects, setProjects } from './project-model.js';
import { initDb, getDb } from './db.js';
import { createMembership, setMembershipRole } from './memberships-store.js';
import { ensureOwnerUserFromAuthRecord } from './users-store.js';
import { saveAuthRecord, setAuthFilePathForTests } from './auth-store.js';
import type { Project, Stmts } from './types.js';
import { deleteProjectScopedRows } from './project-owner-cascade.js';
import {
  archiveBusinessOrganization,
  attachBusinessOrganizationProject,
  createBusinessOrganization,
  detachBusinessOrganizationProject,
  getBusinessOrganization,
  listBusinessOrganizationMembers,
  listBusinessOrganizationProjectIds,
  listBusinessOrganizations,
  listBusinessOrganizationsForProject,
  removeBusinessOrganizationMember,
  removeBusinessOrganizationProjectLinks,
  renameBusinessOrganization,
  setBusinessOrganizationMember,
} from './business-organizations-store.js';

// Keep all inactive Server registry fixtures inside the test's temporary root.
const fixture = vi.hoisted(() => ({ directory: '' }));
vi.mock('./orgs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./orgs.js')>()),
  orgDataDir: (id: string) => path.join(fixture.directory, id),
}));

function project(id: string, extra: Partial<Project> = {}): Project {
  return { id, name: id, cwd: path.join(fixture.directory, id), ahw: '', agents: [], ...extra };
}

function create(serverId = 'default', name = 'Organization') {
  return createBusinessOrganization({ serverId, name, createdBy: 'owner' });
}

beforeEach(() => {
  fixture.directory = mkdtempSync(path.join(os.tmpdir(), 'business-organizations-store-'));
  setAuthFilePathForTests(path.join(fixture.directory, 'auth.json'));
  setOrgsDbPathForTests(path.join(fixture.directory, 'orgs.db'));
  initOrgsDb();
  getOrgsDb().exec(`
    INSERT INTO orgs (id, name) VALUES ('other', 'Other Server');
    INSERT INTO orgs (id, name, mode) VALUES ('remote', 'Remote Server', 'remote');
    INSERT INTO users (id, username, password_hash) VALUES ('owner', 'owner', 'unused'), ('member', 'member', 'unused');
    INSERT INTO memberships (user_id, org_id, role) VALUES
      ('owner', 'default', 'Owner'), ('owner', 'other', 'Owner'), ('member', 'default', 'User');
  `);
  setProjects([project('shared'), project('independent')]);
  mkdirSync(orgDataDir('other'), { recursive: true });
  writeFileSync(
    path.join(orgDataDir('other'), 'projects.json'),
    JSON.stringify([
      project('shared', { name: 'Other project with the same ID' }),
      project('foreign'),
      project('internal', { kind: 'system' }),
    ]),
  );
});

afterEach(() => {
  setProjects([]);
  setOrgsDbPathForTests(null);
  setAuthFilePathForTests(null);
  rmSync(fixture.directory, { recursive: true, force: true });
});

describe('business organization persistence', () => {
  it('refuses removing or demoting the last Owner, including through the store', () => {
    const organization = create();
    expect(() => removeBusinessOrganizationMember('default', organization.id, 'owner')).toThrow(
      'Organization must retain an Owner',
    );
    expect(() =>
      setBusinessOrganizationMember('default', organization.id, 'owner', 'Admin'),
    ).toThrow('Organization must retain an Owner');
    setBusinessOrganizationMember('default', organization.id, 'member', 'Owner');
    setBusinessOrganizationMember('default', organization.id, 'owner', 'Member');
    expect(removeBusinessOrganizationMember('default', organization.id, 'owner')).toBe(true);
    expect(() => removeBusinessOrganizationMember('default', organization.id, 'member')).toThrow(
      'Organization must retain an Owner',
    );
  });

  it('creates an empty organization with its creator as Owner and renames without changing identity', () => {
    const organization = create();
    expect(listBusinessOrganizationProjectIds('default', organization.id)).toEqual([]);
    expect(listBusinessOrganizationMembers('default', organization.id)).toEqual([
      expect.objectContaining({ user_id: 'owner', role: 'Owner', server_id: 'default' }),
    ]);
    const renamed = renameBusinessOrganization('default', organization.id, ' Renamed ');
    expect(renamed).toMatchObject({
      id: organization.id,
      name: 'Renamed',
      created_at: organization.created_at,
    });
    expect(listBusinessOrganizations('default')).toEqual([renamed]);
    expect(listBusinessOrganizations('other')).toEqual([]);
  });

  it('links the same project to two organizations without copying or moving project data', () => {
    const a = create();
    const b = create();
    const original = getProjects()[0];
    const snapshot = structuredClone(getProjects());
    mkdirSync(original.cwd, { recursive: true });
    const repoFile = path.join(original.cwd, 'repo.txt');
    writeFileSync(repoFile, 'existing repository');
    expect(attachBusinessOrganizationProject('default', a.id, 'shared')).toBe(true);
    expect(attachBusinessOrganizationProject('default', a.id, 'shared')).toBe(false);
    attachBusinessOrganizationProject('default', b.id, 'shared');
    expect(
      listBusinessOrganizationsForProject('default', 'shared')
        .map((o) => o.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect(detachBusinessOrganizationProject('default', a.id, 'shared')).toBe(true);
    expect(detachBusinessOrganizationProject('default', a.id, 'shared')).toBe(false);
    expect(listBusinessOrganizationProjectIds('default', a.id)).toEqual([]);
    expect(listBusinessOrganizationProjectIds('default', b.id)).toEqual(['shared']);
    expect(listBusinessOrganizationsForProject('default', 'independent')).toEqual([]);
    expect(getProjects()).toEqual(snapshot);
    expect(getProjects()[0]).toBe(original);
    expect(readFileSync(repoFile, 'utf-8')).toBe('existing repository');
  });

  it('reads the selected Server registry without switching the active Server', () => {
    const a = create();
    const b = create('other');
    expect(() => attachBusinessOrganizationProject('default', a.id, 'foreign')).toThrow(
      'Project not found',
    );
    expect(() => attachBusinessOrganizationProject('other', a.id, 'foreign')).toThrow(
      'Organization not found',
    );
    expect(() => attachBusinessOrganizationProject('default', b.id, 'shared')).toThrow(
      'Organization not found',
    );
    attachBusinessOrganizationProject('other', b.id, 'foreign');
    attachBusinessOrganizationProject('other', b.id, 'shared');
    expect(findProjectForServer('other', 'shared')?.name).toBe('Other project with the same ID');
    expect(findProjectForServer('default', 'shared')).toBe(getProjects()[0]);
    expect(listBusinessOrganizationProjectIds('other', b.id)).toEqual(['foreign', 'shared']);
    expect(getActiveOrgId()).toBe('default');
    expect(getProjects().map((p) => p.id)).toEqual(['shared', 'independent']);
  });

  it.each([
    { id: '__hub__' },
    { id: 'system', kind: 'system' as const },
    { id: 'hidden', hidden: true },
    { id: 'internal', internal: true },
  ])('rejects internal workspace $id', (extra) => {
    const a = create();
    setProjects([project(extra.id, extra)]);
    expect(() => attachBusinessOrganizationProject('default', a.id, extra.id)).toThrow(
      'Project not found',
    );
    const b = create('other');
    expect(() => attachBusinessOrganizationProject('other', b.id, 'internal')).toThrow(
      'Project not found',
    );
  });

  it('rejects missing and remote Servers, missing projects and corrupt inactive registries', () => {
    expect(() => create('missing')).toThrow('Server not found');
    expect(() => create('remote')).toThrow('Server not found');
    const b = create('other');
    expect(() => attachBusinessOrganizationProject('other', b.id, 'missing')).toThrow(
      'Project not found',
    );
    writeFileSync(path.join(orgDataDir('other'), 'projects.json'), 'corrupt');
    expect(() => attachBusinessOrganizationProject('other', b.id, 'shared')).toThrow();
    expect(listBusinessOrganizationProjectIds('other', b.id)).toEqual([]);
    expect(getActiveOrgId()).toBe('default');
  });

  it('rolls back creation when the creator is not a member of the selected Server', () => {
    expect(() =>
      createBusinessOrganization({ serverId: 'other', name: 'Invalid', createdBy: 'member' }),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      createBusinessOrganization({ serverId: 'default', name: 'Invalid', createdBy: 'missing' }),
    ).toThrow(/FOREIGN KEY/);
    expect(() => create('default', '   ')).toThrow('Organization name is required');
    expect(listBusinessOrganizations('other')).toEqual([]);
    expect(listBusinessOrganizations('default')).toEqual([]);
    expect(getOrgsDb().prepare('SELECT * FROM business_organization_members').all()).toEqual([]);
  });

  it('maintains explicit organization members without changing project ACLs', () => {
    const a = create();
    setBusinessOrganizationMember('default', a.id, 'member', 'Member');
    setBusinessOrganizationMember('default', a.id, 'member', 'Admin');
    expect(listBusinessOrganizationMembers('default', a.id)).toHaveLength(2);
    expect(listBusinessOrganizationMembers('default', a.id)[0]).toMatchObject({
      user_id: 'member',
      role: 'Admin',
    });
    expect(getOrgsDb().prepare('SELECT * FROM project_members').all()).toEqual([]);
    expect(removeBusinessOrganizationMember('default', a.id, 'member')).toBe(true);
    expect(removeBusinessOrganizationMember('default', a.id, 'member')).toBe(false);
    const b = create('other');
    expect(() => setBusinessOrganizationMember('other', b.id, 'member', 'Member')).toThrow(
      /FOREIGN KEY/,
    );
  });

  it('preserves organization membership when an existing Server membership is saved again', () => {
    const a = create();
    const members = listBusinessOrganizationMembers('default', a.id);
    createMembership('owner', 'default', 'Admin');
    expect(listBusinessOrganizationMembers('default', a.id)).toEqual(members);
    setMembershipRole('owner', 'default', 'Owner');
    expect(listBusinessOrganizationMembers('default', a.id)).toEqual(members);
  });

  it('preserves organization membership when legacy Owner setup is repaired', () => {
    const a = create();
    const members = listBusinessOrganizationMembers('default', a.id);
    saveAuthRecord({
      username: 'owner',
      passwordHash: 'unused',
      jwtSecret: 'test-only',
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(ensureOwnerUserFromAuthRecord()?.id).toBe('owner');
    expect(listBusinessOrganizationMembers('default', a.id)).toEqual(members);
  });

  it('archives atomically, revokes all active links, and preserves projects and owned session history', () => {
    const a = create();
    const b = create();
    attachBusinessOrganizationProject('default', a.id, 'shared');
    attachBusinessOrganizationProject('default', b.id, 'shared');
    setBusinessOrganizationMember('default', a.id, 'member', 'Member');
    const snapshot = structuredClone(getProjects());
    initDb(fixture.directory);
    getDb()
      .prepare('INSERT INTO sessions (id, agent_id, name, owner_user_id) VALUES (?, ?, ?, ?)')
      .run('history', 'agent', 'History', 'owner');
    getDb()
      .prepare('INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)')
      .run('message', 'history', 'user', 'Retained history');
    expect(archiveBusinessOrganization('default', a.id)).toBe(true);
    expect(archiveBusinessOrganization('default', a.id)).toBe(false);
    expect(getBusinessOrganization('default', a.id)).toBeNull();
    expect(getBusinessOrganization('default', a.id, { includeArchived: true })).toMatchObject({
      id: a.id,
      archived_at: expect.any(String),
    });
    expect(listBusinessOrganizations('default')).toEqual([b]);
    expect(listBusinessOrganizationMembers('default', a.id)).toEqual([]);
    expect(listBusinessOrganizationProjectIds('default', a.id)).toEqual([]);
    expect(listBusinessOrganizationProjectIds('default', b.id)).toEqual(['shared']);
    expect(
      getOrgsDb()
        .prepare('SELECT * FROM business_organization_members WHERE organization_id = ?')
        .all(a.id),
    ).toEqual([]);
    expect(() => attachBusinessOrganizationProject('default', a.id, 'shared')).toThrow(
      'Organization not found',
    );
    expect(() => setBusinessOrganizationMember('default', a.id, 'member', 'Admin')).toThrow(
      'Organization not found',
    );
    expect(() => renameBusinessOrganization('default', a.id, 'Restored')).toThrow(
      'Organization not found',
    );
    expect(getProjects()).toEqual(snapshot);
    expect(
      getDb().prepare('SELECT owner_user_id FROM sessions WHERE id = ?').get('history'),
    ).toEqual({ owner_user_id: 'owner' });
    expect(getDb().prepare('SELECT content FROM messages WHERE id = ?').get('message')).toEqual({
      content: 'Retained history',
    });
  });

  it('rolls back the archive and project unlink if member cleanup fails', () => {
    const a = create();
    attachBusinessOrganizationProject('default', a.id, 'shared');
    getOrgsDb()
      .exec(`CREATE TRIGGER fail_member_delete BEFORE DELETE ON business_organization_members
      BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END;`);
    expect(() => archiveBusinessOrganization('default', a.id)).toThrow('injected cleanup failure');
    expect(getBusinessOrganization('default', a.id)).toEqual(a);
    expect(listBusinessOrganizationProjectIds('default', a.id)).toEqual(['shared']);
    expect(listBusinessOrganizationMembers('default', a.id)).toHaveLength(1);
  });

  it('cleans all links on project deletion without touching another Server using the same ID', () => {
    const a = create();
    const b = create();
    const other = create('other');
    attachBusinessOrganizationProject('default', a.id, 'shared');
    attachBusinessOrganizationProject('default', b.id, 'shared');
    attachBusinessOrganizationProject('other', other.id, 'shared');
    const statements = new Proxy({}, { get: () => ({ run: vi.fn() }) }) as Stmts;
    deleteProjectScopedRows(statements, getProjects()[0]);
    expect(listBusinessOrganizationProjectIds('default', a.id)).toEqual([]);
    expect(listBusinessOrganizationProjectIds('default', b.id)).toEqual([]);
    expect(listBusinessOrganizationProjectIds('other', other.id)).toEqual(['shared']);
    expect(removeBusinessOrganizationProjectLinks('default', 'shared')).toBe(0);
  });

  it('cascades Server membership and Server deletion without affecting other partitions', () => {
    const a = create();
    const b = create('other');
    setBusinessOrganizationMember('default', a.id, 'member', 'Member');
    attachBusinessOrganizationProject('other', b.id, 'shared');
    getOrgsDb()
      .prepare('DELETE FROM memberships WHERE user_id = ? AND org_id = ?')
      .run('member', 'default');
    expect(listBusinessOrganizationMembers('default', a.id).map((m) => m.user_id)).toEqual([
      'owner',
    ]);
    getOrgsDb().prepare('DELETE FROM orgs WHERE id = ?').run('other');
    expect(listBusinessOrganizations('other')).toEqual([]);
    expect(listBusinessOrganizationMembers('other', b.id)).toEqual([]);
    expect(listBusinessOrganizations('default')).toEqual([a]);
    expect(getOrgsDb().prepare('SELECT * FROM business_organization_projects').all()).toEqual([]);
    expect(getOrgsDb().pragma('foreign_key_check')).toEqual([]);
  });
});
