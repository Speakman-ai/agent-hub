import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  broadcastPreviewRefreshIfReady,
  sessionHasActiveUserPreview,
  syncPreviewAfterWorktreeTurn,
} from './preview-worktree-sync.js';

function deps(broadcast = vi.fn()) {
  return {
    broadcast,
    getDevServerRuntime: () => ({
      getActiveBySessionId: (id: string) =>
        id === 'ready' ? { id: 'g1', status: 'ready', port: 4100 } : null,
      getSessionUpstreamPort: (id: string) => (id === 'ready' ? 4100 : null),
    }),
  };
}

describe('preview-worktree-sync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it('broadcasts a refresh for a ready dev server', () => {
    const broadcast = vi.fn();
    broadcastPreviewRefreshIfReady('ready', deps(broadcast), { force: true });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'preview_refresh', sessionId: 'ready', previewId: 'g1' }),
    );
  });

  it('does not refresh when no active server or upstream port exists', () => {
    const broadcast = vi.fn();
    broadcastPreviewRefreshIfReady('missing', deps(broadcast), { force: true });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('reports ready and starting rows as active user previews', () => {
    const getDevServerRuntime = () => ({
      getActiveBySessionId: (id: string) =>
        id === 'starting'
          ? { id: 'g2', status: 'starting', port: 4101 }
          : { id: 'g1', status: 'ready', port: 4100 },
      getSessionUpstreamPort: () => 4100,
    });
    const d = { broadcast: vi.fn(), getDevServerRuntime };
    expect(sessionHasActiveUserPreview('starting', d)).toBe(true);
    expect(sessionHasActiveUserPreview('ready', d)).toBe(true);
  });

  it('forces a refresh after a worktree turn without restarting the process', () => {
    const broadcast = vi.fn();
    syncPreviewAfterWorktreeTurn('ready', deps(broadcast));
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'preview_refresh' }));
  });
});
