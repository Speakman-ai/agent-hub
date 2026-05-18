/**
 * Unit tests for the autonomous-mode umbrella feature branch helper +
 * dispatch-path contract.
 *
 * `createUmbrellaBranch` is tested in isolation by mocking child_process so
 * no real git operations happen. We verify:
 *   1. Branch names follow the `feature/autonomous-{epicId8}-{uuid8}` pattern.
 *   2. The function calls `git fetch` then `git rev-parse` then `git push`.
 *   3. It falls back gracefully when the remote ref can't be resolved.
 *   4. It falls back gracefully when git push fails.
 *
 * Dispatch-path contract (added when umbrella creation became opt-in):
 *   5. `runAutonomousLoop` MUST NOT auto-call `createUmbrellaBranch`. When
 *      `epic.pr_base_branch` is blank, PRs target the default branch; when
 *      it's set, the operator-supplied value is used as-is.
 */
import './setup.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

// ── mock child_process BEFORE importing the module under test ──────────────
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

import { execFile } from 'child_process';
import {
  createUmbrellaBranch,
  ensureOperatorBaseBranch,
  lastOperatorBaseBranchFailureSignature,
} from '../autonomous.js';
import type { KanbanEpicRow, Project } from '../types.js';

const mockedExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

// Minimal fake project + epic for the helper
function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test Project',
    cwd: '/tmp/fake-repo',
    ahw: '/tmp/fake-workspace',
    agents: [],
    ...overrides,
  } as unknown as Project;
}

function makeEpic(overrides: Partial<KanbanEpicRow> = {}): KanbanEpicRow {
  return {
    id: 'aabbccdd-eeff-0011-2233-445566778899',
    board_id: 'board-1',
    name: 'Test Epic',
    description: null,
    color: '#3B82F6',
    autonomous: 1,
    autonomous_interval: 60,
    autonomous_max_concurrent: 2,
    autonomous_model: null,
    orchestration_budgets_json: null,
    pr_base_branch: null,
    position: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Simulate a successful execFile call returning stdout. */
function mockExecSuccess(stdout: string) {
  return (_cmd: unknown, _args: unknown, _opts: unknown, cb: (...args: unknown[]) => void) => {
    cb(null, { stdout, stderr: '' });
  };
}

/** Simulate a failing execFile call. */
function mockExecFail(msg: string) {
  return (_cmd: unknown, _args: unknown, _opts: unknown, cb: (...args: unknown[]) => void) => {
    cb(new Error(msg), { stdout: '', stderr: '' });
  };
}

beforeEach(() => {
  mockedExecFile.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createUmbrellaBranch', () => {
  it('returns a branch name matching the feature/autonomous- prefix pattern', async () => {
    // fetch → success, rev-parse origin/HEAD → sha, push → success
    let callIdx = 0;
    mockedExecFile.mockImplementation(
      (_cmd: unknown, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        callIdx++;
        if (callIdx === 1) {
          // git fetch origin --depth=1
          expect(args).toContain('fetch');
          cb(null, { stdout: '', stderr: '' });
        } else if (callIdx === 2) {
          // git rev-parse origin/HEAD
          expect(args).toContain('rev-parse');
          cb(null, { stdout: 'abc1234567890def\n', stderr: '' });
        } else {
          // git push origin sha:refs/heads/...
          expect(args).toContain('push');
          cb(null, { stdout: '', stderr: '' });
        }
      },
    );

    const result = await createUmbrellaBranch(makeProject(), makeEpic());
    expect(result).not.toBeNull();
    expect(result).toMatch(/^feature\/autonomous-[a-f0-9]{8}-[a-f0-9]{8}$/);
  });

  it('falls back to origin/main when origin/HEAD resolution fails', async () => {
    let callIdx = 0;
    mockedExecFile.mockImplementation(
      (_cmd: unknown, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        callIdx++;
        if (callIdx === 1) {
          // fetch
          cb(null, { stdout: '', stderr: '' });
        } else if (callIdx === 2) {
          // rev-parse origin/HEAD → fail
          cb(new Error('unknown ref'), { stdout: '', stderr: '' });
        } else if (callIdx === 3) {
          // rev-parse origin/main → success
          expect(args).toContain('rev-parse');
          expect(args).toContain('origin/main');
          cb(null, { stdout: 'deadbeef1234\n', stderr: '' });
        } else {
          // push
          cb(null, { stdout: '', stderr: '' });
        }
      },
    );

    const result = await createUmbrellaBranch(makeProject(), makeEpic());
    expect(result).toMatch(/^feature\/autonomous-/);
  });

  it('returns null when all ref resolutions fail', async () => {
    let callIdx = 0;
    mockedExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: (...a: unknown[]) => void) => {
        callIdx++;
        if (callIdx === 1) {
          // fetch
          cb(null, { stdout: '', stderr: '' });
        } else {
          // all rev-parse attempts fail
          cb(new Error('bad ref'), { stdout: '', stderr: '' });
        }
      },
    );

    const result = await createUmbrellaBranch(makeProject(), makeEpic());
    expect(result).toBeNull();
  });

  it('returns null when git push fails', async () => {
    let callIdx = 0;
    mockedExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: (...a: unknown[]) => void) => {
        callIdx++;
        if (callIdx === 1) {
          // fetch
          cb(null, { stdout: '', stderr: '' });
        } else if (callIdx === 2) {
          // rev-parse origin/HEAD
          cb(null, { stdout: 'abc123\n', stderr: '' });
        } else {
          // push → fail
          cb(new Error('permission denied'), { stdout: '', stderr: '' });
        }
      },
    );

    const result = await createUmbrellaBranch(makeProject(), makeEpic());
    expect(result).toBeNull();
  });

  it('returns null immediately when project.cwd is empty', async () => {
    const result = await createUmbrellaBranch(makeProject({ cwd: '' }), makeEpic());
    expect(result).toBeNull();
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it('does NOT get auto-invoked from runAutonomousLoop (umbrella creation is opt-in)', () => {
    // Contract: when an operator leaves `epic.pr_base_branch` blank, the
    // dispatch path must NOT auto-create a `feature/autonomous-...` branch.
    // This is enforced as a source-shape assertion: the body of
    // `runAutonomousLoop` must not contain a call to `createUmbrellaBranch`.
    // If a future change re-introduces auto-creation, this test fails.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.resolve(here, '..', 'autonomous.ts'), 'utf8');

    // Locate the runAutonomousLoop function body.
    // `runAutonomousLoop` is now a thin per-epic single-flight gate; the
    // dispatch body lives in `runAutonomousLoopInner`. Scan that function's
    // body for the source-shape assertions below.
    const startMatch = src.match(/async function runAutonomousLoopInner\b/);
    expect(startMatch, 'runAutonomousLoopInner definition not found in autonomous.ts').toBeTruthy();
    const start = startMatch!.index!;

    // Walk braces to find the end of the function body.
    const openBrace = src.indexOf('{', start);
    expect(openBrace).toBeGreaterThan(start);
    let depth = 0;
    let end = -1;
    for (let i = openBrace; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(end, 'runAutonomousLoop function body braces are unbalanced').toBeGreaterThan(openBrace);

    const body = src.slice(openBrace, end + 1);
    expect(
      body.includes('createUmbrellaBranch('),
      'runAutonomousLoop must not call createUmbrellaBranch — umbrella branches are now opt-in via operator-set pr_base_branch',
    ).toBe(false);
  });

  it('embeds the first 8 hex chars of the epic id (dashes stripped) in the branch name', async () => {
    const epicId = 'aabbccdd-eeff-0011-2233-445566778899';
    // 'aabbccdd-eeff-...' → remove dashes → 'aabbccddeeff...' → first 8 → 'aabbccdd'
    const expectedPrefix = 'aabbccdd';

    mockedExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: (...a: unknown[]) => void) => {
        cb(null, { stdout: 'sha123\n', stderr: '' });
      },
    );

    const result = await createUmbrellaBranch(makeProject(), makeEpic({ id: epicId }));
    expect(result).toMatch(new RegExp(`^feature\\/autonomous-${expectedPrefix}-`));
  });
});

describe('ensureOperatorBaseBranch', () => {
  it('returns "skipped" when branch name is null/empty/whitespace', async () => {
    expect(await ensureOperatorBaseBranch(makeProject(), null)).toBe('skipped');
    expect(await ensureOperatorBaseBranch(makeProject(), '')).toBe('skipped');
    expect(await ensureOperatorBaseBranch(makeProject(), '   ')).toBe('skipped');
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it('returns "skipped" without touching git when project.cwd is empty', async () => {
    const result = await ensureOperatorBaseBranch(makeProject({ cwd: '' }), 'feature/auth');
    expect(result).toBe('skipped');
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it('returns "skipped" for the reserved auto-generated umbrella prefix', async () => {
    const result = await ensureOperatorBaseBranch(
      makeProject(),
      'feature/autonomous-aabbccdd-11223344',
    );
    expect(result).toBe('skipped');
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it('returns "invalid" and never pushes when the branch name fails safe-regex', async () => {
    const result = await ensureOperatorBaseBranch(makeProject(), 'feature/auth;rm -rf /');
    expect(result).toBe('invalid');
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it('returns "exists" when ls-remote finds the branch on origin (no push)', async () => {
    let pushCalled = false;
    mockedExecFile.mockImplementation(
      (_cmd: unknown, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        if (args[0] === 'fetch') return cb(null, { stdout: '', stderr: '' });
        if (args[0] === 'ls-remote') {
          // Real ls-remote output looks like: "<sha>\trefs/heads/<name>"
          return cb(null, { stdout: 'abc1234\trefs/heads/feature/auth\n', stderr: '' });
        }
        if (args[0] === 'push') pushCalled = true;
        cb(null, { stdout: '', stderr: '' });
      },
    );

    const result = await ensureOperatorBaseBranch(makeProject(), 'feature/auth');
    expect(result).toBe('exists');
    expect(pushCalled).toBe(false);
  });

  it('creates the branch when ls-remote returns empty (operator-set name, rooted at origin/HEAD)', async () => {
    const pushArgs: string[][] = [];
    mockedExecFile.mockImplementation(
      (_cmd: unknown, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        if (args[0] === 'fetch') return cb(null, { stdout: '', stderr: '' });
        if (args[0] === 'ls-remote') return cb(null, { stdout: '', stderr: '' });
        if (args[0] === 'rev-parse' && args[1] === 'origin/HEAD') {
          return cb(null, { stdout: 'deadbeef1234567890\n', stderr: '' });
        }
        if (args[0] === 'push') {
          pushArgs.push(args);
          return cb(null, { stdout: '', stderr: '' });
        }
        cb(null, { stdout: '', stderr: '' });
      },
    );

    const result = await ensureOperatorBaseBranch(makeProject(), 'feature/auth');
    expect(result).toBe('created');
    expect(pushArgs).toHaveLength(1);
    // Verify the push uses the operator-supplied name, not an auto-generated one
    expect(pushArgs[0]).toEqual(['push', 'origin', 'deadbeef1234567890:refs/heads/feature/auth']);
  });

  it('falls back to origin/main when origin/HEAD rev-parse fails, still creating the operator branch', async () => {
    const pushArgs: string[][] = [];
    mockedExecFile.mockImplementation(
      (_cmd: unknown, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        if (args[0] === 'fetch') return cb(null, { stdout: '', stderr: '' });
        if (args[0] === 'ls-remote') return cb(null, { stdout: '', stderr: '' });
        if (args[0] === 'rev-parse' && args[1] === 'origin/HEAD') {
          return cb(new Error('unknown ref'), { stdout: '', stderr: '' });
        }
        if (args[0] === 'rev-parse' && args[1] === 'origin/main') {
          return cb(null, { stdout: 'mainshaaaaa\n', stderr: '' });
        }
        if (args[0] === 'push') {
          pushArgs.push(args);
          return cb(null, { stdout: '', stderr: '' });
        }
        cb(null, { stdout: '', stderr: '' });
      },
    );

    const result = await ensureOperatorBaseBranch(makeProject(), 'feature/auth');
    expect(result).toBe('created');
    expect(pushArgs[0]).toEqual(['push', 'origin', 'mainshaaaaa:refs/heads/feature/auth']);
  });

  it('returns "failed" when push fails (e.g. permission denied) — caller treats as non-fatal', async () => {
    mockedExecFile.mockImplementation(
      (_cmd: unknown, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        if (args[0] === 'fetch') return cb(null, { stdout: '', stderr: '' });
        if (args[0] === 'ls-remote') return cb(null, { stdout: '', stderr: '' });
        if (args[0] === 'rev-parse') return cb(null, { stdout: 'sha\n', stderr: '' });
        if (args[0] === 'push')
          return cb(new Error('permission denied'), { stdout: '', stderr: '' });
        cb(null, { stdout: '', stderr: '' });
      },
    );

    const result = await ensureOperatorBaseBranch(makeProject(), 'feature/auth');
    expect(result).toBe('failed');
  });

  it('returns "failed" when all rev-parse candidates fail (no SHA to push)', async () => {
    let pushCalled = false;
    mockedExecFile.mockImplementation(
      (_cmd: unknown, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        if (args[0] === 'fetch') return cb(null, { stdout: '', stderr: '' });
        if (args[0] === 'ls-remote') return cb(null, { stdout: '', stderr: '' });
        if (args[0] === 'rev-parse')
          return cb(new Error('unknown ref'), { stdout: '', stderr: '' });
        if (args[0] === 'push') pushCalled = true;
        cb(null, { stdout: '', stderr: '' });
      },
    );

    const result = await ensureOperatorBaseBranch(makeProject(), 'feature/auth');
    expect(result).toBe('failed');
    expect(pushCalled).toBe(false);
  });

  it('tolerates a fetch failure and still performs the ls-remote check', async () => {
    mockedExecFile.mockImplementation(
      (_cmd: unknown, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        if (args[0] === 'fetch') return cb(new Error('network down'), { stdout: '', stderr: '' });
        if (args[0] === 'ls-remote') {
          // ls-remote talks to origin directly and finds the branch
          return cb(null, { stdout: 'abc\trefs/heads/feature/auth\n', stderr: '' });
        }
        cb(null, { stdout: '', stderr: '' });
      },
    );

    const result = await ensureOperatorBaseBranch(makeProject(), 'feature/auth');
    expect(result).toBe('exists');
  });
});

describe('ensureOperatorBaseBranch — per-user GitHub credential injection', () => {
  beforeEach(() => {
    lastOperatorBaseBranchFailureSignature.clear();
  });

  /**
   * Captures the `env` passed to every git exec call so we can assert the
   * credential wiring (GH_TOKEN, GIT_CONFIG_KEY_*) matches what the
   * auto-commit/push path uses.
   */
  function captureExecEnv(stdoutByVerb: Record<string, string> = {}) {
    const envs: NodeJS.ProcessEnv[] = [];
    mockedExecFile.mockImplementation(
      (
        _cmd: unknown,
        args: string[],
        opts: { env?: NodeJS.ProcessEnv },
        cb: (...a: unknown[]) => void,
      ) => {
        envs.push(opts?.env ?? {});
        const verb = args[0];
        const stdout = stdoutByVerb[verb] ?? '';
        cb(null, { stdout, stderr: '' });
      },
    );
    return envs;
  }

  it('injects GH_TOKEN and the credential helper into every git child when a token resolves', async () => {
    // The test process env may already carry GH_TOKEN / GIT_CONFIG_KEY_* from
    // the outer agent's spawn. We assert on the *delta*: GH_TOKEN now points
    // at the resolved token, and two new credential-helper entries (empty +
    // working) have been appended on top of whatever was inherited.
    const preCount = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '0', 10) || 0;

    const envs = captureExecEnv({
      // ls-remote returns empty → triggers the rev-parse + push flow,
      // exercising every git verb in the function.
      'ls-remote': '',
      'rev-parse': 'deadbeefcafef00d\n',
    });

    const outcome = await ensureOperatorBaseBranch(makeProject(), 'feature/auth', {
      resolveToken: async () => 'gho_test_token_42',
    });
    expect(outcome).toBe('created');

    // At least the fetch + ls-remote + rev-parse + push must have run with the
    // injected env. (`createUmbrellaBranch` and other helpers in the file are
    // unchanged; this assertion is scoped to ensureOperatorBaseBranch.)
    expect(envs.length).toBeGreaterThanOrEqual(4);
    for (const env of envs) {
      // GH_TOKEN is reset to the resolved value regardless of what was inherited.
      expect(env.GH_TOKEN).toBe('gho_test_token_42');
      expect(env.GITHUB_TOKEN).toBe('gho_test_token_42');
      // autoGitChildEnv appends exactly two entries:
      //   index N    : empty-helper sentinel (clears inherited helpers)
      //   index N+1  : working helper that emits username=x-access-token + password=$GH_TOKEN
      const postCount = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
      expect(postCount).toBe(preCount + 2);
      expect(env[`GIT_CONFIG_KEY_${preCount}`]).toBe('credential.https://github.com.helper');
      expect(env[`GIT_CONFIG_VALUE_${preCount}`]).toBe('');
      expect(env[`GIT_CONFIG_KEY_${preCount + 1}`]).toBe('credential.https://github.com.helper');
      expect((env[`GIT_CONFIG_VALUE_${preCount + 1}`] ?? '').length).toBeGreaterThan(0);
    }
  });

  it('appends the empty-helper sentinel and scrubs inherited GH_TOKEN when no token resolves (auto-git identity isolation)', async () => {
    // Identity isolation in `autoGitChildEnv` is unconditional: even when no
    // session-owner token resolves, the empty-helper sentinel is appended and
    // any inherited `GH_TOKEN` / `GITHUB_TOKEN` is scrubbed so the host
    // operator's `gh auth login` (typically the GitHub-App installation)
    // cannot piggy-back into our `git push` / `gh pr create` calls. Without
    // this, PRs that should be authored by the session owner end up opened
    // by the bot.
    const preCount = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '0', 10) || 0;

    const envs = captureExecEnv({
      'ls-remote': 'abc\trefs/heads/feature/auth\n',
    });

    const outcome = await ensureOperatorBaseBranch(makeProject(), 'feature/auth', {
      resolveToken: async () => null,
    });
    expect(outcome).toBe('exists');
    expect(envs.length).toBeGreaterThanOrEqual(2);
    for (const env of envs) {
      // Empty-helper sentinel appended.
      const postCount = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
      expect(postCount).toBe(preCount + 1);
      expect(env[`GIT_CONFIG_KEY_${preCount}`]).toBe('credential.https://github.com.helper');
      expect(env[`GIT_CONFIG_VALUE_${preCount}`]).toBe('');
      // Host-inherited token vars scrubbed.
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
    }
  });

  it('always scrubs inherited GH_TOKEN and appends the empty-helper sentinel when called without opts', async () => {
    const preCount = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '0', 10) || 0;

    const envs: NodeJS.ProcessEnv[] = [];
    mockedExecFile.mockImplementation(
      (
        _cmd: unknown,
        args: string[],
        opts: { env?: NodeJS.ProcessEnv } | undefined,
        cb: (...a: unknown[]) => void,
      ) => {
        envs.push(opts?.env ?? {});
        const verb = args[0];
        cb(null, {
          stdout: verb === 'ls-remote' ? 'abc\trefs/heads/feature/auth\n' : '',
          stderr: '',
        });
      },
    );

    const outcome = await ensureOperatorBaseBranch(makeProject(), 'feature/auth');
    expect(outcome).toBe('exists');
    // Without opts the function passes `env: autoGitChildEnv(null)`. The
    // post-fix shape always carries the empty-helper sentinel + scrubbed
    // token vars; there is no longer a "no isolation when no token" mode.
    for (const env of envs) {
      const postCount = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
      expect(postCount).toBe(preCount + 1);
      expect(env[`GIT_CONFIG_KEY_${preCount}`]).toBe('credential.https://github.com.helper');
      expect(env[`GIT_CONFIG_VALUE_${preCount}`]).toBe('');
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
    }
  });

  it('debounces repeated failure logs by signature (project,branch,errorline) — only logs once per change', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockedExecFile.mockImplementation(
      (_cmd: unknown, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        if (args[0] === 'fetch') return cb(null, { stdout: '', stderr: '' });
        if (args[0] === 'ls-remote') {
          // Fail with the same error every tick — the classic auth failure.
          return cb(new Error("Authentication failed for 'https://github.com/example/repo.git/'"), {
            stdout: '',
            stderr: '',
          });
        }
        cb(null, { stdout: '', stderr: '' });
      },
    );

    const project = makeProject();

    // Three back-to-back ticks with the same failure → exactly one error line.
    expect(
      await ensureOperatorBaseBranch(project, 'feature/auth', { resolveToken: async () => 'tok' }),
    ).toBe('failed');
    expect(
      await ensureOperatorBaseBranch(project, 'feature/auth', { resolveToken: async () => 'tok' }),
    ).toBe('failed');
    expect(
      await ensureOperatorBaseBranch(project, 'feature/auth', { resolveToken: async () => 'tok' }),
    ).toBe('failed');

    const failureCalls = errorSpy.mock.calls.filter((c) =>
      String(c[0] ?? '').includes('Failed to ensure operator base branch'),
    );
    expect(failureCalls).toHaveLength(1);

    errorSpy.mockRestore();
  });

  it('re-logs when the failure signature changes (new underlying error)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    let errorMessage = 'first error';
    mockedExecFile.mockImplementation(
      (_cmd: unknown, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        if (args[0] === 'fetch') return cb(null, { stdout: '', stderr: '' });
        if (args[0] === 'ls-remote') {
          return cb(new Error(errorMessage), { stdout: '', stderr: '' });
        }
        cb(null, { stdout: '', stderr: '' });
      },
    );

    const project = makeProject();
    await ensureOperatorBaseBranch(project, 'feature/auth', { resolveToken: async () => 'tok' });
    await ensureOperatorBaseBranch(project, 'feature/auth', { resolveToken: async () => 'tok' });
    errorMessage = 'second different error';
    await ensureOperatorBaseBranch(project, 'feature/auth', { resolveToken: async () => 'tok' });

    const failureCalls = errorSpy.mock.calls.filter((c) =>
      String(c[0] ?? '').includes('Failed to ensure operator base branch'),
    );
    // First error logged once (3rd tick suppressed); second error logged once.
    expect(failureCalls).toHaveLength(2);

    errorSpy.mockRestore();
  });

  it('clears the debounce slot on success so a later failure logs again', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    let mode: 'fail' | 'exists' = 'fail';
    mockedExecFile.mockImplementation(
      (_cmd: unknown, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        if (args[0] === 'fetch') return cb(null, { stdout: '', stderr: '' });
        if (args[0] === 'ls-remote') {
          if (mode === 'fail') return cb(new Error('auth failed'), { stdout: '', stderr: '' });
          return cb(null, { stdout: 'abc\trefs/heads/feature/auth\n', stderr: '' });
        }
        cb(null, { stdout: '', stderr: '' });
      },
    );

    const project = makeProject();
    expect(
      await ensureOperatorBaseBranch(project, 'feature/auth', { resolveToken: async () => 'tok' }),
    ).toBe('failed'); // logs once
    expect(
      await ensureOperatorBaseBranch(project, 'feature/auth', { resolveToken: async () => 'tok' }),
    ).toBe('failed'); // suppressed by debounce
    mode = 'exists';
    expect(
      await ensureOperatorBaseBranch(project, 'feature/auth', { resolveToken: async () => 'tok' }),
    ).toBe('exists'); // clears the slot
    mode = 'fail';
    expect(
      await ensureOperatorBaseBranch(project, 'feature/auth', { resolveToken: async () => 'tok' }),
    ).toBe('failed'); // logs again because the slot is cleared

    const failureCalls = errorSpy.mock.calls.filter((c) =>
      String(c[0] ?? '').includes('Failed to ensure operator base branch'),
    );
    expect(failureCalls).toHaveLength(2);

    errorSpy.mockRestore();
  });

  it('emits a single "connect a GitHub account" warning when no token is reachable, debounced across ticks', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockedExecFile.mockImplementation(
      (_cmd: unknown, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        if (args[0] === 'fetch') return cb(null, { stdout: '', stderr: '' });
        if (args[0] === 'ls-remote') {
          // Probe still runs unauthenticated — exists path keeps it noise-free
          return cb(null, { stdout: 'abc\trefs/heads/feature/auth\n', stderr: '' });
        }
        cb(null, { stdout: '', stderr: '' });
      },
    );

    const project = makeProject();
    await ensureOperatorBaseBranch(project, 'feature/auth', { resolveToken: async () => null });
    await ensureOperatorBaseBranch(project, 'feature/auth', { resolveToken: async () => null });
    await ensureOperatorBaseBranch(project, 'feature/auth', { resolveToken: async () => null });

    const noTokenWarnings = errorSpy.mock.calls.filter((c) =>
      String(c[0] ?? '').includes('No per-user GitHub credential reachable'),
    );
    expect(noTokenWarnings).toHaveLength(1);
    expect(String(noTokenWarnings[0][0])).toContain('Settings → Integrations');

    errorSpy.mockRestore();
  });
});

describe('runAutonomousLoop — operator base branch contract', () => {
  it('runAutonomousLoop calls ensureOperatorBaseBranch when epic.pr_base_branch is set, not when blank', () => {
    // Source-shape assertion: the dispatch loop must reach for
    // `ensureOperatorBaseBranch` (gated by an `epic.pr_base_branch` truthiness
    // check) so an operator-typed branch is created before per-card PRs try
    // to target it.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.resolve(here, '..', 'autonomous.ts'), 'utf8');

    // `runAutonomousLoop` is now a thin per-epic single-flight gate; the
    // dispatch body lives in `runAutonomousLoopInner`. Scan that function's
    // body for the source-shape assertions below.
    const startMatch = src.match(/async function runAutonomousLoopInner\b/);
    expect(startMatch, 'runAutonomousLoopInner definition not found in autonomous.ts').toBeTruthy();
    const start = startMatch!.index!;
    const openBrace = src.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (let i = openBrace; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = src.slice(openBrace, end + 1);
    expect(
      body.includes('ensureOperatorBaseBranch('),
      'runAutonomousLoop must call ensureOperatorBaseBranch so operator-set epic.pr_base_branch values are auto-created on origin before PRs target them',
    ).toBe(true);
    // And it must be guarded by an explicit truthiness check so blank values
    // don't trigger any git work.
    expect(
      /epic\.pr_base_branch\s*&&[\s\S]{0,200}ensureOperatorBaseBranch\(/.test(body),
      'ensureOperatorBaseBranch must only be called when epic.pr_base_branch is truthy',
    ).toBe(true);
  });
});
