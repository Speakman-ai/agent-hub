/**
 * pr-detail-fetch.ts — Shared helper that fetches full PR detail from GitHub.
 * Auth chain: User OAuth (optional) → GitHub App → `gh` CLI fallback.
 *
 * Extracted from `routes/pr-list.ts` so the same App→CLI fallback ladder can
 * be reused by `routes/pr-resolve.ts` without duplicating ~140 lines of
 * orchestration. Normalizers live in `pr-list.ts` and are re-used here.
 *
 * Shape returned is identical to what `GET /api/projects/:id/pulls/:number`
 * returns (minus the `repo` envelope); callers can forward it verbatim or
 * pull out specific fields (e.g. the resolve endpoint looks at
 * `pr.mergeable`, `checks[].conclusion`, and `reviews[].state`).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AppConfig, GitHubAppConfig } from './types.js';
import { githubApiRequest, resolveInstallationId } from './github-app.js';
import { githubUserApiRequest } from './github-oauth.js';
import {
  mergeableFromCli,
  normalizeCheckRuns,
  normalizeIssueComments,
  normalizePrSummary,
  normalizeReviews,
} from './routes/pr-list.js';

const execFileAsync = promisify(execFile);

export interface PrDetailFetchOptions {
  /** User OAuth access token (tier 0). When provided, tried before App/CLI. */
  userAccessToken?: string | null;
}

export interface PrDetailFetchResult {
  source: 'user-oauth' | 'github-app' | 'gh-cli';
  pr: Record<string, unknown>;
  reviews: Array<Record<string, unknown>>;
  comments: Array<Record<string, unknown>>;
  checks: Array<Record<string, unknown>>;
}

function hasGitHubApp(config: AppConfig): boolean {
  const app = config.githubApp;
  if (!(app?.appId && app?.privateKey)) return false;
  return !!(app.installationId || (app.installations && app.installations.length > 0));
}

function botGhEnv(config: AppConfig): NodeJS.ProcessEnv | undefined {
  if (!config.botGithubToken) return undefined;
  return { ...process.env, GH_TOKEN: config.botGithubToken };
}

async function callCli(config: AppConfig, args: string[]): Promise<string> {
  const env = botGhEnv(config);
  const { stdout } = await execFileAsync('gh', args, {
    timeout: 20000,
    maxBuffer: 10 * 1024 * 1024,
    ...(env && { env }),
  });
  return stdout;
}

/**
 * Fetch PR detail via the User OAuth → GitHub App → `gh` CLI fallback ladder.
 *
 * Throws when all tiers fail; throws with a descriptive message (first line
 * of the underlying error) so callers can pass it through as 502 text.
 */
export async function fetchPrDetail(
  config: AppConfig,
  repo: { owner: string; repo: string },
  num: number,
  opts?: PrDetailFetchOptions,
): Promise<PrDetailFetchResult> {
  // Tier 0: User OAuth — respects the caller's repo visibility
  if (opts?.userAccessToken) {
    try {
      const uReq = <T>(path: string) =>
        githubUserApiRequest<T>({ accessToken: opts.userAccessToken!, endpoint: path });

      const prData = await uReq<Record<string, unknown>>(
        `/repos/${repo.owner}/${repo.repo}/pulls/${num}`,
      );
      const head = prData.head as Record<string, unknown> | undefined;
      const sha = head?.sha as string | undefined;

      const [reviewsRaw, commentsRaw, checksRaw] = await Promise.all([
        uReq(`/repos/${repo.owner}/${repo.repo}/pulls/${num}/reviews?per_page=50`).catch(() => []),
        uReq(`/repos/${repo.owner}/${repo.repo}/issues/${num}/comments?per_page=50`).catch(
          () => [],
        ),
        sha
          ? uReq(`/repos/${repo.owner}/${repo.repo}/commits/${sha}/check-runs`).catch(() => ({}))
          : Promise.resolve({}),
      ]);

      return {
        source: 'user-oauth',
        pr: normalizePrSummary(prData),
        reviews: normalizeReviews(reviewsRaw as unknown),
        comments: normalizeIssueComments(commentsRaw as unknown),
        checks: normalizeCheckRuns(checksRaw as unknown),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[PR Detail] User OAuth fetch failed, trying GitHub App: ${msg.split('\n')[0]}`);
    }
  }

  // Tier 1: GitHub App
  if (hasGitHubApp(config)) {
    const app = config.githubApp as GitHubAppConfig;
    const instId = resolveInstallationId(app, repo.owner);
    if (instId) {
      try {
        const req = (path: string) =>
          githubApiRequest(path, {
            appId: app.appId,
            privateKey: app.privateKey,
            installationId: instId,
          });

        const prData = (await req(`/repos/${repo.owner}/${repo.repo}/pulls/${num}`)) as Record<
          string,
          unknown
        >;
        const head = prData.head as Record<string, unknown> | undefined;
        const sha = head?.sha as string | undefined;

        const [reviewsRaw, commentsRaw, checksRaw] = await Promise.all([
          req(`/repos/${repo.owner}/${repo.repo}/pulls/${num}/reviews?per_page=50`).catch(() => []),
          req(`/repos/${repo.owner}/${repo.repo}/issues/${num}/comments?per_page=50`).catch(
            () => [],
          ),
          sha
            ? req(`/repos/${repo.owner}/${repo.repo}/commits/${sha}/check-runs`).catch(() => ({}))
            : Promise.resolve({}),
        ]);

        return {
          source: 'github-app',
          pr: normalizePrSummary(prData),
          reviews: normalizeReviews(reviewsRaw),
          comments: normalizeIssueComments(commentsRaw),
          checks: normalizeCheckRuns(checksRaw),
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[PR Detail] GitHub App fetch failed, trying gh CLI: ${msg.split('\n')[0]}`);
      }
    }
  }

  // Tier 2: gh CLI
  const viewJsonFields =
    'number,title,state,isDraft,url,author,headRefName,baseRefName,createdAt,updatedAt,additions,deletions,changedFiles,body,mergeable,reviewDecision,reviewRequests,labels,reviews,comments,statusCheckRollup';
  const stdout = await callCli(config, [
    'pr',
    'view',
    String(num),
    '--repo',
    `${repo.owner}/${repo.repo}`,
    '--json',
    viewJsonFields,
  ]);
  const data = JSON.parse(stdout) as Record<string, unknown>;
  const author = data.author as Record<string, unknown> | null | undefined;
  const reviews = (data.reviews as Array<Record<string, unknown>> | undefined) || [];
  const comments = (data.comments as Array<Record<string, unknown>> | undefined) || [];
  const statusChecks = (data.statusCheckRollup as Array<Record<string, unknown>> | undefined) || [];
  const labels = (data.labels as Array<Record<string, unknown>> | undefined) || [];

  return {
    source: 'gh-cli',
    pr: {
      number: data.number,
      title: data.title,
      state: typeof data.state === 'string' ? (data.state as string).toLowerCase() : data.state,
      draft: data.isDraft ?? false,
      html_url: data.url,
      user: author?.login ?? null,
      user_avatar: null,
      head: data.headRefName,
      base: data.baseRefName,
      created_at: data.createdAt,
      updated_at: data.updatedAt,
      merged_at: null,
      closed_at: null,
      body: data.body,
      mergeable: mergeableFromCli(data.mergeable),
      mergeable_state: data.mergeable,
      review_decision: data.reviewDecision,
      labels: labels.map((l) => ({ name: l.name as string, color: l.color as string })),
      comments: comments.length,
      additions: data.additions,
      deletions: data.deletions,
      changed_files: data.changedFiles,
    },
    reviews: reviews.map((r) => {
      const rAuthor = r.author as Record<string, unknown> | null | undefined;
      return {
        id: r.id,
        user: rAuthor?.login ?? null,
        state: r.state,
        body: r.body ?? '',
        submitted_at: r.submittedAt ?? null,
        html_url: null,
      };
    }),
    comments: comments.map((c) => {
      const cAuthor = c.author as Record<string, unknown> | null | undefined;
      return {
        id: c.id,
        user: cAuthor?.login ?? null,
        body: c.body ?? '',
        created_at: c.createdAt ?? null,
        html_url: null,
      };
    }),
    checks: statusChecks.map((chk) => ({
      id: chk.id ?? null,
      name: chk.name ?? chk.context ?? null,
      status: (chk.status as string | undefined)?.toLowerCase?.() ?? null,
      conclusion:
        (chk.conclusion as string | undefined)?.toLowerCase?.() ??
        (chk.state as string | undefined)?.toLowerCase?.() ??
        null,
      html_url: chk.detailsUrl ?? chk.targetUrl ?? null,
      started_at: chk.startedAt ?? null,
      completed_at: chk.completedAt ?? null,
    })),
  };
}
