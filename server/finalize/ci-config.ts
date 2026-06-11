/**
 * ci-config.ts — Finalize Code Changes, `.agent-hub/ci.yaml` parser entry point.
 *
 * Defines the schema for the project's Finalize pipeline config and the
 * validator the orchestrator consumes before running steps. The full design
 * lives in the wiki page `finalize-code-changes-architecture-v0` (§5); this
 * module is the executable form of that spec.
 *
 * TWO schema versions are accepted:
 *   - `version: 1` — flat sequential `steps:` pipeline, parsed inline below.
 *     Runs on the Hub box itself, one step at a time.
 *   - `version: 2` — GHA-style `jobs:` / `matrix:` / `env:`, parsed by
 *     `parseCiConfigV2Root` in `./ci-config-v2.ts`. The orchestrator fans v2
 *     jobs out to the remote runner fleet, one container per job instance.
 * Any other `version` value is an error (`invalid_version`). The constraints
 * below describe the **v1** wire format; v2's allowances (job `env`, step
 * `env`, `matrix`, `runs-on`, `needs`) live in ci-config-v2.ts.
 *
 * Hard constraints at v1 (mirroring §5 of the design doc):
 *
 *   - `on:` accepts only `finalize` and `manual`. No `pull_request`.
 *   - `steps[].run` is required. Every step is executed by the
 *     orchestrator as `bash -euo pipefail -c <run>`. There is no
 *     `shell:` override and providing one is an error.
 *   - `steps[].name` is optional and defaults to `step <index>`
 *     (1-indexed), matching what a human would write in a worklog.
 *   - `timeout_minutes` is optional. The runtime cap is 4 hours. The config
 *     may LOWER the cap (e.g. fast-fail at 10 minutes) but never RAISE
 *     it — and the floor is 1 minute. Out-of-range values error.
 *   - Unknown top-level keys are a HARD ERROR rather than a silent
 *     ignore. In particular, an `autofix:` field is rejected at parse
 *     time — design lock removed autofix as a distinct phase; fixes
 *     always flow back into the originating session.
 *   - Unknown step-level keys are also a hard error at v1. We do not
 *     silently drop directives so an author can't believe they enabled a
 *     feature the orchestrator ignored. NOTE: `env:` and `matrix:` are NOT
 *     v1 keys, but they ARE valid in v2 (see ci-config-v2.ts) — `env:` at the
 *     job OR step level, `matrix:` at the job level ONLY (a step still cannot
 *     carry `matrix:`). Config that needs them should declare `version: 2`
 *     rather than assume the directive is illegal.
 *
 * Authoring path: users do not hand-roll this file from scratch. The
 * `finalize-setup` skill proposes a default ci.yaml based on repo
 * introspection. Hand-authored configs stay fully supported — this
 * parser is the single source of truth on the v1 wire format.
 */

import { promises as fs } from 'fs';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { FINALIZE_BUDGET_DEFAULT_SECONDS, FINALIZE_BUDGET_HARD_CEILING_SECONDS } from './budget.js';
import { parseCiConfigV2Root } from './ci-config-v2.js';

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

/** Top-level keys the parser accepts. Anything else fails closed. */
const SUPPORTED_TOP_LEVEL_KEYS = new Set(['version', 'on', 'timeout_minutes', 'steps']);

/** Step-level keys the parser accepts. Anything else fails closed. */
const SUPPORTED_STEP_KEYS = new Set(['name', 'run']);

export interface CiStep {
  /**
   * Step display name. Defaults to `step <index>` (1-indexed) when the
   * author omitted the field — index is filled in here so downstream
   * code never has to re-derive it.
   */
  name: string;
  /**
   * Shell command. Executed verbatim under
   * `bash -euo pipefail -c <run>` by the orchestrator.
   */
  run: string;
  /**
   * Resolved (env-substituted) step-level environment variables. Injected into
   * the step's process environment (for container jobs, as `docker exec -e`
   * args — never inlined into `run`, which is persisted/displayed). Absent when
   * the step declared no `env:`.
   */
  env?: Record<string, string>;
}

export interface CiConfig {
  version: 1;
  /** Non-empty subset of {@link SUPPORTED_TRIGGERS}. */
  on: CiTrigger[];
  /**
   * Active-time cap in minutes. Always within
   * `[FINALIZE_TIMEOUT_MIN_MINUTES, FINALIZE_TIMEOUT_MAX_MINUTES]`.
   * Defaults to {@link FINALIZE_TIMEOUT_DEFAULT_MINUTES}.
   */
  timeoutMinutes: number;
  /** Non-empty list of steps in declaration order. */
  steps: CiStep[];
}

/** v1 config alias for clarity in v2 call-sites. */
export type CiConfigV1 = CiConfig;

export type { CiConfigV2, CiJobV2, CiStepV2, JobInstance } from './ci-config-v2.js';
export type AnyCiConfig = CiConfigV1 | import('./ci-config-v2.js').CiConfigV2;

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
  | 'not_an_object'
  | 'missing_version'
  | 'invalid_version'
  | 'unknown_top_level_key'
  | 'missing_on'
  | 'invalid_on_shape'
  | 'empty_on'
  | 'invalid_on_value'
  | 'invalid_timeout_shape'
  | 'timeout_out_of_range'
  | 'missing_steps'
  | 'invalid_steps_shape'
  | 'empty_steps'
  | 'invalid_step_shape'
  | 'missing_step_run'
  | 'invalid_step_run'
  | 'invalid_step_name'
  | 'unknown_step_key'
  | import('./ci-config-v2.js').CiConfigV2ErrorCode;

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
  | { ok: true; config: AnyCiConfig }
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
  if (version !== 1 && version !== 2) {
    return err_(
      'invalid_version',
      `ci.yaml 'version' must be 1 or 2 (got ${describeValue(version)}).`,
      'version',
    );
  }

  // ─── Stage 4: on: triggers (shared v1 + v2) ─────────────────────────
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

  // ─── Stage 5: timeout_minutes (shared v1 + v2) ──────────────────────
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

  if (version === 2) {
    return parseCiConfigV2Root(root, on, timeoutMinutes);
  }

  // ─── v1-only: unknown top-level keys ────────────────────────────────
  for (const key of Object.keys(root)) {
    if (!SUPPORTED_TOP_LEVEL_KEYS.has(key)) {
      const hint =
        key === 'autofix'
          ? ' (autofix is not a v1 field — fixes flow into the originating session)'
          : key === 'jobs'
            ? ' (use version: 2 for jobs/matrix)'
            : '';
      return err_(
        'unknown_top_level_key',
        `Unknown top-level key in ci.yaml: '${key}'${hint}.`,
        key,
      );
    }
  }

  // ─── v1-only: steps ─────────────────────────────────────────────────
  if (!('steps' in root)) {
    return err_('missing_steps', "ci.yaml is missing the required 'steps' field.", 'steps');
  }
  const stepsRaw = root.steps;
  if (!Array.isArray(stepsRaw)) {
    return err_(
      'invalid_steps_shape',
      `ci.yaml 'steps' must be a list; got ${describeType(stepsRaw)}.`,
      'steps',
    );
  }
  if (stepsRaw.length === 0) {
    return err_(
      'empty_steps',
      "ci.yaml 'steps' must declare at least one step; an empty pipeline is not valid.",
      'steps',
    );
  }
  const steps: CiStep[] = [];
  for (let i = 0; i < stepsRaw.length; i++) {
    const raw = stepsRaw[i];
    const stepPath = `steps[${i}]`;
    if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
      return err_(
        'invalid_step_shape',
        `ci.yaml '${stepPath}' must be a mapping with a 'run' field; got ${describeType(raw)}.`,
        stepPath,
      );
    }
    const stepObj = raw as Record<string, unknown>;
    // Unknown step keys fail closed (catches `shell:`, `uses:`, `with:`,
    // `env:`, `matrix:` etc. — design §5 forbids all of them at v1).
    for (const key of Object.keys(stepObj)) {
      if (!SUPPORTED_STEP_KEYS.has(key)) {
        return err_(
          'unknown_step_key',
          `Unknown key in ci.yaml '${stepPath}': '${key}' ` +
            `(allowed: ${[...SUPPORTED_STEP_KEYS].join(', ')}).`,
          `${stepPath}.${key}`,
        );
      }
    }
    if (!('run' in stepObj)) {
      return err_(
        'missing_step_run',
        `ci.yaml '${stepPath}' is missing the required 'run' field.`,
        `${stepPath}.run`,
      );
    }
    const runRaw = stepObj.run;
    if (typeof runRaw !== 'string' || runRaw.trim().length === 0) {
      return err_(
        'invalid_step_run',
        `ci.yaml '${stepPath}.run' must be a non-empty string; got ${describeValue(runRaw)}.`,
        `${stepPath}.run`,
      );
    }
    let name: string;
    if ('name' in stepObj) {
      const nameRaw = stepObj.name;
      if (typeof nameRaw !== 'string' || nameRaw.trim().length === 0) {
        return err_(
          'invalid_step_name',
          `ci.yaml '${stepPath}.name' must be a non-empty string when provided; got ${describeValue(nameRaw)}.`,
          `${stepPath}.name`,
        );
      }
      name = nameRaw;
    } else {
      // Default to "step <1-indexed-position>". Matches design §5 wording.
      name = `step ${i + 1}`;
    }
    steps.push({ name, run: runRaw });
  }

  return {
    ok: true,
    config: {
      version: 1,
      on,
      timeoutMinutes,
      steps,
    },
  };
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
    const detail =
      code === 'ENOENT'
        ? `file not found at ${absPath}`
        : `could not read ${absPath}: ${err instanceof Error ? err.message : String(err)}`;
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
