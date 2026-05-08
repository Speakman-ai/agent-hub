/**
 * github-skill-auth-resolve.ts
 *
 * Thin helper that resolves the GitHub token for the github default skill.
 *
 * Resolution order (mirrors scripts/_common.sh):
 *  1. `env.GH_TOKEN`       — Agent Hub injects this at spawn time when the user
 *                            has stored a token in the per-user credential store
 *                            (Settings → Skills → Credentials → GitHub).
 *  2. `env.GITHUB_TOKEN`   — GitHub Actions built-in, or host `export GITHUB_TOKEN=…`.
 *  3. Absent               — returns `undefined`. The shell script layer handles
 *                            the user-facing error message and falls back to
 *                            `gh auth status`.
 *
 * The helper intentionally does NOT log, throw, or print the token. Callers
 * that need a runtime assertion should check `hasGitHubToken()` and surface an
 * appropriate error through their own channel.
 */

export interface GitHubAuthContext {
  /** The resolved token, or undefined if not configured. */
  token: string | undefined;
  /** Which env var the token was sourced from. */
  source: 'GH_TOKEN' | 'GITHUB_TOKEN' | undefined;
}

/**
 * Resolves the GitHub token from the given environment map.
 *
 * @param env - environment to inspect (defaults to `process.env`)
 * @returns auth context; `token` is `undefined` when no token is found.
 */
export function resolveGitHubToken(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): GitHubAuthContext {
  // Priority 1: GH_TOKEN (Agent Hub per-user credential store)
  const ghToken = env['GH_TOKEN']?.trim();
  if (ghToken) {
    return { token: ghToken, source: 'GH_TOKEN' };
  }

  // Priority 2: GITHUB_TOKEN (GitHub Actions / host export)
  const githubToken = env['GITHUB_TOKEN']?.trim();
  if (githubToken) {
    return { token: githubToken, source: 'GITHUB_TOKEN' };
  }

  return { token: undefined, source: undefined };
}

/**
 * Returns true when a GitHub token is available in the environment.
 *
 * Note: this does NOT check `gh auth status` — that check requires a live
 * subprocess call and is handled by `scripts/_common.sh`. This helper is for
 * server-side spawn-time validation only.
 *
 * @param env - environment to inspect (defaults to `process.env`)
 */
export function hasGitHubToken(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): boolean {
  return resolveGitHubToken(env).token !== undefined;
}
