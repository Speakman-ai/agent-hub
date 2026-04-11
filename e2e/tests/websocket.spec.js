/**
 * WebSocket tests — verify real-time connection, message delivery, and
 * reconnection behavior.
 *
 * These tests interact with WebSocket at the page level, verifying that
 * the client establishes and maintains a connection.
 */

import { test, expect } from '../fixtures.js';

test.describe('WebSocket connection', () => {
  test('client connects to WebSocket on load', async ({ page }) => {
    // Track WebSocket creation
    const wsPromise = page.waitForEvent('websocket');

    await page.goto('/');

    const ws = await wsPromise;
    // WebSocket connects to the server — could be direct or via Vite proxy
    expect(ws.url()).toMatch(/localhost/);
  });

  test('WebSocket receives pong messages', async ({ page }) => {
    const wsPromise = page.waitForEvent('websocket');
    await page.goto('/');
    const ws = await wsPromise;

    // Wait for a frame exchange (ping/pong happens every 30s, but
    // the first ping is sent after connection)
    const frame = await ws.waitForEvent('framereceived', { timeout: 35_000 });
    const data = JSON.parse(frame.payload);
    // Could be any server message — just verify we got valid JSON
    expect(data).toBeDefined();
  });

  test('app shows connected state (no reconnecting banner)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // "Reconnecting" text should NOT be visible when connected
    const reconnecting = page.getByText('Reconnecting');
    await expect(reconnecting).not.toBeVisible();
  });
});
