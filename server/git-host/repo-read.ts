/**
 * repo-read.ts — read-only repository browsing for Agent Hub-hosted
 * repos: branch list (with ahead/behind vs the default branch), commit
 * log, and single-commit detail (stat + patch). Backs the Repository
 * page (`GET /api/projects/:id/git-host/{branches,commits}`).
 *
 * Everything shells out to real `git -C <bare>`; reuses the generic
 * runner from native-pr/git-read.ts.
 */

import { git } from '../native-pr/git-read.js';
import { gitHostRepoPath, hostedRepoDefaultBranch, hostedRepoExists } from './repo-store.js';
import config from '../config.js';

const MAX_BRANCHES = 200;
const MAX_COMMITS = 200;
/** Patch output cap for single-commit detail (UI renders a <pre>). */
const MAX_PATCH_BYTES = 1024 * 1024;

/** Field separator unlikely to appear in commit subjects. */
const SEP = '\x1f';

export interface RepoBranchEntry {
  name: string;
  sha: string;
  subject: string;
  author: string;
  date: string;
  isDefault: boolean;
  /** Commits on this branch that the default branch lacks (null when unknown). */
  ahead: number | null;
  /** Commits on the default branch that this branch lacks (null when unknown). */
  behind: number | null;
}

export interface RepoBranchesResult {
  defaultBranch: string | null;
  branches: RepoBranchEntry[];
}

export async function listRepoBranches(
  projectId: string,
  dataDir: string = config.dataDir,
): Promise<RepoBranchesResult> {
  const repoPath = gitHostRepoPath(projectId, dataDir);
  if (!hostedRepoExists(projectId, dataDir)) {
    return { defaultBranch: null, branches: [] };
  }
  const defaultBranch = await hostedRepoDefaultBranch(projectId, dataDir);

  const out = await git(repoPath, [
    'for-each-ref',
    '--sort=-committerdate',
    `--count=${MAX_BRANCHES}`,
    `--format=%(refname:short)${SEP}%(objectname)${SEP}%(subject)${SEP}%(authorname)${SEP}%(committerdate:iso-strict)`,
    'refs/heads',
  ]);

  const branches: RepoBranchEntry[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [name, sha, subject, author, date] = line.split(SEP);
    if (!name || !sha) continue;
    let ahead: number | null = null;
    let behind: number | null = null;
    if (defaultBranch && name !== defaultBranch) {
      try {
        const counts = await git(repoPath, [
          'rev-list',
          '--left-right',
          '--count',
          `refs/heads/${defaultBranch}...refs/heads/${name}`,
        ]);
        const [behindRaw, aheadRaw] = counts.trim().split(/\s+/);
        behind = Number.parseInt(behindRaw, 10);
        ahead = Number.parseInt(aheadRaw, 10);
        if (!Number.isFinite(ahead)) ahead = null;
        if (!Number.isFinite(behind)) behind = null;
      } catch {
        // unrelated histories / race with branch deletion — leave null
      }
    }
    branches.push({
      name,
      sha,
      subject: subject ?? '',
      author: author ?? '',
      date: date ?? '',
      isDefault: name === defaultBranch,
      ahead: name === defaultBranch ? 0 : ahead,
      behind: name === defaultBranch ? 0 : behind,
    });
  }
  return { defaultBranch, branches };
}

export interface RepoCommitEntry {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

export async function listRepoCommits(
  projectId: string,
  branch: string,
  limit: number,
  dataDir: string = config.dataDir,
): Promise<RepoCommitEntry[]> {
  const repoPath = gitHostRepoPath(projectId, dataDir);
  const capped = Math.min(Math.max(1, limit), MAX_COMMITS);
  const out = await git(repoPath, [
    'log',
    `--max-count=${capped}`,
    `--format=%H${SEP}%s${SEP}%an${SEP}%aI`,
    `refs/heads/${branch}`,
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, author, date] = line.split(SEP);
      return { sha, subject: subject ?? '', author: author ?? '', date: date ?? '' };
    });
}

export interface RepoCommitDetail {
  sha: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  parents: string[];
  stat: string;
  /** Unified diff; truncated to {@link MAX_PATCH_BYTES} with a marker. */
  patch: string;
  patchTruncated: boolean;
}

const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;

export async function getRepoCommitDetail(
  projectId: string,
  sha: string,
  dataDir: string = config.dataDir,
): Promise<RepoCommitDetail | null> {
  if (!COMMIT_SHA_RE.test(sha)) return null;
  const repoPath = gitHostRepoPath(projectId, dataDir);

  let meta: string;
  try {
    meta = await git(repoPath, [
      'show',
      '--no-patch',
      `--format=%H${SEP}%s${SEP}%an${SEP}%aI${SEP}%P${SEP}%b`,
      sha,
    ]);
  } catch {
    return null; // unknown sha
  }
  const [fullSha, subject, author, date, parentsRaw, ...bodyParts] = meta.trim().split(SEP);

  const stat = await git(repoPath, ['show', '--stat', '--format=', sha]);
  // -m so merge commits still show a diff (vs first parent).
  const rawPatch = await git(repoPath, ['show', '--format=', '-m', '--first-parent', sha]);
  const patchTruncated = Buffer.byteLength(rawPatch, 'utf8') > MAX_PATCH_BYTES;
  const patch = patchTruncated ? `${rawPatch.slice(0, MAX_PATCH_BYTES)}\n… (truncated)` : rawPatch;

  return {
    sha: fullSha,
    subject: subject ?? '',
    body: (bodyParts.join(SEP) ?? '').trim(),
    author: author ?? '',
    date: date ?? '',
    parents: (parentsRaw ?? '').split(/\s+/).filter(Boolean),
    stat: stat.trim(),
    patch,
    patchTruncated,
  };
}

/** Branch names come from URLs — refuse anything ref-unsafe. */
export function isSafeBranchName(name: string): boolean {
  if (!name || name.length > 250) return false;
  if (name.startsWith('-') || name.includes('..') || name.includes('//')) return false;
  // git-check-ref-format subset: printable, no spaces/control/refspec chars.
  return /^[^\s~^:?*[\\]+$/.test(name) && !name.endsWith('.lock') && !name.endsWith('/');
}
