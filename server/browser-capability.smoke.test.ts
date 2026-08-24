import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveDefaultChromiumPath } from './browser.js';
import { probeBrowserCapability } from './browser-capability.js';

/**
 * Real-launch smoke: actually starts the bundled Chromium and screenshots.
 *
 * This catches an environment that has a Chromium but can't actually launch it
 * (a PLAYWRIGHT_BROWSERS_PATH mismatch, a missing system lib) — things a static
 * Dockerfile-text test can't see.
 *
 * Requirement contract:
 *  - When Chromium is INSTALLED, the real launch runs and MUST pass — so any
 *    environment that provisions a browser (local dev, the runtime image) is
 *    genuinely exercised; a present-but-broken Chromium fails here, never skips.
 *  - `AGENT_HUB_REQUIRE_BROWSER=1` makes a MISSING Chromium a hard failure too —
 *    the explicit "this environment must have a working browser" switch.
 *  - Only when Chromium is absent AND the switch is unset do we skip: a bare
 *    contributor laptop, and the Finalize unit-test lane, which mocks the
 *    browser and deliberately provisions none (its runner pins
 *    PLAYWRIGHT_BROWSERS_PATH at an unwritable path). The image-level guarantee
 *    that Chromium is bundled is enforced by dockerfile.test.ts (recipe) and the
 *    boot-time capability probe (runtime), not this unit lane.
 *
 * Launching Chromium is allowed in tests — the spawn guard in test/setup.ts only
 * blocks the agent CLIs (claude/cursor/gemini/codex), not the browser.
 */
function envFlagEnabled(value: string | undefined): boolean {
  return value != null && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

const chromiumPath = await resolveDefaultChromiumPath();
const chromiumInstalled = Boolean(chromiumPath && existsSync(chromiumPath));
const browserRequired = envFlagEnabled(process.env.AGENT_HUB_REQUIRE_BROWSER);

/** Skip the real launch ONLY when no browser is installed and none is required. */
const skipRealLaunch = !chromiumInstalled && !browserRequired;

describe('browser capability (real launch)', () => {
  it('enforces the required-browser contract', () => {
    // Fast, launch-independent guard. When AGENT_HUB_REQUIRE_BROWSER is set, an
    // absent Chromium fails right here rather than skipping.
    if (browserRequired) {
      expect(
        chromiumInstalled,
        `AGENT_HUB_REQUIRE_BROWSER is set but Chromium is not installed at ` +
          `${chromiumPath ?? '(unresolved)'}. Provision it with ` +
          '`npx playwright install chromium` — a required-but-absent browser must ' +
          'fail, not silently skip.',
      ).toBe(true);
    } else if (skipRealLaunch) {
      console.warn(
        `[browser-capability.smoke] Chromium not installed at ${chromiumPath ?? '(unresolved)'} ` +
          'and AGENT_HUB_REQUIRE_BROWSER unset — skipping the real launch (contributor laptop / ' +
          'browserless CI lane). The bundled-Chromium guarantee is covered by dockerfile.test.ts ' +
          'and the boot-time capability probe.',
      );
    }
    expect(typeof browserRequired).toBe('boolean');
  });

  it.skipIf(skipRealLaunch)(
    'launches the bundled Chromium and captures a screenshot',
    async () => {
      expect(
        chromiumInstalled,
        `Chromium required here but missing at ${chromiumPath ?? '(unresolved)'}; ` +
          'provision with `npx playwright install chromium`.',
      ).toBe(true);
      const cap = await probeBrowserCapability();
      expect(cap.ok, `Chromium failed to launch: ${cap.error ?? ''} — ${cap.diag}`).toBe(true);
    },
    30_000,
  );
});
