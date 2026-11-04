/**
 * Keep open native PRs current when their base moves onto their files
 * (`Project.baseDrift.autoUpdatePrs`).
 *
 * The merge-time drift gate (merge-drift.ts) refuses a PR whose base changed
 * the same ground since its checks ran. Waiting for someone to click Merge
 * before noticing means the fix starts late. This runs "Update branch" on
 * every such PR as soon as the base moves, so its checks re-run against the
 * new base right away. A red result then reaches auto-resolve through the
 * normal PR CI hooks, and a green one lets an armed auto-merge finish.
 *
 * PRs the base moved past without touching their files are left alone: an
 * update would only buy a full CI run for nothing. A conflicting update is
 * skipped; the conflict probe in auto-resolve owns that case.
 */

import type { Project, PullRequestRow, Stmts } from '../types.js';
import { resolveBaseDriftPolicy } from '../finalize/base-drift-policy.js';
import { hostedRepoDefaultBranch } from '../git-host/repo-store.js';
import { listPullRequests } from './store.js';
import { inspectMergeBaseDrift } from './merge-drift.js';
import type { NativePrService } from './service.js';
import { revParse } from './git-read.js';
import { bareRepoPath } from './host.js';

/** Actor recorded on the merge commit an automatic update creates. */
export const AUTO_UPDATE_ACTOR = 'auto-update';
/** Open PRs inspected per base move. */
const SCAN_LIMIT = 200;

export interface AutoUpdateDeps {
  stmts: Stmts;
  nativePr: Pick<NativePrService, 'updateBranch'>;
  /** Test seam: bare repo path for a project. */
  repoPath?: (project: Project) => string;
  /** Test seam: the repo's default branch. */
  defaultBranch?: (project: Project) => Promise<string | null>;
}

export interface AutoUpdateResult {
  updated: number[];
  skipped: Array<{ number: number; reason: string }>;
}

export function autoUpdatePrsEnabled(project: Project): boolean {
  if (project.gitHost !== 'agenthub') return false;
  const policy = resolveBaseDriftPolicy(project.baseDrift);
  return policy.mode !== 'off' && policy.autoUpdatePrs;
}

/** Update every open PR on `baseBranch` that the base moved onto. Never throws. */
export async function autoUpdateDriftedPrs(
  project: Project,
  baseBranch: string,
  deps: AutoUpdateDeps,
): Promise<AutoUpdateResult> {
  const result: AutoUpdateResult = { updated: [], skipped: [] };
  if (!autoUpdatePrsEnabled(project)) return result;
  try {
    const defaultBranch =
      (await (deps.defaultBranch ?? ((p: Project) => hostedRepoDefaultBranch(p.id)))(project)) ??
      'main';
    // Same scope as the merge gate: only the protected default branch.
    if (baseBranch !== defaultBranch) return result;
    const repoPath = deps.repoPath ? deps.repoPath(project) : bareRepoPath(project.id);
    const open = listPullRequests(deps.stmts, project.id, 'open', SCAN_LIMIT).filter(
      (pr: PullRequestRow) => pr.base_branch === baseBranch,
    );
    for (const pr of open) {
      const headSha = (await revParse(repoPath, `refs/heads/${pr.head_branch}`)) ?? pr.head_sha;
      const drift = await inspectMergeBaseDrift({
        repoPath,
        baseBranch,
        headSha,
        baseDrift: project.baseDrift,
        onWarn: (message) => console.warn(`[auto-update] ${project.id}#${pr.number}: ${message}`),
      });
      if (drift.kind !== 'stale') continue;
      const res = await deps.nativePr.updateBranch({
        project,
        number: pr.number,
        actor: AUTO_UPDATE_ACTOR,
      });
      if (res.ok) {
        result.updated.push(pr.number);
        console.log(
          `[auto-update] ${project.id}#${pr.number}: ${baseBranch} moved onto ` +
            `${drift.overlap.slice(0, 3).join(', ')}; updated the branch to ${res.headSha.slice(0, 8)}`,
        );
      } else {
        result.skipped.push({ number: pr.number, reason: res.error });
        console.log(`[auto-update] ${project.id}#${pr.number}: not updated (${res.error})`);
      }
    }
  } catch (err: unknown) {
    console.warn(
      `[auto-update] ${project.id} ${baseBranch}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return result;
}
