import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startSessionPreview } from './start-session-preview.js';
import type { Project, SessionRow } from '../types.js';

vi.mock('./preview-block.js', () => ({
  handlePreviewBlock: vi.fn().mockResolvedValue(undefined),
}));

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
      }),
    );
  });
});
