/**
 * Read-only repository browsing for Agent Hub-hosted
 * repos: branch list (with ahead/behind vs the default branch), commit
 * log, single-commit detail (stat + patch), directory tree, blob, and
 * recursive path index. Backs the Repository page
 * (`GET /api/projects/:id/git-host/{branches,commits,tree,file,paths}`).
 *
 * Everything shells out to real `git -C <bare>`; reuses the generic
 * runner from native-pr/git-read.ts.
 */

import { spawn } from 'child_process';
import path from 'path';
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

export interface RepoFile {
  /** Branch the file was read from. */
  branch: string;
  /** Root-relative path that was read. */
  path: string;
  /** Raw file content; truncated when it exceeds the requested cap. */
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

/**
 * Read a single root-relative file from a Hub-hosted repo branch.
 * Returns null when the hosted repo, branch, or file is absent.
 */
export async function readRepoFile(
  projectId: string,
  filePath: string,
  branch?: string,
  dataDir: string = config.dataDir,
  maxBytes = 512 * 1024,
): Promise<RepoFile | null> {
  if (!hostedRepoExists(projectId, dataDir)) return null;
  if (!isSafeRepoPath(filePath)) return null;
  const repoPath = gitHostRepoPath(projectId, dataDir);
  const targetBranch = branch || (await hostedRepoDefaultBranch(projectId, dataDir));
  if (!targetBranch || !isSafeBranchName(targetBranch)) return null;

  const blob = await readGitBlobBounded(
    repoPath,
    `refs/heads/${targetBranch}:${filePath}`,
    maxBytes,
  );
  if (!blob) return null;
  return {
    branch: targetBranch,
    path: filePath,
    content: blob.buffer.toString('utf8'),
    truncated: blob.truncated,
  };
}

export interface RepoBlob {
  /** Branch the blob was read from. */
  branch: string;
  /** Root-relative path that was read. */
  path: string;
  /** Raw bytes of the blob, byte-accurately truncated at the cap. */
  buffer: Buffer;
  truncated: boolean;
}

/**
 * Read a single root-relative file from a Hub-hosted repo branch as raw
 * bytes (binary-safe — no utf8 decode). Used to serve README-referenced
 * images through the browser-loadable media mount. Returns null when the
 * hosted repo, branch, or file is absent, or the path is unsafe.
 */
export async function readRepoBlob(
  projectId: string,
  filePath: string,
  branch?: string,
  dataDir: string = config.dataDir,
  maxBytes = 10 * 1024 * 1024,
): Promise<RepoBlob | null> {
  if (!hostedRepoExists(projectId, dataDir)) return null;
  if (!isSafeRepoPath(filePath)) return null;
  const repoPath = gitHostRepoPath(projectId, dataDir);
  const targetBranch = branch || (await hostedRepoDefaultBranch(projectId, dataDir));
  if (!targetBranch || !isSafeBranchName(targetBranch)) return null;

  const blob = await readGitBlobBounded(
    repoPath,
    `refs/heads/${targetBranch}:${filePath}`,
    maxBytes,
  );
  if (!blob) return null;
  return {
    branch: targetBranch,
    path: filePath,
    buffer: blob.buffer,
    truncated: blob.truncated,
  };
}

const MAX_TREE_ENTRIES = 1000;
const MAX_TREE_LOG = 400;
const MAX_PATHS = 5000;
const RECORD_SEP = '\x1e';

export interface RepoTreeLastCommit {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

/**
 * `commit` is a gitlink (submodule). Git records it in the tree with mode
 * 160000 and type `commit`; it is neither a browsable directory nor a
 * readable blob, so callers must render it without offering either action.
 */
export type RepoTreeEntryType = 'blob' | 'tree' | 'commit';

export interface RepoTreeEntry {
  name: string;
  path: string;
  type: RepoTreeEntryType;
  size: number | null;
  mode: string;
  lastCommit: RepoTreeLastCommit | null;
}

export interface RepoTreeResult {
  branch: string;
  path: string;
  entries: RepoTreeEntry[];
  latestCommit: RepoTreeLastCommit | null;
  commitCount: number;
}

/**
 * Parse one `git ls-tree -l -z` record: `<mode> <type> <sha> <size>\t<name>`.
 *
 * Callers MUST pass `-z`. Without it git applies `core.quotePath` quoting,
 * which renders `café.txt` as `"caf\303\251.txt"` (octal escapes inside
 * quotes) and makes the returned name unusable as a path. `-z` emits the
 * bytes verbatim, so no unescaping belongs here.
 */
function parseLsTreeRecord(line: string): {
  mode: string;
  type: RepoTreeEntryType;
  sha: string;
  size: number | null;
  name: string;
} | null {
  const tab = line.indexOf('\t');
  if (tab < 0) return null;
  const meta = line.slice(0, tab);
  const name = line.slice(tab + 1);
  const parts = meta.split(/\s+/);
  if (parts.length < 4) return null;
  const [mode, typeRaw, sha, sizeRaw] = parts;
  // `commit` is a submodule gitlink. Dropping it (as returning null did) made
  // a directory of submodules render as empty.
  const type: RepoTreeEntryType | null =
    typeRaw === 'tree' || typeRaw === 'blob' || typeRaw === 'commit' ? typeRaw : null;
  if (!type || !name) return null;
  const size = sizeRaw === '-' ? null : Number.parseInt(sizeRaw, 10);
  return {
    mode,
    type,
    sha,
    size: Number.isFinite(size) ? size : null,
    name,
  };
}

function joinRepoPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function relativeToDir(filePath: string, dir: string): string | null {
  if (!dir) return filePath;
  const prefix = `${dir}/`;
  if (filePath === dir) return '';
  if (!filePath.startsWith(prefix)) return null;
  return filePath.slice(prefix.length);
}

async function lastCommitsForTree(
  repoPath: string,
  branch: string,
  dir: string,
  entries: RepoTreeEntry[],
): Promise<RepoTreeLastCommit | null> {
  const remaining = new Map(entries.map((e) => [e.name, e]));
  const logArgs = [
    'log',
    `--max-count=${MAX_TREE_LOG}`,
    `--format=${RECORD_SEP}%H${SEP}%s${SEP}%an${SEP}%aI`,
    '--name-only',
    // Without -z git quotes non-ASCII paths, so `café.txt` arrives as
    // `"caf\303\251.txt"` and never matches the ls-tree entry name.
    '-z',
    '--first-parent',
    `refs/heads/${branch}`,
  ];
  if (dir) logArgs.push('--', dir);
  let out: string;
  try {
    out = await git(repoPath, logArgs);
  } catch {
    return null;
  }

  let latest: RepoTreeLastCommit | null = null;
  let current: RepoTreeLastCommit | null = null;
  // `-z` records: `<RECORD_SEP>sha<SEP>…<NUL>\n<path><NUL><path><NUL>…`. The
  // newline git inserts between a commit header and its name list rides on the
  // first path token, so it is stripped there and nowhere else (a path may
  // legitimately begin with a newline).
  let afterHeader = false;
  for (const token of out.split('\0')) {
    const raw = afterHeader && token.startsWith('\n') ? token.slice(1) : token;
    afterHeader = false;
    if (!raw) continue;
    if (raw.startsWith(RECORD_SEP)) {
      const [sha, subject, author, date] = raw.slice(1).split(SEP);
      if (!sha) continue;
      current = { sha, subject: subject ?? '', author: author ?? '', date: date ?? '' };
      if (!latest) latest = current;
      afterHeader = true;
      continue;
    }
    if (!current || remaining.size === 0) continue;
    const rel = relativeToDir(raw, dir);
    if (rel === null || rel === '') continue;
    const top = rel.split('/')[0];
    const entry = remaining.get(top);
    if (entry && !entry.lastCommit) {
      entry.lastCommit = current;
      remaining.delete(top);
    }
  }
  return latest;
}

/**
 * Directory listing of a Hub-hosted repo branch (GitHub Code-tab file
 * table). `dirPath` empty means the tree root. Returns null when the
 * hosted repo, branch, or path is missing.
 */
export async function listRepoTree(
  projectId: string,
  branch?: string,
  dirPath = '',
  dataDir: string = config.dataDir,
): Promise<RepoTreeResult | null> {
  if (!hostedRepoExists(projectId, dataDir)) return null;
  if (dirPath && !isSafeRepoPath(dirPath)) return null;
  const repoPath = gitHostRepoPath(projectId, dataDir);
  const targetBranch = branch || (await hostedRepoDefaultBranch(projectId, dataDir));
  if (!targetBranch || !isSafeBranchName(targetBranch)) return null;

  const treeish = dirPath ? `refs/heads/${targetBranch}:${dirPath}` : `refs/heads/${targetBranch}`;
  let out: string;
  try {
    // -z keeps names byte-exact: no `core.quotePath` octal escaping, no
    // surrounding quotes, and newlines in names stay inside their record.
    out = await git(repoPath, ['ls-tree', '-l', '-z', treeish]);
  } catch {
    return null;
  }

  const entries: RepoTreeEntry[] = [];
  for (const record of out.split('\0')) {
    if (!record) continue;
    const parsed = parseLsTreeRecord(record);
    if (!parsed) continue;
    entries.push({
      name: parsed.name,
      path: joinRepoPath(dirPath, parsed.name),
      type: parsed.type,
      size: parsed.size,
      mode: parsed.mode,
      lastCommit: null,
    });
    if (entries.length >= MAX_TREE_ENTRIES) break;
  }

  // Explicit rank: a two-way `tree ? -1 : 1` test is not a total order once a
  // third type exists (blob-vs-commit and commit-vs-blob would both return 1).
  // Submodules sort with directories, as they do on GitHub.
  const typeRank: Record<RepoTreeEntryType, number> = { tree: 0, commit: 1, blob: 2 };
  entries.sort((a, b) => {
    if (a.type !== b.type) return typeRank[a.type] - typeRank[b.type];
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  const latestCommit = await lastCommitsForTree(repoPath, targetBranch, dirPath, entries);

  let commitCount = 0;
  try {
    const countOut = await git(repoPath, ['rev-list', '--count', `refs/heads/${targetBranch}`]);
    commitCount = Number.parseInt(countOut.trim(), 10);
    if (!Number.isFinite(commitCount)) commitCount = 0;
  } catch {
    commitCount = 0;
  }

  return {
    branch: targetBranch,
    path: dirPath,
    entries,
    latestCommit,
    commitCount,
  };
}

/**
 * Recursive file paths on a branch (GitHub "Go to file"). Directories
 * are omitted — only blobs. Capped at {@link MAX_PATHS}.
 */
export async function listRepoPaths(
  projectId: string,
  branch?: string,
  dataDir: string = config.dataDir,
): Promise<{ branch: string; paths: string[] } | null> {
  if (!hostedRepoExists(projectId, dataDir)) return null;
  const repoPath = gitHostRepoPath(projectId, dataDir);
  const targetBranch = branch || (await hostedRepoDefaultBranch(projectId, dataDir));
  if (!targetBranch || !isSafeBranchName(targetBranch)) return null;
  let out: string;
  try {
    // Full records, not --name-only: the type column is the only way to tell a
    // submodule gitlink from a blob, and offering a gitlink in "Go to file"
    // just 404s when the user picks it.
    // -l as well as -r: parseLsTreeRecord expects the size column.
    out = await git(repoPath, ['ls-tree', '-r', '-l', '-z', `refs/heads/${targetBranch}`]);
  } catch {
    return null;
  }
  // No trim: `-z` already delimits exactly, and trimming would rewrite a real
  // ` plain.txt` into `plain.txt`, which then 404s when opened.
  const paths: string[] = [];
  for (const record of out.split('\0')) {
    if (!record) continue;
    const parsed = parseLsTreeRecord(record);
    if (!parsed || parsed.type !== 'blob') continue;
    paths.push(parsed.name);
    if (paths.length >= MAX_PATHS) break;
  }
  return { branch: targetBranch, paths };
}

export interface RepoFileBrowse {
  branch: string;
  path: string;
  /** UTF-8 text when the blob is not binary; null for binary files. */
  content: string | null;
  binary: boolean;
  truncated: boolean;
  size: number;
}

const MAX_FILE_BYTES = 512 * 1024;

/**
 * Browse a single file on a Hub-hosted branch (GitHub blob page).
 * Returns null when the repo, branch, or path is missing.
 */
export async function readRepoFileBrowse(
  projectId: string,
  filePath: string,
  branch?: string,
  dataDir: string = config.dataDir,
): Promise<RepoFileBrowse | null> {
  if (!hostedRepoExists(projectId, dataDir)) return null;
  if (!isSafeRepoPath(filePath)) return null;
  const repoPath = gitHostRepoPath(projectId, dataDir);
  const targetBranch = branch || (await hostedRepoDefaultBranch(projectId, dataDir));
  if (!targetBranch || !isSafeBranchName(targetBranch)) return null;

  let size = 0;
  try {
    const sizeOut = await git(repoPath, [
      'cat-file',
      '-s',
      `refs/heads/${targetBranch}:${filePath}`,
    ]);
    size = Number.parseInt(sizeOut.trim(), 10);
    if (!Number.isFinite(size)) size = 0;
  } catch {
    return null;
  }

  const blob = await readGitBlobBounded(
    repoPath,
    `refs/heads/${targetBranch}:${filePath}`,
    MAX_FILE_BYTES,
  );
  if (!blob) return null;
  const binary = blob.buffer.includes(0);
  return {
    branch: targetBranch,
    path: filePath,
    content: binary ? null : blob.buffer.toString('utf8'),
    binary,
    truncated: blob.truncated,
    size,
  };
}

/** Branch names come from URLs — refuse anything ref-unsafe. */
export function isSafeBranchName(name: string): boolean {
  if (!name || name.length > 250) return false;
  if (name.startsWith('-') || name.includes('..') || name.includes('//')) return false;
  // git-check-ref-format subset: printable, no spaces/control/refspec chars.
  return /^[^\s~^:?*[\\]+$/.test(name) && !name.endsWith('.lock') && !name.endsWith('/');
}

export function isSafeRepoPath(filePath: string): boolean {
  if (!filePath || filePath.length > 500 || path.isAbsolute(filePath)) return false;
  return filePath
    .split('/')
    .every((part) => part.length > 0 && part !== '.' && part !== '..' && !part.includes('\0'));
}
