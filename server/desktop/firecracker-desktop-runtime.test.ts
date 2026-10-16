import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { DESKTOP_COMPUTERS_SCHEMA } from './desktop-computers-schema.js';
import {
  createDesktopComputersStore,
  type DesktopComputersStore,
} from './desktop-computers-store.js';
import {
  DESKTOP_GUEST_BOOT_ARG,
  FirecrackerDesktopRuntime,
  desktopVmId,
  type FirecrackerDesktopVm,
  type FirecrackerDesktopVmSpec,
} from './firecracker-desktop-runtime.js';
import { createFirecrackerSlotPool } from './register-firecracker-desktop-runtime.js';
import {
  deleteDesktopComputersWithProfile,
  registerDesktopRuntime,
  resetDesktopRuntimesForTests,
} from './desktop-runtime-registry.js';
import { DesktopComputerDeletingError } from './desktop-deletion-guard.js';
import { DESKTOP_IDLE_STOP_MS, DESKTOP_VNC_PORT } from './desktop-runtime.js';
import { sessionVmId } from '../session-env/firecracker/firecracker-vm-args.js';
import type {
  SessionEnvDisposeOpts,
  SessionEnvExit,
  SessionEnvProcess,
  SessionEnvSpawnOpts,
} from '../session-env/session-env.js';

type Responder = (command: string) => { code: number; stdout?: string; stderr?: string } | 'hang';

class FakeProc implements SessionEnvProcess {
  readonly pid = 1;
  exited = false;
  exitResult: SessionEnvExit | null = null;
  #out: ((c: string) => void)[] = [];
  #err: ((c: string) => void)[] = [];
  #exit: ((r: SessionEnvExit) => void)[] = [];
  constructor(
    readonly name: string,
    private readonly onKill: () => void,
  ) {}
  onStdout(cb: (c: string) => void) {
    this.#out.push(cb);
    return () => undefined;
  }
  onStderr(cb: (c: string) => void) {
    this.#err.push(cb);
    return () => undefined;
  }
  onExit(cb: (r: SessionEnvExit) => void) {
    if (this.exitResult) cb(this.exitResult);
    else this.#exit.push(cb);
    return () => undefined;
  }
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.onKill();
    this.finish({ code: null, signal });
  }
  emit(stdout: string, stderr: string) {
    if (stdout) for (const cb of this.#out) cb(stdout);
    if (stderr) for (const cb of this.#err) cb(stderr);
  }
  finish(result: SessionEnvExit) {
    if (this.exited) return;
    this.exited = true;
    this.exitResult = result;
    for (const cb of this.#exit) cb(result);
  }
}

class FakeVm implements FirecrackerDesktopVm {
  disposed = false;
  started = false;
  guestIp: string | null = null;
  bootError: Error | null = null;
  disposeError: Error | null = null;
  live = 0;
  readonly disposeCalls: SessionEnvDisposeOpts[] = [];
  readonly spawns: { command: string; opts: SessionEnvSpawnOpts }[] = [];
  respond: Responder = () => ({ code: 0 });

  constructor(readonly spec: FirecrackerDesktopVmSpec) {}
  get vmId() {
    return this.spec.vmId;
  }
  async ensureStarted() {
    if (this.bootError) throw this.bootError;
    this.started = true;
    this.guestIp = `172.30.0.${this.spec.slot}`;
  }
  spawn(command: string, opts: SessionEnvSpawnOpts = {}) {
    this.spawns.push({ command, opts });
    this.live++;
    const proc = new FakeProc(opts.name ?? command, () => undefined);
    proc.onExit(() => this.live--);
    const reply = this.respond(command);
    if (reply !== 'hang') {
      queueMicrotask(() => {
        proc.emit(reply.stdout ?? '', reply.stderr ?? '');
        proc.finish({ code: reply.code, signal: null });
      });
    }
    return proc;
  }
  liveProcessCount() {
    return this.live;
  }
  /** What suspend reports: the snapshot fingerprint, or null for none taken. */
  snapshotResult: string | null = 'sha256:snap-1';
  suspendCalls = 0;
  async suspend() {
    this.suspendCalls++;
    await this.dispose({ forgetWorkspace: false });
    return this.snapshotResult;
  }
  disposeGate: Promise<void> | null = null;
  async dispose(opts: SessionEnvDisposeOpts = {}) {
    this.disposeCalls.push(opts);
    if (this.disposeGate) await this.disposeGate;
    if (this.disposeError) throw this.disposeError;
    this.disposed = true;
    this.started = false;
  }
}

const ALICE = { userId: 'alice', agentId: 'agent-a', projectId: 'proj-1' };
const BOB = { userId: 'bob', agentId: 'agent-a', projectId: 'proj-1' };

function memoryStore(): { store: DesktopComputersStore; db: Database.Database } {
  const db = new Database(':memory:');
  db.exec(DESKTOP_COMPUTERS_SCHEMA);
  return { store: createDesktopComputersStore(() => db), db };
}

function makeRuntime(
  store: DesktopComputersStore,
  opts: { configure?: (vm: FakeVm) => void } = {},
) {
  let now = 1_000_000;
  const vms: FakeVm[] = [];
  const slots = createFirecrackerSlotPool(store);
  const runtime = new FirecrackerDesktopRuntime({
    store,
    slots,
    now: () => now,
    logger: { warn: () => undefined },
    createVm: (spec) => {
      const vm = new FakeVm(spec);
      opts.configure?.(vm);
      vms.push(vm);
      return vm;
    },
  });
  return {
    runtime,
    slots,
    vms,
    advance: (ms: number) => {
      now += ms;
    },
    lastVm: () => vms[vms.length - 1]!,
  };
}

describe('FirecrackerDesktopRuntime identity', () => {
  let store: DesktopComputersStore;
  beforeEach(() => {
    ({ store } = memoryStore());
  });

  it('boots one VM per (user, agent, project) with a persisted slot and the desktop boot flag', async () => {
    const { runtime, vms } = makeRuntime(store);
    const status = await runtime.ensureStarted(ALICE);
    expect(status).toMatchObject({ kind: 'firecracker', state: 'running' });

    const record = store.get(ALICE, 'firecracker')!;
    expect(record.vmId).toBe(desktopVmId(ALICE));
    expect(record.vmId).toMatch(/^ahdt-[0-9a-f]{40}$/);
    expect(record.slot).toBe(3);
    expect(vms[0]!.spec).toMatchObject({ vmId: record.vmId, slot: 3 });
    expect(vms[0]!.spec.bootArgsExtra).toContain(DESKTOP_GUEST_BOOT_ARG);
    // The per-VM pool always hands back the computer's own slot.
    expect(vms[0]!.spec.slots.allocate()).toBe(3);

    await runtime.ensureStarted(ALICE);
    expect(vms).toHaveLength(1);
  });

  it('gives different users talking to the same agent separate computers', async () => {
    const { runtime, vms } = makeRuntime(store);
    await runtime.ensureStarted(ALICE);
    await runtime.ensureStarted(BOB);
    expect(vms.map((vm) => vm.spec.slot)).toEqual([3, 4]);
    expect(desktopVmId(ALICE)).not.toBe(desktopVmId(BOB));
  });

  it('never shares a vm id namespace with session VMs', () => {
    expect(desktopVmId(ALICE).startsWith('ahdt-')).toBe(true);
    expect(sessionVmId('ahdt-anything').startsWith('ahvm-')).toBe(true);
    expect(desktopVmId(ALICE).length).toBeLessThanOrEqual(64);
  });

  it('keeps the same slot across a Hub restart and reserves it from sessions', async () => {
    const first = makeRuntime(store);
    await first.runtime.ensureStarted(ALICE);
    await first.runtime.ensureStarted(BOB);
    await first.runtime.stop(BOB);

    // New process: fresh runtime and pool built from the store.
    const second = makeRuntime(store);
    expect(second.slots.has(3)).toBe(true);
    expect(second.slots.has(4)).toBe(true);
    // A session VM allocating now gets a slot no computer holds.
    expect(second.slots.allocate()).toBe(5);

    await second.runtime.ensureStarted(BOB);
    expect(second.lastVm().spec).toMatchObject({ vmId: desktopVmId(BOB), slot: 4 });
  });

  it('reports a computer it has never loaded from the store as stopped with its last activity', async () => {
    const first = makeRuntime(store);
    await first.runtime.ensureStarted(ALICE);
    const second = makeRuntime(store);
    await expect(second.runtime.status(ALICE)).resolves.toEqual({
      kind: 'firecracker',
      state: 'stopped',
      lastActiveAt: 1_000_000,
    });
  });
});

describe('FirecrackerDesktopRuntime stop and resume', () => {
  let store: DesktopComputersStore;
  beforeEach(() => {
    ({ store } = memoryStore());
  });

  it('stop keeps the disk and the next call resumes the same computer', async () => {
    const { runtime, vms } = makeRuntime(store);
    await runtime.ensureStarted(ALICE);
    await runtime.stop(ALICE);
    expect(vms[0]!.disposeCalls).toEqual([{ forgetWorkspace: false }]);
    expect((await runtime.status(ALICE)).state).toBe('stopped');
    expect(store.get(ALICE, 'firecracker')).not.toBeNull();

    await runtime.exec(ALICE, 'true');
    expect(vms).toHaveLength(2);
    expect(vms[1]!.spec).toMatchObject({ vmId: vms[0]!.spec.vmId, slot: vms[0]!.spec.slot });
  });

  it('stops a computer after 30 idle minutes and not before', async () => {
    const { runtime, vms, advance } = makeRuntime(store);
    await runtime.ensureStarted(ALICE);

    advance(DESKTOP_IDLE_STOP_MS - 1);
    expect(await runtime.sweepIdle()).toEqual([]);
    expect(vms[0]!.disposed).toBe(false);

    advance(1);
    expect(await runtime.sweepIdle()).toEqual([ALICE]);
    expect(vms[0]!.disposeCalls).toEqual([{ forgetWorkspace: false }]);
    expect((await runtime.status(ALICE)).state).toBe('stopped');
  });

  it('every tool call resets the idle clock', async () => {
    const { runtime, advance } = makeRuntime(store);
    await runtime.ensureStarted(ALICE);
    advance(DESKTOP_IDLE_STOP_MS - 10);
    await runtime.input(ALICE, { type: 'move', x: 1, y: 1 });
    advance(DESKTOP_IDLE_STOP_MS - 10);
    expect(await runtime.sweepIdle()).toEqual([]);
    expect(store.get(ALICE, 'firecracker')!.lastActiveAt).toBe(
      1_000_000 + DESKTOP_IDLE_STOP_MS - 10,
    );
  });

  it('does not stop a computer with a guest command still running', async () => {
    const { runtime, vms, advance } = makeRuntime(store, {
      configure: (vm) => {
        vm.respond = () => 'hang';
      },
    });
    await runtime.ensureStarted(ALICE);
    void runtime.exec(ALICE, 'sleep 100000', { timeoutMs: 10 * DESKTOP_IDLE_STOP_MS });
    await vi.waitFor(() => expect(vms[0]!.spawns).toHaveLength(1));
    advance(DESKTOP_IDLE_STOP_MS * 2);
    expect(await runtime.sweepIdle()).toEqual([]);
    expect(vms[0]!.disposed).toBe(false);
  });

  it('surfaces a failed boot as an error state and retries on a fresh VM', async () => {
    let fail = true;
    const { runtime, vms } = makeRuntime(store, {
      configure: (vm) => {
        if (fail) vm.bootError = new Error('guest agent did not answer');
      },
    });
    await expect(runtime.ensureStarted(ALICE)).rejects.toThrow('guest agent did not answer');
    expect(await runtime.status(ALICE)).toMatchObject({
      state: 'error',
      error: 'guest agent did not answer',
    });
    expect(vms[0]!.disposed).toBe(true);

    fail = false;
    await expect(runtime.ensureStarted(ALICE)).resolves.toMatchObject({ state: 'running' });
    expect(vms).toHaveLength(2);
    expect(vms[1]!.spec.slot).toBe(vms[0]!.spec.slot);
  });
});

describe('FirecrackerDesktopRuntime snapshots', () => {
  let store: DesktopComputersStore;
  beforeEach(() => {
    ({ store } = memoryStore());
  });

  it('idle stop snapshots the VM and the next use resumes from that snapshot', async () => {
    const { runtime, vms, advance } = makeRuntime(store);
    await runtime.ensureStarted(ALICE);
    expect(vms[0]!.spec.restoreSnapshot).toBeNull();

    advance(DESKTOP_IDLE_STOP_MS);
    expect(await runtime.sweepIdle()).toEqual([ALICE]);
    expect(vms[0]!.suspendCalls).toBe(1);
    expect(store.getSnapshot(ALICE, 'firecracker')).toBe('sha256:snap-1');

    await runtime.exec(ALICE, 'true');
    expect(vms).toHaveLength(2);
    expect(vms[1]!.spec.restoreSnapshot).toBe('sha256:snap-1');
    // Consumed: the guest's disks have moved on since the snapshot.
    expect(store.getSnapshot(ALICE, 'firecracker')).toBeNull();
  });

  it('survives a Hub restart: the snapshot pointer lives on the row', async () => {
    const first = makeRuntime(store);
    await first.runtime.ensureStarted(ALICE);
    await first.runtime.stop(ALICE);

    const second = makeRuntime(store);
    await second.runtime.ensureStarted(ALICE);
    expect(second.vms[0]!.spec.restoreSnapshot).toBe('sha256:snap-1');
  });

  it('cold boots next time when the stop could not take a snapshot', async () => {
    const { runtime, vms } = makeRuntime(store, {
      configure: (vm) => {
        vm.snapshotResult = null;
      },
    });
    await runtime.ensureStarted(ALICE);
    await runtime.stop(ALICE);
    expect(store.getSnapshot(ALICE, 'firecracker')).toBeNull();
    await runtime.ensureStarted(ALICE);
    expect(vms[1]!.spec.restoreSnapshot).toBeNull();
  });

  it('keeps the pointer when the start fails so the next attempt can still resume', async () => {
    let fail = false;
    const { runtime, vms } = makeRuntime(store, {
      configure: (vm) => {
        if (fail) vm.bootError = new Error('bridge not ready');
      },
    });
    await runtime.ensureStarted(ALICE);
    await runtime.stop(ALICE);
    fail = true;
    await expect(runtime.ensureStarted(ALICE)).rejects.toThrow('bridge not ready');
    expect(store.getSnapshot(ALICE, 'firecracker')).toBe('sha256:snap-1');
    fail = false;
    await runtime.ensureStarted(ALICE);
    expect(vms[2]!.spec.restoreSnapshot).toBe('sha256:snap-1');
    expect(store.getSnapshot(ALICE, 'firecracker')).toBeNull();
  });

  it('destroy of a snapshotted computer removes its disks (snapshot included) and the row', async () => {
    const { runtime, vms } = makeRuntime(store);
    await runtime.ensureStarted(ALICE);
    await runtime.stop(ALICE);
    await runtime.destroy(ALICE);
    // The teardown VM must not try to resume anything.
    expect(vms[1]!.spec.restoreSnapshot).toBeNull();
    expect(vms[1]!.disposeCalls).toEqual([{ forgetWorkspace: true }]);
    expect(store.get(ALICE, 'firecracker')).toBeNull();
    expect(store.getSnapshot(ALICE, 'firecracker')).toBeNull();
  });
});

describe('FirecrackerDesktopRuntime destroy', () => {
  let store: DesktopComputersStore;
  beforeEach(() => {
    ({ store } = memoryStore());
    resetDesktopRuntimesForTests();
  });

  it('refuses a start queued while profile deletion awaits VM disposal', async () => {
    const { runtime, vms } = makeRuntime(store);
    registerDesktopRuntime(runtime);
    await runtime.ensureStarted(ALICE);
    let release!: () => void;
    vms[0]!.disposeGate = new Promise<void>((r) => (release = r));

    const deleteProfile = vi.fn();
    const deleting = deleteDesktopComputersWithProfile(ALICE, deleteProfile, store);
    await vi.waitFor(() => expect(vms[0]!.disposeCalls).toHaveLength(1));
    // Queued behind destroy() on the runtime's lifecycle lock.
    const queued = runtime.ensureStarted(ALICE);
    release();

    await expect(deleting).resolves.toBeUndefined();
    await expect(queued).rejects.toBeInstanceOf(DesktopComputerDeletingError);
    expect(deleteProfile).toHaveBeenCalledOnce();
    expect(store.get(ALICE, 'firecracker')).toBeNull();
    expect(vms).toHaveLength(1);

    // Once the profile is gone the mark clears and the key is usable again.
    await expect(runtime.ensureStarted(ALICE)).resolves.toMatchObject({ state: 'running' });
  });

  it('refuses every start queued behind the teardown, not just the first', async () => {
    const { runtime, vms } = makeRuntime(store);
    registerDesktopRuntime(runtime);
    await runtime.ensureStarted(ALICE);
    let release!: () => void;
    vms[0]!.disposeGate = new Promise<void>((r) => (release = r));

    const deleting = deleteDesktopComputersWithProfile(ALICE, () => undefined, store);
    await vi.waitFor(() => expect(vms[0]!.disposeCalls).toHaveLength(1));
    // These arrive while the mark is set and are refused at admission.
    const queued = [1, 2, 3].map(() => runtime.ensureStarted(ALICE));
    release();

    await deleting;
    const results = await Promise.allSettled(queued);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(DesktopComputerDeletingError);
    }
    expect(store.get(ALICE, 'firecracker')).toBeNull();
    expect(vms).toHaveLength(1);
  });

  it('refuses starts queued ahead of the delete that run while it is pending', async () => {
    const { runtime, vms } = makeRuntime(store);
    registerDesktopRuntime(runtime);
    await runtime.ensureStarted(ALICE);
    // Hold the lifecycle lock with a slow stop so later starts queue up
    // before the deletion mark exists.
    let releaseStop!: () => void;
    vms[0]!.disposeGate = new Promise<void>((r) => (releaseStop = r));
    const stopping = runtime.stop(ALICE);
    await vi.waitFor(() => expect(vms[0]!.disposeCalls).toHaveLength(1));
    const early = [1, 2].map(() => runtime.ensureStarted(ALICE));

    const deleting = deleteDesktopComputersWithProfile(ALICE, () => undefined, store);
    releaseStop();
    await stopping;
    await deleting;

    const results = await Promise.allSettled(early);
    for (const r of results) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(DesktopComputerDeletingError);
    }
    expect(store.get(ALICE, 'firecracker')).toBeNull();
    expect(vms.filter((vm) => vm.started)).toHaveLength(0);
  });

  it('clears the deletion mark and keeps the profile when teardown fails', async () => {
    const { runtime, vms } = makeRuntime(store);
    registerDesktopRuntime(runtime);
    await runtime.ensureStarted(ALICE);
    vms[0]!.disposeError = new Error('tap delete failed');
    const deleteProfile = vi.fn();
    await expect(deleteDesktopComputersWithProfile(ALICE, deleteProfile, store)).rejects.toThrow(
      /tap delete failed/,
    );
    expect(deleteProfile).not.toHaveBeenCalled();
    vms[0]!.disposeError = null;
    await expect(runtime.ensureStarted(ALICE)).resolves.toBeDefined();
  });

  it('deletes the disk, the row, and frees the slot', async () => {
    const { runtime, slots, vms } = makeRuntime(store);
    await runtime.ensureStarted(ALICE);
    await runtime.destroy(ALICE);
    expect(vms[0]!.disposeCalls).toEqual([{ forgetWorkspace: true }]);
    expect(store.get(ALICE, 'firecracker')).toBeNull();
    expect(slots.has(3)).toBe(false);
  });

  it('deletes the disk of a stopped computer after a Hub restart', async () => {
    const first = makeRuntime(store);
    await first.runtime.ensureStarted(ALICE);
    const second = makeRuntime(store);
    await second.runtime.destroy(ALICE);
    expect(second.vms).toHaveLength(1);
    expect(second.vms[0]!.started).toBe(false);
    expect(second.vms[0]!.spec.vmId).toBe(desktopVmId(ALICE));
    expect(second.vms[0]!.disposeCalls).toEqual([{ forgetWorkspace: true }]);
    expect(store.get(ALICE, 'firecracker')).toBeNull();
  });

  it('keeps the row and slot when the disk delete fails', async () => {
    const { runtime, slots } = makeRuntime(store, {
      configure: (vm) => {
        vm.disposeError = new Error('tap delete failed');
      },
    });
    await runtime.ensureStarted(ALICE);
    await expect(runtime.destroy(ALICE)).rejects.toThrow('tap delete failed');
    expect(store.get(ALICE, 'firecracker')).not.toBeNull();
    expect(slots.has(3)).toBe(true);
  });

  it('is a no-op for a computer that never existed', async () => {
    const { runtime, vms } = makeRuntime(store);
    await runtime.destroy(ALICE);
    expect(vms).toHaveLength(0);
  });
});

describe('FirecrackerDesktopRuntime tool ops', () => {
  let store: DesktopComputersStore;
  beforeEach(() => {
    ({ store } = memoryStore());
  });

  it('runs exec in the persistent home with the display set', async () => {
    const { runtime, lastVm } = makeRuntime(store, {
      configure: (vm) => {
        vm.respond = () => ({ code: 0, stdout: 'hi\n' });
      },
    });
    const res = await runtime.exec(ALICE, 'echo hi', { cwd: 'Downloads' });
    expect(res).toEqual({ exitCode: 0, stdout: 'hi\n', stderr: '', timedOut: false });
    const spawn = lastVm().spawns[0]!;
    expect(spawn.command).toBe("cd -- 'Downloads' && echo hi");
    expect(spawn.opts.cwd).toBe('home');
    expect(spawn.opts.env).toEqual({ DISPLAY: ':99' });
  });

  it('kills a command past its timeout and reports it', async () => {
    vi.useFakeTimers();
    try {
      const { runtime } = makeRuntime(store, {
        configure: (vm) => {
          vm.respond = () => 'hang';
        },
      });
      const pending = runtime.exec(ALICE, 'sleep 60', { timeoutMs: 500 });
      await vi.advanceTimersByTimeAsync(500);
      await expect(pending).resolves.toMatchObject({ timedOut: true, exitCode: -1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('decodes a screenshot from base64 output', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const { runtime, lastVm } = makeRuntime(store, {
      configure: (vm) => {
        vm.respond = () => ({ code: 0, stdout: png.toString('base64') });
      },
    });
    await expect(runtime.screenshot(ALICE)).resolves.toEqual(png);
    expect(lastVm().spawns[0]!.command).toContain('scrot');
  });

  it('viewFrame returns null for a stopped computer and never boots it', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]);
    const { runtime, lastVm, advance } = makeRuntime(store, {
      configure: (vm) => {
        vm.respond = () => ({ code: 0, stdout: png.toString('base64') });
      },
    });
    await expect(runtime.viewFrame(ALICE)).resolves.toBeNull();
    expect(store.get(ALICE, 'firecracker')).toBeNull();
    await runtime.ensureStarted(ALICE);
    const before = (await runtime.status(ALICE)).lastActiveAt;
    advance(60_000);
    await expect(runtime.viewFrame(ALICE)).resolves.toEqual(png);
    expect((await runtime.status(ALICE)).lastActiveAt).toBe(before);
    expect(lastVm().spawns.at(-1)!.command).toContain('scrot');
  });

  it('turns a failed screenshot into an error', async () => {
    const { runtime } = makeRuntime(store, {
      configure: (vm) => {
        vm.respond = () => ({ code: 2, stderr: "Can't open X display" });
      },
    });
    await expect(runtime.screenshot(ALICE)).rejects.toThrow(/exit 2: Can't open X display/);
  });

  it('sends input as xdotool and rejects off-screen coordinates before booting', async () => {
    const { runtime, vms, lastVm } = makeRuntime(store);
    await expect(runtime.input(ALICE, { type: 'click', x: 1280, y: 10 })).rejects.toThrow(
      /x must be within 0\.\.1279/,
    );
    expect(vms).toHaveLength(0);

    await runtime.input(ALICE, { type: 'click', x: 10, y: 20, button: 'right' });
    expect(lastVm().spawns[0]!.command).toBe(
      "DISPLAY=:99 xdotool 'mousemove' '10' '20' 'click' '3'",
    );
  });

  it('maps the display to the guest address and VNC port', async () => {
    const { runtime } = makeRuntime(store);
    await expect(runtime.mapDisplayPort(ALICE)).resolves.toEqual({
      host: '172.30.0.3',
      port: DESKTOP_VNC_PORT,
    });
  });

  it('rejects a key with an empty field', async () => {
    const { runtime } = makeRuntime(store);
    await expect(runtime.ensureStarted({ ...ALICE, agentId: ' ' })).rejects.toThrow(/agentId/);
  });
});
