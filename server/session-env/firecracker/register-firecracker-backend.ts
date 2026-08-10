/**
 * Registers the microVM backend with the SessionEnv registry.
 *
 * Unlike the host and container adapters, this one is registered
 * *conditionally* — only after the capability probe confirms the host can
 * boot a VM and the boot sweep has prepared the bridge. That makes
 * `registeredBackends.has('firecracker')` mean "a VM would actually start
 * here", so `auto` can prefer it without a second availability check, and an
 * explicit `sessionEnvAdapter: firecracker` on an incapable host fails loudly
 * at boot instead of on a user's first preview.
 *
 * The per-session caller only knows a session id and a worktree; the slot
 * pool and the staged guest artifacts are host-wide, so they are bound here.
 */

import { registerSessionEnvBackend, unregisterSessionEnvBackend } from '../select-session-env.js';
import {
  FirecrackerSessionEnv,
  type FirecrackerSessionEnvDeps,
  type FirecrackerPaths,
  type FirecrackerSlotPool,
} from './firecracker-session-env.js';
import {
  createFirecrackerHostIo,
  createSpawnVmm,
  createStopVmm,
  type FirecrackerExecConfig,
} from './firecracker-privileged-exec.js';
import { InMemorySlotPool } from './firecracker-slots.js';

/**
 * Where the host keeps guest artifacts and per-VM scratch. Defaults match
 * `ops/scripts/setup-firecracker-host.sh`; the env overrides exist so a
 * developer can stage artifacts somewhere else without editing the setup
 * script and drifting from what the host actually has.
 */
export function firecrackerHostPaths(env: NodeJS.ProcessEnv = process.env): FirecrackerPaths {
  const artifactDir = env.AGENT_HUB_FIRECRACKER_DIR ?? '/var/lib/agent-hub/firecracker';
  return {
    kernelPath: env.AGENT_HUB_FIRECRACKER_KERNEL ?? `${artifactDir}/vmlinux`,
    baseRootfsPath: env.AGENT_HUB_FIRECRACKER_ROOTFS ?? `${artifactDir}/rootfs.ext4`,
    // Root-owned disk scratch — prepare-disks constructs paths under here.
    runDir: env.AGENT_HUB_FIRECRACKER_RUN_DIR ?? `${artifactDir}/vms`,
    // Hub-writable control plane for config/pid/sockets. Lives under the
    // shared Firecracker data mount (not /run) so a containerized Hub and
    // the privileged helper see the same files without an extra bind.
    controlDir: env.AGENT_HUB_FIRECRACKER_CONTROL_DIR ?? `${artifactDir}/control`,
    jailerChrootBase: env.AGENT_HUB_FIRECRACKER_JAILER_DIR ?? `${artifactDir}/jailer`,
    diskHelper:
      env.AGENT_HUB_FIRECRACKER_DISK_HELPER ?? '/usr/local/lib/agent-hub/fc-prepare-disks.sh',
  };
}

export type FirecrackerBackendDefaults = Omit<
  FirecrackerSessionEnvDeps,
  'sessionId' | 'worktreePath' | 'slots' | 'paths'
> & {
  paths: FirecrackerPaths;
  /** Defaults to a fresh in-memory pool covering the whole slot range. */
  slots?: FirecrackerSlotPool;
};

export function registerFirecrackerBackend(defaults: FirecrackerBackendDefaults): void {
  const slots = defaults.slots ?? new InMemorySlotPool();
  registerSessionEnvBackend(
    'firecracker',
    (opts) =>
      new FirecrackerSessionEnv({
        ...defaults,
        slots,
        sessionId: opts.sessionId,
        worktreePath: opts.worktreePath,
        ...(opts.firecrackerDeps as Partial<FirecrackerSessionEnvDeps> | undefined),
      }),
  );
}

/**
 * Bind the three privileged seams to one exec mode.
 *
 * They travel together on purpose: creating a tap locally and then launching
 * the VMM in a container would put the interface in a namespace the VM cannot
 * reach, and the failure surfaces as a guest with no network rather than as
 * anything that points at the mismatch.
 */
/**
 * Whether the VMM should run under the jailer.
 *
 * Defaults **on** for both local and docker exec once jail resources are
 * staged into the chroot (see `firecracker-jailer-stage.ts`). Firecracker
 * production guidance requires the jailer or equally restrictive constraints;
 * docker mode without the jailer leaves a UID-0 VMM with host networking and
 * writable mounts. Override with `AGENT_HUB_FIRECRACKER_USE_JAILER=0|1` only
 * for break-glass debugging — not a supported production posture.
 */
export function resolveFirecrackerUseJailer(
  _cfg: FirecrackerExecConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.AGENT_HUB_FIRECRACKER_USE_JAILER?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  if (raw === '1' || raw === 'true' || raw === 'on') return true;
  return true;
}

export function firecrackerExecDefaults(
  cfg: FirecrackerExecConfig,
): Pick<FirecrackerSessionEnvDeps, 'io' | 'spawnVmm' | 'stopVmm' | 'useJailer'> {
  return {
    io: createFirecrackerHostIo(cfg),
    spawnVmm: createSpawnVmm(cfg),
    stopVmm: createStopVmm(cfg),
    useJailer: resolveFirecrackerUseJailer(cfg),
  };
}

/** Test-only: drop the backend so `auto` stops considering it. */
export function unregisterFirecrackerBackend(): void {
  unregisterSessionEnvBackend('firecracker');
}
