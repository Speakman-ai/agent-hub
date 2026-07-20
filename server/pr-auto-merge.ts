/**
 * pr-auto-merge.ts — arm/disarm GitHub's native auto-merge on a PR using the
 * acting user's OAuth token (GraphQL), for the toggle on the PR pages.
 *
 * This is the user-facing counterpart to `github-auto-merge.ts` (which drives
 * the Finalize "Auto Merge" automation level via the `gh` CLI and an
 * org/owner token). Here a human explicitly arms auto-merge on any GitHub PR
 * they can see — including PRs opened outside the session/Finalize flow —
 * and GitHub completes the merge once required checks pass and required
 * reviews approve. That is precisely what GitHub's native auto-merge does, so
 * we enable/disable it via the `enablePullRequestAutoMerge` /
 * `disablePullRequestAutoMerge` GraphQL mutations rather than merging directly.
 *
 * REST has no endpoint to arm auto-merge — it is GraphQL-only — so we resolve
 * the PR's node id over REST first, then run the mutation.
 */

export type PullRequestMergeMethod = 'squash' | 'merge' | 'rebase';

/** GraphQL `PullRequestMergeMethod` enum values. */
const MERGE_METHOD_ENUM: Record<PullRequestMergeMethod, string> = {
  squash: 'SQUASH',
  merge: 'MERGE',
  rebase: 'REBASE',
};

export function mergeMethodToGraphqlEnum(method: PullRequestMergeMethod): string {
  return MERGE_METHOD_ENUM[method];
}

export const ENABLE_AUTO_MERGE_MUTATION = `mutation EnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
    pullRequest {
      id
      autoMergeRequest {
        enabledAt
        mergeMethod
      }
    }
  }
}`;

export const DISABLE_AUTO_MERGE_MUTATION = `mutation DisableAutoMerge($pullRequestId: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
    pullRequest {
      id
      autoMergeRequest {
        enabledAt
      }
    }
  }
}`;

/** Injected side-effect callables so the core logic stays unit-testable. */
export interface AutoMergeToggleDeps {
  /**
   * REST getter that returns the raw PR object (needs `node_id`). The route
   * wires this to `githubUserApiRequest`.
   */
  getPr: (owner: string, repo: string, number: number) => Promise<Record<string, unknown>>;
  /** GraphQL poster bound to the acting user's token. Throws on GraphQL errors. */
  graphql: (query: string, variables: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export interface SetAutoMergeResult {
  enabled: boolean;
  mergeMethod: PullRequestMergeMethod;
  nodeId: string;
}

/**
 * Arm (or disarm) GitHub native auto-merge on a PR.
 *
 * @throws when the node id can't be resolved or the GraphQL mutation fails
 *   (e.g. the repo has "Allow auto-merge" disabled, or the PR is already in a
 *   clean/mergeable-now state with nothing to wait on).
 */
export async function setGithubPrAutoMerge(opts: {
  owner: string;
  repo: string;
  number: number;
  enabled: boolean;
  mergeMethod: PullRequestMergeMethod;
  deps: AutoMergeToggleDeps;
}): Promise<SetAutoMergeResult> {
  const { owner, repo, number, enabled, mergeMethod, deps } = opts;

  const prData = await deps.getPr(owner, repo, number);
  const nodeId = typeof prData.node_id === 'string' ? prData.node_id : '';
  if (!nodeId) {
    throw new Error('Could not resolve PR node id from GitHub');
  }

  if (enabled) {
    await deps.graphql(ENABLE_AUTO_MERGE_MUTATION, {
      pullRequestId: nodeId,
      mergeMethod: mergeMethodToGraphqlEnum(mergeMethod),
    });
  } else {
    await deps.graphql(DISABLE_AUTO_MERGE_MUTATION, { pullRequestId: nodeId });
  }

  return { enabled, mergeMethod, nodeId };
}
