import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startSessionPreview } from './start-session-preview.js';
import type { Project, SessionRow } from '../types.js';

vi.mock('./preview-block.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./preview-block.js')>();
  return {
    ...actual,
    handlePreviewBlock: vi.fn().mockResolvedValue(undefined),
  };
});

import config from '../config.js';
import { handlePreviewBlock } from './preview-block.js';

const project: Project = {
  id: 'p1',
  name: 'Demo',
  cwd: '/tmp/demo',
  color: '#000',
  ahw: '/tmp/demo/.ahw',
  agents: [],
  prEnv: {
    enabled: true,
    startScript: '',
    internalPort: 5173,
    preview: {
      enabled: true,
      compose: { file: 'docker-compose.yml', entryService: 'web', entryPort: 5173 },
      captureRoutes: ['/'],
    },
  },
} as Project;

const session: SessionRow = {
  id: 'sess-1',
  agent_id: 'a1',
  name: 'Test',
  engine: 'claude-code',
  model: 'x',
  use_worktree: 1,
  worktree_path: '/tmp/wt',
  ask_mode: 0,
  created_at: '',
  updated_at: '',
} as SessionRow;

describe('startSessionPreview', () => {
  beforeEach(() => {
    vi.mocked(handlePreviewBlock).mockClear();
  });

  it('returns 404 when session is missing', async () => {
    const result = await startSessionPreview({
      sessionId: 'missing',
      broadcast: vi.fn(),
      findAgent: () => ({ project, agent: { id: 'a1' } }),
      getSession: () => undefined,
    });
    expect(result).toEqual({ ok: false, error: 'Session not found', statusCode: 404 });
    expect(handlePreviewBlock).not.toHaveBeenCalled();
  });

  it('invokes handlePreviewBlock with compose runtime and worktree cwd', async () => {
    const broadcast = vi.fn();
    const composeRuntime = { startPreview: vi.fn(), getById: vi.fn(), getLogTail: vi.fn() };
    const result = await startSessionPreview({
      sessionId: 'sess-1',
      body: { route: '/board' },
      broadcast,
      findAgent: () => ({ project, agent: { id: 'a1' } }),
      getPreviewComposeRuntime: () => composeRuntime,
      getSession: () => session,
    });
    expect(result).toEqual({ ok: true, started: true });
    expect(handlePreviewBlock).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ target: 'client', route: '/board' }),
      expect.objectContaining({
        runtime: composeRuntime,
        broadcast,
        project,
        worktreePath: '/tmp/wt',
        readyTimeoutMs: config.previewComposeReadyTimeoutMs,
      }),
    );
  });

  it('selects the managed dev-server runtime when configured', async () => {
    const broadcast = vi.fn();
    const composeRuntime = { startPreview: vi.fn(), getById: vi.fn(), getLogTail: vi.fn() };
    const devServerRuntime = {
      start: vi.fn().mockResolvedValue({
        devServerId: 'dev-server-1',
        url: 'http://localhost:4200',
        port: 4200,
      }),
      getById: vi.fn(),
      getLogTail: vi.fn(),
    };
    const devServerProject = {
      ...project,
      prEnv: {
        ...project.prEnv,
        // Keep the legacy compose config present to pin dev-server precedence.
        devServer: { startCommand: 'npm run dev', env: {}, secretKeys: [], portMap: [] },
      },
    } as Project;

    const result = await startSessionPreview({
      sessionId: 'sess-1',
      broadcast,
      findAgent: () => ({ project: devServerProject, agent: { id: 'a1' } }),
      getPreviewComposeRuntime: () => composeRuntime,
      getDevServerRuntime: () => devServerRuntime,
      getSession: () => session,
    });

    expect(result).toEqual({ ok: true, started: true });
    const handlerDeps = vi.mocked(handlePreviewBlock).mock.calls[0]?.[2];
    expect(handlerDeps?.runtime).not.toBe(composeRuntime);
    expect(handlerDeps?.runtime).toBeTruthy();

    await handlerDeps!.runtime!.startPreview('sess-1', devServerProject, '/tmp/wt');
    expect(devServerRuntime.start).toHaveBeenCalledWith('sess-1', devServerProject, '/tmp/wt');
    expect(composeRuntime.startPreview).not.toHaveBeenCalled();
  });

  it('returns 409 instead of falling back to project cwd before worktree provisioning finishes', async () => {
    const broadcast = vi.fn();
    const composeRuntime = { startPreview: vi.fn(), getById: vi.fn(), getLogTail: vi.fn() };
    const result = await startSessionPreview({
      sessionId: 'sess-1',
      broadcast,
      findAgent: () => ({ project, agent: { id: 'a1' } }),
      getPreviewComposeRuntime: () => composeRuntime,
      getSession: () => ({ ...session, worktree_path: null }),
    });
    expect(result).toEqual({
      ok: false,
      error: 'Session workspace is not ready yet. Wait for workspace provisioning to finish.',
      statusCode: 409,
    });
    expect(handlePreviewBlock).not.toHaveBeenCalled();
  });
});
