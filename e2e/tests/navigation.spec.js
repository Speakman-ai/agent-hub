/**
 * Navigation tests — verify sidebar links and view switching.
 */

import { test, expect } from '../fixtures.js';

test.describe('Sidebar navigation', () => {
  test('navigates to Settings view', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.getByText('Settings').click();
    await expect(page.getByText('General')).toBeVisible();
  });

  test('navigates to Skills view', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.getByText('Skills').click();
    await expect(page.locator('text=Skills')).toBeVisible();
  });

  test('navigates to Kanban board for a project', async ({ seededApp }) => {
    const { page, project } = seededApp;
    await page.getByText(project.name).click();
    const kanbanButton = page.locator(`[title="Kanban board"], svg.lucide-layout-grid`).first();
    await expect(kanbanButton).toBeVisible({ timeout: 5000 });
    await kanbanButton.click();
    await expect(page.getByText('Backlog')).toBeVisible({ timeout: 5000 });
  });

  test('navigates to Wiki for a project', async ({ seededApp }) => {
    const { page, project } = seededApp;
    await page.getByText(project.name).click();
    const wikiLink = page.getByText('Wiki').first();
    await wikiLink.click();
    await expect(page.getByText('Wiki').first()).toBeVisible();
  });
});
