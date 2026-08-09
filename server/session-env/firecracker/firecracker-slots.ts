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
  // DOCKER-USER is evaluated before Docker's isolation drops; ACCEPT here
  // keeps guest traffic from being collateral damage of docker0 rules.
  const optional: string[][] = [
    ['iptables', '-C', 'DOCKER-USER', '-i', bridge, '-j', 'ACCEPT'],
    ['iptables', '-I', 'DOCKER-USER', '-i', bridge, '-j', 'ACCEPT'],
    [
      'iptables',
      '-C',
      'DOCKER-USER',
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
export async function ensureFirecrackerGuestNat(
  deps: ReconcileFirecrackerHostDeps,
): Promise<boolean> {
  const logger = deps.logger ?? { warn: (msg: string) => console.warn(msg) };
  const route = await deps.run(['ip', '-o', 'route', 'get', '1.1.1.1']);
  const uplink = parseUplinkDev(route.ok ? route.stdout : '');
  if (!uplink) {
    logger.warn(
      '[firecracker] no default uplink — guests will have no outbound network ' +
        `(ip route get 1.1.1.1: ${(route.stderr || route.stdout).trim() || 'empty'})`,
    );
    return false;
  }

  const { required, optional } = buildEnsureGuestNatArgv(uplink);
  const sysctl = await deps.run(required[0]!);
  if (!sysctl.ok) {
    logger.warn(`[firecracker] failed to enable ip_forward: ${sysctl.stderr.trim()}`);
  }

  const requiredOk = await ensureIptablesRulePairs(deps.run, required.slice(1), logger, {
    warnOnFailure: true,
  });
  // Optional DOCKER-USER rules: chain may not exist when Docker is absent.
  await ensureIptablesRulePairs(deps.run, optional, logger, { warnOnFailure: false });
  return requiredOk;
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

  let bridgeReady = true;
  for (const argv of buildEnsureBridgeArgv()) {
    const res = await deps.run(argv);
    // "File exists" / "RTNETLINK answers: File exists" is the normal path on
    // every boot after the first; only a different failure is a problem.
    if (!res.ok && !/exists/i.test(res.stderr)) {
      bridgeReady = false;
      logger.warn(
        `[firecracker] failed to prepare bridge via \`${argv.join(' ')}\`: ${res.stderr.trim()}`,
      );
    }
  }

  const natReady = await ensureFirecrackerGuestNat(deps);

  const listed = await deps.run(['ip', '-o', 'link', 'show']);
  if (!listed.ok) {
    logger.warn(`[firecracker] could not list host interfaces: ${listed.stderr.trim()}`);
    return { bridgeReady, natReady, deletedTaps: [] };
  }

  const deletedTaps: string[] = [];
  for (const tap of parseSessionTapNames(listed.stdout)) {
    const res = await deps.run(['ip', 'link', 'del', tap]);
    if (res.ok) deletedTaps.push(tap);
    else logger.warn(`[firecracker] failed to delete stale tap ${tap}: ${res.stderr.trim()}`);
  }
  return { bridgeReady, natReady, deletedTaps };
}
