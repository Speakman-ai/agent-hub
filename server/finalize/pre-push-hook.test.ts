/**
 * Pre-push hook runner against a real throwaway git repo. The hook is plain
 * bash, so nothing here spawns an agent CLI.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parsePrePushHookPatch,
  resolvePrePushHook,
  runPrePushHook,
  PrePushHookError,
  hookFailureReason,
  PRE_PUSH_HOOK_DEFAULT_TIMEOUT_SEC,
} from './pre-push-hook.js';

let repo: string;
let head: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'pre-push-hook-test-'));
  git('init', '-q', '-b', 'agent-hub/dev/session-1');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  writeFileSync(path.join(repo, 'a.txt'), 'a');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  head = git('rev-parse', 'HEAD');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/**
 * True once `pid` no longer runs. A killed orphan is reparented to PID 1,
 * which in a CI container may never reap it, so a zombie counts as gone
 * (`kill(pid, 0)` still succeeds on a zombie).
 */
function isGone(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state === 'Z' || state === 'X';
  } catch {
    // No /proc entry (process gone, or no /proc on this OS): fall back to a probe.
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function run(command: string, extra: { existingPrUrl?: string | null } = {}) {
  return runPrePushHook({
    hook: { command, timeoutMs: 10_000 },
    worktreePath: repo,
    branch: 'agent-hub/dev/session-1',
    baseBranch: 'main',
    headSha: head,
    env: process.env,
    context: {
      sessionId: 'sess-1',
      cardId: 'card-1',
      cardTitle: 'Fix MRN reassignment',
      githubRepo: 'acme/app',
      existingPrUrl: extra.existingPrUrl ?? null,
    },
  });
}

describe('runPrePushHook', () => {
  it('returns the renamed branch and the PR body text the hook wrote', async () => {
    const result = await run(
      'git branch -m "42-$(echo "$AGENT_HUB_CARD_TITLE" | tr "A-Z " "a-z-")" && ' +
        'echo "Fixes #42" >> "$AGENT_HUB_PR_BODY_APPEND"',
    );
    expect(result).toEqual({ branch: '42-fix-mrn-reassignment', prBodyAppend: 'Fixes #42' });
  });

  it('passes push context in the environment', async () => {
    const result = await run(
      'printf "%s|%s|%s|%s|%s" "$AGENT_HUB_BRANCH" "$AGENT_HUB_BASE_BRANCH" ' +
        '"$AGENT_HUB_SESSION_ID" "$AGENT_HUB_GITHUB_REPO" "$AGENT_HUB_EXISTING_PR_URL" ' +
        '> "$AGENT_HUB_PR_BODY_APPEND"',
      { existingPrUrl: 'https://github.com/acme/app/pull/9' },
    );
    expect(result.prBodyAppend).toBe(
      'agent-hub/dev/session-1|main|sess-1|acme/app|https://github.com/acme/app/pull/9',
    );
    expect(result.branch).toBe('agent-hub/dev/session-1');
  });

  it('fails the push with the hook output on a non-zero exit', async () => {
    await expect(run('echo "issue create refused" >&2; exit 3')).rejects.toThrow(
      /pre-push hook failed[\s\S]*issue create refused/,
    );
  });

  it('keeps stdout in the failure message', async () => {
    await expect(run("printf 'diagnostic line\\n'; exit 3")).rejects.toThrow(
      /pre-push hook failed: exit 3:\n[\s\S]*diagnostic line/,
    );
  });

  it('reports a timeout with the output so far', async () => {
    const err = await runPrePushHook({
      hook: { command: 'echo started; sleep 5', timeoutMs: 300 },
      worktreePath: repo,
      branch: 'agent-hub/dev/session-1',
      baseBranch: 'main',
      headSha: head,
      env: process.env,
      context: {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrePushHookError);
    expect((err as Error).message).toMatch(/timed out after 1s[\s\S]*started/);
  });

  it('fails on timeout even when bash already exited 0 behind a background child', async () => {
    const err = await runPrePushHook({
      hook: { command: 'sleep 30 & echo started', timeoutMs: 300 },
      worktreePath: repo,
      branch: 'agent-hub/dev/session-1',
      baseBranch: 'main',
      headSha: head,
      env: process.env,
      context: {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrePushHookError);
    expect((err as Error).message).toMatch(/timed out after 1s:\n[\s\S]*started/);
  });

  it('kills processes the hook started when it times out', async () => {
    const pidFile = path.join(repo, '..', `${path.basename(repo)}.pid`);
    await runPrePushHook({
      hook: { command: `sleep 30 & echo $! > ${pidFile}; wait`, timeoutMs: 300 },
      worktreePath: repo,
      branch: 'agent-hub/dev/session-1',
      baseBranch: 'main',
      headSha: head,
      env: process.env,
      context: {},
    }).catch(() => {});
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    rmSync(pidFile, { force: true });
    let gone = isGone(pid);
    for (let i = 0; i < 40 && !gone; i++) {
      await new Promise((r) => setTimeout(r, 50));
      gone = isGone(pid);
    }
    expect(gone).toBe(true);
  });

  it('reports the renamed branch when the hook fails after renaming', async () => {
    const err = await run('git branch -m 9-renamed; exit 1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrePushHookError);
    expect((err as PrePushHookError).branch).toBe('9-renamed');
  });

  it('reports the renamed branch when the hook times out after renaming', async () => {
    const err = await runPrePushHook({
      hook: { command: 'git branch -m 10-renamed && sleep 5', timeoutMs: 500 },
      worktreePath: repo,
      branch: 'agent-hub/dev/session-1',
      baseBranch: 'main',
      headSha: head,
      env: process.env,
      context: {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrePushHookError);
    expect((err as Error).message).toMatch(/timed out/);
    expect((err as PrePushHookError).branch).toBe('10-renamed');
  });

  it('refuses when the hook commits', async () => {
    await expect(run('git commit -q --allow-empty -m sneaky')).rejects.toThrow(/moved HEAD/);
  });

  it('refuses a detached HEAD', async () => {
    await expect(run('git checkout -q --detach')).rejects.toThrow(/detached HEAD/);
  });
});

describe('resolvePrePushHook', () => {
  it('applies only to enabled hooks with a command on GitHub-backed projects', () => {
    const hook = { enabled: true, command: ' echo hi ' };
    expect(resolvePrePushHook({ prePushHook: hook })).toEqual({
      command: 'echo hi',
      timeoutMs: PRE_PUSH_HOOK_DEFAULT_TIMEOUT_SEC * 1000,
    });
    expect(resolvePrePushHook({ gitHost: 'agenthub', prePushHook: hook })).toBeNull();
    expect(resolvePrePushHook({ prePushHook: { ...hook, enabled: false } })).toBeNull();
    expect(resolvePrePushHook({ prePushHook: { enabled: true, command: '  ' } })).toBeNull();
    expect(resolvePrePushHook({ prePushHook: { ...hook, timeoutSec: 30 } })?.timeoutMs).toBe(
      30_000,
    );
  });
});

describe('hookFailureReason', () => {
  const base = {
    code: 0,
    signal: null,
    timedOut: false,
    timeoutMs: 2000,
    spawnError: null,
    stdout: '',
    stderr: '',
  };
  it('succeeds only on a timely, started, exit-0 run', () => {
    expect(hookFailureReason(base)).toBeNull();
    expect(hookFailureReason({ ...base, timedOut: true })).toBe('timed out after 2s');
    expect(hookFailureReason({ ...base, spawnError: 'ENOENT' })).toBe('could not start: ENOENT');
    expect(hookFailureReason({ ...base, code: null, signal: 'SIGKILL' })).toBe('killed by SIGKILL');
    expect(hookFailureReason({ ...base, code: null })).toBe('ended without an exit code');
    expect(hookFailureReason({ ...base, code: 2, stdout: 'out', stderr: 'err' })).toBe(
      'exit 2:\nout\nerr',
    );
  });
});

describe('parsePrePushHookPatch', () => {
  it('accepts partial objects and null', () => {
    expect(parsePrePushHookPatch(null)).toEqual({ ok: true, value: null });
    expect(parsePrePushHookPatch({ enabled: true })).toEqual({
      ok: true,
      value: { enabled: true },
    });
  });

  it('rejects bad shapes', () => {
    for (const bad of [
      'x',
      [],
      { enabled: 1 },
      { command: false },
      { timeoutSec: 1.5 },
      { timeoutSec: 99999 },
      { command: 'x'.repeat(20_001) },
    ]) {
      expect(parsePrePushHookPatch(bad).ok).toBe(false);
    }
  });
});
