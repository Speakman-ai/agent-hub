import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { DESKTOP_COMPUTERS_SCHEMA } from './desktop-computers-schema.js';
import { createDesktopComputersStore } from './desktop-computers-store.js';
import {
  destroyDesktopComputers,
  registerDesktopRuntime,
  resetDesktopRuntimesForTests,
} from './desktop-runtime-registry.js';

const KEY = { userId: 'u1', agentId: 'a1', projectId: 'p1' };

function store() {
  const db = new Database(':memory:');
  db.exec(DESKTOP_COMPUTERS_SCHEMA);
  return createDesktopComputersStore(() => db);
}

describe('destroyDesktopComputers', () => {
  beforeEach(() => resetDesktopRuntimesForTests());

  it('fails when a persisted computer has no registered backend', async () => {
    const s = store();
    s.create({ ...KEY, kind: 'firecracker', vmId: 'ahdt-1', slot: 3, lastActiveAt: null });
    await expect(destroyDesktopComputers(KEY, s)).rejects.toThrow(
      /firecracker: backend is not available/,
    );
    expect(s.get(KEY, 'firecracker')).not.toBeNull();
  });

  it('destroys through the registered backend that owns the row', async () => {
    const s = store();
    s.create({ ...KEY, kind: 'firecracker', vmId: 'ahdt-1', slot: 3, lastActiveAt: null });
    const destroy = vi.fn(async () => undefined);
    registerDesktopRuntime({ kind: 'firecracker', destroy } as never);
    await destroyDesktopComputers(KEY, s);
    expect(destroy).toHaveBeenCalledWith(KEY);
  });

  it('ignores rows that belong to another key', async () => {
    const s = store();
    s.create({
      ...KEY,
      userId: 'other',
      kind: 'firecracker',
      vmId: 'ahdt-2',
      slot: 4,
      lastActiveAt: null,
    });
    await expect(destroyDesktopComputers(KEY, s)).resolves.toBeUndefined();
  });
});
