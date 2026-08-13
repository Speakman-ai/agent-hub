import { describe, it, expect, vi } from 'vitest';
import { createVmAgentProcess, createVmAgentPty } from './vm-agent-process.js';
import type { VmAgentStream } from './vm-agent-client.js';
import {
  VmAgentFrameDecoder,
  encodeFrame,
  decodeJsonPayload,
  type VmAgentControl,
  type VmAgentFrame,
} from './vm-agent-protocol.js';

class FakeStream implements VmAgentStream {
  readonly sent: Buffer[] = [];
  closed = false;
  #frameSubs = new Set<(f: VmAgentFrame) => void>();
  #closeSubs = new Set<(err?: Error) => void>();

  send(frame: Buffer): void {
    this.sent.push(frame);
  }
  onFrame(cb: (f: VmAgentFrame) => void): () => void {
    this.#frameSubs.add(cb);
    return () => this.#frameSubs.delete(cb);
  }
  onClose(cb: (err?: Error) => void): () => void {
    this.#closeSubs.add(cb);
    return () => this.#closeSubs.delete(cb);
  }
  close(): void {
    this.emitClose();
  }

  emit(type: Parameters<typeof encodeFrame>[0], payload: Buffer): void {
    for (const cb of this.#frameSubs) cb({ type, payload });
  }
  emitJson(type: Parameters<typeof encodeFrame>[0], value: unknown): void {
    this.emit(type, Buffer.from(JSON.stringify(value)));
  }
  emitClose(err?: Error): void {
    this.closed = true;
    for (const cb of this.#closeSubs) cb(err);
  }

  decodeSent(): VmAgentFrame[] {
    const decoder = new VmAgentFrameDecoder();
    return this.sent.flatMap((c) => decoder.push(c));
  }
}

describe('createVmAgentProcess', () => {
  it('reports the guest pid once the agent announces it', () => {
    const stream = new FakeStream();
    const { process } = createVmAgentProcess({ stream, name: 'dev' });
    expect(process.pid).toBeNull();
    stream.emitJson('started', { pid: 412 });
    expect(process.pid).toBe(412);
  });

  it('fans stdout and stderr out to subscribers', () => {
    const stream = new FakeStream();
    const { process } = createVmAgentProcess({ stream, name: 'dev' });
    const out: string[] = [];
    const err: string[] = [];
    process.onStdout((c) => out.push(c));
    process.onStderr((c) => err.push(c));
    stream.emit('stdout', Buffer.from('building'));
    stream.emit('stderr', Buffer.from('warn'));
    expect(out).toEqual(['building']);
    expect(err).toEqual(['warn']);
  });

  it('settles once with the exit frame', async () => {
    const stream = new FakeStream();
    const { process, exited } = createVmAgentProcess({ stream, name: 'dev' });
    const onExit = vi.fn();
    process.onExit(onExit);
    stream.emitJson('exit', { code: 3, signal: null });
    stream.emitJson('exit', { code: 0, signal: null });
    await exited;
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(process.exitResult).toEqual({ code: 3, signal: null });
    expect(process.exited).toBe(true);
  });

  it('replays the exit to a subscriber that arrives late', () => {
    const stream = new FakeStream();
    const { process } = createVmAgentProcess({ stream, name: 'dev' });
    stream.emitJson('exit', { code: 0, signal: null });
    const cb = vi.fn();
    process.onExit(cb);
    expect(cb).toHaveBeenCalledWith({ code: 0, signal: null });
  });

  it('settles with an error when the VM dies without an exit frame', async () => {
    // A host reap or guest panic drops the stream. Reporting a plausible
    // exit 0 here would tell the dev-server runtime the command succeeded.
    const stream = new FakeStream();
    const { process, exited } = createVmAgentProcess({ stream, name: 'dev' });
    stream.emitClose();
    await exited;
    expect(process.exitResult?.code).toBeNull();
    expect(process.exitResult?.error?.message).toMatch(
      /closed before the process reported an exit/,
    );
  });

  it('prefers the transport error when the stream fails', async () => {
    const stream = new FakeStream();
    const { process, exited } = createVmAgentProcess({ stream, name: 'dev' });
    stream.emitClose(new Error('vsock reset'));
    await exited;
    expect(process.exitResult?.error?.message).toBe('vsock reset');
  });

  it('maps an agent error frame onto a spawn failure', async () => {
    const stream = new FakeStream();
    const { process, exited } = createVmAgentProcess({ stream, name: 'dev' });
    stream.emitJson('error', { message: 'sh: nope: not found', code: 'ENOENT' });
    await exited;
    expect(process.exitResult?.error?.message).toBe('sh: nope: not found');
  });

  it('sends a signal control frame on kill and stops after exit', () => {
    const stream = new FakeStream();
    const { process } = createVmAgentProcess({ stream, name: 'dev' });
    process.kill('SIGTERM');
    const frames = stream.decodeSent();
    expect(frames).toHaveLength(1);
    expect(decodeJsonPayload<VmAgentControl>(frames[0].payload)).toEqual({
      kind: 'signal',
      signal: 'SIGTERM',
    });

    stream.emitJson('exit', { code: 0, signal: null });
    process.kill('SIGKILL');
    expect(stream.decodeSent()).toHaveLength(1);
  });

  it('notifies the env on every frame so idle reaping sees activity', () => {
    const onActivity = vi.fn();
    const stream = new FakeStream();
    createVmAgentProcess({ stream, name: 'dev', onActivity });
    stream.emit('stdout', Buffer.from('x'));
    expect(onActivity).toHaveBeenCalled();
  });
  it('sends writeStdin / endStdin over the stream', () => {
    const stream = new FakeStream();
    const { process } = createVmAgentProcess({ stream, name: 'codex' });
    process.writeStdin?.('prompt body');
    process.endStdin?.();
    const frames = stream.decodeSent();
    expect(frames[0].type).toBe('stdin');
    expect(frames[0].payload.toString()).toBe('prompt body');
    expect(decodeJsonPayload<VmAgentControl>(frames[1].payload)).toEqual({
      kind: 'stdin-eof',
    });
  });
});

describe('createVmAgentPty', () => {
  it('writes input as raw stdin frames', () => {
    const stream = new FakeStream();
    const { pty } = createVmAgentPty({ stream, pid: 9 });
    pty.write('ls -la\n');
    const frames = stream.decodeSent();
    expect(frames[0].type).toBe('stdin');
    expect(frames[0].payload.toString()).toBe('ls -la\n');
  });

  it('sends resize as a control frame', () => {
    const stream = new FakeStream();
    const { pty } = createVmAgentPty({ stream, pid: 9 });
    pty.resize(120, 40);
    expect(decodeJsonPayload<VmAgentControl>(stream.decodeSent()[0].payload)).toEqual({
      kind: 'resize',
      cols: 120,
      rows: 40,
    });
  });

  it('merges stderr into terminal output', () => {
    // A real PTY has one master; the guest still labels frames, but a
    // terminal that dropped stderr would silently lose compiler errors.
    const stream = new FakeStream();
    const { pty } = createVmAgentPty({ stream, pid: 9 });
    const seen: string[] = [];
    pty.onData((d) => seen.push(d));
    stream.emit('stdout', Buffer.from('out'));
    stream.emit('stderr', Buffer.from('err'));
    expect(seen).toEqual(['out', 'err']);
  });

  it('settles once whether the shell exits or the VM disappears', async () => {
    const stream = new FakeStream();
    const { pty, exited } = createVmAgentPty({ stream, pid: 9 });
    const onExit = vi.fn();
    pty.onExit(onExit);
    stream.emitJson('exit', { code: 130, signal: null });
    stream.emitClose();
    await exited;
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith({ exitCode: 130, signal: undefined });
  });

  it('treats a dropped stream as the shell ending', async () => {
    const stream = new FakeStream();
    const { pty, exited } = createVmAgentPty({ stream, pid: 9 });
    const onExit = vi.fn();
    pty.onExit(onExit);
    stream.emitClose();
    await exited;
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes data listeners on demand', () => {
    const stream = new FakeStream();
    const { pty } = createVmAgentPty({ stream, pid: 9 });
    const seen: string[] = [];
    const off = pty.onData((d) => seen.push(d));
    stream.emit('stdout', Buffer.from('a'));
    off();
    stream.emit('stdout', Buffer.from('b'));
    expect(seen).toEqual(['a']);
  });
});
