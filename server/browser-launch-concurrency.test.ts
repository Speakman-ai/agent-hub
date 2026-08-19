import { describe, it, expect, beforeEach, vi } from 'vitest';

const concurrencyMock = vi.hoisted(() => {
  let launchCount = 0;
  return {
    getLaunchCount: () => launchCount,
    reset: () => {
      launchCount = 0;
    },
    launch: async () => {
      launchCount++;
      await new Promise((r) => setTimeout(r, 20));
      return {
        newContext: async () => ({
          newPage: async () => ({
            setDefaultTimeout: () => {},
            setDefaultNavigationTimeout: () => {},
            url: () => 'about:blank',
            close: async () => {},
          }),
          close: async () => {},
        }),
        close: async () => {},
      };
    },
  };
});

vi.mock('@browserbasehq/stagehand', () => ({
  Stagehand: class {
    constructor() {
      throw new Error('Stagehand must not launch for navigate/screenshot');
    }
  },
}));

vi.mock('playwright', () => ({
  chromium: {
    executablePath: () => '/tmp/fake-chromium-for-tests',
    launch: concurrencyMock.launch,
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
    concurrencyMock.reset();
    resetBrowserSecurityTestOverrides();
    vi.clearAllMocks();
  });

  it('dedupes concurrent launches with the same id', async () => {
    const id = 'chat-session-concurrent';
    const [a, b] = await Promise.all([launchBrowserSession({ id }), launchBrowserSession({ id })]);
    expect(a).toBe(b);
    expect(concurrencyMock.getLaunchCount()).toBe(1);
    expect(a.page).toBeDefined();
    expect(a.stagehand).toBeUndefined();
  });

  it('reuses registered session when launchBrowserSession is called again with same id', async () => {
    const id = 'chat-session-reuse';
    const first = await launchBrowserSession({ id });
    const afterFirst = concurrencyMock.getLaunchCount();
    const second = await launchBrowserSession({ id });
    expect(second).toBe(first);
    expect(concurrencyMock.getLaunchCount()).toBe(afterFirst);
  });

  it('getOrCreateBrowserSessionForChat does not double-launch the same chat id concurrently', async () => {
    const id = 'get-or-create-race';
    const [a, b] = await Promise.all([
      getOrCreateBrowserSessionForChat(id),
      getOrCreateBrowserSessionForChat(id),
    ]);
    expect(a).toBe(b);
    expect(concurrencyMock.getLaunchCount()).toBe(1);
  });

  it('rejects launches that exceed configured global concurrency', async () => {
    __setBrowserConcurrencyForTests(2);
    await launchBrowserSession({ id: 'cap-a' });
    await launchBrowserSession({ id: 'cap-b' });
    await expect(launchBrowserSession({ id: 'cap-c' })).rejects.toThrow(/capacity reached/i);
  });
});
