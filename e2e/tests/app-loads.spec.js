/**
 * Smoke tests — verify the app boots, connects to WebSocket, and renders
 * the core layout.
 */

import { test, expect } from '../fixtures.js';

test.describe('App loading', () => {
  test('renders the main layout', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Sidebar should be present (desktop)
    const sidebar = page.locator('.sidebar-container');
    await expect(sidebar).toBeVisible();

    // Settings nav item should exist
    await expect(page.getByText('Settings')).toBeVisible();
  });

  test('establishes WebSocket connection', async ({ page }) => {
    // Listen for the WS connection indicator
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // The TopBar shows a green dot when connected — look for the connected state
    // The connection indicator is rendered in the TopBar component
    // Verify no "Reconnecting" banner is showing (auto-retries until actionTimeout)
    await expect(page.getByText('Reconnecting')).not.toBeVisible();
  });

  test('shows empty chat state when no agent selected', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // "Start a conversation" prompt should be visible
    await expect(page.getByText('Start a conversation')).toBeVisible();
  });
});
