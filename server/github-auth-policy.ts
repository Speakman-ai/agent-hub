/**
 * Shared copy for GitHub credential policy.
 *
 * GitHub access is strictly per-user: every human-facing route and spawn
 * uses the acting user's own connection (OAuth or PAT from Settings →
 * GitHub).
 */

export const CONNECT_GITHUB_HINT =
  'Connect your GitHub account in Settings → GitHub (Sign in with GitHub or paste a personal access token).';
