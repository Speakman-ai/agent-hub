/**
 * Slot allocation and host-network preparation for session microVMs.
 *
 * A slot is the single integer every per-VM identity is derived from — guest
 * IP, MAC, tap name, and vsock CID (see `firecracker-vm-args.ts`). Handing the
 * same slot to two live VMs would collide on all four at once, so allocation
 * is the one place that has to be exactly right.
 *
 * Slots are in-memory, which is correct rather than lazy: a slot is only
 * meaningful while its VM exists, and the boot sweep below deletes every tap
 * left behind by a previous process before any slot is handed out. That makes
 * a Hub restart authoritative instead of something the allocator has to
 * reason about.
 */

import {
  FIRECRACKER_BRIDGE_NAME,
  FIRECRACKER_GATEWAY_IP,
  FIRECRACKER_MAX_SLOT,
  FIRECRACKER_MIN_SLOT,
  FIRECRACKER_SUBNET_PREFIX,
  firecrackerSubnetCidr,
  resolveFcNetctlHelper,
} from './firecracker-vm-args.js';
import type { FirecrackerSlotPool } from './firecracker-session-env.js';

export class SlotPoolExhaustedError extends Error {
  constructor(limit: number) {
    super(`No free microVM slot: all ${limit} slots are in use`);
    this.name = 'SlotPoolExhaustedError';
  }
}

export interface InMemorySlotPoolOpts {
  min?: number;
  max?: number;
  /** Slots already taken (e.g. adopted from a boot reconcile). */
  reserved?: Iterable<number>;
}

export class InMemorySlotPool implements FirecrackerSlotPool {
  readonly #used = new Set<number>();
  readonly #min: number;
  readonly #max: number;

  constructor(opts: InMemorySlotPoolOpts = {}) {
    this.#min = opts.min ?? FIRECRACKER_MIN_SLOT;
    this.#max = opts.max ?? FIRECRACKER_MAX_SLOT;
    for (const slot of opts.reserved ?? []) this.#used.add(slot);
  }

  allocate(): number {
    for (let slot = this.#min; slot <= this.#max; slot++) {
      if (this.#used.has(slot)) continue;
      this.#used.add(slot);
      return slot;
    }
    throw new SlotPoolExhaustedError(this.#max - this.#min + 1);
  }

  release(slot: number): void {
    this.#used.delete(slot);
  }

  get inUse(): number {
    return this.#used.size;
  }

  has(slot: number): boolean {
    return this.#used.has(slot);
  }
}

/** Commands that create the shared bridge every session tap attaches to. */
export function buildEnsureBridgeArgv(): string[][] {
  // Prefer the closed netctl helper; keep the historical raw argv shape as the
  // fallback documentation of what netctl runs (unit tests assert both).
  return [[resolveFcNetctlHelper(), 'ensure-bridge']];
}

/** @deprecated Prefer buildEnsureBridgeArgv(); retained for NAT shape tests. */
export function buildEnsureBridgeRawIpArgv(): string[][] {
  return [
    ['ip', 'link', 'add', FIRECRACKER_BRIDGE_NAME, 'type', 'bridge'],
    [
      'ip',
      'addr',
      'add',
      `${FIRECRACKER_GATEWAY_IP}/${FIRECRACKER_SUBNET_PREFIX}`,
      'dev',
      FIRECRACKER_BRIDGE_NAME,
    ],
    ['ip', 'link', 'set', FIRECRACKER_BRIDGE_NAME, 'up'],
  ];
}

/**
 * Tap names left over from a previous Hub process.
 *
 * `ip link show` output is line-oriented as `<index>: <name>: <flags>`, where
 * the name may carry an `@peer` suffix. Only interfaces matching the session
 * tap pattern are returned, so a bridge or a project's own veth is never
 * mistaken for garbage to delete.
 */
export function parseSessionTapNames(ipLinkOutput: string): string[] {
  const names: string[] = [];
  for (const line of ipLinkOutput.split('\n')) {
    const match = /^\d+:\s+([^:@\s]+)/.exec(line);
    if (!match) continue;
    if (/^ahfct\d+$/.test(match[1])) names.push(match[1]);
  }
  return names;
}

export interface ReconcileFirecrackerHostDeps {
  run(argv: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }>;
  logger?: { warn: (msg: string) => void };
  /** Best-effort stop of orphaned VMM containers before deleting taps. */
  stopStaleVmms?: () => Promise<void>;
}

export interface ReconcileFirecrackerHostResult {
  bridgeReady: boolean;
  /** False when guests would have no outbound path (no uplink / NAT failed). */
  natReady: boolean;
  deletedTaps: string[];
}

/**
 * Pull the egress interface out of `ip route get <addr>` output.
 * Returns null when the host has no usable default route.
 */
export function parseUplinkDev(ipRouteGetOutput: string): string | null {
  const match = /\bdev\s+(\S+)/.exec(ipRouteGetOutput);
  const dev = match?.[1];
  return dev && dev.length > 0 ? dev : null;
}

export interface GuestNatArgv {
  /** Always run (sysctl + MASQUERADE + FORWARD). Failures mark NAT not ready. */
  required: string[][];
  /**
   * Best-effort DOCKER-USER accepts. Absent when Docker is not installed
   * (no DOCKER-USER chain); failures are logged but do not fail NAT.
   */
  optional: string[][];
}

/**
 * iptables `-C` / `-A` (or `-I`) pairs that NAT the guest subnet behind the
 * host uplink and allow FORWARD both ways. Without these, guests resolve
 * nothing and `apt-get` / `npm` / `pip` die with "Temporary failure resolving …".
 *
 * The one-time host setup script installs the same rules, but Docker restarts
 * and image rollouts routinely leave the bridge up with no MASQUERADE — so the
 * Hub boot sweep re-applies them every start.
 */
export function buildEnsureGuestNatArgv(uplink: string): GuestNatArgv {
  const subnet = firecrackerSubnetCidr();
  const bridge = FIRECRACKER_BRIDGE_NAME;
  const required: string[][] = [
    ['sysctl', '-qw', 'net.ipv4.ip_forward=1'],
    // Block guest-to-guest forwarding on the shared bridge before any ACCEPT
    // rules — without this, sessions on different taps can reach each other.
    ['iptables', '-C', 'FORWARD', '-i', bridge, '-o', bridge, '-j', 'DROP'],
    ['iptables', '-I', 'FORWARD', '-i', bridge, '-o', bridge, '-j', 'DROP'],
    ['iptables', '-t', 'nat', '-C', 'POSTROUTING', '-s', subnet, '-o', uplink, '-j', 'MASQUERADE'],
    ['iptables', '-t', 'nat', '-A', 'POSTROUTING', '-s', subnet, '-o', uplink, '-j', 'MASQUERADE'],
    ['iptables', '-C', 'FORWARD', '-i', bridge, '-o', uplink, '-j', 'ACCEPT'],
    ['iptables', '-A', 'FORWARD', '-i', bridge, '-o', uplink, '-j', 'ACCEPT'],
    [
      'iptables',
      '-C',
      'FORWARD',
      '-i',
      uplink,
      '-o',
      bridge,
      '-m',
      'state',
      '--state',
      'RELATED,ESTABLISHED',
      '-j',
      'ACCEPT',
    ],
    [
      'iptables',
      '-A',
      'FORWARD',
      '-i',
      uplink,
      '-o',
      bridge,
      '-m',
      'state',
      '--state',
      'RELATED,ESTABLISHED',
      '-j',
      'ACCEPT',
    ],
  ];
  // DOCKER-USER runs before Docker's bridge-isolation chains. ACCEPT must be
  // scoped to the uplink — a bare `-i ahfc0 -j ACCEPT` would let an untrusted
  // guest route onto docker0 / other containers, not just the internet.
  const optional: string[][] = [
    ['iptables', '-C', 'DOCKER-USER', '-i', bridge, '-o', uplink, '-j', 'ACCEPT'],
    ['iptables', '-I', 'DOCKER-USER', '-i', bridge, '-o', uplink, '-j', 'ACCEPT'],
    [
      'iptables',
      '-C',
      'DOCKER-USER',
      '-i',
      uplink,
      '-o',
      bridge,
      '-m',
      'conntrack',
      '--ctstate',
      'RELATED,ESTABLISHED',
      '-j',
      'ACCEPT',
    ],
    [
      'iptables',
      '-I',
      'DOCKER-USER',
      '-i',
      uplink,
      '-o',
      bridge,
      '-m',
      'conntrack',
      '--ctstate',
      'RELATED,ESTABLISHED',
      '-j',
      'ACCEPT',
    ],
  ];
  return { required, optional };
}

async function ensureIptablesRule(
  run: ReconcileFirecrackerHostDeps['run'],
  checkArgv: string[],
  addArgv: string[],
  logger: { warn: (msg: string) => void },
  opts: { warnOnFailure: boolean },
): Promise<boolean> {
  const check = await run(checkArgv);
  if (check.ok) return true;
  const add = await run(addArgv);
  if (add.ok) return true;
  if (opts.warnOnFailure) {
    logger.warn(
      `[firecracker] failed to install NAT rule via \`${addArgv.join(' ')}\`: ${add.stderr.trim()}`,
    );
  }
  return false;
}

async function ensureIptablesRulePairs(
  run: ReconcileFirecrackerHostDeps['run'],
  pairs: string[][],
  logger: { warn: (msg: string) => void },
  opts: { warnOnFailure: boolean },
): Promise<boolean> {
  let ok = true;
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const installed = await ensureIptablesRule(run, pairs[i]!, pairs[i + 1]!, logger, opts);
    if (!installed) ok = false;
  }
  return ok;
}

/**
 * Enable ip_forward + MASQUERADE/FORWARD for the guest subnet.
 * Idempotent: each iptables rule is `-C`'d before `-A`/`-I`.
 */
/**
 * Bridged L2 traffic between session taps does not hit iptables FORWARD unless
 * br_netfilter is loaded and bridge-nf-call-iptables is on. Without that, the
 * ahfc0→ahfc0 DROP rule is a no-op and sibling guests can talk directly.
 */
export async function ensureBridgeNetfilter(
  deps: Pick<ReconcileFirecrackerHostDeps, 'run' | 'logger'>,
): Promise<boolean> {
  const logger = deps.logger ?? { warn: (msg: string) => console.warn(msg) };
  // Prefer absolute paths: the privileged docker helper uses `--entrypoint`,
  // and the Finalize runner image often has no `modprobe` on PATH (no kmod).
  const modprobeBins = ['/usr/sbin/modprobe', '/sbin/modprobe', 'modprobe'];
  let modprobeOk = false;
  let lastModprobeErr = '';
  for (const bin of modprobeBins) {
    const modprobe = await deps.run([bin, 'br_netfilter']);
    if (modprobe.ok) {
      modprobeOk = true;
      break;
    }
    lastModprobeErr = modprobe.stderr.trim() || modprobe.stdout.trim();
    // Keep trying other paths when the binary is missing; stop on a real load error.
    if (!/not found|no such file|executable file not found/i.test(lastModprobeErr)) {
      break;
    }
  }
  if (!modprobeOk) {
    // Host setup / a prior boot may already have the module. Privileged helpers
    // share the host's /sys, so this is authoritative without needing kmod.
    const loaded = await deps.run(['test', '-d', '/sys/module/br_netfilter']);
    if (!loaded.ok) {
      logger.warn(`[firecracker] modprobe br_netfilter failed: ${lastModprobeErr}`);
      return false;
    }
    logger.warn(
      `[firecracker] modprobe unavailable (${lastModprobeErr || 'not in PATH'}); ` +
        `br_netfilter already loaded — continuing`,
    );
  }
  const enable = await deps.run(['sysctl', '-qw', 'net.bridge.bridge-nf-call-iptables=1']);
  if (!enable.ok) {
    logger.warn(`[firecracker] failed to enable bridge-nf-call-iptables: ${enable.stderr.trim()}`);
    return false;
  }
  // Best-effort ipv6 twin — failure here must not block ipv4 isolation.
  await deps.run(['sysctl', '-qw', 'net.bridge.bridge-nf-call-ip6tables=1']);
  const verify = await deps.run(['sysctl', '-n', 'net.bridge.bridge-nf-call-iptables']);
  if (!verify.ok || verify.stdout.trim() !== '1') {
    logger.warn(
      `[firecracker] bridge-nf-call-iptables not enabled (got ${JSON.stringify(verify.stdout.trim())})`,
    );
    return false;
  }
  return true;
}

export async function ensureFirecrackerGuestNat(
  deps: ReconcileFirecrackerHostDeps,
): Promise<boolean> {
  const logger = deps.logger ?? { warn: (msg: string) => console.warn(msg) };
  // Closed helper owns uplink discovery, br_netfilter, sysctl, and iptables.
  // The Hub process must not hold passwordless sudo for those binaries.
  const helper = resolveFcNetctlHelper();
  const res = await deps.run([helper, 'ensure-nat']);
  if (!res.ok) {
    logger.warn(
      `[firecracker] fc-netctl ensure-nat failed: ${res.stderr.trim() || res.stdout.trim() || 'unknown'}`,
    );
    return false;
  }
  return true;
}

/**
 * Boot sweep: make the bridge exist, NAT the guest subnet for egress, and
 * delete every session tap this host still carries.
 *
 * Leftover taps are not cosmetic. A tap whose VM is gone keeps its name
 * occupied, so the first session after a restart fails to create `ahfct3` and
 * the whole backend looks broken. Deleting them here is what makes a restart
 * a clean slate — the same role `sysbox-reconcile.ts` plays for containers.
 *
 * NAT is re-applied every boot for the same reason: Docker / host rollouts
 * leave `ahfc0` up while dropping the MASQUERADE rule, which surfaces as
 * `apt-get` exit 100 ("Temporary failure resolving …") on the first preview.
 */
export async function reconcileFirecrackerHost(
  deps: ReconcileFirecrackerHostDeps,
): Promise<ReconcileFirecrackerHostResult> {
  const logger = deps.logger ?? { warn: (msg: string) => console.warn(msg) };
  const helper = resolveFcNetctlHelper();

  const bridge = await deps.run([helper, 'ensure-bridge']);
  const bridgeReady = bridge.ok || /exists/i.test(bridge.stderr) || /exists/i.test(bridge.stdout);
  if (!bridgeReady) {
    logger.warn(
      `[firecracker] failed to prepare bridge via fc-netctl: ${bridge.stderr.trim() || bridge.stdout.trim()}`,
    );
  }

  let natReady = await ensureFirecrackerGuestNat(deps);

  let staleVmmsStopped = true;
  if (deps.stopStaleVmms) {
    try {
      await deps.stopStaleVmms();
    } catch (err) {
      // Fail closed: deleting taps / rewriting disks while a VMM still holds
      // them open risks filesystem corruption.
      staleVmmsStopped = false;
      natReady = false;
      logger.warn(
        `[firecracker] failed to stop stale VMMs — refusing Firecracker readiness: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const listed = await deps.run([helper, 'list-taps']);
  if (!listed.ok) {
    logger.warn(`[firecracker] could not list session taps: ${listed.stderr.trim()}`);
    return { bridgeReady, natReady, deletedTaps: [] };
  }

  const deletedTaps: string[] = [];
  // Only reclaim taps when stale VMMs are confirmed gone (or no stop hook).
  if (staleVmmsStopped) {
    for (const tap of listed.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((n) => /^ahfct\d+$/.test(n))) {
      const res = await deps.run([helper, 'tap-delete', tap]);
      if (res.ok) deletedTaps.push(tap);
      else logger.warn(`[firecracker] failed to delete stale tap ${tap}: ${res.stderr.trim()}`);
    }
  }
  return { bridgeReady, natReady, deletedTaps };
}
