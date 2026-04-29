/**
 * Tests for SpawnRegistry. We don't shell out to a real binary —
 * instead we inject a `ChildSpawner` test seam that returns a fake
 * EventEmitter mimicking the ChildProcess surface the spawner touches:
 * stdout/stderr Readable-ish streams, stdin Writable-ish, kill(),
 * 'spawn' / 'error' / 'close' events. This keeps the tests deterministic
 * and lets us assert exact frame ordering.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { SpawnRegistry, type ChildSpawner } from './spawner.js';
import type {
  RunnerInbound,
  RunnerSpawnMessage,
  RunnerStreamMessage,
} from '../../shared/runner-protocol.js';

class FakeChild extends EventEmitter {
  pid = 12345;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  killSignal: NodeJS.Signals | null = null;
  killCalls: Array<NodeJS.Signals | undefined> = [];
  /** Capture writes for stdin assertions. */
  stdinWrites: string[] = [];
  stdinEnded = false;

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => this.stdinWrites.push(chunk.toString('utf8')));
    this.stdin.on('end', () => {
      this.stdinEnded = true;
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killCalls.push(signal);
    this.killed = true;
    this.killSignal = signal ?? 'SIGTERM';
    return true;
  }

  /** Helper: simulate the kernel acknowledging the spawn. */
  emitSpawn(): void {
    this.emit('spawn');
  }

  /** Helper: emit a stdout chunk (encoded to utf8 via setEncoding). */
  emitStdout(s: string): void {
    this.stdout.emit('data', s);
  }

  emitStderr(s: string): void {
    this.stderr.emit('data', s);
  }

  /** Helper: simulate the child exiting cleanly. */
  emitClose(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('close', code, signal);
  }

  emitError(err: NodeJS.ErrnoException): void {
    this.emit('error', err);
  }
}

interface Harness {
  reg: SpawnRegistry;
  frames: RunnerInbound[];
  childOf: (id: string) => FakeChild;
  spawnCalls: Array<{ bin: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }>;
}

function makeHarness(opts?: { defaultCwd?: string; baseEnv?: NodeJS.ProcessEnv }): Harness {
  const frames: RunnerInbound[] = [];
  const children = new Map<string, FakeChild>();
  const spawnCalls: Harness['spawnCalls'] = [];
  // We tag the FakeChild → spawnId via the env on each call; the test
  // helper looks up by spawn id.
  let nextId = 0;
  const childSpawner: ChildSpawner = (bin, args, options) => {
    const id = `child-${nextId++}`;
    spawnCalls.push({ bin, args, cwd: options.cwd, env: options.env });
    const c = new FakeChild();
    children.set(id, c);
    return c as unknown as ReturnType<ChildSpawner>;
  };
  const reg = new SpawnRegistry({
    send: (f) => frames.push(f),
    childSpawner,
    flushIntervalMs: 1, // tighten so tests don't have to wait 50ms
    defaultCwd: opts?.defaultCwd,
    baseEnv:
      opts?.baseEnv ?? {
        AGENT_HUB_RUNNER_BIN_CLAUDE_CODE: '/fake/claude',
      },
  });
  // Stable lookup by call-order so tests can fetch the FakeChild they need.
  return {
    reg,
    frames,
    spawnCalls,
    childOf: (id) => {
      const c = children.get(id);
      if (!c) throw new Error(`no fake child for ${id}`);
      return c;
    },
  };
}

function spawnMsg(overrides: Partial<RunnerSpawnMessage> = {}): RunnerSpawnMessage {
  return {
    type: 'spawn',
    id: 'spawn-1',
    engine: 'claude-code',
    args: ['--print', 'hello'],
    sessionId: 'session-abc',
    ...overrides,
  };
}

/** Wait for the next macrotask so PassThrough drains and coalescer
 * timers fire (we set flushIntervalMs:1, so a single setTimeout is
 * enough). */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

describe('SpawnRegistry — happy path', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  it('sends `result {ok:true, pid}` after the child reports spawn', async () => {
    h.reg.handleSpawn(spawnMsg());
    expect(h.frames).toEqual([]); // nothing before the kernel acks
    h.childOf('child-0').emitSpawn();
    expect(h.frames).toEqual([
      { type: 'result', id: 'spawn-1', ok: true, pid: 12345 },
    ]);
  });

  it('streams coalesced stdout chunks with monotonic seq', async () => {
    h.reg.handleSpawn(spawnMsg());
    const c = h.childOf('child-0');
    c.emitSpawn();
    c.emitStdout('hel');
    c.emitStdout('lo ');
    c.emitStdout('world');
    await nextTick();
    const streams = h.frames.filter((f) => f.type === 'stream') as RunnerStreamMessage[];
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      type: 'stream',
      id: 'spawn-1',
      channel: 'stdout',
      data: 'hello world',
      seq: 0,
    });
  });

  it('drains the buffer on close before sending exit', async () => {
    h.reg.handleSpawn(spawnMsg());
    const c = h.childOf('child-0');
    c.emitSpawn();
    c.emitStdout('partial-output');
    // Don't wait for the timer — close should force a flush.
    c.emitClose(0, null);
    const types = h.frames.map((f) => f.type);
    expect(types).toEqual(['result', 'stream', 'exit']);
    const exitFrame = h.frames[2];
    expect(exitFrame).toEqual({ type: 'exit', id: 'spawn-1', code: 0, signal: null });
  });

  it('exit frame carries signal when killed', async () => {
    h.reg.handleSpawn(spawnMsg());
    const c = h.childOf('child-0');
    c.emitSpawn();
    c.emitClose(null, 'SIGTERM');
    expect(h.frames.at(-1)).toEqual({
      type: 'exit',
      id: 'spawn-1',
      code: null,
      signal: 'SIGTERM',
    });
  });

  it('drops the registry slot after exit', async () => {
    h.reg.handleSpawn(spawnMsg());
    h.childOf('child-0').emitSpawn();
    h.childOf('child-0').emitClose(0, null);
    expect(h.reg.size()).toBe(0);
  });
});

describe('SpawnRegistry — env + cwd plumbing', () => {
  it('merges spawn-frame env on top of base env', () => {
    const h = makeHarness({
      baseEnv: { PATH: '/usr/bin', AGENT_HUB_RUNNER_BIN_CLAUDE_CODE: '/fake/claude' },
    });
    h.reg.handleSpawn(spawnMsg({ env: { CUSTOM_VAR: 'value', PATH: '/custom/bin' } }));
    const call = h.spawnCalls[0];
    expect(call.bin).toBe('/fake/claude');
    expect(call.env?.CUSTOM_VAR).toBe('value');
    expect(call.env?.PATH).toBe('/custom/bin'); // overridden
  });

  it('uses defaultCwd when no workspace is sent', () => {
    const h = makeHarness({ defaultCwd: '/tmp/runner-cwd' });
    h.reg.handleSpawn(spawnMsg());
    expect(h.spawnCalls[0].cwd).toBe('/tmp/runner-cwd');
  });
});

describe('SpawnRegistry — error paths', () => {
  it('rejects unknown engines with `unknown_engine`', () => {
    const h = makeHarness({ baseEnv: {} }); // no overrides defined
    h.reg.handleSpawn(spawnMsg({ engine: 'pretend-engine' }));
    expect(h.frames).toEqual([
      {
        type: 'result',
        id: 'spawn-1',
        ok: false,
        errorCode: 'unknown_engine',
        error: 'Unknown engine: pretend-engine',
      },
    ]);
    expect(h.spawnCalls).toHaveLength(0);
  });

  it('maps ENOENT to `binary_not_found`', () => {
    const h = makeHarness();
    h.reg.handleSpawn(spawnMsg());
    const c = h.childOf('child-0');
    const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    c.emitError(err);
    expect(h.frames.at(-1)).toMatchObject({
      type: 'exit',
      id: 'spawn-1',
    });
    const result = h.frames.find((f) => f.type === 'result');
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'binary_not_found',
    });
  });

  it('rejects workspace.repoUrl with `workspace_failed` (phase 2 placeholder)', () => {
    const h = makeHarness();
    h.reg.handleSpawn(
      spawnMsg({
        workspace: { repoUrl: 'https://example.com/r.git', branch: 'feat/x' },
      }),
    );
    expect(h.frames).toEqual([
      {
        type: 'result',
        id: 'spawn-1',
        ok: false,
        errorCode: 'workspace_failed',
        error: 'Runner workspace preparation not implemented in this phase',
      },
    ]);
    expect(h.spawnCalls).toHaveLength(0);
  });

  it('rejects duplicate spawn ids without disturbing the live one', () => {
    const h = makeHarness();
    h.reg.handleSpawn(spawnMsg());
    h.childOf('child-0').emitSpawn(); // first spawn alive
    h.reg.handleSpawn(spawnMsg()); // duplicate id
    const dupResult = h.frames.find(
      (f) => f.type === 'result' && f.ok === false,
    );
    expect(dupResult).toMatchObject({
      errorCode: 'spawn_failed',
      error: 'duplicate spawn id',
    });
    // Original spawn still alive — only one spawn call landed.
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.reg.size()).toBe(1);
  });

  it('does not double-emit exit when error fires before close', () => {
    const h = makeHarness();
    h.reg.handleSpawn(spawnMsg());
    const c = h.childOf('child-0');
    const err = new Error('boom') as NodeJS.ErrnoException;
    c.emitError(err);
    c.emitClose(1, null);
    const exits = h.frames.filter((f) => f.type === 'exit');
    expect(exits).toHaveLength(1);
  });
});

describe('SpawnRegistry — stdin', () => {
  it('writes the initial stdin payload on spawn', () => {
    const h = makeHarness();
    h.reg.handleSpawn(spawnMsg({ stdin: 'initial-prompt\n' }));
    const c = h.childOf('child-0');
    c.emitSpawn();
    expect(c.stdinWrites).toEqual(['initial-prompt\n']);
  });

  it('routes follow-up stdin frames to the child', () => {
    const h = makeHarness();
    h.reg.handleSpawn(spawnMsg());
    const c = h.childOf('child-0');
    c.emitSpawn();
    h.reg.handleStdin({ type: 'stdin', id: 'spawn-1', data: 'more\n' });
    expect(c.stdinWrites.at(-1)).toBe('more\n');
  });

  it('honours stdin.end to close the pipe', async () => {
    const h = makeHarness();
    h.reg.handleSpawn(spawnMsg());
    const c = h.childOf('child-0');
    c.emitSpawn();
    // Drain via resume() so PassThrough actually fires its 'end' event
    // once we call end() on the writable side. Without resume(), data
    // is buffered in the readable side and 'end' never lands.
    c.stdin.resume();
    h.reg.handleStdin({ type: 'stdin', id: 'spawn-1', data: 'last', end: true });
    await nextTick();
    expect(c.stdinEnded).toBe(true);
  });

  it('drops stdin for unknown ids without throwing', () => {
    const h = makeHarness();
    expect(() =>
      h.reg.handleStdin({ type: 'stdin', id: 'no-such-spawn', data: 'x' }),
    ).not.toThrow();
  });
});

describe('SpawnRegistry — cancel', () => {
  it('forwards SIGTERM by default', () => {
    const h = makeHarness();
    h.reg.handleSpawn(spawnMsg());
    const c = h.childOf('child-0');
    c.emitSpawn();
    h.reg.handleCancel({ type: 'cancel', id: 'spawn-1' });
    expect(c.killCalls).toEqual(['SIGTERM']);
  });

  it('forwards an explicit signal verbatim', () => {
    const h = makeHarness();
    h.reg.handleSpawn(spawnMsg());
    const c = h.childOf('child-0');
    c.emitSpawn();
    h.reg.handleCancel({ type: 'cancel', id: 'spawn-1', signal: 'SIGKILL' });
    expect(c.killCalls).toEqual(['SIGKILL']);
  });

  it('silently drops cancel for unknown ids', () => {
    const h = makeHarness();
    expect(() =>
      h.reg.handleCancel({ type: 'cancel', id: 'no-such-spawn' }),
    ).not.toThrow();
  });
});

describe('SpawnRegistry — stream ordering invariants', () => {
  it('exit is the last frame for a spawn id', async () => {
    const h = makeHarness();
    h.reg.handleSpawn(spawnMsg());
    const c = h.childOf('child-0');
    c.emitSpawn();
    c.emitStdout('a');
    await nextTick();
    c.emitStdout('b');
    c.emitStderr('err');
    c.emitClose(0, null);
    const ids = h.frames.map((f) => f.type);
    expect(ids[ids.length - 1]).toBe('exit');
  });

  it('seq counters are independent per channel', async () => {
    const h = makeHarness();
    h.reg.handleSpawn(spawnMsg());
    const c = h.childOf('child-0');
    c.emitSpawn();
    c.emitStdout('out-1');
    await nextTick();
    c.emitStdout('out-2');
    await nextTick();
    c.emitStderr('err-1');
    await nextTick();
    const streams = h.frames.filter(
      (f) => f.type === 'stream',
    ) as RunnerStreamMessage[];
    const out = streams.filter((s) => s.channel === 'stdout');
    const err = streams.filter((s) => s.channel === 'stderr');
    expect(out.map((s) => s.seq)).toEqual([0, 1]);
    expect(err.map((s) => s.seq)).toEqual([0]);
  });
});
