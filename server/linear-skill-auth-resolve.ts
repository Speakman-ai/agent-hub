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
  /**
   * True when `LINEAR_API_KEY` was present and non-empty in the environment.
   *
   * Note: `fromEnv === true` iff `apiKey !== undefined` — they always agree.
   * The field is kept as a named boolean so callers can write expressive log
   * messages ("key sourced from env") without re-deriving the condition.
   * Diagnostic tooling (e.g. Session Health) may log the source separately
   * from the key itself to distinguish "key set" from "key value".
   */
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
  const apiKey = env['LINEAR_API_KEY'];
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
