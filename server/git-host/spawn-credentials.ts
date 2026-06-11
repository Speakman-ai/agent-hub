/**
 * spawn-credentials.ts — git credential helper for the Hub's own smart-
 * HTTP remotes, injected into every agent spawn. Exact parallel of
 * `applyGithubSpawnCredentials` (spawn-github-credentials.ts) but scoped
 * to the Hub's origin(s) instead of `https://github.com`.
 *
 * The helper snippet dereferences `$AGENT_HUB_API_KEY` at run time —
 * already injected into every spawn env (global key via config.ts, or a
 * per-session `ahub_*` spawn-creds token), and `ahub_*` keys verify
 * through the same `verifyApiKey` chain the git transport's Basic auth
 * uses (server/git-host/auth.ts). So a spawned CLI can `git push` to
 * `http(s)://<hub>/git/<projectId>.git` with no extra setup.
 *
 * Two origins may be registered: the externally-reachable base
 * (`resolveAgentHubApiBaseForSpawn` — publicUrl/agentHubUrl when set) and
 * the loopback base, because worktrees may carry either URL shape as
 * their remote. Harmless for non-hosted projects — the helper only
 * matches the Hub origins.
 */

import type { AppConfig } from '../types.js';
import { getActualPort } from '../server-port.js';
import { resolveAgentHubApiBaseForSpawn } from '../config.js';
import { appendGitConfigEntry } from '../spawn-github-credentials.js';

const HELPER_SNIPPET =
  '!f() { test -n "$AGENT_HUB_API_KEY" && printf "username=agent-hub\\npassword=%s\\n" "$AGENT_HUB_API_KEY"; }; f';

/** Origin (scheme://host[:port]) of a URL, or null when unparsable. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Mutate a spawn env record to add a git credential helper for the
 * Hub's smart-HTTP git remotes. Call alongside
 * `applyGithubSpawnCredentials` (after `applyReviewerSpawnIsolation`,
 * which only clears github.com helpers — Hub origins are unaffected by
 * the scrub). No-op when no origin can be resolved.
 */
export function applyAgentHubGitSpawnCredentials(env: NodeJS.ProcessEnv, cfg: AppConfig): void {
  const origins = new Set<string>();
  const spawnBase = originOf(resolveAgentHubApiBaseForSpawn(cfg));
  if (spawnBase) origins.add(spawnBase);
  try {
    origins.add(`http://127.0.0.1:${getActualPort()}`);
  } catch {
    // port not bound yet (tests) — spawnBase alone is fine
  }
  for (const origin of origins) {
    appendGitConfigEntry(env, `credential.${origin}.helper`, HELPER_SNIPPET);
  }
}
