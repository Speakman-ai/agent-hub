/**
 * Integration tests for the Skill Builder eval routes (Phase 3).
 *
 * The CLI spawn (`runOneShotPrompt`) is mocked so no real engine is launched —
 * it returns a canned answer keyed on whether the with-skill system prompt was
 * injected. `resolveOneShotEngine` is mocked to a fixed engine so the run path
 * never probes availability. Everything else (skill load, grading, report
 * render, evals.json read/write) is exercised for real against a temp
 * workspace.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import type { Role } from '../roles.js';

vi.mock('../one-shot-spawn.js', () => ({ runOneShotPrompt: vi.fn() }));
vi.mock('../engine-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine-resolver.js')>();
  return { ...actual, resolveOneShotEngine: vi.fn() };
});

const { runOneShotPrompt } = await import('../one-shot-spawn.js');
const { resolveOneShotEngine, NoEnginesAvailableError } = await import('../engine-resolver.js');
const { default: createSkillEvalRoutes } = await import('./skill-evals.js');

const spawnMock = runOneShotPrompt as unknown as ReturnType<typeof vi.fn>;
const resolveMock = resolveOneShotEngine as unknown as ReturnType<typeof vi.fn>;

const PROJECT_ID = 'proj';
const SKILL_ID = 'tester';

function makeWorkspace(): string {
  const ahw = mkdtempSync(path.join(tmpdir(), 'skill-evals-'));
  const skillDir = path.join(ahw, 'skills', SKILL_ID);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${SKILL_ID}\ndescription: Always recommend npx vitest for tests.\n---\n\nWhen asked how to test, answer with \`npx vitest\`.\n`,
  );
  return ahw;
}

// `authRole` stands in for what authMiddleware sets in production (this
// standalone app has no auth middleware). The mutating routes are gated by
// requireRole('Admin'); pass a lower role to exercise the 403 path.
function buildApp(ahw: string, authRole: Role = 'Admin') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authRole?: Role; authUserId?: string }).authRole = authRole;
    (req as unknown as { authRole?: Role; authUserId?: string }).authUserId = 'test-user';
    next();
  });
  const project = { id: PROJECT_ID, name: 'Proj', cwd: ahw, ahw };
  const deps = {
    config: { dataDir: tmpdir() },
    broadcast: vi.fn(),
    findProject: (id: string) => (id === PROJECT_ID ? project : null),
  };
  app.use(createSkillEvalRoutes(deps as unknown as Parameters<typeof createSkillEvalRoutes>[0]));
  return app;
}

const base = `/api/projects/${PROJECT_ID}/skills/${SKILL_ID}/evals`;

describe('skill eval routes', () => {
  let ahw = '';
  let app: express.Express;

  beforeEach(() => {
    spawnMock.mockReset();
    resolveMock.mockReset();
    resolveMock.mockResolvedValue({ engine: 'claude-code', model: 'sonnet' });
    ahw = makeWorkspace();
    app = buildApp(ahw);
  });

  describe('GET', () => {
    it('returns an empty suite when evals.json is absent', async () => {
      const res = await supertest(app).get(base);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ evals: [] });
    });

    it('404s for an unknown skill', async () => {
      const res = await supertest(app).get(`/api/projects/${PROJECT_ID}/skills/nope/evals`);
      expect(res.status).toBe(404);
    });

    it('404s for an unknown project', async () => {
      const res = await supertest(app).get(`/api/projects/other/skills/${SKILL_ID}/evals`);
      expect(res.status).toBe(404);
    });
  });

  describe('PUT', () => {
    it('writes a valid suite to evals/evals.json', async () => {
      const evals = [
        {
          id: 'happy',
          prompt: 'how to test?',
          assertions: [{ type: 'contains', value: 'npx vitest' }],
        },
      ];
      const res = await supertest(app).put(base).send({ evals });
      expect(res.status).toBe(200);
      expect(res.body.evals).toEqual(evals);

      const file = path.join(ahw, 'skills', SKILL_ID, 'evals', 'evals.json');
      expect(existsSync(file)).toBe(true);
      expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ version: 1, evals });
    });

    it('400s on an invalid suite', async () => {
      const res = await supertest(app)
        .put(base)
        .send({ evals: [{ id: 'BAD ID', prompt: 'x' }] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/slug/);
    });

    it('403s for a non-Admin (User) and does not write the suite', async () => {
      const userApp = buildApp(ahw, 'User');
      const res = await supertest(userApp)
        .put(base)
        .send({ evals: [{ id: 'a', prompt: 'x' }] });
      expect(res.status).toBe(403);
      expect(res.body.requiredRole).toBe('Admin');
      expect(existsSync(path.join(ahw, 'skills', SKILL_ID, 'evals', 'evals.json'))).toBe(false);
    });
  });

  describe('POST /run', () => {
    const evals = [
      {
        id: 'happy',
        prompt: 'how to test?',
        assertions: [{ type: 'contains', value: 'npx vitest' }],
      },
    ];

    beforeEach(() => {
      // With-skill injection present => correct answer; baseline => wrong.
      spawnMock.mockImplementation((input: { systemPrompt?: string }) =>
        Promise.resolve(input.systemPrompt ? 'run npx vitest' : 'run npm test'),
      );
    });

    it('400s when no evals are defined and none inline', async () => {
      const res = await supertest(app).post(`${base}/run`).send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/no evals defined/);
    });

    it('403s for a non-Admin (User) and never spawns an agent CLI', async () => {
      const userApp = buildApp(ahw, 'User');
      const res = await supertest(userApp).post(`${base}/run`).send({ evals });
      expect(res.status).toBe(403);
      expect(res.body.requiredRole).toBe('Admin');
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('runs an inline suite: with-skill passes, baseline fails, improved counted', async () => {
      const res = await supertest(app).post(`${base}/run`).send({ evals });
      expect(res.status).toBe(200);
      expect(res.body.withSkillPassed).toBe(1);
      expect(res.body.baselinePassed).toBe(0);
      expect(res.body.improvedCount).toBe(1);
      expect(res.body.engine).toBe('claude-code');
      expect(res.body.markdown).toMatch(/# Eval results/);

      // Two spawns: one with the SKILL.md injection, one without.
      expect(spawnMock).toHaveBeenCalledTimes(2);
      const systemPrompts = spawnMock.mock.calls.map((c) => c[0].systemPrompt);
      expect(systemPrompts.some((s: string | undefined) => s && s.includes('npx vitest'))).toBe(
        true,
      );
      expect(systemPrompts.some((s: string | undefined) => s === undefined)).toBe(true);
    });

    it('runs each variant in an isolated throwaway workspace, not the project, and cleans up', async () => {
      const seenCwds: string[] = [];
      spawnMock.mockImplementation((input: { cwd: string; systemPrompt?: string }) => {
        seenCwds.push(input.cwd);
        return Promise.resolve(input.systemPrompt ? 'run npx vitest' : 'run npm test');
      });
      const res = await supertest(app).post(`${base}/run`).send({ evals });
      expect(res.status).toBe(200);
      expect(seenCwds).toHaveLength(2);
      // Neither variant ran in the project checkout (no destructive mutations
      // to the user's project from a user-authored prompt).
      for (const c of seenCwds) {
        expect(c).not.toBe(ahw);
        expect(c.startsWith(tmpdir())).toBe(true);
      }
      // Per-variant isolation: the two runs cannot race in a shared tree.
      expect(seenCwds[0]).not.toBe(seenCwds[1]);
      // Throwaway: dirs are removed after the run.
      for (const c of seenCwds) expect(existsSync(c)).toBe(false);
    });

    it('runs the saved evals.json when no inline suite is given', async () => {
      await supertest(app).put(base).send({ evals });
      const res = await supertest(app).post(`${base}/run`).send({});
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it('narrows to a subset via evalIds', async () => {
      const two = [
        { id: 'a', prompt: 'p1', assertions: [{ type: 'contains', value: 'npx vitest' }] },
        { id: 'b', prompt: 'p2', assertions: [{ type: 'contains', value: 'npx vitest' }] },
      ];
      const res = await supertest(app)
        .post(`${base}/run`)
        .send({ evals: two, evalIds: ['b'] });
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.results[0].evalId).toBe('b');
    });

    it('400s when evalIds match nothing', async () => {
      const res = await supertest(app)
        .post(`${base}/run`)
        .send({ evals, evalIds: ['zzz'] });
      expect(res.status).toBe(400);
    });

    it('400s listing the missing ids on a partial evalIds miss (no silent subset run)', async () => {
      const two = [
        { id: 'happy', prompt: 'p1', assertions: [{ type: 'contains', value: 'npx vitest' }] },
        { id: 'sad', prompt: 'p2', assertions: [{ type: 'contains', value: 'npx vitest' }] },
      ];
      const res = await supertest(app)
        .post(`${base}/run`)
        .send({ evals: two, evalIds: ['happy', 'typo'] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/typo/);
      expect(res.body.missing).toEqual(['typo']);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    // Request-body validation: a malformed option must 400 BEFORE any spawn,
    // never silently reinterpret into broader/different work.
    it('400s on an empty evalIds (must not silently expand to the whole suite)', async () => {
      const res = await supertest(app).post(`${base}/run`).send({ evals, evalIds: [] });
      expect(res.status).toBe(400);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('400s and does not spawn when evalIds is a string, not an array', async () => {
      const res = await supertest(app).post(`${base}/run`).send({ evals, evalIds: 'happy' });
      expect(res.status).toBe(400);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('400s on an unknown body key (typo guard)', async () => {
      const res = await supertest(app).post(`${base}/run`).send({ evals, evalId: 'happy' });
      expect(res.status).toBe(400);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('400s on an unsupported engine (e.g. gemini-cli)', async () => {
      const res = await supertest(app).post(`${base}/run`).send({ evals, engine: 'gemini-cli' });
      expect(res.status).toBe(400);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('400s on a non-numeric timeoutMs', async () => {
      const res = await supertest(app).post(`${base}/run`).send({ evals, timeoutMs: 'soon' });
      expect(res.status).toBe(400);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('400s on an out-of-range timeoutMs', async () => {
      const res = await supertest(app).post(`${base}/run`).send({ evals, timeoutMs: 1 });
      expect(res.status).toBe(400);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('passes a valid timeoutMs through to the spawn', async () => {
      const res = await supertest(app).post(`${base}/run`).send({ evals, timeoutMs: 5000 });
      expect(res.status).toBe(200);
      expect(spawnMock.mock.calls.every((c) => c[0].timeoutMs === 5000)).toBe(true);
    });

    it('uses the agent-CLI fallback chain (Gemini excluded) when no engine override', async () => {
      await supertest(app).post(`${base}/run`).send({ evals });
      const call = resolveMock.mock.calls[0][1];
      expect(call.fallbackChain).toEqual(['claude-code', 'cursor-agent', 'codex-cli']);
      expect(call.fallbackChain).not.toContain('gemini-cli');
    });

    it('pins the fallback chain to an explicit engine override (no silent fallback)', async () => {
      resolveMock.mockReset();
      resolveMock.mockResolvedValue({ engine: 'cursor-agent', model: 'sonnet' });
      const res = await supertest(app).post(`${base}/run`).send({ evals, engine: 'cursor-agent' });
      expect(res.status).toBe(200);
      const call = resolveMock.mock.calls[0][1];
      expect(call.preferred).toBe('cursor-agent');
      expect(call.fallbackChain).toEqual(['cursor-agent']);
      expect(res.body.engine).toBe('cursor-agent');
    });

    it('400s when an explicit engine override is unavailable (no fallback to another CLI)', async () => {
      resolveMock.mockReset();
      resolveMock.mockRejectedValue(new NoEnginesAvailableError({} as never));
      const res = await supertest(app).post(`${base}/run`).send({ evals, engine: 'codex-cli' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('no_engines_configured');
      expect(res.body.error).toMatch(/codex-cli/);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('404s for an unknown skill', async () => {
      const res = await supertest(app)
        .post(`/api/projects/${PROJECT_ID}/skills/nope/evals/run`)
        .send({ evals });
      expect(res.status).toBe(404);
    });
  });
});
