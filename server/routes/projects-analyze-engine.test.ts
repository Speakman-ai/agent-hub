/**
 * Regression tests for `POST /api/projects/analyze` engine selection.
 *
 * Two bugs this locks down:
 *
 *  1. The acting user's id was never threaded into `resolveOneShotEngine`.
 *     Because the agent CLIs (Claude / Cursor / Codex) authenticate
 *     strictly per-account, omitting `userId` made the availability probe
 *     report "No acting user for this <engine> run" even when the user
 *     had credentials configured — so analysis always failed with
 *     `no_engines_configured`.
 *
 *  2. The route used the default fallback chain, which includes
 *     `gemini-cli`. Gemini is reserved for RAG/embeddings and must never
 *     drive interactive project analysis; the analyze chain must fall back
 *     across the agent CLIs only (claude → cursor → codex).
 *
 * We mock `resolveOneShotEngine` (preserving the real
 * `NoEnginesAvailableError`) and assert the exact args the route passes.
 * The resolver is rejected so the route returns 400 before ever spawning
 * a CLI — keeping this a pure wiring test.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';

vi.mock('../engine-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine-resolver.js')>();
  return { ...actual, resolveOneShotEngine: vi.fn() };
});

const { resolveOneShotEngine, NoEnginesAvailableError } = await import('../engine-resolver.js');
const { default: createProjectRoutes } = await import('./projects.js');

const resolveMock = resolveOneShotEngine as unknown as ReturnType<typeof vi.fn>;

function buildApp(opts: { authUserId?: string }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts.authUserId !== undefined) {
      (req as unknown as { authUserId?: string }).authUserId = opts.authUserId;
    }
    next();
  });
  const deps = {
    config: { dataDir: tmpdir() },
    broadcast: vi.fn(),
    getClaudeBin: () => '/usr/local/bin/claude',
  };
  app.use(createProjectRoutes(deps as unknown as Parameters<typeof createProjectRoutes>[0]));
  return app;
}

describe('POST /api/projects/analyze — engine selection wiring', () => {
  let cwd = '';

  beforeEach(() => {
    resolveMock.mockReset();
    // The resolver rejecting keeps the route on the 400 path (no spawn).
    resolveMock.mockRejectedValue(new NoEnginesAvailableError({} as never));
    cwd = mkdtempSync(path.join(tmpdir(), 'analyze-engine-'));
  });

  it('threads the acting user id and a Gemini-excluded fallback chain', async () => {
    const app = buildApp({ authUserId: 'user-abc' });

    const res = await supertest(app).post('/api/projects/analyze').send({ cwd });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('no_engines_configured');

    expect(resolveMock).toHaveBeenCalledTimes(1);
    const [, input] = resolveMock.mock.calls[0];
    expect(input).toMatchObject({
      preferred: 'claude-code',
      userId: 'user-abc',
    });

    // Gemini must never be a fallback target for interactive analysis.
    expect(input.fallbackChain).toEqual(['claude-code', 'cursor-agent', 'codex-cli']);
    expect(input.fallbackChain).not.toContain('gemini-cli');
  });

  it('passes userId=null when the request is unauthenticated', async () => {
    const app = buildApp({});

    const res = await supertest(app).post('/api/projects/analyze').send({ cwd });

    expect(res.status).toBe(400);
    const [, input] = resolveMock.mock.calls[0];
    expect(input.userId).toBeNull();
  });
});
