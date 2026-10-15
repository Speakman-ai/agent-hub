/**
 * "Update branch" button state for native PRs (web + mobile). Shown only when
 * the head is behind its base; disabled when merging the base in would
 * conflict, since the server would refuse it.
 */
export interface UpdateBranchButtonState {
  visible: boolean;
  enabled: boolean;
  label: string;
  reason: string;
}

export function updateBranchButtonState(
  pr: {
    state?: string | null;
    merged_at?: string | null;
    base?: string | null;
    behind_by?: number | null;
    mergeable?: boolean | null;
  } | null,
  opts: { isNative: boolean },
): UpdateBranchButtonState {
  const base = pr?.base || 'base';
  const label = `Update with ${base}`;
  const hidden = { visible: false, enabled: false, label, reason: '' };
  if (!pr || !opts.isNative || pr.merged_at) return hidden;
  if (String(pr.state || '').toLowerCase() !== 'open') return hidden;
  const behind = typeof pr.behind_by === 'number' ? pr.behind_by : 0;
  if (behind <= 0) return hidden;
  const commits = `${behind} commit${behind === 1 ? '' : 's'}`;
  if (pr.mergeable === false) {
    return {
      visible: true,
      enabled: false,
      label,
      reason: `This branch is ${commits} behind ${base} and has conflicts. Resolve them first.`,
    };
  }
  return {
    visible: true,
    enabled: true,
    label,
    reason: `This branch is ${commits} behind ${base}. Merge ${base} into it.`,
  };
}
