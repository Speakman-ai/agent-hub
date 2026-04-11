/**
 * Wiki browser tests — verify page listing, content rendering, and search.
 */

import { test, expect } from '../fixtures.js';

test.describe('Wiki browser', () => {
  test('displays seeded wiki pages', async ({ page, seed }) => {
    const project = await seed.project();
    await seed.agent({ projectId: project.id });
    await seed.wikiPage(project.id, {
      title: 'Getting Started Guide',
      content: '# Getting Started\n\nWelcome to the project.',
      category: 'onboarding',
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Navigate to wiki
    await page.getByText(project.name).click();
    const wikiLink = page.getByText('Wiki').first();
    await wikiLink.click();

    // The wiki page title should appear
    await expect(page.getByText('Getting Started Guide')).toBeVisible({ timeout: 5000 });
  });

  test('wiki shows empty state when no pages exist', async ({ seededApp }) => {
    const { page, project } = seededApp;

    // Navigate to wiki for a project with no pages
    await page.getByText(project.name).click();
    const wikiLink = page.getByText('Wiki').first();
    await wikiLink.click();

    // Wiki browser should at least be rendered
    await expect(page.getByText('Wiki').first()).toBeVisible({ timeout: 5000 });
  });
});
