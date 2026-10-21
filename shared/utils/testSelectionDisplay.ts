/**
 * Display helpers for the dynamic test-selection manifest a Finalize run
 * stores on `finalize_runs.test_selection` (shape: `TestSelection` in
 * `server/finalize/test-selection.ts`). Shared by the web session strip, the
 * CI runs page and the mobile Finalize bar / Runners screen so every surface
 * reads the same labels.
 */

export type SelectionSourceWire = 'session' | 'reviewer' | 'always' | 'needs' | 'unmapped' | 'diff';

export interface SelectionInstanceWire {
  jobId: string;
  matrixKey: string;
  selected: boolean;
  sources: string[];
  files: string[];
  reasons: string[];
}

export interface TestSelectionWire {
  mode: 'dynamic';
  forcedFullReason: string | null;
  inventorySha: string | null;
  instances: SelectionInstanceWire[];
}

export interface TestSelectionSummary {
  selectedJobs: number;
  totalJobs: number;
  selectedInstances: number;
  totalInstances: number;
  forcedFullReason: string | null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function parseInstance(raw: unknown): SelectionInstanceWire | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.jobId !== 'string' || !r.jobId) return null;
  return {
    jobId: r.jobId,
    matrixKey: typeof r.matrixKey === 'string' ? r.matrixKey : '',
    selected: r.selected !== false,
    sources: strings(r.sources),
    files: strings(r.files),
    reasons: strings(r.reasons),
  };
}

/**
 * Parse a manifest from a JSON string or object. Returns null for anything
 * that isn't a dynamic manifest, so a bad row renders as a plain run.
 */
export function parseTestSelectionWire(raw: unknown): TestSelectionWire | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.mode !== 'dynamic' || !Array.isArray(v.instances)) return null;
  const instances = v.instances
    .map(parseInstance)
    .filter((i): i is SelectionInstanceWire => i !== null);
  return {
    mode: 'dynamic',
    forcedFullReason:
      typeof v.forcedFullReason === 'string' && v.forcedFullReason ? v.forcedFullReason : null,
    inventorySha: typeof v.inventorySha === 'string' ? v.inventorySha : null,
    instances,
  };
}

/**
 * Read the manifest off a run: the raw row (`test_selection` as JSON text),
 * the ci-runs payload (`test_selection` parsed) or the latest-run payload
 * (`testSelection`).
 */
export function readTestSelection(run: unknown): TestSelectionWire | null {
  if (!run || typeof run !== 'object') return null;
  const r = run as { test_selection?: unknown; testSelection?: unknown };
  return parseTestSelectionWire(r.testSelection ?? r.test_selection);
}

/** A job counts as selected when any of its instances runs. */
export function summarizeTestSelection(selection: TestSelectionWire): TestSelectionSummary {
  const jobs = new Map<string, boolean>();
  let selectedInstances = 0;
  for (const i of selection.instances) {
    if (i.selected) selectedInstances += 1;
    jobs.set(i.jobId, (jobs.get(i.jobId) ?? false) || i.selected);
  }
  return {
    selectedJobs: [...jobs.values()].filter(Boolean).length,
    totalJobs: jobs.size,
    selectedInstances,
    totalInstances: selection.instances.length,
    forcedFullReason: selection.forcedFullReason,
  };
}

/** True when the run actually skipped at least one instance. */
export function isSelectedRun(selection: TestSelectionWire | null): selection is TestSelectionWire {
  return !!selection && !selection.forcedFullReason && selection.instances.some((i) => !i.selected);
}

/**
 * `Tested (selected: N of M jobs)` for a passed run that skipped instances;
 * null for full runs, forced-full runs and runs without a manifest.
 */
export function selectedRunLabel(run: unknown): string | null {
  const selection = readTestSelection(run);
  if (!isSelectedRun(selection)) return null;
  const { selectedJobs, totalJobs } = summarizeTestSelection(selection);
  return `Tested (selected: ${selectedJobs} of ${totalJobs} jobs)`;
}

/** Short chip text for a run row: `selected 4 of 17 jobs` or `full run`. */
export function selectionChipLabel(selection: TestSelectionWire | null): string | null {
  if (!selection) return null;
  if (selection.forcedFullReason) return 'full run';
  const { selectedJobs, totalJobs } = summarizeTestSelection(selection);
  if (selectedJobs === totalJobs && selection.instances.every((i) => i.selected)) {
    return 'all jobs selected';
  }
  return `selected ${selectedJobs} of ${totalJobs} jobs`;
}

/** `Full run: <reason>` when selection fell back to every instance. */
export function forcedFullLabel(selection: TestSelectionWire | null): string | null {
  return selection?.forcedFullReason ? `Full run: ${selection.forcedFullReason}` : null;
}

const SOURCE_LABELS: Record<SelectionSourceWire, string> = {
  session: 'the session ran its tests',
  reviewer: 'the reviewer asked for it',
  always: 'always runs',
  needs: 'needed by a selected job',
  unmapped: 'owns a new or moved test file',
  diff: 'the change edits its tests',
};

export function selectionSourceLabel(source: string): string {
  return SOURCE_LABELS[source as SelectionSourceWire] ?? source;
}

export const NOT_SELECTED_REASON =
  'No test in this instance was run by the session, requested by the reviewer, or edited by the change';

/** Why an instance ran or was skipped, as one line. */
export function selectionInstanceReason(instance: SelectionInstanceWire): string {
  if (!instance.selected) return NOT_SELECTED_REASON;
  if (instance.reasons.length > 0) return instance.reasons.join('; ');
  if (instance.sources.length > 0) return instance.sources.map(selectionSourceLabel).join('; ');
  return 'selected';
}

/** Find the manifest entry for a job instance. Empty and `default` keys match. */
export function findSelectionInstance(
  selection: TestSelectionWire | null,
  jobId: string | null | undefined,
  matrixKey: string | null | undefined,
): SelectionInstanceWire | null {
  if (!selection || !jobId) return null;
  const norm = (k: string | null | undefined) => (!k || k === 'default' ? '' : k);
  const key = norm(matrixKey);
  return selection.instances.find((i) => i.jobId === jobId && norm(i.matrixKey) === key) ?? null;
}

/**
 * Why a `not_selected` step or job was skipped: the manifest's reason for its
 * instance when the run's selection is at hand, else the generic one. Null
 * for any other state. Accepts camelCase (live hook) and snake_case (REST)
 * rows.
 */
export function notSelectedStepReason(
  step: unknown,
  selection: TestSelectionWire | null = null,
): string | null {
  if (!step || typeof step !== 'object') return null;
  const s = step as Record<string, unknown>;
  if (s.state !== 'not_selected') return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const instance = findSelectionInstance(
    selection,
    str(s.jobId) ?? str(s.job_id),
    str(s.matrixKey) ?? str(s.matrix_key),
  );
  return instance ? selectionInstanceReason(instance) : NOT_SELECTED_REASON;
}

/** `job` or `job · shard`. */
export function selectionInstanceName(instance: SelectionInstanceWire): string {
  return instance.matrixKey && instance.matrixKey !== 'default'
    ? `${instance.jobId} · ${instance.matrixKey}`
    : instance.jobId;
}

/** Manifest entries sorted selected first, then by name. */
export function sortedSelectionInstances(selection: TestSelectionWire): SelectionInstanceWire[] {
  return [...selection.instances].sort((a, b) => {
    if (a.selected !== b.selected) return a.selected ? -1 : 1;
    return selectionInstanceName(a).localeCompare(selectionInstanceName(b));
  });
}

// --- Default-branch health -------------------------------------------------

export interface DefaultBranchFailureWire {
  job_id: string;
  matrix_key: string;
  first_failing_sha: string;
  last_failing_sha: string;
}

export interface DefaultBranchHealthWire {
  state: 'green' | 'red' | 'unknown';
  branch: string | null;
  breakage: { id: string; card_id: string | null; first_failing_sha: string } | null;
  failures: DefaultBranchFailureWire[];
}

/** `main is red: 2 failing instances`, or null when the branch is not red. */
export function defaultBranchRedLabel(health: DefaultBranchHealthWire | null): string | null {
  if (!health || health.state !== 'red') return null;
  const n = health.failures.length;
  const branch = health.branch || 'Default branch';
  if (n === 0) return `${branch} is red`;
  return `${branch} is red: ${n} failing instance${n === 1 ? '' : 's'}`;
}

export function defaultBranchFailureName(f: DefaultBranchFailureWire): string {
  return f.matrix_key && f.matrix_key !== 'default' ? `${f.job_id} · ${f.matrix_key}` : f.job_id;
}

/** Fallback poll for the red-branch banner when no run list drives refreshes. */
export const DEFAULT_BRANCH_HEALTH_POLL_MS = 60_000;

/**
 * Changes whenever a push-CI run (the only kind that records default-branch
 * health) appears or changes status, so the banner can refetch on CI
 * completion instead of only on mount.
 */
export function defaultBranchHealthRefreshKey(runs: unknown): string {
  if (!Array.isArray(runs)) return '';
  return runs
    .filter((r) => r && typeof r === 'object' && (r as any).trigger_source === 'git_push')
    .map((r: any) => `${r.id}:${r.status}`)
    .join(',');
}

/** Board deep link to a card. */
export function boardCardPath(projectId: string, cardId: string | null | undefined): string | null {
  if (!projectId || !cardId) return null;
  return `/projects/${encodeURIComponent(projectId)}/board?card=${encodeURIComponent(cardId)}`;
}
