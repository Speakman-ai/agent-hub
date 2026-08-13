/**
 * ci-config.ts — Finalize Code Changes, `.agent-hub/ci.yaml` parser entry point.
 *
 * Defines the schema for the project's Finalize pipeline config and the
 * validator the orchestrator consumes before running jobs. The full design
 * lives in the wiki page `finalize-code-changes-architecture-v0` (§5); this
 * module is the executable form of that spec.
 *
 * This file owns the ROOT of the document — `version`, `on`, `timeout_minutes`
 * — and hands the `jobs:` / `matrix:` body to `parseCiConfigJobs` in
 * `./ci-config-jobs.ts`. The orchestrator fans the resulting job instances out
 * to the runner fleet, one container per instance.
 *
 * `version: 2` is the only accepted schema. Any other value is an error
 * (`invalid_version`); a `version: 1` document (the flat sequential `steps:`
 * pipeline that used to run on the Hub box itself) is rejected with a
 * conversion hint rather than misrouted.
 *
 * Hard constraints (mirroring §5 of the design doc):
 *
 *   - `on:` accepts only `finalize`, `manual`, and `push`. No `pull_request`.
 *   - `steps[].run` is required. Every step is executed by the runner as
 *     `bash -euo pipefail -c <run>`. There is no `shell:` override and
 *     providing one is an error.
 *   - `steps[].name` is optional and defaults to `step <index>` (1-indexed),
 *     matching what a human would write in a worklog.
 *   - `timeout_minutes` is optional. It is the **pipeline wall-clock**
 *     cap (kill a hung job/step). The runtime ceiling is 4 hours. The
 *     config may LOWER that hang limit (e.g. fast-fail at 10 minutes)
 *     but never RAISE it — and the floor is 1 minute. Out-of-range
 *     values error. This field does **not** cap the §13 active-time
 *     budget (agent/reviewer turns); that stays at the 4-hour default.
 *   - Unknown top-level, job-level, and step-level keys are a HARD ERROR
 *     rather than a silent ignore, so an author can't believe they enabled a
 *     feature the runner ignored. In particular, an `autofix:` field is
 *     rejected at parse time — design lock removed autofix as a distinct
 *     phase; fixes always flow back into the originating session.
 *
 * Authoring path: users do not hand-roll this file from scratch. The
 * `finalize-setup` skill proposes a default ci.yaml based on repo
 * introspection. Hand-authored configs stay fully supported — this
 * parser is the single source of truth on the wire format.
 */

import { promises as fs } from 'fs';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { FINALIZE_BUDGET_DEFAULT_SECONDS, FINALIZE_BUDGET_HARD_CEILING_SECONDS } from './budget.js';
import { parseCiConfigJobs } from './ci-config-jobs.js';

/** Shell prefix the orchestrator uses to execute every `run` step. */
export const FINALIZE_STEP_SHELL = 'bash -euo pipefail -c';

/** Hard ceiling on `timeout_minutes`. Config may lower; never raise. */
export const FINALIZE_TIMEOUT_MAX_MINUTES = FINALIZE_BUDGET_HARD_CEILING_SECONDS / 60;

/** Floor on `timeout_minutes`. A zero/negative budget is meaningless. */
export const FINALIZE_TIMEOUT_MIN_MINUTES = 1;

/** Default for `timeout_minutes` when the field is omitted entirely. */
export const FINALIZE_TIMEOUT_DEFAULT_MINUTES = FINALIZE_BUDGET_DEFAULT_SECONDS / 60;

/**
 * Triggers the parser accepts. `finalize`/`manual` gate the Finalize
 * orchestrator; `push` marks configs intended for "CI on push" against
 * Agent Hub-hosted repos (server/git-host/push-ci.ts) — actual gating is
 * the project-level `ciOnPush.enabled` toggle, the trigger value just
 * keeps such configs parseable.
 */
export const SUPPORTED_TRIGGERS = ['finalize', 'manual', 'push'] as const;
export type CiTrigger = (typeof SUPPORTED_TRIGGERS)[number];

/**
 * Validate a step-level `timeout_minutes` (GHA parity — a per-step wall-clock
 * cap). Must be a positive integer no larger than the pipeline ceiling: a
 * per-step cap can only TIGHTEN the bound, never raise it above
 * {@link FINALIZE_TIMEOUT_MAX_MINUTES}. The remote runner agent enforces it
 * locally (kills the container exec on expiry); the pipeline budget is always
 * the outer ceiling regardless.
 */
export function validateStepTimeoutMinutes(
  raw: unknown,
): { ok: true; value: number } | { ok: false; message: string } {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    return { ok: false, message: `must be a positive integer; got ${describeValue(raw)}` };
  }
  if (raw > FINALIZE_TIMEOUT_MAX_MINUTES) {
    return {
      ok: false,
      message: `= ${raw} exceeds the pipeline ceiling of ${FINALIZE_TIMEOUT_MAX_MINUTES} minutes`,
    };
  }
  return { ok: true, value: raw };
}

export type { CiConfig, CiJob, CiStep, JobInstance } from './ci-config-jobs.js';

/**
 * Machine-readable error codes for parse / validation failures.
 *
 * Used by the orchestrator to map failures to the `ci_config_invalid`
 * `failure_reason` on `finalize_runs` (design §10) without losing the
 * detail that the user actually needs to fix. The codes are also stable
 * for tests — never rename without updating call-sites.
 */
export type CiConfigErrorCode =
  | 'yaml_parse_error'
  // The committed `.agent-hub/ci.yaml` does not exist on disk. Distinct from
  // `yaml_parse_error` (which means the file IS there but unreadable/malformed)
  // because absence is the ONLY signal the config resolver treats as "fall back
  // to a server-stored config" (see ci-config-source.ts). Overloading
  // `yaml_parse_error` for absence would make a broken committed file silently
  // fall through to server config.
  | 'ci_config_absent'
  | 'not_an_object'
  | 'missing_version'
  | 'invalid_version'
  | 'missing_on'
  | 'invalid_on_shape'
  | 'empty_on'
  | 'invalid_on_value'
  | 'invalid_timeout_shape'
  | 'timeout_out_of_range'
  | import('./ci-config-jobs.js').CiConfigJobsErrorCode;

export interface CiConfigParseError {
  code: CiConfigErrorCode;
  message: string;
  /**
   * Dotted path to the offending field when meaningful (e.g.
   * `steps[2].run`). Omitted for top-level / structural errors.
   */
  path?: string;
}

export type CiConfigParseResult =
  | { ok: true; config: import('./ci-config-jobs.js').CiConfig }
  | { ok: false; error: CiConfigParseError };

/**
 * Parse a `.agent-hub/ci.yaml` document from raw text.
 *
 * Pure with respect to filesystem and process state — callers that want
 * to read a file from disk should use {@link loadCiConfigFromFile}. The
 * split exists so unit tests can drive the validator with fixture
 * strings without touching the filesystem and so the file loader can
 * stay a thin shell that the orchestrator can mock at one boundary.
 *
 * Returns a tagged union rather than throwing because every failure
 * mode here is a user-visible "your config is wrong, fix it" surface,
 * not an exceptional condition. Throwing would force every call-site
 * into try/catch and lose the structured error code that the
 * orchestrator turns into `ci_config_invalid` + a session-visible
 * message.
 */
export function parseCiConfig(text: string): CiConfigParseResult {
  // ─── Stage 1: YAML parse ────────────────────────────────────────────
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    const detail = err instanceof YAMLParseError ? err.message : String(err);
    return err_('yaml_parse_error', `Could not parse ci.yaml as YAML: ${detail}`);
  }

  // ─── Stage 2: root shape ────────────────────────────────────────────
  if (parsed === null || parsed === undefined) {
    return err_('not_an_object', 'ci.yaml is empty; expected a top-level mapping.');
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return err_(
      'not_an_object',
      'ci.yaml must be a top-level mapping (object); got ' + describeType(parsed) + '.',
    );
  }
  const root = parsed as Record<string, unknown>;

  // ─── Stage 3: version ───────────────────────────────────────────────
  if (!('version' in root)) {
    return err_('missing_version', "ci.yaml is missing the required 'version' field.", 'version');
  }
  const version = root.version;
  if (version !== 2) {
    // A `version: 1` document is the retired flat `steps:` pipeline. Name the
    // migration explicitly instead of the generic "must be 2" — an operator
    // reading this in the run's failure detail needs to know what to write.
    const hint =
      version === 1
        ? " The flat 'steps:' pipeline is no longer supported: declare 'version: 2' and" +
          " move your steps under a job that names a runner, e.g. 'jobs: { build: {" +
          " runs-on: ubuntu-24.04, steps: [...] } }'."
        : '';
    return err_(
      'invalid_version',
      `ci.yaml 'version' must be 2 (got ${describeValue(version)}).${hint}`,
      'version',
    );
  }

  // ─── Stage 4: on: triggers ──────────────────────────────────────────
  if (!('on' in root)) {
    return err_('missing_on', "ci.yaml is missing the required 'on' field.", 'on');
  }
  const onRaw = root.on;
  if (!Array.isArray(onRaw)) {
    return err_(
      'invalid_on_shape',
      `ci.yaml 'on' must be a list of trigger names; got ${describeType(onRaw)}.`,
      'on',
    );
  }
  if (onRaw.length === 0) {
    return err_(
      'empty_on',
      "ci.yaml 'on' must declare at least one trigger (allowed: " +
        SUPPORTED_TRIGGERS.join(', ') +
        ').',
      'on',
    );
  }
  const on: CiTrigger[] = [];
  for (let i = 0; i < onRaw.length; i++) {
    const entry = onRaw[i];
    if (typeof entry !== 'string') {
      return err_(
        'invalid_on_value',
        `ci.yaml 'on[${i}]' must be a string; got ${describeType(entry)}.`,
        `on[${i}]`,
      );
    }
    if (!isTrigger(entry)) {
      return err_(
        'invalid_on_value',
        `ci.yaml 'on[${i}]' = '${entry}' is not a recognised trigger (allowed: ${SUPPORTED_TRIGGERS.join(', ')}).`,
        `on[${i}]`,
      );
    }
    on.push(entry);
  }

  // ─── Stage 5: timeout_minutes ───────────────────────────────────────
  let timeoutMinutes: number = FINALIZE_TIMEOUT_DEFAULT_MINUTES;
  if ('timeout_minutes' in root) {
    const raw = root.timeout_minutes;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
      return err_(
        'invalid_timeout_shape',
        `ci.yaml 'timeout_minutes' must be a positive integer; got ${describeValue(raw)}.`,
        'timeout_minutes',
      );
    }
    if (raw < FINALIZE_TIMEOUT_MIN_MINUTES || raw > FINALIZE_TIMEOUT_MAX_MINUTES) {
      return err_(
        'timeout_out_of_range',
        `ci.yaml 'timeout_minutes' = ${raw} is out of range; must be ` +
          `between ${FINALIZE_TIMEOUT_MIN_MINUTES} and ${FINALIZE_TIMEOUT_MAX_MINUTES}.`,
        'timeout_minutes',
      );
    }
    timeoutMinutes = raw;
  }

  return parseCiConfigJobs(root, on, timeoutMinutes);
}

/**
 * Read a ci.yaml file from disk and parse it.
 *
 * The orchestrator usually reads from `<repo>/.agent-hub/ci.yaml`, but
 * the loader is path-agnostic so tests (and any future "config lives in
 * a sibling directory" deploys) can point at an arbitrary file. The
 * "file lives at non-root location" acceptance criterion is exercised
 * by the unit tests via this entry point.
 *
 * Failures fall into three buckets, all returned as the same tagged
 * union as {@link parseCiConfig}:
 *
 *   - Missing file → `yaml_parse_error` with a clear "could not read"
 *     message. The caller (orchestrator's parse phase) maps this to
 *     `ci_config_invalid` the same way as a syntactic error.
 *   - Read error other than ENOENT → same code, message includes the
 *     OS error so on-call has something to grep for.
 *   - Parsed but invalid → whatever {@link parseCiConfig} returns.
 */
export async function loadCiConfigFromFile(absPath: string): Promise<CiConfigParseResult> {
  let text: string;
  try {
    text = await fs.readFile(absPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    // ENOENT is reported with the dedicated `ci_config_absent` code so the
    // config resolver can distinguish "no committed file → try server config"
    // from "committed file present but unreadable/malformed → fail". Every
    // other read error stays `yaml_parse_error` (the file exists but we could
    // not read it — a real problem, not a fallback trigger).
    if (code === 'ENOENT') {
      return err_('ci_config_absent', `file not found at ${absPath}`);
    }
    const detail = `could not read ${absPath}: ${err instanceof Error ? err.message : String(err)}`;
    return err_('yaml_parse_error', detail);
  }
  return parseCiConfig(text);
}

// ─── Helpers ──────────────────────────────────────────────────────────

function err_(
  code: CiConfigErrorCode,
  message: string,
  path?: string,
): { ok: false; error: CiConfigParseError } {
  return { ok: false, error: path ? { code, message, path } : { code, message } };
}

function isTrigger(value: string): value is CiTrigger {
  return (SUPPORTED_TRIGGERS as readonly string[]).includes(value);
}

/**
 * Human-readable type label for error messages. We use `typeof` plus a
 * couple of overrides so `null` and `array` come out distinct rather
 * than both reading as `'object'`.
 */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Compact value label for error messages. Quoting strings makes
 * empty-string and whitespace-only mistakes visible in the surface the
 * user reads ("got ''" beats "got "). Falls back to {@link describeType}
 * for everything else so we never dump arbitrary objects into messages.
 */
function describeValue(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return describeType(value);
}
