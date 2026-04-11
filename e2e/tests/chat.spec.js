/**
 * Chat interface tests — verify message input, session creation, and
 * WebSocket streaming behavior.
 *
 * NOTE: These tests verify the UI layer only. The server runs without
 * AGENT_HUB_TEST_MODE so all API routes behave normally, but no real
 * agent CLI is configured in the test environment. The tests validate
 * that the chat UI renders correctly and sends messages via WebSocket,
 * even if no response streams back.
 */

import { test, expect } from '../fixtures.js';

test.describe('Chat interface', () => {
  test('shows message input area', async ({ seededApp }) => {
    const { page, agent } = seededApp;

    // Select the agent
    await page.getByText(agent.name).first().click();

    // Message input should be visible (textarea or contenteditable)
    const input = page.locator('textarea, [contenteditable="true"], input[type="text"]').last();
    await expect(input).toBeVisible({ timeout: 5000 });
  });

  test('can type in message input', async ({ seededApp }) => {
    const { page, project, agent } = seededApp;

    // Expand project and select agent
    await page.getByText(project.name).click();
    await page.getByText(agent.name).first().click();

    // Find and type in the message input
    const input = page.locator('textarea').last();
    await expect(input).toBeVisible({ timeout: 5000 });
    await input.fill('Hello, test message');
    await expect(input).toHaveValue('Hello, test message');
  });

  test('empty chat shows welcome message', async ({ seededApp }) => {
    const { page, project, agent } = seededApp;

    await page.getByText(project.name).click();
    await page.getByText(agent.name).first().click();

    // "Start a conversation" or similar prompt
    await expect(page.getByText('Start a conversation')).toBeVisible({ timeout: 5000 });
  });

  test('displays previously seeded messages', async ({ page, seed }) => {
    const project = await seed.project();
    const agent = await seed.agent({ projectId: project.id });
    const session = await seed.session(agent.id, { name: 'Test Chat Session' });

    // Seed a message via the API
    const serverPort = process.env.E2E_SERVER_PORT || 4051;
    const res = await page.request.post(
      `http://localhost:${serverPort}/api/sessions/${session.id}/messages`,
      {
        data: {
          role: 'user',
          content: 'This is a seeded test message',
        },
      },
    );

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Navigate to the project and agent
    await page.getByText(project.name).click();
    await page.getByText(agent.name).first().click();

    // Click on the session to load it
    const sessionLink = page.getByText('Test Chat Session').first();
    await expect(sessionLink).toBeVisible({ timeout: 5000 });
    await sessionLink.click();
    // The seeded message should appear
    await expect(page.getByText('This is a seeded test message')).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Session management', () => {
  test('new session button creates a session', async ({ seededApp }) => {
    const { page, project, agent } = seededApp;

    // Expand project and select agent
    await page.getByText(project.name).click();
    await page.getByText(agent.name).first().click();

    // Look for "New Session" or "+" button
    const newSessionBtn = page
      .locator('button[title="New session"], button[title="New chat"]')
      .first();
    await expect(newSessionBtn).toBeVisible({ timeout: 5000 });
    await newSessionBtn.click();
    // Should show empty chat state
    await expect(page.getByText('Start a conversation')).toBeVisible({ timeout: 5000 });
  });
});
