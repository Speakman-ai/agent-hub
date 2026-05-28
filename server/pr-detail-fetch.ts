/**
 * pr-detail-fetch.ts — Shared helper that fetches full PR detail from GitHub.
 *
 * Auth policy:
 *   - With `userAccessToken`: user identity only (no App/gh fallback on failure).
 *   - With `reviewerAppRead: true` and no user token: GitHub App installation only.
 */

import type { AppConfig, GitHubAppConfig } from './types.js';
import { githubApiRequest, resolveInstallationId } from './github-app.js';
import { githubUserApiRequest } from './github-oauth.js';
import {
  CONNECT_GITHUB_HINT,
  REVIEWER_APP_HINT,
  hasReviewerGitHubApp,
} from './github-auth-policy.js';
import {
  normalizeCheckRuns,
  normalizeIssueComments,
  normalizePrSummary,
  normalizeReviews,
} from './routes/pr-list.js';

export interface PrDetailFetchOptions {
  /** Per-user OAuth/PAT. When set, only this tier is used. */
  userAccessToken?: string | null;
  /** Reviewer read proxies: App installation when no user token. */
  reviewerAppRead?: boolean;
}

export interface PrDetailFetchResult {
  source: 'user-oauth' | 'github-app';
  pr: Record<string, unknown>;
  reviews: Array<Record<string, unknown>>;
  comments: Array<Record<string, unknown>>;
  checks: Array<Record<string, unknown>>;
  /**
   * PR head commit SHA, extracted from the raw GitHub `pull_request.head.sha`
   * before `normalizePrSummary` collapses `head` into a branch-ref string.
   *
   * Exposed at the top level because the normalised `pr.head` is the branch
   * name only — callers that need the SHA (e.g. reviewer Check Run creation,
   * which is commit-scoped) would otherwise have to refetch. `null` when the
   * upstream payload has no head SHA (edge case: deleted-branch GhostPR).
   */
  headSha: string | null;
}

export class PrFetchError extends Error {
  appTierError?: string;
  constructor(message: string, opts?: { appTierError?: string | null }) {
    super(message);
    this.name = 'PrFetchError';
    if (opts?.appTierError) this.appTierError = opts.appTierError;
  }
}

export async function fetchPrDetail(
  config: AppConfig,
  repo: { owner: string; repo: string },
  num: number,
  opts?: PrDetailFetchOptions,
): Promise<PrDetailFetchResult> {
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
        headSha: sha ?? null,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new PrFetchError(msg.split('\n')[0]);
    }
  }

  if (opts?.reviewerAppRead && hasReviewerGitHubApp(config)) {
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
          headSha: sha ?? null,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new PrFetchError(msg.split('\n')[0], { appTierError: msg.split('\n')[0] });
      }
    }
    throw new PrFetchError(`No GitHub App installation for "${repo.owner}". ${REVIEWER_APP_HINT}`);
  }

  throw new PrFetchError(CONNECT_GITHUB_HINT);
}
