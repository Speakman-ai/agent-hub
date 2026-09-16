import { describe, expect, it } from 'vitest';
import { validateBrowserNavigationUrl } from '../browser-navigation-url.js';
import {
  localTargetBrowserPolicy,
  localTargetNavigateAllowed,
  AUTOPILOT_EVAL_BROWSER_TIMEOUT_MS,
} from './local-target-worker.js';

const ORIGIN = 'http://127.0.0.1:4310';

describe('local-target browser worker', () => {
  it('pins navigation to the experiment origin and leaves the public browser blocked', () => {
    expect(validateBrowserNavigationUrl(`${ORIGIN}/todos`).ok).toBe(false);
    expect(localTargetNavigateAllowed(`${ORIGIN}/todos`, ORIGIN)).toBe(true);
    expect(localTargetNavigateAllowed('http://127.0.0.1:9999/', ORIGIN)).toBe(false);
    expect(localTargetNavigateAllowed('https://example.com/', ORIGIN)).toBe(false);
    expect(localTargetBrowserPolicy(ORIGIN)).toEqual({ allowOrigins: [ORIGIN] });
  });

  it('gives evaluator journeys a multi-minute wait so generation can finish', () => {
    expect(AUTOPILOT_EVAL_BROWSER_TIMEOUT_MS).toBe(300_000);
    expect(AUTOPILOT_EVAL_BROWSER_TIMEOUT_MS).toBeGreaterThan(30_000);
  });
});
