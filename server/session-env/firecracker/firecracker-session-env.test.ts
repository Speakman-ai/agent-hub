import { describe, it, expect, vi } from 'vitest';
import {
  FirecrackerSessionEnv,
  VmAgentProtocolMismatchError,
  defaultPrepareDisks,
  type FirecrackerHostIo,
  type FirecrackerSlotPool,
} from './firecracker-session-env.js';
import type { VsockDuplex } from './vm-agent-client.js';
import {
  VmAgentFrameDecoder,
  VM_AGENT_PROTOCOL_VERSION,
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
  #decoder = new VmAgentFrameDecoder();
  #handshakeDone = false;
  #data: ((chunk: Buffer) => void)[] = [];
  #close: (() => void)[] = [];
  #error: ((err: Error) => void)[] = [];

  constructor(
    private readonly accept: boolean,
    /** Reply sent for a `ping`; null to model an agent that never answers. */
    readonly pong: VmAgentReply | null = {
      kind: 'pong',
      protocolVersion: VM_AGENT_PROTOCOL_VERSION,
      bootId: 'boot-1',
    },
  ) {}

  write(data: Buffer): void {
    if (!this.#handshakeDone) {
      this.#handshakeDone = true;
      const reply = this.accept ? 'OK 1024\n' : 'FAILED\n';
      setImmediate(() => this.emitData(Buffer.from(reply)));
      return;
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
  on(event: 'data' | 'close' | 'error', cb: never): void {
    if (event === 'data') this.#data.push(cb);
    else if (event === 'close') this.#close.push(cb);
    else this.#error.push(cb);
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
  /** Overridden to model a stale guest image or an agent that never answers. */
  pong: VmAgentReply | null = {
    kind: 'pong',
    protocolVersion: VM_AGENT_PROTOCOL_VERSION,
    bootId: 'boot-1',
  };

  connect = async (): Promise<VsockDuplex> => {
    const conn = new FakeGuestConnection(this.accept, this.pong);
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
      // ensureFirecrackerGuestNat runs before tap create; give it a usable uplink.
      if (argv[0] === 'ip' && argv.includes('route')) {
        return {
          ok: true,
          stdout: '1.1.1.1 via 10.0.0.1 dev eth0 src 10.0.0.5\n',
          stderr: '',
        };
      }
      if (argv[0] === 'iptables' && argv.includes('-C')) {
        return { ok: false, stdout: '', stderr: 'No chain/target/match by that name' };
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
      runDir: '/run/agent-hub/vms',
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

    expect(runs.some((a) => a[0] === 'ip' && a[1] === 'tuntap' && a.includes('ahfct3'))).toBe(true);
    expect(runs.some((a) => a[0].endsWith('fc-prepare-disks.sh'))).toBe(true);
    // Guest NAT is ensured before the tap is created.
    expect(runs.some((a) => a[0] === 'sysctl' && a.includes('net.ipv4.ip_forward=1'))).toBe(true);

    const config = JSON.parse([...written.values()][0]);
    expect(config['machine-config'].vcpu_count).toBeGreaterThan(0);
    expect(config.vsock.guest_cid).toBe(3);
    expect(config['boot-source'].boot_args).toContain('ahvm.session=sess-1');

    expect(spawned[0].file).toBe('firecracker');
    expect(env.vmStarted).toBe(true);
    expect(env.guestIp).toBe('172.30.0.3');
  });

  it('clears leftover sockets before binding them', async () => {
    // Firecracker binds api.sock and vsock.sock and refuses to start when
    // either exists. The vm id is derived from the session id, so a session
    // whose VMM died without unlinking them (host reboot, OOM kill) reboots
    // onto its own leftovers and fails with FailedToBindSocket forever — the
    // session can never get an environment again.
    const { env, removed } = makeEnv();
    await env.ensureStarted();

    expect(removed).toContain('/run/agent-hub/vms/ahvm-sess-1/api.sock');
    expect(removed).toContain('/run/agent-hub/vms/ahvm-sess-1/vsock.sock');
  });

  it('boots under the jailer when asked', async () => {
    const { env, spawned } = makeEnv({ useJailer: true, jailerUid: 1001, jailerGid: 1001 });
    await env.ensureStarted();
    expect(spawned[0].file).toBe('jailer');
    expect(spawned[0].args).toContain('--chroot-base-dir');
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
    expect(runs.some((a) => a[0] === 'ip' && a[1] === 'link' && a[2] === 'del')).toBe(true);
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
  it('kills the VMM, drops the tap, releases the slot, and clears the run dir', async () => {
    const { env, runs, slots, removed, stopVmm } = makeEnv();
    await env.ensureStarted();
    await env.dispose();

    expect(stopVmm).toHaveBeenCalledWith({ vmId: 'ahvm-sess-1', pid: 4242 });
    expect(runs.at(-1)).toEqual(['ip', 'link', 'del', 'ahfct3']);
    expect(slots.released).toEqual([3]);
    // The whole directory goes, not just the sockets start cleared out of the
    // way — leaving the disks behind would grow the run dir without bound.
    expect(removed.at(-1)).toBe('/run/agent-hub/vms/ahvm-sess-1');
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
    expect(stopVmm).toHaveBeenCalledTimes(1);

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
    diskHelper: '/usr/local/lib/agent-hub/fc-prepare-disks.sh',
  };
  const ctx = {
    vmDir: '/var/lib/agent-hub/firecracker/vms/ahvm-s1',
    sessionId: 's1',
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
