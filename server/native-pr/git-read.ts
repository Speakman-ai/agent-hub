/**
 * git-read.ts — read-only git queries against a hosted bare repo for
 * native PRs: diff, changed files, commits, shortstat, mergeability.
 *
 * Everything here shells out to real `git` with `-C <bareRepo>`; no
 * worktree or checkout is ever needed. Mergeability uses
 * `git merge-tree --write-tree` (git ≥ 2.38) — asserted once via
 * {@link assertMergeTreeSupport}.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

const GIT_TIMEOUT_MS = 60_000;
/** Diff output cap — same ballpark as the GitHub API's diff truncation. */
const MAX_DIFF_BYTES = 16 * 1024 * 1024;

export async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', ['-C', repoPath, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_DIFF_BYTES,
  });
  return stdout;
}

let mergeTreeChecked = false;

/**
 * `git merge-tree --write-tree` shipped in git 2.38. Checked once per
 * process with a clear error so a misprovisioned host fails loudly at
 * the first merge instead of with a cryptic exit code.
 */
export async function assertMergeTreeSupport(): Promise<void> {
  if (mergeTreeChecked) return;
  const { stdout } = await execFileP('git', ['--version'], { timeout: 10_000 });
  const match = stdout.match(/git version (\d+)\.(\d+)/);
  if (!match) throw new Error(`could not parse git version from: ${stdout.trim()}`);
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major < 2 || (major === 2 && minor < 38)) {
    throw new Error(
      `Agent Hub-hosted PR merges require git >= 2.38 (for merge-tree --write-tree); found ${stdout.trim()}`,
    );
  }
  mergeTreeChecked = true;
}

export async function revParse(repoPath: string, ref: string): Promise<string | null> {
  try {
    return (await git(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  } catch {
    return null;
  }
}

/** Does `filePath` exist as a blob in the tree of `commitSha`? */
export async function blobExistsAtCommit(
  repoPath: string,
  commitSha: string,
  filePath: string,
): Promise<boolean> {
  try {
    await git(repoPath, ['cat-file', '-e', `${commitSha}:${filePath}`]);
    return true;
  } catch {
    return false;
  }
}

export interface MergeTreeResult {
  mergeable: boolean;
  /** Tree OID when mergeable. */
  treeOid: string | null;
  /** Conflict detail (file list) when not mergeable. */
  conflictDetail: string | null;
}

/**
 * Dry-run merge of `headSha` into `baseSha` without touching any
 * worktree. Exit 0 → clean (stdout line 1 = tree OID); exit 1 →
 * conflicts (stdout carries the conflicted-file sections).
 */
export async function mergeTree(
  repoPath: string,
  baseSha: string,
  headSha: string,
): Promise<MergeTreeResult> {
  await assertMergeTreeSupport();
  try {
    const stdout = await git(repoPath, [
      'merge-tree',
      '--write-tree',
      '--messages',
      baseSha,
      headSha,
    ]);
    const treeOid = stdout.split('\n', 1)[0]?.trim() || null;
    return { mergeable: true, treeOid, conflictDetail: null };
  } catch (err: unknown) {
    // Exit 1 = conflicts; anything else is a real failure.
    const e = err as { code?: number; stdout?: string; message?: string };
    if (e.code === 1) {
      const detail = (e.stdout ?? '').split('\n').slice(1).join('\n').trim();
      return { mergeable: false, treeOid: null, conflictDetail: detail || 'merge conflicts' };
    }
    throw err;
  }
}

/** Unified diff `base...head` (three-dot: changes introduced by head). */
export async function prDiff(repoPath: string, baseSha: string, headSha: string): Promise<string> {
  return git(repoPath, ['diff', `${baseSha}...${headSha}`]);
}

export interface PrFileEntry {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string;
}

/**
 * Changed files with per-file add/delete counts and patches — field names
 * deliberately match the GitHub `pulls/:n/files` shape consumed by the
 * existing client (`pr-read-fetch.ts` contract).
 */
export async function prFiles(
  repoPath: string,
  baseSha: string,
  headSha: string,
): Promise<PrFileEntry[]> {
  const range = `${baseSha}...${headSha}`;
  const [numstatOut, statusOut] = await Promise.all([
    git(repoPath, ['diff', '--numstat', range]),
    git(repoPath, ['diff', '--name-status', '-M', range]),
  ]);

  const statusByFile = new Map<string, PrFileEntry['status']>();
  for (const line of statusOut.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0]?.[0];
    if (code === 'R' && parts[2]) {
      statusByFile.set(parts[2], 'renamed');
    } else if (code === 'A' && parts[1]) {
      statusByFile.set(parts[1], 'added');
    } else if (code === 'D' && parts[1]) {
      statusByFile.set(parts[1], 'removed');
    } else if (parts[1]) {
      statusByFile.set(parts[1], 'modified');
    }
  }

  const entries: PrFileEntry[] = [];
  for (const line of numstatOut.split('\n')) {
    if (!line.trim()) continue;
    const [adds, dels, ...nameParts] = line.split('\t');
    let filename = nameParts.join('\t');
    // Rename numstat shape: `1\t2\told => new` or `{a => b}/c`. Use the
    // post-rename side so it matches the name-status map.
    const arrow = filename.lastIndexOf(' => ');
    if (arrow >= 0 && !filename.includes('{')) {
      filename = filename.slice(arrow + 4);
    }
    entries.push({
      filename,
      status: statusByFile.get(filename) ?? 'modified',
      additions: adds === '-' ? 0 : Number(adds),
      deletions: dels === '-' ? 0 : Number(dels),
    });
  }

  // Per-file patches (best-effort; binary files yield no patch).
  for (const entry of entries.slice(0, 100)) {
    try {
      const patch = await git(repoPath, ['diff', range, '--', entry.filename]);
      if (patch.trim()) entry.patch = patch;
    } catch {
      // skip patch for unreadable entries
    }
  }
  return entries;
}

export interface PrCommitEntry {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

export async function prCommits(
  repoPath: string,
  baseSha: string,
  headSha: string,
): Promise<PrCommitEntry[]> {
  const out = await git(repoPath, [
    'log',
    '--format=%H%x1f%s%x1f%an%x1f%aI',
    `${baseSha}..${headSha}`,
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, author, date] = line.split('\x1f');
      return { sha, subject, author, date };
    });
}

export interface PrDiffStat {
  additions: number;
  deletions: number;
  changedFiles: number;
}

export async function prDiffStat(
  repoPath: string,
  baseSha: string,
  headSha: string,
): Promise<PrDiffStat> {
  const out = await git(repoPath, ['diff', '--shortstat', `${baseSha}...${headSha}`]);
  const files = out.match(/(\d+) files? changed/);
  const adds = out.match(/(\d+) insertions?\(\+\)/);
  const dels = out.match(/(\d+) deletions?\(-\)/);
  return {
    changedFiles: files ? Number(files[1]) : 0,
    additions: adds ? Number(adds[1]) : 0,
    deletions: dels ? Number(dels[1]) : 0,
  };
}
