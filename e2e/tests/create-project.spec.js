/**
 * Create-project happy path — Acts I–V of the New Project storyboard.
 *
 * Exercises the full flow end-to-end with the backend's deterministic
 * provisioning stub (enabled via AGENT_HUB_PROVISIONING_STUB=1 in
 * playwright.config.js). That stub swaps the real template + github
 * executors for the same `stubExecutor` used throughout the orchestrator
 * Vitest suite, so every phase emits a plausible success event without
 * touching disk, spawning commands, or calling the GitHub CLI. The
 * post-scaffold audit / roster endpoints are stubbed at the network
 * layer via `page.route()` so we don't depend on the audit service
 * running against an empty workspace.
 *
 * Coverage (Act I → V):
 *   • CTA → adaptive wizard mounts
 *   • Description is required (Continue disabled until filled)
 *   • Every subsequent step exposes an `aq-*-idk` button (covered:
 *     appType, stack, integrations, identity{name,visibility})
 *   • Submit → provisioning view streams phase events
 *   • ps-phase-* rows reach status=ok (the "green dots" assertion)
 *   • "Done" advances to PostScaffoldAudit (Act IV)
 *   • Audit renders a readiness score
 *   • Confirm roster → ProjectLandingHandoff (Act V)
 *   • Landing shows the assigned roster + "Open project" CTA
 *
 * Network guard:
 *   Any 404 on an /api/* URL fails the test — catches the missing-route
 *   regression class (e.g. a frontend build calling an endpoint the
 *   server doesn't define yet).
 */

import { test, expect } from '../fixtures.js';

test.describe('Create project — happy path', () => {
  test('wizard → provisioning → audit → roster → landing', async ({ page, seed }) => {
    test.setTimeout(30_000);

    // Seed a single agent so the roster picker has something assignable
    // and /api/agents is non-empty.
    const seedProject = await seed.project({ name: 'Seed Frontend Home' });
    const agent = await seed.agent({
      projectId: seedProject.id,
      name: 'Frontend Lead',
      role: 'frontend',
    });

    // ── Network-layer stubs for audit / roster endpoints ──────────────
    // The stub provisioning executor doesn't populate a real workspace
    // tree, so the audit service would run against an empty directory.
    // Mocking keeps the audit render deterministic and decoupled from
    // that subsystem's own test coverage.
    const capturedRosterPost = [];

    await page.route('**/api/projects/*/audit', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          projectId: 'e2e-project',
          generatedAt: new Date().toISOString(),
          score: 78,
          readinessScore: 78,
          categories: [
            { id: 'git', label: 'Git', status: 'ok', findings: [] },
            {
              id: 'tests',
              label: 'Tests',
              status: 'warn',
              findings: [
                {
                  id: 'tests-missing',
                  severity: 'warn',
                  category: 'tests',
                  message: 'No test script configured',
                  hint: 'Add `npm test` to package.json',
                },
              ],
            },
          ],
          findings: [
            {
              id: 'tests-missing',
              severity: 'warn',
              category: 'tests',
              message: 'No test script configured',
              hint: 'Add `npm test` to package.json',
            },
          ],
          gaps: [],
          suggestedTracks: [],
        }),
      });
    });

    await page.route('**/api/projects/*/roster/suggest', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          tracks: [
            {
              id: 'architect',
              label: 'Architect',
              rationale: 'Owns high-level design decisions.',
              keywords: ['lead'],
              suggestedAgentId: null,
            },
            {
              id: 'frontend',
              label: 'Frontend',
              rationale: 'Owns the client UI.',
              keywords: ['frontend'],
              // Pre-assign the seeded agent so `hasAnyAssignment` is true
              // and the Confirm button enables without a manual click.
              suggestedAgentId: agent.id,
            },
          ],
        }),
      });
    });

    await page.route('**/api/projects/*/roster', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = JSON.parse(route.request().postData() || '{}');
      capturedRosterPost.push(body);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          tracks: (body.tracks || []).map((t) => ({
            id: t.id,
            label: t.label || t.id,
            agentId: t.agentId || null,
            custom: !!t.custom,
          })),
          updatedAt: new Date().toISOString(),
        }),
      });
    });

    // ── Fail-loud on unexpected 404s for any /api/* endpoint ──────────
    // This is the "catches the missing-route regression class" guard
    // from the acceptance criteria.
    const unexpected404s = [];
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

    // ── Step 2 (appType): idk present ─────────────────────────────────
    await expect(page.getByTestId('aq-idk')).toBeVisible();
    await page.getByTestId('aq-idk').click();
    await page.getByTestId('aq-continue').click();

    // ── Step 3 (stack): idk present ───────────────────────────────────
    await expect(page.getByTestId('aq-idk')).toBeVisible();
    await page.getByTestId('aq-idk').click();
    await page.getByTestId('aq-continue').click();

    // ── Step 4 (integrations): idk present; choosing idk skips auth ──
    await expect(page.getByTestId('aq-idk')).toBeVisible();
    await page.getByTestId('aq-idk').click();
    await page.getByTestId('aq-continue').click();

    // ── Step 5 (identity): idk present for both name and visibility ──
    await expect(page.getByTestId('aq-name-idk')).toBeVisible();
    await expect(page.getByTestId('aq-visibility-idk')).toBeVisible();
    await page.getByTestId('aq-name-idk').click();
    await page.getByTestId('aq-visibility-idk').click();
    await page.getByTestId('aq-continue').click();

    // ── Step 6 (review): submit ───────────────────────────────────────
    const submitBtn = page.getByTestId('aq-submit');
    await expect(submitBtn).toBeVisible();
    await submitBtn.click();

    // ── Act III: provisioning stream ─────────────────────────────────
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

    // Continue into Act IV.
    await page.getByTestId('ps-success-close').click();

    // ── Act IV: PostScaffoldAudit — readiness score rendered ─────────
    await expect(page.getByTestId('post-scaffold-audit')).toBeVisible();
    await expect(page.getByTestId('audit-report')).toBeVisible();
    await expect(page.getByTestId('audit-score-value')).toHaveText(/^\d+$/);
    await expect(page.getByTestId('audit-score-band')).toBeVisible();

    // Roster picker was pre-populated from the suggestions mock; the
    // Frontend track is pre-assigned to the seeded agent so Confirm is
    // enabled straight away.
    const confirmBtn = page.getByTestId('psa-confirm');
    await expect(confirmBtn).toBeEnabled();
    await confirmBtn.click();

    // ── Act V: ProjectLandingHandoff ─────────────────────────────────
    await expect(page.getByTestId('project-landing')).toBeVisible();
    await expect(page.getByTestId('pl-summary')).toBeVisible();
    await expect(page.getByTestId('pl-roster')).toBeVisible();
    // Assigned roster surfaces the Chat button for the Frontend track
    // (only tracks with an agentId render the Chat CTA).
    await expect(page.getByTestId('pl-chat-frontend')).toBeVisible();
    // "Open project" CTA — the Next-Steps "Open the project home" row.
    await expect(page.getByTestId('pl-next-open')).toBeVisible();

    // ── Roster persistence wired up ───────────────────────────────────
    // The POST body should have both tracks with the second assigned to
    // our seeded agent — proves the picker → payload → network round
    // trip works even though the endpoint is mocked.
    expect(capturedRosterPost.length).toBeGreaterThan(0);
    const lastPost = capturedRosterPost[capturedRosterPost.length - 1];
    expect(Array.isArray(lastPost.tracks)).toBe(true);
    const frontendRow = lastPost.tracks.find((t) => t.id === 'frontend');
    expect(frontendRow?.agentId).toBe(agent.id);

    // ── Network regression guard ──────────────────────────────────────
    expect(unexpected404s, `Unexpected 404s: ${unexpected404s.join(', ')}`).toEqual([]);
  });
});
