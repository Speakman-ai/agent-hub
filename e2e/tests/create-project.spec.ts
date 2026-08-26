/**
 * Create-project happy path — the full New Project flow.
 *
 * Exercises the flow end-to-end with the backend's deterministic
 * provisioning stub (enabled via AGENT_HUB_PROVISIONING_STUB=1 in
 * playwright.config.js). That stub swaps the real template + github
 * executors for the same `stubExecutor` used throughout the orchestrator
 * Vitest suite, so every phase emits a plausible success event without
 * touching disk, spawning commands, or calling the GitHub CLI.
 *
 * Coverage:
 *   • CTA → adaptive wizard mounts
 *   • Description is required (Continue disabled until filled)
 *   • Hosting / name / visibility expose an idk escape hatch
 *   • Submit → provisioning view streams phase events
 *   • ps-phase-* rows reach status=ok (the "green dots" assertion)
 *   • First-build kickoff auto-opens the session (wizard unmounts; no landing picker)
 *
 * Network guard:
 *   Any 404 on an /api/* URL fails the test — catches the missing-route
 *   regression class (e.g. a frontend build calling an endpoint the
 *   server doesn't define yet).
 */

import { test, expect } from '../fixtures.js';

test.describe('Create project — happy path', () => {
  test('wizard → provisioning → landing', async ({ page }) => {
    test.setTimeout(30_000);

    // ── Fail-loud on unexpected 404s for any /api/* endpoint ──────────
    // This is the "catches the missing-route regression class" guard
    // from the acceptance criteria.
    const unexpected404s: string[] = [];
    page.on('response', (resp) => {
      if (resp.status() === 404 && /\/api\//.test(resp.url())) {
        unexpected404s.push(resp.url());
      }
    });

    // ── Boot ──────────────────────────────────────────────────────────
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // ── Act I: open the adaptive wizard ───────────────────────────────
    await page.getByTestId('sidebar-new-project-cta').click();
    await expect(page.getByTestId('new-project-adaptive-mount')).toBeVisible();
    await expect(page.getByTestId('adaptive-questionnaire')).toBeVisible();

    // ── Step 1 (description): required — Continue is disabled empty ───
    const continueBtn = page.getByTestId('aq-continue');
    await expect(continueBtn).toBeVisible();
    await expect(continueBtn).toBeDisabled();

    // Description has no `aq-*-idk` button — escape hatches only start
    // from step 2 onward.
    await expect(page.locator('[data-testid*="idk"]')).toHaveCount(0);

    await page
      .getByTestId('aq-description-input')
      .fill('an adaptive survey tool that auto-branches based on answers');
    await expect(continueBtn).toBeEnabled();
    await continueBtn.click();

    // ── Step 2 (hosting): idk present; Agent Hub is pre-selected ──────
    await expect(page.getByTestId('aq-idk')).toBeVisible();
    await page.getByTestId('aq-continue').click();

    // ── Step 3 (identity): idk present for both name and visibility ──
    await expect(page.getByTestId('aq-name-idk')).toBeVisible();
    await expect(page.getByTestId('aq-visibility-idk')).toBeVisible();
    await page.getByTestId('aq-name-idk').click();
    await page.getByTestId('aq-visibility-idk').click();
    await page.getByTestId('aq-continue').click();

    // ── Step 4 (review): submit ───────────────────────────────────────
    const submitBtn = page.getByTestId('aq-submit');
    await expect(submitBtn).toBeVisible();
    await submitBtn.click();

    // ── Provisioning stream ──────────────────────────────────────────
    await expect(page.getByTestId('provisioning-status')).toBeVisible();

    // Header chip lands on "Project ready" once the terminal done event
    // arrives. The stub executor completes every phase inline so this
    // settles well under the default action timeout.
    await expect(page.getByTestId('ps-overall')).toHaveText('Project ready', {
      timeout: 15_000,
    });

    // "provisioning shows green dots" — at least one phase row has
    // status=ok (the emerald-colored CheckCircle2). The stub runs every
    // phase so we expect several.
    const okPhases = page.locator('[data-testid^="ps-phase-"][data-status="ok"]');
    await expect(okPhases.first()).toBeVisible();
    expect(await okPhases.count()).toBeGreaterThanOrEqual(2);

    // First-build kickoff auto-opens the session — the wizard unmounts
    // instead of showing a landing / next-steps picker.
    await expect(page.getByTestId('new-project-adaptive-mount')).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.getByTestId('project-landing')).toHaveCount(0);
    await expect(page.getByTestId('pl-next-open')).toHaveCount(0);
    await expect(page.getByTestId('post-scaffold-audit')).toHaveCount(0);
    await expect(page.getByTestId('pl-roster')).toHaveCount(0);

    // ── Network regression guard ──────────────────────────────────────
    expect(unexpected404s, `Unexpected 404s: ${unexpected404s.join(', ')}`).toEqual([]);
  });
});
