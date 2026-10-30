/**
 * Merges of github.com pull requests that Agent Hub observed, kept so other
 * features can tell whether a session's PR merged and when.
 *
 * Hub-hosted repos already have this in `pull_requests`; github.com PRs leave
 * no local row, and inbound GitHub webhooks are gone, so the only merges the
 * Hub sees are the ones it performs (Finalize auto-merge, auto-git, the PR
 * page). All of them go through `handleGithubCardOnMerge`, which records the
 * merge here. A kanban card's column is never merge evidence: a person can
 * drag a card to Done before anything merged.
 */
import { getDb } from './db.js';

/** Record one observed merge. The first observation's time wins. Never throws. */
export function recordGithubPrMerge(args: {
  projectId: string;
  prUrl: string;
  prNumber?: number | null;
  headRef?: string | null;
  mergedAt?: number;
}): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO github_pr_merges (project_id, pr_url, pr_number, head_ref, merged_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, pr_url) DO UPDATE SET
           head_ref = COALESCE(github_pr_merges.head_ref, excluded.head_ref),
           pr_number = COALESCE(github_pr_merges.pr_number, excluded.pr_number)`,
      )
      .run(
        args.projectId,
        args.prUrl,
        args.prNumber ?? null,
        args.headRef ?? null,
        args.mergedAt ?? Date.now(),
      );
  } catch (err) {
    console.warn(
      `[github-pr] recording merge failed for ${args.prUrl}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * When a session's github.com PR merged, or null. The PR is the session's when
 * its head branch is the session branch, or the Hub opened it for the session
 * (`pr_creation_logs`).
 */
export function githubMergedAtForSession(
  projectId: string,
  sessionId: string,
  branch: string | null,
): number | null {
  const row = getDb()
    .prepare(
      `SELECT MAX(merged_at) AS merged_at FROM github_pr_merges
        WHERE project_id = ?
          AND ((? IS NOT NULL AND head_ref = ?)
            OR pr_url IN (SELECT pr_url FROM pr_creation_logs
                           WHERE project_id = ? AND session_id = ?))`,
    )
    .get(projectId, branch, branch, projectId, sessionId) as { merged_at: number | null };
  return row?.merged_at ?? null;
}

/** How often one branch is asked of GitHub at most. */
export const GITHUB_MERGE_RECONCILE_MS = 2 * 60_000;
const lastReconciled = new Map<string, number>();

interface GithubPullListItem {
  number?: number;
  html_url?: string;
  merged_at?: string | null;
  head?: { ref?: string };
}

/**
 * Ask GitHub whether a branch's PR merged and record any merge found, so
 * merges the Hub never observed (done on github.com, or before the Hub kept
 * this table) still count. Lists closed PRs with `head=<owner>:<branch>`
 * (REST "List pull requests"). Throttled per branch; never throws. Returns
 * the number of merges recorded.
 */
export async function reconcileGithubMergesForBranch(args: {
  projectId: string;
  githubRepo: string | null | undefined;
  branch: string | null | undefined;
  resolveToken: (githubRepo: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<number> {
  const repo = args.githubRepo?.trim();
  const branch = args.branch?.trim();
  if (!repo || !branch || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return 0;
  const key = `${args.projectId}:${branch}`;
  const now = args.now ?? Date.now();
  const last = lastReconciled.get(key);
  if (last !== undefined && now - last < GITHUB_MERGE_RECONCILE_MS) return 0;
  lastReconciled.set(key, now);
  try {
    const token = await args.resolveToken(repo);
    if (!token) return 0;
    const { githubUserApiRequest } = await import('./github-oauth.js');
    const owner = repo.split('/')[0];
    const pulls = await githubUserApiRequest<GithubPullListItem[]>({
      accessToken: token,
      endpoint: `/repos/${repo}/pulls?state=closed&per_page=20&head=${encodeURIComponent(`${owner}:${branch}`)}`,
      fetchImpl: args.fetchImpl,
    });
    let recorded = 0;
    for (const pr of Array.isArray(pulls) ? pulls : []) {
      const mergedAt = pr.merged_at ? Date.parse(pr.merged_at) : NaN;
      if (!pr.html_url || !Number.isFinite(mergedAt)) continue;
      recordGithubPrMerge({
        projectId: args.projectId,
        prUrl: pr.html_url,
        prNumber: pr.number ?? null,
        headRef: pr.head?.ref ?? branch,
        mergedAt,
      });
      recorded += 1;
    }
    return recorded;
  } catch (err) {
    console.warn(
      `[github-pr] merge reconcile failed for ${repo}:${branch}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 0;
  }
}

/** Test-only: forget throttle state. */
export function __testResetGithubMergeReconcile(): void {
  lastReconciled.clear();
}

export interface GithubPrContext {
  number: number;
  title: string;
  body: string;
}

interface GithubPullDetail {
  number?: number;
  title?: string | null;
  body?: string | null;
}

/**
 * Title and body of a session's github.com PR, for prompts that need what the
 * PR says. Looks the PR up by head branch (any state), then by the PR number
 * the Hub recorded for the session (a merge record or `pr_creation_logs`).
 * Without a token or on any GitHub error it falls back to the title the Hub
 * logged when it opened the PR. Never throws.
 */
export async function fetchGithubPrContextForSession(args: {
  projectId: string;
  sessionId: string;
  githubRepo: string | null | undefined;
  branch: string | null | undefined;
  resolveToken: (githubRepo: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
}): Promise<GithubPrContext | null> {
  const db = getDb();
  const logged = db
    .prepare(
      `SELECT pr_number, pr_title, pr_url FROM pr_creation_logs
        WHERE project_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(args.projectId, args.sessionId) as
    | { pr_number: number | null; pr_title: string; pr_url: string }
    | undefined;
  const branch = args.branch?.trim() || null;
  const recorded = branch
    ? (db
        .prepare(
          `SELECT pr_number FROM github_pr_merges
            WHERE project_id = ? AND head_ref = ? AND pr_number IS NOT NULL
            ORDER BY merged_at DESC LIMIT 1`,
        )
        .get(args.projectId, branch) as { pr_number: number } | undefined)
    : undefined;
  const fallback: GithubPrContext | null =
    logged && logged.pr_number != null
      ? { number: logged.pr_number, title: logged.pr_title, body: '' }
      : null;
  const repo = args.githubRepo?.trim();
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return fallback;
  try {
    const token = await args.resolveToken(repo);
    if (!token) return fallback;
    const { githubUserApiRequest } = await import('./github-oauth.js');
    const toContext = (p: GithubPullDetail | undefined): GithubPrContext | null =>
      p && typeof p.number === 'number'
        ? { number: p.number, title: p.title ?? '', body: p.body ?? '' }
        : null;
    if (branch) {
      const owner = repo.split('/')[0];
      const list = await githubUserApiRequest<GithubPullDetail[]>({
        accessToken: token,
        endpoint: `/repos/${repo}/pulls?state=all&per_page=5&head=${encodeURIComponent(`${owner}:${branch}`)}`,
        fetchImpl: args.fetchImpl,
      });
      const hit = toContext(Array.isArray(list) ? list[0] : undefined);
      if (hit) return hit;
    }
    const number = recorded?.pr_number ?? logged?.pr_number ?? null;
    if (number == null) return fallback;
    const detail = await githubUserApiRequest<GithubPullDetail>({
      accessToken: token,
      endpoint: `/repos/${repo}/pulls/${number}`,
      fetchImpl: args.fetchImpl,
    });
    return toContext(detail) ?? fallback;
  } catch (err) {
    console.warn(
      `[github-pr] PR context lookup failed for ${repo}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return fallback;
  }
}
