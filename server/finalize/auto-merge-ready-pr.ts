/**
 * auto-merge-ready-pr.ts — dispatch the "Merge Automatically" auto-merge
 * step to the right host.
 *
 * Finalize's push step creates one of two PR kinds depending on the
 * project's git host (see push-and-create-pr.ts):
 *   - GitHub (default `gitHost`): a github.com PR — merge with `gh pr merge`
 *     (immediate, falling back to native auto-merge) via
 *     {@link mergeOrEnableGithubAutoMerge}.
 *   - Agent Hub-hosted (`gitHost: 'agenthub'`): a NATIVE Hub PR at
 *     `/projects/<id>/pulls/<n>` — `gh` cannot touch the Hub's bare repo, so
 *     the merge runs in-process through {@link NativePrService.merge}.
 *
 * The old auto-merge always ran `gh pr merge`. On a Hub-hosted project that
 * `gh` call fails ("none of the git remotes point to a known GitHub host"),
 * the error is swallowed, and the native PR sits open with all checks green
 * — the "Auto Merge didn't merge" complaint. We dispatch on the PR URL
 * shape (the authoritative record of what the push actually created) so
 * config drift can never route a native PR through the GitHub path.
 */
import type { Project } from '../types.js';
import { parseNativePrUrl } from '../native-pr/url.js';
import {
  mergeOrEnableGithubAutoMerge,
  type GhRunner,
  type MergeMethodFlag,
} from '../github-auto-merge.js';

/**
 * Minimal native-merge surface — the slice of `NativePrService` this module
 * needs. Declared structurally so tests can inject a fake without standing
 * up the whole service.
 */
export interface NativePrMerger {
  merge(args: {
    project: Project;
    number: number;
    mergeMethod: 'squash' | 'merge';
    actor: string;
  }): Promise<
    | { ok: true; mergedSha: string }
    | { ok: false; status: number; error: string; mergeable?: false }
  >;
}

export interface AutoMergeReadyPrResult {
  /** Which host actually performed (or attempted) the merge. */
  source: 'agenthub' | 'github';
  /** PR was merged immediately. */
  merged: boolean;
  /** GitHub-only: native auto-merge was enabled to finish once checks pass. */
  autoEnabled?: boolean;
  /** Human-readable note for logs. */
  note: string;
}

/** Actor recorded on native merges performed by fire-and-forget automation. */
export const AUTO_MERGE_ACTOR = 'finalize-automation';

/**
 * Merge a Finalize-pushed PR, picking the host from the PR URL.
 *
 * @throws when the native merge is refused (blocked / conflict / infra) or
 *   when neither an immediate GitHub merge nor enabling auto-merge succeeds.
 *   The fire-and-forget caller catches and logs — a failed auto-merge must
 *   never crash the automation, but it must surface in the logs.
 */
export async function autoMergeReadyPr(args: {
  prUrl: string;
  project: Project;
  nativePr: NativePrMerger | null | undefined;
  runGh: GhRunner;
  method?: MergeMethodFlag;
}): Promise<AutoMergeReadyPrResult> {
  const { prUrl, project, nativePr, runGh } = args;
  const method = args.method ?? '--squash';

  const native = parseNativePrUrl(prUrl);
  if (native) {
    if (!nativePr) {
      throw new Error(`native PR ${prUrl} cannot be auto-merged: NativePrService is not wired`);
    }
    // Native PRs support squash + merge commits only (no rebase). The
    // automation default is squash; map an explicit --merge through.
    const nativeMethod: 'squash' | 'merge' = method === '--merge' ? 'merge' : 'squash';
    const result = await nativePr.merge({
      project,
      number: native.number,
      mergeMethod: nativeMethod,
      actor: AUTO_MERGE_ACTOR,
    });
    if (!result.ok) {
      throw new Error(
        `native merge failed for ${prUrl} (status ${result.status}): ${result.error}`,
      );
    }
    return {
      source: 'agenthub',
      merged: true,
      note: `merged native PR ${prUrl} (${nativeMethod}) sha=${result.mergedSha.slice(0, 12)}`,
    };
  }

  const outcome = await mergeOrEnableGithubAutoMerge(prUrl, runGh, method);
  return {
    source: 'github',
    merged: outcome.merged,
    autoEnabled: outcome.autoEnabled,
    note: outcome.note,
  };
}
