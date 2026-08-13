/**
 * Pure builders for a session microVM: naming, network plan, Firecracker
 * boot config, and the `firecracker` / `jailer` argv.
 *
 * Everything here is a pure function of its inputs so the shape of a VM is
 * unit-testable on a laptop with no KVM, no root, and no tap devices — the
 * same parity seam `finalize/runner-exec-args.ts` gives the CI runner.
 *
 * Addressing: one host bridge carries every session VM, and each VM is
 * identified by a single small integer (its *slot*), from which the guest IP,
 * MAC, vsock CID, and tap name are all derived. One number to grep for when a
 * VM misbehaves beats four independent allocators that can drift apart.
 */

/** Where the session worktree disk is mounted inside the guest. */
export const FIRECRACKER_GUEST_WORKSPACE = '/workspace';

/** Unprivileged user the guest agent runs commands as. Matches the runner image. */
export const FIRECRACKER_GUEST_USER = 'runner';

/**
 * Host bridge every session tap is enslaved to. A single shared L2 segment
 * (rather than a /30 per VM) is what lets the Hub dial a guest IP directly and
 * reuse the existing `container-ip` port routing: no host port pool, and a
 * port that appears minutes after boot is reachable with no reconfiguration.
 */
export const FIRECRACKER_BRIDGE_NAME = 'ahfc0';
export const FIRECRACKER_SUBNET_PREFIX = 16;
/** 172.30.0.0/16 — inside RFC1918 and clear of docker's default 172.17/16. */
export const FIRECRACKER_SUBNET_BASE = [172, 30, 0, 0] as const;
export const FIRECRACKER_GATEWAY_IP = '172.30.0.1';

/** Guest subnet CIDR used for NAT masquerade and FORWARD rules. */
export function firecrackerSubnetCidr(): string {
  const [a, b, c, d] = FIRECRACKER_SUBNET_BASE;
  return `${a}.${b}.${c}.${d}/${FIRECRACKER_SUBNET_PREFIX}`;
}

/**
 * Slots below this are reserved: 0/1 collide with the network address and the
 * gateway, and vsock reserves CIDs 0-2 (2 is the host). Starting at 3 keeps
 * `cid === slot` true, so a VM's address and its control channel share one id.
 */
export const FIRECRACKER_MIN_SLOT = 3;
export const FIRECRACKER_MAX_SLOT = 65_534;

export interface VmNetworkPlan {
  slot: number;
  /** Host-side tap interface, enslaved to {@link FIRECRACKER_BRIDGE_NAME}. */
  tapName: string;
  guestIp: string;
  gatewayIp: string;
  /** Dotted-quad form; the kernel `ip=` cmdline option wants it spelled out. */
  netmask: string;
  guestMac: string;
  /** vsock context id. Equals the slot. */
  guestCid: number;
}

function assertSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < FIRECRACKER_MIN_SLOT || slot > FIRECRACKER_MAX_SLOT) {
    throw new Error(
      `VM slot must be an integer in [${FIRECRACKER_MIN_SLOT}, ${FIRECRACKER_MAX_SLOT}] (got ${slot})`,
    );
  }
}

export function planVmNetwork(slot: number): VmNetworkPlan {
  assertSlot(slot);
  const [a, b] = FIRECRACKER_SUBNET_BASE;
  const third = (slot >> 8) & 0xff;
  const fourth = slot & 0xff;
  const guestIp = `${a}.${b}.${third}.${fourth}`;
  return {
    slot,
    // IFNAMSIZ caps interface names at 15 chars; `ahfct` + 5 digits fits.
    tapName: `ahfct${slot}`,
    guestIp,
    gatewayIp: FIRECRACKER_GATEWAY_IP,
    netmask: '255.255.0.0',
    // Locally-administered unicast prefix (02:) + the address, so the MAC is
    // readable straight off the IP when reading `ip neigh` output.
    guestMac: `02:fc:${hex(a)}:${hex(b)}:${hex(third)}:${hex(fourth)}`,
    guestCid: slot,
  };
}

function hex(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** Jailer requires the VM id to be alphanumeric-with-dashes, max 64 chars. */
export function sessionVmId(sessionId: string): string {
  const sanitized = sessionId.replace(/[^A-Za-z0-9-]/g, '');
  return `ahvm-${sanitized}`.slice(0, 64);
}

export interface VmBootArgsOpts {
  network: VmNetworkPlan;
  /**
   * Resolvers for the guest. The static `ip=` option assigns an address but
   * writes no resolver, so without these the guest routes fine and resolves
   * nothing. Empty leaves the image default in place.
   */
  nameservers?: string[];
  /** Appended verbatim; used to hand the guest agent its identity. */
  extra?: string[];
}

/**
 * Kernel command line. The static `ip=` option configures eth0 during boot,
 * which removes DHCP from the critical path — a DHCP client would add seconds
 * to a boot the whole point of which is to take milliseconds.
 */
export function vmBootArgs(opts: VmBootArgsOpts): string {
  const { network } = opts;
  const base = [
    'console=ttyS0',
    'reboot=k',
    'panic=1',
    // No PCI probing and no legacy modules: the device model has none of it,
    // and probing for absent hardware is pure boot latency.
    'pci=off',
    'i8042.noaux=1',
    'i8042.nomux=1',
    'i8042.nopnp=1',
    'i8042.dumbkbd=1',
    `ip=${network.guestIp}::${network.gatewayIp}:${network.netmask}::eth0:off`,
    'root=/dev/vda',
    'rw',
  ];
  // Only emitted when the host has resolvers to offer; otherwise the guest
  // image's baked-in default applies. See agent-hub-write-resolv.
  const nameservers = (opts.nameservers ?? []).filter((entry) => entry.trim() !== '');
  if (nameservers.length > 0) base.push(`agenthub.dns=${nameservers.join(',')}`);
  return [...base, ...(opts.extra ?? [])].join(' ');
}

export interface FirecrackerDrive {
  drive_id: string;
  path_on_host: string;
  is_root_device: boolean;
  is_read_only: boolean;
}

export interface FirecrackerVmConfig {
  'boot-source': { kernel_image_path: string; boot_args: string };
  drives: FirecrackerDrive[];
  'machine-config': { vcpu_count: number; mem_size_mib: number; smt: boolean };
  'network-interfaces': { iface_id: string; host_dev_name: string; guest_mac: string }[];
  vsock: { guest_cid: number; uds_path: string };
  balloon: {
    amount_mib: number;
    deflate_on_oom: boolean;
    stats_polling_interval_s: number;
  };
}

export interface BuildVmConfigOpts {
  network: VmNetworkPlan;
  /** Guest kernel (uncompressed vmlinux), as the VMM process sees it. */
  kernelPath: string;
  /** Per-VM copy-on-write overlay of the shared base rootfs. */
  rootfsPath: string;
  /** Per-session workspace disk holding the worktree. */
  workspacePath: string;
  vsockUdsPath: string;
  vcpuCount: number;
  memSizeMib: number;
  bootArgsExtra?: string[];
  /** See {@link VmBootArgsOpts.nameservers}. */
  nameservers?: string[];
}

export function buildFirecrackerVmConfig(opts: BuildVmConfigOpts): FirecrackerVmConfig {
  if (opts.vcpuCount < 1) throw new Error(`vcpuCount must be >= 1 (got ${opts.vcpuCount})`);
  if (opts.memSizeMib < 128) {
    throw new Error(`memSizeMib must be >= 128 (got ${opts.memSizeMib})`);
  }
  return {
    'boot-source': {
      kernel_image_path: opts.kernelPath,
      boot_args: vmBootArgs({
        network: opts.network,
        nameservers: opts.nameservers,
        extra: opts.bootArgsExtra,
      }),
    },
    drives: [
      {
        drive_id: 'rootfs',
        path_on_host: opts.rootfsPath,
        is_root_device: true,
        is_read_only: false,
      },
      {
        drive_id: 'workspace',
        path_on_host: opts.workspacePath,
        is_root_device: false,
        is_read_only: false,
      },
    ],
    'machine-config': {
      vcpu_count: opts.vcpuCount,
      mem_size_mib: opts.memSizeMib,
      // SMT off matches Firecracker's guidance for untrusted guests: a sibling
      // hyperthread is a cross-VM side channel.
      smt: false,
    },
    'network-interfaces': [
      {
        iface_id: 'eth0',
        host_dev_name: opts.network.tapName,
        guest_mac: opts.network.guestMac,
      },
    ],
    vsock: {
      guest_cid: opts.network.guestCid,
      uds_path: opts.vsockUdsPath,
    },
    balloon: {
      // Starts empty and is inflated by the reaper to claw back a guest page
      // cache the host cannot otherwise reclaim — the memory overhead a VM has
      // over a container, made recoverable.
      amount_mib: 0,
      deflate_on_oom: true,
      stats_polling_interval_s: 1,
    },
  };
}

export interface BuildFirecrackerArgvOpts {
  binary?: string;
  apiSockPath: string;
  configPath: string;
  /** Firecracker's own log file; separate from guest console output. */
  logPath?: string;
  level?: 'Error' | 'Warning' | 'Info' | 'Debug';
}

export function buildFirecrackerArgv(opts: BuildFirecrackerArgvOpts): string[] {
  const argv = [
    opts.binary ?? 'firecracker',
    '--api-sock',
    opts.apiSockPath,
    '--config-file',
    opts.configPath,
  ];
  if (opts.logPath) {
    argv.push('--log-path', opts.logPath, '--level', opts.level ?? 'Warning');
  }
  return argv;
}

export interface BuildJailerArgvOpts {
  jailerBinary?: string;
  firecrackerBinary?: string;
  vmId: string;
  /** Numeric ids the jailed VMM drops to after chrooting. */
  uid: number;
  gid: number;
  chrootBaseDir: string;
  /** Paths below are relative to the chroot, not the host root. */
  apiSockPath: string;
  configPath: string;
  /** Pre-created network namespace to join, when one is used. */
  netns?: string;
  /**
   * cgroup constraints, e.g. v2 `memory.max=6442450944` or v1
   * `memory.limit_in_bytes=…`. Jailer defaults to cgroup v1, so callers that
   * pass v2 file names must also set {@link cgroupVersion} to 2.
   */
  cgroups?: string[];
  /** Jailer `--cgroup-version`. Defaults to 2 when omitted (modern hosts). */
  cgroupVersion?: 1 | 2;
}

/**
 * Jailer argv. The jailer chroots the VMM, drops to an unprivileged uid, and
 * applies cgroup limits before exec'ing Firecracker — the difference between
 * "a VM boundary" and "a VM boundary plus a compromised VMM running as root".
 * Everything after `--` is passed through to Firecracker itself.
 */
export function buildJailerArgv(opts: BuildJailerArgvOpts): string[] {
  const argv = [
    opts.jailerBinary ?? 'jailer',
    '--id',
    opts.vmId,
    '--exec-file',
    opts.firecrackerBinary ?? '/usr/bin/firecracker',
    '--uid',
    String(opts.uid),
    '--gid',
    String(opts.gid),
    '--chroot-base-dir',
    opts.chrootBaseDir,
    // AL2023 / modern Ubuntu are cgroup v2; jailer's implicit default is v1
    // and fails with "No hierarchy found for this cgroup version".
    '--cgroup-version',
    String(opts.cgroupVersion ?? 2),
  ];
  if (opts.netns) argv.push('--netns', opts.netns);
  for (const cgroup of opts.cgroups ?? []) argv.push('--cgroup', cgroup);
  argv.push('--', '--api-sock', opts.apiSockPath, '--config-file', opts.configPath);
  return argv;
}

/** Default closed net helper (sudoers / docker entrypoint). */
export const FC_NETCTL_HELPER_DEFAULT = '/usr/local/lib/agent-hub/fc-netctl.sh';

export function resolveFcNetctlHelper(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_HUB_FIRECRACKER_NETCTL_HELPER?.trim() || FC_NETCTL_HELPER_DEFAULT;
}

/**
 * Host commands that create and tear down a VM's tap device.
 * Routed through {@link resolveFcNetctlHelper} so local sudoers never grants
 * raw `ip` to the Hub process.
 */
export function buildCreateTapArgv(plan: VmNetworkPlan): string[][] {
  return [[resolveFcNetctlHelper(), 'tap-create', plan.tapName]];
}

export function buildDeleteTapArgv(plan: VmNetworkPlan): string[] {
  return [resolveFcNetctlHelper(), 'tap-delete', plan.tapName];
}
