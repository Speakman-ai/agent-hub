import { describe, expect, it, vi, beforeEach } from 'vitest';
import { startSessionPreview } from './start-session-preview.js';
import type { Project, SessionRow } from '../types.js';

vi.mock('./preview-block.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./preview-block.js')>();
  return { ...actual, handlePreviewBlock: vi.fn().mockResolvedValue(undefined) };
});

import { handlePreviewBlock } from './preview-block.js';

const project = {
  id: 'p1',
  name: 'Demo',
  cwd: '/tmp/demo',
  color: '#000',
  ahw: '/tmp/demo/.ahw',
  agents: [],
  prEnv: {
    enabled: false,
    devServer: {
      startCommand: 'npm run dev',
      env: {},
      secretKeys: [],
      portMap: [{ internalPort: 5173, label: 'web', primary: true }],
      aptPackages: [],
    },
  },
} as unknown as Project;

const session = {
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
  beforeEach(() => vi.mocked(handlePreviewBlock).mockClear());

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

  it('returns 404 for a soft-deleted session', async () => {
    // The row survives deletion, so this path used to be accepted and then fail
    // deep in the env manager as "has no workspace yet, wait for provisioning" —
    // a provisioning step that is not running for a deleted session.
    const result = await startSessionPreview({
      sessionId: 'sess-1',
      broadcast: vi.fn(),
      findAgent: () => ({ project, agent: { id: 'a1' } }),
      getSession: () => ({ ...session, deleted_at: '2026-08-06 20:54:48' }) as SessionRow,
    });
    expect(result).toEqual({ ok: false, error: 'Session not found', statusCode: 404 });
    expect(handlePreviewBlock).not.toHaveBeenCalled();
  });

  it('adapts the managed dev-server runtime and preserves the worktree cwd', async () => {
    const broadcast = vi.fn();
    const runtime = {
      start: vi
        .fn()
        .mockResolvedValue({ devServerId: 'ds-1', url: 'http://localhost:4200', port: 4200 }),
      getById: vi.fn(),
      getLogTail: vi.fn(),
    };
    const result = await startSessionPreview({
      sessionId: 'sess-1',
      body: { route: '/board' },
      broadcast,
      findAgent: () => ({ project, agent: { id: 'a1' } }),
      getDevServerRuntime: () => runtime,
      getSession: () => session,
    });
    expect(result).toEqual({ ok: true, started: true });
    const deps = vi.mocked(handlePreviewBlock).mock.calls[0]?.[2];
    expect(deps).toMatchObject({ broadcast, project, worktreePath: '/tmp/wt' });
    await deps!.runtime!.startPreview('sess-1', project, '/tmp/wt');
    expect(runtime.start).toHaveBeenCalledWith('sess-1', project, '/tmp/wt');
  });

  it('refuses to start when the deployment can only serve a path-prefix preview', async () => {
    // Starting anyway produces a preview that boots, reports ready, and
    // then white-screens or never hot-reloads — a deployment problem that
    // looks like an application bug.
    const result = await startSessionPreview({
      sessionId: 'sess-1',
      broadcast: vi.fn(),
      findAgent: () => ({ project, agent: { id: 'a1' } }),
      getSession: () => session,
      routing: { publicUrl: 'https://hub.example.com', subdomainBase: null },
    });
    expect(result).toMatchObject({ ok: false, statusCode: 501 });
    expect(handlePreviewBlock).not.toHaveBeenCalled();
  });

  it('starts normally when subdomain routing is configured', async () => {
    const result = await startSessionPreview({
      sessionId: 'sess-1',
      broadcast: vi.fn(),
      findAgent: () => ({ project, agent: { id: 'a1' } }),
      getDevServerRuntime: () => null,
      getSession: () => session,
      routing: {
        publicUrl: 'https://hub.example.com',
        subdomainBase: 'preview.hub.example.com',
      },
    });
    expect(result).toEqual({ ok: true, started: true });
  });

  it('returns 409 before worktree provisioning finishes', async () => {
    const result = await startSessionPreview({
      sessionId: 'sess-1',
      broadcast: vi.fn(),
      findAgent: () => ({ project, agent: { id: 'a1' } }),
      getDevServerRuntime: () => null,
      getSession: () => ({ ...session, worktree_path: null }),
    });
    expect(result).toMatchObject({ ok: false, statusCode: 409 });
    expect(handlePreviewBlock).not.toHaveBeenCalled();
  });
});
