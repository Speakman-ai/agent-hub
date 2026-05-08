import { describe, it, expect, vi } from 'vitest';
import type { V3 } from '@browserbasehq/stagehand';
import { installBrowserSessionHardening } from './browser-session-hardening.js';

describe('installBrowserSessionHardening', () => {
  it('aborts requests to blocked tracker hosts', async () => {
    let routeHandler!: (route: {
      request: () => { url: () => string };
      abort: () => Promise<void>;
      continue: () => Promise<void>;
    }) => void | Promise<void>;

    const route = vi.fn(async (_pattern: string, fn: typeof routeHandler) => {
      routeHandler = fn;
    });
    const ctx = {
      on: vi.fn(),
      route,
    };
    const stagehand = { context: ctx } as unknown as V3;

    await installBrowserSessionHardening(stagehand, {
      allowDownloads: true,
      blockAdsTrackers: true,
    });

    expect(route).toHaveBeenCalledWith('**/*', expect.any(Function));

    const abort = vi.fn().mockResolvedValue(undefined);
    const cont = vi.fn().mockResolvedValue(undefined);
    await routeHandler({
      request: () => ({ url: () => 'https://stats.g.doubleclick.net/pixel?token=secret&sig=bad' }),
      abort,
      continue: cont,
    });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(cont).not.toHaveBeenCalled();
  });

  it('continues non-blocked hosts', async () => {
    let routeHandler!: (route: {
      request: () => { url: () => string };
      abort: () => Promise<void>;
      continue: () => Promise<void>;
    }) => void | Promise<void>;

    const route = vi.fn(async (_pattern: string, fn: typeof routeHandler) => {
      routeHandler = fn;
    });
    const stagehand = { context: { on: vi.fn(), route } } as unknown as V3;

    await installBrowserSessionHardening(stagehand, {
      allowDownloads: true,
      blockAdsTrackers: true,
    });

    const abort = vi.fn().mockResolvedValue(undefined);
    const cont = vi.fn().mockResolvedValue(undefined);
    await routeHandler({
      request: () => ({ url: () => 'https://example.com/api?x=1' }),
      abort,
      continue: cont,
    });
    expect(abort).not.toHaveBeenCalled();
    expect(cont).toHaveBeenCalledTimes(1);
  });
});
