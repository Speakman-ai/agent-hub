/**
 * Tests for browser.ts — covers the pure pieces (options builder, session
 * registry) without launching real Chromium. A separate smoke-test (not
 * run in CI by default) will exercise `launchBrowserSession` against a
 * real browser binary.
 */

import { fileURLToPath } from 'url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DEFAULT_CHROMIUM_ARGS,
  DEFAULT_STAGEHAND_OPTIONS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_VIEWPORT,
  __registerBrowserSessionForTests,
  __resetBrowserRegistryForTests,
  __unregisterBrowserSessionForTests,
  buildStagehandOptions,
  closeAllBrowserSessions,
  closeBrowserSession,
  describeChromiumLaunchEnv,
  getBrowserSession,
  listBrowserSessions,
  type BrowserSession,
} from './browser.js';

describe('browser.ts — defaults', () => {
  it('exposes a frozen defaults object with safe EC2 flags', () => {
    expect(DEFAULT_VIEWPORT).toEqual({ width: 1280, height: 720 });
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
    // The flag set MUST include --no-sandbox for the agenthub EC2 user.
    expect(DEFAULT_CHROMIUM_ARGS).toContain('--no-sandbox');
    expect(DEFAULT_CHROMIUM_ARGS).toContain('--disable-setuid-sandbox');
    expect(DEFAULT_CHROMIUM_ARGS).toContain('--disable-dev-shm-usage');
    expect(Object.isFrozen(DEFAULT_CHROMIUM_ARGS)).toBe(true);
    // The shared defaults object is also frozen so no caller can mutate it.
    expect(Object.isFrozen(DEFAULT_STAGEHAND_OPTIONS)).toBe(true);
  });

  it('defaults object points Stagehand at LOCAL env with headless chromium', () => {
    expect(DEFAULT_STAGEHAND_OPTIONS.env).toBe('LOCAL');
    expect(DEFAULT_STAGEHAND_OPTIONS.localBrowserLaunchOptions.headless).toBe(true);
    expect(DEFAULT_STAGEHAND_OPTIONS.localBrowserLaunchOptions.viewport).toEqual(DEFAULT_VIEWPORT);
    expect(DEFAULT_STAGEHAND_OPTIONS.localBrowserLaunchOptions.connectTimeoutMs).toBe(
      DEFAULT_TIMEOUT_MS,
    );
    expect(DEFAULT_STAGEHAND_OPTIONS.localBrowserLaunchOptions.chromiumSandbox).toBe(false);
  });
});

describe('buildStagehandOptions', () => {
  it('returns defaults when called with no overrides', () => {
    const opts = buildStagehandOptions();
    expect(opts.env).toBe('LOCAL');
    expect(opts.verbose).toBe(0);
    expect(opts.localBrowserLaunchOptions.headless).toBe(true);
    expect(opts.localBrowserLaunchOptions.viewport).toEqual(DEFAULT_VIEWPORT);
    expect(opts.localBrowserLaunchOptions.args).toEqual([...DEFAULT_CHROMIUM_ARGS]);
    expect(opts.actTimeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(opts.domSettleTimeout).toBe(DEFAULT_TIMEOUT_MS);
    // No model unless explicitly requested.
    expect(opts.model).toBeUndefined();
  });

  it('applies caller-supplied overrides', () => {
    const opts = buildStagehandOptions({
      headless: false,
      viewport: { width: 800, height: 600 },
      timeoutMs: 5_000,
      args: ['--foo'],
      model: 'anthropic/claude-sonnet-4-6',
    });
    expect(opts.localBrowserLaunchOptions.headless).toBe(false);
    expect(opts.localBrowserLaunchOptions.viewport).toEqual({ width: 800, height: 600 });
    expect(opts.localBrowserLaunchOptions.args).toEqual(['--foo']);
    expect(opts.localBrowserLaunchOptions.connectTimeoutMs).toBe(5_000);
    expect(opts.actTimeoutMs).toBe(5_000);
    expect(opts.domSettleTimeout).toBe(5_000);
    expect(opts.model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('returns a fresh args array (callers mutating the result must not affect defaults)', () => {
    const opts = buildStagehandOptions();
    opts.localBrowserLaunchOptions.args.push('--mutated');
    // Re-building must still yield the pristine default set.
    const fresh = buildStagehandOptions();
    expect(fresh.localBrowserLaunchOptions.args).toEqual([...DEFAULT_CHROMIUM_ARGS]);
    expect(fresh.localBrowserLaunchOptions.args).not.toContain('--mutated');
  });

  it('overriding args replaces — does not extend — the default set', () => {
    const opts = buildStagehandOptions({ args: ['--only-one'] });
    expect(opts.localBrowserLaunchOptions.args).toEqual(['--only-one']);
    // Sanity: caller is responsible for re-adding --no-sandbox when overriding.
    expect(opts.localBrowserLaunchOptions.args).not.toContain('--no-sandbox');
  });

  it('passes executablePath through when supplied', () => {
    const opts = buildStagehandOptions({ executablePath: '/tmp/chrome' });
    expect(opts.localBrowserLaunchOptions.executablePath).toBe('/tmp/chrome');
  });

  it('omits executablePath when the caller does not set one', () => {
    const opts = buildStagehandOptions();
    expect(opts.localBrowserLaunchOptions.executablePath).toBeUndefined();
  });
});

describe('describeChromiumLaunchEnv', () => {
  const prev = process.env.PLAYWRIGHT_BROWSERS_PATH;
  afterEach(() => {
    if (prev === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = prev;
  });

  it('reports the pinned PLAYWRIGHT_BROWSERS_PATH when set', () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH = '/ms-playwright';
    const diag = describeChromiumLaunchEnv('/ms-playwright/chromium-1234/chrome-linux/chrome');
    expect(diag).toContain('PLAYWRIGHT_BROWSERS_PATH=/ms-playwright');
  });

  it('flags an unset browsers path so an unpinned image is obvious', () => {
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    const diag = describeChromiumLaunchEnv(undefined);
    expect(diag).toContain('unset');
    expect(diag).toContain('~/.cache/ms-playwright');
  });

  it('marks a resolved executable that is missing on disk (the revision-mismatch failure mode)', () => {
    const diag = describeChromiumLaunchEnv('/does/not/exist/chrome');
    expect(diag).toContain('/does/not/exist/chrome');
    expect(diag).toContain('MISSING ON DISK');
  });

  it('marks a resolved executable that exists on disk', () => {
    // Use this test file itself as a guaranteed-present path.
    const diag = describeChromiumLaunchEnv(fileURLToPath(import.meta.url));
    expect(diag).toContain('[exists]');
  });

  it('notes the system-Chrome fallback when no executable could be resolved', () => {
    const diag = describeChromiumLaunchEnv(undefined);
    expect(diag).toContain('unresolved');
  });
});

describe('session registry', () => {
  beforeEach(() => {
    __resetBrowserRegistryForTests();
  });

  function fakeSession(id: string): BrowserSession & { closeMock: ReturnType<typeof vi.fn> } {
    const closeMock = vi.fn().mockResolvedValue(undefined);
    const session: BrowserSession = {
      id,
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      stagehand: { close: closeMock, init: vi.fn() },
      close: async () => {
        await closeMock();
        __unregisterBrowserSessionForTests(id);
      },
    };
    return Object.assign(session, { closeMock });
  }

  it('starts empty', () => {
    expect(listBrowserSessions()).toEqual([]);
    expect(getBrowserSession('missing')).toBeUndefined();
  });

  it('registers and retrieves sessions by id', () => {
    const a = fakeSession('a');
    const b = fakeSession('b');
    __registerBrowserSessionForTests(a);
    __registerBrowserSessionForTests(b);

    expect(getBrowserSession('a')?.id).toBe('a');
    expect(getBrowserSession('b')?.id).toBe('b');
    expect(listBrowserSessions()).toHaveLength(2);
  });

  it('closeBrowserSession returns false for unknown ids', async () => {
    expect(await closeBrowserSession('nope')).toBe(false);
  });

  it('closeAllBrowserSessions closes every registered session and clears the registry', async () => {
    const a = fakeSession('a');
    const b = fakeSession('b');
    __registerBrowserSessionForTests(a);
    __registerBrowserSessionForTests(b);

    await closeAllBrowserSessions();

    expect(listBrowserSessions()).toEqual([]);
    expect(a.closeMock).toHaveBeenCalledTimes(1);
    expect(b.closeMock).toHaveBeenCalledTimes(1);
  });

  it('closeAllBrowserSessions tolerates a single close() failure without throwing', async () => {
    const good = fakeSession('good');
    const bad = fakeSession('bad');
    bad.closeMock.mockRejectedValueOnce(new Error('kaboom'));
    __registerBrowserSessionForTests(good);
    __registerBrowserSessionForTests(bad);

    await expect(closeAllBrowserSessions()).resolves.toBeUndefined();
    expect(listBrowserSessions()).toEqual([]);
    expect(good.closeMock).toHaveBeenCalledTimes(1);
    expect(bad.closeMock).toHaveBeenCalledTimes(1);
  });
});
