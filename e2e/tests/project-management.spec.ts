/**
 * Project management tests — creating projects, viewing agents, sessions.
 */

import { test, expect } from '../fixtures.js';

test.describe('Project management', () => {
  test('seeded project appears in sidebar', async ({ seededApp }) => {
    const { page, project } = seededApp;
    await expect(page.getByText(project.name)).toBeVisible();
  });

  test('seeded agent appears under project', async ({ seededApp }) => {
    const { page, project, agent } = seededApp;
    // Expand the project
    await page.getByText(project.name).click();
    await expect(page.getByText(agent.name)).toBeVisible();
  });

  test('can create a new session for an agent', async ({ seededApp }) => {
    const { page, project, agent } = seededApp;

    // Expand the project to show agent
    await page.getByText(project.name).click();

    // Click the agent to select it
    await page.getByText(agent.name).click();

    // Empty chat state should show
    await expect(page.getByText('Start a conversation')).toBeVisible({ timeout: 5000 });
  });

  test('Open Project button is visible', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // "Open Project" or "+" button should exist in sidebar
    const openProjectBtn = page.locator('button[title="Open project"]').first();
    const plusBtn = page.locator('text=Open Project').first();
    const isVisible = (await openProjectBtn.isVisible()) || (await plusBtn.isVisible());
    expect(isVisible).toBeTruthy();
  });
});

test.describe('Multiple projects', () => {
  test('shows multiple projects in sidebar', async ({ page, seed }) => {
    await seed.project({ name: 'Alpha Project' });
    await seed.project({ name: 'Beta Project' });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await expect(page.getByText('Alpha Project')).toBeVisible();
    await expect(page.getByText('Beta Project')).toBeVisible();
  });
});
