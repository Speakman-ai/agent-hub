import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the real Chromium launch surface so these tests never spawn a browser.
const launchBrowserSession = vi.fn();
const closeBrowserSession = vi.fn(async (_id: string) => true);
vi.mock('./browser.js', () => ({
  launchBrowserSession: (opts: unknown) => launchBrowserSession(opts),
  closeBrowserSession: (id: string) => closeBrowserSession(id),
  resolveDefaultChromiumPath: async () => '/ms-playwright/chromium-1217/chrome-linux64/chrome',
  describeChromiumLaunchEnv: (p: string | undefined) =>
    `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright; executablePath=${p} [exists]`,
}));

import {
  __resetBrowserCapabilityForTests,
  getLastBrowserCapability,
  logBrowserCapabilityAtBoot,
  probeBrowserCapability,
} from './browser-capability.js';

afterEach(() => {
  __resetBrowserCapabilityForTests();
  launchBrowserSession.mockReset();
  closeBrowserSession.mockClear();
  vi.restoreAllMocks();
});

describe('probeBrowserCapability', () => {
  it('reports ok and exercises the screenshot render path when Chromium launches', async () => {
    const screenshot = vi.fn(async () => Buffer.from('jpeg'));
    launchBrowserSession.mockResolvedValue({ id: 'x', page: { screenshot }, timeoutMs: 1000 });

    const cap = await probeBrowserCapability();

    expect(cap.ok).toBe(true);
    expect(cap.error).toBeUndefined();
    expect(cap.diag).toContain('PLAYWRIGHT_BROWSERS_PATH');
    expect(screenshot).toHaveBeenCalledTimes(1);
    // Always cleans up the probe session.
    expect(closeBrowserSession).toHaveBeenCalledWith('__browser_capability_probe__');
    expect(getLastBrowserCapability()).toEqual(cap);
  });

  it('reports the launch failure (with diag) and still cleans up when Chromium is missing', async () => {
    launchBrowserSession.mockRejectedValue(
      new Error('Chromium launch failed: spawn ENOENT. executablePath=/nope [MISSING ON DISK]'),
    );

    const cap = await probeBrowserCapability();

    expect(cap.ok).toBe(false);
    expect(cap.error).toContain('MISSING ON DISK');
    expect(cap.diag).toContain('PLAYWRIGHT_BROWSERS_PATH');
    // finally-block cleanup runs even on a failed launch.
    expect(closeBrowserSession).toHaveBeenCalledWith('__browser_capability_probe__');
    expect(getLastBrowserCapability()?.ok).toBe(false);
  });

  it('never throws even if the launch layer throws synchronously', async () => {
    launchBrowserSession.mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(probeBrowserCapability()).resolves.toMatchObject({ ok: false });
  });
});

describe('logBrowserCapabilityAtBoot', () => {
  it('logs OK at info level when the browser launches', async () => {
    launchBrowserSession.mockResolvedValue({
      id: 'x',
      page: { screenshot: vi.fn() },
      timeoutMs: 1,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await logBrowserCapabilityAtBoot();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('capability check: OK'));
    expect(err).not.toHaveBeenCalled();
  });

  it('logs a loud error with a remediation pointer when the browser is broken', async () => {
    launchBrowserSession.mockRejectedValue(new Error('Chromium launch failed: MISSING ON DISK'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await logBrowserCapabilityAtBoot();

    expect(err).toHaveBeenCalledWith(expect.stringContaining('capability check FAILED'));
    expect(err).toHaveBeenCalledWith(expect.stringContaining('playwright install chromium'));
  });
});
