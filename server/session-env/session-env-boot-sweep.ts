import type { SessionEnvKind } from './session-env.js';
import type { ReconcileFirecrackerHostResult } from './firecracker/firecracker-slots.js';

/**
 * Boot-time GC sweep for session-env backends, extracted from `index.ts` so it
 * can be unit-tested without booting the whole server.
 *
 * Two independent sweeps run in parallel:
 *
 *   - **Container sweep** (`reconcileSysbox`) runs only when the *selected*
 *     adapter is a container backend (`sysbox` / `container`). Session envs
 *     live only in Hub memory, so labeled containers/volumes left by a prior
 *     run are leaks; one sweep covers both container backends.
 *
 *   - **Firecracker sweep** (`reconcileFirecracker`) runs whenever the
 *     Firecracker backend is *registered* — deliberately NOT gated on the
 *     selected adapter. VM mode is opt-in, so the global adapter is usually
 *     `host`; but we must still create `ahfc0` + guest NAT and reclaim stale
 *     taps on boot, or the first opt-in VM session fails on tap-create (no
 *     bridge). If the sweep reports the guest NAT or bridge is not ready, the
 *     Firecracker backend is unregistered so `auto` cannot select a path that
 *     cannot reach the network (an explicit firecracker force still fails loud
 *     at session start when `ensureNat` runs again).
 */
export interface SessionEnvBootSweepDeps {
  /** The resolved global adapter for this boot. */
  adapter: SessionEnvKind;
  /** Whether the Firecracker backend is currently registered. */
  firecrackerRegistered: () => boolean;
  /** Sweep leaked sysbox/container session envs. */
  reconcileSysbox: () => Promise<void>;
  /** Prepare the Firecracker bridge/NAT and reclaim stale taps. */
  reconcileFirecracker: () => Promise<ReconcileFirecrackerHostResult>;
  /** Drop the Firecracker backend when its host networking is not ready. */
  unregisterFirecracker: () => void;
  logger?: Pick<Console, 'log' | 'error'>;
}

export async function runSessionEnvBootSweep(deps: SessionEnvBootSweepDeps): Promise<void> {
  const logger = deps.logger ?? console;
  const jobs: { name: string; run: Promise<void> }[] = [];

  // Boot GC sweep: session envs live only in Hub memory, so every labeled
  // session container/volume from a previous run is a leak. Both container
  // backends label identically, so one sweep covers them.
  if (deps.adapter === 'sysbox' || deps.adapter === 'container') {
    jobs.push({ name: 'sysbox', run: deps.reconcileSysbox() });
  }

  // Isolated / VM mode is opt-in; the global adapter is often `host`. Still
  // prepare ahfc0 + guest NAT whenever Firecracker is registered, or the first
  // VM session fails on tap-create (no bridge). Gating this on the *selected*
  // adapter would regress that opt-in-on-host path.
  if (deps.firecrackerRegistered()) {
    jobs.push({
      name: 'firecracker',
      run: deps.reconcileFirecracker().then((result) => {
        if (result.deletedTaps.length > 0) {
          logger.log(
            `[session-env] swept ${result.deletedTaps.length} stale microVM tap(s): ${result.deletedTaps.join(', ')}`,
          );
        }
        // Without guest NAT, apt/npm/pip die with "Temporary failure
        // resolving …". Drop the backend so `auto` cannot select a path that
        // cannot reach the network; an explicit firecracker force still fails
        // loud at session start when ensureNat runs again.
        if (!result.natReady) {
          logger.error(
            '[session-env] Firecracker guest NAT is not ready — unregistering firecracker backend',
          );
          deps.unregisterFirecracker();
        } else if (!result.bridgeReady) {
          logger.error(
            '[session-env] Firecracker bridge is not ready — unregistering firecracker backend',
          );
          deps.unregisterFirecracker();
        }
      }),
    });
  }

  // Wait for EVERY launched sweep to settle before returning. The caller opens
  // the session boot gate once this resolves, so a `Promise.all` here would be
  // a bug: it rejects the instant one sweep fails, letting the gate open while
  // the other sweep is still preparing guest networking or reclaiming stale
  // taps (a rejected Sysbox sweep must not let a VM session start mid-bridge
  // setup). `allSettled` holds the gate until both are done, and we surface
  // each failure individually rather than losing all but the first.
  const settled = await Promise.allSettled(jobs.map((j) => j.run));
  settled.forEach((outcome, i) => {
    if (outcome.status === 'rejected') {
      const job = jobs[i]!;
      logger.error(
        `[session-env] ${job.name} boot sweep failed: ${
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
        }`,
      );
    }
  });
}
