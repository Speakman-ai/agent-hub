/**
 * push-and-create-pr-agenthub.ts — Finalize §8 push step for Agent
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
import type { NativePrService } from '../native-pr/service.js';
import {
  buildPrDetails,
  collectPrCommits,
  collectPrDiffStat,
  execGit,
} from './push-and-create-pr.js';
import type { PushAndCreatePrArgs, PushAndCreatePrResult } from './orchestrator.js';

const PUSH_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BUFFER = 10 * 1024 * 1024;

export async function pushAndCreateNativePr(
  nativePr: NativePrService,
  args: PushAndCreatePrArgs,
): Promise<PushAndCreatePrResult> {
  // Guard: the push must land on the Hub repo. A worktree whose origin
  // still points at GitHub (e.g. opt-in happened mid-session, before the
  // session clone was recreated) would otherwise silently ship to the
  // wrong host with no native PR to gate it.
  const { stdout: originOut } = await execGit('git', ['remote', 'get-url', 'origin'], {
    cwd: args.worktreePath,
    timeout: 10_000,
    maxBuffer: MAX_BUFFER,
  });
  const origin = originOut.trim();
  const expectedBare = bareRepoPath(args.project.id);
  const expectedHttpSuffix = `/git/${args.project.id}.git`;
  if (origin !== expectedBare && !origin.endsWith(expectedHttpSuffix)) {
    throw new Error(
      `agenthub push refused: worktree origin (${origin}) is not the hosted repo for project ${args.project.id}. ` +
        `Recreate the session worktree after enabling Agent Hub git hosting.`,
    );
  }

  await execGit('git', ['push', '--force-with-lease', '-u', 'origin', args.branch], {
    cwd: args.worktreePath,
    timeout: PUSH_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });

  const [commits, diffStat] = await Promise.all([
    collectPrCommits(args.worktreePath, args.baseBranch, process.env),
    collectPrDiffStat(args.worktreePath, args.baseBranch, process.env),
  ]);
  const { title, body } = buildPrDetails(args, commits, diffStat);

  const { prUrl } = nativePr.createOrGetOpenPr({
    project: args.project,
    headBranch: args.branch,
    baseBranch: args.baseBranch,
    headSha: args.headSha,
    title,
    body,
    author: 'finalize',
  });
  return { prUrl };
}
