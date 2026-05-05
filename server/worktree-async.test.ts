import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
  default: { defaultCwd: '/tmp' },
}));

// Spy on `execFile` so we can assert on the env / timeout / args flowing
// from `runGit` into the child_process layer without actually shelling
// out to git. The factory replaces `execFile` with a deterministic stub
// that resolves immediately for inspection-only commands.
//
// Important: vi.mock factory cannot reference outer-scope vars at
// hoist-time, so we reach the recorded calls back through a top-level
// container variable populated inside the factory. (Standard vitest
// pattern for spying on transitive deps of an async module under test.)
const recorded: { calls: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> } =
  { calls: [] };

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  // Note on the callback shape: `util.promisify(execFile)` resolves to
  // `{ stdout, stderr }`. Internally that's because Node tags the real
  // `execFile` with a private `customPromisifyArgs` symbol, which the
  // spread above does NOT copy. With the symbol missing, `promisify`
  // falls back to its default semantics — first non-err callback arg
  // becomes the resolve value — so our stub passes a single object.
  // (worktree.ts then destructures `const { stdout } = ...` against it.)
  const stubExecFile = (
    file: string,
    args: string[],
    opts: Record<string, unknown>,
    cb: (err: Error | null, value: { stdout: string; stderr: string }) => void,
  ): void => {
    recorded.calls.push({ file, args, opts });
    setImmediate(() => cb(null, { stdout: '', stderr: '' }));
  };
  return {
    ...actual,
    execFile: stubExecFile,
  };
});

const { __test, isGitRepo, getOrCreateProcessWorktree } = await import('./worktree.js');

describe('worktree — fail-fast git env contract', () => {
  beforeEach(() => {
    recorded.calls = [];
  });

  it('exposes the documented timeouts', () => {
    // The 5s short-op timeout is the fix from this PR for the unbounded
    // execSyncs at lines 12, 21, 40, 44, 85, 91 in the pre-refactor code.
    expect(__test.SHORT_GIT_TIMEOUT_MS).toBe(5000);
    expect(__test.FETCH_TIMEOUT_MS).toBe(30000);
    expect(__test.CLONE_TIMEOUT_MS).toBe(60000);
  });

  it('builds a fail-fast git env with non-interactive overrides', () => {
    const env = __test.gitEnv();
    // Without GIT_TERMINAL_PROMPT=0 git silently waits on stdin for
    // credentials when an authenticated remote rejects creds, which is
    // the proximate cause of the multi-minute event-loop stalls
    // observed on PID 19954.
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    // Without BatchMode=yes / ConnectTimeout=5, ssh-based remotes
    // (auth prompt, hung agent) produce the same indefinite stall.
    expect(env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes -o ConnectTimeout=5');
    // PATH must still flow through so the spawned `git` is findable.
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('isGitRepo invokes git via execFile with the fail-fast env and a 5s timeout', async () => {
    const ok = await isGitRepo('/tmp');
    // Stub resolves with empty stdout — execution path treats that as success.
    expect(ok).toBe(true);
    expect(recorded.calls.length).toBe(1);

    const [call] = recorded.calls;
    expect(call.file).toBe('git');
    expect(call.args).toEqual(['rev-parse', '--git-dir']);
    expect(call.opts.cwd).toBe('/tmp');
    expect(call.opts.timeout).toBe(5000);

    const env = call.opts.env as NodeJS.ProcessEnv;
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes -o ConnectTimeout=5');
  });

  it('returns a real Promise from getOrCreateProcessWorktree (not a sync string)', () => {
    // Regression guard: callers in heartbeat.ts / workflow-runner.ts /
    // chat.ts now `await` this. A future drop back to a sync return
    // would mask the event-loop-stall fix without breaking those
    // callers immediately. The shape contract here pins it.
    //
    // We deliberately do NOT await the result — the underlying call walks
    // the filesystem looking for a git repo and, under parallel load,
    // can outrun the vitest 15s timeout. The shape check is enough to
    // guard the regression; suppress the eventual rejection so vitest
    // doesn't flag an unhandled rejection.
    const result = getOrCreateProcessWorktree('/nonexistent/path/that/does/not/exist', 'test-key');
    expect(typeof (result as Promise<string>).then).toBe('function');
    (result as Promise<string>).catch(() => {});
  });
});
