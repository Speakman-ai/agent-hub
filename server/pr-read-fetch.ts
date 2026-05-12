/**
 * pr-read-fetch.ts — Server-side helpers that fetch PR diff / changed-files
 * through the same auth ladder as `pr-detail-fetch.ts`.
 *
 * Why these exist:
 * - Reviewer-role spawns are intentionally stripped of `GH_TOKEN` and pointed
 *   at an empty `GH_CONFIG_DIR` by `applyReviewerSpawnIsolation`. That is the
 *   isolation contract that prevents a reviewer from forging commits or
 *   opening PRs under the App identity.
 * - The cost of that contract is the reviewer has no way to *read* the PR.
 *   `POST /api/pr/review` is write-only; there were no GET equivalents until
 *   these helpers were introduced.
 *
 * Auth ladder mirrors `pr-detail-fetch.ts`:
 *   Tier 0: User OAuth — respects the caller's repo visibility
 *   Tier 1: GitHub App installation token — distinct identity, no host creds
 *   Tier 2: gh CLI fallback with `botGithubToken` env (legacy hosts)
 *
 * Used by:
 *   GET /api/pr/diff   → fetchPrDiff
 *   GET /api/pr/files  → fetchPrFiles
 *
 * Kept as plain functions (no Express coupling) so unit tests can drive the
 * three tiers directly without spinning up the router.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AppConfig, GitHubAppConfig } from './types.js';
import { getInstallationToken, resolveInstallationId } from './github-app.js';

const execFileAsync = promisify(execFile);

const GH_API_BASE = 'https://api.github.com';
const USER_AGENT = 'agent-hub';
const API_VERSION = '2022-11-28';

export interface PrReadFetchOptions {
  /** User OAuth access token (tier 0). When provided, tried before App/CLI. */
  userAccessToken?: string | null;
  /** Override fetch — used by tests. */
  fetchImpl?: typeof fetch;
}

export type PrReadSource = 'user-oauth' | 'github-app' | 'gh-cli';

export interface PrDiffResult {
  source: PrReadSource;
  diff: string;
}

/**
 * GitHub `pulls/:n/files` response entry. Trimmed to the shape the reviewer
 * actually needs — we don't pass through every raw field GitHub returns
 * (avoids growing the response when GitHub adds new fields the reviewer
 * doesn't read yet).
 */
export interface PrFilesEntry {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  blob_url?: string;
  raw_url?: string;
  sha?: string;
  previous_filename?: string;
}

export interface PrFilesResult {
  source: PrReadSource;
  files: PrFilesEntry[];
  /** True when pagination hit `MAX_PAGES`; caller should warn. */
  truncated: boolean;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 30; // 3000-file cap. Larger PRs get truncated + flagged.

function hasGitHubApp(config: AppConfig): boolean {
  const app = config.githubApp;
  if (!(app?.appId && app?.privateKey)) return false;
  return !!(app.installationId || (app.installations && app.installations.length > 0));
}

function botGhEnv(config: AppConfig): NodeJS.ProcessEnv | undefined {
  if (!config.botGithubToken) return undefined;
  return { ...process.env, GH_TOKEN: config.botGithubToken };
}

async function fetchText(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<string> {
  const res = await fetchImpl(url, { headers });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.text();
}

async function fetchJson<T = unknown>(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<T> {
  const res = await fetchImpl(url, { headers });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status}: ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/**
 * Fetch the unified diff for a PR. Returns plain text — the body is the
 * `application/vnd.github.v3.diff` media type from GitHub.
 *
 * Throws when every tier fails; the route handler converts that to a 502
 * with the first line of the underlying error.
 */
export async function fetchPrDiff(
  config: AppConfig,
  repo: { owner: string; repo: string },
  num: number,
  opts?: PrReadFetchOptions,
): Promise<PrDiffResult> {
  const f = opts?.fetchImpl ?? fetch;
  const path = `/repos/${repo.owner}/${repo.repo}/pulls/${num}`;

  // Tier 0: User OAuth
  if (opts?.userAccessToken) {
    try {
      const diff = await fetchText(
        `${GH_API_BASE}${path}`,
        {
          Authorization: `Bearer ${opts.userAccessToken}`,
          Accept: 'application/vnd.github.v3.diff',
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': USER_AGENT,
        },
        f,
      );
      return { source: 'user-oauth', diff };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[PR Diff] User OAuth failed, trying GitHub App: ${msg.split('\n')[0]}`);
    }
  }

  // Tier 1: GitHub App
  if (hasGitHubApp(config)) {
    const app = config.githubApp as GitHubAppConfig;
    const instId = resolveInstallationId(app, repo.owner);
    if (instId) {
      try {
        const token = await getInstallationToken(app.appId, app.privateKey, instId);
        const diff = await fetchText(
          `${GH_API_BASE}${path}`,
          {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3.diff',
            'X-GitHub-Api-Version': API_VERSION,
            'User-Agent': USER_AGENT,
          },
          f,
        );
        return { source: 'github-app', diff };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[PR Diff] GitHub App failed, trying gh CLI: ${msg.split('\n')[0]}`);
      }
    }
  }

  // Tier 2: gh CLI
  const env = botGhEnv(config);
  const { stdout } = await execFileAsync(
    'gh',
    ['pr', 'diff', String(num), '--repo', `${repo.owner}/${repo.repo}`],
    { timeout: 30000, maxBuffer: 25 * 1024 * 1024, ...(env && { env }) },
  );
  return { source: 'gh-cli', diff: stdout };
}

/**
 * Fetch the changed-files list for a PR. Paginates GitHub's
 * `GET /repos/{owner}/{repo}/pulls/{n}/files` (max 100/page, MAX_PAGES cap
 * to bound memory on accidentally-massive PRs).
 *
 * `truncated: true` means the file list hit `MAX_PAGES * PAGE_SIZE`; callers
 * should surface that to the reviewer prompt so it doesn't silently miss
 * files in a giant PR.
 */
export async function fetchPrFiles(
  config: AppConfig,
  repo: { owner: string; repo: string },
  num: number,
  opts?: PrReadFetchOptions,
): Promise<PrFilesResult> {
  const f = opts?.fetchImpl ?? fetch;

  async function paginate(headers: Record<string, string>): Promise<PrFilesResult> {
    const all: PrFilesEntry[] = [];
    let truncated = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${GH_API_BASE}/repos/${repo.owner}/${repo.repo}/pulls/${num}/files?per_page=${PAGE_SIZE}&page=${page}`;
      const batch = await fetchJson<PrFilesEntry[]>(url, headers, f);
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < PAGE_SIZE) return { source: 'user-oauth', files: all, truncated };
      if (page === MAX_PAGES) truncated = true;
    }
    return { source: 'user-oauth', files: all, truncated };
  }

  // Tier 0: User OAuth
  if (opts?.userAccessToken) {
    try {
      const result = await paginate({
        Authorization: `Bearer ${opts.userAccessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': USER_AGENT,
      });
      return { ...result, source: 'user-oauth' };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[PR Files] User OAuth failed, trying GitHub App: ${msg.split('\n')[0]}`);
    }
  }

  // Tier 1: GitHub App
  if (hasGitHubApp(config)) {
    const app = config.githubApp as GitHubAppConfig;
    const instId = resolveInstallationId(app, repo.owner);
    if (instId) {
      try {
        const token = await getInstallationToken(app.appId, app.privateKey, instId);
        const result = await paginate({
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': USER_AGENT,
        });
        return { ...result, source: 'github-app' };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[PR Files] GitHub App failed, trying gh CLI: ${msg.split('\n')[0]}`);
      }
    }
  }

  // Tier 2: gh CLI
  const env = botGhEnv(config);
  const { stdout } = await execFileAsync(
    'gh',
    [
      'api',
      '--paginate',
      `repos/${repo.owner}/${repo.repo}/pulls/${num}/files?per_page=${PAGE_SIZE}`,
    ],
    { timeout: 30000, maxBuffer: 25 * 1024 * 1024, ...(env && { env }) },
  );
  // `gh api --paginate` concatenates JSON arrays into a single array when
  // the response is an array, so a single `JSON.parse` works.
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = [];
  }
  const files: PrFilesEntry[] = Array.isArray(parsed) ? (parsed as PrFilesEntry[]) : [];
  return { source: 'gh-cli', files, truncated: false };
}
