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
// Must retain the real default export: delegation pulls agent-skills-list → db,
// and db initializes from `config.default.dataDir` at module load.
vi.mock('./config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config.js')>();
  return {
    ...actual,
    buildSpawnEnv: vi.fn(() => ({})),
    defaultModelForEngine: vi.fn((engine: string) =>
      engine === 'cursor-agent'
        ? 'gpt-default'
        : engine === 'codex-cli'
          ? 'gpt-5.3-codex'
          : engine === 'gemini-cli'
            ? 'gemini-2.5-pro'
            : 'claude-default',
    ),
  };
});

vi.mock('./codex-auth.js', () => ({
  detectCodexAuthMode: vi.fn(() => ({
    mode: 'apikey' as const,
    path: '/tmp/mock-codex-auth',
    present: false,
  })),
  shouldPassModelFlag: vi.fn(() => true),
}));

import { spawn } from 'child_process';
import {
  initDelegation,
  handleDelegation,
  handleDelegationCancel,
  synthesizeResults,
  buildDelegationSynthesisPrompt,
  type DelegationDeps,
} from './delegation.js';
import type { BroadcastFn, EnrichedAgent, Project, SessionRow, Stmts } from './types.js';

/**
 * Minimal ChildProcess fake: an EventEmitter with .stdout/.stderr streams and
 * a .kill() hook. Tests drive it by calling `finish(code, { stdout, stderr })`
 * or `fail(err)` to simulate exit/spawn-error.
 */
function makeFakeProc(): {
  proc: EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (sig?: string) => void;
  };
  finish: (code: number, opts?: { stdout?: string; stderr?: string }) => void;
  fail: (err: Error) => void;
} {
  const proc = Object.assign(new EventEmitter(), {
    // High fake pid that's well above /proc/sys/kernel/pid_max on every
    // supported host. killProcessGroup will call `process.kill(-pid, sig)`
    // which the kernel rejects with ESRCH; the helper then falls through
    // to `proc.kill(signal)` which the mock below handles. Without a pid
    // killProcessGroup short-circuits and `close` never fires, so cancel
    // tests deadlock.
    pid: 99_999_999,
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

/** Lead session `ask_mode` for `stmts.getSession.get(sessionId)` in delegate tests (0 = off). */
let delegationLeadAskMode = 0;

/** Host `codexDangerBypass` returned by `getConfig()` in delegate tests. */
let delegationCodexDangerBypass = false;

/** Build a stub Stmts with delegation statements + session lookup for Ask Mode parity. */
function makeStmts() {
  const createDelegation = { run: vi.fn() };
  const updateDelegation = { run: vi.fn() };
  const getSession = {
    get: vi.fn((_id: string) => ({ ask_mode: delegationLeadAskMode })),
  };
  // Used by the no-valid-tasks path to persist a system-message into the
  // lead's session — see persistDelegationSkipSystemMessage in delegation.ts.
  const addMessage = { run: vi.fn() };
  const touchSession = { run: vi.fn() };
  const getMessageById = { get: vi.fn((id: string) => ({ id, role: 'system' })) };
  return {
    stmts: {
      createDelegation,
      updateDelegation,
      getSession,
      addMessage,
      touchSession,
      getMessageById,
    } as unknown as Stmts,
    createDelegation,
    updateDelegation,
    getSession,
    addMessage,
    touchSession,
    getMessageById,
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

function delegateTask(task: string) {
  return {
    agentId: 'sub-1',
    task,
    owner: 'hub-backend',
    scope: 'Implement only server-side changes for this task.',
    expectedArtifact: 'Code patch + test updates',
    deadline: 'end-of-turn',
    returnFormat: 'summary + changed files + test status',
  };
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
    delegationLeadAskMode = 0;
    delegationCodexDangerBypass = false;
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
      buildEnrichedPrompt: (() => 'prompt') as DelegationDeps['buildEnrichedPrompt'],
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
      getCursorBin: () => '/bin/cursor',
      getGeminiBin: () => '/bin/gemini',
      getCodexBin: () => '/bin/codex',
      getDefaultModel: () => 'sonnet',
      getConfig: () =>
        ({
          conferenceTimeoutMs: 600000,
          delegationMaxAttempts: 3,
          delegationRetryBackoffMs: 0, // no wait between attempts in tests
          codexDangerBypass: delegationCodexDangerBypass,
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
      [delegateTask('do the thing')],
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
      [delegateTask('impossible task')],
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
    expect(results[0].error).toContain('Attempt trace');

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
      [delegateTask('x')],
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
      [delegateTask('parallel research')],
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

  it('uses Cursor CLI when sub-agent engine is cursor-agent', async () => {
    subAgent = makeAgent('sub-1', {
      engine: 'cursor-agent',
      model: 'gpt-5.3-codex-high',
    } as Partial<EnrichedAgent>);
    leadAgent = makeAgent('lead', { subAgents: ['sub-1'] } as Partial<EnrichedAgent>);

    const pending = handleDelegation(
      'session-cursor',
      'msg-cursor',
      [delegateTask('inspect api')],
      leadAgent,
      project,
      '/tmp',
    );

    await flush();
    expect(fakeProcs.length).toBe(1);
    const spawnCalls = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(spawnCalls[0][0]).toBe('/bin/cursor');
    const argv = spawnCalls[0][1] as string[];
    expect(argv[0]).toBe('-p');
    expect(argv.join(' ')).toContain('--force');

    fakeProcs[0].finish(0, { stdout: 'cursor sub output' });

    const results = await pending;
    expect(results[0].output).toBe('cursor sub output');
    expect(results[0].error).toBeNull();
  });

  it('uses Gemini CLI + JSONL stream assembly for gemini-cli sub-agent', async () => {
    subAgent = makeAgent('sub-1', {
      engine: 'gemini-cli',
      model: 'gemini-2.5-pro',
    } as Partial<EnrichedAgent>);
    leadAgent = makeAgent('lead', { subAgents: ['sub-1'] } as Partial<EnrichedAgent>);

    const pending = handleDelegation(
      'session-gemini',
      'msg-g',
      [delegateTask('audit routes')],
      leadAgent,
      project,
      '/tmp',
    );

    await flush();
    const spawnCalls = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(spawnCalls[0][0]).toBe('/bin/gemini');
    const argv = spawnCalls[0][1] as string[];
    expect(argv).toContain('-p');
    expect(argv).toContain('--yolo');
    expect(argv).toContain('--output-format');
    expect(argv).toContain('stream-json');
    expect(argv.join('\0')).toContain('prompt');
    expect(argv.join('\0')).toContain('audit routes');

    const geminiLine = JSON.stringify({
      type: 'message',
      role: 'assistant',
      partial: false,
      content: [{ type: 'text', text: 'Gemini delegate output.' }],
    });
    fakeProcs[0].finish(0, { stdout: `${geminiLine}\n` });

    const results = await pending;
    expect(results[0].output).toContain('Gemini delegate output.');
    expect(results[0].error).toBeNull();
  });

  it('uses Codex CLI + JSONL stream assembly for codex-cli sub-agent', async () => {
    subAgent = makeAgent('sub-1', {
      engine: 'codex-cli',
      model: 'gpt-5.3-codex',
    } as Partial<EnrichedAgent>);
    leadAgent = makeAgent('lead', { subAgents: ['sub-1'] } as Partial<EnrichedAgent>);

    const pending = handleDelegation(
      'session-codex',
      'msg-x',
      [delegateTask('scan imports')],
      leadAgent,
      project,
      '/tmp',
    );

    await flush();
    const spawnCalls = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(spawnCalls[0][0]).toBe('/bin/codex');
    const argv = spawnCalls[0][1] as string[];
    expect(argv[0]).toBe('exec');
    expect(argv).toContain('--json');
    expect(argv).toContain('--full-auto');
    expect(argv[argv.length - 1]).toContain('scan imports');

    const codexLine = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'im1',
        type: 'agent_message',
        text: 'Codex delegate output.',
      },
    });
    fakeProcs[0].finish(0, { stdout: `${codexLine}\n` });

    const results = await pending;
    expect(results[0].output).toContain('Codex delegate output.');
    expect(results[0].error).toBeNull();
  });

  it('Gemini delegate omits --yolo when lead session is Ask Mode', async () => {
    delegationLeadAskMode = 1;
    subAgent = makeAgent('sub-1', {
      engine: 'gemini-cli',
      model: 'gemini-2.5-pro',
    } as Partial<EnrichedAgent>);
    leadAgent = makeAgent('lead', { subAgents: ['sub-1'] } as Partial<EnrichedAgent>);

    const pending = handleDelegation(
      'session-g-ask',
      'msg-g-ask',
      [delegateTask('readonly audit')],
      leadAgent,
      project,
      '/tmp',
    );

    await flush();
    const argv = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(argv).not.toContain('--yolo');

    fakeProcs[0].finish(0, {
      stdout:
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          partial: false,
          content: [{ type: 'text', text: 'gemini ok' }],
        }) + '\n',
    });

    const results = await pending;
    expect(results[0].output).toContain('gemini ok');
  });

  it('Codex delegate uses read-only sandbox when lead session is Ask Mode', async () => {
    delegationLeadAskMode = 1;
    subAgent = makeAgent('sub-1', {
      engine: 'codex-cli',
      model: 'gpt-5.3-codex',
    } as Partial<EnrichedAgent>);
    leadAgent = makeAgent('lead', { subAgents: ['sub-1'] } as Partial<EnrichedAgent>);

    const pending = handleDelegation(
      'session-x-ask',
      'msg-x-ask',
      [delegateTask('inspect')],
      leadAgent,
      project,
      '/tmp',
    );

    await flush();
    const argv = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(argv).toContain('--sandbox');
    expect(argv).toContain('read-only');
    expect(argv).not.toContain('--full-auto');

    fakeProcs[0].finish(0, {
      stdout:
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'x', type: 'agent_message', text: 'codex ask ok' },
        }) + '\n',
    });

    const results = await pending;
    expect(results[0].output).toContain('codex ask ok');
  });

  it('Codex delegate passes danger bypass instead of full-auto when host enables codexDangerBypass', async () => {
    delegationCodexDangerBypass = true;
    subAgent = makeAgent('sub-1', {
      engine: 'codex-cli',
      model: 'gpt-5.3-codex',
    } as Partial<EnrichedAgent>);
    leadAgent = makeAgent('lead', { subAgents: ['sub-1'] } as Partial<EnrichedAgent>);

    const pending = handleDelegation(
      'session-codex-yolo',
      'msg-yolo',
      [delegateTask('full access task')],
      leadAgent,
      project,
      '/tmp',
    );

    await flush();
    const argv = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(argv).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(argv).not.toContain('--full-auto');

    fakeProcs[0].finish(0, {
      stdout:
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'y', type: 'agent_message', text: 'codex bypass ok' },
        }) + '\n',
    });

    const results = await pending;
    expect(results[0].output).toContain('codex bypass ok');
  });
});

/** Stubs for delegation synthesis tests (session row + message writers). */
function makeSynthStmts(session: Partial<SessionRow>) {
  const row: SessionRow = {
    id: 'syn-session',
    agent_id: 'lead-1',
    name: 'Test',
    engine: session.engine ?? 'claude-code',
    model: session.model ?? 'opus',
    engine_session_id:
      session.engine_session_id !== undefined ? session.engine_session_id : 'eng-cli-sess',
    use_worktree: session.use_worktree ?? 0,
    worktree_path: session.worktree_path ?? null,
    worktree_branch: null,
    git_worktree_detected: null,
    changes_ready: null,
    stale_pr_notified_at: null,
    pending_skill_context: null,
    ask_mode: 0,
    cron_id: null,
    created_at: '',
    updated_at: '',
    deleted_at: null,
    ...session,
  };
  const getSession = { get: vi.fn(() => row) };
  const addMessage = { run: vi.fn() };
  const touchSession = { run: vi.fn() };
  return {
    stmts: { getSession, addMessage, touchSession } as unknown as Stmts,
    getSession,
    addMessage,
    touchSession,
    sessionRow: row,
  };
}

describe('synthesizeResults — engine routing', () => {
  let fakeProcs: FakeProc[];
  let broadcast: ReturnType<typeof vi.fn>;
  let synthBundle: ReturnType<typeof makeSynthStmts>;
  let project: Project;
  let leadAgent: EnrichedAgent;
  let procMap: Map<string, unknown>;
  /** Tracks correct (agent, undefined, opts) arity for Gemini/Codex synthesis enrichment. */
  let buildEnrichedPromptMock: ReturnType<typeof vi.fn>;
  /** Host flag surfaced via `getConfig().codexDangerBypass` for Codex synthesis argv tests. */
  let synthesisCodexDangerBypass = false;

  beforeEach(() => {
    vi.clearAllMocks();
    synthesisCodexDangerBypass = false;
    fakeProcs = [];
    broadcast = vi.fn();
    procMap = new Map();
    buildEnrichedPromptMock = vi.fn(() => '## enriched system prompt');
    synthBundle = makeSynthStmts({
      engine: 'claude-code',
      model: 'opus',
      engine_session_id: 'claude-cli-sess',
    });
    leadAgent = makeAgent('lead', {});
    project = {
      id: 'proj',
      name: 'Proj',
      slug: 'proj',
      cwd: '/tmp/syn',
      ahw: '',
      color: '#000',
      agentIds: ['lead'],
    } as unknown as Project;

    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const fp = makeFakeProc();
      fakeProcs.push(fp);
      return fp.proc;
    });

    initDelegation({
      stmts: synthBundle.stmts,
      broadcast: broadcast as unknown as BroadcastFn,
      getEnrichedAgent: () => null,
      buildEnrichedPrompt: buildEnrichedPromptMock as DelegationDeps['buildEnrichedPrompt'],
      saveErrorMessage: vi.fn(),
      appendDailyNote: vi.fn(),
      getActiveProcesses: () => procMap as never,
      getClaudeBin: () => '/bin/claude',
      getCursorBin: () => '/bin/cursor',
      getGeminiBin: () => '/bin/gemini',
      getCodexBin: () => '/bin/codex',
      getDefaultModel: () => 'sonnet',
      getConfig: () =>
        ({
          conferenceTimeoutMs: 600000,
          codexDangerBypass: synthesisCodexDangerBypass,
        }) as unknown as import('./types.js').AppConfig,
    });
  });

  async function flushSynth() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  it('spawns Claude with --print and --resume for claude-code session', async () => {
    const pending = synthesizeResults(
      'syn-session',
      'lead-1',
      leadAgent,
      project,
      [
        {
          agentId: 'sub-1',
          agentName: 'Sub',
          task: 'delegated work',
          output: 'delegated work',
          error: null,
        },
      ],
      'user asked for help',
      '/tmp/syn',
    );

    await flushSynth();
    expect(fakeProcs.length).toBe(1);
    expect((spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/bin/claude');
    const argv = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(argv).toContain('--print');
    expect(argv).toContain('--resume');
    expect(argv).toContain('claude-cli-sess');
    expect(argv).toContain('bypassPermissions');

    fakeProcs[0].finish(0, { stdout: 'Here is the unified summary.' });

    await pending;

    expect(synthBundle.addMessage.run).toHaveBeenCalledWith(
      expect.any(String),
      'syn-session',
      'assistant',
      'Here is the unified summary.',
      'claude-code',
      'opus',
      null,
      null,
    );
    const doneEv = broadcast.mock.calls.map((c) => c[0]).find((e) => e.type === 'done');
    expect(doneEv?.message?.content).toContain('Here is the unified summary.');
  });

  it('uses Claude plan permission mode when lead session is in Ask Mode', async () => {
    synthBundle.sessionRow.ask_mode = 1;

    const pending = synthesizeResults(
      'syn-session',
      'lead-1',
      leadAgent,
      project,
      [{ agentId: 's', agentName: 'S', task: 'subtask', output: 'x', error: null }],
      'q',
      '/tmp/syn',
    );

    await flushSynth();
    const argv = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(argv.indexOf('--permission-mode')).toBeGreaterThan(-1);
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('plan');

    fakeProcs[0].finish(0, { stdout: 'answer' });
    await pending;

    expect(synthBundle.addMessage.run).toHaveBeenCalled();
  });

  it('spawns Cursor with resume + stream-json and assembles streamed assistant text', async () => {
    synthBundle.sessionRow.engine = 'cursor-agent';
    synthBundle.sessionRow.model = 'gpt-5.3-codex-high';
    synthBundle.sessionRow.engine_session_id = 'cursor-engine-42';

    const pending = synthesizeResults(
      'syn-session',
      'lead-1',
      leadAgent,
      project,
      [
        {
          agentId: 'sub-1',
          agentName: 'Sub',
          task: 'delegate',
          output: 'done',
          error: null,
        },
      ],
      'original ask',
      '/tmp/syn',
    );

    await flushSynth();
    expect((spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/bin/cursor');
    const argv = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(argv).toContain('-p');
    expect(argv).toContain('--resume');
    expect(argv).toContain('cursor-engine-42');
    expect(argv).toContain('--output-format');
    expect(argv).toContain('stream-json');

    const streamLine = JSON.stringify({
      type: 'assistant',
      timestamp_ms: 1,
      message: { content: [{ type: 'text', text: 'Cursor synthesized summary.' }] },
    });
    fakeProcs[0].finish(0, { stdout: `${streamLine}\n` });

    await pending;

    expect(synthBundle.addMessage.run).toHaveBeenCalled();
    const contentArg = synthBundle.addMessage.run.mock.calls[0][3] as string;
    expect(contentArg).toContain('Cursor synthesized summary.');
    expect(synthBundle.addMessage.run.mock.calls[0][4]).toBe('cursor-agent');
  });

  it('surfaces error when Cursor synthesis lacks engine_session_id (no spawn)', async () => {
    synthBundle.sessionRow.engine = 'cursor-agent';
    synthBundle.sessionRow.engine_session_id = null;

    await synthesizeResults(
      'syn-session',
      'lead-1',
      leadAgent,
      project,
      [{ agentId: 's', agentName: 'S', task: 'subtask', output: 'x', error: null }],
      'ask',
      '/tmp/syn',
    );

    expect((spawn as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);

    const errCalls = broadcast.mock.calls.map((c) => c[0]).filter((e) => e.type === 'error');
    expect(errCalls.length).toBeGreaterThan(0);
    expect(errCalls[0].error).toMatch(/missing Cursor engine session id/i);
  });

  it('spawns Gemini with enriched prompt + synthesis JSONL stream', async () => {
    synthBundle.sessionRow.engine = 'gemini-cli';
    synthBundle.sessionRow.model = 'gemini-2.5-pro';
    synthBundle.sessionRow.engine_session_id = null;

    const pending = synthesizeResults(
      'syn-session',
      'lead-1',
      leadAgent,
      project,
      [{ agentId: 's', agentName: 'S', task: 'subtask', output: 'sub', error: null }],
      'user question',
      '/tmp/syn',
    );

    await flushSynth();
    expect((spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/bin/gemini');
    const argv = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(argv[0]).toBe('-p');
    const combined = argv[1];
    expect(combined).toContain('## enriched system prompt');
    expect(combined).toContain('user question');
    expect(argv).toContain('--yolo');

    const geminiLine = JSON.stringify({
      type: 'message',
      role: 'assistant',
      partial: false,
      content: [{ type: 'text', text: 'Gemini synthesis done.' }],
    });
    fakeProcs[0].finish(0, { stdout: `${geminiLine}\n` });

    await pending;

    expect(synthBundle.addMessage.run.mock.calls[0][3]).toContain('Gemini synthesis done.');
    expect(synthBundle.addMessage.run.mock.calls[0][4]).toBe('gemini-cli');
    expect(buildEnrichedPromptMock).toHaveBeenCalledWith(
      leadAgent,
      undefined,
      expect.objectContaining({
        sessionId: 'syn-session',
        useWorktree: false,
        isFirstMessage: false,
      }),
    );
  });

  it('Gemini synthesis omits --yolo when lead session is in Ask Mode', async () => {
    synthBundle.sessionRow.engine = 'gemini-cli';
    synthBundle.sessionRow.model = 'gemini-2.5-pro';
    synthBundle.sessionRow.engine_session_id = null;
    synthBundle.sessionRow.ask_mode = 1;

    const pending = synthesizeResults(
      'syn-session',
      'lead-1',
      leadAgent,
      project,
      [{ agentId: 's', agentName: 'S', task: 'subtask', output: 'sub', error: null }],
      'user question',
      '/tmp/syn',
    );

    await flushSynth();
    const argv = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(argv).not.toContain('--yolo');

    fakeProcs[0].finish(0, {
      stdout:
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          partial: false,
          content: [{ type: 'text', text: 'Ask-mode gemini synth.' }],
        }) + '\n',
    });

    await pending;

    expect(synthBundle.addMessage.run.mock.calls[0][3]).toContain('Ask-mode gemini synth.');
    expect(buildEnrichedPromptMock).toHaveBeenCalledWith(
      leadAgent,
      undefined,
      expect.objectContaining({
        sessionId: 'syn-session',
        useWorktree: false,
        isFirstMessage: false,
      }),
    );
  });

  it('spawns Codex exec resume with correct argv order for synthesis', async () => {
    synthBundle.sessionRow.engine = 'codex-cli';
    synthBundle.sessionRow.model = 'gpt-5.3-codex';
    synthBundle.sessionRow.engine_session_id = 'thread-resume-id';

    const pending = synthesizeResults(
      'syn-session',
      'lead-1',
      leadAgent,
      project,
      [{ agentId: 's', agentName: 'S', task: 'subtask', output: 'x', error: null }],
      'original',
      '/tmp/syn',
    );

    await flushSynth();
    expect((spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/bin/codex');
    const argv = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(argv.slice(0, 6)).toEqual([
      'exec',
      'resume',
      'thread-resume-id',
      '--json',
      '--skip-git-repo-check',
      '--full-auto',
    ]);

    const codexLine = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'z1',
        type: 'agent_message',
        text: 'Codex synthesis output.',
      },
    });
    fakeProcs[0].finish(0, { stdout: `${codexLine}\n` });

    await pending;

    expect(synthBundle.addMessage.run.mock.calls[0][3]).toContain('Codex synthesis output.');
    expect(synthBundle.addMessage.run.mock.calls[0][4]).toBe('codex-cli');
    expect(buildEnrichedPromptMock).toHaveBeenCalledWith(
      leadAgent,
      undefined,
      expect.objectContaining({
        sessionId: 'syn-session',
        useWorktree: false,
        isFirstMessage: false,
      }),
    );
  });

  it('Codex synthesis passes danger bypass when host enables codexDangerBypass', async () => {
    synthesisCodexDangerBypass = true;
    synthBundle.sessionRow.engine = 'codex-cli';
    synthBundle.sessionRow.model = 'gpt-5.3-codex';
    synthBundle.sessionRow.engine_session_id = 'thread-bypass-id';

    const pending = synthesizeResults(
      'syn-session',
      'lead-1',
      leadAgent,
      project,
      [{ agentId: 's', agentName: 'S', task: 'subtask', output: 'x', error: null }],
      'original',
      '/tmp/syn',
    );

    await flushSynth();
    const argv = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(argv.slice(0, 6)).toEqual([
      'exec',
      'resume',
      'thread-bypass-id',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
    ]);

    fakeProcs[0].finish(0, {
      stdout:
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'byp', type: 'agent_message', text: 'bypass synth.' },
        }) + '\n',
    });

    await pending;

    expect(synthBundle.addMessage.run.mock.calls[0][3]).toContain('bypass synth.');
  });

  it('Codex synthesis uses read-only sandbox in Ask Mode instead of full-auto', async () => {
    synthBundle.sessionRow.engine = 'codex-cli';
    synthBundle.sessionRow.model = 'gpt-5.3-codex';
    synthBundle.sessionRow.engine_session_id = 'thr-ask';
    synthBundle.sessionRow.ask_mode = 1;

    const pending = synthesizeResults(
      'syn-session',
      'lead-1',
      leadAgent,
      project,
      [{ agentId: 's', agentName: 'S', task: 'subtask', output: 'x', error: null }],
      'original',
      '/tmp/syn',
    );

    await flushSynth();
    const argv = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(argv).toContain('--sandbox');
    expect(argv).toContain('read-only');
    expect(argv).not.toContain('--full-auto');

    fakeProcs[0].finish(0, {
      stdout:
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'a',
            type: 'agent_message',
            text: 'Codex ask synth.',
          },
        }) + '\n',
    });

    await pending;

    expect(synthBundle.addMessage.run.mock.calls[0][3]).toContain('Codex ask synth.');
    expect(buildEnrichedPromptMock).toHaveBeenCalledWith(
      leadAgent,
      undefined,
      expect.objectContaining({
        sessionId: 'syn-session',
        useWorktree: false,
        isFirstMessage: false,
      }),
    );
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

/**
 * Regression: when every <delegate> task is filtered out (target not in the
 * lead's `subAgents` allowlist, or unknown agent), the server must persist a
 * system message into the lead's session in addition to broadcasting
 * `delegation_error`. Without the system message the model never sees the
 * filter reason and just stops on its next turn (which is exactly the
 * "Delegation skip: target agent not in sub-agent roster" tool-error this
 * test guards against re-introducing).
 */
describe('handleDelegation — empty-after-filter regression', () => {
  let tmpWorkspace: string;
  let project: Project;
  let leadAgent: EnrichedAgent;
  let broadcast: ReturnType<typeof vi.fn>;
  let stmts: ReturnType<typeof makeStmts>;

  beforeEach(() => {
    vi.clearAllMocks();
    delegationLeadAskMode = 0;
    tmpWorkspace = mkdtempSync(path.join(os.tmpdir(), 'delegation-skip-test-'));
    broadcast = vi.fn();
    stmts = makeStmts();

    project = {
      id: 'proj',
      name: 'Proj',
      slug: 'proj',
      cwd: '/tmp',
      ahw: tmpWorkspace,
      color: '#000',
      agentIds: ['lead'],
    } as unknown as Project;

    initDelegation({
      stmts: stmts.stmts,
      broadcast: broadcast as unknown as BroadcastFn,
      // No sub-agents resolvable — even if the allowlist passed, the lookup
      // would return null. We exercise both skip reasons below.
      getEnrichedAgent: () => null,
      buildEnrichedPrompt: (() => 'prompt') as DelegationDeps['buildEnrichedPrompt'],
      saveErrorMessage: vi.fn(),
      appendDailyNote: vi.fn(),
      getActiveProcesses: () => new Map(),
      getClaudeBin: () => '/bin/claude',
      getCursorBin: () => '/bin/cursor',
      getGeminiBin: () => '/bin/gemini',
      getCodexBin: () => '/bin/codex',
      getDefaultModel: () => 'sonnet',
      getConfig: () =>
        ({
          conferenceTimeoutMs: 600000,
          delegationMaxAttempts: 3,
          delegationRetryBackoffMs: 0,
        }) as unknown as import('./types.js').AppConfig,
    });
  });

  afterEach(() => {
    rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  it('persists a system message AND broadcasts delegation_error when the target is not in subAgents', async () => {
    leadAgent = makeAgent('lead', { subAgents: ['frontend'] } as Partial<EnrichedAgent>);

    const results = await handleDelegation(
      'session-skip-1',
      'msg-skip-1',
      [delegateTask('do something')], // delegateTask defaults agentId to 'sub-1'
      leadAgent,
      project,
      '/tmp',
    );

    expect(results).toEqual([]);

    // delegation_error broadcast still fires (UI banner contract preserved).
    const errEvents = broadcast.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === 'delegation_error');
    expect(errEvents).toHaveLength(1);
    expect(errEvents[0].sessionId).toBe('session-skip-1');
    expect(errEvents[0].parentMessageId).toBe('msg-skip-1');

    // System message persisted into the lead's session.
    expect(stmts.addMessage.run).toHaveBeenCalledTimes(1);
    const args = stmts.addMessage.run.mock.calls[0];
    expect(args[1]).toBe('session-skip-1'); // sessionId
    expect(args[2]).toBe('system'); // role
    const content = args[3] as string;
    expect(content).toContain('Delegation skipped');
    expect(content).toContain('`sub-1`');
    expect(content).toContain('subAgents');
    expect(content).toContain('`frontend`'); // allowlist surfaced
    expect(content).toContain('<handoff>');
    const metadata = JSON.parse(args[7] as string);
    expect(metadata.kind).toBe('delegation_skip');
    expect(metadata.parentMessageId).toBe('msg-skip-1');
    expect(metadata.allowlist).toEqual(['frontend']);
    expect(metadata.skipped).toEqual([{ agentId: 'sub-1', reason: 'not-sub-agent' }]);

    // touchSession bumped so the sidebar moves the session up.
    expect(stmts.touchSession.run).toHaveBeenCalledWith('session-skip-1');

    // message_added broadcast fires alongside delegation_error so any open
    // chat view picks up the system message without a refetch.
    const msgEvents = broadcast.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === 'message_added');
    expect(msgEvents).toHaveLength(1);
    expect(msgEvents[0].sessionId).toBe('session-skip-1');
  });

  it('explains when the lead has no subAgents at all', async () => {
    leadAgent = makeAgent('lone-lead', {} as Partial<EnrichedAgent>); // no subAgents

    const results = await handleDelegation(
      'session-skip-2',
      'msg-skip-2',
      [delegateTask('attempt')],
      leadAgent,
      project,
      '/tmp',
    );

    expect(results).toEqual([]);
    expect(stmts.addMessage.run).toHaveBeenCalledTimes(1);
    const content = stmts.addMessage.run.mock.calls[0][3] as string;
    expect(content).toContain('no registered sub-agents');
    expect(content).toContain('`<delegate>` is unavailable');
  });

  it('records reason=agent-not-found when the target is on subAgents but missing from the project', async () => {
    leadAgent = makeAgent('lead', { subAgents: ['sub-1'] } as Partial<EnrichedAgent>);
    // getEnrichedAgent already returns null in this describe's beforeEach,
    // so the agent passes the allowlist check but fails the project lookup.

    const results = await handleDelegation(
      'session-skip-3',
      'msg-skip-3',
      [delegateTask('attempt')],
      leadAgent,
      project,
      '/tmp',
    );

    expect(results).toEqual([]);
    expect(stmts.addMessage.run).toHaveBeenCalledTimes(1);
    const metadata = JSON.parse(stmts.addMessage.run.mock.calls[0][7] as string);
    expect(metadata.skipped).toEqual([{ agentId: 'sub-1', reason: 'agent-not-found' }]);
    const content = stmts.addMessage.run.mock.calls[0][3] as string;
    expect(content).toContain('not a known agent on this project');
  });
});
