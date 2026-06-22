import type { PersonalOAuthConfig } from './types.js';

/**
 * Return a credential value only when it is a non-empty string (after
 * trimming), else `null`. Empty / whitespace-only values must be treated as
 * "missing" so an upgraded config with a blank `personalOAuth` block
 * (`{ clientId: '', clientSecret: '' }`) does not shadow a valid legacy
 * `githubApp` fallback. Trimming also tolerates a stray newline pasted into
 * config.json — OAuth client ids/secrets never carry meaningful surrounding
 * whitespace.
 */
function nonEmptyCredential(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Resolve the personal "Sign in with GitHub" OAuth App credentials from the
 * on-disk config, with a back-compat fallback to the removed GitHub App block.
 *
 * Why the fallback exists:
 *   GitHub App + inbound-webhook infrastructure was removed (PR #149). Personal
 *   OAuth now lives under `config.personalOAuth`. But installs that previously
 *   authenticated through a GitHub App still carry their OAuth client id/secret
 *   under the legacy `githubApp.{clientId,clientSecret}` block in config.json.
 *   GitHub requires those exact credentials to refresh GitHub App
 *   user-to-server tokens, which expire ~8h after issue by default (see
 *   https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).
 *   Reading only `personalOAuth` would 503 `/api/auth/github/start` and break
 *   `getActiveAccessToken(...)` refresh for those installs.
 *
 * Precedence: the modern `personalOAuth` block wins when complete; otherwise we
 * fall back to the legacy GitHub App client id/secret. Returns `null` when
 * neither source has a complete id+secret pair (PAT connections need no OAuth
 * credentials). This is a read-time migration: by funnelling both sources into
 * `config.personalOAuth` at boot, every downstream consumer
 * (`resolveOAuthAppCredentials`, the OAuth routes, the spawn refresh path) keeps
 * working without touching the legacy block.
 */
export function resolvePersonalOAuthConfig(
  fileConfig: Record<string, unknown>,
): PersonalOAuthConfig | null {
  const personal = fileConfig.personalOAuth as Partial<PersonalOAuthConfig> | null | undefined;
  const personalId = nonEmptyCredential(personal?.clientId);
  const personalSecret = nonEmptyCredential(personal?.clientSecret);
  if (personalId && personalSecret) {
    return { clientId: personalId, clientSecret: personalSecret };
  }

  // Back-compat: derive from the legacy `githubApp` block (removed from the
  // AppConfig type, still present in upgraded installs' config.json). Only
  // reached when `personalOAuth` is absent OR blank — a blank modern block
  // must not shadow valid legacy credentials.
  const legacy = fileConfig.githubApp as
    | { clientId?: unknown; clientSecret?: unknown }
    | null
    | undefined;
  const legacyId = nonEmptyCredential(legacy?.clientId);
  const legacySecret = nonEmptyCredential(legacy?.clientSecret);
  if (legacyId && legacySecret) {
    return { clientId: legacyId, clientSecret: legacySecret };
  }

  return null;
}
