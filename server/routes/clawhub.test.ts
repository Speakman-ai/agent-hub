import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'path';
import { fileURLToPath } from 'url';
import type { RouteDeps } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');
const EXPECTED_DEFAULT_SKILLS_DIR = path.join(SERVER_DIR, 'default-skills');

// ─── Mock child_process ───────────────────────────────────────────
vi.mock('child_process', () => {
  const mockSpawn = vi.fn();
  return { spawn: mockSpawn };
});

const { spawn } = await import('child_process');
const spawnMock = spawn as unknown as Mock;

interface MockProc {
  stdout: { on: Mock };
  stderr: { on: Mock };
  on: Mock;
  kill: Mock;
}

function setupSpawnSuccess(): void {
  spawnMock.mockImplementation((): MockProc => {
    const proc: MockProc = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    };
    setTimeout(() => {
      const closeCb = proc.on.mock.calls.find((c: unknown[]) => c[0] === 'close')?.[1] as
        | ((code: number) => void)
        | undefined;
      if (closeCb) closeCb(0);
    }, 5);
    return proc;
  });
}

// ─── Import route after mocks ────────────────────────────────────
const { default: createClawhubRoutes, __clearClawhubCache } = await import('./clawhub.js');

// ─── Build mock deps ─────────────────────────────────────────────
function buildMockDeps(overrides: Partial<RouteDeps> = {}): RouteDeps {
  return {
    config: { port: 3051, dataDir: '/tmp' },
    stmts: {},
    broadcast: vi.fn(),
    findProject: vi.fn(),
    findAgent: vi.fn().mockReturnValue(null),
    getEnrichedAgent: vi.fn(),
    allAgents: vi.fn(),
    saveProjects: vi.fn(),
    ensureProjectRoom: vi.fn(),
    handleChat: vi.fn(),
    pendingReviewComments: new Map(),
    lastDispatchedReviewId: new Map(),
    scheduleAutonomousEpic: vi.fn(),
    autonomousCrons: new Map(),
    runAutonomousLoop: vi.fn(),
    getProjects: vi.fn().mockReturnValue([]),
    setProjects: vi.fn(),
    getGhBotUser: vi.fn().mockReturnValue(null),
    setGhBotUser: vi.fn(),
    getGhAppSlug: vi.fn().mockReturnValue(null),
    setGhAppSlug: vi.fn(),
    serverDir: '/tmp',
    buildTranscript: vi.fn(),
    summarizeTranscript: vi.fn(),
    ...overrides,
  } as unknown as RouteDeps;
}

function buildApp(deps: RouteDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.use(createClawhubRoutes(deps));
  return app;
}

describe('ClawHub routes', () => {
  beforeEach(() => {
    __clearClawhubCache();
    spawnMock.mockReset();
    vi.restoreAllMocks();
  });

  describe('GET /api/clawhub/search', () => {
    it('proxies to ClawHub v1 API and caches on second call', async () => {
      const fakePayload = { skills: [{ slug: 'foo', summary: 'hi' }] };
      const fetchMock = vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue(
        new Response(JSON.stringify(fakePayload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const app = buildApp(buildMockDeps());

      const res1 = await request(app).get('/api/clawhub/search?q=deploy&limit=10');
      expect(res1.status).toBe(200);
      expect(res1.body).toEqual(fakePayload);
      expect(res1.headers['x-clawhub-cache']).toBe('miss');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const calledUrl = fetchMock.mock.calls[0]![0] as string;
      expect(calledUrl).toContain('https://clawhub.ai/api/v1/search');
      expect(calledUrl).toContain('q=deploy');
      expect(calledUrl).toContain('limit=10');

      // Second call with same query should be served from cache — no new fetch
      const res2 = await request(app).get('/api/clawhub/search?q=deploy&limit=10');
      expect(res2.status).toBe(200);
      expect(res2.body).toEqual(fakePayload);
      expect(res2.headers['x-clawhub-cache']).toBe('hit');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('honors CLAWHUB_REGISTRY env var', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch' as 'fetch')
        .mockResolvedValue(
          new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
        );

      const originalRegistry = process.env.CLAWHUB_REGISTRY;
      process.env.CLAWHUB_REGISTRY = 'https://staging.clawhub.example';
      try {
        const app = buildApp(buildMockDeps());
        await request(app).get('/api/clawhub/search?q=x');
        expect(fetchMock.mock.calls[0]![0] as string).toContain(
          'https://staging.clawhub.example/api/v1/search',
        );
      } finally {
        if (originalRegistry === undefined) delete process.env.CLAWHUB_REGISTRY;
        else process.env.CLAWHUB_REGISTRY = originalRegistry;
      }
    });
  });

  describe('POST /api/clawhub/install', () => {
    it('rejects 400 for path-traversal slug', async () => {
      const app = buildApp(buildMockDeps());

      const res = await request(app)
        .post('/api/clawhub/install')
        .send({ slug: '../../../etc/passwd', target: 'global' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid characters/i);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('rejects 400 for absolute-path slug', async () => {
      const app = buildApp(buildMockDeps());

      const res = await request(app)
        .post('/api/clawhub/install')
        .send({ slug: '/etc/passwd', target: 'global' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid characters/i);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("rejects 400 when target='agent' and agentId is missing", async () => {
      const app = buildApp(buildMockDeps());

      const res = await request(app)
        .post('/api/clawhub/install')
        .send({ slug: 'some-skill', target: 'agent' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/agentId is required/i);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("resolves agent workspace skills/ dir when target='agent'", async () => {
      setupSpawnSuccess();

      const findAgent = vi.fn().mockReturnValue({
        project: { id: 'proj-1', ahw: '/ws/proj-1', cwd: '/repo', agents: [] },
        agent: { id: 'agent-1', name: 'A' },
      });

      const app = buildApp(buildMockDeps({ findAgent }));

      const res = await request(app)
        .post('/api/clawhub/install')
        .send({ slug: 'my-skill', target: 'agent', agentId: 'agent-1' });

      expect(res.status).toBe(200);
      expect(res.body.slug).toBe('my-skill');
      expect(res.body.path).toBe(path.join('/ws/proj-1', 'skills', 'my-skill'));

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
      expect(cmd).toBe('npx');
      expect(args[0]).toBe('clawhub@latest');
      expect(args[1]).toBe('install');
      expect(args[2]).toBe('my-skill');
      expect(args).toContain('--workdir');
      expect(args).toContain('/ws/proj-1');
      expect(args).toContain('--dir');
      expect(args).toContain('skills');
    });

    it("resolves default-skills dir when target='global'", async () => {
      setupSpawnSuccess();

      const app = buildApp(buildMockDeps());

      const res = await request(app)
        .post('/api/clawhub/install')
        .send({ slug: 'global-skill', target: 'global' });

      expect(res.status).toBe(200);
      expect(res.body.path).toBe(path.join(EXPECTED_DEFAULT_SKILLS_DIR, 'global-skill'));

      const [, args] = spawnMock.mock.calls[0] as [string, string[]];
      const workdirIdx = args.indexOf('--workdir');
      const dirIdx = args.indexOf('--dir');
      expect(workdirIdx).toBeGreaterThan(-1);
      expect(dirIdx).toBeGreaterThan(-1);
      expect(path.join(args[workdirIdx + 1]!, args[dirIdx + 1]!)).toBe(EXPECTED_DEFAULT_SKILLS_DIR);
    });

    it('passes --version flag through to npx when provided', async () => {
      setupSpawnSuccess();

      const app = buildApp(buildMockDeps());
      const res = await request(app)
        .post('/api/clawhub/install')
        .send({ slug: 'foo', target: 'global', version: '1.2.3' });

      expect(res.status).toBe(200);
      const [, args] = spawnMock.mock.calls[0] as [string, string[]];
      expect(args).toContain('--version');
      expect(args[args.indexOf('--version') + 1]).toBe('1.2.3');
    });

    it('returns 500 with stderr tail when npx exits non-zero', async () => {
      spawnMock.mockImplementation((): MockProc => {
        const proc: MockProc = {
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: vi.fn(),
          kill: vi.fn(),
        };
        setTimeout(() => {
          const stderrCb = proc.stderr.on.mock.calls.find(
            (c: unknown[]) => c[0] === 'data',
          )?.[1] as ((buf: Buffer) => void) | undefined;
          if (stderrCb) stderrCb(Buffer.from('skill not found: nope\n'));
          const closeCb = proc.on.mock.calls.find((c: unknown[]) => c[0] === 'close')?.[1] as
            | ((code: number) => void)
            | undefined;
          if (closeCb) closeCb(1);
        }, 5);
        return proc;
      });

      const app = buildApp(buildMockDeps());
      const res = await request(app)
        .post('/api/clawhub/install')
        .send({ slug: 'nope', target: 'global' });

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/clawhub install failed/i);
      expect(res.body.stderrTail).toContain('skill not found');
    });
  });
});
