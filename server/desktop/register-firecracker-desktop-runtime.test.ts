/**
 * The desktop runtime driving a real FirecrackerSessionEnv. Only the
 * privileged seams are faked: host IO (fc-netctl / fc-prepare-disks), the
 * VMM launcher, and the vsock connection to the guest agent.
 */
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { DESKTOP_COMPUTERS_SCHEMA } from './desktop-computers-schema.js';
import { createDesktopComputersStore } from './desktop-computers-store.js';
import {
  createFirecrackerDesktopRuntime,
  createFirecrackerSlotPool,
  desktopVmPaths,
  DesktopSlotReservationError,
} from './register-firecracker-desktop-runtime.js';
import { desktopVmId } from './firecracker-desktop-runtime.js';
import type { FirecrackerHostIo } from '../session-env/firecracker/firecracker-session-env.js';
import type { VsockDuplex } from '../session-env/firecracker/vm-agent-client.js';
import {
  VmAgentFrameDecoder,
  VM_AGENT_PROTOCOL_VERSION,
  decodeJsonPayload,
  encodeJsonFrame,
  type VmAgentRequest,
} from '../session-env/firecracker/vm-agent-protocol.js';

/** Guest agent that completes the VMM handshake and answers pings. */
class PingingGuest implements VsockDuplex {
  #handshake = false;
  #decoder = new VmAgentFrameDecoder();
  #data: ((chunk: Buffer) => void)[] = [];
  write(data: Buffer): boolean {
    if (!this.#handshake) {
      this.#handshake = true;
      setImmediate(() => this.#emit(Buffer.from('OK 1024\n')));
      return true;
    }
    for (const frame of this.#decoder.push(data)) {
      if (frame.type !== 'request') continue;
      const req = decodeJsonPayload<VmAgentRequest>(frame.payload);
      if (req.kind === 'ping') {
        setImmediate(() =>
          this.#emit(
            encodeJsonFrame('reply', {
              kind: 'pong',
              protocolVersion: VM_AGENT_PROTOCOL_VERSION,
              bootId: 'b',
            }),
          ),
        );
      }
    }
    return true;
  }
  end(): void {}
  destroy(): void {}
  on(event: 'data', cb: (chunk: Buffer) => void): void;
  on(event: 'close' | 'drain', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'data' | 'close' | 'error' | 'drain', cb: never): void {
    if (event === 'data') this.#data.push(cb);
  }
  #emit(chunk: Buffer) {
    for (const cb of this.#data) cb(chunk);
  }
}

function setup() {
  const db = new Database(':memory:');
  db.exec(DESKTOP_COMPUTERS_SCHEMA);
  const store = createDesktopComputersStore(() => db);
  const runs: string[][] = [];
  const written = new Map<string, string>();
  const io: FirecrackerHostIo = {
    run: async (argv) => {
      runs.push(argv);
      return { ok: true, stdout: '', stderr: '' };
    },
    writeFile: async (p, c) => {
      written.set(p, c);
    },
    mkdirp: async () => undefined,
    rmrf: async () => undefined,
    isDirectory: async () => true,
  };
  const stopVmm = vi.fn();
  const spawnVmm = vi.fn(() => ({ pid: undefined, stderr: null }));
  const slots = createFirecrackerSlotPool(store);
  const runtime = createFirecrackerDesktopRuntime({
    store,
    slots,
    vmDefaults: {
      paths: {
        kernelPath: '/fc/vmlinux',
        baseRootfsPath: '/fc/rootfs.ext4',
        desktopRootfsPath: '/fc/rootfs-desktop.ext4',
        runDir: '/fc/vms',
        controlDir: '/fc/control',
        jailerChrootBase: '/fc/jailer',
        diskHelper: '/usr/local/lib/agent-hub/fc-prepare-disks.sh',
      },
      io,
      spawnVmm,
      stopVmm,
      connect: async () => new PingingGuest(),
      readyTimeoutMs: 2000,
      readyPollMs: 1,
      logger: { warn: () => undefined },
    },
  });
  return { runtime, store, runs, written, stopVmm, spawnVmm, slots };
}

const KEY = { userId: 'u1', agentId: 'a1', projectId: 'p1' };
const isPrepare = (a: string[]) => a[0]!.endsWith('fc-prepare-disks.sh');

describe('Firecracker desktop runtime on FirecrackerSessionEnv', () => {
  it('boots the computer VM on an empty persistent disk, stops without deleting it, and deletes it on destroy', async () => {
    const { runtime, store, runs, written, spawnVmm } = setup();
    const vmId = desktopVmId(KEY);

    await runtime.ensureStarted(KEY);
    const prepare = runs.find(isPrepare)!;
    expect(prepare).toEqual(expect.arrayContaining(['--vm-id', vmId, '--no-worktree']));
    expect(prepare).not.toContain('--worktree');
    expect(prepare[prepare.indexOf('--base-rootfs') + 1]).toBe('/fc/rootfs-desktop.ext4');
    expect(spawnVmm).toHaveBeenCalledWith(expect.objectContaining({ vmId }));
    const config = JSON.parse([...written.values()].find((c) => c.includes('boot-source'))!);
    expect(config['boot-source'].boot_args).toContain('ahvm.desktop=1');
    expect(config.vsock.guest_cid).toBe(store.get(KEY, 'firecracker')!.slot);
    expect(runs.some((a) => a[1] === 'tap-create' && a.includes('ahfct3'))).toBe(true);

    await runtime.stop(KEY);
    expect(runs.some((a) => isPrepare(a) && a[1] === 'clean')).toBe(false);
    expect(runs.some((a) => a[1] === 'tap-delete' && a.includes('ahfct3'))).toBe(true);

    await runtime.destroy(KEY);
    expect(runs.some((a) => isPrepare(a) && a[1] === 'clean' && a.includes(vmId))).toBe(true);
    expect(store.get(KEY, 'firecracker')).toBeNull();
  });

  it('resumes after stop with the same VM id and slot', async () => {
    const { runtime, runs } = setup();
    await runtime.ensureStarted(KEY);
    await runtime.stop(KEY);
    await runtime.ensureStarted(KEY);
    const taps = runs
      .filter((a) => a[1] === 'tap-create')
      .map((a) => a.find((x) => /^ahfct/.test(x)));
    expect(taps).toEqual(['ahfct3', 'ahfct3']);
    const prepares = runs.filter(isPrepare).map((a) => a[a.indexOf('--vm-id') + 1]);
    expect(new Set(prepares)).toEqual(new Set([desktopVmId(KEY)]));
  });

  it('falls back to the session rootfs only when no desktop rootfs is configured', () => {
    const paths = {
      kernelPath: 'k',
      baseRootfsPath: '/fc/rootfs.ext4',
      runDir: 'r',
      controlDir: 'c',
    };
    expect(desktopVmPaths(paths).baseRootfsPath).toBe('/fc/rootfs.ext4');
    expect(
      desktopVmPaths({ ...paths, desktopRootfsPath: '/fc/rootfs-desktop.ext4' }).baseRootfsPath,
    ).toBe('/fc/rootfs-desktop.ext4');
  });

  it('refuses to build a pool when the reserved slots cannot be read', () => {
    const store = {
      listSlots: () => {
        throw new Error('database is locked');
      },
    } as never;
    expect(() => createFirecrackerSlotPool(store)).toThrow(DesktopSlotReservationError);
    expect(() => createFirecrackerSlotPool(store)).toThrow(/database is locked/);
  });
});
