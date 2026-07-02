/**
 * Regression: the "switch all agents models" bulk tool
 * (POST /api/agents/bulk-engine) must be per-user. When user A switches every
 * agent to a new engine/model, user B's own sessions must keep resolving to
 * their own pick (or the shared default) — A's choice must never leak into
 * B's spawn-time engine/model resolution, and vice versa.
 *
 * The existing agents-bulk-engine-per-user.test.ts proves storage isolation
 * for a single user + that the shared `agents` row is untouched. This locks
 * the end-to-end invariant across TWO distinct users, exercised through the
 * real bulk route AND the canonical spawn-time resolver so a future refactor
 * that reintroduces a global write is caught by resolution, not just storage.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { RouteDeps, Project, Agent, AppConfig } from '../types.js';

const mockConfig = {
  engineValidModels: {
    'claude-code': ['claude-sonnet-4-5-20250929', 'claude-opus-4-8'],
    'codex-cli': ['gpt-5.2', 'gpt-5.5'],
  },
  engineDefaultModels: {
    'claude-code': 'claude-sonnet-4-5-20250929',
    'codex-cli': 'gpt-5.5',
  },
  defaultModel: 'claude-sonnet-4-5-20250929',
};

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    defaultModelForEngine: (engine: string) =>
      mockConfig.engineDefaultModels[engine as keyof typeof mockConfig.engineDefaultModels] ??
      mockConfig.defaultModel,
  };
});

let TMP_DIR = '';

const { initOrgsDb, setOrgsDbPathForTests } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { getUserPreferencesRow } = await import('../user-preferences-store.js');
const { resolveEffectiveEngineAndModel } = await import('../effective-model.js');
const { default: createAgentRoutes } = await import('./agents.js');

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: overrides.id ?? 'agent-1',
    name: overrides.name ?? 'Agent 1',
    engine: overrides.engine ?? 'claude-code',
    model: overrides.model ?? 'claude-sonnet-4-5-20250929',
    systemPrompt: '',
    color: '#abc',
    heartbeat: { enabled: false, interval: '', prompt: '' },
    ...overrides,
  };
}

describe('POST /api/agents/bulk-engine — isolation across two distinct users', () => {
  let projects: Project[];
  let deps: RouteDeps;
  let userA: string;
  let userB: string;

  beforeEach(() => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'bulk-engine-multi-user-'));
    setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
    initOrgsDb();
    userA = createUser({ username: 'user-a', passwordHash: 'x' }).id;
    userB = createUser({ username: 'user-b', passwordHash: 'x' }).id;

    projects = [
      {
        id: 'proj-shared',
        name: 'Shared',
        cwd: '/tmp',
        ahw: '/tmp/ahw',
        visibility: 'shared',
        agents: [makeAgent({ id: 'a-shared' })],
      },
    ];

    deps = {
      stmts: {
        getSessions: { all: vi.fn().mockReturnValue([]) },
        getLastMessage: { get: vi.fn().mockReturnValue(undefined) },
      },
      findProject: (id: string) => projects.find((p) => p.id === id) ?? null,
      findAgent: (agentId: string) => {
        for (const p of projects) {
          const a = p.agents.find((ag) => ag.id === agentId);
          if (a) return { project: p, agent: a };
        }
        return null;
      },
      allAgents: () =>
        projects.flatMap((p) =>
          p.agents.map((a) => ({
            ...a,
            projectId: p.id,
            projectName: p.name,
            cwd: p.cwd,
            ahw: p.ahw,
            workspace: p.ahw,
          })),
        ),
      getEnrichedAgent: vi.fn(),
      saveProjects: vi.fn(),
      ensureProjectRoom: vi.fn(),
      getProjects: () => projects,
      config: mockConfig,
    } as unknown as RouteDeps;
  });

  function mount(authUserId: string): Express {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      Object.assign(req, { authUserId, authUser: 'x', authRole: 'User' });
      next();
    });
    app.use(createAgentRoutes(deps));
    return app;
  }

  // What a session spawned by `ownerUserId` for `a-shared` would resolve to.
  function resolveForOwner(ownerUserId: string) {
    return resolveEffectiveEngineAndModel(mockConfig as unknown as AppConfig, {
      agentId: 'a-shared',
      agentEngine: 'claude-code',
      agentModel: 'claude-sonnet-4-5-20250929',
      ownerUserId,
    });
  }

  it("user A's bulk switch does not change user B's resolved engine/model", async () => {
    // Baseline: neither user has an override → both resolve to the shared default.
    expect(resolveForOwner(userA)).toMatchObject({ engine: 'claude-code' });
    expect(resolveForOwner(userB)).toMatchObject({ engine: 'claude-code' });

    // User A switches every visible agent to codex-cli / gpt-5.2.
    await request(mount(userA))
      .post('/api/agents/bulk-engine')
      .send({ engine: 'codex-cli', model: 'gpt-5.2' })
      .expect(200);

    // User A now spawns with their pick.
    expect(resolveForOwner(userA)).toMatchObject({ engine: 'codex-cli', model: 'gpt-5.2' });

    // User B is untouched — still the shared default, no leak from A.
    expect(resolveForOwner(userB)).toMatchObject({
      engine: 'claude-code',
      model: 'claude-sonnet-4-5-20250929',
    });
    expect(getUserPreferencesRow(userB).agentEngineOverrides).toBeUndefined();
    expect(getUserPreferencesRow(userB).agentModelOverrides).toBeUndefined();
  });

  it('a later bulk switch by user B leaves user A’s stored picks intact', async () => {
    await request(mount(userA))
      .post('/api/agents/bulk-engine')
      .send({ engine: 'codex-cli', model: 'gpt-5.2' })
      .expect(200);

    await request(mount(userB))
      .post('/api/agents/bulk-engine')
      .send({ engine: 'claude-code', model: 'claude-opus-4-8' })
      .expect(200);

    // Each user keeps their own pick — writes don't clobber across users.
    expect(resolveForOwner(userA)).toMatchObject({ engine: 'codex-cli', model: 'gpt-5.2' });
    expect(resolveForOwner(userB)).toMatchObject({
      engine: 'claude-code',
      model: 'claude-opus-4-8',
    });

    expect(getUserPreferencesRow(userA).agentModelOverrides?.['a-shared']).toBe('gpt-5.2');
    expect(getUserPreferencesRow(userB).agentModelOverrides?.['a-shared']).toBe('claude-opus-4-8');

    // Shared agent row never mutated by either bulk call.
    expect(projects[0].agents[0].engine).toBe('claude-code');
    expect(projects[0].agents[0].model).toBe('claude-sonnet-4-5-20250929');
    expect(deps.saveProjects).not.toHaveBeenCalled();
  });
});
