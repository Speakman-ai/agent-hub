/**
 * push-and-create-pr.ts — Finalize Code Changes, §8 push step.
 *
 * Wires the orchestrator's injected {@link PushAndCreatePrFn} seam to a real
 * `git push --force-with-lease -u origin <branch>` + `gh pr create` pair.
 *
 * v0 contract (intentionally minimal):
 *   - Auth prefers the session owner's personal token
 *     ({@link resolveAutoGitGithubToken}), falling back to the org-owner token
 *     ({@link resolveOrgOwnerGithubToken}) when the session owner has no usable
 *     GitHub identity — shaped with {@link autoGitChildEnv} (token scrub +
 *     helper isolation, see auto-git.ts).
 *   - Title and body are derived from the implementation commit(s), with the
 *     owning kanban card preserved as original-task context.
 *   - Existing PR branches are updated in place. After the push succeeds,
 *     the helper asks `gh pr list --head <branch>` for an open PR and returns
 *     that URL instead of trying to create a duplicate PR.
 *   - Throws on error — the orchestrator catches and maps to
 *     `infra_error / github_push_5xx` (see `terminate()` in `orchestrator.ts`).
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AppConfig } from '../types.js';
import {
  autoGitChildEnv,
  resolveAutoGitGithubToken,
  resolveOrgOwnerGithubToken,
} from '../auto-git.js';
import type {
  PushAndCreatePrArgs,
  PushAndCreatePrFn,
  PushAndCreatePrResult,
} from './orchestrator.js';

const execFileAsync = promisify(execFile);

/**
 * Run a command, rethrowing with stderr/stdout folded into the message.
 *
 * `execFileAsync`'s rejection `.message` is typically just `Command failed:
 * <cmd>` — the actual git / gh diagnostic lands on `err.stderr`, which the
 * Finalize push path otherwise discards. Folding it in here is what makes the
 * `[finalize-push] github_push_5xx ...` server log line actionable.
 */
async function execGit(
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

/** Per-call timeout for `git push` / `gh pr create`. Generous — large pushes are slow. */
const PUSH_TIMEOUT_MS = 5 * 60 * 1000;

/** Cap stdout/stderr at 10 MiB to match auto-git.ts's STREAM_OUTPUT_MAX_BYTES. */
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Extract the PR URL from `gh pr create` stdout. `gh` emits the URL on its
 * own line (typically last); we take the first https:// line as the
 * authoritative URL.
 */
function parsePrUrl(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('https://github.com/') && trimmed.includes('/pull/')) {
      return trimmed;
    }
  }
  return null;
}

function parsePrListUrl(stdout: string): string | null {
  try {
    const rows: unknown = JSON.parse(stdout);
    if (!Array.isArray(rows)) return null;
    const first = rows[0] as { url?: unknown } | undefined;
    return typeof first?.url === 'string' && first.url.length > 0 ? first.url : null;
  } catch {
    return null;
  }
}

interface CommitInfo {
  subject: string;
  body?: string;
}

function normalizeTitle(rawTitle: string): string {
  const normalized = rawTitle.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Untitled change';
  const stripped = normalized.replace(/[.!?:;,\s]+$/, '');
  return stripped.length > 70
    ? `${stripped.slice(0, 67).replace(/[.!?:;,\s]+$/, '')}...`
    : stripped;
}

async function collectPrCommits(
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
        timeout: 10_000,
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

async function collectPrDiffStat(
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
        timeout: 10_000,
        maxBuffer: MAX_BUFFER,
      });
      return stdout.trim();
    } catch {
      // Try the next ref. Missing diff stat should not block PR creation.
    }
  }
  return '';
}

function buildPrDetails(args: PushAndCreatePrArgs, commits: CommitInfo[], diffStat: string) {
  const firstCommit = commits[0];
  const title = normalizeTitle(firstCommit?.subject ?? args.card.title);
  const cardDescription = args.card.description?.trim() ?? '';
  const sections: string[] = ['## Summary'];

  if (firstCommit) {
    sections.push(
      firstCommit.body ? `${firstCommit.subject}\n\n${firstCommit.body}` : firstCommit.subject,
    );
  } else if (cardDescription) {
    sections.push(cardDescription);
  } else {
    sections.push(`Completed ${args.card.title}.`);
  }

  if (commits.length > 1) {
    sections.push('');
    sections.push('## Commits');
    for (const commit of commits.slice(0, 20)) {
      sections.push(`- ${commit.subject}`);
    }
    if (commits.length > 20) {
      sections.push(`- ...and ${commits.length - 20} more`);
    }
  }

  if (firstCommit && cardDescription) {
    sections.push('');
    sections.push('## Original task');
    sections.push(cardDescription);
  }

  const stat = diffStat.trim();
  if (stat) {
    sections.push('');
    sections.push('## Files changed');
    sections.push('```');
    const lines = stat.split('\n');
    sections.push(
      lines.length > 20
        ? [...lines.slice(0, 19), `...and ${lines.length - 19} more`].join('\n')
        : stat,
    );
    sections.push('```');
  }

  sections.push('');
  sections.push('---');
  sections.push(
    [
      'Automated PR from Agent Hub Finalize Code Changes',
      `Kanban card: ${args.card.id}`,
      `Branch: ${args.branch}`,
      `Base: ${args.baseBranch}`,
      `Head: ${args.headSha.slice(0, 12)}`,
    ].join('\n'),
  );

  return { title, body: sections.join('\n') };
}

/**
 * Build a real {@link PushAndCreatePrFn} bound to the supplied `AppConfig`.
 * The orchestrator calls the returned function once per finalize run.
 */
export function createPushAndCreatePr(deps: {
  config: Pick<AppConfig, 'personalOAuth' | 'githubApp'>;
}): PushAndCreatePrFn {
  return async function pushAndCreatePr(args: PushAndCreatePrArgs): Promise<PushAndCreatePrResult> {
    // Prefer the session owner's personal GitHub token so the push and the
    // `gh pr create` are attributed to the user who triggered Finalize — not
    // an arbitrary org Owner. Falls back to the org-owner token only when the
    // session owner has no usable token (no connected GitHub identity, or no
    // session scope at all). Mirrors the resolution in finalize-git-env.ts so
    // every Finalize git phase authenticates as the same identity.
    const sessionToken = args.sessionId
      ? await resolveAutoGitGithubToken(args.sessionId, deps.config)
      : null;
    const token =
      sessionToken ??
      (await resolveOrgOwnerGithubToken(deps.config, args.project.githubRepo ?? null));
    const env = autoGitChildEnv(token);

    // git push --force-with-lease -u origin <branch>
    await execGit('git', ['push', '--force-with-lease', '-u', 'origin', args.branch], {
      cwd: args.worktreePath,
      env,
      timeout: PUSH_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });

    const { stdout: existingPrStdout } = await execGit(
      'gh',
      ['pr', 'list', '--head', args.branch, '--json', 'url', '--limit', '1'],
      { cwd: args.worktreePath, env, timeout: PUSH_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
    );
    const existingPrUrl = parsePrListUrl(existingPrStdout);
    if (existingPrUrl) {
      return { prUrl: existingPrUrl };
    }

    const [commits, diffStat] = await Promise.all([
      collectPrCommits(args.worktreePath, args.baseBranch, env),
      collectPrDiffStat(args.worktreePath, args.baseBranch, env),
    ]);
    const { title, body } = buildPrDetails(args, commits, diffStat);

    // gh pr create --base <baseBranch> --head <branch> --title <title> --body <body>
    const { stdout } = await execGit(
      'gh',
      [
        'pr',
        'create',
        '--base',
        args.baseBranch,
        '--head',
        args.branch,
        '--title',
        title,
        '--body',
        body,
      ],
      { cwd: args.worktreePath, env, timeout: PUSH_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
    );

    const prUrl = parsePrUrl(stdout);
    if (!prUrl) {
      throw new Error(`gh pr create returned no parseable PR URL; stdout: ${stdout.slice(0, 500)}`);
    }
    return { prUrl };
  };
}

// Exported for tests.
export const __test = { buildPrDetails, parsePrListUrl, parsePrUrl };
