import { describe, it, expect, vi } from 'vitest';
import {
  FirecrackerSessionEnv,
  VmAgentProtocolMismatchError,
  defaultPrepareDisks,
  STREAM_WRITE_TIMEOUT_MS,
  type FirecrackerHostIo,
  type FirecrackerSlotPool,
} from './firecracker-session-env.js';
import type { VsockDuplex } from './vm-agent-client.js';
import {
  VmAgentFrameDecoder,
  VM_AGENT_PROTOCOL_VERSION,
  WRITE_FILE_CHUNK_BYTES,
  encodeFrame,
  encodeJsonFrame,
  decodeJsonPayload,
  type VmAgentFrame,
  type VmAgentReply,
  type VmAgentRequest,
} from './vm-agent-protocol.js';
import { SessionEnvDisposedError } from '../session-env.js';

/**
 * Opening a stream takes several turns — connect, CONNECT line, the VMM's
 * reply, then the request frame — so a single tick lands mid-handshake and
 * sees no request at all.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Stands in for the agent inside the guest: completes the VMM handshake, then
 * decodes request frames and lets a test drive replies. Exercising the
 * adapter against this covers the whole exec/PTY lifecycle with no KVM.
 */
class FakeGuestConnection implements VsockDuplex {
  request: VmAgentRequest | null = null;
  destroyed = false;
  ended = false;
  readonly sentFrames: VmAgentFrame[] = [];
  /** When false, the next post-handshake `write` reports backpressure. */
  writable = true;
  #decoder = new VmAgentFrameDecoder();
  #handshakeDone = false;
  #data: ((chunk: Buffer) => void)[] = [];
  #close: (() => void)[] = [];
  #error: ((err: Error) => void)[] = [];
  #drain: (() => void)[] = [];

  constructor(
    private readonly accept: boolean,
    /** Reply sent for a `ping`; null to model an agent that never answers. */
    readonly pong: VmAgentReply | null = {
      kind: 'pong',
      protocolVersion: VM_AGENT_PROTOCOL_VERSION,
      bootId: 'boot-1',
    },
  ) {}

  write(data: Buffer): boolean {
    if (!this.#handshakeDone) {
      this.#handshakeDone = true;
      const reply = this.accept ? 'OK 1024\n' : 'FAILED\n';
      setImmediate(() => this.emitData(Buffer.from(reply)));
      return true;
    }
    for (const frame of this.#decoder.push(data)) {
      this.sentFrames.push(frame);
      if (frame.type === 'request') {
        this.request = decodeJsonPayload<VmAgentRequest>(frame.payload);
        // Boot blocks on a real pong, so a fake guest that never answers would
        // stall every test at the readiness gate.
        if (this.request.kind === 'ping' && this.pong) {
          const pong = this.pong;
          setImmediate(() => this.replyJson('reply', pong));
        }
      }
    }
    return this.writable;
  }
  end(): void {
    this.ended = true;
    this.emitClose();
  }
  destroy(): void {
    this.destroyed = true;
  }
  on(event: 'data', cb: (chunk: Buffer) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'drain', cb: () => void): void;
  on(event: 'data' | 'close' | 'error' | 'drain', cb: never): void {
    if (event === 'data') this.#data.push(cb);
    else if (event === 'close') this.#close.push(cb);
    else if (event === 'drain') this.#drain.push(cb);
    else this.#error.push(cb);
  }

  /** Release backpressure and wake the host's drain waiter. */
  emitDrain(): void {
    this.writable = true;
    for (const cb of this.#drain) cb();
  }

  emitData(chunk: Buffer): void {
    for (const cb of this.#data) cb(chunk);
  }
  emitClose(): void {
    for (const cb of this.#close) cb();
  }
  /** Push a guest→host frame onto this stream. */
  reply(type: VmAgentFrame['type'], payload: Buffer): void {
    this.emitData(encodeFrame(type, payload));
  }
  replyJson(type: VmAgentFrame['type'], value: unknown): void {
    this.emitData(encodeJsonFrame(type, value));
  }
}

class FakeGuest {
  readonly connections: FakeGuestConnection[] = [];
  accept = true;
  /** Backpressure state applied to every new connection at creation. */
  defaultWritable = true;
  /** Overridden to model a stale guest image or an agent that never answers. */
  pong: VmAgentReply | null = {
    kind: 'pong',
    protocolVersion: VM_AGENT_PROTOCOL_VERSION,
    bootId: 'boot-1',
  };

  connect = async (): Promise<VsockDuplex> => {
    const conn = new FakeGuestConnection(this.accept, this.pong);
    conn.writable = this.defaultWritable;
    this.connections.push(conn);
    return conn;
  };

  /** Connections opened for real work (the readiness ping is the first). */
  get workConnections(): FakeGuestConnection[] {
    return this.connections.slice(1);
  }
}

function makeIo(overrides: Partial<FirecrackerHostIo> = {}) {
  const runs: string[][] = [];
  const written = new Map<string, string>();
  const removed: string[] = [];
  const io: FirecrackerHostIo = {
    run: async (argv) => {
      runs.push(argv);
      // ensureFirecrackerGuestNat / tap ops go through fc-netctl.
      if (typeof argv[0] === 'string' && argv[0].endsWith('fc-netctl.sh')) {
        if (argv[1] === 'list-taps') {
          return { ok: true, stdout: '', stderr: '' };
        }
        return { ok: true, stdout: '', stderr: '' };
      }
      return { ok: true, stdout: '', stderr: '' };
    },
    writeFile: async (path, contents) => {
      written.set(path, contents);
    },
    mkdirp: async () => undefined,
    rmrf: async (path) => {
      removed.push(path);
    },
    isDirectory: async () => true,
    ...overrides,
  };
  return { io, runs, written, removed };
}

function makeSlots(): FirecrackerSlotPool & { released: number[] } {
  let next = 3;
  const released: number[] = [];
  return {
    allocate: () => next++,
    release: (slot) => released.push(slot),
    released,
  };
}

function makeVmm() {
  const spawned: { file: string; args: string[]; vmId: string; cwd: string }[] = [];
  const spawnVmm = ((spec: { vmId: string; argv: string[]; cwd: string }) => {
    spawned.push({
      file: spec.argv[0],
      args: spec.argv.slice(1),
      vmId: spec.vmId,
      cwd: spec.cwd,
    });
    return {
      pid: 4242,
      stdout: { on: () => undefined },
      stderr: { on: () => undefined },
      on: () => undefined,
    };
  }) as never;
  return { spawnVmm, spawned };
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  const { io, runs, written, removed } = makeIo(
    (overrides.ioOverrides as Partial<FirecrackerHostIo>) ?? {},
  );
  const slots = makeSlots();
  const guest = new FakeGuest();
  const { spawnVmm, spawned } = makeVmm();
  const stopVmm = vi.fn();
  const env = new FirecrackerSessionEnv({
    sessionId: 'sess-1',
    worktreePath: '/wt/sess-1',
    slots,
    paths: {
      kernelPath: '/var/lib/agent-hub/fc/vmlinux',
      baseRootfsPath: '/var/lib/agent-hub/fc/rootfs.ext4',
      runDir: '/var/lib/agent-hub/fc/vms',
      controlDir: '/run/agent-hub/vm-control',
      jailerChrootBase: '/srv/jailer',
    },
    io,
    slotsOverride: undefined,
    spawnVmm,
    stopVmm,
    connect: guest.connect,
    readyTimeoutMs: 2000,
    readyPollMs: 1,
    logger: { warn: () => undefined },
    ...overrides,
  } as never);
  return { env, io, runs, written, removed, slots, guest, spawned, stopVmm };
}

describe('FirecrackerSessionEnv start', () => {
  it('creates the tap, prepares disks, writes a config, and boots the VMM', async () => {
    const { env, runs, written, spawned } = makeEnv();
    await env.ensureStarted();

    expect(
      runs.some(
        (a) => a[0]?.endsWith('fc-netctl.sh') && a[1] === 'tap-create' && a.includes('ahfct3'),
      ),
    ).toBe(true);
    expect(runs.some((a) => a[0].endsWith('fc-prepare-disks.sh'))).toBe(true);
    // Guest bridge + NAT are ensured before the tap is created. Chat sessions
    // use the host adapter, so Hub boot may skip the Firecracker sweep —
    // isolated mode must create ahfc0 itself.
    const netctl = runs.filter((a) => a[0]?.endsWith('fc-netctl.sh')).map((a) => a[1]);
    expect(netctl.indexOf('ensure-bridge')).toBeGreaterThanOrEqual(0);
    expect(netctl.indexOf('ensure-bridge')).toBeLessThan(netctl.indexOf('ensure-nat'));
    expect(netctl.indexOf('ensure-nat')).toBeLessThan(netctl.indexOf('tap-create'));

    const config = JSON.parse([...written.values()][0]);
    expect(config['machine-config'].vcpu_count).toBeGreaterThan(0);
    expect(config.vsock.guest_cid).toBe(3);
    expect(config['boot-source'].boot_args).toContain('ahvm.session=sess-1');

    expect(spawned[0].file).toBe('jailer');
    expect(env.vmStarted).toBe(true);
    expect(env.guestIp).toBe('172.30.0.3');
  });

  it('fails closed when the guest bridge cannot be created', async () => {
    const { env } = makeEnv({
      ioOverrides: {
        run: async (argv: string[]) => {
          if (argv[1] === 'ensure-bridge') {
            return { ok: false, stdout: '', stderr: 'Cannot find device "ahfc0"' };
          }
          return { ok: true, stdout: '', stderr: '' };
        },
      },
    });
    await expect(env.ensureStarted()).rejects.toThrow(/guest bridge is not ready/);
  });

  it('fails closed when guest NAT cannot be installed', async () => {
    const { env } = makeEnv({
      ioOverrides: {
        run: async (argv: string[]) => {
          if (argv[1] === 'ensure-nat') {
            return { ok: false, stdout: '', stderr: 'no uplink' };
          }
          return { ok: true, stdout: '', stderr: '' };
        },
      },
    });
    await expect(env.ensureStarted()).rejects.toThrow(/guest NAT is not ready/);
  });

  it('clears leftover sockets before binding them', async () => {
    // Firecracker binds api.sock and vsock.sock and refuses to start when
    // either exists. The vm id is derived from the session id, so a session
    // whose VMM died without unlinking them (host reboot, OOM kill) reboots
    // onto its own leftovers and fails with FailedToBindSocket forever — the
    // session can never get an environment again.
    const { env, removed, stopVmm } = makeEnv();
    await env.ensureStarted();

    expect(stopVmm).toHaveBeenCalledWith({
      vmId: 'ahvm-sess-1',
      pid: undefined,
      pidFile: '/run/agent-hub/vm-control/ahvm-sess-1/vmm.pid',
      identityFile: '/run/agent-hub/vm-control/ahvm-sess-1/vmm.identity.json',
    });
    expect(removed).toContain('/run/agent-hub/vm-control/ahvm-sess-1/api.sock');
    // Jailer creates the vsock inside the chroot; leftovers are cleared there.
    expect(removed).toContain('/srv/jailer/firecracker/ahvm-sess-1/root/vsock.sock');
  });

  it('boots under the jailer by default', async () => {
    const { env, spawned, runs } = makeEnv({ jailerUid: 1001, jailerGid: 1001 });
    await env.ensureStarted();
    expect(spawned[0].file).toBe('jailer');
    expect(spawned[0].args).toContain('--chroot-base-dir');
    // Relative to the jail root after pivot_root — not host-absolute paths.
    const configIdx = spawned[0].args.indexOf('--config-file');
    expect(spawned[0].args[configIdx + 1]).toBe('vm-config.json');
    const apiIdx = spawned[0].args.indexOf('--api-sock');
    expect(spawned[0].args[apiIdx + 1]).toBe('api.sock');
    expect(runs.some((a) => a[0].endsWith('fc-jail-manage.sh') && a[1] === 'clean')).toBe(true);
    const stage = runs.find((a) => a[0].endsWith('fc-jail-manage.sh') && a[1] === 'stage');
    expect(stage).toBeTruthy();
    // stage <root> <kernel> <rootfs> <workspace> <uid> <gid> <configSrc>
    expect(stage![6]).toBe('1001');
    expect(stage![7]).toBe('1001');
    expect(stage![8]).toMatch(/vm-config\.json$/);
  });

  it('can opt out of the jailer for debugging', async () => {
    const { env, spawned } = makeEnv({ useJailer: false });
    await env.ensureStarted();
    expect(spawned[0].file).toBe('firecracker');
  });

  it('is idempotent across concurrent callers', async () => {
    const { env, spawned } = makeEnv();
    await Promise.all([env.ensureStarted(), env.ensureStarted(), env.ensureStarted()]);
    expect(spawned).toHaveLength(1);
  });

  it('refuses to start without a worktree', async () => {
    const { env } = makeEnv({ ioOverrides: { isDirectory: async () => false } });
    await expect(env.ensureStarted()).rejects.toThrow(/Session worktree not found/);
  });

  it('unwinds the tap and slot when the boot fails', async () => {
    // A half-booted VM would hold a slot and an interface forever while never
    // serving a request, and the next allocation would collide on the name.
    const guest = new FakeGuest();
    guest.accept = false;
    const { env, runs, slots } = makeEnv({ connect: guest.connect, readyTimeoutMs: 5 });

    await expect(env.ensureStarted()).rejects.toThrow(/did not answer within/);
    expect(runs.some((a) => a[0]?.endsWith('fc-netctl.sh') && a[1] === 'tap-delete')).toBe(true);
    expect(slots.released).toEqual([3]);
    expect(env.vmStarted).toBe(false);
  });

  it('allows a retry after a failed boot', async () => {
    const guest = new FakeGuest();
    guest.accept = false;
    const { env } = makeEnv({ connect: guest.connect, readyTimeoutMs: 5 });
    await expect(env.ensureStarted()).rejects.toThrow();
    guest.accept = true;
    await expect(env.ensureStarted()).resolves.toBeUndefined();
  });
});

describe('FirecrackerSessionEnv processes', () => {
  it('rejects spawn before the VM is up rather than queueing', async () => {
    const { env } = makeEnv();
    expect(() => env.spawn('npm run dev')).toThrow(/is not started/);
  });

  it('sends an exec request with a guest-absolute cwd and merged env', async () => {
    const { env, guest } = makeEnv({ baseEnv: { BASE: '1' } });
    await env.ensureStarted();
    env.spawn('npm run dev', { cwd: 'frontend', env: { PORT: '4200' } });
    await flush();

    const conn = guest.workConnections[0];
    expect(conn.request).toEqual({
      kind: 'exec',
      command: 'npm run dev',
      cwd: '/workspace/frontend',
      env: { BASE: '1', PORT: '4200' },
      name: 'npm run dev',
    });
  });

  it('streams output and settles on the guest exit code', async () => {
    const { env, guest } = makeEnv();
    await env.ensureStarted();
    const proc = env.spawn('build');
    await flush();
    const conn = guest.workConnections[0];

    const out: string[] = [];
    proc.onStdout((c) => out.push(c));
    const onExit = vi.fn();
    proc.onExit(onExit);

    conn.replyJson('started', { pid: 91 });
    conn.reply('stdout', Buffer.from('compiling'));
    conn.replyJson('exit', { code: 2, signal: null });
    await flush();

    expect(proc.pid).toBe(91);
    expect(out).toEqual(['compiling']);
    expect(onExit).toHaveBeenCalledWith({ code: 2, signal: null });
    // Exited processes are dropped; the VM boundary itself is not a live count.
    expect(env.liveProcessCount()).toBe(0);
  });

  it('rejects a cwd that escapes the worktree', async () => {
    const { env } = makeEnv();
    await env.ensureStarted();
    expect(() => env.spawn('ls', { cwd: '../etc' })).toThrow(/must not escape/);
    expect(() => env.spawn('ls', { cwd: '/etc' })).toThrow(/must be relative/);
  });

  it('opens a PTY once the guest reports its pid', async () => {
    const { env, guest } = makeEnv();
    await env.ensureStarted();
    const opening = env.openPty({ cols: 120, rows: 40 });
    await flush();

    const conn = guest.workConnections[0];
    expect(conn.request).toMatchObject({ kind: 'pty', cols: 120, rows: 40, cwd: '/workspace' });

    conn.replyJson('started', { pid: 55 });
    const pty = await opening;
    expect(pty.pid).toBe(55);
    expect(env.liveProcessCount()).toBe(1);
  });

  it('carries an unset variable as an explicit null', async () => {
    // JSON cannot express `undefined`, and an absent key would read as
    // "leave it alone" — the opposite of what the terminal asks for when it
    // drops ambient AWS credentials.
    const { env, guest } = makeEnv();
    await env.ensureStarted();
    void env.openPty({ env: { AWS_PROFILE: undefined, TERM_APP: 'hub' } });
    await flush();

    const request = guest.workConnections[0].request as { env: Record<string, string | null> };
    expect(request.env.AWS_PROFILE).toBeNull();
    expect(request.env.TERM_APP).toBe('hub');
  });
});

describe('FirecrackerSessionEnv writeGuestFile', () => {
  it('sends a small body as a single JSON write-file frame', async () => {
    const { env, guest } = makeEnv();
    await env.ensureStarted();
    const writing = env.writeGuestFile('/workspace/note.txt', Buffer.from('hello vm'));
    await flush();

    const conn = guest.workConnections[0];
    expect(conn.request).toMatchObject({
      kind: 'write-file',
      path: '/workspace/note.txt',
      contentBase64: Buffer.from('hello vm').toString('base64'),
    });
    conn.replyJson('reply', { kind: 'written' });
    await writing;
  });

  it('streams a body above WRITE_FILE_CHUNK_BYTES via cat + stdin instead of JSON', async () => {
    // Regression: copying a chat zip into the guest used to JSON-base64 the
    // whole file into one vsock frame. encodeFrame throws above 8 MB, and the
    // Hub process died (uncaught handleChat rejection / OOM).
    const { env, guest } = makeEnv();
    await env.ensureStarted();
    const payload = Buffer.alloc(WRITE_FILE_CHUNK_BYTES + 1, 7);
    const writing = env.writeGuestFile('/workspace/.agent-hub-images/pack.zip', payload);
    await flush();

    const conn = guest.workConnections[0];
    expect(conn.request).toMatchObject({
      kind: 'exec',
      cwd: '/workspace',
    });
    expect((conn.request as { command: string }).command).toContain(
      "cat > '/workspace/.agent-hub-images/pack.zip'",
    );
    expect(guest.workConnections.every((c) => c.request?.kind !== 'write-file')).toBe(true);

    const stdin = Buffer.concat(
      conn.sentFrames.filter((f) => f.type === 'stdin').map((f) => f.payload),
    );
    expect(stdin.equals(payload)).toBe(true);

    conn.replyJson('started', { pid: 11 });
    conn.replyJson('exit', { code: 0, signal: null });
    await writing;
  });

  it('parks on transport backpressure instead of queueing the whole body', async () => {
    // Regression: a slow guest consumer must not let a large attachment pile up
    // in host/socket memory. When the stdin transport signals backpressure the
    // streaming loop stops writing and waits for a drain.
    const { env, guest } = makeEnv();
    await env.ensureStarted();
    // The `cat` connection is backpressured from the first stdin write.
    guest.defaultWritable = false;
    const payload = Buffer.alloc(WRITE_FILE_CHUNK_BYTES * 3, 9);
    const writing = env.writeGuestFile('/workspace/big.bin', payload);
    await flush();

    const conn = guest.workConnections[0];
    const stdinFrames = () => conn.sentFrames.filter((f) => f.type === 'stdin').length;
    // The whole 3-chunk body is NOT on the wire — the loop parked mid-stream.
    expect(stdinFrames()).toBeLessThan(3);
    const parked = stdinFrames();
    // Still parked: no forward progress while backpressured.
    await flush();
    expect(stdinFrames()).toBe(parked);

    // Consumer catches up: the remaining chunks flush and the write completes.
    conn.emitDrain();
    await flush();
    const stdin = Buffer.concat(
      conn.sentFrames.filter((f) => f.type === 'stdin').map((f) => f.payload),
    );
    expect(stdin.equals(payload)).toBe(true);

    conn.replyJson('started', { pid: 21 });
    conn.replyJson('exit', { code: 0, signal: null });
    await writing;
  });

  it('kills the guest cat when the host source fails mid-stream', async () => {
    // Regression: if the host read stream throws, the spawned `cat` must be
    // torn down rather than left running in the guest's live-process set.
    const { env, guest } = makeEnv();
    await env.ensureStarted();
    const uploading = env.uploadGuestFile('/workspace/pack.zip', '/no/such/source-file-xyz');
    await expect(uploading).rejects.toThrow();
    await flush();

    const conn = guest.workConnections[0];
    expect(conn.request).toMatchObject({ kind: 'exec' });
    const killed = conn.sentFrames.some(
      (f) =>
        f.type === 'control' &&
        decodeJsonPayload<{ kind: string; signal?: string }>(f.payload).signal === 'SIGKILL',
    );
    expect(killed).toBe(true);
  });

  it('rejects with a timeout — and no unhandled rejection — when the stream never drains', async () => {
    // Regression: the timeout rejection must be attached (raced) immediately.
    // Otherwise, firing while the loop is parked on backpressure surfaces as an
    // unhandledRejection and terminates the Hub. Boot on real timers, then fake
    // only setTimeout so the streaming timeout — the sole pending timer — can be
    // advanced deterministically while the vsock handshake still runs live.
    const { env, guest } = makeEnv();
    await env.ensureStarted();

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // Backpressured from the first stdin write and never drained: the loop
      // parks, so the timeout fires with no chunk-level await in flight.
      guest.defaultWritable = false;
      const payload = Buffer.alloc(WRITE_FILE_CHUNK_BYTES * 2, 5);
      const writing = env.writeGuestFile('/workspace/stuck.bin', payload);
      const settled = writing.then(
        () => 'resolved' as const,
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      // Let the live handshake complete and the loop reach its parked state.
      await flush();
      // Fire the streaming timeout.
      vi.advanceTimersByTime(STREAM_WRITE_TIMEOUT_MS + 1);
      // Let the guest ack the kill so the losing pump() unwinds deterministically
      // (a non-racing implementation would surface the timeout error here as its
      // reject reason — this keeps the negative case failing fast, not hanging).
      const conn = guest.workConnections[0];
      conn.replyJson('exit', { code: 137, signal: 'SIGKILL' });
      const outcome = await settled;
      expect(outcome).toMatch(/timed out/);
    } finally {
      vi.useRealTimers();
      // Give Node a real tick to surface any unhandled rejection before checking.
      await new Promise<void>((resolve) => setImmediate(resolve));
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

describe('FirecrackerSessionEnv ports', () => {
  it('dials the guest address with no host port allocation', async () => {
    const { env } = makeEnv();
    await env.ensureStarted();
    const mapping = await env.mapPort(4200);
    expect(mapping).toEqual({
      internalPort: 4200,
      host: '172.30.0.3',
      hostPort: 4200,
      envPort: 4200,
      hostUrl: 'http://172.30.0.3:4200',
    });
  });

  it('accepts a port that first appears long after boot', async () => {
    // The whole point of routing by guest IP: nothing is published, so a
    // service started minutes later needs no restart to become reachable.
    const { env } = makeEnv();
    await env.ensureStarted();
    await env.mapPort(4200);
    const late = await env.resolveDialTarget(8000);
    expect(late).toEqual({ host: '172.30.0.3', port: 8000, url: 'http://172.30.0.3:8000' });
  });

  it('is idempotent and preserves input order in batches', async () => {
    const { env } = makeEnv();
    await env.ensureStarted();
    const mappings = await env.mapPortsOut([8000, 4200, 8000]);
    expect(mappings.map((m) => m.internalPort)).toEqual([8000, 4200, 8000]);
    expect(env.listPortMappings()).toHaveLength(2);
  });

  it('reports the guest mount point and withholds the stale host path', async () => {
    const { env } = makeEnv();
    // The host worktree only seeded the disk; the guest has owned the tree
    // since boot, so handing back a host path would invite stale reads.
    expect(await env.mountWorktree()).toEqual({
      hostPath: null,
      envPath: '/workspace',
      sharing: 'env-owned',
    });
  });
});

describe('FirecrackerSessionEnv dispose', () => {
  it('kills the VMM, drops the tap, releases the slot, and keeps the workspace disk', async () => {
    const { env, runs, slots, removed, stopVmm } = makeEnv();
    await env.ensureStarted();
    await env.dispose();

    expect(stopVmm).toHaveBeenCalledWith({
      vmId: 'ahvm-sess-1',
      pid: 4242,
      pidFile: '/run/agent-hub/vm-control/ahvm-sess-1/vmm.pid',
      identityFile: '/run/agent-hub/vm-control/ahvm-sess-1/vmm.identity.json',
    });
    expect(runs.some((a) => a[0]?.endsWith('fc-netctl.sh') && a[1] === 'tap-delete')).toBe(true);
    // Hub restart / idle reap must not delete workspace.ext4 — the next boot
    // reattaches it. Session archive passes forgetWorkspace to clean.
    expect(runs.some((a) => a[0]?.endsWith('fc-prepare-disks.sh') && a[1] === 'clean')).toBe(false);
    expect(slots.released).toEqual([3]);
    // Control-plane dir is Hub-removable; disk images stay under runDir.
    expect(removed.at(-1)).toBe('/run/agent-hub/vm-control/ahvm-sess-1');
  });

  it('deletes the workspace disk only when the session itself is gone', async () => {
    const { env, runs } = makeEnv();
    await env.ensureStarted();
    await env.dispose({ forgetWorkspace: true });
    expect(runs.at(-1)).toEqual([
      '/usr/local/lib/agent-hub/fc-prepare-disks.sh',
      'clean',
      '--vm-id',
      'ahvm-sess-1',
    ]);
  });

  it('signals live processes before tearing the VM down', async () => {
    const { env, guest } = makeEnv();
    await env.ensureStarted();
    const proc = env.spawn('sleep 999');
    await flush();
    const conn = guest.workConnections[0];
    conn.replyJson('started', { pid: 12 });

    const disposing = env.dispose({ graceMs: 5 });
    await flush();
    const control = conn.sentFrames.filter((f) => f.type === 'control');
    expect(decodeJsonPayload(control[0].payload)).toEqual({
      kind: 'signal',
      signal: 'SIGTERM',
    });

    conn.replyJson('exit', { code: 143, signal: null });
    await disposing;
    expect(proc.exited).toBe(true);
  });

  it('is idempotent and rejects every op afterwards', async () => {
    const { env, stopVmm } = makeEnv();
    await env.ensureStarted();
    await Promise.all([env.dispose(), env.dispose()]);
    expect(stopVmm).toHaveBeenCalledTimes(2);

    expect(() => env.spawn('ls')).toThrow(SessionEnvDisposedError);
    await expect(env.openPty()).rejects.toThrow(SessionEnvDisposedError);
    await expect(env.mapPort(80)).rejects.toThrow(SessionEnvDisposedError);
    await expect(env.mountWorktree()).rejects.toThrow(SessionEnvDisposedError);
  });

  it('fires dispose hooks exactly once', async () => {
    const { env } = makeEnv();
    const hook = vi.fn();
    env.onDispose(hook);
    await env.ensureStarted();
    await env.dispose();
    await env.dispose();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('fails closed when stopVmm rejects — leaves tap/slot/dir untouched', async () => {
    const { env, stopVmm, slots, removed, runs } = makeEnv();
    await env.ensureStarted();
    const tapDeletesBefore = runs.filter((a) => a[1] === 'link' && a[2] === 'del').length;
    // ensureStarted also calls stopVmm to clear leftovers — fail only on dispose.
    stopVmm.mockRejectedValueOnce(new Error('identity mismatch'));

    await expect(env.dispose()).rejects.toThrow(/identity mismatch/);
    expect(env.disposed).toBe(false);
    expect(slots.released).toEqual([]);
    expect(removed).not.toContain('/run/agent-hub/vm-control/ahvm-sess-1');
    expect(runs.filter((a) => a[1] === 'link' && a[2] === 'del')).toHaveLength(tapDeletesBefore);

    // Retry succeeds after stopVmm recovers.
    stopVmm.mockResolvedValueOnce(undefined);
    await env.dispose();
    expect(env.disposed).toBe(true);
    expect(slots.released).toEqual([3]);
  });
});

describe('FirecrackerSessionEnv readiness', () => {
  it('waits for the pong, not just an open connection', async () => {
    // socat in the guest accepts before the agent behind it is listening, so a
    // connection alone declared the VM ready and the first real spawn died on
    // socat's reset. Modelled here by a guest that connects but never answers.
    const { env, guest } = makeEnv({ readyTimeoutMs: 30, readyPollMs: 1 });
    guest.pong = null;
    await expect(env.ensureStarted()).rejects.toThrow(/did not answer within/);
  });

  it('refuses a guest image speaking a different protocol version', async () => {
    // Retrying cannot fix a stale rootfs, so this fails immediately and names
    // both versions instead of surfacing as a decode error on a later request.
    const { env, guest } = makeEnv({ readyTimeoutMs: 5000, readyPollMs: 1 });
    guest.pong = {
      kind: 'pong',
      protocolVersion: VM_AGENT_PROTOCOL_VERSION + 1,
      bootId: 'boot-1',
    };
    await expect(env.ensureStarted()).rejects.toThrow(
      new RegExp(`protocol v${VM_AGENT_PROTOCOL_VERSION + 1}.*v${VM_AGENT_PROTOCOL_VERSION}`),
    );
  });

  it('gives up on a mismatch instead of burning the whole boot deadline', async () => {
    // A generous timeout would mask a retry loop, so the rejection must arrive
    // long before the deadline could have expired.
    const { env, guest } = makeEnv({ readyTimeoutMs: 60_000, readyPollMs: 1 });
    guest.pong = {
      kind: 'pong',
      protocolVersion: VM_AGENT_PROTOCOL_VERSION + 1,
      bootId: 'boot-1',
    };
    const startedAt = Date.now();
    await expect(env.ensureStarted()).rejects.toThrow(VmAgentProtocolMismatchError);
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });
});

describe('defaultPrepareDisks — worktree path handed to the privileged helper', () => {
  const paths = {
    kernelPath: '/var/lib/agent-hub/firecracker/vmlinux',
    baseRootfsPath: '/var/lib/agent-hub/firecracker/rootfs.ext4',
    runDir: '/var/lib/agent-hub/firecracker/vms',
    controlDir: '/run/agent-hub/vm-control',
    diskHelper: '/usr/local/lib/agent-hub/fc-prepare-disks.sh',
  };
  const ctx = {
    vmDir: '/run/agent-hub/vm-control/ahvm-s1',
    sessionId: 's1',
    vmId: 'ahvm-s1',
    worktreePath: '/home/node/.agent-hub/workspaces/proj/session-s1',
    paths,
    workspaceSizeMib: 1024,
  };
  const okIo = (): { io: FirecrackerHostIo; calls: string[][] } => {
    const calls: string[][] = [];
    return {
      calls,
      io: {
        run: async (argv: string[]) => {
          calls.push(argv);
          return { ok: true, stdout: '', stderr: '', code: 0 };
        },
      } as unknown as FirecrackerHostIo,
    };
  };
  const worktreeArg = (argv: string[]): string => argv[argv.indexOf('--worktree') + 1] as string;

  it('constructs disk paths from --vm-id under the root-owned runDir', async () => {
    const { io, calls } = okIo();
    const disks = await defaultPrepareDisks(io, ctx);
    expect(calls[0]).toContain('--vm-id');
    expect(calls[0]).toContain('ahvm-s1');
    expect(calls[0]).not.toContain('--rootfs-out');
    expect(disks.rootfsPath).toBe('/var/lib/agent-hub/firecracker/vms/ahvm-s1/rootfs.ext4');
    expect(disks.workspacePath).toBe('/var/lib/agent-hub/firecracker/vms/ahvm-s1/workspace.ext4');
  });

  it('translates the container path to the host path the helper has mounted', async () => {
    // The helper container mounts the host workspaces dir, so the Hub's own
    // /home/node/... view means nothing inside it.
    const { io, calls } = okIo();
    await defaultPrepareDisks(io, {
      ...ctx,
      hostWorkspacesDir: '/var/lib/agent-hub/workspaces',
      containerWorkspacesDir: '/home/node/.agent-hub/workspaces',
    });
    expect(worktreeArg(calls[0] as string[])).toBe('/var/lib/agent-hub/workspaces/proj/session-s1');
  });

  it('passes the path through when the Hub and helper already agree', async () => {
    // A Hub installed directly on the host configures no translation roots.
    const { io, calls } = okIo();
    await defaultPrepareDisks(io, {
      ...ctx,
      hostWorkspacesDir: null,
      containerWorkspacesDir: null,
    });
    expect(worktreeArg(calls[0] as string[])).toBe(ctx.worktreePath);
  });
});
