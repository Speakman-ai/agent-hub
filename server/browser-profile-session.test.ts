import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';

/**
 * Fake Playwright: each context keeps a cookie jar seeded from the
 * `storageState` it was created with, and `storageState()` returns the jar.
 * Tests "log in" by pushing a cookie into a context's jar.
 */
const pw = vi.hoisted(() => {
  type Cookie = { name: string; value: string; domain: string; path: string };
  type FakeContext = {
    cookies: Cookie[];
    createdWith: { storageState?: unknown };
    storageStateCalls: Array<{ indexedDB: boolean }>;
    closed: boolean;
    /** When set, storageState() waits on it, then reads the jar (and fails if closed). */
    storageGate: Promise<void> | null;
    storageState: (o: { indexedDB: boolean }) => Promise<unknown>;
    newPage: () => Promise<unknown>;
    close: () => Promise<void>;
  };
  const contexts: FakeContext[] = [];
  const launches: Array<Record<string, unknown>> = [];
  const launch = async (opts: Record<string, unknown>) => {
    launches.push(opts);
    return {
      newContext: async (o: { storageState?: { cookies?: Cookie[] } } = {}) => {
        const ctx: FakeContext = {
          cookies: [...(o.storageState?.cookies ?? [])],
          createdWith: o,
          storageStateCalls: [],
          closed: false,
          storageGate: null,
          async storageState(so) {
            ctx.storageStateCalls.push(so);
            if (ctx.storageGate) await ctx.storageGate;
            if (ctx.closed) throw new Error('Target page, context or browser has been closed');
            return { cookies: [...ctx.cookies], origins: [] };
          },
          newPage: async () => ({
            setDefaultTimeout: () => {},
            setDefaultNavigationTimeout: () => {},
            url: () => 'about:blank',
            close: async () => {},
          }),
          close: async () => {
            ctx.closed = true;
          },
        };
        contexts.push(ctx);
        return ctx;
      },
      close: async () => {},
    };
  };
  return {
    contexts,
    launches,
    launch,
    reset() {
      contexts.length = 0;
      launches.length = 0;
    },
  };
});

vi.mock('playwright', () => ({
  chromium: { executablePath: () => '/tmp/fake-chromium-for-tests', launch: pw.launch },
}));

let TMP_DIR = '';
vi.mock('./config.js', () => ({
  default: {
    apiKey: null,
    get dataDir() {
      return TMP_DIR;
    },
  },
}));

const { initOrgsDb, setOrgsDbPathForTests } = await import('./orgs.js');
const { createUser } = await import('./users-store.js');
const { __resetSecretCryptoForTests } = await import('./secret-crypto.js');
const store = await import('./browser-profiles-store.js');
const browser = await import('./browser.js');
const { withBrowserProfile } = await import('./browser-agent-settings.js');
const { BROWSER_PROFILE_READ_ONLY_NOTICE, BROWSER_PROFILE_LEASE_LOST_NOTICE } =
  await import('./browser-profile-binding.js');
const { runBrowserReActStep } = await import('./browser-tools.js');
const {
  __setBrowserConcurrencyForTests,
  __setBrowserIdleMsForTests,
  resetBrowserSecurityTestOverrides,
} = await import('./browser-host-policy.js');
const { registerShutdownTask, _runShutdownTasksForTesting, _resetProcessGroupsForTesting } =
  await import('./process-groups.js');

const LOGIN = { name: 'sid', value: 'logged-in', domain: '.example.com', path: '/' };
let key: { userId: string; agentId: string; projectId: string };

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'browser-profile-session-'));
  __resetSecretCryptoForTests();
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  const user = createUser({ username: 'alice', passwordHash: 'x' });
  key = { userId: user.id, agentId: 'agent-a', projectId: 'proj-1' };
  browser.__resetBrowserRegistryForTests();
  pw.reset();
  __setBrowserConcurrencyForTests(8);
  __setBrowserIdleMsForTests(60 * 60 * 1000);
});

afterEach(async () => {
  vi.useRealTimers();
  await browser.closeAllBrowserSessions();
  _resetProcessGroupsForTesting();
  resetBrowserSecurityTestOverrides();
});

describe('browser sessions with saved profiles', () => {
  it('a login cookie survives session A closing and appears in session B', async () => {
    const a = await browser.launchBrowserSession({ id: 'chat-a', profile: key });
    const ctxA = pw.contexts[0];
    expect(ctxA.createdWith.storageState).toBeUndefined();
    ctxA.cookies.push(LOGIN);

    await browser.closeBrowserSession(a.id);
    expect(ctxA.storageStateCalls).toEqual([{ indexedDB: true }]);
    expect(store.getBrowserProfile(key)?.leaseHolder).toBeNull();

    await browser.launchBrowserSession({ id: 'chat-b', profile: key });
    const ctxB = pw.contexts[1];
    expect(ctxB.createdWith.storageState).toMatchObject({ cookies: [LOGIN] });
    expect(ctxB.cookies).toContainEqual(LOGIN);
  });

  it('gives a concurrent second session a read-only copy whose changes are discarded', async () => {
    const seed = await browser.launchBrowserSession({ id: 'chat-seed', profile: key });
    pw.contexts[0].cookies.push(LOGIN);
    await browser.closeBrowserSession(seed.id);

    const a = await browser.launchBrowserSession({ id: 'chat-a', profile: key });
    const b = await browser.launchBrowserSession({ id: 'chat-b', profile: key });
    const ctxB = pw.contexts[2];
    expect(a.profile?.writable).toBe(true);
    expect(b.profile?.writable).toBe(false);
    expect(ctxB.cookies).toContainEqual(LOGIN);

    const step = await runBrowserReActStep('chat-b', { op: 'close' });
    expect(step.markdown).toContain(BROWSER_PROFILE_READ_ONLY_NOTICE);

    ctxB.cookies.push({ name: 'other', value: 'b-only', domain: 'b.test', path: '/' });
    await browser.closeBrowserSession(b.id);
    expect(ctxB.storageStateCalls).toEqual([]);
    expect(store.loadBrowserProfileState(key)?.cookies).toEqual([LOGIN]);
    expect(store.getBrowserProfile(key)?.leaseHolder).toBe('chat-a');
  });

  it('tells the agent once, not on every step', async () => {
    await browser.launchBrowserSession({ id: 'chat-a', profile: key });
    const b = await browser.launchBrowserSession({ id: 'chat-b', profile: key });
    expect(b.profile?.takeNotice()).toBe(BROWSER_PROFILE_READ_ONLY_NOTICE);
    expect(b.profile?.takeNotice()).toBeNull();
  });

  it('never loads or saves a profile on the preview or design surfaces', async () => {
    const seed = await browser.launchBrowserSession({ id: 'chat-seed', profile: key });
    pw.contexts[0].cookies.push(LOGIN);
    await browser.closeBrowserSession(seed.id);

    for (const id of ['preview:chat-a', 'design:chat-a']) {
      const s = await browser.launchBrowserSession({ id, profile: key });
      const ctx = pw.contexts[pw.contexts.length - 1];
      expect(ctx.createdWith.storageState).toBeUndefined();
      expect(s.profile).toBeUndefined();
      expect(store.getBrowserProfile(key)?.leaseHolder).toBeNull();
      ctx.cookies.push({ name: 'leak', value: 'x', domain: 'localhost', path: '/' });
      await browser.closeBrowserSession(id);
      expect(ctx.storageStateCalls).toEqual([]);
    }
    expect(store.loadBrowserProfileState(key)?.cookies).toEqual([LOGIN]);
  });

  it('saves every 5 minutes while open and keeps the lease alive', async () => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    await browser.launchBrowserSession({ id: 'chat-a', profile: key });
    const ctx = pw.contexts[0];
    ctx.cookies.push(LOGIN);

    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(ctx.storageStateCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60 * 1000 + 10);
    expect(ctx.storageStateCalls).toEqual([{ indexedDB: true }]);
    expect(store.loadBrowserProfileState(key)?.cookies).toEqual([LOGIN]);
    // 5 minutes is past the 2-minute lease TTL, so this only holds if renewal ran.
    expect(store.getBrowserProfile(key)?.leaseHolder).toBe('chat-a');
  });

  it('saves on idle close', async () => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    __setBrowserIdleMsForTests(60 * 1000);
    await browser.launchBrowserSession({ id: 'chat-a', profile: key });
    pw.contexts[0].cookies.push(LOGIN);
    await vi.advanceTimersByTimeAsync(61 * 1000);
    expect(browser.getBrowserSession('chat-a')).toBeUndefined();
    expect(store.loadBrowserProfileState(key)?.cookies).toEqual([LOGIN]);
    expect(store.getBrowserProfile(key)?.leaseHolder).toBeNull();
  });

  it('overlapping closes all wait for the final save before tearing down', async () => {
    const s = await browser.launchBrowserSession({ id: 'chat-a', profile: key });
    const ctx = pw.contexts[0];
    ctx.cookies.push(LOGIN);
    let release!: () => void;
    ctx.storageGate = new Promise<void>((r) => {
      release = r;
    });

    const first = s.close();
    const second = s.close();
    let secondDone = false;
    void second.then(() => {
      secondDone = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(secondDone).toBe(false);
    expect(ctx.closed).toBe(false);

    release();
    await Promise.all([first, second]);
    expect(ctx.storageStateCalls).toHaveLength(1);
    expect(store.loadBrowserProfileState(key)?.cookies).toEqual([LOGIN]);
    expect(store.getBrowserProfile(key)?.leaseHolder).toBeNull();
    expect(ctx.closed).toBe(true);
  });

  it('saves on server shutdown through the registered shutdown task', async () => {
    registerShutdownTask(() => browser.closeAllBrowserSessions());
    await browser.launchBrowserSession({ id: 'chat-a', profile: key });
    pw.contexts[0].cookies.push(LOGIN);
    expect(pw.launches[0]).toMatchObject({ handleSIGTERM: false, handleSIGINT: false });

    await _runShutdownTasksForTesting();
    expect(store.loadBrowserProfileState(key)?.cookies).toEqual([LOGIN]);
  });

  it('goes read-only and says so when the lease is taken over', async () => {
    const a = await browser.launchBrowserSession({ id: 'chat-a', profile: key });
    // Simulate a lapsed lease grabbed by another session.
    store.releaseBrowserProfileLease(key, 'chat-a');
    store.acquireBrowserProfileLease(key, 'chat-z');

    expect(await a.profile!.save()).toBe(false);
    expect(a.profile?.writable).toBe(false);
    expect(a.profile?.takeNotice()).toBe(BROWSER_PROFILE_LEASE_LOST_NOTICE);
  });

  it('launches without a profile when the session has no owner', async () => {
    const opts = withBrowserProfile({}, { ownerUserId: null, agentId: 'a', projectId: 'p' });
    expect(opts.profile).toBeUndefined();
    const s = await browser.launchBrowserSession({ id: 'chat-a', ...opts });
    expect(s.profile).toBeUndefined();
    expect(pw.launches[0].handleSIGTERM).toBeUndefined();
  });
});
