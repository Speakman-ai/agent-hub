/**
 * Finalize push step for Agent Hub-hosted projects: pushes to a bare-repo
 * origin with NO gh / token resolution, creates the native PR in-process,
 * reuses the open PR idempotently, and refuses non-Hub origins.
 */
import '../test/setup.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import config from '../config.js';
import { createPushAndCreatePr } from './push-and-create-pr.js';
import type { PushAndCreatePrArgs } from './orchestrator.js';
import type { NativePrService } from '../native-pr/service.js';
import type { AppConfig, Project } from '../types.js';

// `openaiApiKey: null` → the LLM PR-summary step is a no-op, so these tests
// exercise the deterministic buildPrDetails path unchanged.
const TEST_CONFIG = { openaiApiKey: null } as Pick<AppConfig, 'personalOAuth' | 'openaiApiKey'>;

// Controllable native-PR author resolver so a test can force the
// "no attributed Hub user" failure without mutating process-wide auth state.
const VALID_AUTHOR = '00000000-0000-4000-8000-000000000001';
const authorMock = vi.hoisted(() => ({
  resolve: (): string => '00000000-0000-4000-8000-000000000001',
}));
vi.mock('../native-pr/author-user.js', async (importActual) => {
  const actual = await importActual<typeof import('../native-pr/author-user.js')>();
  return { ...actual, resolveNativePrAuthorUserId: () => authorMock.resolve() };
});

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

describe('pushAndCreateNativePr (via createPushAndCreatePr host branch)', () => {
  let tmpRoot: string;
  let bare: string;
  let worktree: string;
  let project: Project;
  let projectId: string;

  beforeEach(() => {
    tmpRoot = path.join(
      os.tmpdir(),
      `pcp-agenthub-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    // The hosted bare repo must live under the (test) config dataDir —
    // that's where bareRepoPath() resolves the origin guard against.
    projectId = `proj-x-${uuidv4().slice(0, 8)}`;
    bare = path.join(config.dataDir, 'git', `${projectId}.git`);
    mkdirSync(bare, { recursive: true });
    execSync('git init --bare --initial-branch=main', { cwd: bare, stdio: 'pipe' });

    worktree = path.join(tmpRoot, 'worktree');
    mkdirSync(worktree, { recursive: true });
    execSync('git init --initial-branch=main', { cwd: worktree, stdio: 'pipe' });
    git(worktree, 'config user.email "t@example.com"');
    git(worktree, 'config user.name "T"');
    git(worktree, `remote add origin "${bare}"`);
    writeFileSync(path.join(worktree, 'base.txt'), 'base\n');
    git(worktree, 'add base.txt');
    git(worktree, 'commit -m initial');
    git(worktree, 'push -u origin main');
    git(worktree, 'checkout -b agent-hub/dev/session-12345678');
    writeFileSync(path.join(worktree, 'feat.txt'), 'feat\n');
    git(worktree, 'add feat.txt');
    git(worktree, 'commit -m "feat: add feature"');

    project = { id: projectId, name: projectId, cwd: '', ahw: '', gitHost: 'agenthub' } as Project;
    authorMock.resolve = () => VALID_AUTHOR;
  });

  afterEach(() => {
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeArgs(): PushAndCreatePrArgs {
    return {
      project,
      branch: 'agent-hub/dev/session-12345678',
      baseBranch: 'main',
      headSha: git(worktree, 'rev-parse HEAD'),
      worktreePath: worktree,
      authorUserId: '00000000-0000-4000-8000-000000000001',
      card: { id: 'card-1', title: 'Add feature', description: 'Feature card' },
    } as unknown as PushAndCreatePrArgs;
  }

  function makeNativePrStub() {
    const createOrGetOpenPr = vi.fn(
      (args: { project: Project; headBranch: string }) =>
        ({
          row: { number: 1 },
          prUrl: `/projects/${args.project.id}/pulls/1`,
          created: true,
        }) as ReturnType<NativePrService['createOrGetOpenPr']>,
    );
    return { service: { createOrGetOpenPr } as unknown as NativePrService, createOrGetOpenPr };
  }

  it('pushes the branch to the hosted bare repo and returns the native PR URL', async () => {
    const { service, createOrGetOpenPr } = makeNativePrStub();
    const fn = createPushAndCreatePr({ config: TEST_CONFIG, nativePr: service });

    const result = await fn(makeArgs());

    expect(result.prUrl).toBe(`/projects/${projectId}/pulls/1`);
    // Branch landed in the bare repo.
    expect(git(bare, 'rev-parse refs/heads/agent-hub/dev/session-12345678')).toBe(
      git(worktree, 'rev-parse HEAD'),
    );
    // Title/body derived from the implementation commit.
    const call = createOrGetOpenPr.mock.calls[0][0] as Record<string, unknown>;
    expect(call.title).toBe('feat: add feature');
    expect(String(call.body)).toContain('## Summary');
    expect(call.author).toBe('00000000-0000-4000-8000-000000000001');
    expect(call.baseBranch).toBe('main');
  });

  it('throws without pushing when the worktree origin is not the hosted repo', async () => {
    git(worktree, 'remote set-url origin https://github.com/owner/repo.git');
    const { service, createOrGetOpenPr } = makeNativePrStub();
    const fn = createPushAndCreatePr({ config: TEST_CONFIG, nativePr: service });

    await expect(fn(makeArgs())).rejects.toThrow(/agenthub push refused/);
    expect(createOrGetOpenPr).not.toHaveBeenCalled();
    expect(() => git(bare, 'rev-parse refs/heads/agent-hub/dev/session-12345678')).toThrow();
  });

  it('accepts an HTTP Hub origin (/git/<id>.git)', async () => {
    // Push first over the file origin so the remote ref exists, then point
    // origin at the HTTP shape — the guard must accept it (the push itself
    // is a no-op update in this test setup).
    git(worktree, 'push -u origin agent-hub/dev/session-12345678');
    git(worktree, `remote set-url origin "http://127.0.0.1:9/git/${projectId}.git"`);
    const { service } = makeNativePrStub();
    const fn = createPushAndCreatePr({ config: TEST_CONFIG, nativePr: service });
    // The push to the dead HTTP URL fails, but AFTER the origin guard —
    // proving the guard accepted the URL shape.
    await expect(fn(makeArgs())).rejects.toThrow(/git push failed/);
  });

  it('resolves the author before pushing — missing attribution fails without mutating the remote', async () => {
    // Regression: author attribution used to be resolved AFTER the push, so an
    // auth-enabled deployment with no session owner would strand a pushed
    // branch with no PR. Attribution must now fail before any remote mutation.
    authorMock.resolve = () => {
      throw new Error('Native PR creation requires an attributed Hub user');
    };
    const { service, createOrGetOpenPr } = makeNativePrStub();
    const fn = createPushAndCreatePr({ config: TEST_CONFIG, nativePr: service });

    await expect(fn(makeArgs())).rejects.toThrow(/attributed Hub user/);
    expect(createOrGetOpenPr).not.toHaveBeenCalled();
    // Crucially: the branch was never pushed to the bare origin.
    expect(() => git(bare, 'rev-parse refs/heads/agent-hub/dev/session-12345678')).toThrow();
  });

  it('throws a clear wiring error when nativePr is missing', async () => {
    const fn = createPushAndCreatePr({ config: TEST_CONFIG });
    await expect(fn(makeArgs())).rejects.toThrow(/native PR service is not wired/);
  });
});
