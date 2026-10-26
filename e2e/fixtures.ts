/**
 * Playwright test fixtures for Agent Hub E2E tests.
 *
 * Provides helpers for seeding data via the REST API and interacting with
 * the WebSocket layer.  All seed functions hit the backend directly so
 * tests start with known state.
 */

import {
  test as base,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const SERVER_PORT = process.env.E2E_SERVER_PORT || 4051;
const API_BASE = `http://localhost:${SERVER_PORT}`;

type JsonRecord = Record<string, unknown>;
type SeedOverrides = JsonRecord;

export interface SeedProject {
  id: string;
  name: string;
  cwd?: string;
  color?: string;
}

export interface SeedAgent {
  id: string;
  name: string;
  projectId: string;
  engine?: string;
}

export interface SeedSession {
  id: string;
  name?: string;
}

export interface SeedCard {
  id: string;
  title: string;
  columnId?: string;
}

export interface SeedWikiPage {
  id: string;
  title: string;
}

// First-run auth

const OWNER_EMAIL = 'e2e-owner@example.com';
const OWNER_PASSWORD = 'e2e-owner-password-123';
// Playwright starts a new worker after every failed test. Sharing the token
// keeps those restarts from tripping the server's per-IP login rate limit.
const AUTH_CACHE = path.join(os.tmpdir(), `agent-hub-e2e-auth-${SERVER_PORT}.json`);

export interface HubAuth {
  token: string;
  expiresAt: string | null;
  user: unknown;
}

/**
 * A fresh Hub shows the "Create your Hub account" wizard over the whole app
 * until an Owner exists, and every API route needs a token after that. Create
 * the Owner on first use (or sign in when an earlier worker already did) so
 * specs start on the normal UI.
 */
async function ensureOwner(): Promise<HubAuth> {
  const ctx = await playwrightRequest.newContext();
  try {
    try {
      const cached = JSON.parse(readFileSync(AUTH_CACHE, 'utf-8')) as HubAuth;
      const me = await ctx.get(`${API_BASE}/api/auth/me`, {
        headers: { authorization: `Bearer ${cached.token}` },
      });
      if (me.ok()) return cached;
    } catch {
      // No cache yet, or it belongs to an earlier server.
    }
    const credentials = { data: { email: OWNER_EMAIL, password: OWNER_PASSWORD } };
    // Setup status needs a token once an Owner exists, so try signing in first.
    let res = await ctx.post(`${API_BASE}/api/auth/login`, credentials);
    if (!res.ok()) res = await ctx.post(`${API_BASE}/api/auth/setup`, credentials);
    expect(res.ok(), `Owner sign-in failed: ${await res.text()}`).toBeTruthy();
    const auth = (await res.json()) as HubAuth;
    const done = await ctx.post(`${API_BASE}/api/setup/complete`, {
      headers: { authorization: `Bearer ${auth.token}` },
    });
    expect(done.ok()).toBeTruthy();
    writeFileSync(AUTH_CACHE, JSON.stringify(auth));
    return auth;
  } finally {
    await ctx.dispose();
  }
}

// API helpers (used in fixtures and tests)

let _counter = 0;
function uid(prefix = 'e2e') {
  return `${prefix}-${Date.now()}-${++_counter}`;
}

/**
 * Seed a project via the REST API.
 */
async function seedProject(request: APIRequestContext, overrides: SeedOverrides = {}) {
  const id = (overrides.id as string | undefined) || uid('proj');
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
  return res.json() as Promise<SeedProject>;
}

/**
 * Seed an agent under a project via the REST API.
 */
async function seedAgent(request: APIRequestContext, overrides: SeedOverrides = {}) {
  let projectId = overrides.projectId as string | undefined;
  if (!projectId) {
    const project = await seedProject(request);
    projectId = project.id;
  }
  const id = (overrides.id as string | undefined) || uid('agent');
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
  return res.json() as Promise<SeedAgent>;
}

/**
 * Seed a session for an agent.
 */
async function seedSession(
  request: APIRequestContext,
  agentId: string,
  overrides: SeedOverrides = {},
) {
  const res = await request.post(`${API_BASE}/api/agents/${agentId}/sessions`, {
    data: {
      name: overrides.name || 'E2E Session',
      ...overrides,
    },
  });
  expect(res.ok()).toBeTruthy();
  return res.json() as Promise<SeedSession>;
}

/**
 * Seed a kanban board card for a project.
 */
async function seedCard(
  request: APIRequestContext,
  projectId: string,
  overrides: SeedOverrides = {},
) {
  let columnId = overrides.columnId as string | undefined;
  if (!columnId) {
    const boardRes = await request.get(`${API_BASE}/api/projects/${projectId}/board`);
    const board = (await boardRes.json()) as { columns?: Array<{ id?: string }> };
    columnId = board.columns?.[0]?.id;
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
  return res.json() as Promise<SeedCard>;
}

/**
 * Seed a wiki page for a project.
 */
async function seedWikiPage(
  request: APIRequestContext,
  projectId: string,
  overrides: SeedOverrides = {},
) {
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
  return res.json() as Promise<SeedWikiPage>;
}

type SeedHelpers = {
  project: (overrides?: SeedOverrides) => Promise<SeedProject>;
  agent: (overrides?: SeedOverrides) => Promise<SeedAgent>;
  session: (agentId: string, overrides?: SeedOverrides) => Promise<SeedSession>;
  card: (projectId: string, overrides?: SeedOverrides) => Promise<SeedCard>;
  wikiPage: (projectId: string, overrides?: SeedOverrides) => Promise<SeedWikiPage>;
};

type SeededAppFixture = {
  project: SeedProject;
  agent: SeedAgent;
  page: Page;
};

type AgentHubFixtures = {
  seed: SeedHelpers;
  seededApp: SeededAppFixture;
};

type AgentHubWorkerFixtures = {
  hubAuth: HubAuth;
};

// Extended test fixture

export const test = base.extend<AgentHubFixtures, AgentHubWorkerFixtures>({
  hubAuth: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use(await ensureOwner());
    },
    { scope: 'worker' },
  ],

  // `request` and `page.request` both send the Owner token.
  extraHTTPHeaders: async ({ hubAuth }, use) => {
    await use({ authorization: `Bearer ${hubAuth.token}` });
  },

  // The web app reads its session from localStorage before the first fetch.
  page: async ({ page, hubAuth }, use) => {
    await page.addInitScript((record) => {
      localStorage.setItem('agent-hub-jwt', JSON.stringify(record));
    }, hubAuth);
    await use(page);
  },

  /**
   * Seed helpers bound to the current request context.
   * Usage: const project = await seed.project({ name: 'My Project' });
   */
  seed: async ({ request }, use) => {
    await use({
      project: (overrides?: SeedOverrides) => seedProject(request, overrides),
      agent: (overrides?: SeedOverrides) => seedAgent(request, overrides),
      session: (agentId: string, overrides?: SeedOverrides) =>
        seedSession(request, agentId, overrides),
      card: (projectId: string, overrides?: SeedOverrides) =>
        seedCard(request, projectId, overrides),
      wikiPage: (projectId: string, overrides?: SeedOverrides) =>
        seedWikiPage(request, projectId, overrides),
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
