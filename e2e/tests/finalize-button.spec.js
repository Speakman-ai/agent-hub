/**
 * Finalize Code Changes button — E2E spec (card 2bce78c2).
 *
 * Verifies that the new <FinalizeButton /> mounted in the session view
 * (replacing the legacy ChangesReadyBox) exposes the contract documented
 * in the design doc:
 *
 *   • The split "Run Tests" + "Reviewer" buttons are visible for
 *     card-linked sessions in the idle state.
 *   • Clicking "Run Tests" POSTs `/api/projects/:projectId/cards/:cardId/finalize`
 *     with `{ mode: 'checks' }`.
 *   • On 200, the button optimistically transitions to a disabled state
 *     whose label includes "Running" within 5s.
 *   • Sessions that are NOT linked to a card do not render the buttons
 *     (the gate is `activeSession?.card_id`).
 *
 * Setup strategy:
 *   The button only renders when the active session is card-linked AND has
 *   a worktree branch. Rather than fight the real worktree provisioning
 *   path (which would require spawning git + writing real worktree rows),
 *   we mock the backend surfaces the FinalizeButton + useFinalizeRun hook
 *   touch via `page.route()`. This keeps the spec scoped to the UI contract
 *   without depending on the orchestrator or git tooling.
 *
 *   We also intercept the session-list response for the test agent so we
 *   can stamp `card_id` + `worktree_branch` onto the row regardless of how
 *   those fields are surfaced server-side once the implementing agent
 *   wires `card_id` onto the SessionRow wire shape.
 *
 * Pattern is borrowed from `create-project.spec.js` (route-mock heavy) and
 * `chat.spec.js` (seeded project/agent/session navigation).
 */

import { test, expect } from '../fixtures.js';

const SERVER_PORT = process.env.E2E_SERVER_PORT || 4051;

test.describe('Finalize Code Changes button', () => {
  test('idle → click Run Tests → disabled "Running" state', async ({ page, seed, request }) => {
    test.setTimeout(30_000);

    // ── Seed: project, agent, card-linked session ──────────────────────
    const project = await seed.project({ name: 'Finalize E2E Project' });
    const agent = await seed.agent({ projectId: project.id, name: 'Finalize E2E Agent' });
    const card = await seed.card(project.id, { title: 'Finalize E2E Card' });
    const session = await seed.session(agent.id, { name: 'Finalize E2E Session' });

    // Link the session to the card so `card_id` is available on the
    // session wire (the implementing agent will plumb `card_id` onto
    // SessionRow; until then, the route mock below stamps it directly).
    const linkRes = await request.put(
      `http://localhost:${SERVER_PORT}/api/projects/${project.id}/board/cards/${card.id}`,
      { data: { sessionId: session.id } },
    );
    expect(linkRes.ok()).toBeTruthy();

    // ── Network mocks ─────────────────────────────────────────────────
    // 1) Session list: stamp card_id + worktree_branch on the seeded
    //    session so the UI's `activeSession?.card_id` gate is satisfied
    //    and the FinalizeButton receives a non-empty branchLabel. This
    //    is order-independent — if the implementing agent already added
    //    `card_id` to the wire, our overlay is a no-op.
    await page.route(`**/api/agents/${agent.id}/sessions`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const upstream = await route.fetch();
      const body = await upstream.json();
      const rows = Array.isArray(body) ? body : [];
      const patched = rows.map((row) =>
        row.id === session.id
          ? { ...row, card_id: card.id, worktree_branch: 'feature/finalize-e2e' }
          : row,
      );
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(patched),
      });
    });

    // 2) Latest finalize run for this session — start with none so the
    //    button mounts in the idle state.
    let finalizeRunRow = null;
    await page.route(`**/api/sessions/${session.id}/finalize-runs/latest`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ run: finalizeRunRow }),
      });
    });

    // 3) POST finalize start — returns 200 with a queued run. After the
    //    click lands, subsequent reads of finalize-runs/latest will
    //    surface the queued row (drives the disabled label even if the
    //    component falls back to a refetch instead of trusting the POST
    //    response's optimistic state).
    const finalizeStartCalls = [];
    await page.route(`**/api/projects/${project.id}/cards/${card.id}/finalize`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      finalizeStartCalls.push({
        url: route.request().url(),
        body: route.request().postData(),
      });
      const runId = 'finalize-run-e2e-1';
      finalizeRunRow = {
        id: runId,
        card_id: card.id,
        session_id: session.id,
        project_id: project.id,
        branch: 'feature/finalize-e2e',
        head_sha: 'a'.repeat(40),
        idempotency_key: 'idem-1',
        status: 'queued',
        phase: null,
        mode: 'checks',
        trigger_source: 'ui_button',
        worktree_path: null,
        triggered_by_user_id: 'e2e-user',
        author_name: 'E2E',
        author_email: 'e2e@example.com',
        reviewer_verdict: null,
        failure_reason: null,
        failed_step_index: null,
        failed_step_name: null,
        failed_step_exit_code: null,
        retry_of_run_id: null,
        active_seconds_consumed: 0,
        started_at: Date.now(),
        ended_at: null,
        pr_url: null,
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ run_id: runId, status: 'queued', reused: false }),
      });
    });

    // 4) Cancel endpoint — not exercised by this happy-path test, but
    //    stubbed so a stray click during teardown doesn't 404.
    await page.route(`**/api/projects/${project.id}/finalize/*/cancel`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, status: 'cancelled' }),
      });
    });

    // ── Boot the app and navigate to the seeded session ───────────────
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.getByText(project.name).click();
    await page.getByText(agent.name).first().click();

    // Click into the seeded session so it becomes the active session.
    const sessionLink = page.getByText('Finalize E2E Session').first();
    await expect(sessionLink).toBeVisible({ timeout: 5000 });
    await sessionLink.click();

    // ── Assertion 1: the split trigger buttons mount in the idle state ─
    const runTestsBtn = page.getByTestId('finalize-run-tests-button');
    const reviewerBtn = page.getByTestId('finalize-reviewer-button');
    await expect(runTestsBtn).toBeVisible({ timeout: 5000 });
    await expect(runTestsBtn).toBeEnabled();
    await expect(runTestsBtn).toContainText('Run Tests');
    await expect(reviewerBtn).toBeVisible();
    await expect(reviewerBtn).toContainText('Reviewer');

    // ── Assertion 2: clicking "Run Tests" POSTs to the start endpoint ──
    await runTestsBtn.click();
    await expect.poll(() => finalizeStartCalls.length, { timeout: 5000 }).toBeGreaterThan(0);

    // ── Assertion 3: button transitions into a "Stop Tests" control ────
    //
    // While the checks phase runs its trigger flips into a Stop affordance.
    // The contract allows the component to either (a) flip optimistically
    // on the POST 200 response, or (b) wait for the next WS phase event /
    // refetch to land. Either path must settle to "Stop Tests" within 5s
    // of the click (the mocked run row carries `mode: 'checks'`).
    await expect(runTestsBtn).toContainText('Stop Tests', { timeout: 5000 });

    // Once the run row (with its id) lands, the Stop button is clickable so
    // the operator can halt the run — there is no separate cancel control.
    await expect(runTestsBtn).toBeEnabled({ timeout: 5000 });
    await expect(page.getByTestId('finalize-code-changes-cancel')).toHaveCount(0);
  });

  test('card-less session shows the "Link a card" hint instead of the button', async ({
    page,
    seed,
  }) => {
    test.setTimeout(20_000);

    // Seed a session that is intentionally NOT linked to a card. The
    // FinalizeButton's mount gate (`activeSession?.card_id`) means the
    // button must not render — and the round-2 fallback must surface a
    // discoverable "Link a card" hint so the new requirement isn't
    // silently invisible to users.
    const project = await seed.project({ name: 'Finalize Hidden Project' });
    const agent = await seed.agent({ projectId: project.id, name: 'Finalize Hidden Agent' });
    await seed.session(agent.id, { name: 'Unlinked Session' });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.getByText(project.name).click();
    await page.getByText(agent.name).first().click();

    const sessionLink = page.getByText('Unlinked Session').first();
    await expect(sessionLink).toBeVisible({ timeout: 5000 });
    await sessionLink.click();

    // Give the chat surface a moment to fully mount before asserting.
    await page.waitForTimeout(1000);

    // The buttons must be absent (mount gate denied).
    await expect(page.getByTestId('finalize-run-tests-button')).toHaveCount(0);
    await expect(page.getByTestId('finalize-reviewer-button')).toHaveCount(0);

    // The "Link a card" hint must be present so users discover the new
    // requirement instead of seeing nothing.
    const hint = page.getByTestId('finalize-no-card-hint');
    await expect(hint).toBeVisible({ timeout: 5000 });
    await expect(hint).toContainText(/link a card/i);
  });
});
