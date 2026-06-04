/**
 * repo-aware-token.ts — Pick the org Owner whose GitHub token can
 * actually reach a given `<owner>/<repo>` on github.com.
 *
 * Why this exists:
 *
 * System-spawned sessions (PR reviewer, autonomous probe, webhook fan-out,
 * cron, heartbeat) intentionally leave `sessions.owner_user_id` NULL so
 * the row is visible across the org. Token resolution for those flows
 * historically fell back to a "first user wins" org-owner shortcut —
 * `listUsers()[0]`, the user with the earliest `created_at` (since
 * removed).
 *
 * That "first user wins" shortcut produces the WRONG token whenever the
 * first user's GitHub OAuth/PAT was issued with a narrower scope (or
 * for a different GitHub App installation) than a newer Owner's. The
 * symptom is loud: `git clone https://github.com/<owner>/<repo>.git`
 * fails with `could not read Username for 'https://github.com':
 * terminal prompts disabled` because the injected basic-auth header
 * gets a 401 from GitHub and `GIT_TERMINAL_PROMPT=0` prevents the
 * interactive fallback. Every reviewer session for the affected repos
 * then dies at clone time, gets cleaned up by `ReviewerCleanup`, and
 * the PR is silently never reviewed.
 *
 * This module solves it by treating "org owner" as a capability, not a
 * row index. For a given `<owner>/<repo>`, walk all Owner-role users in
 * `created_at` order, resolve each user's GitHub access token via the
 * existing OAuth/PAT chain, and probe
 * `GET https://api.github.com/repos/<owner>/<repo>`. The first user
 * whose probe returns 2xx is returned. If no Owner can see the repo,
 * this returns `null` — there is **no org-owner fallback**. The caller
 * must hard-fail / surface the missing-token error rather than borrow an
 * arbitrary user's GitHub identity.
 *
 * Probes are cached per-repo for 5 minutes to avoid hammering the
 * GitHub REST API. The cache stores `null` (no Owner with access)
 * just like a positive hit so we don't re-probe on every reviewer
 * dispatch when the install is genuinely misconfigured.
 */

import config from './config.js';
import { getActiveOrgId } from './orgs.js';
import { listMembersForOrg } from './memberships-store.js';
import { resolveUserGithubToken } from './skill-credentials-github.js';
import { resolveOAuthAppCredentials } from './spawn-github-credentials.js';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const PROBE_TIMEOUT_MS = 5000;
const PROBE_USER_AGENT = 'agent-hub-repo-probe/1';

interface CacheEntry {
  userId: string | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export interface ResolveOpts {
  /** Override the active org (tests). */
  orgId?: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Override Date.now (tests). */
  now?: () => number;
  /** Bypass the cache (tests / nudge tools). */
  skipCache?: boolean;
}

/**
 * Return the user id of an Owner-role user whose stored GitHub token
 * can read `<owner>/<repo>`. Returns `null` when no Owner probes 2xx —
 * there is no org-owner fallback; the caller must hard-fail / surface
 * the missing-token error.
 *
 * Per-repo result is cached for {@link CACHE_TTL_MS}. Callers that
 * mutate Owner GitHub connections (Settings → reconnect) should call
 * {@link resetRepoAccessCache} to drop the stale answer. Test code
 * pass `skipCache: true` to force a re-probe.
 */
export async function resolveOwnerWithRepoAccess(
  githubRepo: string | null | undefined,
  opts: ResolveOpts = {},
): Promise<string | null> {
  const repo = (githubRepo ?? '').trim();
  // Sanity-check the repo string. Skip the probe entirely (and don't
  // cache) on garbage input — a stray scheme prefix or empty string
  // would otherwise dump a permanent miss into the cache.
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    return null;
  }

  const now = (opts.now ?? Date.now)();
  if (!opts.skipCache) {
    const hit = cache.get(repo);
    if (hit && hit.expiresAt > now) {
      // Positive hit → the Owner who probed 200. Cached miss → null
      // (no org-owner fallback).
      return hit.userId;
    }
  }

  let orgId: string;
  try {
    orgId = opts.orgId ?? getActiveOrgId();
  } catch {
    return null;
  }

  let owners: Array<{ userId: string }> = [];
  try {
    owners = listMembersForOrg(orgId)
      .filter((m) => m.role === 'Owner')
      .map((m) => ({ userId: m.userId }));
  } catch {
    return null;
  }

  if (owners.length === 0) {
    return null;
  }

  const oauthCreds = resolveOAuthAppCredentials(config);
  const fetchImpl = opts.fetchImpl ?? fetch;
  let resolvedUserId: string | null = null;

  for (const owner of owners) {
    let token: string | null = null;
    try {
      token = await resolveUserGithubToken(owner.userId, { oauthCredentials: oauthCreds });
    } catch {
      // resolveUserGithubToken is already best-effort; treat as no-token.
      token = null;
    }
    if (!token) continue;

    let ok = false;
    try {
      ok = await probeRepoAccess(fetchImpl, token, repo);
    } catch {
      // Network error / abort — treat as no-access and try the next user.
      ok = false;
    }
    if (ok) {
      resolvedUserId = owner.userId;
      break;
    }
  }

  // Cache the result (positive or null) so we don't re-probe every dispatch.
  // A future Settings → reconnect that calls `resetRepoAccessCache()`
  // immediately re-probes from scratch.
  cache.set(repo, { userId: resolvedUserId, expiresAt: now + CACHE_TTL_MS });

  return resolvedUserId;
}

async function probeRepoAccess(
  fetchImpl: typeof fetch,
  token: string,
  repo: string,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${repo}`, {
      headers: {
        Authorization: `token ${token}`,
        'User-Agent': PROBE_USER_AGENT,
        Accept: 'application/vnd.github+json',
      },
      signal: controller.signal,
    });
    return r.ok;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drop the per-repo cache. Wire this into Settings → GitHub reconnect /
 * disconnect so a user who just changed their token doesn't have to
 * wait out the 5-minute TTL to see reviewer dispatches start using it.
 *
 * Also exposed for tests that seed/tear down Owner memberships between
 * fixtures.
 */
export function resetRepoAccessCache(): void {
  cache.clear();
}
