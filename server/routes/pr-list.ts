/**
 * routes/pr-list.ts — Project-scoped read-only PR viewer endpoints.
 *
 * GET  /api/projects/:projectId/pulls             — list PRs for the project's GitHub repo
 * GET  /api/projects/:projectId/pulls/:number     — full detail: PR + reviews + check-runs + comments
 *
 * Auth chain mirrors routes/pr-actions.ts:
 *   1. GitHub App installation (if configured for the repo's owner)
 *   2. `gh` CLI fallback (optionally with `GH_TOKEN` from `botGithubToken`)
 *
 * This is a read-only surface — no mutating actions live here. Merge/close/review
 * continue to live in pr-actions.ts so that write surfaces stay consolidated.
 */

import { Router, Request, Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { RouteDeps, AppConfig, GitHubAppConfig } from '../types.js';
import { githubApiRequest, resolveInstallationId } from '../github-app.js';

const execFileAsync = promisify(execFile);

const ALLOWED_STATES = new Set(['open', 'closed', 'all']);
const DEFAULT_LIST_LIMIT = 30;
const MAX_LIST_LIMIT = 100;

interface ParsedRepo {
  owner: string;
  repo: string;
}

export function parseRepoFullName(value: string | null | undefined): ParsedRepo | null {
  if (!value) return null;
  const match = value.trim().match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/**
 * Map `gh pr view --json mergeable` tri-state to the boolean-or-null shape
 * that the REST API (and therefore the App tier + mobile UI) expects.
 *
 *   'MERGEABLE'   → true
 *   'CONFLICTING' → false
 *   anything else (UNKNOWN, null, missing) → null
 *
 * Preserving null for UNKNOWN is important: the mobile badge renders
 * "Mergeable"/"Conflicts" only when mergeable is a boolean, so `null`
 * correctly suppresses the badge while GitHub is still computing.
 */
export function mergeableFromCli(value: unknown): boolean | null {
  if (value === 'MERGEABLE') return true;
  if (value === 'CONFLICTING') return false;
  return null;
}

export function normalizePrSummary(raw: Record<string, unknown>): Record<string, unknown> {
  const user = raw.user as Record<string, unknown> | null | undefined;
  const head = raw.head as Record<string, unknown> | null | undefined;
  const base = raw.base as Record<string, unknown> | null | undefined;
  const labels = Array.isArray(raw.labels)
    ? (raw.labels as Array<Record<string, unknown>>).map((l) => ({
        name: l.name as string,
        color: l.color as string,
      }))
    : [];
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    draft: raw.draft ?? false,
    html_url: raw.html_url,
    user: user?.login ?? null,
    user_avatar: user?.avatar_url ?? null,
    head: head?.ref ?? null,
    base: base?.ref ?? null,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    merged_at: raw.merged_at ?? null,
    closed_at: raw.closed_at ?? null,
    labels,
    comments: raw.comments ?? 0,
    review_comments: raw.review_comments ?? 0,
    additions: raw.additions,
    deletions: raw.deletions,
    changed_files: raw.changed_files,
    mergeable: raw.mergeable ?? null,
    mergeable_state: raw.mergeable_state ?? null,
  };
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

async function callApp<T>(config: AppConfig, owner: string, path: string): Promise<T | null> {
  if (!hasGitHubApp(config)) return null;
  const app = config.githubApp as GitHubAppConfig;
  const instId = resolveInstallationId(app, owner);
  if (!instId) return null;
  const data = await githubApiRequest(path, {
    appId: app.appId,
    privateKey: app.privateKey,
    installationId: instId,
  });
  return data as unknown as T;
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

export default function createPrListRoutes(deps: RouteDeps): Router {
  const { config, findProject } = deps;
  const router = Router();

  // ─── List PRs for a project ─────────────────────────────────────

  router.get(
    '/api/projects/:projectId/pulls',
    async (req: Request, res: Response): Promise<Response | void> => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const repo = parseRepoFullName(project.githubRepo as string | undefined);
      if (!repo) {
        return res.status(400).json({
          error: 'Project has no githubRepo configured',
          hint: 'Set project.githubRepo to "owner/repo" to enable the PR viewer.',
        });
      }

      const stateParam = typeof req.query.state === 'string' ? req.query.state : 'open';
      const state = ALLOWED_STATES.has(stateParam) ? stateParam : 'open';
      let limit = Number.parseInt((req.query.limit as string) || '', 10);
      if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIST_LIMIT;
      if (limit > MAX_LIST_LIMIT) limit = MAX_LIST_LIMIT;

      // Tier 1: GitHub App
      try {
        const appPath = `/repos/${repo.owner}/${repo.repo}/pulls?state=${state}&per_page=${limit}&sort=updated&direction=desc`;
        const appData = await callApp<Array<Record<string, unknown>>>(config, repo.owner, appPath);
        if (Array.isArray(appData)) {
          return res.json({
            repo: `${repo.owner}/${repo.repo}`,
            state,
            source: 'github-app',
            pulls: appData.map(normalizePrSummary),
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[PR List] GitHub App list failed, trying gh CLI: ${msg.split('\n')[0]}`);
      }

      // Tier 2: gh CLI
      try {
        const stateFlag = state === 'all' ? 'all' : state;
        const stdout = await callCli(config, [
          'pr',
          'list',
          '--repo',
          `${repo.owner}/${repo.repo}`,
          '--state',
          stateFlag,
          '--limit',
          String(limit),
          '--json',
          'number,title,state,isDraft,url,author,headRefName,baseRefName,createdAt,updatedAt,labels,additions,deletions,changedFiles,comments',
        ]);
        const raw = JSON.parse(stdout) as Array<Record<string, unknown>>;
        const pulls = raw.map((pr) => {
          const author = pr.author as Record<string, unknown> | null | undefined;
          const comments = pr.comments as Array<unknown> | undefined;
          const labels = (pr.labels as Array<Record<string, unknown>> | undefined) || [];
          return {
            number: pr.number,
            title: pr.title,
            state: typeof pr.state === 'string' ? pr.state.toLowerCase() : pr.state,
            draft: pr.isDraft ?? false,
            html_url: pr.url,
            user: author?.login ?? null,
            user_avatar: null,
            head: pr.headRefName,
            base: pr.baseRefName,
            created_at: pr.createdAt,
            updated_at: pr.updatedAt,
            merged_at: null,
            closed_at: null,
            labels: labels.map((l) => ({ name: l.name as string, color: l.color as string })),
            comments: Array.isArray(comments) ? comments.length : 0,
            review_comments: 0,
            additions: pr.additions,
            deletions: pr.deletions,
            changed_files: pr.changedFiles,
            mergeable: null,
            mergeable_state: null,
          };
        });
        return res.json({
          repo: `${repo.owner}/${repo.repo}`,
          state,
          source: 'gh-cli',
          pulls,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(502).json({ error: `Failed to list PRs: ${msg.split('\n')[0]}` });
      }
    },
  );

  // ─── PR detail: PR + reviews + check-runs + issue comments ──────

  router.get(
    '/api/projects/:projectId/pulls/:number',
    async (req: Request, res: Response): Promise<Response | void> => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const repo = parseRepoFullName(project.githubRepo as string | undefined);
      if (!repo) {
        return res.status(400).json({ error: 'Project has no githubRepo configured' });
      }

      const num = Number.parseInt(String(req.params.number), 10);
      if (!Number.isFinite(num) || num <= 0) {
        return res.status(400).json({ error: 'Invalid PR number' });
      }

      // Tier 1: GitHub App (make all requests in parallel)
      if (hasGitHubApp(config)) {
        const app = config.githubApp as GitHubAppConfig;
        const instId = resolveInstallationId(app, repo.owner);
        if (instId) {
          try {
            const req2 = (path: string) =>
              githubApiRequest(path, {
                appId: app.appId,
                privateKey: app.privateKey,
                installationId: instId,
              });

            const prData = (await req2(`/repos/${repo.owner}/${repo.repo}/pulls/${num}`)) as Record<
              string,
              unknown
            >;
            const head = prData.head as Record<string, unknown> | undefined;
            const sha = head?.sha as string | undefined;

            const [reviewsRaw, commentsRaw, checksRaw] = await Promise.all([
              req2(`/repos/${repo.owner}/${repo.repo}/pulls/${num}/reviews?per_page=50`).catch(
                () => [],
              ),
              req2(`/repos/${repo.owner}/${repo.repo}/issues/${num}/comments?per_page=50`).catch(
                () => [],
              ),
              sha
                ? req2(`/repos/${repo.owner}/${repo.repo}/commits/${sha}/check-runs`).catch(
                    () => ({}),
                  )
                : Promise.resolve({}),
            ]);

            return res.json({
              repo: `${repo.owner}/${repo.repo}`,
              source: 'github-app',
              pr: normalizePrSummary(prData),
              reviews: normalizeReviews(reviewsRaw),
              comments: normalizeIssueComments(commentsRaw),
              checks: normalizeCheckRuns(checksRaw),
            });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(
              `[PR Detail] GitHub App fetch failed, trying gh CLI: ${msg.split('\n')[0]}`,
            );
          }
        }
      }

      // Tier 2: gh CLI — uses `gh pr view` + `gh api` for reviews/checks
      try {
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
        const statusChecks =
          (data.statusCheckRollup as Array<Record<string, unknown>> | undefined) || [];
        const labels = (data.labels as Array<Record<string, unknown>> | undefined) || [];

        return res.json({
          repo: `${repo.owner}/${repo.repo}`,
          source: 'gh-cli',
          pr: {
            number: data.number,
            title: data.title,
            state: typeof data.state === 'string' ? data.state.toLowerCase() : data.state,
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
            // Preserve null for UNKNOWN (see mergeableFromCli docs) so the mobile
            // UI doesn't render a false "Conflicts" badge while GitHub is still
            // computing mergeability — matches the App branch's boolean-or-null.
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
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(502).json({ error: `Failed to fetch PR: ${msg.split('\n')[0]}` });
      }
    },
  );

  return router;
}

// ─── Normalizers (exported for tests) ─────────────────────────────

export function normalizeReviews(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<Record<string, unknown>>).map((r) => {
    const user = r.user as Record<string, unknown> | null | undefined;
    return {
      id: r.id,
      user: user?.login ?? null,
      state: r.state,
      body: r.body ?? '',
      submitted_at: r.submitted_at ?? null,
      html_url: r.html_url ?? null,
    };
  });
}

export function normalizeIssueComments(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<Record<string, unknown>>).map((c) => {
    const user = c.user as Record<string, unknown> | null | undefined;
    return {
      id: c.id,
      user: user?.login ?? null,
      body: c.body ?? '',
      created_at: c.created_at ?? null,
      html_url: c.html_url ?? null,
    };
  });
}

export function normalizeCheckRuns(raw: unknown): Array<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object') return [];
  const runs = (raw as Record<string, unknown>).check_runs;
  if (!Array.isArray(runs)) return [];
  return (runs as Array<Record<string, unknown>>).map((chk) => ({
    id: chk.id,
    name: chk.name,
    status: chk.status,
    conclusion: chk.conclusion ?? null,
    html_url: chk.html_url ?? null,
    started_at: chk.started_at ?? null,
    completed_at: chk.completed_at ?? null,
  }));
}
