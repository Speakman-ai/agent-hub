/**
 * Session file-change (code diff) computation.
 *
 * Powers the web client's "Changes" pane: a GitHub-style view of every
 * file the agent touched in a session worktree. The baseline is the
 * merge-base of `origin/<baseBranch>` and the worktree HEAD, and the diff
 * is taken against the **working tree** so it captures committed *and*
 * uncommitted edits (the total session delta) — newly created files that
 * git doesn't track yet are surfaced separately as `added`.
 *
 * Every command runs through the session's {@link SessionWorktreeIo}, not a
 * host path: under a microVM env the worktree lives on the guest's disk and
 * the host directory is a boot-time seed, so host-side git would report the
 * session as empty. The {@link GitExec} seam stays injectable so tests never
 * spawn a real `git` (they pass canned output). It tolerates `git diff
 * --no-index`'s exit code 1 (which simply means "differences found"), unlike
 * the throw-on-nonzero wrappers in worktree.ts / auto-git.ts.
 */
import path from 'path';
import { resolveDefaultBranchIn } from './git-default-branch.js';
import type { SessionWorktreeIo } from './session-env/worktree-io.js';

/** Thrown when a caller-supplied path is absolute or escapes the worktree.
 * Callers (the route layer) map this to a 400 rather than a 500. */
export class UnsafePathError extends Error {
  constructor(file: string) {
    super(`unsafe file path rejected: ${file}`);
    this.name = 'UnsafePathError';
  }
}

/**
 * Normalize a caller-supplied worktree-relative path, rejecting absolute
 * paths and `..` traversal that would escape the worktree.
 *
 * Returns the normalized path (forward-slashed, matching git's own output),
 * or `null` when the path is unsafe. This is the choke point that stops the
 * per-file diff endpoint from becoming an arbitrary server file-read
 * primitive via `git diff --no-index /etc/passwd`.
 *
 * Deliberately takes no root: containment is a property of the path itself,
 * and the root is not knowable under an `env-owned` env, where the worktree
 * lives inside the guest and has no host path at all.
 */
export function resolveWorktreeRelativePath(file: string): string | null {
  if (!file || typeof file !== 'string') return null;
  if (path.isAbsolute(file) || file.startsWith('\\')) return null;
  let rel = path.normalize(file);
  // `normalize` keeps a trailing separator ("src/" → "src/"); git never emits
  // one, so drop it to keep these paths comparable with git output.
  while (rel.length > 1 && rel.endsWith(path.sep)) rel = rel.slice(0, -1);
  if (!rel || rel === '.' || rel === '..') return null;
  if (rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  // Normalize separators to match git's forward-slash output on all platforms.
  return rel.split(path.sep).join('/');
}

/**
 * Hub-owned paths that can appear dirty in a session worktree but are not
 * session/agent code changes (e.g. session-startup status). Exclude them from
 * the Changes pane / badge so the count matches "diff vs base branch of what
 * you would ship", not platform bookkeeping.
 */
export function isHubManagedChangePath(file: string): boolean {
  const rel = resolveWorktreeRelativePath(file) ?? file.replaceAll('\\', '/');
  return rel === '.agent-hub-runtime' || rel.startsWith('.agent-hub-runtime/');
}

/** Git's empty-tree object hash — used as the base when no real base ref
 * can be resolved (brand-new repo / detached worktree with no upstream). */
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/** Cap the file list so a pathological session (generated lockfiles,
 * vendored trees) can't return a multi-thousand-entry payload. */
export const MAX_CHANGED_FILES = 600;

/** Above this many bytes a single-file unified diff is withheld and the
 * client is told to render a "diff too large" placeholder. */
export const MAX_FILE_DIFF_BYTES = 1_500_000;

/** Cap on how many untracked files get a per-file `--no-index --numstat`
 * line-count probe. Untracked respects .gitignore so this is usually a small
 * number; the cap bounds the TOTAL git-process count for pathological sets. */
export const MAX_UNTRACKED_NUMSTAT = 300;

/** Max untracked numstat probes running at once. Bounds CONCURRENT git
 * processes so a many-untracked-file session (the pane refetches on every
 * `code_changed`) can't fan out hundreds of spawns and starve the host. */
export const UNTRACKED_NUMSTAT_CONCURRENCY = 8;

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed';

export interface SessionChangeFile {
  /** Path relative to repo root (the *new* path for renames). */
  path: string;
  /** Previous path, only set for renames/copies. */
  oldPath?: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  /** True for binary files (no textual line counts available). */
  binary: boolean;
  /** True for files git isn't tracking yet (freshly created). */
  untracked: boolean;
}

export interface SessionChangesSummary {
  baseBranch: string | null;
  /** Merge-base SHA the diff is anchored to (null if unresolved). */
  baseSha: string | null;
  headSha: string | null;
  branch: string | null;
  /** True when `git status --porcelain` is non-empty. */
  dirty: boolean;
  files: SessionChangeFile[];
  /** True when the file list was capped at {@link MAX_CHANGED_FILES}. */
  truncated: boolean;
}

export interface FileDiffResult {
  path: string;
  status: ChangeStatus;
  binary: boolean;
  /** Unified diff body (empty when binary or tooLarge). */
  unifiedDiff: string;
  /** True when the diff exceeded {@link MAX_FILE_DIFF_BYTES} and was withheld. */
  tooLarge: boolean;
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Run git in the session worktree. Takes no `cwd`: every command here runs at
 * the worktree root, and under an `env-owned` env there is no host directory
 * to name anyway.
 */
export type GitExec = (args: string[]) => Promise<GitExecResult>;

/**
 * The default exec, bound to one session's worktree. Never prompts, and
 * resolves (rather than rejects) on the expected non-zero exits used by diff.
 */
export function gitExecForWorktree(io: SessionWorktreeIo): GitExec {
  return async (args) => {
    const { stdout, stderr, exitCode } = await io.git(args, {
      timeoutMs: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    // A signal kill reports `null`; treat it as a generic failure so callers
    // that only inspect `code` cannot mistake it for success.
    return { stdout, stderr, code: exitCode ?? 1 };
  };
}

export interface ComputeChangesOptions {
  /** The session's worktree, wherever it physically lives. */
  io: SessionWorktreeIo;
  /** Preferred base branch — typically the session's resolved PR base
   * (card → epic → repo default, via resolveFinalizeBaseBranchForCard).
   * Falls back to the repo's resolved default branch when null/undefined. */
  baseBranch?: string | null;
  exec?: GitExec;
  resolveBaseBranch?: (io: SessionWorktreeIo) => Promise<string | null>;
}

/** Map a `git diff --name-status` letter to our status enum. */
function statusFromLetter(letter: string): ChangeStatus {
  switch (letter[0]) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'type-changed';
    default:
      return 'modified';
  }
}

/** Parse NUL-delimited `git diff -z --name-status` output. */
export function parseNameStatusZ(
  out: string,
): Array<{ status: ChangeStatus; path: string; oldPath?: string }> {
  const tokens = out.split('\0').filter((t) => t.length > 0);
  const result: Array<{ status: ChangeStatus; path: string; oldPath?: string }> = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i++];
    const status = statusFromLetter(code);
    if ((code[0] === 'R' || code[0] === 'C') && i + 1 < tokens.length + 1) {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      result.push({ status, path: newPath, oldPath });
    } else {
      const p = tokens[i++];
      if (p === undefined) break;
      result.push({ status, path: p });
    }
  }
  return result;
}

/** Parse NUL-delimited `git diff -z --numstat` output. Returns a map keyed
 * by the new path. Binary files report `-` for additions/deletions. */
export function parseNumstatZ(
  out: string,
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const tokens = out.split('\0');
  const map = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i];
    if (head === undefined || head.length === 0) {
      i++;
      continue;
    }
    // Each record begins with "<adds>\t<dels>\t<path?>". For renames the
    // path is empty and the old/new paths follow as two extra NUL fields.
    const parts = head.split('\t');
    if (parts.length < 3) {
      i++;
      continue;
    }
    const [addsRaw, delsRaw, inlinePath] = parts;
    const binary = addsRaw === '-' || delsRaw === '-';
    const additions = binary ? 0 : parseInt(addsRaw, 10) || 0;
    const deletions = binary ? 0 : parseInt(delsRaw, 10) || 0;
    i++;
    let key = inlinePath;
    if (!inlinePath) {
      // Rename/copy: next two tokens are oldPath, newPath.
      const oldPath = tokens[i++] ?? '';
      const newPath = tokens[i++] ?? '';
      key = newPath || oldPath;
    }
    if (key) map.set(key, { additions, deletions, binary });
  }
  return map;
}

/**
 * Build the path operand for `git diff --no-index`. The leading `./` forces
 * git to treat the (already worktree-relative, validated) path as a path
 * rather than a revision or option — robust for dash-like or unusual names —
 * while keeping it relative so no absolute server path leaks into the patch.
 * Combined with the `--` separator the operand is unambiguous.
 */
function noIndexOperand(file: string): string {
  return file.startsWith('./') ? file : `./${file}`;
}

/** Thrown when a core git command exits non-zero — the route maps this to a
 * 500 so the Changes pane shows an error rather than a false "no changes". */
export class GitCommandError extends Error {
  constructor(label: string, result: GitExecResult) {
    const detail = result.stderr.trim() || result.stdout.trim() || 'no output';
    super(`git ${label} failed (exit ${result.code}): ${detail}`);
    this.name = 'GitCommandError';
  }
}

/** Throw {@link GitCommandError} when a command we treat as authoritative
 * exited non-zero. */
function assertGitOk(label: string, result: GitExecResult): void {
  if (result.code !== 0) throw new GitCommandError(label, result);
}

/**
 * Line counts for a single untracked file via `git diff --no-index --numstat`
 * (the file vs. /dev/null — an all-add patch). Returns binary=true and zero
 * additions for binary files. Best-effort: any failure resolves to 0/false.
 */
async function untrackedNumstat(
  exec: GitExec,
  file: string,
): Promise<{ additions: number; binary: boolean }> {
  try {
    // `--no-index` exits 1 when differences exist — expected, not an error.
    const r = await exec([
      'diff',
      '--no-index',
      '--numstat',
      '--',
      '/dev/null',
      noIndexOperand(file),
    ]);
    const line = r.stdout.split('\n').find((l) => l.trim().length > 0) ?? '';
    const [addsRaw, delsRaw] = line.split('\t');
    if (addsRaw === undefined || delsRaw === undefined) return { additions: 0, binary: false };
    const binary = addsRaw === '-' || delsRaw === '-';
    return { additions: binary ? 0 : parseInt(addsRaw, 10) || 0, binary };
  } catch {
    return { additions: 0, binary: false };
  }
}

async function revParse(exec: GitExec, ref: string): Promise<string | null> {
  const r = await exec(['rev-parse', '--verify', '--quiet', ref]);
  const sha = r.stdout.trim();
  return r.code === 0 && sha ? sha : null;
}

/** Resolve the SHA the session diff should be anchored against: the
 * merge-base of the best-available base ref and HEAD, falling back to the
 * base ref itself, then to the empty tree. */
async function resolveBaseSha(exec: GitExec, baseBranch: string | null): Promise<string | null> {
  const candidates = baseBranch
    ? [`origin/${baseBranch}`, baseBranch]
    : ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'];
  for (const ref of candidates) {
    const sha = await revParse(exec, ref);
    if (!sha) continue;
    const mb = await exec(['merge-base', sha, 'HEAD']);
    const mbSha = mb.stdout.trim();
    if (mb.code === 0 && mbSha) return mbSha;
    return sha;
  }
  return null;
}

/**
 * Map over `items` with bounded concurrency, preserving result order. Used to
 * cap how many `git diff --no-index` probes run at once so a session with many
 * untracked files can't spawn an unbounded burst of git processes.
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * Normalize + dedupe untracked paths from `ls-files -z` output through the
 * worktree-relative safety helper. `ls-files` already yields repo-relative
 * names, but these paths are later handed to `git diff --no-index`, so we run
 * them through the same boundary `computeFileDiff` uses rather than trusting
 * that invariant — anything that doesn't resolve inside the worktree is
 * dropped. Returns the normalized paths not already present in `alreadySeen`.
 */
function normalizeUntracked(lsFilesZ: string, alreadySeen: Set<string>): string[] {
  const out: string[] = [];
  const seen = new Set(alreadySeen);
  for (const raw of lsFilesZ.split('\0')) {
    if (!raw) continue;
    const safe = resolveWorktreeRelativePath(raw);
    if (!safe || seen.has(safe)) continue;
    seen.add(safe);
    out.push(safe);
  }
  return out;
}

/**
 * Untruncated membership lookup: every path changed in the session worktree
 * (committed, uncommitted, untracked) mapped to whether it's untracked. This
 * is the authorization set for the per-file diff route — deliberately separate
 * from {@link computeSessionChanges}, whose UI payload is capped at
 * {@link MAX_CHANGED_FILES}. Gating diffs against the capped list would 404
 * valid changed files past the cap. Lighter than the full summary: no numstat,
 * no sort, no truncation.
 */
export async function listSessionChangedPaths(
  opts: ComputeChangesOptions,
): Promise<Map<string, { untracked: boolean }>> {
  const exec = opts.exec ?? gitExecForWorktree(opts.io);
  const resolveBase = opts.resolveBaseBranch ?? resolveDefaultBranchIn;

  const baseBranch = opts.baseBranch ?? (await resolveBase(opts.io)) ?? null;
  const baseSha = (await resolveBaseSha(exec, baseBranch)) ?? EMPTY_TREE_SHA;

  const [nameStatusRes, untrackedRes] = await Promise.all([
    exec(['diff', '-M', '-z', '--name-status', baseSha]),
    exec(['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  assertGitOk('diff --name-status', nameStatusRes);
  assertGitOk('ls-files --others', untrackedRes);

  const membership = new Map<string, { untracked: boolean }>();
  for (const s of parseNameStatusZ(nameStatusRes.stdout)) {
    if (isHubManagedChangePath(s.path)) continue;
    membership.set(s.path, { untracked: false });
  }
  const seen = new Set(membership.keys());
  for (const p of normalizeUntracked(untrackedRes.stdout, seen)) {
    if (isHubManagedChangePath(p)) continue;
    membership.set(p, { untracked: true });
  }
  return membership;
}

/**
 * Compute the full set of files changed in a session worktree relative to
 * its base branch, including uncommitted and untracked files.
 */
export async function computeSessionChanges(
  opts: ComputeChangesOptions,
): Promise<SessionChangesSummary> {
  const exec = opts.exec ?? gitExecForWorktree(opts.io);
  const resolveBase = opts.resolveBaseBranch ?? resolveDefaultBranchIn;

  const baseBranch = opts.baseBranch ?? (await resolveBase(opts.io)) ?? null;
  const baseSha = (await resolveBaseSha(exec, baseBranch)) ?? EMPTY_TREE_SHA;

  const [branchRes, headRes, statusRes, nameStatusRes, numstatRes, untrackedRes] =
    await Promise.all([
      exec(['rev-parse', '--abbrev-ref', 'HEAD']),
      exec(['rev-parse', 'HEAD']),
      exec(['status', '--porcelain']),
      exec(['diff', '-M', '-z', '--name-status', baseSha]),
      exec(['diff', '-M', '-z', '--numstat', baseSha]),
      exec(['ls-files', '--others', '--exclude-standard', '-z']),
    ]);

  // Surface a real git failure instead of silently returning an empty/partial
  // change set. A stale worktree path, a non-repo directory, or a corrupt repo
  // makes these core commands exit non-zero — without this the pane would lie
  // to the user with "no changes". `rev-parse HEAD`/`--abbrev-ref` are NOT
  // checked here: they legitimately fail on a branch with no commits yet, a
  // case handled below by leaving headSha/branch null.
  assertGitOk('status --porcelain', statusRes);
  assertGitOk('diff --name-status', nameStatusRes);
  assertGitOk('diff --numstat', numstatRes);
  assertGitOk('ls-files --others', untrackedRes);

  const branch = branchRes.code === 0 ? branchRes.stdout.trim() || null : null;
  const headSha = headRes.code === 0 ? headRes.stdout.trim() || null : null;
  const dirty = statusRes.stdout.trim().length > 0;

  const statuses = parseNameStatusZ(nameStatusRes.stdout);
  const numstat = parseNumstatZ(numstatRes.stdout);

  const files: SessionChangeFile[] = [];
  const seen = new Set<string>();

  for (const s of statuses) {
    if (isHubManagedChangePath(s.path)) continue;
    const stat = numstat.get(s.path);
    files.push({
      path: s.path,
      oldPath: s.oldPath,
      status: s.status,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      binary: stat?.binary ?? false,
      untracked: false,
    });
    seen.add(s.path);
  }

  // Untracked files (newly created, not yet `git add`-ed). Surface them as
  // additions so the agent's brand-new files don't silently vanish. Derive
  // real line counts via `git diff --no-index --numstat` (an untracked file
  // is an all-add patch) so the UI doesn't show "+0 −0" for new text files.
  // Paths are normalized through the worktree-safety helper before any are
  // handed to git, since they feed `--no-index` spawns.
  const untrackedToAdd = normalizeUntracked(untrackedRes.stdout, seen).filter(
    (p) => !isHubManagedChangePath(p),
  );
  // Bound the per-file numstat probes: untracked respects .gitignore so this
  // is normally a handful of files, but cap it so a pathological set can't
  // spawn hundreds of git processes. Files past the cap fall back to 0/0.
  const numstatTargets = untrackedToAdd.slice(0, MAX_UNTRACKED_NUMSTAT);
  // Bounded concurrency: process all targets but never more than
  // UNTRACKED_NUMSTAT_CONCURRENCY git spawns in flight at once.
  const untrackedStats = await mapLimit(numstatTargets, UNTRACKED_NUMSTAT_CONCURRENCY, (p) =>
    untrackedNumstat(exec, p),
  );
  const untrackedStatByPath = new Map(numstatTargets.map((p, i) => [p, untrackedStats[i]]));
  for (const p of untrackedToAdd) {
    const stat = untrackedStatByPath.get(p);
    files.push({
      path: p,
      status: 'added',
      additions: stat?.additions ?? 0,
      deletions: 0,
      binary: stat?.binary ?? false,
      untracked: true,
    });
    seen.add(p);
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  const truncated = files.length > MAX_CHANGED_FILES;

  return {
    baseBranch,
    baseSha: baseSha === EMPTY_TREE_SHA ? null : baseSha,
    headSha,
    branch,
    dirty,
    files: truncated ? files.slice(0, MAX_CHANGED_FILES) : files,
    truncated,
  };
}

export interface ComputeFileDiffOptions extends ComputeChangesOptions {
  /** Repo-relative path to diff (the new path for renames). */
  file: string;
  /** Pass true when the file is untracked (uses `git diff --no-index`). */
  untracked?: boolean;
}

/**
 * Compute the unified diff for a single file vs the session base. Returns
 * `tooLarge` (with an empty body) when the patch exceeds the byte cap.
 */
export async function computeFileDiff(opts: ComputeFileDiffOptions): Promise<FileDiffResult> {
  const exec = opts.exec ?? gitExecForWorktree(opts.io);
  const resolveBase = opts.resolveBaseBranch ?? resolveDefaultBranchIn;

  // Defense-in-depth: never hand an unvalidated path to git. Even though the
  // route also verifies membership in the changed-file set, this primitive
  // must be safe on its own — an absolute or `..`-traversal path would
  // otherwise turn `git diff --no-index` into a server file-read oracle.
  const file = resolveWorktreeRelativePath(opts.file);
  if (!file) throw new UnsafePathError(opts.file);

  let unifiedDiff: string;
  if (opts.untracked) {
    // `--no-index` against /dev/null renders a brand-new file as an all-add
    // patch. Exit 0 = identical, 1 = differences found (the expected case);
    // anything else (e.g. 128 when the file vanished after the membership
    // check, or the repo went invalid) is fatal and must surface, not be
    // treated as an empty diff.
    const r = await exec(['diff', '--no-index', '--', '/dev/null', noIndexOperand(file)]);
    if (r.code !== 0 && r.code !== 1) throw new GitCommandError('diff --no-index', r);
    unifiedDiff = r.stdout;
  } else {
    const baseBranch = opts.baseBranch ?? (await resolveBase(opts.io)) ?? null;
    const baseSha = (await resolveBaseSha(exec, baseBranch)) ?? EMPTY_TREE_SHA;
    // Plain `git diff` (no --exit-code) returns 0 even with differences, so a
    // non-zero exit is always a real failure — don't return it as an empty diff.
    const r = await exec(['diff', '-M', baseSha, '--', file]);
    if (r.code !== 0) throw new GitCommandError('diff', r);
    unifiedDiff = r.stdout;
  }

  const binary = /^Binary files .* differ$/m.test(unifiedDiff);
  const byteLen = Buffer.byteLength(unifiedDiff, 'utf8');
  const tooLarge = byteLen > MAX_FILE_DIFF_BYTES;

  return {
    path: file,
    status: opts.untracked ? 'added' : inferStatusFromDiff(unifiedDiff),
    binary,
    unifiedDiff: tooLarge || binary ? '' : unifiedDiff,
    tooLarge,
  };
}

/** Best-effort status inference from a unified diff header. */
function inferStatusFromDiff(diff: string): ChangeStatus {
  if (/^new file mode /m.test(diff)) return 'added';
  if (/^deleted file mode /m.test(diff)) return 'deleted';
  if (/^rename from /m.test(diff)) return 'renamed';
  if (/^copy from /m.test(diff)) return 'copied';
  return 'modified';
}
