/**
 * origin-guard.ts — Finalize §8 push-target lock for GitHub-hosted projects.
 *
 * Why this exists:
 *   The GitHub push path (push-and-create-pr.ts) runs
 *   `git push -u origin <branch>` + `gh pr create` against whatever the
 *   session worktree's `origin` remote happens to be. A session clone
 *   inherits its origin from the project checkout (`server/worktree.ts`),
 *   so a tampered / mis-configured / stale origin would otherwise let a
 *   session ship commits and PRs to an ARBITRARY repo with no warning.
 *
 *   The Agent Hub-hosted path already refuses to push when the worktree
 *   origin is not the Hub's bare repo (push-and-create-pr-agenthub.ts).
 *   This module is the symmetric guard for the GitHub path: the push must
 *   land on the project's own configured GitHub repository.
 *
 * Contract — there is NO fail-open path. Every GitHub-path push is locked
 * to a trusted expected repo, resolved in priority order:
 *   1. The project's config-declared repo — `githubRepo` (`owner/repo`) or
 *      `repoUrl` (HTTPS clone URL). Most trusted: it lives in the Hub's
 *      project config, not in a git config a worktree could rewrite.
 *   2. Fallback: the project checkout's (`project.cwd`) `origin` remote.
 *      This is the source the session clone was made from, so it still
 *      anchors the push to "the repo this project points at" rather than
 *      letting it go anywhere.
 *   3. If neither resolves to a GitHub repo, the push is HARD-REFUSED — a
 *      project whose target cannot be verified must not ship to an
 *      arbitrary origin.
 * Once an expected repo is established, the worktree origin's owner/repo
 * MUST match it (case-insensitively — GitHub owner/repo are
 * case-insensitive). A mismatch or a non-GitHub / unparseable worktree
 * origin throws.
 */
import { parseGithubRemote, type RepoOwner } from '../github-remote-owner.js';
import { execGit } from './push-and-create-pr.js';
import type { Project } from '../types.js';

const GET_ORIGIN_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 10 * 1024 * 1024;

/** Where the trusted expected repo was resolved from (for logging/diagnostics). */
export type ExpectedRepoSource = 'config' | 'project-checkout';

/** `owner/repo` lower-cased for case-insensitive comparison. */
function repoKey(r: RepoOwner): string {
  return `${r.owner.toLowerCase()}/${r.repo.toLowerCase()}`;
}

/**
 * Resolve the project's CONFIG-declared canonical GitHub `{owner, repo}`.
 * Prefers the explicit `githubRepo` (`owner/repo`) field, falling back to
 * parsing the `repoUrl` HTTPS clone URL. Returns `null` when neither is set
 * or neither parses as a GitHub repo — callers then derive the fallback
 * anchor from the project checkout.
 *
 * Exported for tests.
 */
export function resolveProjectExpectedRepo(
  project: Pick<Project, 'githubRepo' | 'repoUrl'>,
): RepoOwner | null {
  const fromSlug = parseRepoSlug(project.githubRepo);
  if (fromSlug) return fromSlug;
  return parseGithubRemote(project.repoUrl);
}

/** Parse an `owner/repo` slug (the `githubRepo` field). `null` on miss. */
function parseRepoSlug(value: string | null | undefined): RepoOwner | null {
  if (!value) return null;
  const match = value.trim().match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]! };
}

/**
 * Read the project checkout's (`cwd`) `origin` remote and parse it into a
 * GitHub `{owner, repo}`. This is the fallback trusted anchor when the
 * project declares no canonical repo in its config. Returns `null` on any
 * failure (no cwd, no origin, non-git dir, non-GitHub origin) — the caller
 * then hard-refuses rather than failing open.
 */
async function resolveProjectCheckoutRepo(
  cwd: string | null | undefined,
  env: NodeJS.ProcessEnv | undefined,
): Promise<RepoOwner | null> {
  if (!cwd) return null;
  try {
    const { stdout } = await execGit('git', ['remote', 'get-url', 'origin'], {
      cwd,
      env,
      timeout: GET_ORIGIN_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return parseGithubRemote(stdout.trim());
  } catch {
    return null;
  }
}

export type OriginGuardDecision =
  | { ok: true; reason: 'match'; expected: RepoOwner; actual: RepoOwner }
  | {
      ok: false;
      reason: 'mismatch' | 'unparseable-origin' | 'no-trusted-repo';
      expected: RepoOwner | null;
      message: string;
    };

/**
 * Pure decision: given a trusted `expected` repo (or `null` when none could
 * be resolved), does `originUrl` (the worktree's `origin` remote) point at
 * it? No I/O — exported for tests.
 *
 * A `null` expected is a HARD REFUSAL (`no-trusted-repo`), never a skip:
 * without a verifiable target the push must not proceed.
 */
export function evaluateOriginGuard(
  projectId: string,
  expected: RepoOwner | null,
  originUrl: string | null | undefined,
): OriginGuardDecision {
  if (!expected) {
    return {
      ok: false,
      reason: 'no-trusted-repo',
      expected: null,
      message:
        `github push refused: project ${projectId} has no canonical repo ` +
        `(githubRepo/repoUrl) configured and its project checkout has no resolvable ` +
        `GitHub origin, so the push target cannot be verified. Set the project's repo ` +
        `before finalizing.`,
    };
  }

  const actual = parseGithubRemote(originUrl);
  if (!actual) {
    return {
      ok: false,
      reason: 'unparseable-origin',
      expected,
      message:
        `github push refused: worktree origin (${(originUrl ?? '').trim() || '<unset>'}) ` +
        `is not a GitHub remote for project ${projectId}; expected ` +
        `${expected.owner}/${expected.repo}. Recreate the session worktree from the project's configured repo.`,
    };
  }

  if (repoKey(actual) !== repoKey(expected)) {
    return {
      ok: false,
      reason: 'mismatch',
      expected,
      message:
        `github push refused: worktree origin (${actual.owner}/${actual.repo}) ` +
        `is not the configured repo for project ${projectId} (${expected.owner}/${expected.repo}). ` +
        `A session may only push to its own project's repository.`,
    };
  }

  return { ok: true, reason: 'match', expected, actual };
}

/**
 * Enforce the push-target lock for the GitHub path: resolve the trusted
 * expected repo (config first, project checkout as fallback) and throw
 * unless the worktree's `origin` matches it. Throws when no trusted repo can
 * be resolved at all — there is no fail-open path. Returns a one-line
 * summary for the caller to log.
 *
 * `env` is threaded through so the `git remote get-url` reads run with the
 * same scrubbed/credential-isolated environment as the push itself.
 */
export async function assertWorktreeOriginMatchesProject(
  project: Pick<Project, 'id' | 'cwd' | 'githubRepo' | 'repoUrl'>,
  worktreePath: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<{ expectedSource: ExpectedRepoSource; summary: string }> {
  // 1. Most trusted: the Hub project config.
  let expected = resolveProjectExpectedRepo(project);
  let expectedSource: ExpectedRepoSource = 'config';
  // 2. Fallback: the project checkout's origin (what this project points at).
  if (!expected) {
    expected = await resolveProjectCheckoutRepo(project.cwd, env);
    expectedSource = 'project-checkout';
  }

  let originUrl: string | null = null;
  try {
    const { stdout } = await execGit('git', ['remote', 'get-url', 'origin'], {
      cwd: worktreePath,
      env,
      timeout: GET_ORIGIN_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    originUrl = stdout.trim();
  } catch {
    originUrl = null;
  }

  const decision = evaluateOriginGuard(project.id, expected, originUrl);
  if (!decision.ok) {
    throw new Error(decision.message);
  }
  return {
    expectedSource,
    summary: `origin-guard: project ${project.id} origin locked to ${decision.expected.owner}/${decision.expected.repo} (source: ${expectedSource})`,
  };
}
