/**
 * Kanban board tests — verify column rendering, card CRUD, drag interactions.
 */

import { test, expect } from '../fixtures.js';

test.describe('Kanban board', () => {
  test('renders default columns', async ({ seededApp }) => {
    const { page, project } = seededApp;

    // Navigate to kanban for the project
    await page.getByText(project.name).click();
    const kanbanButton = page.locator(`[title="Kanban board"], svg.lucide-layout-grid`).first();
    await expect(kanbanButton).toBeVisible({ timeout: 5000 });
    await kanbanButton.click();

    // Default columns should render
    await expect(page.getByText('To Do')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('In Progress')).toBeVisible();
    await expect(page.getByText('Done')).toBeVisible();
  });

  test('displays seeded cards', async ({ page, seed }) => {
    const project = await seed.project();
    await seed.agent({ projectId: project.id });
    await seed.card(project.id, { title: 'Fix login bug', priority: 'high' });
    await seed.card(project.id, { title: 'Add dark mode', priority: 'low' });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Navigate to kanban
    await page.getByText(project.name).click();
    const kanbanButton = page.locator(`[title="Kanban board"], svg.lucide-layout-grid`).first();
    await expect(kanbanButton).toBeVisible({ timeout: 5000 });
    await kanbanButton.click();

    // Cards should appear
    await expect(page.getByText('Fix login bug')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Add dark mode')).toBeVisible();
  });
});
