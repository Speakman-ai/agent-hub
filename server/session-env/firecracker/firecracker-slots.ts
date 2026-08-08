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
  deletedTaps: string[];
}

/**
 * Boot sweep: make the bridge exist and delete every session tap this host
 * still carries.
 *
 * Leftover taps are not cosmetic. A tap whose VM is gone keeps its name
 * occupied, so the first session after a restart fails to create `ahfct3` and
 * the whole backend looks broken. Deleting them here is what makes a restart
 * a clean slate — the same role `sysbox-reconcile.ts` plays for containers.
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

  const listed = await deps.run(['ip', '-o', 'link', 'show']);
  if (!listed.ok) {
    logger.warn(`[firecracker] could not list host interfaces: ${listed.stderr.trim()}`);
    return { bridgeReady, deletedTaps: [] };
  }

  const deletedTaps: string[] = [];
  for (const tap of parseSessionTapNames(listed.stdout)) {
    const res = await deps.run(['ip', 'link', 'del', tap]);
    if (res.ok) deletedTaps.push(tap);
    else logger.warn(`[firecracker] failed to delete stale tap ${tap}: ${res.stderr.trim()}`);
  }
  return { bridgeReady, deletedTaps };
}
