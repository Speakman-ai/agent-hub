/**
 * Route-level tests for the per-project visibility filter on the agents
 * endpoint group.
 *
 * The shape we're pinning down:
 *
 *   - `GET /api/agents` returns only agents whose project the caller can
 *     view (`canViewProject(project, caller)` from
 *     `server/project-visibility.ts`). A User who is not the owner of a
 *     private project must not see that project's agents listed.
 *
 *   - `POST /api/agents/bulk-engine` only writes per-user overrides for agents
 *     in projects the caller can view (see agents-bulk-engine-per-user.test.ts).
 *
 *   - `PATCH /api/agents/:agentId` and the other `/api/agents/:agentId/*`
 *     handlers return 404 (`{error:'Agent not found'}`) when the caller
 *     cannot view the agent's project, matching the shape of a genuinely
 *     missing agent so the endpoint never leaks the existence of agents in
 *     private projects.
 *
 *   - Bypass identities (local-bundled, global apiKey break-glass,
 *     no-auth-configured) keep the legacy "see everything" semantics so
 *     this change is invisible in single-tenant dev / Electron / scripts.
 *
 * The full integration suite under `server/test/` runs in
 * no-auth-configured mode (localBypass=true), which collapses every
 * visibility check to "yes". To exercise the real filter we mount the
 * router into a tiny ad-hoc Express app and stamp auth claims onto each
 * request via a thin middleware — same pattern the existing
 * `routes/pr-actions.test.ts` uses for its dependency injection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import type { RouteDeps, Project, Agent } from '../types.js';

interface AuthClaims {
  authUserId?: string;
  authUser?: string;
  authRole?: 'Owner' | 'Admin' | 'User';
  authLocalOrgBypass?: boolean;
  authViaApiKey?: boolean;
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? 'proj-shared',
    name: overrides.name ?? 'Shared',
    cwd: '/tmp',
    ahw: '/tmp/ahw',
    agents: [],
    ...overrides,
  };
}

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

function buildApp(claims: AuthClaims): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    Object.assign(req, claims);
    next();
  });
  return app;
}

describe('agents route — project visibility filter', () => {
  let projects: Project[];
  let baseDeps: RouteDeps;

  beforeEach(() => {
    const sharedProject = makeProject({
      id: 'proj-shared',
      name: 'Shared',
      visibility: 'shared',
      agents: [makeAgent({ id: 'a-shared', name: 'Shared Agent' })],
    });
    const privateProject = makeProject({
      id: 'proj-private',
      name: 'Private',
      visibility: 'private',
      ownerUserId: 'owner-1',
      // Distinct engine so the bulk-engine test can prove the private
      // project was left untouched (rewriting it to 'claude-code' would be
      // an information leak — the caller never saw it).
      agents: [makeAgent({ id: 'a-private', name: 'Private Agent', engine: 'cursor-agent' })],
    });
    projects = [sharedProject, privateProject];

    baseDeps = {
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
      config: {
        engineValidModels: { 'claude-code': ['claude-sonnet-4-5-20250929'] },
      },
    } as unknown as RouteDeps;
  });

  async function mount(claims: AuthClaims): Promise<Express> {
    const { default: createAgentRoutes } = await import('./agents.js');
    const app = buildApp(claims);
    app.use(createAgentRoutes(baseDeps));
    return app;
  }

  describe('GET /api/agents', () => {
    it('hides agents from private projects the caller cannot view', async () => {
      const app = await mount({ authUserId: 'other-user', authUser: 'other', authRole: 'User' });
      const res = await request(app).get('/api/agents').expect(200);
      const ids = (res.body as Array<{ id: string }>).map((a) => a.id);
      expect(ids).toContain('a-shared');
      expect(ids).not.toContain('a-private');
    });

    it('includes private-project agents for the project owner', async () => {
      const app = await mount({ authUserId: 'owner-1', authUser: 'owner', authRole: 'User' });
      const res = await request(app).get('/api/agents').expect(200);
      const ids = (res.body as Array<{ id: string }>).map((a) => a.id);
      expect(ids).toContain('a-shared');
      expect(ids).toContain('a-private');
    });

    it('does NOT grant a read bypass to org Owners on others private projects', async () => {
      // Owners can list-and-delete via the admin endpoint but cannot read
      // contents — same rule the project visibility gate enforces.
      const app = await mount({
        authUserId: 'org-owner-id',
        authUser: 'org-owner',
        authRole: 'Owner',
      });
      const res = await request(app).get('/api/agents').expect(200);
      const ids = (res.body as Array<{ id: string }>).map((a) => a.id);
      expect(ids).toContain('a-shared');
      expect(ids).not.toContain('a-private');
    });

    it('local-bundled bypass sees every agent (single-tenant dev / Electron)', async () => {
      const app = await mount({ authLocalOrgBypass: true, authRole: 'Owner' });
      const res = await request(app).get('/api/agents').expect(200);
      const ids = (res.body as Array<{ id: string }>).map((a) => a.id);
      expect(ids).toEqual(expect.arrayContaining(['a-shared', 'a-private']));
    });

    it('global x-api-key break-glass sees every agent', async () => {
      const app = await mount({ authViaApiKey: true, authRole: 'Owner' });
      const res = await request(app).get('/api/agents').expect(200);
      const ids = (res.body as Array<{ id: string }>).map((a) => a.id);
      expect(ids).toEqual(expect.arrayContaining(['a-shared', 'a-private']));
    });

    it('no-auth-configured (Owner + no userId) sees every agent', async () => {
      // Matches the test-environment behavior and dev/local-bundled boot:
      // existing callers must not see a visibility change.
      const app = await mount({ authRole: 'Owner' });
      const res = await request(app).get('/api/agents').expect(200);
      const ids = (res.body as Array<{ id: string }>).map((a) => a.id);
      expect(ids).toEqual(expect.arrayContaining(['a-shared', 'a-private']));
    });
  });

  describe('PATCH /api/agents/:agentId', () => {
    it('returns 404 with "Agent not found" when caller cannot view the project', async () => {
      const app = await mount({ authUserId: 'other-user', authUser: 'other', authRole: 'User' });
      const res = await request(app)
        .patch('/api/agents/a-private')
        .send({ name: 'pwned' })
        .expect(404);
      expect(res.body.error).toBe('Agent not found');
      // The agent name must not have been mutated.
      const priv = projects.find((p) => p.id === 'proj-private')!;
      expect(priv.agents[0].name).toBe('Private Agent');
    });

    it('allows the project owner to patch their own agent', async () => {
      const app = await mount({ authUserId: 'owner-1', authUser: 'owner', authRole: 'User' });
      baseDeps.getEnrichedAgent = ((agentId: string) => {
        const a = projects.find((p) => p.id === 'proj-private')!.agents[0];
        return a.id === agentId ? { ...a, projectId: 'proj-private' } : null;
      }) as RouteDeps['getEnrichedAgent'];
      await request(app).patch('/api/agents/a-private').send({ name: 'Renamed' }).expect(200);
      const priv = projects.find((p) => p.id === 'proj-private')!;
      expect(priv.agents[0].name).toBe('Renamed');
    });
  });

  describe('POST /api/agents', () => {
    it('refuses to add an agent to a private project the caller cannot view', async () => {
      const app = await mount({ authUserId: 'other-user', authUser: 'other', authRole: 'User' });
      const res = await request(app)
        .post('/api/agents')
        .send({ id: 'new-agent', projectId: 'proj-private', name: 'Sneak' })
        .expect(404);
      // Masked as 'Project not found' to avoid leaking private project existence.
      expect(res.body.error).toBe('Project not found');
      const priv = projects.find((p) => p.id === 'proj-private')!;
      expect(priv.agents.find((a) => a.id === 'new-agent')).toBeUndefined();
    });
  });
});
