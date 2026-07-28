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
 * Commits on the branch that are not on `baseBranch`, newest first. Tries the
 * local ref then `origin/<base>`; returns `[]` when neither resolves so callers
 * degrade to card data rather than failing.
 */
export async function collectPrCommits(
  worktreePath: string,
  baseBranch: string,
  env: NodeJS.ProcessEnv,
): Promise<CommitInfo[]> {
  const refs = [baseBranch, `origin/${baseBranch}`];
  for (const ref of refs) {
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
      // Try the next ref. If neither resolves, callers fall back to card data.
    }
  }
  return [];
}

/** `git diff --stat <base>...HEAD`, or `''` when neither base ref resolves. */
export async function collectPrDiffStat(
  worktreePath: string,
  baseBranch: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const refs = [baseBranch, `origin/${baseBranch}`];
  for (const ref of refs) {
    try {
      const { stdout } = await execGit('git', ['diff', '--stat', `${ref}...HEAD`], {
        cwd: worktreePath,
        env,
        timeout: READ_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
      return stdout.trim();
    } catch {
      // Try the next ref. Missing diff stat should not block the caller.
    }
  }
  return '';
}
