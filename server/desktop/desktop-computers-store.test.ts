import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { DESKTOP_COMPUTERS_SCHEMA } from './desktop-computers-schema.js';
import { createDesktopComputersStore } from './desktop-computers-store.js';
import { organizationWorkspaceId } from '../organization-workspace-id.js';

function store() {
  const db = new Database(':memory:');
  db.exec(DESKTOP_COMPUTERS_SCHEMA);
  return createDesktopComputersStore(() => db);
}

const key = (userId: string) => ({ userId, agentId: 'a', projectId: 'p' });

describe('desktop computers store', () => {
  it('round-trips a record and lists held slots', () => {
    const s = store();
    s.create({ ...key('u1'), kind: 'firecracker', vmId: 'ahdt-1', slot: 7, lastActiveAt: null });
    s.create({ ...key('u2'), kind: 'firecracker', vmId: 'ahdt-2', slot: 4, lastActiveAt: null });
    s.touch(key('u1'), 'firecracker', 123);
    expect(s.get(key('u1'), 'firecracker')).toEqual({
      ...key('u1'),
      kind: 'firecracker',
      vmId: 'ahdt-1',
      slot: 7,
      lastActiveAt: 123,
    });
    expect(s.listSlots('firecracker')).toEqual([4, 7]);
    expect(s.listSlots('container')).toEqual([]);
  });

  it('refuses a slot another computer already holds', () => {
    const s = store();
    s.create({ ...key('u1'), kind: 'firecracker', vmId: 'ahdt-1', slot: 3, lastActiveAt: null });
    expect(() =>
      s.create({ ...key('u2'), kind: 'firecracker', vmId: 'ahdt-2', slot: 3, lastActiveAt: null }),
    ).toThrow(/UNIQUE/);
  });

  it('records and clears the snapshot pointer per computer', () => {
    const s = store();
    s.create({ ...key('u1'), kind: 'firecracker', vmId: 'ahdt-1', slot: 3, lastActiveAt: null });
    s.create({ ...key('u2'), kind: 'firecracker', vmId: 'ahdt-2', slot: 4, lastActiveAt: null });
    expect(s.getSnapshot(key('u1'), 'firecracker')).toBeNull();
    s.setSnapshot(key('u1'), 'firecracker', 'sha256:abc');
    expect(s.getSnapshot(key('u1'), 'firecracker')).toBe('sha256:abc');
    expect(s.getSnapshot(key('u2'), 'firecracker')).toBeNull();
    s.setSnapshot(key('u1'), 'firecracker', null);
    expect(s.getSnapshot(key('u1'), 'firecracker')).toBeNull();
  });

  it('deletes only the matching computer', () => {
    const s = store();
    s.create({ ...key('u1'), kind: 'firecracker', vmId: 'ahdt-1', slot: 3, lastActiveAt: null });
    expect(s.delete(key('u2'), 'firecracker')).toBe(false);
    expect(s.delete(key('u1'), 'firecracker')).toBe(true);
    expect(s.get(key('u1'), 'firecracker')).toBeNull();
  });
});

describe('desktop computers store: organization agent isolation', () => {
  const ws = (server: string, org: string) => organizationWorkspaceId(server, org);

  it('keeps one row per Server, organization, user, agent and backend and survives a restart', () => {
    const db = new Database(':memory:');
    db.exec(DESKTOP_COMPUTERS_SCHEMA);
    const s = createDesktopComputersStore(() => db);
    const base = { userId: 'u1', agentId: 'assistant', projectId: ws('server-a', 'org-1') };
    const variants = [
      base,
      { ...base, projectId: ws('server-b', 'org-1') },
      { ...base, projectId: ws('server-a', 'org-2') },
      { ...base, userId: 'u2' },
      { ...base, agentId: 'finance' },
    ];
    variants.forEach((k, i) =>
      s.create({ ...k, kind: 'container', vmId: `vm-${i}`, slot: null, lastActiveAt: null }),
    );
    s.create({ ...base, kind: 'firecracker', vmId: 'vm-fc', slot: 1, lastActiveAt: null });
    expect(new Set(variants.map((k) => s.get(k, 'container')!.vmId)).size).toBe(variants.length);
    expect(s.get(base, 'firecracker')!.vmId).toBe('vm-fc');

    // A fresh store over the same database (Hub restart) resumes the same computer.
    const restarted = createDesktopComputersStore(() => db);
    expect(restarted.get(base, 'container')!.vmId).toBe('vm-0');
  });
});
