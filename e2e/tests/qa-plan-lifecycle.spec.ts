/**
 * QA validation loop, end to end: a human approves a plan, starts a run, the
 * QA agent's results come back, a failing case files a finding card, a
 * failed-only rerun passes, and the human signs off.
 *
 * The QA agent is played by this spec over REST (the same calls `qa.sh`
 * makes). The run session the server spawns talks to fake-agent-cli.sh, so no
 * model and no browser traffic to the target are involved.
 */

import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures.js';

const API_BASE = `http://localhost:${process.env.E2E_SERVER_PORT || 4051}`;

type QaRun = { id: string; iteration: number; status: string; scope: string };
type QaDetail = {
  plan: { id: string; status: string; approved: boolean };
  cases: Array<{ id: string; title: string }>;
  runs: Array<QaRun & { results: Array<{ caseId: string; findingCardId: string | null }> }>;
  signOffBlocker: string | null;
};

async function planDetail(request: APIRequestContext, projectId: string, planId: string) {
  const res = await request.get(`${API_BASE}/api/projects/${projectId}/qa/plans/${planId}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as QaDetail;
}

/** Wait for the run the UI just started to be running, then return it. */
async function runningRun(request: APIRequestContext, projectId: string, planId: string) {
  let run: QaRun | undefined;
  await expect
    .poll(
      async () => {
        run = (await planDetail(request, projectId, planId)).runs.find(
          (r) => r.status === 'running',
        );
        return run?.id ?? null;
      },
      { timeout: 15_000 },
    )
    .not.toBeNull();
  return run!;
}

/** What the QA agent posts with `qa.sh result post` after checking one case. */
async function postResult(
  request: APIRequestContext,
  projectId: string,
  planId: string,
  runId: string,
  body: { caseId: string; verdict: string; actual: string },
) {
  const res = await request.post(
    `${API_BASE}/api/projects/${projectId}/qa/plans/${planId}/runs/${runId}/results`,
    { data: body },
  );
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as { run: QaRun };
}

async function openQaPage(page: Page, projectId: string, projectName: string) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const qaLink = page.getByTestId(`sidebar-qa-link-${projectId}`);
  const planning = page.getByTestId(`sidebar-nav-group-planning-${projectId}`);
  if (!(await planning.isVisible())) await page.getByText(projectName).first().click();
  if (!(await qaLink.isVisible())) await planning.click();
  await qaLink.click();
  await expect(page.getByTestId('qa-page')).toBeVisible({ timeout: 10_000 });
}

test.describe('QA plan lifecycle', () => {
  test('approve, run, file a finding, rerun failed, sign off', async ({ page, request, seed }) => {
    test.setTimeout(90_000);
    const project = await seed.project();
    await seed.agent({ projectId: project.id, name: 'QA E2E Dev', role: 'dev' });
    // Projects created through the API without a primary agent skip QA
    // seeding, so add the project's QA agent the way a user would.
    await seed.agent({ projectId: project.id, name: 'QA E2E Agent', role: 'qa' });

    // Plan and cases: what the New QA plan dialog and the authoring chat produce.
    const planRes = await request.post(`${API_BASE}/api/projects/${project.id}/qa/plans`, {
      data: {
        title: 'Checkout smoke',
        targetUrl: 'https://example.com/checkout',
        goal: 'Cart and payment work',
        autoRerun: false,
      },
    });
    expect(planRes.status()).toBe(201);
    const planId = ((await planRes.json()) as { plan: { id: string } }).plan.id;
    for (const c of [
      { title: 'Cart shows items', steps: 'Open /cart', expected: 'Two items listed' },
      { title: 'Pay button submits', steps: 'Click Pay', expected: 'Receipt page' },
    ]) {
      const res = await request.post(
        `${API_BASE}/api/projects/${project.id}/qa/plans/${planId}/cases`,
        { data: c },
      );
      expect(res.status()).toBe(201);
    }
    const [cartCase, payCase] = (await planDetail(request, project.id, planId)).cases;

    await openQaPage(page, project.id, project.name);
    await expect(page.getByTestId(`qa-plan-row-${planId}`)).toBeVisible();
    await page.getByTestId(`qa-plan-open-${planId}`).first().click();

    // Runs are refused until a human approves.
    await expect(page.getByTestId('qa-start-run')).toBeDisabled();
    await page.getByTestId('qa-approve').click();
    await expect(page.getByTestId('qa-revoke-approval')).toBeVisible();

    await page.getByTestId('qa-start-run').click();
    const first = await runningRun(request, project.id, planId);
    expect(first.scope).toBe('full');

    await postResult(request, project.id, planId, first.id, {
      caseId: cartCase.id,
      verdict: 'pass',
      actual: 'Two items listed',
    });
    const finished = await postResult(request, project.id, planId, first.id, {
      caseId: payCase.id,
      verdict: 'fail',
      actual: 'Pay button does nothing',
    });
    expect(finished.run.status).toBe('failed');

    // The server files a qa-finding card for the failing case.
    const findingCardId = (await planDetail(request, project.id, planId)).runs
      .find((r) => r.id === first.id)!
      .results.find((r) => r.caseId === payCase.id)!.findingCardId;
    expect(findingCardId).toBeTruthy();
    const board = (await (
      await request.get(`${API_BASE}/api/projects/${project.id}/board`)
    ).json()) as { cards: Array<{ id: string; title: string; labels?: unknown }> };
    const finding = board.cards.find((c) => c.id === findingCardId);
    expect(finding?.title).toBe('QA: Pay button submits');
    expect(JSON.stringify(finding?.labels ?? '')).toContain('qa-finding');

    const firstRow = page.getByTestId(`qa-run-row-${first.id}`);
    await expect(firstRow.getByTestId('qa-run-status')).toHaveText(/failed/i, { timeout: 10_000 });
    await expect(
      page.getByTestId(`qa-result-${payCase.id}`).getByTestId('qa-result-finding'),
    ).toBeVisible();
    await expect(page.getByTestId('qa-sign-off')).toBeDisabled();

    // Fix landed: rerun only what failed, and the agent reports a pass.
    await page.getByTestId('qa-rerun-failed').click();
    const second = await runningRun(request, project.id, planId);
    expect(second.iteration).toBe(2);
    expect(second.scope).toBe('failed_only');
    const passed = await postResult(request, project.id, planId, second.id, {
      caseId: payCase.id,
      verdict: 'pass',
      actual: 'Receipt page shown',
    });
    expect(passed.run.status).toBe('passed');

    // Sign-off opens only now, and records the human validation.
    const signOff = page.getByTestId('qa-sign-off');
    await expect(signOff).toBeEnabled({ timeout: 10_000 });
    page.once('dialog', (d) => void d.accept());
    await signOff.click();
    await expect(page.getByTestId('qa-detail-signed-off')).toBeVisible({ timeout: 10_000 });

    const done = await planDetail(request, project.id, planId);
    expect(done.plan.status).toBe('done');
    expect(done.runs).toHaveLength(2);
  });
});
