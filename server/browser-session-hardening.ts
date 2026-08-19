/**
 * Per-context Playwright hardening mounted after Chromium launch.
 *
 * This covers only the download listener. Ad/tracker blocking and document URL
 * policy live in the single CDP Fetch owner (`browser-context-fetch-guard.ts`).
 * A Playwright `context.route('**\/*')` is itself a Fetch client, so mounting
 * one here would race the CDP guard on the same requestIds — the exact
 * dual-interceptor bug that folding everything onto one Fetch owner removes.
 */

import type { V3 } from '@browserbasehq/stagehand';

export interface BrowserSessionHardeningOptions {
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

function isRoutableContext(value: unknown): value is RoutableBrowserContext {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.on === 'function' && typeof rec.route === 'function';
}

/**
 * Playwright BrowserContext, or a Stagehand wrapper `{ context }` whose inner
 * object is a Playwright context. Stagehand v3's own `context` (activePage /
 * pages) is NOT Playwright's BrowserContext — it has no `.on` / `.route`.
 */
export function resolveRoutableBrowserContext(source: unknown): RoutableBrowserContext | null {
  if (isRoutableContext(source)) return source;
  if (!source || typeof source !== 'object') return null;
  const inner = (source as { context?: unknown }).context;
  return isRoutableContext(inner) ? inner : null;
}

/**
 * Install the download listener on a Playwright BrowserContext. Safe to call
 * once per session. No-ops when `source` is a Stagehand v3 instance whose
 * `context` is not Playwright-compatible (`ctx.on is not a function`).
 */
export async function installBrowserSessionHardening(
  source: V3 | RoutableBrowserContext | unknown,
  opts: BrowserSessionHardeningOptions,
): Promise<void> {
  const ctx = resolveRoutableBrowserContext(source);
  if (!ctx) return;

  if (!opts.allowDownloads) {
    ctx.on('download', (dl: DownloadLike) => {
      void dl.cancel().catch(() => {});
    });
  }
}
