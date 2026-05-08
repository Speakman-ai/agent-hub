/**
 * Host-wide browser safety policy: ad/tracker host matching and test hooks
 * for concurrency / idle thresholds (wired from AppConfig).
 */

import config from './config.js';

/** Substrings / suffixes aligned with known third-party ad and tracker CDN hosts. */
export const DEFAULT_BLOCKED_AD_TRACKER_HOST_SUFFIXES: readonly string[] = Object.freeze([
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  '2mdn.net',
  'google-analytics.com',
  'googletagmanager.com',
  'taboola.com',
  'outbrain.com',
  'scorecardresearch.com',
  'adsafeprotected.com',
  'amazon-adsystem.com',
]);

let testConcurrencyOverride: number | null = null;
let testIdleMsOverride: number | null = null;

/** Vitest-only: override max concurrent Chromium contexts without mutating disk config. */
export function __setBrowserConcurrencyForTests(limit: number | null): void {
  testConcurrencyOverride = limit == null ? null : limit;
}

export function resetBrowserSecurityTestOverrides(): void {
  testConcurrencyOverride = null;
  testIdleMsOverride = null;
}

/** Matches `browserMaxConcurrentContexts` upper clamp in `config.ts` (operator-facing cap). */
const BROWSER_CONTEXT_CAP = 32;

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  const i = Math.trunc(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

export function getBrowserMaxConcurrentContexts(): number {
  if (testConcurrencyOverride != null)
    return clampInt(testConcurrencyOverride, 1, BROWSER_CONTEXT_CAP);
  return clampInt(config.browserMaxConcurrentContexts, 1, BROWSER_CONTEXT_CAP);
}

export function getBrowserIdleTimeoutMs(): number {
  if (testIdleMsOverride != null) {
    const v = Math.trunc(testIdleMsOverride);
    if (!Number.isFinite(v)) {
      return clampInt(config.browserIdleTimeoutMs, 30_000, 3_600_000);
    }
    // Lower floor for Vitest timer tests only — production always uses `config` path.
    return Math.min(Math.max(v, 250), 3_600_000);
  }
  return clampInt(config.browserIdleTimeoutMs, 30_000, 3_600_000);
}

/** Vitest-only: clamped like production idle bounds. Pass `null` to clear. */
export function __setBrowserIdleMsForTests(ms: number | null): void {
  testIdleMsOverride = ms;
}

export function browserAllowDownloadsFromConfig(): boolean {
  return config.browserAllowDownloads;
}

export function browserBlockAdsTrackersFromConfig(): boolean {
  return config.browserBlockAdsTrackers;
}

/**
 * Match request hostname against a small static blocklist (suffix + subdomain walk).
 */
export function isBlockedAdTrackerHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (!h) return false;
  for (const suf of DEFAULT_BLOCKED_AD_TRACKER_HOST_SUFFIXES) {
    if (h === suf || h.endsWith(`.${suf}`)) return true;
  }
  return false;
}
