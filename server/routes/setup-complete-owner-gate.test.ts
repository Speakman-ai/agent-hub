/**
 * Regression coverage for the Owner gate on `POST /api/setup/complete`.
 *
 * `onboardingComplete` is GLOBAL instance state: once it flips to true,
 * `GET /api/setup/status` stops telling the client to re-open SetupWizard.
 * The endpoint originally shipped ungated, so any authenticated caller who
 * could reach it — including an Admin or an ordinary User — could mark
 * onboarding finished and permanently strand an Owner whose first-run was
 * interrupted (password-manager kickout, mid-wizard reload) in the main
 * chrome with no route back to the wizard.
 *
 * The gate must reject non-Owners while still admitting every identity that
 * legitimately drives the wizard: a real Owner JWT, the local-bundled
 * Electron bypass, the global-apiKey break-glass, and the fresh-install
 * "no auth configured" mode (Owner role stamped with no user id).
 *
 * Same harness as projects-members.test.ts: mount the real projects router
 * in a bare Express app, stamp auth claims per request, and point
 * `config.dataDir` at a tmpdir so we can assert the DURABLE on-disk effect
 * rather than just the status code.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

vi.mock('../project-members-store.js', () => ({
  addProjectMember: vi.fn(),
  isProjectMember: vi.fn(() => false),
  isProjectRestricted: vi.fn(() => false),
  removeAllProjectMembers: vi.fn(() => 0),
  removeProjectMember: vi.fn(() => true),
  listProjectMembers: vi.fn(() => []),
  // Consumed by the real resolveVisibilityCaller — empty ACL so the
  // caller's role alone decides access.
  assignedProjectIdsForUser: vi.fn(() => new Set<string>()),
  restrictedProjectIds: vi.fn(() => new Set<string>()),
}));

vi.mock('../orgs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../orgs.js')>();
  return { ...actual, getActiveOrgId: vi.fn(() => 'default') };
});

const { default: createProjectRoutes } = await import('./projects.js');

interface Claims {
  authUserId?: string;
  authUser?: string;
  authRole?: 'Owner' | 'Admin' | 'User';
  authViaApiKey?: boolean;
  authLocalOrgBypass?: boolean;
}

function buildApp(claims: Claims) {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'agent-hub-setup-complete-'));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const areq = req as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(claims)) {
      if (value !== undefined) areq[key] = value;
    }
    next();
  });
  const deps = {
    broadcast: vi.fn(),
    findProject: () => null,
    getProjects: () => [],
    saveProjects: vi.fn(),
    config: { defaultCwd: '/tmp', dataDir: dataRoot, projectsDir: '/tmp' },
    getProjectDataDir: (id: string) => path.join(dataRoot, id),
  };
  app.use(createProjectRoutes(deps as unknown as Parameters<typeof createProjectRoutes>[0]));
  return { app, dataRoot };
}

/**
 * Read the persisted flag straight off disk. `undefined` means the route
 * never wrote config.json at all — the state a rejected caller must leave
 * behind.
 */
function persistedFlag(dataRoot: string): boolean | undefined {
  const file = path.join(dataRoot, 'config.json');
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf-8')).onboardingComplete;
}

describe('POST /api/setup/complete — Owner gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('403s an ordinary authenticated User and leaves the flag unwritten', async () => {
    const { app, dataRoot } = buildApp({
      authUserId: 'ada',
      authUser: 'ada',
      authRole: 'User',
    });

    const res = await supertest(app).post('/api/setup/complete');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Owner role required/);
    // The durable assertion: an interrupted Owner can still resume the
    // wizard because nothing was persisted.
    expect(persistedFlag(dataRoot)).toBeUndefined();
  });

  it('403s an Admin — onboarding state is Owner-only, not merely elevated', async () => {
    const { app, dataRoot } = buildApp({
      authUserId: 'admin-1',
      authUser: 'admin-1',
      authRole: 'Admin',
    });

    const res = await supertest(app).post('/api/setup/complete');

    expect(res.status).toBe(403);
    expect(persistedFlag(dataRoot)).toBeUndefined();
  });

  it('lets a real Owner mark onboarding complete', async () => {
    const { app, dataRoot } = buildApp({
      authUserId: 'boss',
      authUser: 'boss',
      authRole: 'Owner',
    });

    const res = await supertest(app).post('/api/setup/complete');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, onboardingComplete: true });
    expect(persistedFlag(dataRoot)).toBe(true);
  });

  it('lets the local-bundled (Electron) bypass identity through', async () => {
    // AGENT_HUB_MODE=local stamps a synthetic Owner with authLocalOrgBypass;
    // the desktop first-run wizard must keep working.
    const { app, dataRoot } = buildApp({
      authUser: 'local',
      authRole: 'Owner',
      authLocalOrgBypass: true,
    });

    const res = await supertest(app).post('/api/setup/complete');

    expect(res.status).toBe(200);
    expect(persistedFlag(dataRoot)).toBe(true);
  });

  it('lets the global-apiKey break-glass caller through', async () => {
    const { app, dataRoot } = buildApp({ authRole: 'Owner', authViaApiKey: true });

    const res = await supertest(app).post('/api/setup/complete');

    expect(res.status).toBe(200);
    expect(persistedFlag(dataRoot)).toBe(true);
  });

  it('lets a fresh install with no auth configured through', async () => {
    // Neither apiKey nor auth.json exists yet: the middleware stamps
    // authRole='Owner' with no user id, which resolveVisibilityCaller
    // collapses into localBypass. This is the very first-run path the
    // wizard itself takes, so it must not 403.
    const { app, dataRoot } = buildApp({ authRole: 'Owner' });

    const res = await supertest(app).post('/api/setup/complete');

    expect(res.status).toBe(200);
    expect(persistedFlag(dataRoot)).toBe(true);
  });
});
