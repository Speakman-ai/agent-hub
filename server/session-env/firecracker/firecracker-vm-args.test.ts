import { describe, it, expect } from 'vitest';
import {
  FIRECRACKER_BRIDGE_NAME,
  FIRECRACKER_MAX_SLOT,
  FIRECRACKER_MIN_SLOT,
  buildCreateTapArgv,
  buildDeleteTapArgv,
  buildFirecrackerArgv,
  buildFirecrackerVmConfig,
  buildJailerArgv,
  planVmNetwork,
  sessionVmId,
  vmBootArgs,
} from './firecracker-vm-args.js';

describe('planVmNetwork', () => {
  it('derives address, MAC, tap, and CID from one slot', () => {
    const plan = planVmNetwork(3);
    expect(plan).toEqual({
      slot: 3,
      tapName: 'ahfct3',
      guestIp: '172.30.0.3',
      gatewayIp: '172.30.0.1',
      netmask: '255.255.0.0',
      guestMac: '02:fc:ac:1e:00:03',
      guestCid: 3,
    });
  });

  it('carries the slot into the third octet past 255', () => {
    const plan = planVmNetwork(300);
    expect(plan.guestIp).toBe('172.30.1.44');
    expect(plan.guestMac).toBe('02:fc:ac:1e:01:2c');
  });

  it('keeps the tap name within the 15-char kernel limit at the top slot', () => {
    // IFNAMSIZ is 16 including the NUL, so a name over 15 chars makes
    // `ip tuntap add` fail — at the far end of the pool, long after tests
    // that only exercise slot 3 have passed.
    expect(planVmNetwork(FIRECRACKER_MAX_SLOT).tapName.length).toBeLessThanOrEqual(15);
  });

  it('rejects slots that collide with the gateway or reserved vsock CIDs', () => {
    for (const slot of [0, 1, 2]) {
      expect(() => planVmNetwork(slot)).toThrow(/VM slot must be an integer/);
    }
    expect(() => planVmNetwork(FIRECRACKER_MIN_SLOT)).not.toThrow();
    expect(() => planVmNetwork(FIRECRACKER_MAX_SLOT + 1)).toThrow();
    expect(() => planVmNetwork(3.5)).toThrow();
  });
});

describe('vmBootArgs', () => {
  it('configures the interface statically so DHCP is off the boot path', () => {
    const args = vmBootArgs({ network: planVmNetwork(4) });
    expect(args).toContain('ip=172.30.0.4::172.30.0.1:255.255.0.0::eth0:off');
    expect(args).toContain('root=/dev/vda');
    expect(args).toContain('pci=off');
  });

  it('appends extra args verbatim', () => {
    const args = vmBootArgs({ network: planVmNetwork(4), extra: ['ahvm.session=abc'] });
    expect(args.endsWith('ahvm.session=abc')).toBe(true);
  });
});

describe('buildFirecrackerVmConfig', () => {
  const base = {
    network: planVmNetwork(5),
    kernelPath: 'vmlinux',
    rootfsPath: 'rootfs.ext4',
    workspacePath: 'workspace.ext4',
    vsockUdsPath: 'vsock.sock',
    vcpuCount: 2,
    memSizeMib: 6144,
  };

  it('boots the rootfs as the root device and attaches the workspace second', () => {
    const cfg = buildFirecrackerVmConfig(base);
    expect(cfg.drives.map((d) => [d.drive_id, d.is_root_device])).toEqual([
      ['rootfs', true],
      ['workspace', false],
    ]);
    expect(cfg.drives.every((d) => !d.is_read_only)).toBe(true);
  });

  it('disables SMT so a sibling hyperthread is not a cross-VM channel', () => {
    expect(buildFirecrackerVmConfig(base)['machine-config'].smt).toBe(false);
  });

  it('attaches a balloon that starts empty but can reclaim later', () => {
    // The balloon is how the host claws back a guest page cache it otherwise
    // cannot touch; without the device attached at boot it cannot be added.
    const cfg = buildFirecrackerVmConfig(base);
    expect(cfg.balloon.amount_mib).toBe(0);
    expect(cfg.balloon.deflate_on_oom).toBe(true);
    expect(cfg.balloon.stats_polling_interval_s).toBeGreaterThan(0);
  });

  it('wires vsock to the slot CID and the network to the slot tap', () => {
    const cfg = buildFirecrackerVmConfig(base);
    expect(cfg.vsock.guest_cid).toBe(5);
    expect(cfg['network-interfaces'][0]).toEqual({
      iface_id: 'eth0',
      host_dev_name: 'ahfct5',
      guest_mac: '02:fc:ac:1e:00:05',
    });
  });

  it('rejects a machine config the VMM would refuse', () => {
    expect(() => buildFirecrackerVmConfig({ ...base, vcpuCount: 0 })).toThrow(/vcpuCount/);
    expect(() => buildFirecrackerVmConfig({ ...base, memSizeMib: 64 })).toThrow(/memSizeMib/);
  });
});

describe('argv builders', () => {
  it('builds a firecracker invocation with an API socket', () => {
    expect(
      buildFirecrackerArgv({ apiSockPath: '/run/fc.sock', configPath: '/run/cfg.json' }),
    ).toEqual(['firecracker', '--api-sock', '/run/fc.sock', '--config-file', '/run/cfg.json']);
  });

  it('adds logging only when a log path is given', () => {
    const argv = buildFirecrackerArgv({
      apiSockPath: 'a',
      configPath: 'b',
      logPath: '/run/fc.log',
    });
    expect(argv.slice(-4)).toEqual(['--log-path', '/run/fc.log', '--level', 'Warning']);
  });

  it('passes firecracker flags after the jailer separator', () => {
    // Anything before `--` configures the jail; anything after configures the
    // VMM. Getting this boundary wrong makes the jailer reject the flag.
    const argv = buildJailerArgv({
      vmId: 'ahvm-1',
      uid: 1000,
      gid: 1000,
      chrootBaseDir: '/srv/jailer',
      apiSockPath: '/run/fc.sock',
      configPath: '/run/cfg.json',
      netns: '/var/run/netns/ns1',
      cgroups: ['memory.max=6442450944'],
    });
    const sep = argv.indexOf('--');
    expect(argv.slice(sep + 1)).toEqual([
      '--api-sock',
      '/run/fc.sock',
      '--config-file',
      '/run/cfg.json',
    ]);
    expect(argv.slice(0, sep)).toContain('--netns');
    expect(argv.slice(0, sep)).toContain('memory.max=6442450944');
    expect(argv.slice(0, sep)).toContain('1000');
  });

  it('sanitizes a session id into a jailer-safe vm id', () => {
    expect(sessionVmId('82162228-636e-483b-8453-eb1aa54afea6')).toBe(
      'ahvm-82162228-636e-483b-8453-eb1aa54afea6',
    );
    expect(sessionVmId('weird/id:with spaces')).toBe('ahvm-weirdidwithspaces');
    expect(sessionVmId('x'.repeat(200)).length).toBeLessThanOrEqual(64);
  });

  it('enslaves the tap to the shared bridge and brings it up', () => {
    const plan = planVmNetwork(7);
    expect(buildCreateTapArgv(plan)).toEqual([
      ['ip', 'tuntap', 'add', 'ahfct7', 'mode', 'tap'],
      ['ip', 'link', 'set', 'ahfct7', 'master', FIRECRACKER_BRIDGE_NAME],
      ['ip', 'link', 'set', 'ahfct7', 'up'],
    ]);
    expect(buildDeleteTapArgv(plan)).toEqual(['ip', 'link', 'del', 'ahfct7']);
  });
});
