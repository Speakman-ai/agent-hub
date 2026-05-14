/**
 * github-remote-owner.ts — derive the GitHub `{owner, repo}` for a
 * project workspace by reading its `origin` remote.
 *
 * Why this exists:
 *   The spawn-side credential resolver
 *   (`resolveGithubSpawnToken`) wants to know which GitHub org/user
 *   owns the repo a session is operating on, so it can prefer a
 *   GitHub-App installation token (`ghs_…`) bound to that org over the
 *   session owner's personal OAuth token (`gho_…`). The webhook handler
 *   knows the repo full_name; interactive sessions don't carry that
 *   hint, but every project has a `cwd` and (almost always) a configured
 *   `origin` remote — so we can recover the info from git itself.
 *
 * Failure mode is "no hint": callers fall back to the existing
 * per-user OAuth path so a missing remote / non-GitHub remote / brand
 * new scaffold without an origin never blocks a spawn.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface RepoOwner {
  owner: string;
  repo: string;
}

interface CacheEntry {
  value: RepoOwner | null;
  expiry: number;
}

// Cache parsed origins per cwd for 5 minutes. The git command is cheap
// but every spawn calls this, and origins effectively never change for
// the lifetime of a session — caching keeps the hot path off the disk.
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

/**
 * Parse a git remote URL (https://, ssh, or `git@github.com:…`) into
 * `{owner, repo}`. Returns `null` for non-GitHub remotes, malformed
 * URLs, or empty input.
 *
 * Exported so tests can pin the parser without spawning git.
 */
export function parseGithubRemote(raw: string | null | undefined): RepoOwner | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // SSH form: git@github.com:owner/repo(.git)?
  const ssh = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (ssh) {
    return { owner: ssh[1]!, repo: ssh[2]! };
  }

  // HTTPS form: https://[token@]github.com/owner/repo(.git)?
  const https = trimmed.match(
    /^https?:\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/.*)?$/,
  );
  if (https) {
    return { owner: https[1]!, repo: https[2]! };
  }

  return null;
}

/**
 * Run `git -C <cwd> remote get-url origin` and parse the result.
 * Returns `null` on any failure (no remote, non-git dir, non-GitHub
 * origin, command timeout). Cached per-cwd for 5 minutes.
 *
 * `exec` is injectable for tests; production callers pass nothing and
 * get the real `execFile`.
 */
export async function getRepoOwnerForCwd(
  cwd: string | null | undefined,
  exec: (
    cmd: string,
    args: string[],
    opts: { cwd: string; timeout?: number },
  ) => Promise<{ stdout: string; stderr: string }> = (cmd, args, opts) =>
    execFileAsync(cmd, args, opts),
): Promise<RepoOwner | null> {
  if (!cwd || typeof cwd !== 'string') return null;

  const now = Date.now();
  const cached = cache.get(cwd);
  if (cached && cached.expiry > now) {
    return cached.value;
  }

  let value: RepoOwner | null = null;
  try {
    const result = await exec('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      cwd,
      timeout: 2000,
    });
    value = parseGithubRemote(result.stdout);
  } catch {
    // No remote configured, not a git repo, non-GitHub origin — all
    // are "no hint" outcomes. The credential resolver falls through to
    // the per-user OAuth path.
    value = null;
  }

  cache.set(cwd, { value, expiry: now + CACHE_TTL_MS });
  return value;
}

/** Test hook: clear the per-cwd cache. */
export function clearRepoOwnerCache(): void {
  cache.clear();
}
