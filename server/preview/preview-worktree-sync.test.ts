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

  it('broadcasts preview_refresh when a dev-server preview is ready', () => {
    const broadcast = vi.fn();
    const deps = {
      broadcast,
      getDevServerRuntime: () => ({
        getActiveBySessionId: (sid: string) =>
          sid === 's-dev' ? { id: 'ds-1', status: 'ready', port: 5173 } : null,
        getSessionUpstreamPort: (sid: string) => (sid === 's-dev' ? 5173 : null),
      }),
      getPreviewComposeRuntime: () => null,
      getPreviewRuntime: () => null,
    };

    broadcastPreviewRefreshIfReady('s-dev', deps, { force: true });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agenthub_preview',
        kind: 'preview_refresh',
        sessionId: 's-dev',
        previewId: 'ds-1',
      }),
    );
  });

  it('does not broadcast for a dev-server preview that is still starting', () => {
    const broadcast = vi.fn();
    broadcastPreviewRefreshIfReady(
      's-dev-starting',
      {
        broadcast,
        getDevServerRuntime: () => ({
          getActiveBySessionId: () => ({ id: 'ds-2', status: 'starting', port: 0 }),
          getSessionUpstreamPort: () => null,
        }),
        getPreviewComposeRuntime: () => null,
        getPreviewRuntime: () => null,
      },
      { force: true },
    );
    expect(broadcast).not.toHaveBeenCalled();
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

  it('is true for a dev-server preview with no compose row', () => {
    const deps = {
      broadcast: vi.fn(),
      getDevServerRuntime: () => ({
        getActiveBySessionId: (sid: string) =>
          sid === 'ready'
            ? { id: 'ds-1', status: 'ready', port: 5173 }
            : sid === 'starting'
              ? { id: 'ds-2', status: 'starting', port: 0 }
              : null,
        getSessionUpstreamPort: (sid: string) => (sid === 'ready' ? 5173 : null),
      }),
      getPreviewComposeRuntime: () => null,
      getPreviewRuntime: () => null,
    };
    expect(sessionHasActiveUserPreview('ready', deps)).toBe(true);
    expect(sessionHasActiveUserPreview('starting', deps)).toBe(true);
    expect(sessionHasActiveUserPreview('idle', deps)).toBe(false);
  });

  it('prefers the dev-server row over a stale compose row', () => {
    const deps = {
      broadcast: vi.fn(),
      getDevServerRuntime: () => ({
        getActiveBySessionId: () => ({ id: 'ds-1', status: 'stopped', port: 0 }),
        getSessionUpstreamPort: () => null,
      }),
      getPreviewComposeRuntime: () => ({
        getActiveBySessionId: () => ({ id: 'g1', status: 'ready', port: 4100 }),
      }),
      getPreviewRuntime: () => null,
    };
    expect(sessionHasActiveUserPreview('s1', deps)).toBe(false);
  });
});
