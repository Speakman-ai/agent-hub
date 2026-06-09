/**
 * runner-repo-visibility.ts — detect the gated repo's GitHub visibility so the
 * Finalize runner can pick the GitHub-parity resource tier automatically.
 *
 * Why this exists: the gate runner defaults to the stricter `ubuntu-private`
 * tier (2 vCPU / 8 GB) because being faster than the GitHub-hosted runner
 * launders timing-sensitive failures into false-greens (PR surveytracker#1001).
 * For a PUBLIC repo GitHub gives 4 vCPU / 16 GB, so the conservative default
 * runs the gate slower than GitHub — safe, but a source of conservative
 * false-reds until an operator opts up. By reading the repo's actual visibility
 * we hand `ubuntu-public` to public repos and `ubuntu-private` to private ones
 * with no manual config, while keeping the stricter default whenever we can't
 * tell (the safe direction).
 *
 * Everything here is best-effort: any failure (no remote, non-GitHub origin, no
 * gh / no token, network error, repo not found) resolves to `'unknown'`, which
 * the profile resolver maps back to the stricter default. A detection miss can
 * therefore only run the gate at-or-slower-than GitHub, never faster.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getRepoOwnerForCwd, type RepoOwner } from '../github-remote-owner.js';
import { resolveGitHubToken } from '../github-skill-auth-resolve.js';
import type { RepoVisibility } from './runner-resource-profile.js';

const execFileAsync = promisify(execFile);

type ExecFn = (
  cmd: string,
  args: string[],
  opts: { timeout?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

interface CacheEntry {
  value: RepoVisibility;
  expiry: number;
}

// Cache per `owner/repo` slug: every matrix shard of a run hits the same repo,
// and a repo's visibility effectively never flips mid-run. Short TTL so a repo
// flipped public<->private is picked up on the next run. `'unknown'` is cached
// too (with the same TTL) so a transient gh failure doesn't re-probe per shard.
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

/**
 * Parse the `visibility` field returned by `gh api repos/{owner}/{repo}` into a
 * `RepoVisibility`. GitHub reports `public`, `private`, or `internal`; `internal`
 * (enterprise org-wide) sizes like a private repo on GitHub Actions, so we fold
 * it into `'private'` — the stricter side. Anything else is `'unknown'`.
 *
 * Exported so tests can pin the mapping without spawning gh.
 */
export function parseVisibility(raw: string | null | undefined): RepoVisibility {
  const v = raw?.trim().toLowerCase();
  if (v === 'public') return 'public';
  if (v === 'private' || v === 'internal') return 'private';
  return 'unknown';
}

export interface DetectRepoVisibilityArgs {
  /** Worktree whose `origin` remote identifies the gated repo. */
  worktreePath: string | null | undefined;
  /** Env carrying GH_TOKEN / GITHUB_TOKEN for the gh call (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests — resolve `{owner, repo}` from the worktree's origin. */
  getRepoOwner?: (cwd: string | null | undefined) => Promise<RepoOwner | null>;
  /** Injectable for tests — run `gh`. Production passes nothing (real execFile). */
  exec?: ExecFn;
}

/**
 * Detect the gated repo's GitHub visibility. Returns `'public'` / `'private'`
 * when resolvable, else `'unknown'`. Cached per `owner/repo` slug.
 */
export async function detectRepoVisibility(
  args: DetectRepoVisibilityArgs,
): Promise<RepoVisibility> {
  const env = args.env ?? process.env;
  const getRepoOwner = args.getRepoOwner ?? ((cwd) => getRepoOwnerForCwd(cwd));
  const exec: ExecFn = args.exec ?? ((cmd, a, o) => execFileAsync(cmd, a, o));

  const owner = await getRepoOwner(args.worktreePath);
  if (!owner) return 'unknown';

  const slug = `${owner.owner}/${owner.repo}`;
  const now = Date.now();
  const cached = cache.get(slug);
  if (cached && cached.expiry > now) {
    return cached.value;
  }

  let value: RepoVisibility = 'unknown';
  try {
    // A token isn't strictly required for public repos, but private/internal
    // repos return 404 unauthenticated — so feed gh whatever token we have.
    const { token } = resolveGitHubToken(env);
    const ghEnv: NodeJS.ProcessEnv = { ...env };
    if (token) ghEnv.GH_TOKEN = token;
    const result = await exec('gh', ['api', `repos/${slug}`, '--jq', '.visibility'], {
      timeout: 5000,
      env: ghEnv,
    });
    value = parseVisibility(result.stdout);
  } catch {
    // gh missing, not authenticated, repo not found, network/timeout — all are
    // "no hint" outcomes. The resolver falls back to the stricter default.
    value = 'unknown';
  }

  cache.set(slug, { value, expiry: now + CACHE_TTL_MS });
  return value;
}

/** Test hook: clear the per-slug visibility cache. */
export function clearRepoVisibilityCache(): void {
  cache.clear();
}
