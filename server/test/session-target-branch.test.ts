/**
 * `PUT /api/sessions/:sessionId/target-branch` — the session's PR target.
 * Provisioned cases run against a real git origin + clone so the rebase
 * semantics (only session commits move) are exercised end to end.
 */
import { vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import type supertest from 'supertest';
import { getRequest, createProject, createAgent, createSession } from './helpers.js';
import { getDb } from '../db.js';
import { routeDeps } from '../index.js';
import {
  releaseSessionWorktreeLock,
  tryAcquireSessionWorktreeLock,
} from '../session-worktree-lock.js';
import { git, makeRetargetRepo, type RetargetRepo } from './retarget-repo-fixture.js';

let request: supertest.Agent;
let repo: RetargetRepo | null = null;

beforeAll(async () => {
  request = await getRequest();
});

afterEach(() => {
  repo?.cleanup();
  repo = null;
  vi.restoreAllMocks();
});

async function freshSession(): Promise<string> {
  const project = await createProject();
  const agent = await createAgent({ projectId: project.id as string });
  const session = (await createSession({ agentId: agent.id as string })) as unknown as {
    id: string;
  };
  return session.id;
}

function provision(sessionId: string, clone: string): void {
  getDb()
    .prepare('UPDATE sessions SET worktree_path = ?, worktree_branch = ? WHERE id = ?')
    .run(clone, 'agent-hub/dev/session-1', sessionId);
}

function systemMessages(sessionId: string): string[] {
  return (
    getDb()
      .prepare("SELECT content FROM messages WHERE session_id = ? AND role = 'system'")
      .all(sessionId) as Array<{ content: string }>
  ).map((r) => r.content);
}

describe('PUT /api/sessions/:sessionId/target-branch', () => {
  it('stores the target on a not-yet-provisioned session', async () => {
    const sessionId = await freshSession();
    const res = await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'release-1.16.0' })
      .expect(200);
    expect(res.body.session.pr_base_branch).toBe('release-1.16.0');
    expect(res.body.retarget).toMatchObject({ kind: 'stored', toBranch: 'release-1.16.0' });
  });

  it('rejects unsafe branch names', async () => {
    const sessionId = await freshSession();
    await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: '-x' })
      .expect(400);
    await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'a/../b' })
      .expect(400);
  });

  it('rebases a provisioned worktree onto the new target and back', async () => {
    repo = makeRetargetRepo();
    const sessionId = await freshSession();
    provision(sessionId, repo.clone);
    const handleChat = vi.spyOn(routeDeps, 'handleChat').mockResolvedValue(undefined);

    const res = await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'release' })
      .expect(200);

    expect(res.body.retarget).toMatchObject({
      kind: 'rebased',
      fromBranch: 'main',
      toBranch: 'release',
      commits: 2,
    });
    expect(res.body.session.pr_base_branch).toBe('release');
    expect(git(repo.clone, 'log', '--format=%s', 'HEAD').split('\n')).toEqual([
      'S2',
      'S1',
      'R release-only',
      'A',
    ]);
    expect(systemMessages(sessionId).some((m) => m.includes('Rebased 2 session commit'))).toBe(
      true,
    );
    expect(handleChat).not.toHaveBeenCalled();

    // Clearing measures the fork point against the session target, not main.
    const back = await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: null })
      .expect(200);
    expect(back.body.retarget).toMatchObject({
      kind: 'rebased',
      fromBranch: 'release',
      toBranch: 'main',
    });
    expect(git(repo.clone, 'log', '--format=%s', 'HEAD').split('\n')).toEqual([
      'S2',
      'S1',
      'B main-only',
      'A',
    ]);
  });

  it('saves the target and hands conflicts to the agent', async () => {
    repo = makeRetargetRepo({ conflictOnRelease: true });
    const sessionId = await freshSession();
    provision(sessionId, repo.clone);
    const before = git(repo.clone, 'rev-parse', 'HEAD');
    const handleChat = vi.spyOn(routeDeps, 'handleChat').mockResolvedValue(undefined);

    const res = await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'release' })
      .expect(200);

    expect(res.body.retarget).toMatchObject({
      kind: 'conflict',
      files: ['shared.txt'],
      agentDispatched: true,
    });
    expect(res.body.session.pr_base_branch).toBe('release');
    expect(git(repo.clone, 'rev-parse', 'HEAD')).toBe(before);
    await vi.waitFor(() => expect(handleChat).toHaveBeenCalledTimes(1));
    const msg = handleChat.mock.calls[0][1] as {
      content: string;
      _skipUserMessagePersist?: boolean;
    };
    expect(msg._skipUserMessagePersist).toBe(true);
    expect(msg.content).toContain('`shared.txt`');
    expect(msg.content).toContain(`git rebase --onto ${repo.releaseTip}`);
  });

  it('measures a later retarget from the real base while a conflict is unresolved', async () => {
    repo = makeRetargetRepo({ conflictOnRelease: true });
    const sessionId = await freshSession();
    provision(sessionId, repo.clone);
    getDb().prepare('UPDATE sessions SET ask_mode = 1 WHERE id = ?').run(sessionId);
    const handleChat = vi.spyOn(routeDeps, 'handleChat').mockResolvedValue(undefined);

    const first = await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'release' })
      .expect(200);
    expect(first.body.retarget).toMatchObject({ kind: 'conflict', agentDispatched: false });
    expect(first.body.session.pr_base_pending_from).toBe('main');

    // Re-selecting the saved target retries the outstanding rebase.
    const again = await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'release' })
      .expect(200);
    expect(again.body.retarget).toMatchObject({
      kind: 'conflict',
      fromBranch: 'main',
      toBranch: 'release',
    });

    // A third branch forks from main (where HEAD really is), not release, so
    // the main-only commit is not replayed.
    const third = await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'hotfix' })
      .expect(200);
    expect(third.body.retarget).toMatchObject({
      kind: 'rebased',
      fromBranch: 'main',
      toBranch: 'hotfix',
      commits: 2,
    });
    expect(third.body.session.pr_base_pending_from ?? null).toBeNull();
    expect(git(repo.clone, 'log', '--format=%s', 'HEAD').split('\n')).toEqual([
      'S2',
      'S1',
      'H hotfix-only',
      'A',
    ]);
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('clears the pending base once the agent finished the rebase', async () => {
    repo = makeRetargetRepo({ conflictOnRelease: true });
    const sessionId = await freshSession();
    provision(sessionId, repo.clone);
    vi.spyOn(routeDeps, 'handleChat').mockResolvedValue(undefined);
    await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'release' })
      .expect(200);

    // Simulate the agent resolving: replay the session commits onto release.
    const fork = git(repo.clone, 'merge-base', 'HEAD', 'origin/main');
    try {
      git(repo.clone, 'rebase', '--onto', 'origin/release', fork);
    } catch {
      git(repo.clone, 'checkout', '--theirs', 'shared.txt');
      git(repo.clone, 'add', 'shared.txt');
      git(repo.clone, '-c', 'core.editor=true', 'rebase', '--continue');
    }

    const next = await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'hotfix' })
      .expect(200);
    expect(next.body.retarget).toMatchObject({ fromBranch: 'release', toBranch: 'hotfix' });
  });

  it('refuses with 409 and leaves a paused user rebase untouched', async () => {
    repo = makeRetargetRepo();
    const sessionId = await freshSession();
    provision(sessionId, repo.clone);
    execFileSync('git', ['rebase', '-i', 'HEAD~1'], {
      cwd: repo.clone,
      env: { ...process.env, GIT_SEQUENCE_EDITOR: "sed -i '1s/^pick/edit/'" },
      stdio: 'ignore',
    });

    const res = await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'release' })
      .expect(409);
    expect(res.body.error).toContain('rebase is already in progress');
    expect(existsSync(join(repo.clone, '.git', 'rebase-merge'))).toBe(true);
    const row = getDb()
      .prepare('SELECT pr_base_branch FROM sessions WHERE id = ?')
      .get(sessionId) as { pr_base_branch: string | null };
    expect(row.pr_base_branch).toBeNull();
  });

  it('flattens a merge history itself, keeping the merge-only change, and finishes', async () => {
    repo = makeRetargetRepo({ mergeOnlyChange: true });
    const sessionId = await freshSession();
    provision(sessionId, repo.clone);
    const before = git(repo.clone, 'rev-parse', 'HEAD');
    const handleChat = vi.spyOn(routeDeps, 'handleChat').mockResolvedValue(undefined);

    const res = await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'release' })
      .expect(200);

    expect(res.body.retarget).toMatchObject({
      kind: 'rebased',
      commits: 1,
      flattened: { originalHead: before, mergeCount: 1 },
    });
    expect(res.body.session.pr_base_pending_from ?? null).toBeNull();
    expect(git(repo.clone, 'show', 'HEAD:merge-only.txt')).toBe('only in the merge');
    expect(git(repo.clone, 'rev-parse', 'HEAD^')).toBe(repo.releaseTip);
    expect(git(repo.clone, 'rev-parse', res.body.retarget.flattened.backupRef)).toBe(before);
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('keeps retrying a conflicted retarget onto a descendant of the old base', async () => {
    repo = makeRetargetRepo({ conflictOnRelease: true, noMainOnly: true });
    const sessionId = await freshSession();
    provision(sessionId, repo.clone);
    getDb().prepare('UPDATE sessions SET ask_mode = 1 WHERE id = ?').run(sessionId);
    const before = git(repo.clone, 'rev-parse', 'HEAD');

    const first = await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'release' })
      .expect(200);
    expect(first.body.retarget).toMatchObject({ kind: 'conflict' });
    expect(first.body.session.pr_base_pending_from).toBe('main');
    expect(first.body.session.pr_base_pending_to_sha).toBe(repo.releaseTip);
    expect(first.body.session.pr_base_pending_fork_sha).toBe(repo.mainOnlySha);

    // Re-selecting must retry, not report "unchanged" off a cleared record.
    const again = await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'release' })
      .expect(200);
    expect(again.body.retarget).toMatchObject({ kind: 'conflict', fromBranch: 'main' });
    expect(again.body.session.pr_base_pending_from).toBe('main');
    expect(git(repo.clone, 'rev-parse', 'HEAD')).toBe(before);

    // The Finalize gate stays closed while it is unfinished.
    const changes = await request.get(`/api/sessions/${sessionId}/worktree-changes`).expect(200);
    expect(changes.body.committable).toBe(false);
  });

  function pendingRow(sessionId: string) {
    return getDb()
      .prepare(
        'SELECT pr_base_branch, pr_base_pending_from, pr_base_pending_to_sha, pr_base_pending_fork_sha, pr_base_pending_head_sha FROM sessions WHERE id = ?',
      )
      .get(sessionId) as Record<string, string | null>;
  }

  it('refuses to re-certify a pending retarget after a plain rebase carried old-base commits', async () => {
    repo = makeRetargetRepo({ conflictOnRelease: true });
    const sessionId = await freshSession();
    provision(sessionId, repo.clone);
    getDb().prepare('UPDATE sessions SET ask_mode = 1 WHERE id = ?').run(sessionId);
    await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'release' })
      .expect(200);
    const recorded = pendingRow(sessionId);
    expect(recorded.pr_base_pending_from).toBe('main');

    // The agent ignores --onto and plain-rebases, dragging B (main-only) along.
    try {
      git(repo.clone, 'rebase', 'origin/release');
    } catch {
      git(repo.clone, 'checkout', '--theirs', 'shared.txt');
      git(repo.clone, 'add', 'shared.txt');
      git(repo.clone, '-c', 'core.editor=true', 'rebase', '--continue');
    }
    expect(git(repo.clone, 'log', '--format=%s', 'HEAD')).toContain('B main-only');
    const rewritten = git(repo.clone, 'rev-parse', 'HEAD');

    const res = await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'release' })
      .expect(409);
    expect(res.body.error).toContain('history was rewritten');
    expect(res.body.error).toContain(
      `git reset --hard ${recorded.pr_base_pending_head_sha!.slice(0, 12)}`,
    );
    expect(pendingRow(sessionId)).toEqual(recorded);
    expect(git(repo.clone, 'rev-parse', 'HEAD')).toBe(rewritten);
  });

  it('refuses switching back to the original base while a rebase is open', async () => {
    repo = makeRetargetRepo({ conflictOnRelease: true });
    const sessionId = await freshSession();
    provision(sessionId, repo.clone);
    getDb().prepare('UPDATE sessions SET ask_mode = 1 WHERE id = ?').run(sessionId);
    await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'release' })
      .expect(200);
    const recorded = pendingRow(sessionId);

    // The agent starts the --onto rebase and stops at the conflict.
    const fork = git(repo.clone, 'merge-base', 'HEAD', 'origin/main');
    expect(() => git(repo!.clone, 'rebase', '--onto', 'origin/release', fork)).toThrow();
    expect(existsSync(join(repo.clone, '.git', 'rebase-merge'))).toBe(true);

    const res = await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'main' })
      .expect(409);
    expect(res.body.error).toContain('rebase is already in progress');
    expect(pendingRow(sessionId)).toEqual(recorded);
    expect(existsSync(join(repo.clone, '.git', 'rebase-merge'))).toBe(true);
  });

  it('retries from the recorded fork after the agent commits a dirty tree', async () => {
    repo = makeRetargetRepo();
    const sessionId = await freshSession();
    provision(sessionId, repo.clone);
    getDb().prepare('UPDATE sessions SET ask_mode = 1 WHERE id = ?').run(sessionId);
    writeFileSync(join(repo.clone, 'wip.txt'), 'wip\n');

    const first = await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'release' })
      .expect(200);
    expect(first.body.retarget).toMatchObject({ kind: 'dirty' });

    // The old base is deleted after the hand-off; the retry must not need it.
    git(join(repo.root, 'origin.git'), 'update-ref', '-d', 'refs/heads/main');
    // Committing appends to the hand-off HEAD; nothing is rewritten.
    git(repo.clone, 'add', 'wip.txt');
    git(repo.clone, 'commit', '-qm', 'S3 wip');

    const again = await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'release' })
      .expect(200);
    expect(again.body.retarget).toMatchObject({ kind: 'rebased', fromBranch: 'main', commits: 3 });
    expect(again.body.session.pr_base_pending_from ?? null).toBeNull();
    expect(git(repo.clone, 'log', '--format=%s', 'HEAD').split('\n')).toEqual([
      'S3 wip',
      'S2',
      'S1',
      'R release-only',
      'A',
    ]);
  });

  it('retargets session work that main absorbed before the first target change', async () => {
    repo = makeRetargetRepo();
    const sessionId = await freshSession();
    provision(sessionId, repo.clone);
    git(repo.clone, 'push', '-q', 'origin', 'HEAD:main');
    git(repo.clone, 'fetch', '-q', 'origin');

    const res = await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'release' })
      .expect(200);

    expect(res.body.retarget).toMatchObject({ kind: 'rebased', commits: 2 });
    expect(git(repo.clone, 'log', '--format=%s', 'HEAD').split('\n')).toEqual([
      'S2',
      'S1',
      'R release-only',
      'A',
    ]);
  });

  it('refuses (409) a retarget whose session work upstream absorbed below a merged commit', async () => {
    repo = makeRetargetRepo();
    const sessionId = await freshSession();
    provision(sessionId, repo.clone);
    const s1 = git(repo.clone, 'rev-parse', 'HEAD^');
    git(repo.clone, 'push', '-q', 'origin', `${s1}:main`);
    git(repo.seed, 'checkout', '-q', 'main');
    git(repo.seed, 'pull', '-q', 'origin', 'main');
    writeFileSync(join(repo.seed, 'newer-main.txt'), 'C\n');
    git(repo.seed, 'add', 'newer-main.txt');
    git(repo.seed, 'commit', '-qm', 'C newer main');
    git(repo.seed, 'push', '-q', 'origin', 'main');
    git(repo.clone, 'fetch', '-q', 'origin');
    git(repo.clone, 'merge', '-q', '--no-ff', '-m', 'M merge main', 'origin/main');
    const before = git(repo.clone, 'rev-parse', 'HEAD');

    const res = await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'release' })
      .expect(409);

    expect(res.body.error).toContain('already contains session work');
    expect(git(repo.clone, 'rev-parse', 'HEAD')).toBe(before);
    expect(pendingRow(sessionId).pr_base_branch).toBeNull();
  });

  it('does not carry upstream merged in after a hand-off when retrying', async () => {
    repo = makeRetargetRepo();
    const sessionId = await freshSession();
    provision(sessionId, repo.clone);
    getDb().prepare('UPDATE sessions SET ask_mode = 1 WHERE id = ?').run(sessionId);
    writeFileSync(join(repo.clone, 'wip.txt'), 'wip\n');
    await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'release' })
      .expect(200);

    // The agent commits the dirty tree, then merges newer main in.
    git(repo.clone, 'add', 'wip.txt');
    git(repo.clone, 'commit', '-qm', 'S3 wip');
    git(repo.seed, 'checkout', '-q', 'main');
    git(repo.seed, 'pull', '-q', 'origin', 'main');
    writeFileSync(join(repo.seed, 'newer-main.txt'), 'C\n');
    git(repo.seed, 'add', 'newer-main.txt');
    git(repo.seed, 'commit', '-qm', 'C newer main');
    git(repo.seed, 'push', '-q', 'origin', 'main');
    git(repo.clone, 'fetch', '-q', 'origin');
    git(repo.clone, 'merge', '-q', '--no-ff', '-m', 'M merge main', 'origin/main');

    const res = await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'release' })
      .expect(200);

    expect(res.body.retarget).toMatchObject({ kind: 'rebased' });
    expect(git(repo.clone, 'show', 'HEAD:wip.txt')).toBe('wip');
    expect(git(repo.clone, 'show', 'HEAD:session.txt')).toBe('session');
    expect(git(repo.clone, 'show', 'HEAD:release-only.txt')).toBe('release');
    expect(() => git(repo!.clone, 'show', 'HEAD:newer-main.txt')).toThrow();
    expect(() => git(repo!.clone, 'show', 'HEAD:main-only.txt')).toThrow();
  });

  it('marks the target as changed, including when the override is cleared', async () => {
    const sessionId = await freshSession();
    await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'release' })
      .expect(200);
    const cleared = await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: null })
      .expect(200);
    expect(cleared.body.session.pr_base_branch ?? null).toBeNull();
    expect(cleared.body.session.pr_base_target_changed).toBe(1);
  });

  it('refuses (409) after absorption followed by a forward rebase', async () => {
    repo = makeRetargetRepo();
    const sessionId = await freshSession();
    provision(sessionId, repo.clone);
    const s1 = git(repo.clone, 'rev-parse', 'HEAD^');
    git(repo.clone, 'push', '-q', 'origin', `${s1}:main`);
    git(repo.seed, 'checkout', '-q', 'main');
    git(repo.seed, 'pull', '-q', 'origin', 'main');
    writeFileSync(join(repo.seed, 'newer-main.txt'), 'C\n');
    git(repo.seed, 'add', 'newer-main.txt');
    git(repo.seed, 'commit', '-qm', 'C newer main');
    git(repo.seed, 'push', '-q', 'origin', 'main');
    git(repo.clone, 'fetch', '-q', 'origin');
    git(repo.clone, 'rebase', '-q', 'origin/main');
    const before = git(repo.clone, 'rev-parse', 'HEAD');

    const res = await request
      .put(`/api/sessions/${sessionId}/target-branch`)
      .send({ branch: 'release' })
      .expect(409);

    expect(res.body.error).toContain('already contains session work');
    expect(res.body.error).toContain(s1.slice(0, 7));
    expect(git(repo.clone, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('returns 409 while a turn holds the worktree lock', async () => {
    const sessionId = await freshSession();
    expect(tryAcquireSessionWorktreeLock(sessionId, 'turn-start')).toBe(true);
    try {
      await request
        .put(`/api/sessions/${sessionId}/target-branch`)
        .send({ branch: 'release' })
        .expect(409);
    } finally {
      releaseSessionWorktreeLock(sessionId, 'turn-start');
    }
  });

  it('returns 404 for an unknown session', async () => {
    await request
      .put('/api/sessions/does-not-exist/target-branch')
      .send({ branch: 'release' })
      .expect(404);
  });
});
