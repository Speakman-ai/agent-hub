/**
 * Per-context Playwright hardening mounted after Stagehand initializes:
 * optional ad/tracker blocking, download cancellation when disallowed.
 */

import type { V3 } from '@browserbasehq/stagehand';
import { isBlockedAdTrackerHostname } from './browser-host-policy.js';

export interface BrowserSessionHardeningOptions {
  blockAdsTrackers: boolean;
  allowDownloads: boolean;
}

/** Minimal Playwright-compatible context surface Stagehand attaches at runtime. */
type RoutableBrowserContext = {
  on(event: 'download', handler: (dl: DownloadLike) => void): void;
  route(pattern: string, handler: (route: RouteLike) => void | Promise<void>): Promise<void>;
};

type DownloadLike = { cancel: () => Promise<void> };

type RouteLike = {
  request(): { url(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
};

/**
 * Install route-based blocking and download listeners on the Stagehand browser context.
 * Safe to call once per session; duplicate route handlers would stack — callers must not repeat.
 */
export async function installBrowserSessionHardening(
  stagehand: V3,
  opts: BrowserSessionHardeningOptions,
): Promise<void> {
  if (!stagehand.context) return;
  const ctx = stagehand.context as unknown as RoutableBrowserContext;

  if (!opts.allowDownloads) {
    ctx.on('download', (dl: DownloadLike) => {
      void dl.cancel().catch(() => {});
    });
  }

  if (!opts.blockAdsTrackers) return;

  await ctx.route('**/*', async (route: RouteLike) => {
    const req = route.request();
    try {
      const u = new URL(req.url());
      if (isBlockedAdTrackerHostname(u.hostname)) {
        await route.abort();
        return;
      }
    } catch {
      // Malformed URLs — fall through.
    }
    await route.continue();
  });
}
