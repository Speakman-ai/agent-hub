import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { setOrgsDbPathForTests, initOrgsDb, getOrgsDb } from '../orgs.js';
import { getHubInstanceId, __resetHubInstanceCacheForTests } from './hub-instance.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'hub-instance-'));
  mkdirSync(tmpRoot, { recursive: true });
  setOrgsDbPathForTests(path.join(tmpRoot, 'orgs.db'));
  initOrgsDb();
  __resetHubInstanceCacheForTests();
});

afterEach(() => {
  try {
    getOrgsDb().close();
  } catch {
    /* not initialized */
  }
  setOrgsDbPathForTests(null);
  rmSync(tmpRoot, { recursive: true, force: true });
  __resetHubInstanceCacheForTests();
});

describe('getHubInstanceId', () => {
  it('generates a UUID on first call and persists it', () => {
    const id1 = getHubInstanceId();
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // Drop the in-memory cache; the next call should hit the DB and
    // return the same persisted value.
    __resetHubInstanceCacheForTests();
    const id2 = getHubInstanceId();
    expect(id2).toBe(id1);
  });

  it('caches the value for subsequent calls', () => {
    const id1 = getHubInstanceId();
    // No reset here — second call hits the in-memory cache. Since the
    // implementation is deterministic on the row, the assertion is just
    // "same value", but we also assert only one row exists in DB.
    const id2 = getHubInstanceId();
    expect(id2).toBe(id1);

    const rows = getOrgsDb().prepare('SELECT instance_id FROM hub_instance').all() as Array<{
      instance_id: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.instance_id).toBe(id1);
  });

  it('singleton CHECK(id=1) prevents inserting a second row', () => {
    getHubInstanceId();
    expect(() =>
      getOrgsDb().prepare('INSERT INTO hub_instance (id, instance_id) VALUES (2, ?)').run('x'),
    ).toThrow();
  });
});
