import { test, expect } from '../fixtures.js';

/**
 * Experimental Autopilot setup + run controls (project-scoped view
 * `#/autopilot/<projectId>`). The server controller is exercised by Vitest;
 * here we mock the `/autopilot` REST surface so the UI states — opt-in,
 * reconnect (state survives a reload), and Stop → "Stopping…" — are
 * deterministic, following the route-mocking pattern in
 * `finalize-button.spec.ts`.
 *
 * `/api/auth/status` is stubbed to report `activeOrgIsLocal: true` so the
 * client treats the visitor as Admin-equivalent (same bypass Electron uses)
 * and renders the admin-only controls. The login gate stays suppressed
 * because `authConfigured` is false.
 */

const LIMITS = {
  cycleMode: 'continuous',
  maxCycles: null,
  maxWallTimeMs: 4 * 60 * 60 * 1000,
  maxStageTimeoutMs: 30 * 60 * 1000,
  maxRetriesPerStage: 2,
  maxCostUsd: null,
};

function readyConfig(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'p1',
    enabled: false,
    disabling: false,
    briefId: 'b1',
    brief: 'Build a todo app.',
    briefRevision: 1,
    target: {
      targetId: 'local',
      origin: 'http://127.0.0.1:8080',
      readinessProbeUrl: 'http://127.0.0.1:8080/health',
    },
    limits: LIMITS,
    credentialOwnerUserId: 'user-1',
    updatedAt: '2026-09-15T00:00:00.000Z',
    updatedBy: 'user-1',
    ...overrides,
  };
}

function runningRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    projectId: 'p1',
    controlState: 'running',
    stage: 'implementing',
    cycleNumber: 1,
    pauseReason: null,
    failureReason: null,
    lastVerifiedSha: 'abcdef1234567890',
    lastDeploymentId: 'dep-1',
    targetId: 'local',
    limits: LIMITS,
    usage: { wallTimeMs: 0, costUsd: null, costAvailable: false },
    startedBy: 'user-1',
    startedAt: '2026-09-15T00:00:00.000Z',
    stoppedAt: null,
    updatedAt: '2026-09-15T00:00:00.000Z',
    ...overrides,
  };
}

async function installAutopilotMocks(
  page: import('@playwright/test').Page,
  projectId: string,
  initial: any,
) {
  const bag = { state: initial, putCalls: [] as any[] };

  await page.route('**/api/auth/status', async (route) => {
    const upstream = await route.fetch();
    let body: any = {};
    try {
      body = await upstream.json();
    } catch {
      /* ignore */
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...body, authConfigured: false, activeOrgIsLocal: true }),
    });
  });

  await page.route(`**/api/projects/${projectId}/autopilot`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(bag.state),
    });
  });

  await page.route(`**/api/projects/${projectId}/autopilot/config`, async (route) => {
    bag.putCalls.push(route.request().postDataJSON());
    bag.state = { ...bag.state, config: readyConfig({ enabled: true }) };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(bag.state.config),
    });
  });

  await page.route(`**/api/projects/${projectId}/autopilot/stop`, async (route) => {
    if (bag.state.activeRun) {
      bag.state = {
        ...bag.state,
        activeRun: {
          ...bag.state.activeRun,
          run: { ...bag.state.activeRun.run, controlState: 'stopping' },
        },
      };
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(bag.state.activeRun),
    });
  });

  return bag;
}

test.describe('Experimental Autopilot', () => {
  test('opts in by enabling from the setup form', async ({ page, seed }) => {
    const project = await seed.project({ name: 'Autopilot E2E opt-in' });
    const bag = await installAutopilotMocks(page, project.id, {
      serverEnabled: true,
      config: readyConfig({ projectId: project.id }),
      activeRun: null,
    });

    await page.goto(`/#/autopilot/${project.id}`);
    await expect(page.getByTestId('autopilot-section')).toBeVisible();
    const enable = page.getByTestId('autopilot-enable-toggle');
    await expect(enable).toBeVisible();
    await enable.click();

    await expect.poll(() => bag.putCalls.length, { timeout: 5000 }).toBeGreaterThan(0);
    expect(bag.putCalls[0].enabled).toBe(true);
    // Once enabled, the opt-in button is gone.
    await expect(page.getByTestId('autopilot-enable-toggle')).toHaveCount(0);
  });

  test('reconnect refetches changed server state on the mounted client', async ({ page, seed }) => {
    const project = await seed.project({ name: 'Autopilot E2E reconnect' });
    const bag = await installAutopilotMocks(page, project.id, {
      serverEnabled: true,
      config: readyConfig({ projectId: project.id, enabled: true }),
      activeRun: { run: runningRun({ projectId: project.id }), cycle: null },
    });

    await page.goto(`/#/autopilot/${project.id}`);
    await expect(page.getByTestId('autopilot-run-state')).toContainText('Running');

    // Server progresses the run while the client is mounted; a WS reconnect
    // (not a reload) refetches the authoritative state and the UI updates.
    bag.state = {
      serverEnabled: true,
      config: readyConfig({ projectId: project.id, enabled: true }),
      activeRun: {
        run: runningRun({ projectId: project.id, controlState: 'paused', stage: null }),
        cycle: null,
      },
    };
    await page.evaluate(() => window.dispatchEvent(new Event('agenthub:ws_reconnected')));

    await expect(page.getByTestId('autopilot-run-state')).toContainText('Paused');
  });

  test('Stop stays stopping until settlement, then renders the settled state', async ({
    page,
    seed,
  }) => {
    const project = await seed.project({ name: 'Autopilot E2E stop' });
    const bag = await installAutopilotMocks(page, project.id, {
      serverEnabled: true,
      config: readyConfig({ projectId: project.id, enabled: true }),
      activeRun: { run: runningRun({ projectId: project.id }), cycle: null },
    });

    page.on('dialog', (dialog) => dialog.accept());

    await page.goto(`/#/autopilot/${project.id}`);
    const stop = page.getByTestId('autopilot-stop');
    await expect(stop).toContainText('Stop');
    await stop.click();

    // Stop flips the mocked run to `stopping`; the button holds the settling
    // label and is disabled until cancellation completes.
    await expect(page.getByTestId('autopilot-stop')).toContainText('Stopping', { timeout: 8000 });
    await expect(page.getByTestId('autopilot-stopping')).toBeVisible();
    await expect(page.getByTestId('autopilot-stop')).toBeDisabled();

    // Cancellation settles: the run is gone. A reconnect refetch renders the
    // settled UI (no active run, no Stop control).
    bag.state = {
      serverEnabled: true,
      config: readyConfig({ projectId: project.id, enabled: true }),
      activeRun: null,
    };
    await page.evaluate(() => window.dispatchEvent(new Event('agenthub:ws_reconnected')));

    await expect(page.getByTestId('autopilot-run')).toHaveCount(0);
    await expect(page.getByTestId('autopilot-stop')).toHaveCount(0);
  });
});
