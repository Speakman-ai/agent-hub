import type { GoogleOAuthConfig } from './types.js';

/**
 * Return a credential value only when it is a non-empty string (after
 * trimming), else `null`. Empty / whitespace-only values must be treated as
 * "missing" so a config with a blank `googleOAuth` block
 * (`{ clientId: '', clientSecret: '' }`) resolves to "unconfigured" rather than
 * a half-populated credential pair. Trimming also tolerates a stray newline
 * pasted into config.json — OAuth client ids/secrets never carry meaningful
 * surrounding whitespace.
 */
function nonEmptyCredential(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Resolve the server-global Google OAuth *app* credentials (client id/secret)
 * from the on-disk config. Mirrors {@link resolvePersonalOAuthConfig} but with
 * no legacy-block fallback — Google OAuth is a new surface, so the only source
 * is `config.googleOAuth`.
 *
 * Returns `null` unless BOTH `clientId` and `clientSecret` resolve to non-empty
 * strings. A partial block (only one field set) is treated as unconfigured so
 * the connect flow degrades to "not configured" instead of attempting a broken
 * OAuth handshake.
 */
export function resolveGoogleOAuthConfig(
  fileConfig: Record<string, unknown>,
): GoogleOAuthConfig | null {
  const google = fileConfig.googleOAuth as Partial<GoogleOAuthConfig> | null | undefined;
  const clientId = nonEmptyCredential(google?.clientId);
  const clientSecret = nonEmptyCredential(google?.clientSecret);
  if (clientId && clientSecret) {
    return { clientId, clientSecret };
  }
  return null;
}
