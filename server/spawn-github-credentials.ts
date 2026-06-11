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
import { mkdirSync } from 'fs';
import path from 'path';
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

  // Append a credential helper entry. When `applyReviewerSpawnIsolation`
  // ran first (the standard spawn flow in `chat.ts`), an empty-value
  // helper entry is already at index 0, which clears any helper inherited
  // from the host's `~/.gitconfig` — so this entry is the ONLY helper
  // git tries on the next push. When this function is called standalone
  // (e.g. tests, or future non-spawn callers), the empty-helper protection
  // is absent; callers that need it must invoke `applyReviewerSpawnIsolation`
  // first, exactly as `chat.ts` does.
  appendGitConfigEntry(env, 'credential.https://github.com.helper', GIT_CREDENTIAL_HELPER_SNIPPET);
}

/**
 * Reviewer-agent isolation directory name (under `config.dataDir`).
 *
 * Kept as a single source-of-truth constant so both the spawn-side
 * application and any startup-time `mkdirSync` agree on the path.
 */
export const REVIEWER_GH_CONFIG_DIR_NAME = 'reviewer-gh-config';

/**
 * Resolve the reviewer-agent `GH_CONFIG_DIR`. Returns an absolute path
 * inside `config.dataDir`. Pure — does not touch the filesystem; pair
 * with `ensureReviewerGhConfigDir` at startup if you want the directory
 * to exist before any reviewer spawn.
 */
export function resolveReviewerGhConfigDir(config: Pick<AppConfig, 'dataDir'>): string {
  return path.join(config.dataDir, REVIEWER_GH_CONFIG_DIR_NAME);
}

/**
 * Ensure the reviewer-isolation `GH_CONFIG_DIR` exists. Idempotent.
 * Call once at server startup so the first reviewer spawn doesn't race
 * the directory creation. `gh` falls back to printing a not-logged-in
 * status when the config dir exists but contains no `hosts.yml`, which
 * is exactly the behaviour we want.
 */
export function ensureReviewerGhConfigDir(config: Pick<AppConfig, 'dataDir'>): string {
  const dir = resolveReviewerGhConfigDir(config);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Apply spawn-env GitHub-identity isolation. Despite the historical
 * name ("reviewer" isolation), this is invoked on EVERY agent spawn —
 * reviewer and non-reviewer roles alike. The naming is preserved
 * because the function originated to fix the reviewer-pipeline identity
 * leak; option-A universal application (card 1f9c8215-…) extended it
 * to close the symmetric leak on non-reviewer spawns where dev/author/
 * lead agents could post formal PR reviews under the session owner's
 * OAuth token.
 *
 * Four effects:
 *
 *   1. `GH_CONFIG_DIR` → an empty Hub-managed directory under
 *      `config.dataDir`. This severs `gh`'s fallback to
 *      `~/.config/gh/hosts.yml`, so a spawned agent never inherits the
 *      host operator's `gh auth login` identity. (Historical leak: PR
 *      reviews attributed to whoever happened to be logged into `gh`
 *      on the box.)
 *
 *   2. `AGENT_HUB_REVIEWER_LOCK=1` — a sentinel the GitHub skill's
 *      `_common.sh` reads to disable its `gh auth status` host-auth
 *      fallback (PR #612 leak). Formal `gh pr review` is disabled
 *      outright in `gh-pr.sh::cmd_review`: the reviewer is an in-session
 *      advisor that emits its verdict in session output, so Agent Hub
 *      never posts a formal review to GitHub under any identity. Applied
 *      universally so non-reviewer spawns also cannot post formal reviews
 *      under the session owner's account.
 *
 *   3. Scrubs `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, and
 *      `GITHUB_ENTERPRISE_TOKEN` from the env. `buildSpawnEnv` clones
 *      `process.env` wholesale, so any token the operator exported in
 *      the shell that started the Hub (or PM2/systemd ambient env)
 *      would otherwise survive into the spawn even when
 *      `resolveGithubSpawnToken` correctly returns `null`. `gh` reads
 *      `GH_TOKEN` at the highest priority — ahead of `GH_CONFIG_DIR` —
 *      so the config-dir isolation alone is insufficient. Callers must
 *      invoke this function BEFORE `applyGithubSpawnCredentials` so
 *      the resolved spawn token (bot for reviewers, per-user OAuth/PAT
 *      for everyone else) is re-set by the credential helper after the
 *      scrub. Net effect for non-reviewer spawns: `git push` / `gh pr
 *      create` continue to authenticate as the human, while the
 *      `gh pr review` write path is blocked by the lock sentinel.
 *
 *   4. Installs a process-scoped empty git credential helper for
 *      `https://github.com` via `GIT_CONFIG_*` (process-scoped config
 *      with the highest precedence in git's config-merge order). Git
 *      accumulates `credential.<url>.helper` entries from every config
 *      source — system, global (`~/.gitconfig`), local, and env — and
 *      tries each helper in order until one returns credentials. An
 *      empty-string entry **clears the accumulated list** so any
 *      helpers inherited from the host operator's `~/.gitconfig`
 *      (notably `!gh auth git-credential`, written by
 *      `gh auth setup-git`) are dropped before our own helper runs.
 *      Without this, even a fully-scrubbed env can still authenticate
 *      via the host's gh credential chain. Order matters:
 *      `applyReviewerSpawnIsolation` writes the empty entry at index 0;
 *      `applyGithubSpawnCredentials` appends the working bot/user
 *      helper at index 1 (or higher). Net: with no token injected,
 *      `git push` to github.com fails with "could not read Username";
 *      with a token, only the injected helper runs. Closed PR #612
 *      leak (reviewer pushed `review/pr-609` + opened #612 as
 *      `speakmanra` because host gh credential helper was reachable).
 *
 * Caller should pre-create the directory at startup via
 * `ensureReviewerGhConfigDir(config)`. Idempotent on env mutation.
 */
export function applyReviewerSpawnIsolation(
  env: NodeJS.ProcessEnv,
  config: Pick<AppConfig, 'dataDir'>,
): void {
  env.GH_CONFIG_DIR = resolveReviewerGhConfigDir(config);
  env.AGENT_HUB_REVIEWER_LOCK = '1';
  // Scrub any inherited GitHub token vars. `gh` reads GH_TOKEN at
  // higher priority than GH_CONFIG_DIR, so these must be explicitly
  // removed to prevent host-env tokens leaking into reviewer spawns.
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_ENTERPRISE_TOKEN;
  delete env.GITHUB_ENTERPRISE_TOKEN;
  // Install a process-scoped empty `credential.https://github.com.helper`
  // BEFORE any working helper. Per git's credential-helper merge rules,
  // an empty value clears the list of helpers accumulated from all
  // earlier config sources (system / global / local). This neutralises
  // the host operator's `gh auth setup-git` helper so a spawn with no
  // token cannot piggy-back on host gh auth. `applyGithubSpawnCredentials`
  // appends its working helper after this entry; git then tries that
  // helper (and only that helper) on the next push.
  appendGitConfigEntry(env, 'credential.https://github.com.helper', '');
}

/**
 * Apply the reviewer-role-only "full lock" marker. Distinct from the
 * universal `AGENT_HUB_REVIEWER_LOCK` (which is set on EVERY spawn and
 * only blocks the `gh pr review` write subcommand because that is the
 * sole identity-attribution surface for formal PR reviews).
 *
 * `AGENT_HUB_REVIEWER_ROLE_LOCK=1` is set ONLY when `agent.role ===
 * 'reviewer'`. It instructs the GitHub skill scripts to refuse a much
 * broader write surface:
 *
 *   - `gh pr create` / `merge` / `close` / `ready` / `edit` — blocked
 *     unconditionally (these create commits or mutate PR state under
 *     the spawn's GitHub identity).
 *   - `gh api … --method POST|PUT|PATCH|DELETE` — denied for any path
 *     outside the allowlist:
 *         POST /repos/<owner>/<repo>/pulls/<n>/reviews
 *         POST /repos/<owner>/<repo>/issues/<n>/comments
 *     These two surfaces are the legitimate review-write paths that a
 *     reviewer agent legitimately needs (formal review submission + PR
 *     conversation comments).
 *   - `gh api graphql` — denied wholesale (graphql mutations have
 *     free-form bodies and can't be allowlisted by path).
 *
 * Why this exists (defense-in-depth):
 *   The reviewer-spawn env is already scrubbed of GitHub tokens by
 *   `applyReviewerSpawnIsolation`, and `resolveGithubSpawnToken`
 *   deliberately returns the App installation token (or `null` when no
 *   App is installed) for reviewer role — it never forwards a per-user
 *   OAuth. The role-lock assumes a *future* change accidentally
 *   reintroduces a user token into the spawn env (e.g. someone adds a
 *   new fallback branch to `resolveGithubSpawnToken`, or a future
 *   helper forwards a user token to reviewers) and makes sure the spawn
 *   still cannot use it to forge commits or open PRs — the failure mode
 *   documented in mcsteen/surveytracker PR #622 where
 *   `agent-hub-reviewer-main[bot]` opened a PR with bot-authored commits.
 *
 * Pure env mutation; no filesystem effect. Call AFTER
 * `applyReviewerSpawnIsolation` (which sets the universal lock).
 */
export function applyReviewerRoleLock(env: NodeJS.ProcessEnv, role: string | undefined): void {
  if (role === 'reviewer') {
    env.AGENT_HUB_REVIEWER_ROLE_LOCK = '1';
  }
}

/**
 * Append a single `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` entry
 * to the env. Defensive numeric parse on `GIT_CONFIG_COUNT` so a
 * malformed inherited value doesn't clobber prior entries; idempotent
 * on the index bookkeeping.
 *
 * Exported so the Agent Hub git-host credential helper
 * (`server/git-host/spawn-credentials.ts`) appends with the same
 * semantics — preserves the precedence ordering described in
 * `applyReviewerSpawnIsolation` effect (4).
 */
export function appendGitConfigEntry(env: NodeJS.ProcessEnv, key: string, value: string): void {
  const prevCountRaw = env.GIT_CONFIG_COUNT;
  const prevCount = (() => {
    if (typeof prevCountRaw !== 'string') return 0;
    const n = Number.parseInt(prevCountRaw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  })();
  const idx = prevCount;
  env.GIT_CONFIG_COUNT = String(prevCount + 1);
  env[`GIT_CONFIG_KEY_${idx}`] = key;
  env[`GIT_CONFIG_VALUE_${idx}`] = value;
}

// NOTE — `selectGithubSpawnToken` was removed.
//
// It was the synchronous-precursor policy function for picking the
// GitHub credential to inject into a spawned agent env. After the
// "user GitHub tokens + Hub account in setup" rewrite, ALL production
// spawn paths route through the async `resolveGithubSpawnToken` in
// `github-spawn-token-resolver.ts`, which encapsulates the same
// reviewer / non-reviewer / autonomous-dispatch rules plus the
// repo-aware App-installation chain.
//
// The helper was kept exported during the transition (so existing
// tests would still pass) but it had no production callers — `chat.ts`
// only imports `applyReviewerSpawnIsolation`, `applyGithubSpawnCredentials`,
// and `applyReviewerRoleLock` from this module. The reviewer (PR #1069
// review) flagged it as a "dead-code trap": a future contributor adding
// a new spawn path would be tempted to reach for the synchronous,
// well-documented function and silently reintroduce the pre-fix
// behaviour (no installation-token preference, no autonomous-dispatch
// guard).
//
// Removed in autofix(review): drop selectGithubSpawnToken (commit
// addressing the M1 finding). If you need to pick a token for a new
// spawn site, call `resolveGithubSpawnToken` — it is the only correct
// entry point.
