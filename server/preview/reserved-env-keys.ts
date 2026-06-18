/**
 * Reserved env-var namespace shared across the preview surface.
 *
 * Kept in its own dependency-free module so pure scan code
 * (`preview-readme-scan.ts`) and the DB-backed secrets store
 * (`preview-secrets-store.ts`) can agree on one canonical rule without
 * the scanner having to import the database layer.
 *
 * AGENT_HUB_* is reserved for server-injected spawn config (the spawned
 * CLI relies on these being canonical), NODE_* is the platform runtime's
 * namespace, and PATH / HOME are the two env vars whose modification can
 * break a spawned child outright. These are injected at spawn time, so
 * they must never be accepted as — or suggested as — user-managed preview
 * secrets.
 */
export const RESERVED_KEY_RE = /^(AGENT_HUB_|NODE_|PATH$|HOME$)/;

/** True when `key` falls in the reserved namespace and must not be user-managed. */
export function isReservedEnvKey(key: string): boolean {
  return RESERVED_KEY_RE.test(key);
}
