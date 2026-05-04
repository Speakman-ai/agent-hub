/**
 * Tracks the actual TCP port the server bound to after `server.listen()`.
 *
 * When AGENT_HUB_PORT is 0 the OS assigns an ephemeral port; config.port
 * stays 0 so it cannot be used to build AGENT_HUB_URL for spawned agents.
 * index.ts calls setActualPort() inside the listen callback; chat.ts reads
 * getActualPort() when constructing the spawn environment.
 *
 * The module-level variable is intentionally simple: the server is a single
 * process, listen() is called once, and the value never changes after that.
 */

let _actualPort: number | null = null;

/**
 * Store the port the server actually bound to.
 * Called once from index.ts inside the server.listen() callback.
 */
export function setActualPort(port: number): void {
  _actualPort = port;
}

/**
 * Return the port the server is listening on.
 * Falls back to 3051 (the production default) if called before the server
 * has started — this keeps unit tests that stub out the server from breaking.
 */
export function getActualPort(): number {
  return _actualPort ?? 3051;
}
