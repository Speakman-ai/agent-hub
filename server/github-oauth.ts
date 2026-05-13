/**
 * github-oauth.ts — GitHub user-to-server OAuth for "Sign in with GitHub".
 *
 * This is the user-identity half of GitHub auth, separate from the bot
 * identity in `github-app.ts`:
 *   - `github-app.ts` issues *installation* tokens (bot acts on repos it is
 *     installed on) — used for formal PR reviews.
 *   - `github-oauth.ts` issues *user* tokens (acts as the individual human
 *     that signed in) — used for list/merge/close/comment as `@user`.
 *
 * Both reuse the *same* GitHub App registration — GitHub Apps can issue
 * user-to-server tokens via the OAuth endpoints without the App being
 * installed anywhere. The `clientId`/`clientSecret` come from the App's
 * OAuth credentials (stored in `AppConfig.githubApp`).
 *
 * Tokens expire in 8 hours by default; refresh tokens in 6 months.
 * Callers refresh transparently via `github-connections-store`.
 *
 * Docs (verified 2026-04-20):
 *   https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
 *   https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
 */

export interface GitHubOAuthCredentials {
  clientId: string;
  clientSecret: string;
}

export interface GitHubTokenResponse {
  access_token: string;
  /**
   * Seconds until the access token expires. Typically 28800 (8h) for
   * GitHub Apps with "Expire user authorization tokens" enabled.
   *
   * Optional because **classic OAuth Apps** (registered at
   * `/settings/applications/new`) and **GitHub Apps without expiring
   * user tokens** return only `access_token`/`scope`/`token_type` —
   * the token never expires and there is no refresh flow at all.
   */
  expires_in?: number;
  /**
   * Optional for the same reason as `expires_in`. When absent, the
   * caller must persist `null` for both `refreshToken` and
   * `refreshExpiresAt` and skip the refresh path forever (the user
   * will need to reconnect manually if the token is revoked).
   */
  refresh_token?: string;
  /** Optional; mirrors `refresh_token`. Typically 15724800 (6mo). */
  refresh_token_expires_in?: number;
  token_type: 'bearer';
  scope: string;
}

export interface GitHubUserInfo {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  email: string | null;
}

/**
 * Default OAuth scopes requested when the registered app is a **classic
 * OAuth App** (`/settings/applications/<id>`). Classic apps follow OAuth
 * scope semantics — a token issued with no `scope=` is scopeless and
 * cannot see private repos or list orgs, even though it can identify the
 * user. The defaults below cover the common agent-hub use cases:
 *
 *   - `repo`     — clone / push / open PRs on private repos
 *   - `read:org` — list orgs the signed-in user belongs to (used by `gh`)
 *   - `workflow` — push changes that touch `.github/workflows/*.yml`
 *
 * GitHub Apps (`/settings/apps/<slug>`) **ignore** the `scope` parameter
 * entirely — their user-to-server tokens inherit the App's installation
 * permissions. So sending these defaults is safe regardless of the app
 * type: classic apps respect them, GitHub Apps silently drop them.
 */
export const DEFAULT_OAUTH_SCOPES = ['repo', 'read:org', 'workflow'] as const;

/**
 * Build the GitHub authorize URL the user's browser should hit to start
 * the OAuth flow. The `state` is a short-lived signed token the caller
 * mints via `server/jwt.ts` — it carries the hub userId and is verified
 * on callback to prevent CSRF.
 *
 * Scope handling:
 *   - Omit `scopes` → uses {@link DEFAULT_OAUTH_SCOPES}.
 *   - Pass `scopes: []` → no `scope=` param at all (legacy GitHub-App-only
 *     behavior, preserved so callers can opt out explicitly).
 *   - Pass `scopes: ['repo', ...]` → comma-separated list per the OAuth
 *     spec. Duplicates are deduped; empty strings are dropped.
 *
 * Why default to scopes: in practice many self-hosters register a classic
 * OAuth App rather than a GitHub App (the UI is simpler and doesn't
 * require an "Install on org" step). Without a `scope=` param, classic
 * apps issue scopeless tokens, which is what caused the "git push 404"
 * symptom that motivated this fix. GitHub Apps are unaffected because
 * they ignore the parameter.
 */
export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  /**
   * If provided, GitHub will prompt only this specific login. Useful for
   * "reconnect as a different account" flows. Usually left undefined.
   */
  login?: string;
  /**
   * OAuth scopes to request. Omit to use {@link DEFAULT_OAUTH_SCOPES};
   * pass an empty array to send no `scope=` parameter at all.
   */
  scopes?: readonly string[];
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    state: opts.state,
  });
  const scopeList = opts.scopes ?? DEFAULT_OAUTH_SCOPES;
  const dedupedScopes = Array.from(
    new Set(scopeList.map((s) => s.trim()).filter((s) => s.length > 0)),
  );
  if (dedupedScopes.length > 0) {
    // GitHub's spec says space-delimited; comma is tolerated in practice
    // (and is what classic OAuth Apps actually parse). We use comma because
    // URLSearchParams would percent-encode spaces as `+` or `%20`.
    params.set('scope', dedupedScopes.join(','));
  }
  if (opts.login) params.set('login', opts.login);
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/**
 * Exchange an OAuth code (delivered to our callback as `?code=...`) for
 * a user access token + refresh token. Throws if GitHub returns an error.
 *
 * GitHub returns 200 with an `error` field on failures rather than a
 * non-2xx status, so we have to check both paths.
 */
export async function exchangeCodeForToken(opts: {
  credentials: GitHubOAuthCredentials;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<GitHubTokenResponse> {
  const f = opts.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: opts.credentials.clientId,
    client_secret: opts.credentials.clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
  });
  const res = await f('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub OAuth token exchange failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as Partial<GitHubTokenResponse> & {
    error?: string;
    error_description?: string;
  };
  if (json.error) {
    throw new Error(`GitHub OAuth error: ${json.error_description || json.error}`);
  }
  // `refresh_token` is OPTIONAL — classic OAuth Apps and GitHub Apps
  // without "Expire user authorization tokens" return only the access
  // token. Only the access token itself is required.
  if (!json.access_token) {
    throw new Error('GitHub OAuth response missing access_token');
  }
  return json as GitHubTokenResponse;
}

/**
 * The refresh-token grant always returns the full quartet of fields —
 * by definition, the OAuth client must have expiring tokens enabled
 * for a refresh_token to have been issued in the first place. We expose
 * a narrowed type so callers don't need to defensively handle undefined
 * `expires_in` / `refresh_token_expires_in` in the rotation path.
 */
export type GitHubRefreshedTokens = GitHubTokenResponse & {
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
};

/**
 * Refresh an expiring/expired user access token using its paired
 * refresh_token. The refresh_token is single-use — GitHub returns a new
 * refresh_token in the response that callers MUST persist in place of
 * the old one. Calling this twice with the same refresh_token will fail
 * the second time.
 */
export async function refreshUserToken(opts: {
  credentials: GitHubOAuthCredentials;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<GitHubRefreshedTokens> {
  const f = opts.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: opts.credentials.clientId,
    client_secret: opts.credentials.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
  });
  const res = await f('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub OAuth refresh failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as Partial<GitHubTokenResponse> & {
    error?: string;
    error_description?: string;
  };
  if (json.error) {
    throw new Error(`GitHub OAuth refresh error: ${json.error_description || json.error}`);
  }
  if (
    !json.access_token ||
    !json.refresh_token ||
    typeof json.expires_in !== 'number' ||
    typeof json.refresh_token_expires_in !== 'number'
  ) {
    throw new Error('GitHub OAuth refresh response missing tokens');
  }
  return json as GitHubRefreshedTokens;
}

/**
 * Fetch the authenticated user's profile. We call this immediately after
 * `exchangeCodeForToken` so we can persist the `login` alongside the
 * token — knowing "this hub user is @speakmanra on GitHub" is what makes
 * "acting as the user" meaningful.
 */
export async function fetchUserInfo(opts: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<GitHubUserInfo> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub /user fetch failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as Partial<GitHubUserInfo>;
  if (typeof json.id !== 'number' || typeof json.login !== 'string') {
    throw new Error('GitHub /user response missing id or login');
  }
  return {
    id: json.id,
    login: json.login,
    name: json.name ?? null,
    avatar_url: json.avatar_url ?? null,
    email: json.email ?? null,
  };
}

/**
 * Make a user-authenticated GitHub REST request. This is the user-tier
 * analog of `githubApiRequest` in `github-app.ts`. The `token` here is
 * the user access token, not an installation token.
 *
 * Callers should already have refreshed the token via the connections
 * store before calling this.
 */
export async function githubUserApiRequest<T = Record<string, unknown>>(opts: {
  accessToken: string;
  endpoint: string;
  method?: string;
  body?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  const url = opts.endpoint.startsWith('https://')
    ? opts.endpoint
    : `https://api.github.com${opts.endpoint}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.accessToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await f(url, {
    method: opts.method || 'GET',
    headers,
    ...(opts.body && { body: JSON.stringify(opts.body) }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `GitHub user-API ${opts.method || 'GET'} ${opts.endpoint} failed (${res.status}): ${text}`,
    );
  }
  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}
