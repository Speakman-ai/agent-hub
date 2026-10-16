/**
 * POST /api/sessions/:sessionId/routines/draft: reads the recording artifact,
 * asks the session agent for a SKILL.md draft (one-shot mocked, no CLI) and
 * returns it for editing. Nothing is saved by this route.
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  owns: vi.fn(() => true),
  getBuffer: vi.fn(),
  runOneShotPrompt: vi.fn(),
  resolveOneShotEngine: vi.fn(),
}));

vi.mock('../session-ownership.js', () => ({
  userOwnsSession: mocks.owns,
  getSessionOwner: vi.fn(() => 'owner-1'),
  resolveOwnerUserId: vi.fn(() => 'caller-1'),
}));
vi.mock('../project-model.js', () => ({
  findAgent: vi.fn((id: string) =>
    id === 'ops'
      ? {
          project: { id: 'p1', name: 'Acme' },
          agent: { id: 'ops', name: 'Ops', engine: 'claude-code', model: null },
        }
      : null,
  ),
}));
vi.mock('../artifacts/artifact-store.js', () => ({
  ArtifactStoreUnavailableError: class extends Error {},
  getArtifactStoreForLocation: () => ({ getBuffer: mocks.getBuffer }),
}));
vi.mock('../engine-resolver.js', () => ({
  NoEnginesAvailableError: class extends Error {},
  resolveOneShotEngine: mocks.resolveOneShotEngine,
}));
vi.mock('../one-shot-spawn.js', () => ({ runOneShotPrompt: mocks.runOneShotPrompt }));
vi.mock('../config.js', () => ({ buildSpawnEnv: vi.fn(() => ({ HOME: '/tmp' })) }));
vi.mock('../per-user-cli-spawn.js', () => ({ resolveUserCliCredOverride: vi.fn(() => null) }));

const { default: createRoutineRoutes } = await import('./routines.js');

const recording = {
  schemaVersion: 1,
  kind: 'agent-hub.browser-demo',
  sessionId: 's1',
  startedAt: '2026-10-16T10:00:00.000Z',
  endedAt: '2026-10-16T10:01:00.000Z',
  durationMs: 60_000,
  stopReason: 'stopped',
  startUrl: 'https://example.com',
  truncated: false,
  steps: [
    { t: 0, type: 'navigate', url: 'https://example.com/reports', source: 'url_bar' },
    {
      t: 1000,
      type: 'type',
      url: 'https://example.com/login',
      text: 'super-secret-pw',
      masked: true,
      selector: '#pw',
      tag: 'input',
    },
  ],
};

function makeApp(artifact: Record<string, unknown> | undefined = undefined) {
  const stmts = {
    getSession: { get: vi.fn(() => ({ id: 's1', agent_id: 'ops' })) },
    getArtifact: {
      get: vi.fn(
        () =>
          artifact ?? {
            id: 'art-1',
            session_id: 's1',
            filename: 'browser-demo-20261016-100000.json',
            size: 500,
            storage_kind: 'local',
            storage_key: 's1/art-1',
          },
      ),
    },
  };
  const app = express();
  app.use(express.json());
  app.use(createRoutineRoutes({ stmts, config: {} } as never));
  return app;
}

describe('POST /api/sessions/:sessionId/routines/draft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.owns.mockReturnValue(true);
    mocks.getBuffer.mockResolvedValue(Buffer.from(JSON.stringify(recording)));
    mocks.resolveOneShotEngine.mockResolvedValue({ engine: 'claude-code', model: 'opus' });
    mocks.runOneShotPrompt.mockResolvedValue(
      '---\nname: weekly-report\ndescription: Export the weekly report.\n---\n\n## Steps\n1. Open reports\n',
    );
  });

  it('returns the agent draft for the session project, as the session owner', async () => {
    const res = await request(makeApp())
      .post('/api/sessions/s1/routines/draft')
      .send({ artifactId: 'art-1', goal: 'weekly report' })
      .expect(200);

    expect(res.body).toMatchObject({
      projectId: 'p1',
      agentId: 'ops',
      steps: 2,
      draft: {
        name: 'weekly-report',
        description: 'Export the weekly report.',
        body: '## Steps\n1. Open reports\n',
      },
    });
    expect(mocks.resolveOneShotEngine).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ userId: 'owner-1', agentId: 'ops', preferred: 'claude-code' }),
    );
    const input = mocks.runOneShotPrompt.mock.calls[0]![0] as { prompt: string; cwd: string };
    expect(input.prompt).toContain('weekly report');
    expect(input.prompt).not.toContain('super-secret-pw');
    expect(input.cwd).toContain('routine-draft-');
  });

  it('404s for a session the caller does not own and for a foreign artifact', async () => {
    mocks.owns.mockReturnValueOnce(false);
    await request(makeApp())
      .post('/api/sessions/s1/routines/draft')
      .send({ artifactId: 'art-1' })
      .expect(404);
    await request(makeApp({ id: 'art-1', session_id: 'other', size: 1 }))
      .post('/api/sessions/s1/routines/draft')
      .send({ artifactId: 'art-1' })
      .expect(404);
    expect(mocks.runOneShotPrompt).not.toHaveBeenCalled();
  });

  it('400s when the artifact is not a recording or the body is missing', async () => {
    mocks.getBuffer.mockResolvedValueOnce(Buffer.from('{"hello":1}'));
    const res = await request(makeApp())
      .post('/api/sessions/s1/routines/draft')
      .send({ artifactId: 'art-1' })
      .expect(400);
    expect(res.body.error).toMatch(/not a browser demo recording/);
    await request(makeApp()).post('/api/sessions/s1/routines/draft').send({}).expect(400);
  });

  it.each([
    ['a null step', [null]],
    ['a step with a non-numeric time', [{ t: 'soon', type: 'navigate', url: 'https://x' }]],
    ['typed text of the wrong type', [{ t: 0, type: 'type', text: 42, masked: true }]],
    [
      'a click with a non-string selector and no coordinates',
      [{ t: 0, type: 'click', selector: 1 }],
    ],
  ])('400s on a recording with %s and never calls the model', async (_label, steps) => {
    mocks.getBuffer.mockResolvedValueOnce(Buffer.from(JSON.stringify({ ...recording, steps })));
    const res = await request(makeApp())
      .post('/api/sessions/s1/routines/draft')
      .send({ artifactId: 'art-1' })
      .expect(400);
    expect(res.body.error).toMatch(/not a browser demo recording/);
    expect(mocks.resolveOneShotEngine).not.toHaveBeenCalled();
    expect(mocks.runOneShotPrompt).not.toHaveBeenCalled();
  });

  it('502s when the model fails or returns nothing', async () => {
    mocks.runOneShotPrompt.mockResolvedValueOnce('  ');
    await request(makeApp())
      .post('/api/sessions/s1/routines/draft')
      .send({ artifactId: 'art-1' })
      .expect(502);
    mocks.runOneShotPrompt.mockRejectedValueOnce(new Error('Timed out'));
    const res = await request(makeApp())
      .post('/api/sessions/s1/routines/draft')
      .send({ artifactId: 'art-1' })
      .expect(502);
    expect(res.body.error).toContain('Timed out');
  });
});
