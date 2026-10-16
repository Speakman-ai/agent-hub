/**
 * The DesktopRuntime backends this Hub has constructed. A backend registers
 * at boot only when its host prerequisites hold (Firecracker: the session
 * microVM backend is registered).
 */
import type { DesktopComputerKey, DesktopRuntime, DesktopRuntimeKind } from './desktop-runtime.js';
import {
  createDesktopComputersStore,
  type DesktopComputersStore,
} from './desktop-computers-store.js';
import { beginDesktopDeletion } from './desktop-deletion-guard.js';
import { beginDesktopAgentOp } from './desktop-agent-activity.js';

const runtimes = new Map<DesktopRuntimeKind, DesktopRuntime>();
const tracked = new WeakMap<DesktopRuntime, DesktopRuntime>();

/**
 * The runtime with every op that acts on the computer (start, exec,
 * screenshot, input) counted as an agent op for the Agent browser pane, so
 * the pane follows the agent onto the desktop and refuses human input while
 * the agent acts. Read-only calls (status, viewFrame) and stop/destroy are
 * passed through untouched.
 */
function trackAgentOps(runtime: DesktopRuntime): DesktopRuntime {
  const existing = tracked.get(runtime);
  if (existing) return existing;
  const bracket =
    <A extends [DesktopComputerKey, ...unknown[]], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      const end = beginDesktopAgentOp(args[0]);
      try {
        return await fn(...args);
      } finally {
        end();
      }
    };
  const wrapped: DesktopRuntime = {
    kind: runtime.kind,
    ensureStarted: bracket((key) => runtime.ensureStarted(key)),
    exec: bracket((key, command: string, opts?: Parameters<DesktopRuntime['exec']>[2]) =>
      runtime.exec(key, command, opts),
    ),
    screenshot: bracket((key) => runtime.screenshot(key)),
    input: bracket((key, event: Parameters<DesktopRuntime['input']>[1]) =>
      runtime.input(key, event),
    ),
    stop: (key) => runtime.stop(key),
    destroy: (key) => runtime.destroy(key),
    viewFrame: (key) => runtime.viewFrame(key),
    mapDisplayPort: (key) => runtime.mapDisplayPort(key),
    status: (key) => runtime.status(key),
  };
  tracked.set(runtime, wrapped);
  return wrapped;
}

export function registerDesktopRuntime(runtime: DesktopRuntime): void {
  runtimes.set(runtime.kind, runtime);
}

export function unregisterDesktopRuntime(kind: DesktopRuntimeKind): void {
  runtimes.delete(kind);
}

/** The runtime agent-side callers (the `computer` tool, routines) must use; see trackAgentOps. */
export function getDesktopRuntime(kind: DesktopRuntimeKind): DesktopRuntime | null {
  const runtime = runtimes.get(kind);
  return runtime ? trackAgentOps(runtime) : null;
}

/**
 * The untracked runtime, for the live view only: its frames and the human's
 * own input must not count as agent ops (human input would otherwise lock
 * the human out with agent_busy).
 */
export function getDesktopRuntimeForLiveView(kind: DesktopRuntimeKind): DesktopRuntime | null {
  return runtimes.get(kind) ?? null;
}

/**
 * Delete the computer and its storage on every backend. A host can switch
 * backends over time, so the profile may own a computer on each.
 *
 * Persisted rows are checked as well as registered runtimes: a computer whose
 * backend is not registered right now (failed capability probe, host change)
 * still has a disk, so this fails rather than letting the caller delete the
 * profile and lose the only path that cleans it up.
 */
export async function destroyDesktopComputers(
  key: DesktopComputerKey,
  store: DesktopComputersStore = createDesktopComputersStore(),
): Promise<void> {
  const failures: string[] = [];
  const kinds = new Set<DesktopRuntimeKind>(runtimes.keys());
  for (const record of store.listForKey(key)) kinds.add(record.kind);
  for (const kind of kinds) {
    const runtime = runtimes.get(kind);
    if (!runtime) {
      failures.push(
        `${kind}: backend is not available on this host, so its disk cannot be deleted`,
      );
      continue;
    }
    try {
      await runtime.destroy(key);
    } catch (err) {
      failures.push(`${kind}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Failed to delete desktop computer storage (${failures.join('; ')})`);
  }
}

/**
 * Delete the key's desktop computers, then run `deleteProfile`, with starts
 * for the key refused from before the teardown until the profile is gone.
 * `deleteProfile` is skipped when any disk could not be deleted.
 */
export async function deleteDesktopComputersWithProfile(
  key: DesktopComputerKey,
  deleteProfile: () => void,
  store?: DesktopComputersStore,
): Promise<void> {
  const end = beginDesktopDeletion(key);
  try {
    await destroyDesktopComputers(key, store);
    deleteProfile();
  } finally {
    end();
  }
}

/** Test-only. */
export function resetDesktopRuntimesForTests(): void {
  runtimes.clear();
}
