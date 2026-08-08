import { describe, it, expect, vi } from 'vitest';
import { KVM_DEVICE, probeFirecrackerCapability } from './firecracker-capability.js';
import {
  InMemorySlotPool,
  SlotPoolExhaustedError,
  buildEnsureBridgeArgv,
  parseSessionTapNames,
  reconcileFirecrackerHost,
} from './firecracker-slots.js';
import { FIRECRACKER_MIN_SLOT } from './firecracker-vm-args.js';

const okProbe = {
  platform: 'linux' as NodeJS.Platform,
  isCharacterDevice: () => true,
  access: () => undefined,
  firecrackerVersion: () => 'Firecracker v1.16.0\n',
  fileExists: () => true,
};

describe('probeFirecrackerCapability', () => {
  it('reports available with the resolved version', () => {
    const result = probeFirecrackerCapability(okProbe);
    expect(result.available).toBe(true);
    expect(result.version).toBe('Firecracker v1.16.0');
    expect(result.reason).toBe('');
  });

  it('declines on a non-Linux host', () => {
    const result = probeFirecrackerCapability({ ...okProbe, platform: 'darwin' });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/only on Linux/);
  });

  it('points at the nested-virtualization flag when /dev/kvm is absent', () => {
    // The likeliest misconfiguration by far: a supported instance type that
    // was launched without the CPU option, which looks normal otherwise.
    const result = probeFirecrackerCapability({ ...okProbe, isCharacterDevice: () => false });
    expect(result.available).toBe(false);
    expect(result.reason).toContain('NestedVirtualization=enabled');
  });

  it('distinguishes a permission problem from a missing device', () => {
    const result = probeFirecrackerCapability({
      ...okProbe,
      access: () => {
        throw new Error('EACCES');
      },
    });
    expect(result.available).toBe(false);
    expect(result.reason).toContain('kvm` group');
    expect(result.reason).toContain(KVM_DEVICE);
  });

  it('declines when the VMM binary is missing', () => {
    const result = probeFirecrackerCapability({
      ...okProbe,
      firecrackerVersion: () => {
        throw new Error('spawn firecracker ENOENT');
      },
    });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/ENOENT/);
  });

  it('names the guest artifacts that are not staged', () => {
    const result = probeFirecrackerCapability({
      ...okProbe,
      artifactPaths: ['/fc/vmlinux', '/fc/rootfs.ext4'],
      fileExists: (p) => p !== '/fc/rootfs.ext4',
    });
    expect(result.available).toBe(false);
    expect(result.reason).toContain('/fc/rootfs.ext4');
    expect(result.reason).not.toContain('/fc/vmlinux,');
  });
});

describe('InMemorySlotPool', () => {
  it('hands out the lowest free slot and never repeats a live one', () => {
    const pool = new InMemorySlotPool();
    const a = pool.allocate();
    const b = pool.allocate();
    expect(a).toBe(FIRECRACKER_MIN_SLOT);
    expect(b).toBe(FIRECRACKER_MIN_SLOT + 1);
    expect(pool.inUse).toBe(2);
  });

  it('reuses a slot only after it is released', () => {
    const pool = new InMemorySlotPool();
    const first = pool.allocate();
    pool.allocate();
    pool.release(first);
    expect(pool.allocate()).toBe(first);
  });

  it('skips slots reserved by a boot reconcile', () => {
    const pool = new InMemorySlotPool({ reserved: [3, 4] });
    expect(pool.allocate()).toBe(5);
  });

  it('throws a named error when the pool is exhausted', () => {
    const pool = new InMemorySlotPool({ min: 3, max: 4 });
    pool.allocate();
    pool.allocate();
    expect(() => pool.allocate()).toThrow(SlotPoolExhaustedError);
  });
});

describe('parseSessionTapNames', () => {
  it('picks out only session taps', () => {
    // Deleting anything else here would tear down the host's own networking.
    const output = [
      '1: lo: <LOOPBACK,UP> mtu 65536',
      '2: ens5: <BROADCAST,UP> mtu 9001',
      '3: docker0: <NO-CARRIER,BROADCAST> mtu 1500',
      '4: ahfc0: <BROADCAST,UP> mtu 1500',
      '5: ahfct3: <BROADCAST,UP> mtu 1500',
      '6: ahfct41: <BROADCAST,UP> mtu 1500',
      '7: veth9a1b@if6: <BROADCAST,UP> mtu 1500',
    ].join('\n');
    expect(parseSessionTapNames(output)).toEqual(['ahfct3', 'ahfct41']);
  });

  it('returns nothing for empty output', () => {
    expect(parseSessionTapNames('')).toEqual([]);
  });
});

describe('reconcileFirecrackerHost', () => {
  it('creates the bridge and deletes stale taps', async () => {
    const run = vi.fn(async (argv: string[]) => {
      if (argv[1] === '-o') {
        return { ok: true, stdout: '5: ahfct3: <UP>\n6: ahfct9: <UP>', stderr: '' };
      }
      return { ok: true, stdout: '', stderr: '' };
    });
    const result = await reconcileFirecrackerHost({ run });
    expect(result.bridgeReady).toBe(true);
    expect(result.deletedTaps).toEqual(['ahfct3', 'ahfct9']);
    expect(run).toHaveBeenCalledWith(['ip', 'link', 'del', 'ahfct3']);
  });

  it('treats an already-existing bridge as success', async () => {
    // Every boot after the first hits this path; warning on it would train
    // operators to ignore the log line that matters.
    const run = vi.fn(async (argv: string[]) => {
      if (argv[1] === 'link' && argv[2] === 'add') {
        return { ok: false, stdout: '', stderr: 'RTNETLINK answers: File exists' };
      }
      return { ok: true, stdout: '', stderr: '' };
    });
    const warn = vi.fn();
    const result = await reconcileFirecrackerHost({ run, logger: { warn } });
    expect(result.bridgeReady).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports a bridge that genuinely failed', async () => {
    const run = vi.fn(async () => ({ ok: false, stdout: '', stderr: 'Operation not permitted' }));
    const warn = vi.fn();
    const result = await reconcileFirecrackerHost({ run, logger: { warn } });
    expect(result.bridgeReady).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('builds the bridge with the gateway address the guests are told to use', () => {
    const argv = buildEnsureBridgeArgv();
    expect(argv[0]).toEqual(['ip', 'link', 'add', 'ahfc0', 'type', 'bridge']);
    expect(argv[1]).toContain('172.30.0.1/16');
  });
});
