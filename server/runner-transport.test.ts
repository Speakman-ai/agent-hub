/**
 * Unit tests for `runner-transport.ts`. Pure transport-layer behaviour:
 * no real CLI processes, no real WebSocket — `LocalSpawnTransport` is
 * exercised against `node -e` (the only external dependency Vitest
 * already needs to run), and `RemoteRunnerTransport` runs through an
 * in-memory protocol harness.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  LocalSpawnTransport,
  RemoteRunnerTransport,
  isRunnerTransportError,
  type RemoteRunnerTransportDeps,
} from './runner-transport.js';
import type {
  RunnerInbound,
  RunnerSpawnMessage,
  RunnerCancelMessage,
  RunnerStdinMessage,
} from '../shared/runner-protocol.js';

// ─── In-memory harness ───────────────────────────────────────────────

/** Simulates a runner: stores frames sent by the server and exposes a
 * helper to push runner→server messages back through the subscription. */
class FakeRunner {
  readonly sent: object[] = [];
  private listeners: Array<(msg: RunnerInbound) => void> = [];
  private disconnectListeners: Array<() => void> = [];
  private connected = true;

  buildDeps(
    runnerId: string,
    opts: { generateId?: () => string; spawnTimeoutMs?: number } = {},
  ): RemoteRunnerTransportDeps {
    return {
      getSender: (id) => {
        if (id !== runnerId) return null;
        if (!this.connected) return null;
        return (frame: object) => {
          this.sent.push(frame);
        };
      },
      subscribe: (id, listener) => {
        if (id !== runnerId) return () => {};
        this.listeners.push(listener);
        return () => {
          this.listeners = this.listeners.filter((l) => l !== listener);
        };
      },
      subscribeDisconnect: (id, listener) => {
        if (id !== runnerId) return () => {};
        this.disconnectListeners.push(listener);
        return () => {
          this.disconnectListeners = this.disconnectListeners.filter((l) => l !== listener);
        };
      },
      generateId: opts.generateId,
      // Tests default to disabling the timeout so they don't have to
      // race a 30s default — individual tests opt in by passing a small
      // value when they specifically exercise the timeout path.
      spawnTimeoutMs: opts.spawnTimeoutMs ?? 0,
    };
  }

  push(msg: RunnerInbound): void {
    for (const l of this.listeners) l(msg);
  }

  /** Fire the one-shot disconnect channel and clear inbound listeners,
   * mirroring `runners-ws.ts#fireDisconnectListeners`. */
  fireDisconnect(): void {
    this.connected = false;
    const snapshot = [...this.disconnectListeners];
    this.disconnectListeners = [];
    this.listeners = [];
    for (const l of snapshot) l();
  }

  disconnect(): void {
    this.connected = false;
  }

  get listenerCount(): number {
    return this.listeners.length;
  }

  get disconnectListenerCount(): number {
    return this.disconnectListeners.length;
  }
}

// ─── LocalSpawnTransport ─────────────────────────────────────────────

describe('LocalSpawnTransport', () => {
  it('runs a process and returns a ChildProcess-shaped handle with pid', async () => {
    const t = new LocalSpawnTransport();
    const handle = await t.spawn({
      engine: 'node',
      bin: process.execPath,
      args: ['-e', 'process.stdout.write("hi"); process.exit(0)'],
      sessionId: 'sess-1',
    });
    expect(handle.pid).toBeGreaterThan(0);
    expect(handle.id).toBe(String(handle.pid));

    const stdout = await collectString(handle.stdout!);
    const exit = await waitForClose(handle);
    expect(stdout).toBe('hi');
    expect(exit.code).toBe(0);
  });

  it('rejects when bin is missing', async () => {
    const t = new LocalSpawnTransport();
    await expect(t.spawn({ engine: 'x', args: [], sessionId: 's' } as never)).rejects.toThrow(
      /bin/i,
    );
  });

  it('writes initial stdin payload when provided', async () => {
    const t = new LocalSpawnTransport();
    const handle = await t.spawn({
      engine: 'node',
      bin: process.execPath,
      args: [
        '-e',
        'let d=""; process.stdin.on("data",b=>d+=b); process.stdin.on("end",()=>{process.stdout.write(d); process.exit(0)})',
      ],
      sessionId: 'sess-1',
      stdin: 'payload',
    });
    handle.stdin!.end();
    const stdout = await collectString(handle.stdout!);
    expect(stdout).toBe('payload');
  });
});

// ─── RemoteRunnerTransport — happy path ──────────────────────────────

describe('RemoteRunnerTransport — spawn lifecycle', () => {
  it('rejects with RUNNER_OFFLINE when the runner is not connected', async () => {
    const fake = new FakeRunner();
    fake.disconnect();
    const t = new RemoteRunnerTransport('r1', fake.buildDeps('r1'));
    await expect(
      t.spawn({ engine: 'claude-code', args: [], sessionId: 's1' }),
    ).rejects.toMatchObject({ code: 'RUNNER_OFFLINE' });
  });

  it('sends a well-formed spawn frame and resolves on result ok', async () => {
    const fake = new FakeRunner();
    const t = new RemoteRunnerTransport(
      'r1',
      fake.buildDeps('r1', { generateId: () => 'spawn-1' }),
    );
    const p = t.spawn({
      engine: 'claude-code',
      args: ['--print'],
      sessionId: 'sess-1',
      env: { FOO: 'bar' },
      workspace: { repoUrl: 'https://x/y.git', branch: 'feat/z' },
      stdin: 'hello',
    });
    // Drive the result frame back.
    fake.push({ type: 'result', id: 'spawn-1', ok: true, pid: 4242 });
    const handle = await p;

    expect(handle.pid).toBe(4242);
    expect(handle.id).toBe('spawn-1');

    const sent = fake.sent[0] as RunnerSpawnMessage;
    expect(sent).toEqual({
      type: 'spawn',
      id: 'spawn-1',
      engine: 'claude-code',
      args: ['--print'],
      sessionId: 'sess-1',
      env: { FOO: 'bar' },
      workspace: { repoUrl: 'https://x/y.git', branch: 'feat/z' },
      stdin: 'hello',
    });
  });

  it('rejects with mapped error code when result.ok=false', async () => {
    const fake = new FakeRunner();
    const t = new RemoteRunnerTransport('r1', fake.buildDeps('r1', { generateId: () => 's1' }));
    const p = t.spawn({ engine: 'claude-code', args: [], sessionId: 'sess-1' });
    fake.push({
      type: 'result',
      id: 's1',
      ok: false,
      errorCode: 'binary_not_found',
      error: 'claude not on PATH',
    });
    await expect(p).rejects.toMatchObject({ code: 'BINARY_NOT_FOUND', message: /claude/ });
    // Failed spawn must unsubscribe to avoid leaking listeners.
    expect(fake.listenerCount).toBe(0);
  });

  it('drops non-string env values when forwarding', async () => {
    const fake = new FakeRunner();
    const t = new RemoteRunnerTransport('r1', fake.buildDeps('r1', { generateId: () => 's1' }));
    const p = t.spawn({
      engine: 'claude-code',
      args: [],
      sessionId: 'sess-1',
      env: { OK: 'yes', GONE: undefined as unknown as string, KEPT: 'no' },
    });
    fake.push({ type: 'result', id: 's1', ok: true, pid: 1 });
    await p;
    const sent = fake.sent[0] as RunnerSpawnMessage;
    expect(sent.env).toEqual({ OK: 'yes', KEPT: 'no' });
  });
});

describe('RemoteRunnerTransport — streams', () => {
  it('pushes stream frames into stdout/stderr in order', async () => {
    const fake = new FakeRunner();
    const t = new RemoteRunnerTransport('r1', fake.buildDeps('r1', { generateId: () => 's1' }));
    const p = t.spawn({ engine: 'claude-code', args: [], sessionId: 'sess-1' });
    fake.push({ type: 'result', id: 's1', ok: true, pid: 1 });
    const handle = await p;

    const outChunks: string[] = [];
    const errChunks: string[] = [];
    handle.stdout!.on('data', (c) => outChunks.push(c.toString()));
    handle.stderr!.on('data', (c) => errChunks.push(c.toString()));

    fake.push({ type: 'stream', id: 's1', channel: 'stdout', data: 'a', seq: 0 });
    fake.push({ type: 'stream', id: 's1', channel: 'stdout', data: 'b', seq: 1 });
    fake.push({ type: 'stream', id: 's1', channel: 'stderr', data: 'oops\n', seq: 0 });

    // Allow PassThrough to flush.
    await new Promise((r) => setImmediate(r));

    expect(outChunks.join('')).toBe('ab');
    expect(errChunks.join('')).toBe('oops\n');
  });

  it('drops out-of-order or duplicate stream frames per (id, channel)', async () => {
    const fake = new FakeRunner();
    const t = new RemoteRunnerTransport('r1', fake.buildDeps('r1', { generateId: () => 's1' }));
    const p = t.spawn({ engine: 'claude-code', args: [], sessionId: 'sess-1' });
    fake.push({ type: 'result', id: 's1', ok: true, pid: 1 });
    const handle = await p;

    const out: string[] = [];
    handle.stdout!.on('data', (c) => out.push(c.toString()));

    fake.push({ type: 'stream', id: 's1', channel: 'stdout', data: 'a', seq: 0 });
    fake.push({ type: 'stream', id: 's1', channel: 'stdout', data: 'b', seq: 1 });
    fake.push({ type: 'stream', id: 's1', channel: 'stdout', data: 'b-dup', seq: 1 });
    fake.push({ type: 'stream', id: 's1', channel: 'stdout', data: 'late', seq: 0 });
    fake.push({ type: 'stream', id: 's1', channel: 'stdout', data: 'c', seq: 2 });
    await new Promise((r) => setImmediate(r));
    expect(out.join('')).toBe('abc');
  });

  it('ignores frames addressed to a different spawn id', async () => {
    const fake = new FakeRunner();
    const t = new RemoteRunnerTransport('r1', fake.buildDeps('r1', { generateId: () => 's1' }));
    const p = t.spawn({ engine: 'claude-code', args: [], sessionId: 'sess-1' });
    fake.push({ type: 'result', id: 's1', ok: true, pid: 1 });
    const handle = await p;

    const out: string[] = [];
    handle.stdout!.on('data', (c) => out.push(c.toString()));
    fake.push({ type: 'stream', id: 'someone-else', channel: 'stdout', data: 'X', seq: 0 });
    fake.push({ type: 'stream', id: 's1', channel: 'stdout', data: 'mine', seq: 0 });
    await new Promise((r) => setImmediate(r));
    expect(out.join('')).toBe('mine');
  });
});

describe('RemoteRunnerTransport — exit', () => {
  it('emits close with code/signal and ends both streams', async () => {
    const fake = new FakeRunner();
    const t = new RemoteRunnerTransport('r1', fake.buildDeps('r1', { generateId: () => 's1' }));
    const p = t.spawn({ engine: 'claude-code', args: [], sessionId: 'sess-1' });
    fake.push({ type: 'result', id: 's1', ok: true, pid: 1 });
    const handle = await p;

    const close = waitForClose(handle);
    // Drain so PassThrough flips into flowing mode and emits `end`.
    const stdoutEnded = waitForEnd(handle.stdout!);
    const stderrEnded = waitForEnd(handle.stderr!);
    fake.push({ type: 'exit', id: 's1', code: 0, signal: null });

    const r = await close;
    expect(r).toEqual({ code: 0, signal: null });
    await Promise.all([stdoutEnded, stderrEnded]);
    // No leaked listeners after exit.
    expect(fake.listenerCount).toBe(0);
  });

  it('forwards signal-based exit', async () => {
    const fake = new FakeRunner();
    const t = new RemoteRunnerTransport('r1', fake.buildDeps('r1', { generateId: () => 's1' }));
    const p = t.spawn({ engine: 'claude-code', args: [], sessionId: 'sess-1' });
    fake.push({ type: 'result', id: 's1', ok: true, pid: 1 });
    const handle = await p;

    const close = waitForClose(handle);
    fake.push({ type: 'exit', id: 's1', code: null, signal: 'SIGKILL' });
    expect(await close).toEqual({ code: null, signal: 'SIGKILL' });
  });
});

describe('RemoteRunnerTransport — kill / stdin', () => {
  it('kill() sends a cancel frame with the requested signal', async () => {
    const fake = new FakeRunner();
    const t = new RemoteRunnerTransport('r1', fake.buildDeps('r1', { generateId: () => 's1' }));
    const p = t.spawn({ engine: 'claude-code', args: [], sessionId: 'sess-1' });
    fake.push({ type: 'result', id: 's1', ok: true, pid: 1 });
    const handle = await p;

    expect(handle.kill('SIGKILL')).toBe(true);
    const cancel = fake.sent.find(
      (f): f is RunnerCancelMessage => (f as { type: string }).type === 'cancel',
    );
    expect(cancel).toEqual({ type: 'cancel', id: 's1', signal: 'SIGKILL' });
  });

  it('kill() defaults to SIGTERM (omits signal field) and is a no-op after exit', async () => {
    const fake = new FakeRunner();
    const t = new RemoteRunnerTransport('r1', fake.buildDeps('r1', { generateId: () => 's1' }));
    const p = t.spawn({ engine: 'claude-code', args: [], sessionId: 'sess-1' });
    fake.push({ type: 'result', id: 's1', ok: true, pid: 1 });
    const handle = await p;

    expect(handle.kill()).toBe(true);
    const cancel = fake.sent.find(
      (f): f is RunnerCancelMessage => (f as { type: string }).type === 'cancel',
    );
    expect(cancel).toEqual({ type: 'cancel', id: 's1' });

    fake.push({ type: 'exit', id: 's1', code: null, signal: 'SIGTERM' });
    await waitForClose(handle);
    expect(handle.kill()).toBe(false);
  });

  it('stdin.write() forwards stdin frames; end() sends end:true', async () => {
    const fake = new FakeRunner();
    const t = new RemoteRunnerTransport('r1', fake.buildDeps('r1', { generateId: () => 's1' }));
    const p = t.spawn({ engine: 'claude-code', args: [], sessionId: 'sess-1' });
    fake.push({ type: 'result', id: 's1', ok: true, pid: 1 });
    const handle = await p;

    handle.stdin!.write('chunk-a');
    handle.stdin!.write('chunk-b');
    await new Promise<void>((resolve) => handle.stdin!.end(resolve));

    const stdinFrames = fake.sent.filter(
      (f): f is RunnerStdinMessage => (f as { type: string }).type === 'stdin',
    );
    expect(stdinFrames).toEqual([
      { type: 'stdin', id: 's1', data: 'chunk-a' },
      { type: 'stdin', id: 's1', data: 'chunk-b' },
      { type: 'stdin', id: 's1', data: '', end: true },
    ]);
  });
});

describe('RemoteRunnerTransport — disconnect & timeout', () => {
  it('rejects pending spawn with RUNNER_DISCONNECTED when runner disconnects before result', async () => {
    const fake = new FakeRunner();
    const t = new RemoteRunnerTransport('r1', fake.buildDeps('r1', { generateId: () => 's1' }));
    const p = t.spawn({ engine: 'claude-code', args: [], sessionId: 'sess-1' });
    // Disconnect before any result frame.
    fake.fireDisconnect();
    await expect(p).rejects.toMatchObject({
      code: 'RUNNER_DISCONNECTED',
      message: /disconnected/i,
    });
    // Listener cleanup ran on teardown.
    expect(fake.listenerCount).toBe(0);
    expect(fake.disconnectListenerCount).toBe(0);
  });

  it('emits synthetic close + error when runner disconnects after spawn-ack', async () => {
    const fake = new FakeRunner();
    const t = new RemoteRunnerTransport('r1', fake.buildDeps('r1', { generateId: () => 's1' }));
    const p = t.spawn({ engine: 'claude-code', args: [], sessionId: 'sess-1' });
    fake.push({ type: 'result', id: 's1', ok: true, pid: 1 });
    const handle = await p;

    const close = waitForClose(handle);
    const errorPromise = new Promise<Error>((resolve) => {
      handle.on('error', (e) => resolve(e as Error));
    });
    const stdoutEnded = waitForEnd(handle.stdout!);
    const stderrEnded = waitForEnd(handle.stderr!);

    fake.fireDisconnect();

    expect(await close).toEqual({ code: null, signal: null });
    const err = await errorPromise;
    expect((err as { code?: string }).code).toBe('RUNNER_DISCONNECTED');
    await Promise.all([stdoutEnded, stderrEnded]);
    expect(fake.listenerCount).toBe(0);
    expect(fake.disconnectListenerCount).toBe(0);
  });

  it('rejects with SPAWN_FAILED when the runner never acks within spawnTimeoutMs', async () => {
    const fake = new FakeRunner();
    const t = new RemoteRunnerTransport(
      'r1',
      fake.buildDeps('r1', { generateId: () => 's1', spawnTimeoutMs: 50 }),
    );
    const start = Date.now();
    await expect(
      t.spawn({ engine: 'claude-code', args: [], sessionId: 'sess-1' }),
    ).rejects.toMatchObject({
      code: 'SPAWN_FAILED',
      message: /50ms/,
    });
    // Sanity-check: elapsed time is in the right ballpark (not the 30s default).
    expect(Date.now() - start).toBeLessThan(2_000);
    // Teardown ran — no leaked subscriptions.
    expect(fake.listenerCount).toBe(0);
    expect(fake.disconnectListenerCount).toBe(0);
  });

  it('rejects with SPAWN_FAILED when the runner sends exit before result', async () => {
    const fake = new FakeRunner();
    const t = new RemoteRunnerTransport('r1', fake.buildDeps('r1', { generateId: () => 's1' }));
    const p = t.spawn({ engine: 'claude-code', args: [], sessionId: 'sess-1' });
    // Protocol violation: exit with no preceding result.
    fake.push({ type: 'exit', id: 's1', code: 1, signal: null });
    await expect(p).rejects.toMatchObject({
      code: 'SPAWN_FAILED',
      message: /exit before result/i,
    });
    expect(fake.listenerCount).toBe(0);
    expect(fake.disconnectListenerCount).toBe(0);
  });
});

describe('RemoteRunnerTransport — error surface', () => {
  it('rejects when the sender throws synchronously', async () => {
    const deps: RemoteRunnerTransportDeps = {
      getSender: () => {
        return () => {
          throw new Error('socket dead');
        };
      },
      subscribe: () => () => {},
      subscribeDisconnect: () => () => {},
      generateId: () => 's1',
      spawnTimeoutMs: 0,
    };
    const t = new RemoteRunnerTransport('r1', deps);
    await expect(t.spawn({ engine: 'x', args: [], sessionId: 'sess' })).rejects.toMatchObject({
      code: 'SPAWN_FAILED',
      message: /socket dead/,
    });
  });

  it('isRunnerTransportError narrows error shape', () => {
    const fake = new FakeRunner();
    fake.disconnect();
    const t = new RemoteRunnerTransport('r1', fake.buildDeps('r1'));
    return t.spawn({ engine: 'x', args: [], sessionId: 'sess-1' }).catch((err) => {
      expect(isRunnerTransportError(err)).toBe(true);
      if (isRunnerTransportError(err)) {
        expect(err.code).toBe('RUNNER_OFFLINE');
      }
    });
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────

function collectString(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    stream.on('data', (c) => (out += c.toString()));
    stream.on('end', () => resolve(out));
    stream.on('error', reject);
  });
}

function waitForClose(handle: {
  on(event: 'close', cb: (code: number | null, signal: string | null) => void): unknown;
}): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    handle.on('close', (code, signal) => resolve({ code, signal }));
  });
}

function waitForEnd(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve) => {
    stream.on('end', () => resolve());
    stream.resume(); // flowing mode so `end` fires even with no data listener
  });
}

// silence unused
void vi;
