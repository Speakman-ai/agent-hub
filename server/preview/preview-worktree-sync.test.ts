import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  broadcastPreviewRefreshIfReady,
  sessionHasActiveUserPreview,
  syncPreviewAfterWorktreeTurn,
} from './preview-worktree-sync.js';

describe('broadcastPreviewRefreshIfReady', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('broadcasts preview_refresh when compose preview is ready', () => {
    const broadcast = vi.fn();
    const deps = {
      broadcast,
      getPreviewComposeRuntime: () => ({
        getActiveBySessionId: () => ({
          id: 'grp-1',
          status: 'ready',
          port: 4100,
          url: 'http://localhost:4100',
          session_id: 's1',
          project_id: 'p1',
          compose_project_name: 'proj',
          started_at: '',
          last_active_at: '',
        }),
      }),
      getPreviewRuntime: () => null,
    };

    broadcastPreviewRefreshIfReady('s1', deps, { force: true });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agenthub_preview',
        kind: 'preview_refresh',
        sessionId: 's1',
        previewId: 'grp-1',
      }),
    );
  });

  it('throttles repeated refresh broadcasts', () => {
    const broadcast = vi.fn();
    const deps = {
      broadcast,
      getPreviewComposeRuntime: () => ({
        getActiveBySessionId: () => ({
          id: 'grp-2',
          status: 'ready',
          port: 4101,
          url: 'http://localhost:4101',
          session_id: 's-throttle',
          project_id: 'p1',
          compose_project_name: 'proj',
          started_at: '',
          last_active_at: '',
        }),
      }),
      getPreviewRuntime: () => null,
    };

    broadcastPreviewRefreshIfReady('s-throttle', deps);
    vi.advanceTimersByTime(100);
    broadcastPreviewRefreshIfReady('s-throttle', deps);
    expect(broadcast).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    broadcastPreviewRefreshIfReady('s-throttle', deps);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });
});

describe('syncPreviewAfterWorktreeTurn', () => {
  it('broadcasts preview_refresh without restarting compose services', () => {
    const broadcast = vi.fn();
    const restartBackendForSession = vi.fn().mockResolvedValue(undefined);
    syncPreviewAfterWorktreeTurn('s1', {
      broadcast,
      getPreviewComposeRuntime: () => ({
        getActiveBySessionId: () => ({
          id: 'grp-1',
          status: 'ready',
          port: 4100,
          url: 'http://localhost:4100',
          session_id: 's1',
          project_id: 'p1',
          compose_project_name: 'proj',
          started_at: '',
          last_active_at: '',
        }),
        restartBackendForSession,
      }),
      getPreviewRuntime: () => null,
    });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'preview_refresh', sessionId: 's1' }),
    );
    expect(restartBackendForSession).not.toHaveBeenCalled();
  });
});

describe('sessionHasActiveUserPreview', () => {
  it('is true for ready or starting previews', () => {
    const deps = {
      broadcast: vi.fn(),
      getPreviewComposeRuntime: () => ({
        getActiveBySessionId: (sid: string) =>
          sid === 'ready'
            ? { id: 'g1', status: 'ready', port: 4100 }
            : sid === 'starting'
              ? { id: 'g2', status: 'starting', port: 4101 }
              : null,
      }),
      getPreviewRuntime: () => null,
    };
    expect(sessionHasActiveUserPreview('ready', deps)).toBe(true);
    expect(sessionHasActiveUserPreview('starting', deps)).toBe(true);
    expect(sessionHasActiveUserPreview('idle', deps)).toBe(false);
  });
});
