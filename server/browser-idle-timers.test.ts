import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  __registerBrowserSessionForTests,
  __resetBrowserRegistryForTests,
  __unregisterBrowserSessionForTests,
  bumpBrowserSessionActivity,
  incrementBrowserToolOpEntered,
  notifyBrowserToolOpEnded,
  type BrowserSession,
} from './browser.js';
import {
  __setBrowserIdleMsForTests,
  resetBrowserSecurityTestOverrides,
} from './browser-host-policy.js';

describe('browser idle auto-close', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetBrowserRegistryForTests();
    resetBrowserSecurityTestOverrides();
    __setBrowserIdleMsForTests(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetBrowserSecurityTestOverrides();
    __resetBrowserRegistryForTests();
  });

  it('defers idle teardown while a browser tool op is in-flight, then closes after TTL from completion', () => {
    const id = 'idle-guard';
    const closeInner = vi.fn().mockResolvedValue(undefined);
    const session: BrowserSession = {
      id,
      createdAt: Date.now(),
      timeoutMs: 30_000,
      stagehand: { close: closeInner, init: vi.fn() },
      close: async () => {
        await closeInner();
        __unregisterBrowserSessionForTests(id);
      },
    };
    __registerBrowserSessionForTests(session);
    bumpBrowserSessionActivity(id);

    incrementBrowserToolOpEntered(id);
    vi.advanceTimersByTime(1_000);
    expect(closeInner).not.toHaveBeenCalled();

    notifyBrowserToolOpEnded(id);
    vi.advanceTimersByTime(999);
    expect(closeInner).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(closeInner).toHaveBeenCalledTimes(1);
  });
});
