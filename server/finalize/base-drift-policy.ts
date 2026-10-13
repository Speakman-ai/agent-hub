/**
 * What Finalize does when the base-drift gate finds the base branch moved
 * onto ground this branch also touches (see base-drift.ts).
 *
 * The gate's default answer, a full rebase + review + every ci.yaml job, is
 * correct but expensive: on a project with a 40-minute E2E suite, every
 * overlapping merge on main throws that whole pipeline away. Projects pick a
 * trade-off with `Project.baseDrift.mode`:
 *
 *   - `full` (default): re-run everything. Same as before this setting existed.
 *   - `fast`: rebase, re-review, and re-run every job except `reuseJobs`, which
 *     keep their passing result from the previous round. Escalates to `full`
 *     when the overlap is the risky kind: the same file changed on both sides,
 *     or overlapping changes under a hazard path such as a migrations
 *     directory (two branches each adding a migration off the same parent is
 *     the failure that motivated the gate).
 *   - `off`: accept the risk and push without re-validating.
 */

import type { BaseDriftOutcome } from './base-drift.js';
import { matchesAnyGlob } from './flake-recovery.js';

export const BASE_DRIFT_MODES = ['full', 'fast', 'off'] as const;
export type BaseDriftMode = (typeof BASE_DRIFT_MODES)[number];

/** Hazard globs applied when a project has not set its own list. */
export const DEFAULT_BASE_DRIFT_HAZARD_PATHS: readonly string[] = [
  '**/migrations/**',
  '**/db/migrate/**',
];

/** Project-level config as stored in projects.json. Every field is optional. */
export interface BaseDriftSettings {
  mode?: BaseDriftMode;
  reuseJobs?: string[];
  hazardPaths?: string[];
}

export interface BaseDriftPolicy {
  mode: BaseDriftMode;
  reuseJobs: string[];
  hazardPaths: string[];
}

export function isBaseDriftMode(value: unknown): value is BaseDriftMode {
  return typeof value === 'string' && (BASE_DRIFT_MODES as readonly string[]).includes(value);
}

/** Fill defaults; an unknown mode reads as `full` so a bad value never relaxes the gate. */
export function resolveBaseDriftPolicy(
  settings: BaseDriftSettings | null | undefined,
): BaseDriftPolicy {
  const mode = isBaseDriftMode(settings?.mode) ? settings.mode : 'full';
  const reuseJobs = cleanList(settings?.reuseJobs);
  const hazardPaths = Array.isArray(settings?.hazardPaths)
    ? cleanList(settings.hazardPaths)
    : [...DEFAULT_BASE_DRIFT_HAZARD_PATHS];
  return { mode, reuseJobs, hazardPaths };
}

function cleanList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export type BaseDriftAction =
  | { kind: 'proceed'; detail: string }
  | {
      kind: 'rerun_full';
      reason: 'policy_full' | 'same_file' | 'hazard_path' | 'no_reuse_jobs';
      detail: string;
    }
  | { kind: 'rerun_fast'; reuseJobs: string[]; detail: string };

type StaleOutcome = Extract<BaseDriftOutcome, { kind: 'stale' }>;

/** Is `path` on ground listed in `overlap` (exact file, or under an overlapping directory)? */
function onOverlap(path: string, overlap: ReadonlySet<string>): boolean {
  if (overlap.has(path)) return true;
  const i = path.lastIndexOf('/');
  return i !== -1 && overlap.has(`${path.slice(0, i)}/`);
}

/** Decide how a stale base-drift outcome should be handled under `policy`. */
export function decideBaseDriftAction(
  outcome: StaleOutcome,
  policy: BaseDriftPolicy,
): BaseDriftAction {
  if (policy.mode === 'off') {
    return {
      kind: 'proceed',
      detail: `base drift policy is off; pushing without re-validation (${outcome.detail})`,
    };
  }
  if (policy.mode === 'full') {
    return { kind: 'rerun_full', reason: 'policy_full', detail: outcome.detail };
  }

  // Directory entries carry a trailing slash; anything else is a file both
  // sides changed.
  const sameFiles = outcome.overlap.filter((entry) => !entry.endsWith('/'));
  if (sameFiles.length > 0) {
    return {
      kind: 'rerun_full',
      reason: 'same_file',
      detail: `base and branch both changed ${sameFiles.slice(0, 5).join(', ')}; full re-run`,
    };
  }

  const overlap = new Set(outcome.overlap);
  const hazardHits = [...new Set([...outcome.basePaths, ...outcome.branchPaths])]
    .filter((path) => onOverlap(path, overlap))
    .filter((path) => matchesAnyGlob(path, policy.hazardPaths))
    .sort();
  if (hazardHits.length > 0) {
    return {
      kind: 'rerun_full',
      reason: 'hazard_path',
      detail: `overlap touches hazard path ${hazardHits.slice(0, 5).join(', ')}; full re-run`,
    };
  }

  if (policy.reuseJobs.length === 0) {
    return {
      kind: 'rerun_full',
      reason: 'no_reuse_jobs',
      detail: 'fast mode has no jobs marked for reuse; full re-run',
    };
  }

  return {
    kind: 'rerun_fast',
    reuseJobs: policy.reuseJobs,
    detail:
      `${outcome.detail}; re-running review and checks except ` +
      `${policy.reuseJobs.join(', ')}, which keep their earlier passing result`,
  };
}

/** Key for one expanded job instance; matches the job runner's instance identity. */
export function jobInstanceKey(jobId: string, matrixKey: string): string {
  return `${jobId}\u0000${matrixKey}`;
}

const MAX_LIST_ENTRIES = 50;
const MAX_ENTRY_LENGTH = 200;

/**
 * Validate a `PATCH /api/projects/:projectId` `baseDrift` body. `null` clears
 * the setting; an object merges the fields it carries over the stored value.
 */
export function parseBaseDriftPatch(
  raw: unknown,
): { ok: true; value: BaseDriftSettings | null } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'baseDrift must be an object or null' };
  }
  const body = raw as Record<string, unknown>;
  const next: BaseDriftSettings = {};
  if (body.mode !== undefined) {
    if (!isBaseDriftMode(body.mode)) {
      return { ok: false, error: `baseDrift.mode must be one of ${BASE_DRIFT_MODES.join(', ')}` };
    }
    next.mode = body.mode;
  }
  for (const key of ['reuseJobs', 'hazardPaths'] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (
      !Array.isArray(value) ||
      value.length > MAX_LIST_ENTRIES ||
      value.some((v) => typeof v !== 'string' || v.length > MAX_ENTRY_LENGTH)
    ) {
      return {
        ok: false,
        error: `baseDrift.${key} must be a list of at most ${MAX_LIST_ENTRIES} strings`,
      };
    }
    next[key] = cleanList(value);
  }
  return { ok: true, value: next };
}
