/**
 * Native PR author attribution — every pull request row must reference a
 * real Hub user id (orgs.db), never orchestrator/agent sentinels.
 */
import config from '../config.js';
import { getAuthRecord } from '../auth-store.js';
import { isLocalBundledServer } from '../auth.js';
import { getSessionOwner } from '../session-ownership.js';
import { getUserById } from '../users-store.js';

/** Legacy/non-user author strings that must not be stamped on new PR rows. */
export const PR_AUTHOR_SENTINELS = new Set(['finalize', 'agent', 'session', 'system']);

/**
 * Synthetic author stamped on PRs created in deployments that intentionally
 * run without per-user auth — the no-auth fresh install (no apiKey + no
 * auth record) and the local bundled server (Electron / dev box). In both,
 * `authMiddleware` runs the request as a synthetic `local` Owner without a
 * `authUserId`, so there is no real Hub user to attribute. Mirrors the
 * `authUser = 'local'` identity set in `authMiddleware`.
 */
export const LOCAL_NO_AUTH_PR_AUTHOR = 'local';

function isAuthDisabled(): boolean {
  if (config.apiKey) return false;
  return !getAuthRecord();
}

/**
 * True when the deployment runs without per-user attribution: a no-auth
 * fresh install, or the local bundled (Electron) server. In these modes a
 * PR may be attributed to the synthetic `local` Owner, and membership-role
 * gates (which have no rows to resolve against) fall back to "any known id".
 *
 * Exported so role-gated config (e.g. the security automation actor) can tell
 * a genuine no-auth/local deployment apart from an auth-enabled deployment
 * where a lookup simply found no membership — only the former may relax the
 * Admin/Owner requirement.
 */
export function attributionOptional(): boolean {
  return isAuthDisabled() || isLocalBundledServer();
}

/**
 * True when `id` is a Hub user row, or (no-auth / local-bundled deployments)
 * any non-empty, non-sentinel string.
 */
export function isKnownHubUserId(id: string | null | undefined): boolean {
  const trimmed = id?.trim();
  if (!trimmed || PR_AUTHOR_SENTINELS.has(trimmed)) return false;
  try {
    if (getUserById(trimmed) != null) return true;
  } catch {
    /* orgs.db not ready — fall through */
  }
  return attributionOptional();
}

export interface ResolveNativePrAuthorSources {
  /** Pre-resolved user id from the caller (wins when valid). */
  explicitUserId?: string | null;
  /** Session whose `owner_user_id` may attribute the PR. */
  sessionId?: string | null;
  /** Finalize run's `triggered_by_user_id`. */
  triggeredByUserId?: string | null;
}

/**
 * Resolve the Hub user id to stamp on a native PR. Throws when no valid
 * attribution can be determined (production paths must not create PRs
 * without a user).
 */
export function resolveNativePrAuthorUserId(sources: ResolveNativePrAuthorSources): string {
  const candidates = [
    sources.explicitUserId,
    sources.sessionId ? getSessionOwner(sources.sessionId) : null,
    sources.triggeredByUserId,
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed && isKnownHubUserId(trimmed)) return trimmed;
  }
  // No real Hub user resolved. In no-auth / local-bundled deployments the
  // request ran as the synthetic `local` Owner (no `authUserId`), so attribute
  // the PR to that local owner instead of making PR creation impossible. Only
  // auth-enabled deployments (apiKey or JWT configured) still require a real
  // attributed user.
  if (attributionOptional()) return LOCAL_NO_AUTH_PR_AUTHOR;
  throw new Error(
    'Native PR creation requires an attributed Hub user (session owner or finalize trigger user)',
  );
}
