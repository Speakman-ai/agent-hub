import { describe, it, expect, vi } from 'vitest';
import type { V3 } from '@browserbasehq/stagehand';
import {
  installBrowserSessionHardening,
  resolveRoutableBrowserContext,
} from './browser-session-hardening.js';

describe('installBrowserSessionHardening', () => {
  it('cancels downloads when downloads are disallowed', async () => {
    let downloadHandler!: (dl: { cancel: () => Promise<void> }) => void;
    const on = vi.fn((evt: string, fn: typeof downloadHandler) => {
      if (evt === 'download') downloadHandler = fn;
    });
    const ctx = { on, route: vi.fn(async () => {}) };
    const stagehand = { context: ctx } as unknown as V3;

    await installBrowserSessionHardening(stagehand, { allowDownloads: false });

    expect(on).toHaveBeenCalledWith('download', expect.any(Function));
    const cancel = vi.fn().mockResolvedValue(undefined);
    downloadHandler({ cancel });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not wire a download listener when downloads are allowed', async () => {
    const on = vi.fn();
    const ctx = { on, route: vi.fn(async () => {}) };
    await installBrowserSessionHardening(ctx, { allowDownloads: true });
    expect(on).not.toHaveBeenCalledWith('download', expect.any(Function));
  });

  it('never installs a Playwright route (the single Fetch owner is CDP)', async () => {
    // A context.route('**/*') would be a second Fetch client that races the CDP
    // guard on the same requestIds. Hardening must not register one.
    const route = vi.fn(async () => {});
    const ctx = { on: vi.fn(), route };
    await installBrowserSessionHardening(ctx, { allowDownloads: false });
    expect(route).not.toHaveBeenCalled();
  });

  it('no-ops on a Stagehand v3 context that is not a Playwright BrowserContext', async () => {
    const stagehand = {
      context: {
        activePage: () => null,
        pages: () => [],
      },
    } as unknown as V3;

    await expect(
      installBrowserSessionHardening(stagehand, { allowDownloads: false }),
    ).resolves.toBeUndefined();
  });
});

describe('resolveRoutableBrowserContext', () => {
  it('unwraps a Stagehand wrapper whose inner context is Playwright-routable', () => {
    const inner = { on: vi.fn(), route: vi.fn() };
    expect(resolveRoutableBrowserContext({ context: inner })).toBe(inner);
  });

  it('returns null for a Stagehand v3 context without on/route', () => {
    expect(resolveRoutableBrowserContext({ context: { activePage: () => null } })).toBeNull();
  });
});
