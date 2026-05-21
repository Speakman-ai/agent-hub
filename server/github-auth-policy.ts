/**
 * Shared copy + helpers for GitHub credential policy.
 *
 * Human-facing routes use the per-user connection only (OAuth or PAT from
 * Settings → GitHub). The reviewer GitHub App installation token is used
 * only on explicit reviewer/system paths — never as a silent fallback when
 * a user's token is missing or rejected.
 *
 * `botGithubToken` / manual PAT-in-config is deprecated and ignored.
 */

import type { AppConfig, GitHubAppConfig } from './types.js';
import { getInstallationToken, resolveInstallationId } from './github-app.js';

export const CONNECT_GITHUB_HINT =
  'Connect your GitHub account in Settings → GitHub (Sign in with GitHub or paste a personal access token).';

export const REVIEWER_APP_HINT =
  'Install the Agent Hub Reviewer GitHub App on this org (Settings → GitHub → GitHub App).';

export function hasReviewerGitHubApp(config: AppConfig): boolean {
  const app = config.githubApp;
  if (!(app?.appId && app?.privateKey)) return false;
  return !!(app.installationId || (app.installations && app.installations.length > 0));
}

/** Mint a short-lived installation token for reviewer/system GitHub API calls. */
export async function mintReviewerInstallationToken(
  config: AppConfig,
  owner: string,
): Promise<string | null> {
  const app = config.githubApp as GitHubAppConfig | null | undefined;
  if (!app?.appId || !app.privateKey) return null;
  const instId = resolveInstallationId(app, owner);
  if (!instId) return null;
  try {
    return await getInstallationToken(app.appId, app.privateKey, instId);
  } catch {
    return null;
  }
}

let botTokenWarned = false;

/** Log once if legacy botGithubToken is still present in config (ignored at runtime). */
export function warnIfLegacyBotGithubToken(config: AppConfig): void {
  if (botTokenWarned || !config.botGithubToken) return;
  botTokenWarned = true;
  console.warn(
    '[config] botGithubToken / AGENT_HUB_BOT_GITHUB_TOKEN is deprecated and ignored. ' +
      'Use Settings → GitHub for your account and the Reviewer GitHub App for bot identity.',
  );
}
