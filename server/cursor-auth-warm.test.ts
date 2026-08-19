import { describe, it, expect, vi, beforeEach } from 'vitest';
import { warmCursorAuthForSpawn, warmCursorAuthForHome } from './cursor-auth-warm.js';
import { _resetCursorAuthCacheForTests } from './cursor-auth-cache.js';

const BIN = '/usr/local/bin/cursor-agent';
const USER = 'user-1';
const DATA_DIR = '/tmp/agent-hub-test-data';

vi.mock('./per-user-home.js', () => ({
  ensurePerUserHome: (userId: string) => `/tmp/per-user/${userId}/home`,
}));

describe('warmCursorAuthForSpawn', () => {
  beforeEach(() => {
    _resetCursorAuthCacheForTests();
  });

  it('probes cursor-agent status under the user own HOME', async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const ok = await warmCursorAuthForSpawn({
      cursorBin: BIN,
      userId: USER,
      dataDir: DATA_DIR,
      probe,
      readStoredApiKey: () => null,
    });
    expect(ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(BIN, `/tmp/per-user/${USER}/home`);
  });

  // Regression: an expired token makes the first `status` kick off the token
  // renewal but still report unauthenticated while auth.json is mid-rewrite.
  // Without the retry the warm-up reports failure and the spawn 401s into an
  // engine failover even though the credential was just repaired.
  it('retries once when the first probe reports unauthenticated', async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const ok = await warmCursorAuthForSpawn({
      cursorBin: BIN,
      userId: USER,
      dataDir: DATA_DIR,
      probe,
      readStoredApiKey: () => null,
    });
    expect(ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry when cursor is genuinely logged out', async () => {
    const probe = vi.fn().mockResolvedValue(false);
    const ok = await warmCursorAuthForSpawn({
      cursorBin: BIN,
      userId: USER,
      dataDir: DATA_DIR,
      probe,
      readStoredApiKey: () => null,
    });
    expect(ok).toBe(false);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('skips the probe entirely for API-key auth (no refreshable token)', async () => {
    const probe = vi.fn().mockResolvedValue(false);
    const ok = await warmCursorAuthForSpawn({
      cursorBin: BIN,
      userId: USER,
      dataDir: DATA_DIR,
      probe,
      readStoredApiKey: () => 'key_live_abc',
    });
    expect(ok).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it('memoizes the probe across back-to-back turns for the same user', async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const args = {
      cursorBin: BIN,
      userId: USER,
      dataDir: DATA_DIR,
      probe,
      readStoredApiKey: () => null,
    };
    await warmCursorAuthForSpawn(args);
    await warmCursorAuthForSpawn(args);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('does not leak one user cached answer to another', async () => {
    const probe = vi
      .fn()
      .mockImplementation(async (_bin: string, home: string) => home.includes('user-1'));
    const a = await warmCursorAuthForSpawn({
      cursorBin: BIN,
      userId: 'user-1',
      dataDir: DATA_DIR,
      probe,
      readStoredApiKey: () => null,
    });
    const b = await warmCursorAuthForSpawn({
      cursorBin: BIN,
      userId: 'user-2',
      dataDir: DATA_DIR,
      probe,
      readStoredApiKey: () => null,
    });
    expect(a).toBe(true);
    expect(b).toBe(false);
  });

  it('never throws when the probe blows up — the spawn owns error handling', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('ENOENT: cursor-agent missing'));
    await expect(
      warmCursorAuthForSpawn({
        cursorBin: BIN,
        userId: USER,
        dataDir: DATA_DIR,
        probe,
        readStoredApiKey: () => null,
      }),
    ).resolves.toBe(false);
  });

  it('is a no-op without an acting user or data dir', async () => {
    const probe = vi.fn().mockResolvedValue(true);
    expect(
      await warmCursorAuthForSpawn({ cursorBin: BIN, userId: null, dataDir: DATA_DIR, probe }),
    ).toBe(false);
    expect(
      await warmCursorAuthForSpawn({ cursorBin: BIN, userId: USER, dataDir: null, probe }),
    ).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('warmCursorAuthForHome', () => {
  beforeEach(() => {
    _resetCursorAuthCacheForTests();
  });

  it('probes under the supplied HOME (one-shot spawns carry no user id)', async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const ok = await warmCursorAuthForHome({ cursorBin: BIN, home: '/tmp/per-user/u/home', probe });
    expect(ok).toBe(true);
    expect(probe).toHaveBeenCalledWith(BIN, '/tmp/per-user/u/home');
  });

  it('retries once when the first probe reports unauthenticated', async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const ok = await warmCursorAuthForHome({ cursorBin: BIN, home: '/tmp/h', probe });
    expect(ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('keys the cache per HOME so two owners do not share an answer', async () => {
    const probe = vi
      .fn()
      .mockImplementation(async (_bin: string, home: string) => home.endsWith('/a'));
    expect(await warmCursorAuthForHome({ cursorBin: BIN, home: '/tmp/a', probe })).toBe(true);
    expect(await warmCursorAuthForHome({ cursorBin: BIN, home: '/tmp/b', probe })).toBe(false);
  });

  it('never throws when the probe blows up', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('ENOENT: cursor-agent missing'));
    await expect(warmCursorAuthForHome({ cursorBin: BIN, home: '/tmp/h', probe })).resolves.toBe(
      false,
    );
  });

  it('is a no-op without a HOME', async () => {
    const probe = vi.fn().mockResolvedValue(true);
    expect(await warmCursorAuthForHome({ cursorBin: BIN, home: undefined, probe })).toBe(false);
    expect(await warmCursorAuthForHome({ cursorBin: BIN, home: '  ', probe })).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
});
