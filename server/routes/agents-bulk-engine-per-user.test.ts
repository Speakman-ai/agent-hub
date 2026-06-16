/**
 * POST /api/agents/bulk-engine writes per-user engine + model overrides —
 * never the shared `agents` row.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { RouteDeps, Project, Agent } from '../types.js';

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

// Preserve the real config module (notably `default.dataDir`, which db.ts
// reads at import time via its top-level `initDb(config.dataDir)` call) and
// only override `defaultModelForEngine` so the model-resolution assertions
// below run against this test's fixed engine model maps. Mocking the whole
// module would leave `config.dataDir` undefined and make db.ts throw
// `The "path" argument must be of type string` when agents.ts imports it.
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

describe('POST /api/agents/bulk-engine — per-user overrides', () => {
  let projects: Project[];
  let deps: RouteDeps;
  let userId: string;

  beforeEach(() => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'bulk-engine-per-user-'));
    setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
    initOrgsDb();
    userId = createUser({ username: 'bulk-user', passwordHash: 'x' }).id;

    projects = [
      {
        id: 'proj-shared',
        name: 'Shared',
        cwd: '/tmp',
        ahw: '/tmp/ahw',
        visibility: 'shared',
        agents: [makeAgent({ id: 'a-shared' })],
      },
      {
        id: 'proj-private',
        name: 'Private',
        cwd: '/tmp',
        ahw: '/tmp/ahw',
        visibility: 'private',
        ownerUserId: 'owner-1',
        agents: [makeAgent({ id: 'a-private', engine: 'cursor-agent', model: 'composer-2.5' })],
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
      Object.assign(req, { authUserId, authUser: 'bulk-user', authRole: 'User' });
      next();
    });
    app.use(createAgentRoutes(deps));
    return app;
  }

  it('writes caller overrides for visible agents only and leaves shared rows untouched', async () => {
    const app = mount(userId);
    const res = await request(app)
      .post('/api/agents/bulk-engine')
      .send({ engine: 'codex-cli', model: 'gpt-5.2' })
      .expect(200);

    expect(res.body).toMatchObject({ updated: 1, engine: 'codex-cli', model: 'gpt-5.2' });

    const prefs = getUserPreferencesRow(userId);
    expect(prefs.agentEngineOverrides?.['a-shared']).toEqual({ engine: 'codex-cli' });
    expect(prefs.agentModelOverrides?.['a-shared']).toBe('gpt-5.2');
    expect(prefs.agentEngineOverrides?.['a-private']).toBeUndefined();

    expect(projects[0].agents[0].engine).toBe('claude-code');
    expect(projects[0].agents[0].model).toBe('claude-sonnet-4-5-20250929');
    expect(projects[1].agents[0].engine).toBe('cursor-agent');
    expect(deps.saveProjects).not.toHaveBeenCalled();
  });

  it('falls back to engine default when model is invalid', async () => {
    const app = mount(userId);
    const res = await request(app)
      .post('/api/agents/bulk-engine')
      .send({ engine: 'codex-cli', model: 'not-a-real-model' })
      .expect(200);

    expect(res.body.model).toBe('gpt-5.5');
    expect(getUserPreferencesRow(userId).agentModelOverrides?.['a-shared']).toBe('gpt-5.5');
  });

  it('returns 401 without authUserId', async () => {
    const app = express();
    app.use(express.json());
    app.use(createAgentRoutes(deps));
    await request(app).post('/api/agents/bulk-engine').send({ engine: 'claude-code' }).expect(401);
  });

  // Body / engine validation lives behind the auth gate, so it can only be
  // exercised with an authenticated caller. (The no-auth integration suites
  // in server/test/ never carry an authUserId, so they 401 before reaching
  // these branches — these authed cases are the canonical 400 coverage.)
  describe('400 validation (authenticated caller)', () => {
    it('rejects an unknown engine with 400', async () => {
      const app = mount(userId);
      const res = await request(app)
        .post('/api/agents/bulk-engine')
        .send({ engine: 'not-an-engine', model: 'x' })
        .expect(400);
      expect(res.body.error).toMatch(/invalid or missing engine/i);
    });

    it('rejects an empty body with 400 + Zod details', async () => {
      const app = mount(userId);
      const res = await request(app).post('/api/agents/bulk-engine').send({}).expect(400);
      expect(res.body.error).toMatch(/invalid or missing engine/i);
      expect(Array.isArray(res.body.details)).toBe(true);
    });

    it('rejects a non-string engine with 400 + Zod details', async () => {
      const app = mount(userId);
      const res = await request(app)
        .post('/api/agents/bulk-engine')
        .send({ engine: 42 })
        .expect(400);
      expect(Array.isArray(res.body.details)).toBe(true);
    });
  });
});
