import { describe, it, expect, vi } from 'vitest';
import { runSessionEnvBootSweep } from './session-env-boot-sweep.js';
import type { ReconcileFirecrackerHostResult } from './firecracker/firecracker-slots.js';

const silentLogger = { log: () => {}, error: () => {} };

function fcResult(
  over: Partial<ReconcileFirecrackerHostResult> = {},
): ReconcileFirecrackerHostResult {
  return { bridgeReady: true, natReady: true, deletedTaps: [], ...over };
}

function makeDeps(
  over: {
    adapter?: 'host' | 'sysbox' | 'container' | 'firecracker';
    firecrackerRegistered?: boolean;
    firecrackerResult?: ReconcileFirecrackerHostResult;
  } = {},
) {
  const reconcileSysbox = vi.fn().mockResolvedValue(undefined);
  const reconcileFirecracker = vi.fn().mockResolvedValue(over.firecrackerResult ?? fcResult());
  const unregisterFirecracker = vi.fn();
  return {
    reconcileSysbox,
    reconcileFirecracker,
    unregisterFirecracker,
    deps: {
      adapter: over.adapter ?? 'host',
      firecrackerRegistered: () => over.firecrackerRegistered ?? false,
      reconcileSysbox,
      reconcileFirecracker,
      unregisterFirecracker,
      logger: silentLogger,
    },
  };
}

describe('runSessionEnvBootSweep', () => {
  it('runs the firecracker sweep when the backend is registered even though the selected adapter is host', async () => {
    // Regression guard: prod runs sessionEnvAdapter=host with firecracker still
    // registered for opt-in VM. The sweep must NOT be tied to selection.adapter,
    // or ahfc0/guest NAT is never prepared and the first VM session fails on
    // tap-create. This test fails if anyone re-gates on `adapter === 'firecracker'`.
    const { deps, reconcileFirecracker, reconcileSysbox, unregisterFirecracker } = makeDeps({
      adapter: 'host',
      firecrackerRegistered: true,
    });

    await runSessionEnvBootSweep(deps);

    expect(reconcileFirecracker).toHaveBeenCalledTimes(1);
    expect(reconcileSysbox).not.toHaveBeenCalled();
    expect(unregisterFirecracker).not.toHaveBeenCalled();
  });

  it('unregisters the firecracker backend when guest NAT is not ready (adapter=host)', async () => {
    const { deps, reconcileFirecracker, unregisterFirecracker } = makeDeps({
      adapter: 'host',
      firecrackerRegistered: true,
      firecrackerResult: fcResult({ natReady: false, bridgeReady: true }),
    });

    await runSessionEnvBootSweep(deps);

    expect(reconcileFirecracker).toHaveBeenCalledTimes(1);
    expect(unregisterFirecracker).toHaveBeenCalledTimes(1);
  });

  it('unregisters the firecracker backend when the bridge is not ready (adapter=host)', async () => {
    const { deps, reconcileFirecracker, unregisterFirecracker } = makeDeps({
      adapter: 'host',
      firecrackerRegistered: true,
      firecrackerResult: fcResult({ natReady: true, bridgeReady: false }),
    });

    await runSessionEnvBootSweep(deps);

    expect(reconcileFirecracker).toHaveBeenCalledTimes(1);
    expect(unregisterFirecracker).toHaveBeenCalledTimes(1);
  });

  it('keeps the firecracker backend registered when both bridge and NAT are ready', async () => {
    const { deps, unregisterFirecracker } = makeDeps({
      adapter: 'host',
      firecrackerRegistered: true,
      firecrackerResult: fcResult({ natReady: true, bridgeReady: true }),
    });

    await runSessionEnvBootSweep(deps);

    expect(unregisterFirecracker).not.toHaveBeenCalled();
  });

  it('skips the firecracker sweep entirely when the backend is not registered', async () => {
    const { deps, reconcileFirecracker, unregisterFirecracker } = makeDeps({
      adapter: 'host',
      firecrackerRegistered: false,
    });

    await runSessionEnvBootSweep(deps);

    expect(reconcileFirecracker).not.toHaveBeenCalled();
    expect(unregisterFirecracker).not.toHaveBeenCalled();
  });

  it('runs the sysbox sweep for a container adapter and the firecracker sweep in parallel when both apply', async () => {
    const { deps, reconcileSysbox, reconcileFirecracker } = makeDeps({
      adapter: 'sysbox',
      firecrackerRegistered: true,
    });

    await runSessionEnvBootSweep(deps);

    expect(reconcileSysbox).toHaveBeenCalledTimes(1);
    expect(reconcileFirecracker).toHaveBeenCalledTimes(1);
  });

  it('does not run the sysbox sweep for a host adapter', async () => {
    const { deps, reconcileSysbox } = makeDeps({ adapter: 'host', firecrackerRegistered: false });

    await runSessionEnvBootSweep(deps);

    expect(reconcileSysbox).not.toHaveBeenCalled();
  });

  it('resolves (does not reject) when a sweep fails, so the caller still opens the boot gate', async () => {
    const { deps, reconcileSysbox } = makeDeps({ adapter: 'sysbox', firecrackerRegistered: true });
    reconcileSysbox.mockRejectedValue(new Error('sysbox reconcile blew up'));

    await expect(runSessionEnvBootSweep(deps)).resolves.toBeUndefined();
  });

  it('waits for the firecracker sweep to settle before returning even when the sysbox sweep rejects first', async () => {
    // The caller opens the session boot gate the moment this resolves. A
    // `Promise.all` would reject on the immediate sysbox failure and open the
    // gate while firecracker is still preparing networking. `allSettled` must
    // hold until firecracker finishes.
    let resolveFirecracker!: (r: ReconcileFirecrackerHostResult) => void;
    const firecrackerPending = new Promise<ReconcileFirecrackerHostResult>((res) => {
      resolveFirecracker = res;
    });
    const reconcileSysbox = vi.fn().mockRejectedValue(new Error('sysbox reconcile blew up'));
    const reconcileFirecracker = vi.fn().mockReturnValue(firecrackerPending);
    const deps = {
      adapter: 'sysbox' as const,
      firecrackerRegistered: () => true,
      reconcileSysbox,
      reconcileFirecracker,
      unregisterFirecracker: vi.fn(),
      logger: silentLogger,
    };

    let settled = false;
    const sweep = runSessionEnvBootSweep(deps).then(() => {
      settled = true;
    });

    // Flush microtasks: the sysbox rejection has propagated, but firecracker
    // is still pending, so the sweep must not have resolved yet.
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);

    resolveFirecracker(fcResult());
    await sweep;
    expect(settled).toBe(true);
  });
});
