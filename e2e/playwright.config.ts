import { defineConfig, devices } from '@playwright/test';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';

/**
 * Playwright E2E test configuration for Agent Hub.
 *
 * Uses ports 4050 (Vite) and 4051 (Express) to avoid conflicts with the
 * production server running on 3050/3051.
 *
 * NOTE: We do NOT set AGENT_HUB_TEST_MODE because that prevents
 * server.listen(). The E2E server needs to listen on a real port.
 * Side-effects (crons, heartbeats, Slack) are harmless with an empty
 * data directory and no configured agents.
 */

const SERVER_PORT = Number(process.env.E2E_SERVER_PORT) || 4051;
const CLIENT_PORT = Number(process.env.E2E_CLIENT_PORT) || 4050;
const DATA_DIR = path.join(os.tmpdir(), 'agent-hub-e2e-data');

// Ensure the data directory exists before the webServer processes start.
// Playwright starts webServers before globalSetup, so we prepare here.
mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(path.join(DATA_DIR, 'projects.json'))) {
  writeFileSync(path.join(DATA_DIR, 'projects.json'), '[]');
}

export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // run tests sequentially — they share a single server
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'on-failure' }]],

  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
    actionTimeout: 10_000,
  },

  globalTeardown: './global-teardown.ts',

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Uncomment to add more browsers:
    // { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    // { name: 'webkit',  use: { ...devices['Desktop Safari'] } },
  ],

  /* Start both servers before tests run.
   * NOTE: env spreads process.env to inherit PATH, HOME, etc. */
  webServer: [
    {
      command: `npx tsx index.ts`,
      cwd: '../server',
      port: SERVER_PORT,
      reuseExistingServer: !process.env.CI,
      env: {
        ...process.env,
        AGENT_HUB_PORT: String(SERVER_PORT),
        AGENT_HUB_DATA_DIR: DATA_DIR,
        AGENT_HUB_API_KEY: '', // disable auth for E2E tests
        // Swap the real template + github executors for the deterministic
        // stub (see server/routes/provisioning.ts). Keeps the new-project
        // happy-path e2e under a few seconds — no npm install, no gh CLI,
        // no shell commands against the workspace tree.
        AGENT_HUB_PROVISIONING_STUB: '1',
      },
      timeout: 30_000,
    },
    {
      command: `npx vite --port ${CLIENT_PORT}`,
      cwd: '../client',
      port: CLIENT_PORT,
      reuseExistingServer: !process.env.CI,
      env: {
        ...process.env,
        VITE_API_PORT: String(SERVER_PORT),
      },
      timeout: 30_000,
    },
  ],
});
