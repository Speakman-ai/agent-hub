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

vi.mock('../one-shot-spawn.js', () => ({
  runOneShotPrompt: vi.fn(),
}));

const { resolveOneShotEngine, NoEnginesAvailableError } = await import('../engine-resolver.js');
const { runOneShotPrompt } = await import('../one-shot-spawn.js');
const { default: createProjectRoutes } = await import('./projects.js');

const resolveMock = resolveOneShotEngine as unknown as ReturnType<typeof vi.fn>;
const runOneShotMock = runOneShotPrompt as unknown as ReturnType<typeof vi.fn>;

function buildApp(opts: {
  authUserId?: string;
  config?: Record<string, unknown>;
  broadcast?: ReturnType<typeof vi.fn>;
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts.authUserId !== undefined) {
      (req as unknown as { authUserId?: string }).authUserId = opts.authUserId;
    }
    next();
  });
  const config = opts.config ?? {
    dataDir: tmpdir(),
    defaultModel: 'claude-opus-4-8',
    engineDefaultModels: {
      'claude-code': 'claude-opus-4-8',
      'cursor-agent': 'composer-2.5',
      'codex-cli': 'gpt-5.5',
    },
    engineValidModels: {
      'claude-code': ['claude-opus-4-8', 'claude-sonnet-4-6'],
      'cursor-agent': ['composer-2.5'],
      'codex-cli': ['gpt-5.5', 'gpt-5.4'],
    },
  };
  const broadcast = opts.broadcast ?? vi.fn();
  const deps = {
    config,
    broadcast,
    getClaudeBin: () => '/usr/local/bin/claude',
  };
  app.use(createProjectRoutes(deps as unknown as Parameters<typeof createProjectRoutes>[0]));
  return app;
}

function buildAppWithoutModelMaps(opts: { authUserId?: string }) {
  return buildApp({
    ...opts,
    config: {
      dataDir: tmpdir(),
    },
  });
}

describe('POST /api/projects/analyze — engine selection wiring', () => {
  let cwd = '';

  beforeEach(() => {
    resolveMock.mockReset();
    runOneShotMock.mockReset();
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

  it('uses the selected analysis engine and model without falling back to another engine', async () => {
    const app = buildApp({ authUserId: 'user-abc' });

    const res = await supertest(app)
      .post('/api/projects/analyze')
      .send({ cwd, engine: 'codex-cli', model: 'gpt-5.4' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Project analysis could not start with codex-cli (gpt-5.4)');

    expect(resolveMock).toHaveBeenCalledTimes(1);
    const [, input] = resolveMock.mock.calls[0];
    expect(input).toMatchObject({
      preferred: 'codex-cli',
      preferredModel: 'gpt-5.4',
      userId: 'user-abc',
      fallbackChain: ['codex-cli'],
    });
  });

  it('rejects a selected model that does not belong to the selected engine', async () => {
    const app = buildApp({ authUserId: 'user-abc' });

    const res = await supertest(app)
      .post('/api/projects/analyze')
      .send({ cwd, engine: 'codex-cli', model: 'claude-opus-4-8' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'invalid_analysis_model',
      error: 'Model "claude-opus-4-8" is not valid for project analysis engine "codex-cli".',
      acceptedModels: ['gpt-5.5', 'gpt-5.4'],
    });
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('returns a useful 400 when model maps are absent and a model is requested', async () => {
    const app = buildAppWithoutModelMaps({ authUserId: 'user-abc' });

    const res = await supertest(app).post('/api/projects/analyze').send({ cwd, model: 'gpt-5.4' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'invalid_analysis_model',
      acceptedModels: {
        'claude-code': [],
        'cursor-agent': [],
        'codex-cli': [],
      },
    });
    expect(res.body.error).toContain('Model "gpt-5.4" is not available for project analysis');
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('passes userId=null when the request is unauthenticated', async () => {
    const app = buildApp({});

    const res = await supertest(app).post('/api/projects/analyze').send({ cwd });

    expect(res.status).toBe(400);
    const [, input] = resolveMock.mock.calls[0];
    expect(input.userId).toBeNull();
  });

  it('parses Codex JSONL final assistant text before reading the project analysis JSON', async () => {
    const broadcast = vi.fn();
    const app = buildApp({ authUserId: 'user-abc', broadcast });
    const analysis = {
      techStack: {
        languages: ['TypeScript'],
        frameworks: ['Express'],
        tools: ['Vitest'],
        packageManager: 'npm',
      },
      description: 'A test project.',
      agents: [
        {
          id: 'test-dev',
          name: 'Test Dev',
          role: 'dev',
          specialty: 'Owns the test project.',
          systemPrompt: 'You own the test project.',
        },
      ],
      wikiPages: [
        {
          title: 'Architecture',
          category: 'architecture',
          content: '# Architecture\n\nExpress routes live under `server/routes`.',
        },
      ],
    };

    resolveMock.mockResolvedValue({
      engine: 'codex-cli',
      model: 'gpt-5.5',
      fallbackUsed: false,
      fallbackFromReason: null,
    });
    runOneShotMock.mockResolvedValue(
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-1' }),
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'msg_1',
            type: 'agent_message',
            text: `\`\`\`json\n${JSON.stringify(analysis)}\n\`\`\``,
          },
        }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20 } }),
      ].join('\n'),
    );

    const res = await supertest(app)
      .post('/api/projects/analyze')
      .send({ cwd, engine: 'codex-cli', model: 'gpt-5.5' });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(broadcast.mock.calls.some(([event]) => event.type === 'analyze-complete')).toBe(true);
    });

    const complete = broadcast.mock.calls.find(([event]) => event.type === 'analyze-complete')?.[0];
    expect(complete).toMatchObject({
      type: 'analyze-complete',
      result: analysis,
    });
    expect(broadcast.mock.calls.some(([event]) => event.type === 'analyze-error')).toBe(false);
  });
});
