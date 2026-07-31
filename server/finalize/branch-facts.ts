/**
 * branch-facts.ts — read-only git facts about a session branch.
 *
 * A leaf module on purpose: `execGit` and the commit/diff-stat readers are
 * wanted by callers that have no business importing the push path's auth,
 * `gh`, and native-PR graph (the origin guard, the end-of-run summary). It
 * only touches `child_process`, so importing it costs nothing.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Cap stdout/stderr at 10 MiB to match auto-git.ts's STREAM_OUTPUT_MAX_BYTES. */
export const MAX_BUFFER = 10 * 1024 * 1024;

/** Per-call timeout for the read-only branch queries below. */
const READ_TIMEOUT_MS = 10_000;

export interface CommitInfo {
  subject: string;
  body?: string;
}

/**
 * Run a command, rethrowing with stderr/stdout folded into the message.
 *
 * `execFileAsync`'s rejection `.message` is typically just `Command failed:
 * <cmd>` — the actual git / gh diagnostic lands on `err.stderr`, which the
 * Finalize push path otherwise discards. Folding it in here is what makes the
 * `[finalize-push] github_push_5xx ...` server log line actionable.
 */
export async function execGit(
  file: string,
  argv: string[],
  opts: Parameters<typeof execFileAsync>[2],
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(file, argv, opts);
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  } catch (err) {
    const e = err as { message?: string; stderr?: unknown; stdout?: unknown };
    const stderr = e.stderr ? String(e.stderr).trim() : '';
    const stdout = e.stdout ? String(e.stdout).trim() : '';
    const detail = stderr || stdout;
    const base = `${file} ${argv[0] ?? ''} failed: ${e.message ?? 'unknown error'}`;
    throw new Error(detail ? `${base}\n${detail}` : base);
  }
}

/**
 * Ref candidates for a base branch, most-authoritative first.
 *
 * The remote-tracking ref has to win over the local branch of the same name. A
 * session worktree is a clone whose local `main` is pinned at clone time and
 * never fast-forwarded, while `origin/main` is refreshed by the fetch that
 * precedes every rebase. Once a session rebases, everything that landed on the
 * base in the meantime — other sessions' merged work — becomes an ancestor of
 * HEAD but is still unreachable from the stale local `main`, so a
 * `main..HEAD` range reports it as this branch's own.
 *
 * A base that is already remote- or fully-qualified is used verbatim, as is
 * anything the first two forms cannot resolve (a raw SHA, say).
 */
function baseRefCandidates(baseBranch: string): string[] {
  const base = baseBranch.trim();
  if (!base) return [];
  if (base.startsWith('refs/') || base.startsWith('origin/')) return [base];
  return [`refs/remotes/origin/${base}`, `refs/heads/${base}`, base];
}

/**
 * The ref this branch should be compared against, or `null` when the base
 * cannot be resolved at all. Both readers below go through this so a PR body
 * and its session summary can never disagree about what the base was.
 */
export async function resolveBaseRef(
  worktreePath: string,
  baseBranch: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  for (const ref of baseRefCandidates(baseBranch)) {
    try {
      const { stdout } = await execGit(
        'git',
        ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
        { cwd: worktreePath, env, timeout: READ_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      );
      if (stdout.trim()) return ref;
    } catch {
      // Ref does not exist here; try the next candidate.
    }
  }
  return null;
}

/**
 * Commits on the branch that are not on `baseBranch`, newest first. Returns
 * `[]` when the base cannot be resolved so callers degrade to card data rather
 * than failing.
 */
export async function collectPrCommits(
  worktreePath: string,
  baseBranch: string,
  env: NodeJS.ProcessEnv,
): Promise<CommitInfo[]> {
  const ref = await resolveBaseRef(worktreePath, baseBranch, env);
  if (!ref) return [];
  try {
    const { stdout } = await execGit('git', ['log', `${ref}..HEAD`, '-z', '--format=%s%n%b'], {
      cwd: worktreePath,
      env,
      timeout: READ_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    const commits: CommitInfo[] = [];
    for (const record of stdout.split('\0')) {
      const trimmed = record.replace(/\n+$/, '');
      if (!trimmed) continue;
      const newlineIdx = trimmed.indexOf('\n');
      const subject = (newlineIdx === -1 ? trimmed : trimmed.slice(0, newlineIdx)).trim();
      if (!subject) continue;
      const body = newlineIdx === -1 ? '' : trimmed.slice(newlineIdx + 1).trim();
      commits.push(body ? { subject, body } : { subject });
    }
    return commits;
  } catch {
    return [];
  }
}

/** `git diff --stat <base>...HEAD`, or `''` when the base ref does not resolve. */
export async function collectPrDiffStat(
  worktreePath: string,
  baseBranch: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const ref = await resolveBaseRef(worktreePath, baseBranch, env);
  if (!ref) return '';
  try {
    const { stdout } = await execGit('git', ['diff', '--stat', `${ref}...HEAD`], {
      cwd: worktreePath,
      env,
      timeout: READ_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}
