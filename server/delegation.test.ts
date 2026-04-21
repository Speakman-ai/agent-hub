import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import os from 'os';

// Mock child_process.spawn BEFORE importing the module under test.
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// buildSpawnEnv pokes a few env-sensitive helpers — stub to a bare object.
vi.mock('./config.js', () => ({
  buildSpawnEnv: vi.fn(() => ({})),
}));

import { spawn } from 'child_process';
import {
  initDelegation,
  handleDelegation,
  handleDelegationCancel,
  buildDelegationSynthesisPrompt,
} from './delegation.js';
import type { BroadcastFn, EnrichedAgent, Project, Stmts } from './types.js';

/**
 * Minimal ChildProcess fake: an EventEmitter with .stdout/.stderr streams and
 * a .kill() hook. Tests drive it by calling `finish(code, { stdout, stderr })`
 * or `fail(err)` to simulate exit/spawn-error.
 */
function makeFakeProc(): {
  proc: EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (sig?: string) => void;
  };
  finish: (code: number, opts?: { stdout?: string; stderr?: string }) => void;
  fail: (err: Error) => void;
} {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn((sig?: string) => {
      // Real SIGTERM ends the process → `close` on stdout/stderr pipes then exit.
      void sig;
      proc.emit('close', null);
    }),
  });
  return {
    proc,
    finish: (code, opts) => {
      if (opts?.stdout) proc.stdout.emit('data', Buffer.from(opts.stdout));
      if (opts?.stderr) proc.stderr.emit('data', Buffer.from(opts.stderr));
      proc.emit('close', code);
    },
    fail: (err) => proc.emit('error', err),
  };
}

type FakeProc = ReturnType<typeof makeFakeProc>;

/** Build a stub Stmts with the two delegation statements this path touches. */
function makeStmts() {
  const createDelegation = { run: vi.fn() };
  const updateDelegation = { run: vi.fn() };
  return {
    stmts: { createDelegation, updateDelegation } as unknown as Stmts,
    createDelegation,
    updateDelegation,
  };
}

function makeAgent(id: string, overrides: Partial<EnrichedAgent> = {}): EnrichedAgent {
  return {
    id,
    name: id,
    engine: 'claude-code',
    model: 'sonnet',
    color: '#fff',
    cwd: '/tmp',
    workspace: '/tmp',
    ...overrides,
  } as unknown as EnrichedAgent;
}

describe('handleDelegation — retry logic', () => {
  let tmpWorkspace: string;
  let fakeProcs: FakeProc[];
  let project: Project;
  let leadAgent: EnrichedAgent;
  let subAgent: EnrichedAgent;
  let broadcast: ReturnType<typeof vi.fn>;
  let stmts: ReturnType<typeof makeStmts>;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpWorkspace = mkdtempSync(path.join(os.tmpdir(), 'delegation-test-'));
    fakeProcs = [];
    broadcast = vi.fn();
    stmts = makeStmts();
    subAgent = makeAgent('sub-1');
    leadAgent = makeAgent('lead', { subAgents: ['sub-1'] } as Partial<EnrichedAgent>);
    project = {
      id: 'proj',
      name: 'Proj',
      slug: 'proj',
      cwd: '/tmp',
      ahw: tmpWorkspace,
      color: '#000',
      agentIds: ['lead', 'sub-1'],
    } as unknown as Project;

    // Every call to spawn() returns a fresh fake proc and records it.
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const fp = makeFakeProc();
      fakeProcs.push(fp);
      return fp.proc;
    });

    initDelegation({
      stmts: stmts.stmts,
      broadcast: broadcast as unknown as BroadcastFn,
      getEnrichedAgent: (id) => (id === 'sub-1' ? subAgent : null),
      buildEnrichedPrompt: () => 'prompt',
      saveErrorMessage: vi.fn(),
      appendDailyNote: (workspace: string, entry: string) => {
        // Minimal stand-in matching the real appendDailyNote signature —
        // writes to <workspace>/memory/<today>.md so tests can inspect it.
        const dir = path.join(workspace, 'memory');
        mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.md`);
        const existing = existsSync(file) ? readFileSync(file, 'utf-8') : '';
        writeFileSync(file, existing + entry + '\n\n');
      },
      getActiveProcesses: () => new Map(),
      getClaudeBin: () => '/bin/claude',
      getDefaultModel: () => 'sonnet',
      getConfig: () =>
        ({
          conferenceTimeoutMs: 600000,
          delegationMaxAttempts: 3,
          delegationRetryBackoffMs: 0, // no wait between attempts in tests
        }) as unknown as import('./types.js').AppConfig,
    });
  });

  afterEach(() => {
    rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  /**
   * Drain microtasks + one macrotask. Retries schedule `setTimeout(…, 0)`
   * for the backoff so plain `await Promise.resolve()` isn't enough.
   */
  async function flush(_count = 1) {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  it('retries on failure and succeeds on a later attempt', async () => {
    const pending = handleDelegation(
      'session-1',
      'msg-1',
      [{ agentId: 'sub-1', task: 'do the thing' }],
      leadAgent,
      project,
      '/tmp',
    );

    // Attempt 1: exit non-zero, no stdout → retry path triggered.
    await flush();
    expect(fakeProcs.length).toBe(1);
    fakeProcs[0].finish(1, { stderr: 'boom' });

    // Attempt 2: succeeds with stdout.
    await flush(5);
    expect(fakeProcs.length).toBe(2);
    fakeProcs[1].finish(0, { stdout: 'great success' });

    const results = await pending;
    expect(results).toHaveLength(1);
    expect(results[0].output).toBe('great success');
    expect(results[0].error).toBeNull();

    // Retry broadcast emitted for the failed first attempt.
    const retryEvents = broadcast.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === 'delegation_agent_retry');
    expect(retryEvents).toHaveLength(1);
    expect(retryEvents[0]).toMatchObject({
      attempt: 1,
      maxAttempts: 3,
      error: 'boom',
    });

    // TOOL_ERROR is NOT logged on eventual success.
    const memDir = path.join(tmpWorkspace, 'memory');
    const files = existsSync(memDir) ? readdirSync(memDir) : [];
    expect(files).toHaveLength(0);
  });

  it('exhausts retries, returns error result, logs TOOL_ERROR', async () => {
    const pending = handleDelegation(
      'session-2',
      'msg-2',
      [{ agentId: 'sub-1', task: 'impossible task' }],
      leadAgent,
      project,
      '/tmp',
    );

    // Fail all three attempts.
    for (let i = 0; i < 3; i++) {
      await flush(5);
      expect(fakeProcs.length).toBe(i + 1);
      fakeProcs[i].finish(1, { stderr: `fail-${i + 1}` });
    }

    const results = await pending;
    expect(results).toHaveLength(1);
    expect(results[0].output).toBeNull();
    expect(results[0].error).toMatch(/failed after 3 attempts/);
    expect(results[0].error).toContain('fail-3');

    // delegation_agent_error broadcast with attempts=3.
    const errEvents = broadcast.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === 'delegation_agent_error');
    expect(errEvents).toHaveLength(1);
    expect(errEvents[0].attempts).toBe(3);

    // Exactly 2 retry broadcasts (attempt 1 and 2 — the third is the final).
    const retryEvents = broadcast.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === 'delegation_agent_retry');
    expect(retryEvents).toHaveLength(2);

    // TOOL_ERROR line written to daily note.
    const memDir = path.join(tmpWorkspace, 'memory');
    const files = readdirSync(memDir);
    expect(files).toHaveLength(1);
    const note = readFileSync(path.join(memDir, files[0]), 'utf-8');
    expect(note).toMatch(/TOOL_ERROR \|/);
    expect(note).toContain('delegation');
    expect(note).toContain('sub-1:impossible task');
    expect(note).toContain('dispatch_failed');
    expect(note).toContain('attempts=3');

    // DB row moved to 'error' with the descriptive message.
    const errCalls = stmts.updateDelegation.run.mock.calls.filter((c) => c[0] === 'error');
    expect(errCalls).toHaveLength(1);
    expect(errCalls[0][2]).toMatch(/failed after 3 attempts/);
  });

  it('spawn() error (e.g. ENOENT) is retried', async () => {
    const pending = handleDelegation(
      'session-3',
      'msg-3',
      [{ agentId: 'sub-1', task: 'x' }],
      leadAgent,
      project,
      '/tmp',
    );

    await flush();
    fakeProcs[0].fail(new Error('ENOENT: no claude binary'));

    await flush(5);
    expect(fakeProcs.length).toBe(2);
    fakeProcs[1].finish(0, { stdout: 'recovered' });

    const results = await pending;
    expect(results[0].output).toBe('recovered');
    expect(results[0].error).toBeNull();
  });

  it('returns Cancelled with task text when user cancels mid-run', async () => {
    const pending = handleDelegation(
      'session-cancel-1',
      'msg-c1',
      [{ agentId: 'sub-1', task: 'parallel research' }],
      leadAgent,
      project,
      '/tmp',
    );

    await flush();
    expect(fakeProcs.length).toBe(1);
    handleDelegationCancel('session-cancel-1');
    await flush(5);

    const results = await pending;
    expect(results).toHaveLength(1);
    expect(results[0].error).toBe('Cancelled');
    expect(results[0].task).toBe('parallel research');
    expect(results[0].output).toBeNull();

    const cancelledDb = stmts.updateDelegation.run.mock.calls.filter((c) => c[0] === 'cancelled');
    expect(cancelledDb.length).toBeGreaterThanOrEqual(1);

    const cancelledBroadcasts = broadcast.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === 'delegation_cancelled');
    expect(cancelledBroadcasts).toHaveLength(1);

    const agentErrAfterCancel = broadcast.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === 'delegation_agent_error');
    expect(agentErrAfterCancel).toHaveLength(0);
  });
});

describe('buildDelegationSynthesisPrompt', () => {
  it('instructs the lead to take over when any delegation was cancelled', () => {
    const prompt = buildDelegationSynthesisPrompt(
      [
        {
          agentId: 'sub-1',
          agentName: 'Sub',
          task: 'Fix the login bug',
          output: null,
          error: 'Cancelled',
        },
      ],
      'Please fix auth',
    );
    expect(prompt).toContain('lead must take over');
    expect(prompt).toContain('Fix the login bug');
    expect(prompt).toContain('Please fix auth');
    expect(prompt).toContain('Delegation cancellation');
  });

  it('uses the standard synthesis template when nothing was cancelled', () => {
    const prompt = buildDelegationSynthesisPrompt(
      [
        {
          agentId: 'sub-1',
          agentName: 'Sub',
          task: 'Do X',
          output: 'Done',
          error: null,
        },
      ],
      'Hi',
    );
    expect(prompt).toContain('Your team completed the delegated tasks');
    expect(prompt).not.toContain('lead must take over');
  });

  it('still uses takeover mode when one of several tasks was cancelled', () => {
    const prompt = buildDelegationSynthesisPrompt(
      [
        {
          agentId: 'a1',
          agentName: 'A',
          task: 'task one',
          output: 'ok',
          error: null,
        },
        {
          agentId: 'a2',
          agentName: 'B',
          task: 'task two',
          output: null,
          error: 'Cancelled',
        },
      ],
      'Original',
    );
    expect(prompt).toContain('lead must take over');
    expect(prompt).toContain('Sub-agents that finished');
    expect(prompt).toContain('Cancelled — you must carry out yourself');
    expect(prompt).toContain('task one');
    expect(prompt).toContain('task two');
  });

  it('surfaces non-cancel failures alongside cancelled rows in takeover mode', () => {
    const prompt = buildDelegationSynthesisPrompt(
      [
        {
          agentId: 'x',
          agentName: 'X',
          task: 'do a',
          output: null,
          error: 'Delegation to X failed after 1 attempts: nope',
        },
        {
          agentId: 'y',
          agentName: 'Y',
          task: 'do b',
          output: null,
          error: 'Cancelled',
        },
      ],
      'orig',
    );
    expect(prompt).toContain('Failed (not user-cancel)');
    expect(prompt).toContain('nope');
    expect(prompt).toContain('Cancelled — you must carry out yourself');
  });
});
