import '../test/setup.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, getStmts } from '../db.js';

function seedRun(overrides: {
  id: string;
  sessionId?: string;
  status?: string;
  validatedHeadSha?: string | null;
  startedAt?: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO finalize_runs (
        id, card_id, session_id, project_id, branch, head_sha,
        idempotency_key, status, phase, trigger_source, worktree_path,
        triggered_by_user_id, author_name, author_email,
        active_seconds_consumed, started_at, mode, validated_head_sha
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      overrides.id,
      `card-${overrides.id}`,
      overrides.sessionId ?? 'sess-1',
      'proj-1',
      'feature/x',
      `head-${overrides.id}`,
      `idem-${overrides.id}`,
      overrides.status ?? 'ready_to_push',
      null,
      'ui_button',
      '/tmp/wt',
      'user-1',
      'Test User',
      'test@example.com',
      0,
      overrides.startedAt ?? Date.now(),
      'full',
      overrides.validatedHeadSha ?? 'sha-1',
    );
}

function statusOf(id: string): string {
  const row = getDb().prepare('SELECT status FROM finalize_runs WHERE id = ?').get(id) as {
    status: string;
  };
  return row.status;
}

describe('finalize push claim SQL', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM finalize_runs').run();
  });

  it('blocks a second push while any push is active for the session', () => {
    seedRun({ id: 'run-pushing', status: 'pushing', validatedHeadSha: 'older-sha' });
    seedRun({ id: 'run-ready', status: 'ready_to_push', validatedHeadSha: 'sha-1' });

    const claim = getStmts().claimFinalizeRunPush.run('run-ready', 'sha-1');

    expect(claim.changes).toBe(0);
    expect(statusOf('run-ready')).toBe('ready_to_push');
    const peer = getStmts().getFinalizePushPeerForSessionHead.get(
      'run-ready',
      'sess-1',
      'sha-1',
    ) as { id: string; status: string };
    expect(peer).toMatchObject({ id: 'run-pushing', status: 'pushing' });
  });

  it('blocks and finds an already pushed peer for the same validated head', () => {
    seedRun({ id: 'run-pushed', status: 'pushed', validatedHeadSha: 'sha-1' });
    seedRun({ id: 'run-ready', status: 'ready_to_push', validatedHeadSha: 'sha-1' });

    const claim = getStmts().claimFinalizeRunPush.run('run-ready', 'sha-1');

    expect(claim.changes).toBe(0);
    expect(statusOf('run-ready')).toBe('ready_to_push');
    const peer = getStmts().getFinalizePushPeerForSessionHead.get(
      'run-ready',
      'sess-1',
      'sha-1',
    ) as { id: string; status: string };
    expect(peer).toMatchObject({ id: 'run-pushed', status: 'pushed' });
  });

  it('allows a later resolved head after the previous push completed', () => {
    seedRun({ id: 'run-pushed', status: 'pushed', validatedHeadSha: 'older-sha' });
    seedRun({ id: 'run-ready', status: 'ready_to_push', validatedHeadSha: 'sha-2' });

    const claim = getStmts().claimFinalizeRunPush.run('run-ready', 'sha-2');

    expect(claim.changes).toBe(1);
    expect(statusOf('run-ready')).toBe('pushing');
  });
});
