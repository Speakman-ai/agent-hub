/**
 * Playwright test fixtures for Agent Hub E2E tests.
 *
 * Provides helpers for seeding data via the REST API and interacting with
 * the WebSocket layer.  All seed functions hit the backend directly so
 * tests start with known state.
 */

import { test as base, expect } from '@playwright/test';

const SERVER_PORT = process.env.E2E_SERVER_PORT || 4051;
const API_BASE = `http://localhost:${SERVER_PORT}`;

// ─── API helpers (used in fixtures and tests) ──────────────────

let _counter = 0;
function uid(prefix = 'e2e') {
  return `${prefix}-${Date.now()}-${++_counter}`;
}

/**
 * Seed a project via the REST API.
 */
async function seedProject(request, overrides = {}) {
  const id = overrides.id || uid('proj');
  const res = await request.post(`${API_BASE}/api/projects`, {
    data: {
      id,
      name: overrides.name || `E2E Project ${id}`,
      cwd: overrides.cwd || '/tmp',
      color: overrides.color || '#3B82F6',
      ...overrides,
    },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/**
 * Seed an agent under a project via the REST API.
 */
async function seedAgent(request, overrides = {}) {
  let projectId = overrides.projectId;
  if (!projectId) {
    const project = await seedProject(request);
    projectId = project.id;
  }
  const id = overrides.id || uid('agent');
  const res = await request.post(`${API_BASE}/api/agents`, {
    data: {
      id,
      projectId,
      name: overrides.name || `E2E Agent ${id}`,
      engine: overrides.engine || 'claude-code',
      ...overrides,
    },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/**
 * Seed a session for an agent.
 */
async function seedSession(request, agentId, overrides = {}) {
  const res = await request.post(`${API_BASE}/api/agents/${agentId}/sessions`, {
    data: {
      name: overrides.name || 'E2E Session',
      ...overrides,
    },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/**
 * Seed a kanban board card for a project.
 */
async function seedCard(request, projectId, overrides = {}) {
  let columnId = overrides.columnId;
  if (!columnId) {
    const boardRes = await request.get(`${API_BASE}/api/projects/${projectId}/board`);
    const board = await boardRes.json();
    columnId = board.columns[0]?.id;
  }
  const res = await request.post(`${API_BASE}/api/projects/${projectId}/board/cards`, {
    data: {
      title: overrides.title || `E2E Card ${uid('card')}`,
      description: overrides.description || 'E2E test card',
      columnId,
      priority: overrides.priority || 'medium',
      ...overrides,
    },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/**
 * Seed a wiki page for a project.
 */
async function seedWikiPage(request, projectId, overrides = {}) {
  const res = await request.post(`${API_BASE}/api/projects/${projectId}/wiki`, {
    data: {
      title: overrides.title || `E2E Page ${uid('wiki')}`,
      content: overrides.content || '# Test Page\n\nE2E test content.',
      category: overrides.category || 'general',
      updatedBy: overrides.updatedBy || 'e2e-test',
      ...overrides,
    },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

// ─── Extended test fixture ─────────────────────────────────────

export const test = base.extend({
  /**
   * Seed helpers bound to the current request context.
   * Usage: const project = await seed.project({ name: 'My Project' });
   */
  seed: async ({ request }, use) => {
    await use({
      project: (overrides) => seedProject(request, overrides),
      agent: (overrides) => seedAgent(request, overrides),
      session: (agentId, overrides) => seedSession(request, agentId, overrides),
      card: (projectId, overrides) => seedCard(request, projectId, overrides),
      wikiPage: (projectId, overrides) => seedWikiPage(request, projectId, overrides),
    });
  },

  /**
   * Pre-seeded project + agent for tests that need a baseline.
   * Automatically creates a project and agent, then navigates to the app.
   */
  seededApp: async ({ page, request }, use) => {
    const project = await seedProject(request, { name: `Test Project ${uid('app')}` });
    const agent = await seedAgent(request, {
      projectId: project.id,
      name: `Test Agent ${uid('app')}`,
    });
    // Navigate and wait for the app to load
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await use({ project, agent, page });
  },
});

export { expect };
