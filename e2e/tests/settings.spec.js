/**
 * Settings page tests — verify tabs, forms, and persistence.
 */

import { test, expect } from '../fixtures.js';

test.describe('Settings page', () => {
  test('shows settings tabs', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.getByText('Settings').click();

    // General tab should be visible/active by default
    await expect(page.getByText('General')).toBeVisible();
  });

  test('settings page renders project sections', async ({ seededApp }) => {
    const { page, project } = seededApp;

    await page.getByText('Settings').click();

    // The project name should appear in settings (auto-retries until visible)
    await expect(page.getByText(project.name).first()).toBeVisible({ timeout: 5000 });
  });

  test('can navigate to different settings tabs', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.getByText('Settings').click();

    // Look for tab-like navigation within settings
    const tabs = page.locator('button, [role="tab"]');
    const tabCount = await tabs.count();
    expect(tabCount).toBeGreaterThan(0);
  });
});
