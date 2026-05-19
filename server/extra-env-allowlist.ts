/**
 * Canonical allowlist + merge for `ChatMessage.extraEnv` into the CLI spawn
 * environment. Used by `handleChat` in `chat.ts`; tests import this module so
 * they exercise the production merge, not a duplicated loop.
 *
 * See `ChatMessage.extraEnv` in `server/types.ts`.
 */

export const EXTRA_ENV_ALLOWLIST = new Set<string>(['DEV_HUB_API_KEY', 'GH_REPO']);

/**
 * Merges allowlisted keys from `extraEnv` into `spawnEnv` in place.
 * Non-allowlisted keys are dropped. Keys already present in `spawnEnv` are
 * never overwritten (server-resolved credentials win).
 */
export function mergeAllowlistedExtraEnv(
  spawnEnv: NodeJS.ProcessEnv,
  extraEnv: Record<string, string> | undefined,
): void {
  if (!extraEnv) return;
  for (const [key, val] of Object.entries(extraEnv)) {
    if (EXTRA_ENV_ALLOWLIST.has(key) && !(key in spawnEnv)) {
      spawnEnv[key] = val;
    }
  }
}
