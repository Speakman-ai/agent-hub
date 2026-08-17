import { describe, it, expect, vi } from 'vitest';
import {
  engineSupportsCheckpointRewind,
  enrichSessionForClient,
  broadcastSessionCreated,
  setSessionProjectResolver,
} from './session-checkpoint-rewind.js';
import { setFirecrackerBackendRegistered } from './session-env/firecracker/firecracker-backend-status.js';
import type { SessionRow, Stmts } from './types.js';

function minimalSession(overrides: Partial<SessionRow>): SessionRow {
  return {
    id: 's1',
    agent_id: 'a1',
    name: 'Test',
    engine: 'claude-code',
    model: 'claude-opus-4-8',
    engine_session_id: null,
    use_worktree: 1,
    worktree_path: null,
    worktree_branch: null,
    git_worktree_detected: null,
    changes_ready: null,
    stale_pr_notified_at: null,
    ask_mode: 0,
    cron_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
    ...overrides,
  };
}

describe('engineSupportsCheckpointRewind', () => {
  it('is true only for claude-code', () => {
    expect(engineSupportsCheckpointRewind('claude-code')).toBe(true);
    expect(engineSupportsCheckpointRewind('cursor-agent')).toBe(false);
    expect(engineSupportsCheckpointRewind('gemini-cli')).toBe(false);
    expect(engineSupportsCheckpointRewind('codex-cli')).toBe(false);
    expect(engineSupportsCheckpointRewind(null)).toBe(false);
    expect(engineSupportsCheckpointRewind(undefined)).toBe(false);
  });
});

describe('enrichSessionForClient', () => {
  it('sets checkpoint_rewind_supported from engine', () => {
    const claude = enrichSessionForClient(minimalSession({ engine: 'claude-code' }));
    expect(claude.checkpoint_rewind_supported).toBe(true);

    const cursor = enrichSessionForClient(minimalSession({ engine: 'cursor-agent' }));
    expect(cursor.checkpoint_rewind_supported).toBe(false);
  });

  it('finalize_status is null when stmts is omitted', () => {
    const wire = enrichSessionForClient(minimalSession({}));
    expect(wire.finalize_status).toBeNull();
  });

  it('can_design_mode mirrors sessionHasUsableWorktree (worktree presence)', () => {
    expect(enrichSessionForClient(minimalSession({ worktree_path: null })).can_design_mode).toBe(
      false,
    );
    expect(enrichSessionForClient(minimalSession({ worktree_path: '   ' })).can_design_mode).toBe(
      false,
    );
    expect(
      enrichSessionForClient(minimalSession({ worktree_path: '/tmp/wt/session-x' }))
        .can_design_mode,
    ).toBe(true);
  });

  it('offers isolated mode only when Firecracker is registered for a dev project', () => {
    setFirecrackerBackendRegistered(false);
    expect(
      enrichSessionForClient(minimalSession({}), undefined, { id: 'p1', mode: 'dev' } as any)
        .can_isolated_mode,
    ).toBe(false);

    setFirecrackerBackendRegistered(true);
    try {
      expect(
        enrichSessionForClient(minimalSession({}), undefined, { id: 'p1', mode: 'dev' } as any)
          .can_isolated_mode,
      ).toBe(true);
      expect(
        enrichSessionForClient(minimalSession({}), undefined, {
          id: 'p1',
          mode: 'workflow',
        } as any).can_isolated_mode,
      ).toBe(false);
    } finally {
      setFirecrackerBackendRegistered(false);
    }
  });

  it('fails closed on VM mode when the owning project is unknown (no project, no resolver)', () => {
    setFirecrackerBackendRegistered(true);
    try {
      // Broadcasts / most routes omit `project`. Without an installed resolver
      // the owning project is unknown, so VM mode must NOT be offered — a
      // workflow session would otherwise expose the picker just because its
      // `project` was omitted (the server-side mode guard rejects it anyway).
      expect(enrichSessionForClient(minimalSession({})).can_isolated_mode).toBe(false);
    } finally {
      setFirecrackerBackendRegistered(false);
    }
  });

  it('resolves the owning project via the installed resolver when project is omitted', () => {
    setFirecrackerBackendRegistered(true);
    try {
      // Dev project → picker stays after a project-less broadcast.
      setSessionProjectResolver(() => ({ id: 'p1', mode: 'dev' }) as any);
      expect(enrichSessionForClient(minimalSession({})).can_isolated_mode).toBe(true);

      // Workflow project → picker never appears, even though `project` is omitted.
      setSessionProjectResolver(() => ({ id: 'p1', mode: 'workflow' }) as any);
      expect(enrichSessionForClient(minimalSession({})).can_isolated_mode).toBe(false);

      // Resolver miss (agent deleted) → fail closed.
      setSessionProjectResolver(() => null);
      expect(enrichSessionForClient(minimalSession({})).can_isolated_mode).toBe(false);
    } finally {
      setSessionProjectResolver(null);
      setFirecrackerBackendRegistered(false);
    }
  });

  it('finalize_status reflects the latest finalize run status when stmts is provided', () => {
    const stmts = {
      getKanbanCardBySession: { get: () => undefined },
      getLatestFinalizeRunForSession: { get: () => ({ status: 'ready_to_push' }) },
    } as unknown as Stmts;
    const wire = enrichSessionForClient(minimalSession({}), stmts);
    expect(wire.finalize_status).toBe('ready_to_push');
  });

  it('finalize_status reports the passed phase (not ready_to_push) for a partial, not-fully-validated run', () => {
    const stmts = {
      getKanbanCardBySession: { get: () => undefined },
      getLatestFinalizeRunForSession: {
        get: () => ({ status: 'ready_to_push', mode: 'checks' }),
      },
      getLatestChecksRunForSession: {
        get: () => ({ status: 'ready_to_push', validated_head_sha: 'sha1' }),
      },
      getLatestReviewRunForSession: { get: () => undefined },
    } as unknown as Stmts;
    const wire = enrichSessionForClient(minimalSession({}), stmts);
    // Inert marker — the sidebar's "ready to push" check only matches the
    // literal 'ready_to_push', so it stays dark until the reviewer passes too.
    expect(wire.finalize_status).toBe('checks_passed');
  });

  it('finalize_status reports ready_to_push once both phases validated the same head', () => {
    const stmts = {
      getKanbanCardBySession: { get: () => undefined },
      getLatestFinalizeRunForSession: {
        get: () => ({ status: 'ready_to_push', mode: 'review' }),
      },
      getLatestChecksRunForSession: {
        get: () => ({ status: 'ready_to_push', validated_head_sha: 'sha1' }),
      },
      getLatestReviewRunForSession: {
        get: () => ({ status: 'ready_to_push', validated_head_sha: 'sha1' }),
      },
    } as unknown as Stmts;
    const wire = enrichSessionForClient(minimalSession({}), stmts);
    expect(wire.finalize_status).toBe('ready_to_push');
  });

  it('finalize_status is null when the session has no finalize runs', () => {
    const stmts = {
      getKanbanCardBySession: { get: () => undefined },
      getLatestFinalizeRunForSession: { get: () => undefined },
    } as unknown as Stmts;
    const wire = enrichSessionForClient(minimalSession({}), stmts);
    expect(wire.finalize_status).toBeNull();
  });

  it('finalize_status falls back to null if the lookup throws', () => {
    const stmts = {
      getKanbanCardBySession: { get: () => undefined },
      getLatestFinalizeRunForSession: {
        get: () => {
          throw new Error('no finalize_runs table');
        },
      },
    } as unknown as Stmts;
    const wire = enrichSessionForClient(minimalSession({}), stmts);
    expect(wire.finalize_status).toBeNull();
  });
});

describe('broadcastSessionCreated', () => {
  it('emits session_created with an enriched wire row', () => {
    const broadcast = vi.fn();
    const row = minimalSession({ id: 'sess-new', engine: 'claude-code' });
    broadcastSessionCreated(broadcast, 'agent-1', row);
    expect(broadcast).toHaveBeenCalledWith({
      type: 'session_created',
      agentId: 'agent-1',
      session: expect.objectContaining({
        id: 'sess-new',
        checkpoint_rewind_supported: true,
      }),
    });
  });
});
