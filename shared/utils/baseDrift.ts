/**
 * Form helpers for the `baseDrift` project setting editors (web
 * CiRunsSection, mobile Runners screen). The server validates the PATCH in
 * `server/finalize/base-drift-policy.ts`.
 */

export type BaseDriftMode = 'full' | 'fast' | 'off';

export const BASE_DRIFT_OPTIONS: ReadonlyArray<{ value: BaseDriftMode; label: string }> = [
  { value: 'full', label: 'Full: re-run review and every job' },
  { value: 'fast', label: 'Fast: re-run review, keep slow job results' },
  { value: 'off', label: 'Off: push without re-running' },
];

export const DEFAULT_BASE_DRIFT_HAZARD_PATHS: readonly string[] = [
  '**/migrations/**',
  '**/db/migrate/**',
];

export interface BaseDriftSettingsValue {
  mode?: string;
  reuseJobs?: string[];
  hazardPaths?: string[];
  mergeCheckJobs?: string[];
  autoUpdatePrs?: boolean;
}

/** The editable text fields, as comma-separated strings. */
export interface BaseDriftForm {
  reuseText: string;
  hazardText: string;
  mergeCheckText: string;
}

export function baseDriftMode(value: BaseDriftSettingsValue | null | undefined): BaseDriftMode {
  return value?.mode === 'fast' || value?.mode === 'off' ? value.mode : 'full';
}

export function splitBaseDriftList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function baseDriftFormFromSettings(
  value: BaseDriftSettingsValue | null | undefined,
): BaseDriftForm {
  return {
    reuseText: (value?.reuseJobs ?? []).join(', '),
    hazardText: (Array.isArray(value?.hazardPaths)
      ? value.hazardPaths
      : DEFAULT_BASE_DRIFT_HAZARD_PATHS
    ).join(', '),
    mergeCheckText: (value?.mergeCheckJobs ?? []).join(', '),
  };
}

export function baseDriftFormDirty(
  form: BaseDriftForm,
  value: BaseDriftSettingsValue | null | undefined,
): boolean {
  const stored = baseDriftFormFromSettings(value);
  return (
    form.reuseText !== stored.reuseText ||
    form.hazardText !== stored.hazardText ||
    form.mergeCheckText !== stored.mergeCheckText
  );
}

/** PATCH body for the list fields the form edits. */
export function baseDriftListsPatch(form: BaseDriftForm): {
  reuseJobs: string[];
  hazardPaths: string[];
  mergeCheckJobs: string[];
} {
  return {
    reuseJobs: splitBaseDriftList(form.reuseText),
    hazardPaths: splitBaseDriftList(form.hazardText),
    mergeCheckJobs: splitBaseDriftList(form.mergeCheckText),
  };
}

export const MERGE_CHECK_HINT =
  'When main changes the same files after a PR passed, these ci.yaml jobs run on the PR ' +
  'combined with the current main before it merges, and the merge finishes on its own if ' +
  'they pass. With none listed, the PR has to be updated first. Comma separated.';

export const AUTO_UPDATE_HINT =
  'When main changes files an open PR also changes, update the PR branch right away so its ' +
  "checks run against the new main. Each update re-runs the PR's full CI.";
