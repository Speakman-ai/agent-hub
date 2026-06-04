/**
 * Shared copy + helpers for GitHub credential policy.
 *
 * GitHub access is strictly per-user: every human-facing route and spawn
 * uses the acting user's own connection (OAuth or PAT from Settings →
 * GitHub). The reviewer GitHub App has been removed — there is no
 * installation-token fallback.
 *
 * `botGithubToken` / manual PAT-in-config is deprecated and ignored.
 */

import type { AppConfig } from './types.js';

export const CONNECT_GITHUB_HINT =
  'Connect your GitHub account in Settings → GitHub (Sign in with GitHub or paste a personal access token).';

let botTokenWarned = false;

/** Log once if legacy botGithubToken is still present in config (ignored at runtime). */
export function warnIfLegacyBotGithubToken(config: AppConfig): void {
  if (botTokenWarned || !config.botGithubToken) return;
  botTokenWarned = true;
  console.warn(
    '[config] botGithubToken / AGENT_HUB_BOT_GITHUB_TOKEN is deprecated and ignored. ' +
      'Use Settings → GitHub to connect your account.',
  );
}
