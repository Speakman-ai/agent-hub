/* global window */
/**
 * E2E happy-path for Settings → Integrations.
 *
 * The OAuth handshake is mocked at the HTTP layer (Playwright's
 * `page.route`) so we don't need a real Nango instance:
 *  - GET  /api/integrations/supported  → fixed catalogue
 *  - GET  /api/users/:id/integrations  → starts empty, then 1 CONNECTED
 *  - POST /api/users/:id/integrations/:app/connect → returns authUrl
 *  - GET  /api/users/:id/integrations/:app → starts 404, then PENDING,
 *    then CONNECTED after we simulate the popup-success postMessage.
 *
 * Flow under test:
 *  1. Open Settings → Integrations
 *  2. Verify the catalogue rows render
 *  3. Click Connect on Slack → server returns authUrl, popup is opened
 *  4. Simulate the popup-success postMessage
 *  5. Row flips to Active without a hard refresh
 */

import { test, expect } from '@playwright/test';

const USER_ID = 'e2e-user';

const SUPPORTED = {
  integrations: [
    { id: 'slack', label: 'Slack', description: 'Slack desc', category: 'communication' },
    { id: 'github', label: 'GitHub', description: 'GitHub desc', category: 'developer' },
  ],
  providerReady: true,
};

test('Integrations: Connect → popup success → row goes Active without reload', async ({ page }) => {
  let slackStatus = 'NONE'; // NONE → PENDING → CONNECTED

  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: { id: USER_ID, username: 'e2e', role: 'Owner' } }),
    }),
  );
  await page.route('**/api/integrations/supported', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SUPPORTED) }),
  );
  await page.route(`**/api/users/${USER_ID}/integrations`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        integrations: slackStatus === 'CONNECTED' ? [{ app: 'slack', status: 'CONNECTED' }] : [],
      }),
    }),
  );
  await page.route(`**/api/users/${USER_ID}/integrations/slack`, (route) => {
    if (slackStatus === 'NONE') return route.fulfill({ status: 404, body: '{}' });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ app: 'slack', status: slackStatus }),
    });
  });
  await page.route(`**/api/users/${USER_ID}/integrations/slack/connect`, (route) => {
    slackStatus = 'PENDING';
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ authUrl: 'about:blank', connectionId: 'conn-1' }),
    });
  });

  // Stub window.open so the test doesn't try to open a popup.
  await page.addInitScript(() => {
    window.open = () => ({ closed: false, close: () => {} });
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByText('Settings').click();
  await page.getByRole('button', { name: /Integrations/ }).first().click();

  await expect(page.getByText('Slack')).toBeVisible();
  await expect(page.getByText('GitHub')).toBeVisible();

  await page.getByTestId('connect-slack').click();

  // Flip the mocked status BEFORE we dispatch postMessage so the
  // refetch the page kicks off in response sees CONNECTED.
  slackStatus = 'CONNECTED';
  await page.evaluate(() => {
    window.postMessage(
      { type: 'agent-hub:integration:result', app: 'slack', status: 'success' },
      window.location.origin,
    );
  });

  // Row pivots to "Disconnect" once the refetch reports CONNECTED — no
  // page reload required.
  await expect(page.getByTestId('disconnect-slack')).toBeVisible({ timeout: 10_000 });
});
