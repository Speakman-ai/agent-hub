/**
 * github-spawn-token-resolver.ts — org-aware GitHub credential chain
 * for spawned agent processes.
 *
 * Closes the two failure modes documented in the recurring
 * "Write access to repository not granted" incidents:
 *
 *   1. Non-reviewer sessions cloning an org-owned repo were spawned
 *      with the session-owner user's personal `gho_…` OAuth token.
 *      Whenever that user's grant on the org was revoked / they left
 *      the org / the OAuth App was de-approved org-wide, every webhook
 *      clone for the org's repos failed with 403 even though the same
 *      Agent Hub install had a perfectly good GitHub App installation
 *      on the org.
 *
 *   2. There was no fallback chain — `selectGithubSpawnToken` made a
 *      one-shot choice and any 401/403 from `git clone` ate a worker
 *      slot for 15 minutes (the wall timeout).
 *
 * This module wraps the existing `resolveInstallationId` /
 * `getInstallationToken` helpers from `github-app.ts` and the
 * historical `selectGithubSpawnToken` policy from
 * `spawn-github-credentials.ts` into a single async resolver that:
 *
 *   - Prefers a GitHub-App installation token (`ghs_…`) scoped to the
 *     repo's org when the App is installed there.
 *   - Validates that token with a cheap `GET /repos/:owner/:repo` ping
 *     before injecting it, so a stale installation falls through to
 *     the next candidate instead of poisoning the spawn.
 *   - Falls back to the existing per-user OAuth / reviewer-bot policy
 *     unchanged for personal repos and security-sensitive
 *     autonomous-dispatch paths.
 *   - Emits TOOL_ERROR-formatted log lines on every credential failure
 *     so the recurring auth-revoked pattern is observable from
 *     `server logs` and minable by the future Session Health surface.
 */
import { getAppInstallations, getInstallationToken, resolveInstallationId } from './github-app.js';
import type { AppConfig, GitHubAppConfig } from './types.js';

interface GithubInstallationApiRow {
  id?: number;
  account?: { login?: string; type?: string };
}

interface InstallationLookupCacheEntry {
  installationId: string | number | null;
  expiry: number;
}

const INSTALLATION_LOOKUP_TTL_MS = 5 * 60 * 1000;
const installationLookupCache = new Map<string, InstallationLookupCacheEntry>();

/**
 * Resolve the installation id for a given org/user login. Reads from
 * `config.githubApp.installations[]` first (populated by the existing
 * `/api/github-app/refresh-installation` and `/api/github-app/setup-complete`
 * routes); cached for 5 minutes so a repeat lookup in the same spawn
 * burst doesn't churn.
 *
 * Returns `null` when no App is configured, no installation matches,
 * or `owner` is empty.
 */
export function lookupInstallationIdForOwner(
  app: GitHubAppConfig | null,
  owner: string | null | undefined,
): string | number | null {
  if (!app || !owner) return null;
  const key = `${app.appId || 'noapp'}::${owner.toLowerCase()}`;
  const now = Date.now();
  const cached = installationLookupCache.get(key);
  if (cached && cached.expiry > now) {
    return cached.installationId;
  }
  const id = resolveInstallationId(app, owner);
  // Don't fall back to `app.installationId` when an explicit owner was
  // supplied but no per-org match exists — using a different org's
  // installation token to clone this one's repo is exactly the bug
  // this module exists to close.
  const matchedExplicitly =
    Array.isArray(app.installations) &&
    app.installations.some((inst) => inst.account?.toLowerCase() === owner.toLowerCase());
  const installationId = matchedExplicitly ? id : null;
  installationLookupCache.set(key, { installationId, expiry: now + INSTALLATION_LOOKUP_TTL_MS });
  return installationId;
}

interface InstallationListRefreshEntry {
  expiry: number;
}

const INSTALLATION_LIST_REFRESH_TTL_MS = 5 * 60 * 1000;
const installationListRefreshCache = new Map<string, InstallationListRefreshEntry>();

/**
 * Lazy self-healing for `config.githubApp.installations[]`. When the
 * resolver hits a cache miss for an org we've never seen — because the
 * user installed the App after the last `/api/github-app/setup-complete`
 * call, or because the App was uninstalled and reinstalled — we make a
 * single live `GET /app/installations` call to refresh the list. This
 * removes the operational burden of remembering to click "Refresh
 * installation" in Settings every time the App is re-installed and is
 * what makes the org-aware credential chain truly self-healing.
 *
 * Rate-limited per (appId, owner) to one live refresh every 5 minutes
 * so a hot loop of webhooks for an org that genuinely has no
 * installation can't hammer GitHub's app-level rate limit.
 *
 * Mutates `app.installations` in place when a refresh succeeds so
 * subsequent calls (and the rest of the server) see the updated list.
 * Config-file persistence stays the responsibility of the explicit
 * setup-complete / refresh-installation routes — this in-memory update
 * is purely so spawns in the same process recover without an operator
 * action.
 */
async function refreshInstallationsForOwner(
  app: GitHubAppConfig,
  owner: string,
  installationLister: (
    appId: string | number,
    privateKey: string,
  ) => Promise<Array<Record<string, unknown>>> = getAppInstallations,
): Promise<void> {
  if (!app.appId || !app.privateKey) return;
  const key = `${app.appId}::${owner.toLowerCase()}`;
  const now = Date.now();
  const lastRefresh = installationListRefreshCache.get(key);
  if (lastRefresh && lastRefresh.expiry > now) return;
  installationListRefreshCache.set(key, { expiry: now + INSTALLATION_LIST_REFRESH_TTL_MS });

  try {
    const installations = (await installationLister(
      app.appId,
      app.privateKey,
    )) as unknown as GithubInstallationApiRow[];
    if (!Array.isArray(installations)) return;
    app.installations = installations
      .filter(
        (inst): inst is GithubInstallationApiRow & { id: number } => typeof inst.id === 'number',
      )
      .map((inst) => ({
        id: inst.id,
        account: inst.account?.login ?? '',
        accountType: inst.account?.type ?? '',
      }));
    // Invalidate the per-owner lookup cache so the next call sees the
    // refreshed list rather than the negative cache entry that brought
    // us here.
    installationLookupCache.clear();
  } catch (err) {
    emitTokenError({
      summary: (err as Error).message || 'installation list refresh failed',
      owner,
      tag: 'app-installation-token',
    });
  }
}

/**
 * Mint a fresh installation token for the given repo owner, or return
 * `null` if the App isn't configured, isn't installed on that org, or
 * the token mint call fails.
 *
 * When the initial cache lookup misses, we trigger a lazy refresh of
 * `config.githubApp.installations[]` via `getAppInstallations()` so a
 * freshly-installed App is picked up without an operator round-trip
 * through Settings.
 *
 * `tokenMinter` and `installationLister` are injectable for tests.
 * Production callers pass nothing and get the real helpers from
 * `github-app.ts` (which themselves cache with a 5-minute window).
 */
export async function mintInstallationTokenForOwner(
  config: Pick<AppConfig, 'githubApp'>,
  owner: string | null | undefined,
  tokenMinter: (
    appId: string | number,
    privateKey: string,
    installationId: string | number,
  ) => Promise<string> = getInstallationToken,
  installationLister: (
    appId: string | number,
    privateKey: string,
  ) => Promise<Array<Record<string, unknown>>> = getAppInstallations,
): Promise<string | null> {
  const app = config.githubApp;
  if (!app?.appId || !app?.privateKey) return null;
  if (!owner) return null;

  let installationId = lookupInstallationIdForOwner(app, owner);
  if (installationId == null) {
    await refreshInstallationsForOwner(app, owner, installationLister);
    installationId = lookupInstallationIdForOwner(app, owner);
  }
  if (installationId == null) return null;

  try {
    return await tokenMinter(app.appId, app.privateKey, installationId);
  } catch (err) {
    emitTokenError({
      summary: (err as Error).message || 'installation token mint failed',
      owner,
      tag: 'app-installation-token',
    });
    return null;
  }
}

/**
 * Cheap auth check: `GET /repos/:owner/:repo` with the supplied token.
 * Returns `true` when the response is 200, `false` for any 4xx/5xx or
 * network error. Used to skip a known-dead token before it lands in
 * the spawn env (and before a 15-minute `git clone` timeout consumes a
 * worker slot).
 *
 * `fetcher` is injectable for tests; production callers pass nothing
 * and get the global `fetch`.
 */
export async function validateTokenForRepo(
  token: string | null | undefined,
  owner: string | null | undefined,
  repo: string | null | undefined,
  fetcher: (
    url: string,
    init?: { method?: string; headers?: Record<string, string> },
  ) => Promise<{ ok: boolean; status: number }> = (url, init) =>
    fetch(url, init as RequestInit) as unknown as Promise<{ ok: boolean; status: number }>,
): Promise<boolean> {
  if (!token || !owner || !repo) return false;
  try {
    const res = await fetcher(`https://api.github.com/repos/${owner}/${repo}`, {
      method: 'GET',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface ResolveGithubSpawnTokenOpts {
  role: string | undefined;
  config: Pick<AppConfig, 'githubApp' | 'botGithubToken'>;
  userGhToken: string | null | undefined;
  /** Webhook payload's `repository.full_name` owner, or `git remote`-derived owner. */
  repoOwner?: string | null;
  /** Webhook payload's `repository.full_name` repo, or `git remote`-derived repo. */
  repoName?: string | null;
  /** Forwarded from `ChatMessage._fromAutonomousDispatch`. */
  autonomousOrigin?: boolean;
  /** Test hooks. */
  tokenMinter?: (
    appId: string | number,
    privateKey: string,
    installationId: string | number,
  ) => Promise<string>;
  installationLister?: (
    appId: string | number,
    privateKey: string,
  ) => Promise<Array<Record<string, unknown>>>;
  validateFetcher?: (
    url: string,
    init?: { method?: string; headers?: Record<string, string> },
  ) => Promise<{ ok: boolean; status: number }>;
}

/**
 * Async credential resolver. Returns the token to inject into the
 * spawn env, or `null` when no credential should be wired (the existing
 * `applyGithubSpawnCredentials` no-ops on null).
 *
 * Chain:
 *
 *   1. **App installation token for the repo's org (preferred).**
 *      Available regardless of role — the App identity is bound to the
 *      org, not a human, so it does not re-introduce the autonomous-
 *      dispatch leak the security guard exists to prevent. Pre-validated
 *      against the repo before injection; a 401/403 here falls through
 *      to step (2) and emits a TOOL_ERROR.
 *
 *   2. **Reviewer role**: `config.botGithubToken` (legacy hand-pasted
 *      PAT / installation token) when the App path didn't produce a
 *      token. Pre-validated when repo info is available.
 *
 *   3. **Non-reviewer, interactive**: `userGhToken` (the session
 *      owner's stored per-user OAuth / PAT). Pre-validated when repo
 *      info is available; a 401/403 here is the "OAuth grant revoked"
 *      case — log it and surface a null so the spawn doesn't barrel
 *      into a 15-minute clone timeout.
 *
 *   4. **Non-reviewer, autonomous-dispatch**: no user-OAuth fallback
 *      (existing security guard preserved). Returns null.
 *
 * Errors at any step are logged as TOOL_ERROR v2 lines tagged
 * `github-auth` so the recurring "lost org access" pattern is
 * observable. They never throw.
 */
export async function resolveGithubSpawnToken(
  opts: ResolveGithubSpawnTokenOpts,
): Promise<string | null> {
  const {
    role,
    config,
    userGhToken,
    repoOwner,
    repoName,
    autonomousOrigin,
    tokenMinter,
    installationLister,
    validateFetcher,
  } = opts;

  // Step 1: try the App installation token for the repo's org.
  const appToken = await mintInstallationTokenForOwner(
    config,
    repoOwner,
    tokenMinter,
    installationLister,
  );
  if (appToken) {
    // Validate when we have enough info to do a real ping. If we only
    // have an owner (no repo name), skip validation — the token came
    // straight from the App and is overwhelmingly likely to be good.
    if (repoOwner && repoName) {
      const ok = await validateTokenForRepo(appToken, repoOwner, repoName, validateFetcher);
      if (ok) return appToken;
      emitTokenError({
        summary: `App installation token failed pre-validation for ${repoOwner}/${repoName}`,
        owner: repoOwner,
        repo: repoName,
        tag: 'app-installation-token',
      });
      // fall through
    } else {
      return appToken;
    }
  }

  // Step 2: reviewer role gets the bot token if step 1 didn't pan out.
  if (role === 'reviewer') {
    const bot = config.botGithubToken ? config.botGithubToken : null;
    if (!bot) return null;
    if (repoOwner && repoName) {
      const ok = await validateTokenForRepo(bot, repoOwner, repoName, validateFetcher);
      if (!ok) {
        emitTokenError({
          summary: `reviewer botGithubToken failed pre-validation for ${repoOwner}/${repoName}`,
          owner: repoOwner,
          repo: repoName,
          tag: 'reviewer-bot-token',
        });
        return null;
      }
    }
    return bot;
  }

  // Step 4 (autonomous): no user-OAuth fallback. See the existing
  // security rationale in `selectGithubSpawnToken`'s doc comment.
  if (autonomousOrigin === true) {
    return null;
  }

  // Step 3: non-reviewer interactive — fall back to per-user OAuth.
  if (!userGhToken) return null;
  if (repoOwner && repoName) {
    const ok = await validateTokenForRepo(userGhToken, repoOwner, repoName, validateFetcher);
    if (!ok) {
      emitTokenError({
        summary: `per-user OAuth token failed pre-validation for ${repoOwner}/${repoName} (grant likely revoked)`,
        owner: repoOwner,
        repo: repoName,
        tag: 'user-oauth-token',
      });
      return null;
    }
  }
  return userGhToken;
}

interface TokenErrorPayload {
  summary: string;
  owner?: string;
  repo?: string;
  tag: 'app-installation-token' | 'reviewer-bot-token' | 'user-oauth-token';
}

/**
 * Emit a TOOL_ERROR v2 line for a credential-resolution failure. The
 * format matches `references/errors.md` so the future Session Health
 * surface can mine these directly.
 *
 * Best-effort only — wrapped in try/catch because the resolver runs
 * inside the hot spawn path and a logging hiccup must never block a
 * spawn.
 */
function emitTokenError(payload: TokenErrorPayload): void {
  try {
    const summary = payload.summary
      .replace(/[\r\n|]+/g, ' ')
      .trim()
      .slice(0, 200);
    const meta: Record<string, unknown> = {
      v: 2,
      sev: 'soft',
      resolution: 'recovered',
      tags: ['github-auth', payload.tag],
    };
    if (payload.owner) meta.owner = payload.owner;
    if (payload.repo) meta.repo = payload.repo;
    console.error(
      `TOOL_ERROR | ${new Date().toISOString()} | github-auth | ${payload.tag} | warn | ${summary} | ${JSON.stringify(meta)}`,
    );
  } catch {
    /* swallow — observability must not block a spawn */
  }
}

/** Test hook: clear the per-owner installation lookup cache. */
export function clearInstallationLookupCache(): void {
  installationLookupCache.clear();
  installationListRefreshCache.clear();
}
