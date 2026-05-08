import { describe, it, expect, beforeEach, vi } from 'vitest';

const concurrencyMock = vi.hoisted(() => {
  let constructCount = 0;
  class StagehandMock {
    constructor() {
      constructCount++;
    }
    init = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    close = vi.fn(async () => {});
  }
  return {
    StagehandMock,
    getConstructCount: () => constructCount,
    resetConstructCount: () => {
      constructCount = 0;
    },
  };
});

vi.mock('@browserbasehq/stagehand', () => ({
  Stagehand: concurrencyMock.StagehandMock,
}));

vi.mock('playwright', () => ({
  chromium: {
    executablePath: () => '/tmp/fake-chromium-for-tests',
  },
}));

import { getOrCreateBrowserSessionForChat } from './browser-tools.js';
import {
  __resetBrowserRegistryForTests,
  __resetStagehandLoaderForTests,
  launchBrowserSession,
} from './browser.js';
import {
  resetBrowserSecurityTestOverrides,
  __setBrowserConcurrencyForTests,
} from './browser-host-policy.js';

describe('launchBrowserSession — pinned id singleflight', () => {
  beforeEach(() => {
    __resetBrowserRegistryForTests();
    __resetStagehandLoaderForTests();
    concurrencyMock.resetConstructCount();
    resetBrowserSecurityTestOverrides();
    vi.clearAllMocks();
  });

  it('dedupes concurrent launches with the same id', async () => {
    const id = 'chat-session-concurrent';
    const [a, b] = await Promise.all([launchBrowserSession({ id }), launchBrowserSession({ id })]);
    expect(a).toBe(b);
    expect(concurrencyMock.getConstructCount()).toBe(1);
  });

  it('reuses registered session when launchBrowserSession is called again with same id', async () => {
    const id = 'chat-session-reuse';
    const first = await launchBrowserSession({ id });
    const afterFirst = concurrencyMock.getConstructCount();
    const second = await launchBrowserSession({ id });
    expect(second).toBe(first);
    expect(concurrencyMock.getConstructCount()).toBe(afterFirst);
  });

  it('getOrCreateBrowserSessionForChat does not double-launch the same chat id concurrently', async () => {
    const id = 'get-or-create-race';
    const [a, b] = await Promise.all([
      getOrCreateBrowserSessionForChat(id),
      getOrCreateBrowserSessionForChat(id),
    ]);
    expect(a).toBe(b);
    expect(concurrencyMock.getConstructCount()).toBe(1);
  });

  it('rejects launches that exceed configured global concurrency', async () => {
    __setBrowserConcurrencyForTests(2);
    await launchBrowserSession({ id: 'cap-a' });
    await launchBrowserSession({ id: 'cap-b' });
    await expect(launchBrowserSession({ id: 'cap-c' })).rejects.toThrow(/capacity reached/i);
  });
});
