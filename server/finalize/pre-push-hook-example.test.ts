/**
 * The example hook offered in project settings, run for real against a
 * throwaway repo with a fake `gh` on PATH. It must fail (so Finalize does not
 * push) whenever issue creation or the branch rename fails.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PRE_PUSH_HOOK_EXAMPLE } from '../../shared/utils/prePushHookExample.js';
import { PrePushHookError, runPrePushHook } from './pre-push-hook.js';

let root: string;
let repo: string;
let bin: string;
let head: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

/** Fake gh: prints `stdout` and exits with `code` for `gh issue create`. */
function fakeGh(stdout: string, code = 0) {
  writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(stdout)}\nexit ${code}\n`,
  );
  chmodSync(path.join(bin, 'gh'), 0o755);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'pre-push-example-'));
  repo = path.join(root, 'repo');
  bin = path.join(root, 'bin');
  mkdirSync(repo);
  mkdirSync(bin);
  git('init', '-q', '-b', 'agent-hub/dev/session-1');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  writeFileSync(path.join(repo, 'a'), 'a');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  head = git('rev-parse', 'HEAD');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(cardTitle = 'Fix MRN reassignment', branch = 'agent-hub/dev/session-1') {
  return runPrePushHook({
    hook: { command: PRE_PUSH_HOOK_EXAMPLE, timeoutMs: 10_000 },
    worktreePath: repo,
    branch,
    baseBranch: 'main',
    headSha: head,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    context: { cardTitle },
  });
}

describe('PRE_PUSH_HOOK_EXAMPLE', () => {
  it('renames the branch to <issue#>-<slug> and adds Fixes #<issue#>', async () => {
    fakeGh('https://github.com/acme/app/issues/123');
    expect(await run()).toEqual({
      branch: '123-fix-mrn-reassignment',
      prBodyAppend: 'Fixes #123',
    });
  });

  it('fails without renaming when gh issue create fails', async () => {
    fakeGh('HTTP 403: Resource not accessible', 1);
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrePushHookError);
    expect((err as PrePushHookError).branch).toBe('agent-hub/dev/session-1');
  });

  it('fails without renaming when gh prints no issue number', async () => {
    fakeGh('https://github.com/acme/app/issues/');
    const err = await run().catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/returned no issue number/);
    expect((err as PrePushHookError).branch).toBe('agent-hub/dev/session-1');
  });

  it('fails when the target branch name already exists', async () => {
    fakeGh('https://github.com/acme/app/issues/7');
    git('branch', '7-fix-mrn-reassignment');
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrePushHookError);
    expect((err as Error).message).toMatch(/already exists/);
    expect((err as PrePushHookError).branch).toBe('agent-hub/dev/session-1');
  });

  it('re-links the issue on a retry after the push failed, without a new issue', async () => {
    fakeGh('https://github.com/acme/app/issues/123');
    const first = await run();
    expect(first.branch).toBe('123-fix-mrn-reassignment');

    // The push failed; Finalize retries with the branch recorded on the
    // session. A second issue must not be created.
    fakeGh('gh must not be called on retry', 1);
    expect(await run('Fix MRN reassignment', first.branch)).toEqual({
      branch: '123-fix-mrn-reassignment',
      prBodyAppend: 'Fixes #123',
    });
  });

  it('does not read an issue number from a branch that merely starts with digits', async () => {
    git('branch', '-m', '2fa-login');
    fakeGh('https://github.com/acme/app/issues/9');
    expect(await run('Fix 2FA login', '2fa-login')).toEqual({
      branch: '9-fix-2fa-login',
      prBodyAppend: 'Fixes #9',
    });
  });
});
