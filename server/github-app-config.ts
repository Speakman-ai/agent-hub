import type { GitHubAppConfig, GitHubAppInstallation } from './types.js';

/**
 * Resolve the server-global GitHub App config from the on-disk `githubApp`
 * block. This restores a first-class read of the legacy block for the
 * narrow purpose of minting an installation token for the Hub → GitHub
 * mirror push (see server/github-app.ts / server/git-host/mirror.ts).
 *
 * Returns `null` unless BOTH `appId` and `privateKey` are present — those
 * two are the minimum required to sign the App JWT and mint a token. A
 * block that carries only the legacy OAuth `clientId`/`clientSecret`
 * (consumed separately by resolvePersonalOAuthConfig) is therefore NOT a
 * usable App-for-mirroring config and resolves to `null`, so a mirror push
 * transparently falls back to the per-user token chain.
 *
 * `installationId` OR a matching `installations[]` entry is what actually
 * lets a token be minted at push time, but neither is required here: an App
 * configured without any installation simply yields `null` at mint time and
 * falls back — validating that is the mirror path's job, not config load's.
 */
export function resolveGithubAppConfig(
  fileConfig: Record<string, unknown>,
): GitHubAppConfig | null {
  const raw = fileConfig.githubApp as Partial<GitHubAppConfig> | null | undefined;
  if (!raw || typeof raw !== 'object') return null;

  const appId = normalizeIdOrNull(raw.appId);
  const privateKey = nonEmptyStr(raw.privateKey);
  if (!appId || !privateKey) return null;

  const installationId = normalizeIdOrNull(raw.installationId);

  let installations: GitHubAppInstallation[] | undefined;
  if (Array.isArray(raw.installations)) {
    installations = raw.installations
      .map((inst): GitHubAppInstallation | null => {
        const id = normalizeIdOrNull(inst?.id);
        if (id === null) return null;
        const account = nonEmptyStr(inst?.account);
        return account ? { account, id } : { id };
      })
      .filter((inst): inst is GitHubAppInstallation => inst !== null);
    if (installations.length === 0) installations = undefined;
  }

  const resolved: GitHubAppConfig = { appId, privateKey };
  if (installationId !== null) resolved.installationId = installationId;
  if (installations) resolved.installations = installations;
  return resolved;
}

/** Non-empty trimmed string, else `null`. */
function nonEmptyStr(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Accept a numeric id or a non-empty numeric-ish string id (GitHub ids are
 * large integers often carried as strings in JSON). Returns the value
 * normalized to `number | string`, or `null` when absent/blank.
 */
function normalizeIdOrNull(value: unknown): string | number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  return null;
}
