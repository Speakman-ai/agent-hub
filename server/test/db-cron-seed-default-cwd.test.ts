/**
 * A fresh DB must NOT seed any default crons. The earlier
 * `dependabot-merger` / `job-search-monitor` rows were operator-specific
 * leftovers and got removed; this test pins the no-seed contract so a
 * future refactor can't quietly re-introduce them.
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

describe('cron seed (none)', () => {
  it('does not insert any default crons on a fresh database', async () => {
    const { getDb } = await import('../db.js');
    const rows = getDb()
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM crons')
      .all();
    expect(rows[0].count).toBe(0);
    expect(existsSync(path.join(_cronSeedTmp, 'agent-hub.db'))).toBe(true);
  });
});
