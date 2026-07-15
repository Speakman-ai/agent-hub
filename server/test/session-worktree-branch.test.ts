/**
 * Tests for `PUT /api/sessions/:sessionId/worktree-branch` — the session Branch
 * picker that positions a worktree on an existing remote branch.
 *
 * The endpoint is the general form of the resolve-PR head-branch mechanism, so
 * the guards matter: it must reject unsafe branch names, refuse to mutate a
 * session after code work begins, and refuse sessions that don't use a
 * worktree.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { vi } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createProject, createAgent, createSession } from './helpers.js';
import { getDb } from '../db.js';
import { routeDeps } from '../index.js';
import {
  releaseSessionWorktreeLock,
  tryAcquireSessionWorktreeLock,
} from '../session-worktree-lock.js';

const checkWorktreeChangesMock = vi.hoisted(() => vi.fn());
vi.mock('../auto-git.js', async () => {
  const actual = await vi.importActual<typeof import('../auto-git.js')>('../auto-git.js');
  checkWorktreeChangesMock.mockImplementation(actual.checkWorktreeChanges);
  return { ...actual, checkWorktreeChanges: checkWorktreeChangesMock };
});

let request: supertest.Agent;

interface SessionBody {
  id: string;
  worktree_checkout_branch?: string | null;
  worktree_path?: string | null;
  worktree_branch?: string | null;
}

async function freshWorktreeSession(): Promise<string> {
  const project = await createProject();
  const agent = await createAgent({ projectId: project.id as string });
  const session = (await createSession({
    agentId: agent.id as string,
  })) as unknown as SessionBody;
  return session.id;
}

beforeAll(async () => {
  request = await getRequest();
});

describe('PUT /api/sessions/:sessionId/worktree-branch', () => {
  it('records a chosen existing branch on a not-yet-provisioned worktree session', async () => {
    const sessionId = await freshWorktreeSession();

    const res = await request
      .put(`/api/sessions/${sessionId}/worktree-branch`)
      .send({ branch: 'feature/existing-work' })
      .expect(200);
    expect((res.body as SessionBody).worktree_checkout_branch).toBe('feature/existing-work');

    // Persisted, so a later GET reflects the choice.
    const detail = await request.get(`/api/sessions/${sessionId}`).expect(200);
    expect((detail.body as SessionBody).worktree_checkout_branch).toBe('feature/existing-work');
  });

  it('clears the choice when branch is null', async () => {
    const sessionId = await freshWorktreeSession();

    await request
      .put(`/api/sessions/${sessionId}/worktree-branch`)
      .send({ branch: 'feature/foo' })
      .expect(200);
    const cleared = await request
      .put(`/api/sessions/${sessionId}/worktree-branch`)
      .send({ branch: null })
      .expect(200);
    expect((cleared.body as SessionBody).worktree_checkout_branch ?? null).toBeNull();
  });

  it('rejects unsafe branch names (leading dash, "..") with 400 and does not mutate', async () => {
    const sessionId = await freshWorktreeSession();

    await request
      .put(`/api/sessions/${sessionId}/worktree-branch`)
      .send({ branch: '-oops' })
      .expect(400);
    await request
      .put(`/api/sessions/${sessionId}/worktree-branch`)
      .send({ branch: 'feature/../etc' })
      .expect(400);
    await request
      .put(`/api/sessions/${sessionId}/worktree-branch`)
      .send({ branch: '' })
      .expect(400);

    const detail = await request.get(`/api/sessions/${sessionId}`).expect(200);
    expect((detail.body as SessionBody).worktree_checkout_branch ?? null).toBeNull();
  });

  it('returns 400 when the session does not use a worktree', async () => {
    const sessionId = await freshWorktreeSession();
    getDb().prepare('UPDATE sessions SET use_worktree = 0 WHERE id = ?').run(sessionId);

    await request
      .put(`/api/sessions/${sessionId}/worktree-branch`)
      .send({ branch: 'feature/foo' })
      .expect(400);
  });

  it('switches a clean, provisioned session onto an existing branch', async () => {
    const sessionId = await freshWorktreeSession();
    const worktreePath = mkdtempSync(join(tmpdir(), 'agent-hub-branch-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: worktreePath });
    writeFileSync(join(worktreePath, 'README.md'), 'test\n');
    execFileSync('git', ['add', 'README.md'], { cwd: worktreePath });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Agent Hub Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-qm',
        'init',
      ],
      { cwd: worktreePath },
    );
    const switchSpy = vi
      .spyOn(routeDeps, 'switchSessionWorkspaceBranch')
      .mockResolvedValue({ worktreePath, branch: 'feature/foo' });

    try {
      getDb()
        .prepare(
          'UPDATE sessions SET worktree_path = ?, worktree_branch = ?, code_changed_at = NULL WHERE id = ?',
        )
        .run(worktreePath, 'agent-hub/x/session-y', sessionId);

      const res = await request
        .put(`/api/sessions/${sessionId}/worktree-branch`)
        .send({ branch: 'feature/foo' });
      expect(res.status).toBe(200);

      expect(switchSpy).toHaveBeenCalledWith(sessionId, 'feature/foo');
      expect((res.body as SessionBody).worktree_branch).toBe('feature/foo');
      expect((res.body as SessionBody).worktree_path).toBe(worktreePath);
    } finally {
      switchSpy.mockRestore();
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('rejects a concurrent switch before the first worktree check completes', async () => {
    const sessionId = await freshWorktreeSession();
    const worktreePath = mkdtempSync(join(tmpdir(), 'agent-hub-branch-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: worktreePath });
    writeFileSync(join(worktreePath, 'README.md'), 'test\n');
    execFileSync('git', ['add', 'README.md'], { cwd: worktreePath });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Agent Hub Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-qm',
        'init',
      ],
      { cwd: worktreePath },
    );

    let releaseCheck!: () => void;
    let resolveCheckStarted!: () => void;
    const checkStarted = new Promise<void>((resolve) => {
      resolveCheckStarted = resolve;
    });
    const defaultCheckWorktreeChanges = checkWorktreeChangesMock.getMockImplementation()!;
    checkWorktreeChangesMock.mockImplementation(async (cwd: string) => {
      if (cwd !== worktreePath) return defaultCheckWorktreeChanges(cwd);
      resolveCheckStarted();
      await new Promise<void>((resolveRelease) => {
        releaseCheck = resolveRelease;
      });
      return { hasUncommitted: false, hasUnpushed: false, branch: 'main', headSha: 'test' };
    });
    const switchSpy = vi
      .spyOn(routeDeps, 'switchSessionWorkspaceBranch')
      .mockResolvedValue({ worktreePath, branch: 'feature/foo' });

    try {
      getDb()
        .prepare(
          'UPDATE sessions SET worktree_path = ?, worktree_branch = ?, code_changed_at = NULL WHERE id = ?',
        )
        .run(worktreePath, 'agent-hub/x/session-y', sessionId);

      const firstResponsePromise = request
        .put(`/api/sessions/${sessionId}/worktree-branch`)
        .send({ branch: 'feature/foo' })
        .then((response) => response);
      await checkStarted;

      const secondResponse = await request
        .put(`/api/sessions/${sessionId}/worktree-branch`)
        .send({ branch: 'feature/bar' });
      expect(secondResponse.status).toBe(409);
      expect(secondResponse.body.error).toBe('The session is already starting or switching a turn');

      releaseCheck();
      expect((await firstResponsePromise).status).toBe(200);
      expect(switchSpy).toHaveBeenCalledTimes(1);
    } finally {
      checkWorktreeChangesMock.mockImplementation(defaultCheckWorktreeChanges);
      switchSpy.mockRestore();
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('rejects a switch while a turn has reserved the session startup', async () => {
    const sessionId = await freshWorktreeSession();
    getDb()
      .prepare(
        'UPDATE sessions SET worktree_path = ?, worktree_branch = ?, code_changed_at = NULL WHERE id = ?',
      )
      .run('/tmp/some/worktree', 'agent-hub/x/session-y', sessionId);
    const switchSpy = vi.spyOn(routeDeps, 'switchSessionWorkspaceBranch');

    expect(tryAcquireSessionWorktreeLock(sessionId, 'turn-start')).toBe(true);
    try {
      const response = await request
        .put(`/api/sessions/${sessionId}/worktree-branch`)
        .send({ branch: 'feature/foo' });
      expect(response.status).toBe(409);
      expect(response.body.error).toBe('The session is already starting or switching a turn');
      expect(switchSpy).not.toHaveBeenCalled();
    } finally {
      releaseSessionWorktreeLock(sessionId, 'turn-start');
      switchSpy.mockRestore();
    }
  });

  it('returns 409 once the worktree has code changes', async () => {
    const sessionId = await freshWorktreeSession();
    getDb()
      .prepare(
        'UPDATE sessions SET worktree_path = ?, worktree_branch = ?, code_changed_at = ? WHERE id = ?',
      )
      .run('/tmp/some/worktree', 'agent-hub/x/session-y', '2026-07-15T16:00:00.000Z', sessionId);

    await request
      .put(`/api/sessions/${sessionId}/worktree-branch`)
      .send({ branch: 'feature/foo' })
      .expect(409);
  });

  it('returns 404 for an unknown session', async () => {
    await request
      .put(`/api/sessions/does-not-exist/worktree-branch`)
      .send({ branch: 'feature/foo' })
      .expect(404);
  });
});
