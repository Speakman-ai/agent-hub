/**
 * Browser capability self-check.
 *
 * The preview tool's `screenshot`/`navigate`/`click`/`type` ops and the generic
 * `browser` tool all drive the **bundled Playwright Chromium** launched inside
 * this process (see {@link file://./browser.ts}). If that Chromium is missing,
 * mislinked (a `PLAYWRIGHT_BROWSERS_PATH` build/runtime mismatch), or crashes on
 * launch for lack of system libs, those tools fail — historically surfacing only
 * when an agent first tried to screenshot, and easily mistaken by the model for
 * "no browser capability exists here."
 *
 * This module launches Chromium once and records the outcome so the failure is
 * loud at boot (operators see it in the server log immediately) and queryable
 * (`getLastBrowserCapability`) rather than latent until first use. The probe is
 * best-effort and never throws — a broken browser must not block server boot.
 */
import {
  closeBrowserSession,
  describeChromiumLaunchEnv,
  launchBrowserSession,
  resolveDefaultChromiumPath,
} from './browser.js';

/** Result of a single {@link probeBrowserCapability} run. */
export interface BrowserCapability {
  /** True when Chromium launched and a test render succeeded. */
  ok: boolean;
  /** Launch/render error message when `ok` is false. */
  error?: string;
  /**
   * One-line diagnostic of how Chromium was located (resolved executable path,
   * whether it exists on disk, and `PLAYWRIGHT_BROWSERS_PATH`). Present on both
   * success and failure so operators can confirm the pinned browser location.
   */
  diag: string;
  /** `Date.now()` when the probe completed. */
  checkedAt: number;
}

/** Reserved browser-session id for the capability probe (never collides with a chat/preview id). */
const PROBE_SESSION_ID = '__browser_capability_probe__';

/** Short timeout — a healthy Chromium launches in well under this; a broken one should fail fast at boot. */
export const BROWSER_CAPABILITY_PROBE_TIMEOUT_MS = 20_000;

let last: BrowserCapability | undefined;

/**
 * The most recent {@link probeBrowserCapability} result, or `undefined` if the
 * probe has not run yet. Callers (e.g. the preview tool) can surface this to
 * explain a browser-backed failure with the real environment diagnostic instead
 * of guessing.
 */
export function getLastBrowserCapability(): BrowserCapability | undefined {
  return last;
}

/** Test-only reset of the cached result. */
export function __resetBrowserCapabilityForTests(): void {
  last = undefined;
}

/**
 * Launch the bundled Chromium once and capture a throwaway screenshot to
 * exercise the full render path the preview/browser tools depend on. Caches and
 * returns the outcome. Never throws.
 */
export async function probeBrowserCapability(): Promise<BrowserCapability> {
  const diag = describeChromiumLaunchEnv(await resolveDefaultChromiumPath());
  try {
    const session = await launchBrowserSession({
      id: PROBE_SESSION_ID,
      headless: true,
      timeoutMs: BROWSER_CAPABILITY_PROBE_TIMEOUT_MS,
    });
    // A live page proves the launch; the screenshot proves the render pipeline
    // (the exact thing the preview `screenshot` op does).
    const page = session.page as { screenshot?: (o?: unknown) => Promise<Buffer> } | undefined;
    if (page?.screenshot) {
      await page.screenshot({ type: 'jpeg', quality: 40 });
    }
    last = { ok: true, diag, checkedAt: Date.now() };
    return last;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    last = { ok: false, error, diag, checkedAt: Date.now() };
    return last;
  } finally {
    try {
      await closeBrowserSession(PROBE_SESSION_ID);
    } catch {
      /* already gone / never launched */
    }
  }
}

/**
 * Run {@link probeBrowserCapability} and log the outcome. Called fire-and-forget
 * at server boot. A failure is logged at error level with a remediation pointer
 * so a de-bundled or mislinked Chromium is obvious immediately rather than at
 * first agent screenshot.
 */
export async function logBrowserCapabilityAtBoot(): Promise<void> {
  const cap = await probeBrowserCapability();
  if (cap.ok) {
    console.log(`[browser] capability check: OK — ${cap.diag}`);
  } else {
    console.error(
      `[browser] capability check FAILED: ${cap.error} — ${cap.diag}. ` +
        'The preview/browser tools cannot screenshot until Chromium launches. ' +
        'Confirm the image ran `npx playwright install-deps chromium` + ' +
        '`npx playwright install chromium`, and that PLAYWRIGHT_BROWSERS_PATH ' +
        'matches between build and runtime (see server/Dockerfile).',
    );
  }
}
