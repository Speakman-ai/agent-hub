/** GitHub check-run conclusions that mean CI failed and the author should fix something. */
export const CI_FAIL_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required']);

/**
 * Conclusions we surface in lists but do not dispatch autofix for. Superseded
 * workflow jobs (cancel-in-progress) land here; the newer run on the same ref
 * is authoritative via {@link latestCheckRunPerName}.
 */
export const CI_NON_ACTIONABLE_CONCLUSIONS = new Set(['cancelled', 'skipped', 'neutral']);

export interface CheckRunCiRow {
  id: number;
  name: string;
  conclusion: string | null;
}

/** Keep only the newest check run per job name for a commit. */
export function latestCheckRunPerName(runs: CheckRunCiRow[]): CheckRunCiRow[] {
  const byName = new Map<string, CheckRunCiRow>();
  for (const run of runs) {
    const name = run.name || '(unnamed)';
    const prev = byName.get(name);
    if (!prev || run.id > prev.id) {
      byName.set(name, run);
    }
  }
  return [...byName.values()];
}

/** True when any latest-per-name check still has an actionable failure on HEAD. */
export function hasActionableCiFailure(runs: CheckRunCiRow[]): boolean {
  return latestCheckRunPerName(runs).some((run) => {
    const conc = run.conclusion?.toLowerCase() ?? null;
    return conc !== null && CI_FAIL_CONCLUSIONS.has(conc);
  });
}
