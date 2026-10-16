/**
 * In-flight agent ops per desktop computer. The `computer` tool brackets each
 * op with {@link beginDesktopAgentOp}; the Agent browser pane reads the count
 * to refuse human input while the agent is acting (single-writer, same rule
 * as the browser surfaces) and to follow the desktop when the agent uses it.
 */
import type { DesktopComputerKey } from './desktop-runtime.js';

export type DesktopAgentActivityEvent = { type: 'entered' | 'ended'; key: DesktopComputerKey };

const inFlight = new Map<string, number>();
const listeners = new Set<(ev: DesktopAgentActivityEvent) => void>();

export function desktopComputerKeyString(key: DesktopComputerKey): string {
  return `${key.userId}\u0000${key.agentId}\u0000${key.projectId}`;
}

function emit(ev: DesktopAgentActivityEvent): void {
  for (const l of Array.from(listeners)) {
    try {
      l(ev);
    } catch {
      /* a broken listener must not break the op */
    }
  }
}

/** Mark an agent op as started. Returns an idempotent end function. */
export function beginDesktopAgentOp(key: DesktopComputerKey): () => void {
  const id = desktopComputerKeyString(key);
  const snapshot = { ...key };
  inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
  emit({ type: 'entered', key: snapshot });
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const n = (inFlight.get(id) ?? 1) - 1;
    if (n <= 0) inFlight.delete(id);
    else inFlight.set(id, n);
    emit({ type: 'ended', key: snapshot });
  };
}

export function desktopAgentOpsInFlight(key: DesktopComputerKey): number {
  return inFlight.get(desktopComputerKeyString(key)) ?? 0;
}

export function subscribeDesktopAgentActivity(
  listener: (ev: DesktopAgentActivityEvent) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only. */
export function __resetDesktopAgentActivityForTests(): void {
  inFlight.clear();
  listeners.clear();
}
