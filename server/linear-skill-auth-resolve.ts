/**
 * linear-skill-auth-resolve.ts
 *
 * Thin helper that resolves and validates the LINEAR_API_KEY for the linear
 * default skill.
 *
 * Resolution order:
 *  1. `env.LINEAR_API_KEY` — Agent Hub injects this at spawn time when the
 *     user has stored the key in the per-user credential store
 *     (Settings → Skills → Credentials → Linear).
 *  2. Absent or whitespace-only → `apiKey: undefined`. The shell script layer
 *     (`_common.sh:require_linear_key`) handles the user-facing error message.
 *
 * The helper intentionally does NOT log, throw, or print the key. It trims
 * whitespace so a pasted key with trailing newlines is still treated as valid.
 *
 * Current in-tree callers
 * -----------------------
 * - `server/linear-skill-auth-resolve.test.ts` (unit tests)
 *
 * Intended future callers
 * -----------------------
 * - Session Health integration — to report "LINEAR_API_KEY configured: yes/no"
 *   without exposing the key value in diagnostics.
 * - Skill status endpoint — to surface configuration state in the Skills UI.
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
  const raw = env['LINEAR_API_KEY'];
  const apiKey = raw !== undefined && raw.trim() !== '' ? raw.trim() : undefined;
  return {
    apiKey,
    fromEnv: apiKey !== undefined,
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
