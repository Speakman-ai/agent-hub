/**
 * github-spawn-token-resolver.ts — GitHub credential resolution for
 * spawned agent processes.
 *
 * The reviewer GitHub App (and its org-aware installation-token chain) has
 * been removed. Credential resolution is now strictly per-user:
 *
 *   - **Reviewer / autonomous-dispatch spawns**: no token. Reviewer sessions
 *     are isolated from GitHub by design (`applyReviewerSpawnIsolation`), and
 *     autonomous git operations push via the org-owner token resolved in
 *     `auto-git.ts`, not via the spawn env.
 *   - **Non-reviewer interactive spawns**: the acting user's own OAuth/PAT
 *     (from Settings → GitHub), validated against the target repo before it
 *     is injected so a stale/revoked token fails fast instead of eating a
 *     worker slot on a 15-minute `git clone` timeout.
 *
 * Errors are logged as TOOL_ERROR v2 lines tagged `github-auth`; they never
 * throw.
 */
import type { AppConfig } from './types.js';

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
  /** Retained for call-site compatibility; no longer consulted. */
  config?: Pick<AppConfig, 'personalOAuth'> | unknown;
  userGhToken: string | null | undefined;
  /** Webhook payload's `repository.full_name` owner, or `git remote`-derived owner. */
  repoOwner?: string | null;
  /** Webhook payload's `repository.full_name` repo, or `git remote`-derived repo. */
  repoName?: string | null;
  /** Forwarded from `ChatMessage._fromAutonomousDispatch`. */
  autonomousOrigin?: boolean;
  /** Test hook. */
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
 *   **Reviewer**: null — reviewer sessions are isolated from GitHub.
 *
 *   **Autonomous-dispatch (non-reviewer)**: null — autonomous git auth is
 *     handled by the org-owner token in `auto-git.ts`, not the spawn env.
 *
 *   **Non-reviewer interactive**: the acting user's own OAuth/PAT, validated
 *     against the repo. Missing/invalid → null (connect Settings → GitHub).
 */
export async function resolveGithubSpawnToken(
  opts: ResolveGithubSpawnTokenOpts,
): Promise<string | null> {
  const { role, userGhToken, repoOwner, repoName, autonomousOrigin, validateFetcher } = opts;

  // Reviewer + autonomous-dispatch spawns get no spawn-env token.
  if (role === 'reviewer' || autonomousOrigin === true) {
    return null;
  }

  // Non-reviewer interactive: per-user OAuth/PAT only.
  if (!userGhToken) return null;
  if (!repoOwner || !repoName) {
    return userGhToken;
  }
  const ok = await validateTokenForRepo(userGhToken, repoOwner, repoName, validateFetcher);
  if (ok) return userGhToken;
  emitTokenError({
    summary: `per-user GitHub token failed pre-validation for ${repoOwner}/${repoName} — connect Settings → GitHub`,
    owner: repoOwner,
    repo: repoName,
    tag: 'user-oauth-token',
  });
  return null;
}

interface TokenErrorPayload {
  summary: string;
  owner?: string;
  repo?: string;
  tag: 'user-oauth-token';
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
    console.warn(
      `TOOL_ERROR | ${new Date().toISOString()} | github-auth | ${payload.tag} | warn | ${summary} | ${JSON.stringify(meta)}`,
    );
  } catch {
    /* swallow — observability must not block a spawn */
  }
}

/** Test hook retained for back-compat; no installation cache remains. */
export function clearInstallationLookupCache(): void {
  /* no-op — installation-token caching removed with the GitHub App */
}
