/**
 * Boot wiring for the Firecracker desktop backend. Runs alongside the
 * session microVM backend registration and shares its slot pool, so desktop
 * computers and session VMs never collide on a slot.
 */
import {
  FirecrackerSessionEnv,
  type FirecrackerSessionEnvDeps,
  type FirecrackerPaths,
} from '../session-env/firecracker/firecracker-session-env.js';
import { InMemorySlotPool } from '../session-env/firecracker/firecracker-slots.js';
import {
  createDesktopComputersStore,
  type DesktopComputersStore,
} from './desktop-computers-store.js';
import { FirecrackerDesktopRuntime } from './firecracker-desktop-runtime.js';
import { registerDesktopRuntime } from './desktop-runtime-registry.js';

export type FirecrackerDesktopVmDefaults = Omit<
  FirecrackerSessionEnvDeps,
  'sessionId' | 'worktreePath' | 'slots' | 'paths' | 'vmId' | 'bootArgsExtra'
> & { paths: FirecrackerPaths };

export class DesktopSlotReservationError extends Error {
  constructor(cause: unknown) {
    super(
      `Could not load the network slots held by desktop computers ` +
        `(${cause instanceof Error ? cause.message : String(cause)}); ` +
        `refusing to start the Firecracker backend so sessions cannot take them`,
    );
    this.name = 'DesktopSlotReservationError';
  }
}

/**
 * The host-wide slot pool with every slot a desktop computer holds already
 * reserved. Built before any session allocates, which is what lets a
 * computer keep its slot across Hub restarts.
 *
 * Throws when the reservations cannot be read. An empty pool here would let
 * a session take a slot a stopped computer still owns, and the computer would
 * later resume on that same slot (it never asks the pool), duplicating the
 * guest IP, tap and vsock CID.
 */
export function createFirecrackerSlotPool(store: DesktopComputersStore): InMemorySlotPool {
  let reserved: number[];
  try {
    reserved = store.listSlots('firecracker');
  } catch (err) {
    throw new DesktopSlotReservationError(err);
  }
  return new InMemorySlotPool({ reserved });
}

/**
 * Desktop computers boot the desktop rootfs (display, window manager, VNC).
 * Without one configured they fall back to the session rootfs, which boots
 * but has no display, so screenshot and input fail with the guest's error.
 */
export function desktopVmPaths(paths: FirecrackerPaths): FirecrackerPaths {
  return paths.desktopRootfsPath ? { ...paths, baseRootfsPath: paths.desktopRootfsPath } : paths;
}

export function createFirecrackerDesktopRuntime(opts: {
  store: DesktopComputersStore;
  slots: InMemorySlotPool;
  vmDefaults: FirecrackerDesktopVmDefaults;
  now?: () => number;
}): FirecrackerDesktopRuntime {
  const paths = desktopVmPaths(opts.vmDefaults.paths);
  return new FirecrackerDesktopRuntime({
    store: opts.store,
    slots: opts.slots,
    now: opts.now,
    createVm: (spec) =>
      new FirecrackerSessionEnv({
        ...opts.vmDefaults,
        paths,
        sessionId: spec.vmId,
        vmId: spec.vmId,
        worktreePath: null,
        slots: spec.slots,
        bootArgsExtra: spec.bootArgsExtra,
      }),
  });
}

/**
 * Build the shared slot pool, register the desktop runtime, and start its
 * idle sweeper. Returns the pool for the session backend and a function that
 * stops the sweeper. Throws {@link DesktopSlotReservationError} when the
 * persisted slots cannot be read; the caller must then not register the
 * session backend either.
 */
export function registerFirecrackerDesktopRuntime(vmDefaults: FirecrackerDesktopVmDefaults): {
  slots: InMemorySlotPool;
  runtime: FirecrackerDesktopRuntime;
  stopSweeper: () => void;
} {
  const store = createDesktopComputersStore();
  const slots = createFirecrackerSlotPool(store);
  const runtime = createFirecrackerDesktopRuntime({ store, slots, vmDefaults });
  registerDesktopRuntime(runtime);
  return { slots, runtime, stopSweeper: runtime.startIdleSweeper() };
}
