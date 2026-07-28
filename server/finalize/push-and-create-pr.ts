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
import type { AppConfig } from '../types.js';
import { MAX_BUFFER, collectPrCommits, collectPrDiffStat, execGit } from './branch-facts.js';
import type { CommitInfo } from './branch-facts.js';
import {
  autoGitChildEnv,
  resolveAutoGitGithubToken,
  resolveOrgOwnerGithubToken,
} from '../auto-git.js';
import type { NativePrService } from '../native-pr/service.js';
import { pushAndCreateNativePr } from './push-and-create-pr-agenthub.js';
import { assertWorktreeOriginMatchesProject } from './origin-guard.js';
import { generateLlmPrSummary } from './pr-summary-llm.js';
import type {
  PushAndCreatePrArgs,
  PushAndCreatePrFn,
  PushAndCreatePrResult,
} from './orchestrator.js';

// Re-exported so existing importers (origin-guard, the Hub-native push path,
// their tests) keep a single entry point for the git helpers.
export { execGit, collectPrCommits, collectPrDiffStat };
export type { CommitInfo };

/** Config slice the LLM PR-summary step needs (host-wide API keys). */
export type PrSummaryConfig = Pick<AppConfig, 'openaiApiKey'> & {
  anthropicApiKey?: string | null;
};

/**
 * Best-effort LLM synthesis of a PR title + summary from the full branch
 * context. Returns `null` when no API key is configured or the call fails —
 * callers pass the result straight to {@link buildPrDetails}, which falls back
 * to its deterministic sources on `null`. Never throws.
 */
export async function resolvePrSummaryOverride(
  args: PushAndCreatePrArgs,
  commits: CommitInfo[],
  diffStat: string,
  config: PrSummaryConfig,
): Promise<PrSummaryOverride | null> {
  if (!config.openaiApiKey && !config.anthropicApiKey) return null;
  return generateLlmPrSummary({
    cardTitle: args.card.title ?? null,
    cardDescription: args.card.description ?? null,
    commits,
    diffStat,
    openaiApiKey: config.openaiApiKey ?? null,
    anthropicApiKey: config.anthropicApiKey ?? null,
  });
}

/** Per-call timeout for `git push` / `gh pr create`. Generous — large pushes are slow. */
const PUSH_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Resolve the authoritative origin SHA for `branch` via `ls-remote`, used to
 * pin `--force-with-lease=<branch>:<sha>` on the push below.
 *
 * Why this is required (not a nicety): a *bare* `--force-with-lease` resolves
 * its expected value by applying origin's configured *fetch refspec* to the
 * pushed branch. Agent Hub session clones fetch only
 * `+refs/heads/main:refs/remotes/origin/main`, so any push to a branch other
 * than `main` — notably a Resolve-PR session's PR head branch — has no refspec
 * mapping. Git then can't find the lease's expected value and rejects the push
 * with `! [rejected] <branch> -> <branch> (stale info)`, *even though*
 * `refs/remotes/origin/<branch>` physically exists and matches the remote.
 * Pinning the lease to an explicit `ls-remote` SHA sidesteps the refspec lookup
 * while preserving force-with-lease's concurrent-update protection. Mirrors the
 * `pre-push-rebase.ts` + `auto-git.ts buildPushArgs` pattern used by the
 * auto-commit pipeline.
 *
 * Returns `null` for a brand-new branch (empty `ls-remote`) or any `ls-remote`
 * failure (network/auth) — callers then fall back to a bare
 * `--force-with-lease`, which is correct for ref creation and degrades to the
 * legacy behavior for the rare lookup failure.
 */
export async function resolveExpectedRemoteSha(
  worktreePath: string,
  branch: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<string | null> {
  try {
    const { stdout } = await execGit('git', ['ls-remote', 'origin', `refs/heads/${branch}`], {
      cwd: worktreePath,
      env,
      timeout: 30_000,
      maxBuffer: MAX_BUFFER,
    });
    // ls-remote output for an existing ref: `<sha>\trefs/heads/<branch>`. For a
    // missing branch stdout is empty (exit 0). Match a 40- or 64-hex SHA prefix
    // to cover SHA-1 and SHA-256 repos.
    const firstLine = stdout.split(/\r?\n/, 1)[0]?.trim() ?? '';
    const shaMatch = firstLine.match(/^([0-9a-f]{40,64})\s/i);
    return shaMatch ? shaMatch[1] : null;
  } catch {
    return null;
  }
}

/**
 * Build the `git push` argv with a `--force-with-lease` that is pinned to an
 * explicit expected SHA when known, falling back to a bare lease otherwise.
 * See {@link resolveExpectedRemoteSha} for why the pin matters.
 */
export function buildForceWithLeasePushArgs(
  branch: string,
  expectedRemoteSha: string | null,
): string[] {
  const lease = expectedRemoteSha
    ? `--force-with-lease=${branch}:${expectedRemoteSha}`
    : '--force-with-lease';
  return ['push', lease, '-u', 'origin', branch];
}

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

function normalizeTitle(rawTitle: string): string {
  const normalized = rawTitle.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Untitled change';
  const stripped = normalized.replace(/[.!?:;,\s]+$/, '');
  return stripped.length > 70
    ? `${stripped.slice(0, 67).replace(/[.!?:;,\s]+$/, '')}...`
    : stripped;
}

/**
 * LLM-synthesized title + summary that overrides the deterministic sources.
 * When present (and non-empty) the title drives the PR name and the summary
 * becomes the ## Summary lede, regardless of single/multi-commit. Either field
 * may be empty — an empty field falls through to the deterministic source.
 */
export interface PrSummaryOverride {
  title?: string;
  summary?: string;
}

export function buildPrDetails(
  args: PushAndCreatePrArgs,
  commits: CommitInfo[],
  diffStat: string,
  override?: PrSummaryOverride | null,
): { title: string; body: string } {
  const firstCommit = commits[0];
  const cardTitle = args.card.title?.trim() ?? '';
  const cardDescription = args.card.description?.trim() ?? '';
  // Trimmed, possibly-empty newest-commit subject. Trimming here (rather than
  // trusting collectPrCommits to drop empty subjects) keeps buildPrDetails
  // defensive when called with malformed/whitespace subjects.
  const firstSubject = firstCommit?.subject?.trim() ?? '';
  // LLM-synthesized title/summary win when available — they capture the whole
  // session rather than the last turn or a vague card title. Empty fields fall
  // through to the deterministic sources below.
  const llmTitle = override?.title?.trim() ?? '';
  const llmSummary = override?.summary?.trim() ?? '';
  // `git log <base>..HEAD` is newest-first, so commits[0] is the *last* commit
  // on the branch. A single commit describes the whole change, so its subject
  // is a good title. But with several commits the newest one describes only the
  // last turn (e.g. "Address review: ...") — naming the PR after it buries the
  // session's actual goal. In that case prefer the kanban card title (what the
  // session set out to do); the per-commit detail still lands in ## Commits.
  // `||` (not `??`) so an empty string always falls through to the next
  // source, ending at the raw card title — never an empty/"Untitled" PR name.
  const multiCommit = commits.length > 1;
  const deterministicTitleSource = multiCommit
    ? cardTitle || firstSubject
    : firstSubject || cardTitle;
  const title = normalizeTitle(llmTitle || deterministicTitleSource || args.card.title);
  const sections: string[] = ['## Summary'];

  // Tracks whether the Summary lede came from the card. When it did, repeating
  // the card description under ## Original task would be redundant.
  let summaryFromCard = false;
  if (llmSummary) {
    sections.push(llmSummary);
  } else if (multiCommit) {
    // Goal-first: summarize the PR as a whole with the card (what was asked),
    // not the newest commit. The individual commits are listed below.
    sections.push(cardDescription || cardTitle || `Completed ${args.card.title}.`);
    summaryFromCard = Boolean(cardDescription || cardTitle);
  } else if (firstCommit) {
    sections.push(
      firstCommit.body ? `${firstCommit.subject}\n\n${firstCommit.body}` : firstCommit.subject,
    );
  } else if (cardDescription) {
    sections.push(cardDescription);
    summaryFromCard = true;
  } else {
    sections.push(`Completed ${args.card.title}.`);
  }

  if (multiCommit) {
    sections.push('');
    sections.push('## Commits');
    for (const commit of commits.slice(0, 20)) {
      sections.push(`- ${commit.subject}`);
    }
    if (commits.length > 20) {
      sections.push(`- ...and ${commits.length - 20} more`);
    }
  }

  // Original-task context adds value whenever the Summary did NOT already come
  // from the card description (a commit drove it, or an LLM synthesized it).
  // When the card description already IS the Summary, repeating it here would
  // be redundant.
  if (!summaryFromCard && cardDescription) {
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
 *
 * Host selection happens per-project inside the returned function (NOT a
 * top-level backend interface): the seam already receives `args.project`,
 * and Agent Hub-hosted projects (`gitHost: 'agenthub'`) push to the Hub's
 * bare repo + create a native PR (push-and-create-pr-agenthub.ts) while
 * everything else keeps the GitHub `git push` + `gh pr create` path
 * byte-for-byte.
 */
export function createPushAndCreatePr(deps: {
  config: Pick<AppConfig, 'personalOAuth' | 'openaiApiKey'>;
  /** Required when any project opts into `gitHost: 'agenthub'`. */
  nativePr?: NativePrService;
}): PushAndCreatePrFn {
  return async function pushAndCreatePr(args: PushAndCreatePrArgs): Promise<PushAndCreatePrResult> {
    // Agent Hub-hosted projects push to the Hub's bare repo and create a
    // native PR — no GitHub token involved.
    if (args.project.gitHost === 'agenthub') {
      if (!deps.nativePr) {
        throw new Error(
          `project ${args.project.id} uses gitHost 'agenthub' but the native PR service is not wired`,
        );
      }
      return pushAndCreateNativePr(deps.nativePr, args, deps.config);
    }

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

    // Push-target lock: refuse to push unless the worktree origin is the
    // project's OWN repo. A session clone inherits its origin from the
    // project checkout, so a tampered / stale / mis-pointed origin would
    // otherwise ship commits + a PR to an arbitrary repo. This is the
    // GitHub-path symmetry to the agenthub path's hosted-repo guard
    // (push-and-create-pr-agenthub.ts). The expected repo is resolved from
    // project config, falling back to the project checkout's origin; a
    // project with no verifiable target is HARD-REFUSED (no fail-open).
    // Runs BEFORE the push so a bad origin never mutates a remote.
    const guard = await assertWorktreeOriginMatchesProject(args.project, args.worktreePath, env);
    console.log(`[finalize-push] ${guard.summary}`);

    // git push --force-with-lease=<branch>:<sha> -u origin <branch> — the lease
    // is pinned to an explicit ls-remote SHA so it does not depend on origin's
    // fetch refspec (which only covers `main`). See resolveExpectedRemoteSha.
    const expectedRemoteSha = await resolveExpectedRemoteSha(args.worktreePath, args.branch, env);
    await execGit('git', buildForceWithLeasePushArgs(args.branch, expectedRemoteSha), {
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
    const override = await resolvePrSummaryOverride(args, commits, diffStat, deps.config);
    const { title, body } = buildPrDetails(args, commits, diffStat, override);

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
export const __test = {
  buildPrDetails,
  parsePrListUrl,
  parsePrUrl,
  resolveExpectedRemoteSha,
  buildForceWithLeasePushArgs,
};
