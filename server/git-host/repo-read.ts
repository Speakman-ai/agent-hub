/**
 * repo-read.ts — read-only repository browsing for Agent Hub-hosted
 * repos: branch list (with ahead/behind vs the default branch), commit
 * log, and single-commit detail (stat + patch). Backs the Repository
 * page (`GET /api/projects/:id/git-host/{branches,commits}`).
 *
 * Everything shells out to real `git -C <bare>`; reuses the generic
 * runner from native-pr/git-read.ts.
 */

import { spawn } from 'child_process';
import { git } from '../native-pr/git-read.js';
import { gitHostRepoPath, hostedRepoDefaultBranch, hostedRepoExists } from './repo-store.js';
import config from '../config.js';

const GIT_BLOB_TIMEOUT_MS = 60_000;

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

/** README blob content cap — the UI renders it as markdown, so keep it sane. */
const MAX_README_BYTES = 512 * 1024;

/**
 * Root-level README extensions, most-renderable first. An extensionless
 * `README` is preferred over `.rst`/`.txt` (markdown renderer treats it as
 * plain text, which is fine), but below the markdown variants.
 */
const README_EXT_PRIORITY = ['.md', '.markdown', '.mdown', '.mkd', '', '.rst', '.txt'];

function readmeExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

export interface RepoReadme {
  /** Branch the README was read from. */
  branch: string;
  /** Root-relative path of the chosen README file (e.g. `README.md`). */
  path: string;
  /** Raw file content; truncated to {@link MAX_README_BYTES} with a marker. */
  content: string;
  truncated: boolean;
}

interface BoundedBlob {
  /** Up to {@link maxBytes} bytes of the blob, byte-accurately truncated. */
  buffer: Buffer;
  truncated: boolean;
}

/**
 * Read a git blob (`git show <ref>`) but stop after `maxBytes` so a huge
 * file never has to be fully buffered into memory (nor blow the generic
 * git helper's stdout cap and come back as null). Kills the git process as
 * soon as enough bytes have arrived. Resolves null when the ref/blob is
 * missing (git exits non-zero with no usable output) or on timeout/error.
 */
function readGitBlobBounded(
  repoPath: string,
  ref: string,
  maxBytes: number,
): Promise<BoundedBlob | null> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', repoPath, 'show', ref], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    let settled = false;

    const finish = (value: BoundedBlob | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill('SIGKILL');
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), GIT_BLOB_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      chunks.push(chunk);
      total += chunk.length;
      if (total > maxBytes) {
        // Enough bytes to satisfy the cap and prove there's more — stop now
        // rather than buffering the rest of a multi-MB file.
        truncated = true;
        finish({ buffer: Buffer.concat(chunks).subarray(0, maxBytes), truncated: true });
      }
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (settled) return;
      // Killed-by-signal (code === null) only happens after we already
      // settled above, so a non-zero/!0 here means a real git failure.
      if (code !== 0) return finish(null);
      finish({ buffer: Buffer.concat(chunks), truncated });
    });
  });
}

/**
 * Read the root-level README of a Hub-hosted repo's branch (defaulting to
 * the repo default branch). Returns null when the repo, branch, or a
 * README file is absent — never throws for "nothing to show".
 */
export async function readRepoReadme(
  projectId: string,
  branch?: string,
  dataDir: string = config.dataDir,
): Promise<RepoReadme | null> {
  if (!hostedRepoExists(projectId, dataDir)) return null;
  const repoPath = gitHostRepoPath(projectId, dataDir);
  const targetBranch = branch || (await hostedRepoDefaultBranch(projectId, dataDir));
  if (!targetBranch || !isSafeBranchName(targetBranch)) return null;

  let names: string[];
  try {
    // Root entries only (no -r). Refuses unknown refs with a non-zero exit.
    const out = await git(repoPath, ['ls-tree', '--name-only', `refs/heads/${targetBranch}`]);
    names = out
      .split('\n')
      .map((n) => n.trim())
      .filter(Boolean);
  } catch {
    return null; // unknown branch / empty repo
  }

  const candidates = names.filter((n) => /^readme(\.[^.]+)?$/i.test(n));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const ai = README_EXT_PRIORITY.indexOf(readmeExt(a));
    const bi = README_EXT_PRIORITY.indexOf(readmeExt(b));
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  const chosen = candidates[0];

  const blob = await readGitBlobBounded(
    repoPath,
    `refs/heads/${targetBranch}:${chosen}`,
    MAX_README_BYTES,
  );
  if (!blob) return null;
  // Byte-accurate truncation already happened in readGitBlobBounded; decoding
  // a buffer cut mid-codepoint yields a single U+FFFD, which is harmless here.
  const decoded = blob.buffer.toString('utf8');
  const content = blob.truncated
    ? `${decoded}\n\n… (README truncated — clone the repo to read the rest.)`
    : decoded;
  return { branch: targetBranch, path: chosen, content, truncated: blob.truncated };
}

/** Branch names come from URLs — refuse anything ref-unsafe. */
export function isSafeBranchName(name: string): boolean {
  if (!name || name.length > 250) return false;
  if (name.startsWith('-') || name.includes('..') || name.includes('//')) return false;
  // git-check-ref-format subset: printable, no spaces/control/refspec chars.
  return /^[^\s~^:?*[\\]+$/.test(name) && !name.endsWith('.lock') && !name.endsWith('/');
}
