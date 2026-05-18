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
/**
 * Failure back-off — much shorter than the success TTL so a transient
 * outage (network blip, 5xx, GitHub rate-limit response) doesn't
 * silently starve an org for the full 5-minute success window. 30s +
 * up to 30s jitter keeps a webhook burst from synchronising retries
 * against the same upstream.
 */
const INSTALLATION_LIST_REFRESH_FAILURE_TTL_MS = 30 * 1000;
const INSTALLATION_LIST_REFRESH_FAILURE_JITTER_MS = 30 * 1000;
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

  try {
    const installations = (await installationLister(
      app.appId,
      app.privateKey,
    )) as unknown as GithubInstallationApiRow[];
    // Only prime the success TTL after the call actually succeeds.
    // Priming pre-call meant a transient failure starved the owner for
    // the full 5-minute success window even though no refresh happened.
    installationListRefreshCache.set(key, {
      expiry: Date.now() + INSTALLATION_LIST_REFRESH_TTL_MS,
    });
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
    // Invalidate ONLY the lookup-cache entries scoped to this App so a
    // refresh for org A doesn't force every other org on the same App
    // to re-run `resolveInstallationId`. Walk the keys (small map, one
    // entry per (appId, owner) seen this process) and drop the
    // matching prefix.
    const prefix = `${app.appId}::`;
    for (const cachedKey of installationLookupCache.keys()) {
      if (cachedKey.startsWith(prefix)) installationLookupCache.delete(cachedKey);
    }
  } catch (err) {
    // Failure back-off: short TTL + jitter so we retry quickly when
    // the upstream recovers, but a hot loop of webhooks for the same
    // org still can't hammer GitHub's rate limit.
    const jitter = Math.floor(Math.random() * INSTALLATION_LIST_REFRESH_FAILURE_JITTER_MS);
    installationListRefreshCache.set(key, {
      expiry: Date.now() + INSTALLATION_LIST_REFRESH_FAILURE_TTL_MS + jitter,
    });
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
 * Role-keyed chain:
 *
 *   **Reviewer**: App installation token → bot token → null.
 *     Never per-user OAuth — would mis-attribute formal reviews to the
 *     org owner's human GitHub account.
 *
 *   **Autonomous-dispatch (non-reviewer)**: App installation token →
 *     null. No per-user fallback — autonomous sessions have no human
 *     caller in scope and the org owner's OAuth would let the spawn
 *     forge formal reviews under their human identity (`gh-pr.sh`
 *     wrapper guard would be bypassed by direct `gh api`). The App
 *     identity is bound to the org, not a human, so it's the correct
 *     credential for system-attributed work.
 *
 *   **Non-reviewer interactive**: per-user OAuth (preferred) →
 *     App installation token (fallback) → null.
 *     This is the human-identity path. The spawn acts AS the user that
 *     started the session — commits, PRs, reviews, gh queries all
 *     attribute correctly. The App installation token is reached ONLY
 *     when the user's stored OAuth is missing or fails pre-validation
 *     against the repo (typical case: the user's grant on the org was
 *     revoked or they left the org). The fallback prevents the spawn
 *     from barrelling into a 15-minute `git clone` timeout, but its
 *     activation is loud — every fall-through emits a TOOL_ERROR so
 *     the operator sees "your PRs are landing as the App, not as you,
 *     because your OAuth is broken" instead of silently mis-attributing.
 *
 * History: prior to PR-against-this-comment the chain preferred the App
 * installation token for EVERY role, which made step (3) dead code on
 * any org with the App installed. That broke per-user attribution for
 * every interactive non-reviewer session — confirmed in the wild by
 * `agent-hub PR #1039` landing as the App's bot identity instead of
 * the human at the keyboard. The intent was always per-user OAuth for
 * humans + App for bots/system; this rewrite restores that.
 *
 * Errors at any step are logged as TOOL_ERROR v2 lines tagged
 * `github-auth` so the recurring "lost org access" pattern stays
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

  // Helper: mint the App installation token for the repo's org and
  // pre-validate it against the repo (when both owner+repo are known).
  // Returns the token on success, null on missing/failed-validation.
  // Centralised so each policy branch reuses the same pattern without
  // re-deriving the success / TOOL_ERROR shape.
  const tryAppInstallationToken = async (): Promise<string | null> => {
    const appToken = await mintInstallationTokenForOwner(
      config,
      repoOwner,
      tokenMinter,
      installationLister,
    );
    if (!appToken) return null;
    if (!repoOwner || !repoName) {
      // No repo name to validate against; trust the freshly-minted
      // installation token. This matches the pre-existing behaviour and
      // keeps spawn paths that don't know the repo (legacy webhook
      // payloads) working.
      return appToken;
    }
    const ok = await validateTokenForRepo(appToken, repoOwner, repoName, validateFetcher);
    if (ok) return appToken;
    emitTokenError({
      summary: `App installation token failed pre-validation for ${repoOwner}/${repoName}`,
      owner: repoOwner,
      repo: repoName,
      tag: 'app-installation-token',
    });
    return null;
  };

  // === Reviewer role ============================================
  if (role === 'reviewer') {
    const appToken = await tryAppInstallationToken();
    if (appToken) return appToken;

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

  // === Autonomous-dispatch (non-reviewer) ========================
  // No per-user OAuth fallback — see security rationale above.
  if (autonomousOrigin === true) {
    return await tryAppInstallationToken();
  }

  // === Non-reviewer interactive ==================================
  // Per-user OAuth first; App installation token fallback only when the
  // user OAuth is missing or fails validation. This is the human-identity
  // path — spawn acts AS the human at the keyboard for `git push`,
  // `gh pr create`, `gh api`, etc.
  if (userGhToken) {
    if (!repoOwner || !repoName) {
      // No repo info to validate against. Trust the stored token and
      // return it without a pre-flight check — matches the pre-existing
      // "missing repo info" path for non-reviewer spawns.
      return userGhToken;
    }
    const ok = await validateTokenForRepo(userGhToken, repoOwner, repoName, validateFetcher);
    if (ok) return userGhToken;
    emitTokenError({
      summary: `per-user OAuth token failed pre-validation for ${repoOwner}/${repoName} (grant likely revoked) — falling back to App installation token`,
      owner: repoOwner,
      repo: repoName,
      tag: 'user-oauth-token',
    });
    // fall through to App-token fallback so `git clone` doesn't eat a
    // 15-minute worker slot on a revoked grant.
  }

  // Last resort for non-reviewer interactive: App installation token.
  // Reached only when user OAuth is missing or revoked. Note: the spawn
  // will be attributed to the App identity for this case, which we
  // surface via the TOOL_ERROR above so the operator sees the swap.
  return await tryAppInstallationToken();
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
    // sev:"soft" with resolution:"recovered" is by definition a warning,
    // not an error. Routing through console.warn keeps PM2 / dashboards
    // from flagging the recurring auth-revoked flap as an error spike.
    console.warn(
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
