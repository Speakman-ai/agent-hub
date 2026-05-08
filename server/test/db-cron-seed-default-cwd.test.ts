/**
 * Narrow config mocks omit `defaultCwd`; cron bootstrap must still populate a
 * non-null `cwd` (see `SqliteError: NOT NULL constraint failed: crons.cwd`).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';

var _cronSeedTmp = '';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  const base = actual.default;
  return {
    default: new Proxy(base, {
      get(t, prop, recv) {
        if (prop === 'dataDir') return _cronSeedTmp || Reflect.get(t, 'dataDir', recv);
        if (prop === 'defaultCwd') return undefined as never;
        return Reflect.get(t, prop, recv);
      },
    }),
  };
});

beforeAll(async () => {
  _cronSeedTmp = mkdtempSync(path.join(tmpdir(), 'cron-seed-db-'));
  await import('../db.js');
});

afterAll(() => {
  rmSync(_cronSeedTmp, { recursive: true, force: true });
});

describe('cron seed cwd', () => {
  it('uses process.cwd when defaultCwd is missing from config', async () => {
    const expected = process.cwd();
    const { getDb } = await import('../db.js');
    const rows = getDb().prepare<{ cwd: string }>('SELECT cwd FROM crons ORDER BY id').all();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) {
      expect(typeof r.cwd).toBe('string');
      expect(r.cwd.length).toBeGreaterThan(0);
      expect(r.cwd).toBe(expected);
    }
    expect(existsSync(path.join(_cronSeedTmp, 'agent-hub.db'))).toBe(true);
  });
});
