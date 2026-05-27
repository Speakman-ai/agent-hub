import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { renderReleaseNotes, parseLogLine } from './release-notes-parse.js';
import {
  buildUserFacingRelease,
  tagToVersion,
  versionToTag,
  type UserFacingRelease,
} from './user-facing-release-notes.js';

const DEFAULT_REPO = 'Speakman-ai/agent-hub';
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

type GhReleaseRow = {
  tag_name: string;
  name: string;
  body: string | null;
  published_at: string | null;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
};

type GithubFetchResult = {
  ok: boolean;
  releases: GhReleaseRow[] | null;
  status: number | null;
};

// Cache key includes `limit` so a small-limit request can't lock out a
// later large-limit request for the cache TTL window.
let cache: {
  at: number;
  repo: string;
  limit: number;
  releases: UserFacingRelease[];
  source: 'github' | 'git';
} | null = null;

function resolveRepo(): string {
  const fromEnv = process.env.AGENT_HUB_RELEASES_REPO?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_REPO;
}

async function fetchGithubReleases(repo: string, limit: number): Promise<GithubFetchResult> {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=${Math.min(limit, 100)}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'agent-hub-server',
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return { ok: false, releases: null, status: res.status };
    const data = (await res.json()) as GhReleaseRow[];
    return {
      ok: Array.isArray(data),
      releases: Array.isArray(data) ? data : null,
      status: res.status,
    };
  } catch {
    return { ok: false, releases: null, status: null };
  } finally {
    clearTimeout(timer);
  }
}

function listGitTags(limit: number): string[] {
  try {
    const out = execFileSync('git', ['tag', '--list', 'v*', '--sort=-version:refname'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function gitLogForRange(range: string): string {
  try {
    // Pass `range` as a separate argv entry — never let it through a shell.
    // This is defence-in-depth: `range` is composed locally from `listGitTags`
    // output, so the input is trusted today, but an `execFile` boundary makes
    // a future caller / malicious tag (e.g. one containing `;` or backticks)
    // a non-event.
    return execFileSync('git', ['log', '--pretty=- %s (%h)', range], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

function buildNotesFromGit(tag: string, previousTag: string | null, repo: string): string {
  const range = previousTag ? `${previousTag}..${tag}` : tag;
  const raw = gitLogForRange(range);
  const commits = raw
    .split('\n')
    .map(parseLogLine)
    .filter((x): x is NonNullable<typeof x> => x !== null);
  return renderReleaseNotes({
    version: tag,
    previous: previousTag,
    commits,
    repo,
  });
}

function releasesFromGitTags(repo: string, limit: number): UserFacingRelease[] {
  const tags = listGitTags(limit);
  const out: UserFacingRelease[] = [];
  for (let i = 0; i < tags.length; i += 1) {
    const tag = tags[i]!;
    const prev = i < tags.length - 1 ? tags[i + 1]! : null;
    const body = buildNotesFromGit(tag, prev, repo);
    out.push(
      buildUserFacingRelease({
        tag,
        body,
        publishedAt: null,
        url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
      }),
    );
  }
  return out;
}

function mapGithubRows(rows: GhReleaseRow[], repo: string, limit: number): UserFacingRelease[] {
  const filtered = rows.filter((r) => !r.draft && !r.prerelease && r.tag_name).slice(0, limit);
  return filtered.map((r) =>
    buildUserFacingRelease({
      tag: r.tag_name,
      body: r.body || '',
      publishedAt: r.published_at,
      url: r.html_url,
    }),
  );
}

export async function listUserFacingReleases(opts?: {
  limit?: number;
  forceRefresh?: boolean;
}): Promise<{ repo: string; releases: UserFacingRelease[]; source: 'github' | 'git' }> {
  const repo = resolveRepo();
  const limit = Math.min(Math.max(opts?.limit ?? 30, 1), 100);

  if (
    !opts?.forceRefresh &&
    cache &&
    cache.repo === repo &&
    cache.limit === limit &&
    Date.now() - cache.at < CACHE_TTL_MS
  ) {
    return { repo, releases: cache.releases, source: cache.source };
  }

  const gh = await fetchGithubReleases(repo, limit);
  let releases: UserFacingRelease[] = [];
  let source: 'github' | 'git' = 'github';

  if (gh.ok && gh.releases) {
    releases = mapGithubRows(gh.releases, repo, limit);
    source = 'github';
  } else {
    releases = releasesFromGitTags(repo, limit);
    source = 'git';
    // If both GitHub and local tags are unavailable, degrade gracefully.
    // The UI can still render the current version and an empty list state.
  }

  cache = { at: Date.now(), repo, limit, releases, source };
  return { repo, releases, source };
}

export function findRelease(
  releases: UserFacingRelease[],
  versionOrTag: string,
): UserFacingRelease | null {
  const norm = versionOrTag.trim();
  if (!norm) return null;
  const tag = versionToTag(norm);
  const ver = tagToVersion(norm);
  return releases.find((r) => r.tag === tag || r.version === ver || r.tag === norm) ?? null;
}

export function resetReleaseCacheForTests(): void {
  cache = null;
}
