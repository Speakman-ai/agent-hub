/**
 * runners-store unit tests. The DB is the per-process test data dir
 * initialized by `test/setup.ts` + `db.ts`. We truncate `runners`
 * between tests so each case starts clean — using a separate tmpdir
 * per test would force a full server bootstrap, which is overkill for
 * pure store coverage.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './db.js';
import {
  createRunner,
  deleteRunner,
  generateToken,
  getRunner,
  hashToken,
  listRunners,
  setRunnerStatus,
  verifyRunnerToken,
} from './runners-store.js';

beforeEach(() => {
  getDb().exec('DELETE FROM runners');
});

describe('hashToken / generateToken', () => {
  it('generateToken produces URL-safe strings of stable length', () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes base64url with no padding → 43 chars
    expect(t.length).toBe(43);
  });

  it('hashToken is deterministic and 64 hex chars', () => {
    const h = hashToken('hello');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('hello')).toBe(h);
    expect(hashToken('hello!')).not.toBe(h);
  });
});

describe('createRunner', () => {
  it('inserts a row and returns the public view + plaintext token', () => {
    const { runner, token } = createRunner({ orgId: 'org1', name: 'alice-laptop' });
    expect(runner.id).toBeTruthy();
    expect(runner.orgId).toBe('org1');
    expect(runner.name).toBe('alice-laptop');
    expect(runner.status).toBe('offline');
    expect(runner.lastSeenAt).toBeNull();
    expect(runner.capabilities).toEqual({});
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('persists capabilities as JSON', () => {
    const { runner } = createRunner({
      orgId: 'org1',
      name: 'r2',
      capabilities: { os: 'linux', engines: ['claude'] },
    });
    expect(runner.capabilities).toEqual({ os: 'linux', engines: ['claude'] });
  });

  it('rejects duplicate (orgId, name)', () => {
    createRunner({ orgId: 'org1', name: 'dup' });
    expect(() => createRunner({ orgId: 'org1', name: 'dup' })).toThrow(/UNIQUE/i);
  });

  it('allows the same name in different orgs', () => {
    createRunner({ orgId: 'orgA', name: 'shared' });
    expect(() => createRunner({ orgId: 'orgB', name: 'shared' })).not.toThrow();
  });

  it('does NOT persist the plaintext token', () => {
    const { runner, token } = createRunner({ orgId: 'org1', name: 'r' });
    const row = getDb().prepare('SELECT token_hash FROM runners WHERE id = ?').get(runner.id) as
      | { token_hash: string }
      | undefined;
    expect(row?.token_hash).toBe(hashToken(token));
    expect(row?.token_hash).not.toBe(token);
  });
});

describe('listRunners / getRunner', () => {
  it('listRunners filters by org and orders by name', () => {
    createRunner({ orgId: 'a', name: 'zeta' });
    createRunner({ orgId: 'a', name: 'alpha' });
    createRunner({ orgId: 'b', name: 'gamma' });
    const a = listRunners('a').map((r) => r.name);
    expect(a).toEqual(['alpha', 'zeta']);
    expect(listRunners('b').map((r) => r.name)).toEqual(['gamma']);
  });

  it('listRunners with no filter returns all rows', () => {
    createRunner({ orgId: 'a', name: 'x' });
    createRunner({ orgId: 'b', name: 'y' });
    expect(listRunners().length).toBe(2);
  });

  it('getRunner returns null for unknown id', () => {
    expect(getRunner('nope')).toBeNull();
  });
});

describe('verifyRunnerToken', () => {
  it('returns true for the right token', () => {
    const { runner, token } = createRunner({ orgId: 'o', name: 'n' });
    expect(verifyRunnerToken(runner.id, token)).toBe(true);
  });

  it('returns false for the wrong token', () => {
    const { runner } = createRunner({ orgId: 'o', name: 'n' });
    expect(verifyRunnerToken(runner.id, 'not-the-token')).toBe(false);
  });

  it('returns false for unknown runner id', () => {
    expect(verifyRunnerToken('no-such-id', 'whatever')).toBe(false);
  });
});

describe('setRunnerStatus', () => {
  it('flips status and bumps last_seen_at', () => {
    const { runner } = createRunner({ orgId: 'o', name: 'n' });
    setRunnerStatus(runner.id, 'online');
    const after = getRunner(runner.id);
    expect(after?.status).toBe('online');
    expect(after?.lastSeenAt).toBeTruthy();
  });

  it('updates capabilities when provided', () => {
    const { runner } = createRunner({ orgId: 'o', name: 'n' });
    setRunnerStatus(runner.id, 'online', { os: 'darwin', engines: ['claude'] });
    expect(getRunner(runner.id)?.capabilities).toEqual({ os: 'darwin', engines: ['claude'] });
  });

  it('preserves capabilities when status changes without new caps', () => {
    const { runner } = createRunner({
      orgId: 'o',
      name: 'n',
      capabilities: { os: 'linux' },
    });
    setRunnerStatus(runner.id, 'online');
    expect(getRunner(runner.id)?.capabilities).toEqual({ os: 'linux' });
    setRunnerStatus(runner.id, 'offline');
    expect(getRunner(runner.id)?.capabilities).toEqual({ os: 'linux' });
  });
});

describe('deleteRunner', () => {
  it('removes the row and reports true', () => {
    const { runner } = createRunner({ orgId: 'o', name: 'n' });
    expect(deleteRunner(runner.id)).toBe(true);
    expect(getRunner(runner.id)).toBeNull();
  });

  it('returns false for unknown id', () => {
    expect(deleteRunner('nope')).toBe(false);
  });
});
