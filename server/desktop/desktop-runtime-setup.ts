/**
 * Process-wide DesktopRuntime. Built lazily on first use from the selection
 * rules in desktop-runtime-selection.ts, so a Hub that never runs a desktop
 * never starts the idle sweep.
 *
 * Env:
 *   - AGENT_HUB_DESKTOP_MAX_RUNNING: Hub-wide cap on running desktops (default 4).
 *   - AGENT_HUB_DESKTOP_IMAGE / _MEMORY / _CPUS: see desktop-container-args.ts.
 *   - AGENT_HUB_DESKTOP_HOME_BUCKET / _HOME_DIR: fleet home snapshots, see
 *     desktop-home-store.ts.
 */
import path from 'path';
import config from '../config.js';
import { createHomeSpools, type HomeSpools } from './desktop-home-spool.js';
import { getActiveOrgId } from '../orgs.js';
import { isFirecrackerBackendRegistered } from '../session-env/firecracker/firecracker-backend-status.js';
import {
  DesktopRuntimeUnavailableError,
  describeDesktopRuntimeSelection,
  selectDesktopRuntime,
  type DesktopContainerPlacement,
} from './desktop-runtime-selection.js';
import { createHubDockerDesktopHost, type DesktopContainerHost } from './container-desktop-host.js';
import { createFleetDesktopHost, sweepDesktopHomeObjects } from './fleet-desktop-host.js';
import {
  createContainerDesktopRuntime,
  DEFAULT_DESKTOP_MAX_RUNNING,
  type ContainerDesktopRuntime,
} from './container-desktop-runtime.js';
import { resolveDesktopHomeStore, type DesktopHomeStore } from './desktop-home-store.js';
import { hasDesktopContainers, hasTrackedDesktopHomeObjects } from './desktop-containers-store.js';
import { registerDesktopRuntime, unregisterDesktopRuntime } from './desktop-runtime-registry.js';

let homeStore: Promise<DesktopHomeStore> | null = null;
let runtime: ContainerDesktopRuntime | null = null;

let spools: HomeSpools | null = null;

/** Hub-side home transfer spools, under `<dataDir>/desktop-home-spool`. */
export function getDesktopHomeSpools(): HomeSpools {
  spools ??= createHomeSpools(path.join(config.dataDir, 'desktop-home-spool'));
  return spools;
}

export function getDesktopHomeStore(): Promise<DesktopHomeStore> {
  homeStore ??= resolveDesktopHomeStore(process.env, config.dataDir);
  return homeStore;
}

export function resolveDesktopMaxRunning(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.AGENT_HUB_DESKTOP_MAX_RUNNING?.trim() ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DESKTOP_MAX_RUNNING;
}

export function createDesktopContainerHost(
  placement: DesktopContainerPlacement,
): DesktopContainerHost {
  if (placement === 'hub-docker') return createHubDockerDesktopHost();
  return createFleetDesktopHost({
    homeStore: getDesktopHomeStore,
    orgId: () => {
      try {
        return getActiveOrgId();
      } catch {
        return '';
      }
    },
  });
}

/**
 * The container runtime, built and registered with the desktop runtime
 * registry on first use. Throws DesktopRuntimeUnavailableError when the
 * configured backend is firecracker and unavailable (fail closed).
 */
export function getContainerDesktopRuntime(
  placement?: DesktopContainerPlacement,
): ContainerDesktopRuntime {
  if (runtime) return runtime;
  const resolved =
    placement ??
    selectDesktopRuntime({
      configured: config.desktopRuntime,
      firecrackerRegistered: isFirecrackerBackendRegistered(),
      finalizeRunnerBackend: process.env.FINALIZE_RUNNER_BACKEND,
    }).containerPlacement;
  if (!resolved) {
    throw new DesktopRuntimeUnavailableError(
      'Desktops on this host run in Firecracker microVMs, not containers.',
    );
  }
  const hosts = new Map<DesktopContainerPlacement, DesktopContainerHost>();
  const hostFor = (p: DesktopContainerPlacement) => {
    let h = hosts.get(p);
    if (!h) hosts.set(p, (h = createDesktopContainerHost(p)));
    return h;
  };
  runtime = createContainerDesktopRuntime({
    host: hostFor(resolved),
    // Computers recorded on the other placement before a switch are stopped
    // and deleted through that placement's own host.
    hostFor,
    maxRunning: resolveDesktopMaxRunning(),
  });
  registerDesktopRuntime(runtime);
  return runtime;
}

function placementForThisHost(): DesktopContainerPlacement {
  return describeDesktopRuntimeSelection({
    configured: 'container',
    firecrackerRegistered: false,
    finalizeRunnerBackend: process.env.FINALIZE_RUNNER_BACKEND,
  }).containerPlacement!;
}

/**
 * Boot wiring. Registers the container runtime when containers are the
 * selected backend, and also whenever container desktops already exist, so
 * a profile delete can still remove their homes after the host switched to
 * Firecracker. Then re-attaches desktops left running by the previous
 * process, so idle stop still applies to them.
 */
export async function registerContainerDesktopRuntimeOnBoot(): Promise<void> {
  try {
    const selection = describeDesktopRuntimeSelection({
      configured: config.desktopRuntime,
      firecrackerRegistered: isFirecrackerBackendRegistered(),
      finalizeRunnerBackend: process.env.FINALIZE_RUNNER_BACKEND,
    });
    const placement =
      selection.kind === 'container' && selection.containerPlacement
        ? selection.containerPlacement
        : hasDesktopContainers()
          ? placementForThisHost()
          : null;
    if (!placement) return;
    await getContainerDesktopRuntime(placement).adopt();
  } catch (err) {
    console.warn(
      `[desktop] container runtime not registered: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

let janitor: ReturnType<typeof setInterval> | null = null;

/**
 * Retry deleting desktop home objects that must go (stale uploads, replaced
 * snapshots, writes the Hub abandoned). Hub-wide and placement-independent:
 * those objects outlive the computer records and placement switches. Does
 * nothing until something is tracked.
 */
export function startDesktopHomeJanitor(everyMs = 5 * 60_000): void {
  if (janitor) return;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      // Transfer spools left by a failed removal or a restart (cheap readdir).
      const spoolsLeft = await getDesktopHomeSpools().sweep();
      if (spoolsLeft)
        console.warn(`[desktop] ${spoolsLeft} home transfer spool(s) still pending deletion`);
      if (!hasTrackedDesktopHomeObjects()) return;
      const pending = await sweepDesktopHomeObjects(await getDesktopHomeStore());
      if (pending) console.warn(`[desktop] ${pending} home object(s) still pending deletion`);
    } catch (err) {
      console.warn(
        `[desktop] home object sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      running = false;
    }
  };
  janitor = setInterval(() => void run(), everyMs);
  (janitor as { unref?: () => void }).unref?.();
  void run();
}

export function __resetDesktopRuntimeForTests(): void {
  if (janitor) clearInterval(janitor);
  janitor = null;
  spools = null;
  if (runtime) unregisterDesktopRuntime('container');
  runtime?.dispose();
  runtime = null;
  homeStore = null;
}
