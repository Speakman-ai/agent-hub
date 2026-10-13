/**
 * PR environments for GitHub-hosted projects.
 *
 * The lifecycle is the same service and runtime as Hub-hosted PRs (the build
 * reads deploy.yaml from the project workspace, which fetches the GitHub
 * remote). What differs is where the PR's state comes from: the GitHub REST
 * API instead of the `pull_requests` table. There is no GitHub webhook
 * receiver, so the periodic catch-up does what webhooks would: it lists each
 * project's open PRs (new PRs and pushes) and re-reads every unsettled
 * environment's PR (merges and closes). Environments can also start from the
 * PR page.
 */
import type { Project } from '../types.js';
import { prEnvironmentPanelVisible, type PrAuthoritativeState } from './pr-environments.js';
import type { PrEnvironmentSource } from './pr-environment-state.js';
import { isAgentHubHosted } from '../native-pr/host.js';

const GITHUB_API = 'https://api.github.com';

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'agent-hub-pr-environment/1',
  };
}
const OWNER_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** Which kind of PR a project's environments belong to; null when it can have none. */
export function prEnvironmentSourceFor(
  project: Pick<Project, 'githubRepo'> & Parameters<typeof isAgentHubHosted>[0],
): PrEnvironmentSource | null {
  if (isAgentHubHosted(project)) return 'native';
  return githubRepoOf(project) ? 'github' : null;
}

/** The project's `owner/repo`, or null when unset or malformed. */
export function githubRepoOf(project: Pick<Project, 'githubRepo'>): string | null {
  const repo = typeof project.githubRepo === 'string' ? project.githubRepo.trim() : '';
  return OWNER_REPO_RE.test(repo) ? repo : null;
}

export class GithubPrStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GithubPrStateError';
  }
}

/**
 * The PR's state from GitHub. Null when GitHub says the PR does not exist.
 * Throws when it cannot be read (no token, network, other API errors); the
 * service treats a failed read as "unknown" and changes nothing.
 */
export async function readGithubPrState(args: {
  repo: string;
  prNumber: number;
  getToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}): Promise<PrAuthoritativeState> {
  if (!OWNER_REPO_RE.test(args.repo)) throw new GithubPrStateError('Invalid GitHub repo');
  const token = await args.getToken();
  if (!token) throw new GithubPrStateError(`No GitHub token can read ${args.repo}`);
  const res = await (args.fetchImpl ?? fetch)(
    `${GITHUB_API}/repos/${args.repo}/pulls/${args.prNumber}`,
    {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new GithubPrStateError(`GitHub PR read failed: HTTP ${res.status}`);
  const pr = (await res.json()) as {
    state?: string;
    merged?: boolean;
    merged_at?: string | null;
    head?: { sha?: string; ref?: string };
  };
  if (pr.state === 'open') {
    const headSha = pr.head?.sha;
    if (!headSha) throw new GithubPrStateError('GitHub PR has no head sha');
    return { status: 'open', headSha, headBranch: pr.head?.ref ?? null };
  }
  return { status: pr.merged || pr.merged_at ? 'merged' : 'closed' };
}

export interface GithubOpenPr {
  prNumber: number;
  headSha: string;
  headBranch: string | null;
}

/**
 * The repo's open PRs whose head branch lives in the repo itself. Fork PRs are
 * left out: their head is not in the project's remote, and building
 * untrusted fork code automatically is what GitHub's own `pull_request`
 * trigger guards against. They can still be started from the PR page.
 * Throws when the list cannot be read.
 */
export async function listOpenGithubPrs(args: {
  repo: string;
  getToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}): Promise<GithubOpenPr[]> {
  if (!OWNER_REPO_RE.test(args.repo)) throw new GithubPrStateError('Invalid GitHub repo');
  const token = await args.getToken();
  if (!token) throw new GithubPrStateError(`No GitHub token can read ${args.repo}`);
  const repo = args.repo.toLowerCase();
  const out: GithubOpenPr[] = [];
  // Every page, every time: a page cap would hide the oldest PRs for good,
  // since each catch-up starts over from the newest.
  for (let page = 1; ; page++) {
    const res = await (args.fetchImpl ?? fetch)(
      `${GITHUB_API}/repos/${args.repo}/pulls?state=open&per_page=100&page=${page}`,
      { headers: githubHeaders(token), signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) throw new GithubPrStateError(`GitHub PR list failed: HTTP ${res.status}`);
    const items = (await res.json()) as Array<{
      number?: number;
      head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null };
    }>;
    if (!Array.isArray(items)) throw new GithubPrStateError('GitHub PR list is not an array');
    for (const pr of items) {
      const sha = pr.head?.sha;
      if (typeof pr.number !== 'number' || !sha) continue;
      if (pr.head?.repo?.full_name?.toLowerCase() !== repo) continue;
      out.push({ prNumber: pr.number, headSha: sha, headBranch: pr.head?.ref ?? null });
    }
    if (items.length < 100) break;
  }
  return out;
}

/**
 * `preview_available` for a GitHub PR's detail: the same rule as Hub-hosted
 * PRs (an environment that still needs attention, or an open PR whose head
 * declares a `preview:` block). The head probe runs only when it matters.
 */
export async function githubPrPreviewAvailable(args: {
  env: Parameters<typeof prEnvironmentPanelVisible>[0];
  prOpen: boolean;
  headSha: string | null;
  probe: (headSha: string) => Promise<boolean>;
}): Promise<boolean> {
  if (prEnvironmentPanelVisible(args.env, false, args.prOpen)) return true;
  if (!args.prOpen || !args.headSha) return false;
  try {
    return await args.probe(args.headSha);
  } catch {
    return false;
  }
}
