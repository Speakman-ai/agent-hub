/**
 * spawn-github-credentials.ts — propagate the session-owner's GitHub
 * identity into a spawned agent process so `gh` and `git push` against
 * GitHub HTTPS remotes work without per-session credential setup.
 *
 * Why this exists:
 *   The server-side GitHub API surface (PR list, PR actions, captures)
 *   reads tokens directly from `github_connections` via
 *   `getActiveAccessToken`. The spawn side never had an equivalent —
 *   `chat.ts` only injected a host-wide `botGithubToken` for *reviewer*
 *   role agents (formal PR reviews via the bot identity). Everyone else
 *   spawned with a sanitized env, so even if the user signed in via
 *   Settings their agent landed in a sandbox with no creds and `git
 *   push` failed with "could not read Username for 'https://github.com'".
 *
 * What the helper does:
 *   1. `resolveOAuthAppCredentials(config)` — pick the OAuth credentials
 *      used to refresh stored user tokens. Personal OAuth App wins over
 *      the back-compat GitHub App fallback. Mirrors the precedence in
 *      `routes/github-oauth.ts` so the refresh path behaves identically
 *      whether triggered by the spawn or by a server-side route.
 *
 *   2. `applyGithubSpawnCredentials(env, token)` — mutate a spawn env
 *      record to add `GH_TOKEN` + `GITHUB_TOKEN` and a process-scoped
 *      git credential helper. The helper is wired via `GIT_CONFIG_*`
 *      env vars (git ≥2.31 feature) so we never touch the host's
 *      `~/.gitconfig` and the wiring is automatically scoped to the
 *      child process — no global mutation, no cleanup required.
 *
 *   The credential helper itself is keyed to `https://github.com` so
 *   pushes to other hosts (GitLab, internal Gitea) don't accidentally
 *   pick up the GitHub token. It emits `username=x-access-token` +
 *   `password=$GH_TOKEN`, which is GitHub's standard PAT-over-HTTPS
 *   pattern and works for both classic PATs and short-lived OAuth
 *   user-to-server tokens.
 */
import type { AppConfig } from './types.js';

export interface ResolvedOAuthAppCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Pick the OAuth App credentials that should be used to refresh stored
 * user tokens. Mirrors `getOAuthCredentials` in `routes/github-oauth.ts`
 * so refresh behaves the same regardless of caller.
 *
 * Precedence:
 *   1. `config.personalOAuth` — the standalone "Sign in with GitHub"
 *      OAuth App registration (decoupled from the reviewer GitHub App).
 *   2. `config.githubApp` — back-compat for installs that completed the
 *      App-manifest flow before the personal/reviewer split, where the
 *      same App registration was used for both.
 *   3. `null` — no OAuth credentials configured. Stored tokens within
 *      the refresh safety window will return `null` from
 *      `getActiveAccessToken` since refresh is impossible. PATs (which
 *      have a sentinel ~100-year expiry) keep working — they never
 *      reach the refresh path.
 */
export function resolveOAuthAppCredentials(
  config: Pick<AppConfig, 'personalOAuth' | 'githubApp'>,
): ResolvedOAuthAppCredentials | null {
  const personal = config.personalOAuth;
  if (personal?.clientId && personal?.clientSecret) {
    return { clientId: personal.clientId, clientSecret: personal.clientSecret };
  }
  const app = config.githubApp;
  if (app?.clientId && app?.clientSecret) {
    return { clientId: app.clientId, clientSecret: app.clientSecret };
  }
  return null;
}

/**
 * Inline shell snippet git executes when asked for credentials. Emits
 * `username=x-access-token` + `password=<GH_TOKEN value>` only when
 * `GH_TOKEN` is non-empty in the spawned process env. We deliberately
 * dereference the env var inside the snippet rather than baking the
 * token literal into the gitconfig value — this:
 *
 *   - Keeps the token off git's reflog / `git config --get` output
 *     (the helper string is what's stored, not the token itself).
 *   - Ensures rotation is automatic: if the wrapping process refreshes
 *     `GH_TOKEN` mid-session, the next push picks up the new value
 *     without any reconfiguration.
 *   - Naturally degrades to "no helper" if `GH_TOKEN` is unset, instead
 *     of erroring with a stale credential.
 */
const GIT_CREDENTIAL_HELPER_SNIPPET =
  '!f() { test -n "$GH_TOKEN" && printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"; }; f';

/**
 * Mutate a spawn env record in place to wire the supplied GitHub token
 * into the child process. No-op when `token` is falsy so callers can
 * unconditionally invoke this — the "user has no connection" case stays
 * a single branch upstream.
 *
 * Sets:
 *   - `GH_TOKEN` — what `gh` CLI looks for first.
 *   - `GITHUB_TOKEN` — what most other tooling (Actions, npm, Stripe
 *     CLI, etc.) looks for. Setting both is harmless: when both are
 *     present `gh` prefers `GH_TOKEN`.
 *   - `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`
 *     — git's process-scoped config-injection mechanism. We append to
 *     any existing count so callers can layer additional config without
 *     this helper clobbering it. Scoped to `https://github.com` so
 *     other hosts are unaffected.
 */
export function applyGithubSpawnCredentials(
  env: NodeJS.ProcessEnv,
  token: string | null | undefined,
): void {
  if (!token) return;

  env.GH_TOKEN = token;
  env.GITHUB_TOKEN = token;

  // Append a credential helper entry to whatever GIT_CONFIG_* may
  // already be set in the env (rare in practice, but cheap to support
  // and avoids future surprises if another caller starts using this
  // mechanism). Numeric parse is defensive: a malformed pre-existing
  // count string is treated as 0 so we still install our helper.
  const prevCountRaw = env.GIT_CONFIG_COUNT;
  const prevCount = (() => {
    if (typeof prevCountRaw !== 'string') return 0;
    const n = Number.parseInt(prevCountRaw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  })();
  const idx = prevCount;
  env.GIT_CONFIG_COUNT = String(prevCount + 1);
  env[`GIT_CONFIG_KEY_${idx}`] = 'credential.https://github.com.helper';
  env[`GIT_CONFIG_VALUE_${idx}`] = GIT_CREDENTIAL_HELPER_SNIPPET;
}
