import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { DESKTOP_COMPUTERS_SCHEMA } from './desktop-computers-schema.js';
import { createDesktopComputersStore } from './desktop-computers-store.js';

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

  it('deletes only the matching computer', () => {
    const s = store();
    s.create({ ...key('u1'), kind: 'firecracker', vmId: 'ahdt-1', slot: 3, lastActiveAt: null });
    expect(s.delete(key('u2'), 'firecracker')).toBe(false);
    expect(s.delete(key('u1'), 'firecracker')).toBe(true);
    expect(s.get(key('u1'), 'firecracker')).toBeNull();
  });
});
