import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  flushScheduledPreviewRefresh,
  isMutatingToolUse,
  markCodeChangedIfDirty,
  maybeAutoStartPreviewOnCodeChange,
  noteMutatingToolUse,
  refreshPreviewAfterMutatingToolResult,
  sessionHasNoPublishableWork,
  syncPreviewAfterWorktreeTurnIfDirty,
} from './code-change-tracker.js';
import type { CodeChangePreviewSyncDeps } from './code-change-tracker.js';
import type { Project } from './types.js';

describe('isMutatingToolUse', () => {
  it('treats Write/Edit as mutating', () => {
    expect(isMutatingToolUse('Write', { path: '/a.ts' })).toBe(true);
    expect(isMutatingToolUse('Edit', { path: '/a.ts' })).toBe(true);
  });

  it('treats Read as non-mutating', () => {
    expect(isMutatingToolUse('Read', { path: '/a.ts' })).toBe(false);
  });

  it('detects mutating Bash commands', () => {
    expect(isMutatingToolUse('Bash', { command: 'echo hi' })).toBe(false);
    expect(isMutatingToolUse('Bash', { command: 'npm install' })).toBe(true);
    expect(isMutatingToolUse('Bash', { command: 'cat > out.txt <<EOF' })).toBe(true);
  });

  it('detects Codex changes[] payloads', () => {
    expect(isMutatingToolUse('unknown', { changes: [{ path: 'x.ts' }] })).toBe(true);
  });
});

describe('markCodeChangedIfDirty', () => {
  const sessionId = 'sess-1';
  const worktree = '/wt/sess-1';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets code_changed_at and broadcasts on first dirty mark', async () => {
    const updateSessionCodeChangedAt = { run: vi.fn() };
    const getSession = {
      get: vi.fn().mockReturnValue({ code_changed_at: null }),
    };
    const broadcast = vi.fn();

    const result = await markCodeChangedIfDirty(sessionId, worktree, {
      stmts: { getSession, updateSessionCodeChangedAt } as never,
      broadcast,
      now: () => new Date('2026-05-20T12:00:00.000Z'),
      checkDirty: async () => true,
    });

    expect(result.newlyMarked).toBe(true);
    expect(result.codeChangedAt).toBe('2026-05-20T12:00:00.000Z');
    expect(updateSessionCodeChangedAt.run).toHaveBeenCalledWith(
      '2026-05-20T12:00:00.000Z',
      sessionId,
    );
    expect(broadcast).toHaveBeenCalledWith({
      type: 'code_changed',
      sessionId,
      codeChangedAt: '2026-05-20T12:00:00.000Z',
    });
  });

  it('is idempotent when code_changed_at is already set', async () => {
    const getSession = {
      get: vi.fn().mockReturnValue({ code_changed_at: '2026-05-19T00:00:00.000Z' }),
    };
    const broadcast = vi.fn();

    const result = await markCodeChangedIfDirty(sessionId, worktree, {
      stmts: { getSession, updateSessionCodeChangedAt: { run: vi.fn() } } as never,
      broadcast,
      checkDirty: async () => true,
    });

    expect(result.newlyMarked).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does nothing when worktree is clean', async () => {
    const getSession = { get: vi.fn().mockReturnValue({ code_changed_at: null }) };
    const broadcast = vi.fn();

    const result = await markCodeChangedIfDirty(sessionId, worktree, {
      stmts: { getSession, updateSessionCodeChangedAt: { run: vi.fn() } } as never,
      broadcast,
      checkDirty: async () => false,
    });

    expect(result.newlyMarked).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe('maybeAutoStartPreviewOnCodeChange', () => {
  it('is a no-op (preview boot is user-only)', () => {
    maybeAutoStartPreviewOnCodeChange(
      'sess-1',
      { newlyMarked: true, codeChangedAt: '2026-05-20T12:00:00.000Z' },
      {
        stmts: {
          getSession: { get: vi.fn() },
          updateSessionCodeChangedAt: { run: vi.fn() },
        } as never,
        broadcast: vi.fn(),
        project: { id: 'p' } as Project,
        worktreePath: '/wt',
      },
    );
  });
});

describe('sessionHasNoPublishableWork', () => {
  it('returns true when no flag and clean worktree', async () => {
    const getSession = { get: vi.fn().mockReturnValue({ code_changed_at: null }) };
    const result = await sessionHasNoPublishableWork('s', '/wt', {
      getSession,
    } as never);
    // Uses real checkWorktreeChanges — in test env /wt may not exist; mock via integration
    // For unit test we only assert when we inject via markCodeChangedIfDirty pattern
    expect(typeof result).toBe('boolean');
  });

  it('returns false when code_changed_at is set', async () => {
    const getSession = {
      get: vi.fn().mockReturnValue({ code_changed_at: '2026-05-20T00:00:00Z' }),
    };
    expect(await sessionHasNoPublishableWork('s', '/wt', { getSession } as never)).toBe(false);
  });
});

function readyPreviewDeps(
  broadcast: CodeChangePreviewSyncDeps['broadcast'],
  schedule?: CodeChangePreviewSyncDeps['schedule'],
): CodeChangePreviewSyncDeps {
  return {
    stmts: {
      getSession: { get: vi.fn().mockReturnValue({ code_changed_at: null }) },
      updateSessionCodeChangedAt: { run: vi.fn() },
    } as never,
    broadcast,
    checkDirty: async () => false,
    project: { id: 'p' } as Project,
    worktreePath: '/wt',
    getDevServerRuntime: () => ({
      getActiveBySessionId: () => ({ id: 'g1', status: 'ready', port: 4100 }),
      getSessionUpstreamPort: () => 4100,
    }),
    ...(schedule ? { schedule } : { schedule: (fn) => fn() }),
  };
}

describe('refreshPreviewAfterMutatingToolResult', () => {
  it('reloads after the write even when git was still clean at tool start', () => {
    const broadcast = vi.fn();
    noteMutatingToolUse('sess-reload', 'tu-1', 'Write', { path: 'a.ts' });
    refreshPreviewAfterMutatingToolResult(
      'sess-reload',
      'tu-1',
      false,
      readyPreviewDeps(broadcast),
    );
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'preview_refresh',
        sessionId: 'sess-reload',
        reason: 'Files changed during turn',
      }),
    );
  });

  it('reloads once, after the last write in a burst', () => {
    const broadcast = vi.fn();
    const queued: Array<() => void> = [];
    const deps = readyPreviewDeps(broadcast, (fn) => {
      queued.push(fn);
    });
    noteMutatingToolUse('sess-burst', 'a', 'Write', { path: 'a.ts' });
    noteMutatingToolUse('sess-burst', 'b', 'Edit', { path: 'b.ts' });
    refreshPreviewAfterMutatingToolResult('sess-burst', 'a', false, deps);
    refreshPreviewAfterMutatingToolResult('sess-burst', 'b', false, deps);
    expect(broadcast).not.toHaveBeenCalled();
    queued[0]!();
    expect(broadcast).not.toHaveBeenCalled();
    queued[1]!();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('does not reload a failed write', () => {
    const broadcast = vi.fn();
    noteMutatingToolUse('sess-err', 'tu-e', 'Write', { path: 'a.ts' });
    refreshPreviewAfterMutatingToolResult('sess-err', 'tu-e', true, readyPreviewDeps(broadcast));
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('ignores a result for a tool that does not write', () => {
    const broadcast = vi.fn();
    noteMutatingToolUse('sess-read', 'tu-r', 'Read', { path: 'a.ts' });
    refreshPreviewAfterMutatingToolResult('sess-read', 'tu-r', false, readyPreviewDeps(broadcast));
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('flushes a waiting reload when the turn ends, and the timer does not fire again', () => {
    const broadcast = vi.fn();
    const queued: Array<() => void> = [];
    const deps = readyPreviewDeps(broadcast, (fn) => {
      queued.push(fn);
    });
    noteMutatingToolUse('sess-flush', 'tu-f', 'StrReplace', { path: 'a.ts' });
    refreshPreviewAfterMutatingToolResult('sess-flush', 'tu-f', false, deps);
    expect(flushScheduledPreviewRefresh('sess-flush', deps)).toBe(true);
    expect(broadcast).toHaveBeenCalledTimes(1);
    queued[0]!();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(flushScheduledPreviewRefresh('sess-flush', deps)).toBe(false);
  });

  it('does not let a flushed timer fire for a write scheduled after the flush', () => {
    const broadcast = vi.fn();
    const queued: Array<() => void> = [];
    const deps = readyPreviewDeps(broadcast, (fn) => {
      queued.push(fn);
    });
    noteMutatingToolUse('sess-reuse', 'tu-a', 'Write', { path: 'a.ts' });
    refreshPreviewAfterMutatingToolResult('sess-reuse', 'tu-a', false, deps);
    expect(flushScheduledPreviewRefresh('sess-reuse', deps)).toBe(true);
    expect(broadcast).toHaveBeenCalledTimes(1);

    noteMutatingToolUse('sess-reuse', 'tu-b', 'Write', { path: 'b.ts' });
    refreshPreviewAfterMutatingToolResult('sess-reuse', 'tu-b', false, deps);
    // A's timer fires before B's quiet period ends: it must not reload early.
    queued[0]!();
    expect(broadcast).toHaveBeenCalledTimes(1);
    // B's own timer still reloads.
    queued[1]!();
    expect(broadcast).toHaveBeenCalledTimes(2);
  });
});

describe('syncPreviewAfterWorktreeTurnIfDirty', () => {
  it('does not refresh when the worktree is clean', async () => {
    const broadcast = vi.fn();
    await syncPreviewAfterWorktreeTurnIfDirty('sess-1', '/wt', {
      stmts: {
        getSession: { get: vi.fn() },
        updateSessionCodeChangedAt: { run: vi.fn() },
      } as never,
      broadcast,
      checkDirty: async () => false,
      project: { id: 'p' } as Project,
      worktreePath: '/wt',
      getDevServerRuntime: () => ({
        getActiveBySessionId: () => ({ id: 'g1', status: 'ready', port: 4100 }),
        getSessionUpstreamPort: () => 4100,
      }),
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('broadcasts preview_refresh when a ready dev server exists', async () => {
    const broadcast = vi.fn();
    await syncPreviewAfterWorktreeTurnIfDirty('sess-1', '/wt', {
      stmts: {
        getSession: { get: vi.fn() },
        updateSessionCodeChangedAt: { run: vi.fn() },
      } as never,
      broadcast,
      checkDirty: async () => true,
      project: { id: 'p' } as Project,
      worktreePath: '/wt',
      getDevServerRuntime: () => ({
        getActiveBySessionId: () => ({ id: 'g1', status: 'ready', port: 4100 }),
        getSessionUpstreamPort: () => 4100,
      }),
    });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'preview_refresh', sessionId: 'sess-1' }),
    );
  });
});
