/**
 * Finalize §8 push step for Agent
 * Hub-hosted projects (`gitHost: 'agenthub'`).
 *
 * Differences from the GitHub path (push-and-create-pr.ts):
 *   - No GitHub token resolution and no env scrubbing — the worktree's
 *     `origin` is the Hub's bare repo (a local path, or the Hub's
 *     /git/<id>.git URL for off-host worktrees), so a plain env pushes.
 *   - PR creation is an in-process call into {@link NativePrService}
 *     instead of `gh pr create`; idempotent reuse of the open PR for the
 *     branch matches the GitHub path's `gh pr list --head` check.
 *   - The returned `prUrl` is the native client route
 *     (`/projects/<id>/pulls/<n>`), which flows opaquely through
 *     `finalize_runs.pr_url`, card linking, and post-push-detach.
 *
 * Throws on infra errors (origin mismatch, push failure) — the
 * orchestrator catches and maps to `infra_error` exactly like the GitHub
 * path.
 */

import { bareRepoPath } from '../native-pr/host.js';
import { isHostedRepoUrl } from '../git-host/hosted-remote.js';
import { readOriginPushUrls } from './branch-facts.js';
import type { NativePrService } from '../native-pr/service.js';
import {
  buildForceWithLeasePushArgs,
  buildPrDetails,
  collectPrCommits,
  collectPrDiffStat,
  execGit,
  resolveExpectedRemoteSha,
  resolvePrSummaryOverride,
  type PrSummaryConfig,
} from './push-and-create-pr.js';
import { resolveNativePrAuthorUserId } from '../native-pr/author-user.js';
import type { PushAndCreatePrArgs, PushAndCreatePrResult } from './orchestrator.js';

const PUSH_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Throw unless every URL `git push origin` would write to is this project's
 * hosted repo: the exact bare path, or `/git/<projectId>.git` on a base this
 * Hub serves.
 */
export async function assertHostedOriginMatchesProject(
  projectId: string,
  worktreePath: string,
  opts: { baseUrls?: string[] } = {},
): Promise<void> {
  const urls = await readOriginPushUrls(worktreePath, undefined);
  if (urls.length === 0) {
    throw new Error(
      `agenthub push refused: worktree has no origin push URL for project ${projectId}.`,
    );
  }
  const barePath = bareRepoPath(projectId);
  const bad = urls.find((url) => !isHostedRepoUrl(url, projectId, { barePath, ...opts }));
  if (bad !== undefined) {
    throw new Error(
      `agenthub push refused: worktree origin push URL (${redactUrl(bad)}) is not the hosted repo for project ${projectId}. ` +
        `Recreate the session worktree after enabling Agent Hub git hosting.`,
    );
  }
}

/** Drop userinfo so an embedded credential never reaches a log line. */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    return u.toString();
  } catch {
    return raw;
  }
}

export async function pushAndCreateNativePr(
  nativePr: NativePrService,
  args: PushAndCreatePrArgs,
  config?: PrSummaryConfig,
): Promise<PushAndCreatePrResult> {
  // Guard: the push must land on the Hub repo. A worktree whose origin
  // still points at GitHub (e.g. opt-in happened mid-session, before the
  // session clone was recreated) would otherwise silently ship to the
  // wrong host with no native PR to gate it.
  await assertHostedOriginMatchesProject(args.project.id, args.worktreePath);

  // Resolve the native-PR author BEFORE any remote mutation. PR creation is
  // intentionally blocked without an attributed Hub user, so an auth-enabled
  // deployment with no session owner must fail here — before the push —
  // rather than after, which would strand a pushed branch with no PR.
  const authorUserId = resolveNativePrAuthorUserId({
    explicitUserId: args.authorUserId,
    sessionId: args.sessionId,
  });

  // Pin the lease to an explicit ls-remote SHA so it does not depend on
  // origin's fetch refspec (session clones fetch only `main`). When the branch
  // is brand-new, use an empty expect (`branch:`) — a bare `--force-with-lease`
  // races a phantom remote-tracking ref and rejects with `(stale info)`. See
  // resolveExpectedRemoteSha / buildForceWithLeasePushArgs.
  const expectedRemoteSha = await resolveExpectedRemoteSha(
    args.worktreePath,
    args.branch,
    process.env,
  );
  await execGit('git', buildForceWithLeasePushArgs(args.branch, expectedRemoteSha), {
    cwd: args.worktreePath,
    timeout: PUSH_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });

  const [commits, diffStat] = await Promise.all([
    collectPrCommits(args.worktreePath, args.baseBranch, process.env),
    collectPrDiffStat(args.worktreePath, args.baseBranch, process.env),
  ]);
  const override = config ? await resolvePrSummaryOverride(args, commits, diffStat, config) : null;
  const { title, body } = buildPrDetails(args, commits, diffStat, override);

  const { prUrl } = nativePr.createOrGetOpenPr({
    project: args.project,
    headBranch: args.branch,
    baseBranch: args.baseBranch,
    headSha: args.headSha,
    title,
    body,
    author: authorUserId,
  });
  return { prUrl };
}
