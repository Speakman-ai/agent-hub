import { describe, it, expect, vi } from 'vitest';
import { KVM_DEVICE, probeFirecrackerCapability } from './firecracker-capability.js';
import {
  InMemorySlotPool,
  SlotPoolExhaustedError,
  buildEnsureBridgeArgv,
  buildEnsureGuestNatArgv,
  parseSessionTapNames,
  parseUplinkDev,
  reconcileFirecrackerHost,
} from './firecracker-slots.js';
import { FIRECRACKER_MIN_SLOT, firecrackerSubnetCidr } from './firecracker-vm-args.js';

function mockReconcileRun(
  opts: {
    linkStdout?: string;
    routeStdout?: string;
    /** Argv prefixes that should fail (e.g. bridge add). */
    failWhen?: (argv: string[]) => { ok: false; stderr: string } | null;
  } = {},
) {
  return vi.fn(async (argv: string[]) => {
    const fail = opts.failWhen?.(argv);
    if (fail) return { ...fail, stdout: '' };
    if (argv[0] === 'ip' && argv[1] === '-o' && argv[2] === 'route') {
      return {
        ok: true,
        stdout: opts.routeStdout ?? '1.1.1.1 via 10.0.0.1 dev eth0 src 10.0.0.5\n',
        stderr: '',
      };
    }
    if (argv[0] === 'ip' && argv[1] === '-o' && argv[2] === 'link') {
      return {
        ok: true,
        stdout: opts.linkStdout ?? '5: ahfct3: <UP>\n6: ahfct9: <UP>',
        stderr: '',
      };
    }
    // iptables -C "rule missing" → not ok, so the -A/-I path runs.
    if (argv[0] === 'iptables' && argv.includes('-C')) {
      return { ok: false, stdout: '', stderr: 'No chain/target/match by that name' };
    }
    // bridge-nf-call-iptables verify must report 1 for NAT readiness.
    if (argv[0] === 'sysctl' && argv[1] === '-n' && String(argv[2]).includes('bridge-nf')) {
      return { ok: true, stdout: '1\n', stderr: '' };
    }
    return { ok: true, stdout: '', stderr: '' };
  });
}
const okProbe = {
  platform: 'linux' as NodeJS.Platform,
  isCharacterDevice: () => true,
  access: () => undefined,
  openKvm: () => undefined,
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

  it('declines when KVM cannot be opened read/write even after access succeeds', () => {
    const result = probeFirecrackerCapability({
      ...okProbe,
      openKvm: () => {
        throw new Error('EBUSY');
      },
    });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/could not be opened read\/write/);
    expect(result.reason).toContain('EBUSY');
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

describe('parseUplinkDev', () => {
  it('reads the egress interface from ip route get output', () => {
    expect(parseUplinkDev('1.1.1.1 via 10.20.150.1 dev enp39s0 src 10.20.150.182 uid 0')).toBe(
      'enp39s0',
    );
  });

  it('returns null when there is no uplink', () => {
    expect(parseUplinkDev('')).toBeNull();
    expect(parseUplinkDev('RTNETLINK answers: Network is unreachable')).toBeNull();
  });
});

describe('buildEnsureGuestNatArgv', () => {
  it('NATs the guest subnet behind the uplink and opens FORWARD', () => {
    const { required, optional } = buildEnsureGuestNatArgv('enp39s0');
    expect(required[0]).toEqual(['sysctl', '-qw', 'net.ipv4.ip_forward=1']);
    expect(required).toContainEqual([
      'iptables',
      '-I',
      'FORWARD',
      '-i',
      'ahfc0',
      '-o',
      'ahfc0',
      '-j',
      'DROP',
    ]);
    expect(required).toContainEqual([
      'iptables',
      '-t',
      'nat',
      '-A',
      'POSTROUTING',
      '-s',
      firecrackerSubnetCidr(),
      '-o',
      'enp39s0',
      '-j',
      'MASQUERADE',
    ]);
    expect(required).toContainEqual([
      'iptables',
      '-A',
      'FORWARD',
      '-i',
      'ahfc0',
      '-o',
      'enp39s0',
      '-j',
      'ACCEPT',
    ]);
    // DOCKER-USER accepts must name both interfaces — never bare `-i ahfc0`.
    expect(optional).toContainEqual([
      'iptables',
      '-I',
      'DOCKER-USER',
      '-i',
      'ahfc0',
      '-o',
      'enp39s0',
      '-j',
      'ACCEPT',
    ]);
    expect(optional.some((argv) => argv.includes('-i') && !argv.includes('-o'))).toBe(false);
  });
});

describe('reconcileFirecrackerHost', () => {
  it('stops stale VMM containers before deleting taps', async () => {
    const events: string[] = [];
    const stopStaleVmms = vi.fn(async () => {
      events.push('stop');
    });
    const run = vi.fn(async (argv: string[]) => {
      if (argv[0] === 'ip' && argv[2] === 'del') events.push('del');
      return mockReconcileRun()(argv);
    });
    await reconcileFirecrackerHost({ run, stopStaleVmms });
    expect(stopStaleVmms).toHaveBeenCalledTimes(1);
    expect(events.indexOf('stop')).toBeLessThan(events.indexOf('del'));
  });

  it('fails closed when stale VMM stop fails (no tap delete, nat not ready)', async () => {
    const stopStaleVmms = vi.fn(async () => {
      throw new Error('docker rm failed');
    });
    const run = mockReconcileRun();
    const warn = vi.fn();
    const result = await reconcileFirecrackerHost({ run, stopStaleVmms, logger: { warn } });
    expect(result.natReady).toBe(false);
    expect(result.deletedTaps).toEqual([]);
    expect(run).not.toHaveBeenCalledWith(['ip', 'link', 'del', 'ahfct3']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refusing Firecracker readiness'));
  });

  it('creates the bridge, installs guest NAT, and deletes stale taps', async () => {
    const run = mockReconcileRun();
    const result = await reconcileFirecrackerHost({ run });
    expect(result.bridgeReady).toBe(true);
    expect(result.natReady).toBe(true);
    expect(result.deletedTaps).toEqual(['ahfct3', 'ahfct9']);
    expect(run).toHaveBeenCalledWith(['ip', 'link', 'del', 'ahfct3']);
    expect(run).toHaveBeenCalledWith([
      'iptables',
      '-t',
      'nat',
      '-A',
      'POSTROUTING',
      '-s',
      '172.30.0.0/16',
      '-o',
      'eth0',
      '-j',
      'MASQUERADE',
    ]);
  });

  it('treats an already-existing bridge as success', async () => {
    // Every boot after the first hits this path; warning on it would train
    // operators to ignore the log line that matters.
    const run = mockReconcileRun({
      failWhen: (argv) =>
        argv[1] === 'link' && argv[2] === 'add'
          ? { ok: false, stderr: 'RTNETLINK answers: File exists' }
          : null,
    });
    const warn = vi.fn();
    const result = await reconcileFirecrackerHost({ run, logger: { warn } });
    expect(result.bridgeReady).toBe(true);
    expect(result.natReady).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports a bridge that genuinely failed', async () => {
    const run = vi.fn(async () => ({ ok: false, stdout: '', stderr: 'Operation not permitted' }));
    const warn = vi.fn();
    const result = await reconcileFirecrackerHost({ run, logger: { warn } });
    expect(result.bridgeReady).toBe(false);
    expect(result.natReady).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('continues when modprobe is missing but br_netfilter is already loaded', async () => {
    const run = mockReconcileRun({
      failWhen: (argv) =>
        argv.includes('br_netfilter') && argv[0] !== 'test'
          ? {
              ok: false,
              stderr: 'exec: "modprobe": executable file not found in $PATH: unknown',
            }
          : null,
    });
    // mockReconcileRun returns ok:true for unknown argv — including `test -d`.
    const warn = vi.fn();
    const result = await reconcileFirecrackerHost({ run, logger: { warn } });
    expect(result.natReady).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already loaded'));
  });

  it('fails NAT when modprobe is missing and br_netfilter is not loaded', async () => {
    const run = mockReconcileRun({
      failWhen: (argv) => {
        if (argv[0] === 'test' && argv.includes('/sys/module/br_netfilter')) {
          return { ok: false, stderr: '' };
        }
        if (argv.includes('br_netfilter')) {
          return { ok: false, stderr: 'executable file not found in $PATH' };
        }
        return null;
      },
    });
    const warn = vi.fn();
    const result = await reconcileFirecrackerHost({ run, logger: { warn } });
    expect(result.natReady).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('modprobe br_netfilter failed'));
  });

  it('marks NAT not ready when the host has no default uplink', async () => {
    const run = mockReconcileRun({ routeStdout: '' });
    // Force route get to fail so parseUplinkDev sees nothing usable.
    run.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'ip' && argv[2] === 'route') {
        return { ok: false, stdout: '', stderr: 'Network is unreachable' };
      }
      if (argv[0] === 'ip' && argv[2] === 'link') {
        return { ok: true, stdout: '', stderr: '' };
      }
      if (argv[0] === 'iptables' && argv.includes('-C')) {
        return { ok: false, stdout: '', stderr: 'missing' };
      }
      return { ok: true, stdout: '', stderr: '' };
    });
    const warn = vi.fn();
    const result = await reconcileFirecrackerHost({ run, logger: { warn } });
    expect(result.natReady).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no default uplink'));
  });

  it('builds the bridge with the gateway address the guests are told to use', () => {
    const argv = buildEnsureBridgeArgv();
    expect(argv[0]).toEqual(['ip', 'link', 'add', 'ahfc0', 'type', 'bridge']);
    expect(argv[1]).toContain('172.30.0.1/16');
  });
});
