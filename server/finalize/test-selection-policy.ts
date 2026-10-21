/**
 * Project setting for Finalize dynamic test selection.
 *
 * `full` (default) runs every `.agent-hub/ci.yaml` job instance. `dynamic`
 * runs only the instances a change needs, which is only safe because every
 * merge to the default branch runs the full suite through push CI. So
 * `dynamic` is refused unless `ciOnPush.enabled` is on, and `ciOnPush` can't
 * be turned off while `dynamic` is on.
 *
 * `alwaysRun` lists job ids that run on every selected run (build, lint,
 * typecheck, ...). A changed file matching any `fullRunPaths` glob forces a
 * full run; project globs add to `DEFAULT_FULL_RUN_PATHS`, never replace them.
 */

import { DEFAULT_FULL_RUN_PATHS } from '../../shared/utils/testSelection.js';
import { matchesAnyGlob } from './flake-recovery.js';

export { DEFAULT_FULL_RUN_PATHS };

export const TEST_SELECTION_MODES = ['full', 'dynamic'] as const;
export type TestSelectionMode = (typeof TEST_SELECTION_MODES)[number];

/** Project-level config as stored in projects.json. Every field is optional. */
export interface TestSelectionSettings {
  mode?: TestSelectionMode;
  alwaysRun?: string[];
  fullRunPaths?: string[];
}

export interface TestSelectionPolicy {
  mode: TestSelectionMode;
  alwaysRun: string[];
  /** Defaults followed by the project's own globs. */
  fullRunPaths: string[];
}

export function isTestSelectionMode(value: unknown): value is TestSelectionMode {
  return typeof value === 'string' && (TEST_SELECTION_MODES as readonly string[]).includes(value);
}

/** Fill defaults; an unknown mode reads as `full` so a bad value never shrinks the gate. */
export function resolveTestSelectionPolicy(
  settings: TestSelectionSettings | null | undefined,
): TestSelectionPolicy {
  const mode = isTestSelectionMode(settings?.mode) ? settings.mode : 'full';
  return {
    mode,
    alwaysRun: cleanList(settings?.alwaysRun),
    fullRunPaths: cleanList([...DEFAULT_FULL_RUN_PATHS, ...cleanList(settings?.fullRunPaths)]),
  };
}

/** Changed paths that force a full run under `policy`, sorted. */
export function fullRunPathHits(changedPaths: readonly string[], policy: TestSelectionPolicy) {
  return [...new Set(changedPaths)].filter((p) => matchesAnyGlob(p, policy.fullRunPaths)).sort();
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

const MAX_LIST_ENTRIES = 100;
const MAX_ENTRY_LENGTH = 200;

/**
 * Validate a `PATCH /api/projects/:projectId` `testSelection` body. `null`
 * clears the setting; an object merges the fields it carries over the stored
 * value.
 */
export function parseTestSelectionPatch(
  raw: unknown,
): { ok: true; value: TestSelectionSettings | null } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'testSelection must be an object or null' };
  }
  const body = raw as Record<string, unknown>;
  const next: TestSelectionSettings = {};
  if (body.mode !== undefined) {
    if (!isTestSelectionMode(body.mode)) {
      return {
        ok: false,
        error: `testSelection.mode must be one of ${TEST_SELECTION_MODES.join(', ')}`,
      };
    }
    next.mode = body.mode;
  }
  for (const key of ['alwaysRun', 'fullRunPaths'] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (
      !Array.isArray(value) ||
      value.length > MAX_LIST_ENTRIES ||
      value.some((v) => typeof v !== 'string' || v.length > MAX_ENTRY_LENGTH)
    ) {
      return {
        ok: false,
        error: `testSelection.${key} must be a list of at most ${MAX_LIST_ENTRIES} strings`,
      };
    }
    next[key] = cleanList(value);
  }
  return { ok: true, value: next };
}

export const DYNAMIC_REQUIRES_CI_ON_PUSH_ERROR =
  'testSelection.mode "dynamic" requires CI on push (ciOnPush.enabled): every merge to the ' +
  'default branch must run the full suite. Turn on CI on push in the project Runners settings first.';

export const CI_ON_PUSH_REQUIRED_BY_DYNAMIC_ERROR =
  'ciOnPush cannot be turned off while testSelection.mode is "dynamic": the full run on every ' +
  'default-branch merge is the backstop for selected runs. Set testSelection.mode to "full" first.';

/**
 * Check the dynamic-selection backstop for a project PATCH. `current` is the
 * stored project; `body` is the raw request. Returns the error to send as a
 * `400`, or null when the resulting state is allowed. Field-level validation
 * of `testSelection` and `ciOnPush` happens elsewhere; malformed values here
 * fall back to the stored state so this never masks those errors.
 */
export function checkTestSelectionBackstop(
  current: { testSelection?: TestSelectionSettings; ciOnPush?: { enabled?: boolean } },
  body: Record<string, unknown>,
): string | null {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  // Unrelated edits never trip over a hand-edited inconsistent projects.json.
  if (!has('testSelection') && !has('ciOnPush')) return null;

  const currentMode = resolveTestSelectionPolicy(current.testSelection).mode;
  let nextMode = currentMode;
  if (has('testSelection')) {
    const parsed = parseTestSelectionPatch(body.testSelection);
    if (parsed.ok) {
      nextMode =
        parsed.value === null
          ? 'full'
          : resolveTestSelectionPolicy({ ...(current.testSelection ?? {}), ...parsed.value }).mode;
    }
  }

  const currentCi = current.ciOnPush?.enabled === true;
  let nextCi = currentCi;
  if (has('ciOnPush')) {
    const raw = body.ciOnPush;
    if (raw === null) nextCi = false;
    else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const enabled = (raw as Record<string, unknown>).enabled;
      if (typeof enabled === 'boolean') nextCi = enabled;
    }
  }

  if (nextMode !== 'dynamic' || nextCi) return null;
  // Name the side the caller is trying to move.
  return currentMode === 'dynamic' && currentCi
    ? CI_ON_PUSH_REQUIRED_BY_DYNAMIC_ERROR
    : DYNAMIC_REQUIRES_CI_ON_PUSH_ERROR;
}
