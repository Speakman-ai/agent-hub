/**
 * epic-branch-link.ts — pure branch-matching between epics and pull requests.
 *
 * An epic's "feature branch" is its `pr_base_branch`: the integration branch
 * that ticket PRs merge into before the epic ships. This module maps that
 * branch to the PRs around it, both directions, with no I/O so it unit-tests
 * cleanly and is reused by the native-PR service (enrich PRs with `linked_epic`)
 * and the epic route (list an epic's PRs).
 *
 * Two relations, from the PR's point of view:
 *   - `targets`      — the PR merges INTO the feature branch (pr.base === branch).
 *                      A ticket PR contributing to the epic.
 *   - `integration`  — the PR ships the feature branch onward (pr.head === branch).
 *                      The epic's own PR: feature branch → its base (usually main).
 *
 * `targets` wins when both could match, which only happens if an epic's feature
 * branch is used as both a PR base and a PR head — degenerate, but base (the
 * "cards under the epic" reading) is the more useful surface.
 */

export type EpicPrRelation = 'targets' | 'integration';

/** Minimal epic shape needed to match — a subset of `KanbanEpicRow`. */
export interface EpicBranchRef {
  id: string;
  name: string;
  color?: string | null;
  pr_base_branch?: string | null;
}

/** Epic association attached to a PR (client renders a chip from this). */
export interface LinkedEpic {
  id: string;
  name: string;
  color: string | null;
  feature_branch: string;
  relation: EpicPrRelation;
}

/** Minimal PR branch shape — matches the summarized native PR (`head`/`base`). */
export interface PrBranchRef {
  head?: string | null;
  base?: string | null;
}

function normalizeBranch(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Find the epic whose feature branch matches a PR's head/base refs, if any.
 * Prefers a base match (`targets`) over a head match (`integration`).
 */
export function matchEpicForPrBranches(
  epics: readonly EpicBranchRef[],
  refs: PrBranchRef,
): LinkedEpic | null {
  const head = normalizeBranch(refs.head);
  const base = normalizeBranch(refs.base);
  if (!head && !base) return null;

  let integrationMatch: LinkedEpic | null = null;
  for (const epic of epics) {
    const branch = normalizeBranch(epic.pr_base_branch);
    if (!branch) continue;
    if (base && branch === base) {
      return {
        id: epic.id,
        name: epic.name,
        color: epic.color ?? null,
        feature_branch: branch,
        relation: 'targets',
      };
    }
    if (!integrationMatch && head && branch === head) {
      integrationMatch = {
        id: epic.id,
        name: epic.name,
        color: epic.color ?? null,
        feature_branch: branch,
        relation: 'integration',
      };
    }
  }
  return integrationMatch;
}

/**
 * Given a set of PRs and one epic's feature branch, return the PRs related to
 * that branch, each tagged with its relation. Returns [] for a blank branch.
 * Order is preserved from the input.
 */
export function prsForEpicFeatureBranch<T extends PrBranchRef>(
  pulls: readonly T[],
  featureBranch: string | null | undefined,
): Array<T & { epic_relation: EpicPrRelation }> {
  const branch = normalizeBranch(featureBranch);
  if (!branch) return [];
  const out: Array<T & { epic_relation: EpicPrRelation }> = [];
  for (const pr of pulls) {
    const base = normalizeBranch(pr.base);
    const head = normalizeBranch(pr.head);
    if (base === branch) {
      out.push({ ...pr, epic_relation: 'targets' });
    } else if (head === branch) {
      out.push({ ...pr, epic_relation: 'integration' });
    }
  }
  return out;
}
