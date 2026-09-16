/**
 * Dedicated Autopilot local-target browser worker.
 *
 * The public `browser` tool keeps blocking loopback. Session preview is a
 * different origin and is not proof of the deployed experiment. Evaluator
 * sessions pin Playwright navigation to the experiment target origin only.
 */

import {
  validateBrowserNavigationUrl,
  type BrowserNavigationPolicyOpts,
} from '../browser-navigation-url.js';

export const LOCAL_TARGET_WORKER_HINT =
  'This is the Autopilot local-target worker (surface: experiment). Session preview is not proof of deployment; the public browser tool cannot open this origin.';

/**
 * Local-target generate/validation journeys (Codex-backed 3MF, scorecards)
 * routinely take longer than the public-web 30s page-load default. Evaluator
 * wait/navigate must cover a real generation, not just health.
 */
export const AUTOPILOT_EVAL_BROWSER_TIMEOUT_MS = 300_000;

export function localTargetBrowserPolicy(origin: string): BrowserNavigationPolicyOpts {
  const trimmed = origin.trim().replace(/\/+$/, '');
  return { allowOrigins: trimmed ? [trimmed] : [] };
}

export function localTargetNavigateAllowed(url: string, origin: string): boolean {
  const pinned = origin.trim().replace(/\/+$/, '');
  const policy = validateBrowserNavigationUrl(url, localTargetBrowserPolicy(pinned));
  if (!policy.ok) return false;
  try {
    return new URL(url).origin === pinned;
  } catch {
    return false;
  }
}
