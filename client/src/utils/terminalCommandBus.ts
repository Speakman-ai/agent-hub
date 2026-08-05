/**
 * Hand-off channel from the chat transcript (markdown code fences, Bash tool
 * cards) to the mounted `SessionTerminalPane` for one session.
 *
 * The pane is a sibling subtree of the message list, is lazily imported, and
 * only accepts input once its WebSocket has attached — so a command sent the
 * instant the user clicks usually has nobody listening yet. Commands sent
 * while unsubscribed are held and replayed to the first subscriber.
 *
 * The hold buffer is deliberately tiny: replaying a long backlog would paste a
 * pile of commands the user has since forgotten about into a shell they share
 * with the agent.
 */

export type TerminalCommandListener = (command: string) => void;

/** Most-recent held commands kept per session while no pane is listening. */
export const MAX_HELD_TERMINAL_COMMANDS = 4;

const listeners = new Map<string, Set<TerminalCommandListener>>();
const held = new Map<string, string[]>();

/**
 * Deliver `command` to this session's terminal pane. Returns true when a pane
 * was listening and took it, false when it was held for the next subscriber.
 */
export function sendCommandToTerminal(sessionId: string, command: string): boolean {
  if (!sessionId || !command) return false;
  const subscribers = listeners.get(sessionId);
  if (subscribers && subscribers.size > 0) {
    // Copy first: a listener may unsubscribe while we iterate.
    for (const listener of [...subscribers]) listener(command);
    return true;
  }
  const queue = held.get(sessionId) ?? [];
  queue.push(command);
  while (queue.length > MAX_HELD_TERMINAL_COMMANDS) queue.shift();
  held.set(sessionId, queue);
  return false;
}

/**
 * Listen for commands aimed at this session's terminal. Anything held since
 * the last subscriber is flushed synchronously on subscribe.
 */
export function subscribeToTerminalCommands(
  sessionId: string,
  listener: TerminalCommandListener,
): () => void {
  const subscribers = listeners.get(sessionId) ?? new Set<TerminalCommandListener>();
  subscribers.add(listener);
  listeners.set(sessionId, subscribers);

  const queued = held.get(sessionId);
  if (queued && queued.length > 0) {
    held.delete(sessionId);
    for (const command of queued) listener(command);
  }

  return () => {
    const current = listeners.get(sessionId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(sessionId);
  };
}

/** Drop every listener and held command. Test-only reset. */
export function resetTerminalCommandBus(): void {
  listeners.clear();
  held.clear();
}
