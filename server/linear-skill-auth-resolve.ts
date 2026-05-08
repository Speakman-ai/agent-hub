/**
 * linear-skill-auth-resolve.ts
 *
 * Thin helper that resolves the LINEAR_API_KEY for the linear default skill.
 *
 * Resolution order:
 *  1. `env.LINEAR_API_KEY` — Agent Hub injects this at spawn time when the
 *     user has stored the key in the per-user credential store
 *     (Settings → Skills → Credentials → Linear).
 *  2. Absent — returns `undefined`. The shell script layer handles the user-
 *     facing error message.
 *
 * The helper intentionally does NOT log, throw, or print the key. Callers
 * that need a runtime assertion should check for `undefined` and surface an
 * appropriate error through their own error channel.
 */

export interface LinearAuthContext {
  /** The resolved API key, or undefined if not configured. */
  apiKey: string | undefined;
  /** True when the key was sourced from the injected environment. */
  fromEnv: boolean;
}

/**
 * Resolves the Linear API key from the given environment map.
 *
 * @param env - environment to inspect (defaults to `process.env`)
 * @returns auth context object; `apiKey` is `undefined` when the key is absent.
 */
export function resolveLinearApiKey(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): LinearAuthContext {
  const apiKey = env['LINEAR_API_KEY']?.trim();
  return {
    apiKey: apiKey !== '' ? apiKey : undefined,
    fromEnv: apiKey !== undefined && apiKey !== '',
  };
}

/**
 * Returns true when a valid Linear API key is available in the environment.
 *
 * Convenience wrapper used by callers that only need a boolean gate.
 */
export function hasLinearApiKey(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): boolean {
  return resolveLinearApiKey(env).fromEnv;
}
