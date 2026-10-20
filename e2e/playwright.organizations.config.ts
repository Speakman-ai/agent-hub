import { defineConfig, devices } from '@playwright/test';

/**
 * Organization acceptance flow (`npm run test:e2e:organizations`).
 *
 * Kept apart from the main E2E config because organizations need real signed-in users: the
 * main suite disables auth, and organization routes refuse callers without a user id. The
 * spec starts its own Hub through organizations/hub-server.ts (isolated ports, data
 * directory, HOME and environment, fake agent CLIs) so it can restart it mid-flow. Only the
 * Vite client runs as a webServer, proxying to that Hub.
 */

const SERVER_PORT = Number(process.env.E2E_ORG_SERVER_PORT) || 4061;
const CLIENT_PORT = Number(process.env.E2E_ORG_CLIENT_PORT) || 4060;

export default defineConfig({
  testDir: './organizations',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 300_000,
  expect: { timeout: 15_000 },
  reporter: [
    [process.env.CI ? 'github' : 'list'],
    ['html', { open: 'never', outputFolder: 'playwright-report-organizations' }],
  ],
  outputDir: 'test-results-organizations',
  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite --port ${CLIENT_PORT} --strictPort`,
    cwd: '../client',
    port: CLIENT_PORT,
    reuseExistingServer: false,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      VITE_API_PORT: String(SERVER_PORT),
    },
    timeout: 60_000,
  },
});
