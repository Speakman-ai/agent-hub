/**
 * github-app.ts — MINIMAL GitHub App installation-token support.
 *
 * Scope note: the full GitHub App integration (reviewer, inbound webhooks,
 * the `/api/pr/review` endpoint, App manifest provisioning) was removed in
 * PR #1205 in favour of strictly per-account AI auth. That removal stays.
 * This module restores ONLY the piece needed to mint a short-lived
 * installation access token, so the Hub → GitHub mirror push can use a
 * GitHub App identity that an operator has added to a repository ruleset's
 * bypass list — letting the mirror push a branch-protected default branch
 * while every other pusher stays blocked.
 *
 * There is deliberately NO webhook, reviewer, manifest, or PR-review code
 * here. The only consumer is `server/git-host/mirror.ts` (via
 * {@link getInstallationTokenForOwner}).
 *
 * Auth flow (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app):
 *   1. Sign a short-lived RS256 JWT with the App's private key (iss = App id).
 *   2. POST /app/installations/{id}/access_tokens with that JWT to mint an
 *      installation token (~1h TTL), cached until shortly before expiry.
 */

import { createSign } from 'crypto';
import type { GitHubAppConfig } from './types.js';

interface JWTHeader {
  alg: string;
  typ: string;
}

interface JWTPayload {
  iss: string;
  iat: number;
  exp: number;
}

interface TokenCacheEntry {
  token: string;
  /** Absolute expiry in ms since epoch, from GitHub's `expires_at`. */
  expiry: number;
}

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
}

/**
 * Normalize a PEM private key pasted into a config field. Tolerates the
 * three ways a key gets mangled in transit: JSON-quoted values, escaped
 * `\n` newlines (env/config transport), and Windows CRLF / BOM.
 */
export function normalizePemPrivateKey(privateKey: string): string {
  let key = privateKey.trim();
  if (key.startsWith('"') && key.endsWith('"')) {
    key = key.slice(1, -1);
  }
  key = key.replace(/\\n/g, '\n');
  key = key.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  return key;
}

/**
 * Build a signed RS256 JWT authenticating AS the GitHub App (not an
 * installation). `iat` is backdated 60s to tolerate clock skew; `exp` is
 * the GitHub-max 10 minutes out.
 */
export function generateJWT(appId: string | number, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header: JWTHeader = { alg: 'RS256', typ: 'JWT' };
  const payload: JWTPayload = {
    iss: String(appId),
    iat: now - 60,
    exp: now + 600,
  };

  const b64 = (obj: JWTHeader | JWTPayload): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(payload)}`;

  const sign = createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = sign.sign(normalizePemPrivateKey(privateKey), 'base64url');

  return `${unsigned}.${signature}`;
}

const tokenCache = new Map<string, TokenCacheEntry>();

/** Clear the installation-token cache (test hook / rotation escape hatch). */
export function clearTokenCache(): void {
  tokenCache.clear();
}

/**
 * Mint (or return a cached) installation access token for a given
 * installation id. Cached until 5 minutes before GitHub's stated expiry so
 * an in-flight push never races the boundary. Throws on a non-2xx from
 * GitHub — callers that must degrade gracefully use
 * {@link getInstallationTokenForOwner}.
 */
export async function getInstallationToken(
  appId: string | number,
  privateKey: string,
  installationId: string | number,
): Promise<string> {
  const key = String(installationId);
  const now = Date.now();
  const cached = tokenCache.get(key);
  if (cached && cached.expiry > now + 5 * 60 * 1000) {
    return cached.token;
  }

  const jwt = generateJWT(appId, privateKey);
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to get installation token (${res.status}): ${body}`);
  }

  const data = (await res.json()) as InstallationTokenResponse;
  const expiry = new Date(data.expires_at).getTime();
  tokenCache.set(key, { token: data.token, expiry });
  return data.token;
}

/**
 * Resolve which installation id to use for a repo `owner`. Prefers a
 * per-owner match from `installations[]` (one App serving several orgs),
 * falling back to the single global `installationId`. Returns `null` when
 * no installation can be determined.
 */
export function resolveInstallationId(
  appConfig: GitHubAppConfig | null,
  owner?: string | null,
): string | number | null {
  if (!appConfig) return null;
  if (owner && Array.isArray(appConfig.installations)) {
    const match = appConfig.installations.find(
      (inst) => inst.account?.toLowerCase() === owner.toLowerCase(),
    );
    if (match) return match.id;
  }
  return appConfig.installationId ?? null;
}

/**
 * Graceful-degradation wrapper used by the mirror push path: resolve the
 * installation id for `owner` and mint a token, returning `null` (never
 * throwing) when the App is misconfigured, has no installation for this
 * owner, or GitHub rejects the mint. A `null` return tells the caller to
 * fall back to the per-user OAuth/PAT token chain — so a broken App config
 * degrades a bypass into an ordinary (possibly protection-blocked) push
 * rather than silently dropping the mirror entirely.
 */
export async function getInstallationTokenForOwner(
  appConfig: GitHubAppConfig | null,
  owner?: string | null,
): Promise<string | null> {
  if (!appConfig?.appId || !appConfig?.privateKey) return null;
  const installationId = resolveInstallationId(appConfig, owner);
  if (!installationId) return null;
  try {
    return await getInstallationToken(appConfig.appId, appConfig.privateKey, installationId);
  } catch (err) {
    console.warn(
      `[github-app] installation token mint failed for owner=${owner ?? '(default)'}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
