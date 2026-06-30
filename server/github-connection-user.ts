/**
 * Resolve which Hub user row should own the GitHub connection (OAuth or PAT).
 *
 * Multi-user deployments: the JWT-authenticated user's id.
 * Legacy single-tenant contexts (Electron local bypass, global apiKey
 * without a JWT user, or open install): a synthetic `local-<orgId>` row.
 * Normal UI flow: Owner JWT from setup/login — not apiKey.
 */
import type { Request } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import { getActiveOrgId } from './orgs.js';
import { createUser, getUserByUsername } from './users-store.js';

export function getOrCreateSyntheticLocalOrgUser(orgId: string): string | null {
  const username = `local-${orgId}`;
  try {
    const existing = getUserByUsername(username);
    if (existing) return existing.id;
    const created = createUser({ username, passwordHash: '' });
    return created.id;
  } catch {
    return null;
  }
}

/**
 * True when the request is from a single-tenant operator context where
 * binding GitHub to the org-wide synthetic user is correct (not a shared
 * multi-user JWT session).
 */
function isSingleTenantGithubBinding(areq: AuthenticatedRequest): boolean {
  if (areq.authUserId) return false;
  return !!(
    areq.authLocalOrgBypass ||
    areq.authViaApiKey ||
    (areq.authRole === 'Owner' && !areq.authViaUserApiKey && !areq.authUser)
  );
}

export function resolveGithubConnectionUserId(req: Request): string | null {
  const areq = req as AuthenticatedRequest;
  if (areq.authUserId) return areq.authUserId;
  if (!isSingleTenantGithubBinding(areq)) return null;

  let orgId = areq.authOrgId;
  if (!orgId) {
    try {
      orgId = getActiveOrgId();
    } catch {
      return null;
    }
  }
  if (!orgId) return null;
  return getOrCreateSyntheticLocalOrgUser(orgId);
}

/**
 * Provider-agnostic alias for {@link resolveGithubConnectionUserId}. The
 * resolution logic (JWT user → single-tenant synthetic local-org user → null)
 * is identity-provider-independent, so per-user OAuth flows for other providers
 * (Google, …) import this name to avoid implying a GitHub-specific dependency.
 */
export const resolveOAuthConnectionUserId = resolveGithubConnectionUserId;
