/**
 * ci-config-v2.ts — `.agent-hub/ci.yaml` v2 parser (GHA-style jobs + matrix).
 *
 * v2 adds `jobs`, `runs-on`, `matrix.include`, job/step `env`, and parallel
 * container execution. v1 configs are unchanged — see ci-config.ts.
 */
import {
  FINALIZE_TIMEOUT_DEFAULT_MINUTES,
  FINALIZE_TIMEOUT_MAX_MINUTES,
  FINALIZE_TIMEOUT_MIN_MINUTES,
  SUPPORTED_TRIGGERS,
  type CiConfigParseError,
  type CiConfigParseResult,
  type CiTrigger,
} from './ci-config.js';

export interface CiStepV2 {
  name: string;
  run: string;
  /** Static env map; values may contain ${VAR} placeholders. */
  env?: Record<string, string>;
}

export interface CiJobV2 {
  runsOn: string;
  failFast: boolean;
  /**
   * Warm-up job: run this job to completion before any non-warmup job starts.
   * Use for a one-shot prepare pass (build images, seed the DB snapshot, warm
   * the dep cache into the shared /finalize-cache) so the fan-out matrix shards
   * load from a warm cache instead of all building concurrently. Acts as a
   * single barrier — every warmup job finishes before the rest begin.
   */
  warmup: boolean;
  /**
   * Job ids this job depends on (GHA `needs:`). The job's instances do not
   * start until every needed job has completed successfully; if a needed job
   * fails, this job is skipped. Use to scope a prepare job to only the jobs
   * that consume its cache (e.g. `e2e` needs `prepare`, while `backend` /
   * `frontend` run immediately). Normalized to an array (a bare string is
   * accepted in YAML). Empty when omitted.
   */
  needs: string[];
  /** One entry per parallel matrix shard (GHA `matrix.include`). */
  matrixInclude: Array<Record<string, string>>;
  /**
   * Optional code-path globs this job covers (e.g. `['server/**', 'e2e/**']`).
   * Used only by the flake-recovery classifier (see
   * `server/finalize/flake-recovery.ts`): when a job fails on one fix-loop
   * round and passes on a later round, the recovery is only treated as a real
   * fix if an intervening commit touched one of these paths. A job that
   * recovers with no matching change is flagged as a laundered flake. Omit to
   * fall back to the coarse "any code change counts as a fix" heuristic.
   */
  paths?: string[];
  env?: Record<string, string>;
  steps: CiStepV2[];
}

export interface CiConfigV2 {
  version: 2;
  on: CiTrigger[];
  timeoutMinutes: number;
  env?: Record<string, string>;
  jobs: Record<string, CiJobV2>;
}

export interface JobInstance {
  jobId: string;
  matrixKey: string;
  matrix: Record<string, string>;
  runsOn: string;
  failFast: boolean;
  /** Run to completion (barrier) before non-warmup instances start. */
  warmup: boolean;
  /** Job ids that must complete successfully before this instance runs. */
  needs: string[];
  steps: CiStepV2[];
  /** Merged env: top + job + matrix builtins (not step env). */
  env: Record<string, string>;
}

const V2_TOP_KEYS = new Set(['version', 'on', 'timeout_minutes', 'env', 'jobs']);
const V2_JOB_KEYS = new Set([
  'runs-on',
  'fail-fast',
  'warmup',
  'needs',
  'paths',
  'matrix',
  'env',
  'steps',
]);
const V2_STEP_KEYS = new Set(['name', 'run', 'env']);

export type CiConfigV2ErrorCode =
  | 'missing_jobs'
  | 'invalid_jobs_shape'
  | 'empty_jobs'
  | 'invalid_job_shape'
  | 'unknown_job_key'
  | 'missing_runs_on'
  | 'invalid_runs_on'
  | 'invalid_matrix_shape'
  | 'empty_matrix'
  | 'invalid_matrix_entry'
  | 'invalid_env_shape'
  | 'invalid_env_entry'
  | 'invalid_fail_fast'
  | 'invalid_warmup'
  | 'invalid_needs'
  | 'invalid_paths'
  | 'unknown_needs_job'
  | 'cyclic_needs'
  | 'unknown_top_level_key_v2'
  | 'missing_steps_v2'
  | 'invalid_steps_shape_v2'
  | 'empty_steps_v2'
  | 'invalid_step_shape_v2'
  | 'unknown_step_key_v2'
  | 'missing_step_run_v2'
  | 'invalid_step_run_v2'
  | 'invalid_step_name_v2';

type V2ErrorCode = CiConfigV2ErrorCode | import('./ci-config.js').CiConfigErrorCode;

function err(
  code: V2ErrorCode,
  message: string,
  path?: string,
): { ok: false; error: CiConfigParseError } {
  return {
    ok: false,
    error: path
      ? { code: code as CiConfigParseError['code'], message, path }
      : { code: code as CiConfigParseError['code'], message },
  };
}

function isTrigger(value: string): value is CiTrigger {
  return (SUPPORTED_TRIGGERS as readonly string[]).includes(value);
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return describeType(value);
}

function parseEnvMap(
  raw: unknown,
  path: string,
): { ok: true; env: Record<string, string> } | { ok: false; error: CiConfigParseError } {
  if (raw === null || raw === undefined) {
    return { ok: true, env: {} };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return err(
      'invalid_env_shape',
      `'${path}' must be a mapping of string keys to string values.`,
      path,
    );
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      return err(
        'invalid_env_entry',
        `'${path}.${key}' must be a string; got ${describeValue(value)}.`,
        `${path}.${key}`,
      );
    }
    env[key] = value;
  }
  return { ok: true, env };
}

function parseStepsV2(
  stepsRaw: unknown,
  jobPath: string,
): { ok: true; steps: CiStepV2[] } | { ok: false; error: CiConfigParseError } {
  if (!Array.isArray(stepsRaw)) {
    return err('invalid_steps_shape_v2', `'${jobPath}.steps' must be a list.`, `${jobPath}.steps`);
  }
  if (stepsRaw.length === 0) {
    return err(
      'empty_steps_v2',
      `'${jobPath}.steps' must declare at least one step.`,
      `${jobPath}.steps`,
    );
  }
  const steps: CiStepV2[] = [];
  for (let i = 0; i < stepsRaw.length; i++) {
    const stepPath = `${jobPath}.steps[${i}]`;
    const raw = stepsRaw[i];
    if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
      return err('invalid_step_shape_v2', `'${stepPath}' must be a mapping.`, stepPath);
    }
    const stepObj = raw as Record<string, unknown>;
    for (const key of Object.keys(stepObj)) {
      if (!V2_STEP_KEYS.has(key)) {
        return err(
          'unknown_step_key_v2',
          `Unknown key in '${stepPath}': '${key}' (allowed: ${[...V2_STEP_KEYS].join(', ')}).`,
          `${stepPath}.${key}`,
        );
      }
    }
    if (!('run' in stepObj)) {
      return err('missing_step_run_v2', `'${stepPath}' is missing 'run'.`, `${stepPath}.run`);
    }
    if (typeof stepObj.run !== 'string' || stepObj.run.trim().length === 0) {
      return err(
        'invalid_step_run_v2',
        `'${stepPath}.run' must be a non-empty string.`,
        `${stepPath}.run`,
      );
    }
    let name: string;
    if ('name' in stepObj) {
      if (typeof stepObj.name !== 'string' || stepObj.name.trim().length === 0) {
        return err(
          'invalid_step_name_v2',
          `'${stepPath}.name' must be a non-empty string.`,
          `${stepPath}.name`,
        );
      }
      name = stepObj.name;
    } else {
      name = `step ${i + 1}`;
    }
    let stepEnv: Record<string, string> | undefined;
    if ('env' in stepObj) {
      const parsed = parseEnvMap(stepObj.env, `${stepPath}.env`);
      if (!parsed.ok) return parsed;
      if (Object.keys(parsed.env).length > 0) stepEnv = parsed.env;
    }
    steps.push({ name, run: stepObj.run, ...(stepEnv ? { env: stepEnv } : {}) });
  }
  return { ok: true, steps };
}

function parseMatrixInclude(
  matrixRaw: unknown,
  jobPath: string,
): { ok: true; include: Array<Record<string, string>> } | { ok: false; error: CiConfigParseError } {
  if (matrixRaw === undefined) {
    return { ok: true, include: [{}] };
  }
  if (matrixRaw === null || typeof matrixRaw !== 'object' || Array.isArray(matrixRaw)) {
    return err(
      'invalid_matrix_shape',
      `'${jobPath}.matrix' must be a mapping.`,
      `${jobPath}.matrix`,
    );
  }
  const matrixObj = matrixRaw as Record<string, unknown>;
  if (!('include' in matrixObj)) {
    return err(
      'invalid_matrix_shape',
      `'${jobPath}.matrix' must have an 'include' list.`,
      `${jobPath}.matrix`,
    );
  }
  const includeRaw = matrixObj.include;
  if (!Array.isArray(includeRaw) || includeRaw.length === 0) {
    return err(
      'empty_matrix',
      `'${jobPath}.matrix.include' must be a non-empty list.`,
      `${jobPath}.matrix.include`,
    );
  }
  const include: Array<Record<string, string>> = [];
  for (let i = 0; i < includeRaw.length; i++) {
    const entry = includeRaw[i];
    const entryPath = `${jobPath}.matrix.include[${i}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return err('invalid_matrix_entry', `'${entryPath}' must be a mapping.`, entryPath);
    }
    const row: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        return err(
          'invalid_matrix_entry',
          `'${entryPath}.${key}' must be a string; got ${describeValue(value)}.`,
          `${entryPath}.${key}`,
        );
      }
      row[key] = value;
    }
    include.push(row);
  }
  return { ok: true, include };
}

/**
 * Finalize's default for matrix `fail-fast` when a job omits the key.
 *
 * GitHub Actions defaults matrix fail-fast to TRUE — cancel the sibling shards
 * the instant one fails — to save runner minutes. Finalize's gate has the
 * OPPOSITE priority: the fix agent needs the COMPLETE, accurate failure set to
 * know what to repair. Cancelling siblings on first failure turns "1 real
 * failure" into "1 real failure + N collateral `context canceled` shards"
 * (which even record a misleading non-zero exit code), so the agent can't tell
 * the genuine red from the cascade noise. Finalize therefore defaults fail-fast
 * OFF: every matrix shard runs to completion and reports its true result.
 *
 * Override to restore GHA parity globally with
 * `FINALIZE_MATRIX_FAIL_FAST_DEFAULT=true` (`1`/`on`/`yes` also accepted), or
 * per-job with an explicit `fail-fast: true` in ci.yaml — an explicit value
 * always wins over this default.
 */
export function resolveDefaultMatrixFailFast(): boolean {
  const raw = process.env.FINALIZE_MATRIX_FAIL_FAST_DEFAULT?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

function parseJob(
  jobId: string,
  raw: unknown,
): { ok: true; job: CiJobV2 } | { ok: false; error: CiConfigParseError } {
  const jobPath = `jobs.${jobId}`;
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return err('invalid_job_shape', `'${jobPath}' must be a mapping.`, jobPath);
  }
  const jobObj = raw as Record<string, unknown>;
  for (const key of Object.keys(jobObj)) {
    if (!V2_JOB_KEYS.has(key)) {
      return err('unknown_job_key', `Unknown key in '${jobPath}': '${key}'.`, `${jobPath}.${key}`);
    }
  }
  if (!('runs-on' in jobObj)) {
    return err(
      'missing_runs_on',
      `'${jobPath}' is missing required 'runs-on'.`,
      `${jobPath}.runs-on`,
    );
  }
  if (typeof jobObj['runs-on'] !== 'string' || jobObj['runs-on'].trim().length === 0) {
    return err(
      'invalid_runs_on',
      `'${jobPath}.runs-on' must be a non-empty string.`,
      `${jobPath}.runs-on`,
    );
  }
  let failFast = resolveDefaultMatrixFailFast();
  if ('fail-fast' in jobObj) {
    if (typeof jobObj['fail-fast'] !== 'boolean') {
      return err(
        'invalid_fail_fast',
        `'${jobPath}.fail-fast' must be a boolean.`,
        `${jobPath}.fail-fast`,
      );
    }
    failFast = jobObj['fail-fast'];
  }
  let warmup = false;
  if ('warmup' in jobObj) {
    if (typeof jobObj.warmup !== 'boolean') {
      return err('invalid_warmup', `'${jobPath}.warmup' must be a boolean.`, `${jobPath}.warmup`);
    }
    warmup = jobObj.warmup;
  }
  let needs: string[] = [];
  if ('needs' in jobObj && jobObj.needs !== null && jobObj.needs !== undefined) {
    const rawNeeds = jobObj.needs;
    const list = Array.isArray(rawNeeds) ? rawNeeds : [rawNeeds];
    for (const dep of list) {
      if (typeof dep !== 'string' || dep.trim().length === 0) {
        return err(
          'invalid_needs',
          `'${jobPath}.needs' must be a job id or a list of job ids.`,
          `${jobPath}.needs`,
        );
      }
    }
    needs = [...new Set(list.map((d) => (d as string).trim()))];
  }
  let paths: string[] | undefined;
  if ('paths' in jobObj && jobObj.paths !== null && jobObj.paths !== undefined) {
    const rawPaths = jobObj.paths;
    if (!Array.isArray(rawPaths)) {
      return err(
        'invalid_paths',
        `'${jobPath}.paths' must be a list of path globs.`,
        `${jobPath}.paths`,
      );
    }
    for (const p of rawPaths) {
      if (typeof p !== 'string' || p.trim().length === 0) {
        return err(
          'invalid_paths',
          `'${jobPath}.paths' entries must be non-empty strings.`,
          `${jobPath}.paths`,
        );
      }
    }
    const cleaned = [...new Set(rawPaths.map((p) => (p as string).trim()))];
    if (cleaned.length > 0) paths = cleaned;
  }
  const matrixParsed = parseMatrixInclude(jobObj.matrix, jobPath);
  if (!matrixParsed.ok) return matrixParsed;
  let jobEnv: Record<string, string> | undefined;
  if ('env' in jobObj) {
    const parsed = parseEnvMap(jobObj.env, `${jobPath}.env`);
    if (!parsed.ok) return parsed;
    if (Object.keys(parsed.env).length > 0) jobEnv = parsed.env;
  }
  if (!('steps' in jobObj)) {
    return err('missing_steps_v2', `'${jobPath}' is missing 'steps'.`, `${jobPath}.steps`);
  }
  const stepsParsed = parseStepsV2(jobObj.steps, jobPath);
  if (!stepsParsed.ok) return stepsParsed;
  return {
    ok: true,
    job: {
      runsOn: jobObj['runs-on'].trim(),
      failFast,
      warmup,
      needs,
      matrixInclude: matrixParsed.include,
      ...(paths ? { paths } : {}),
      ...(jobEnv ? { env: jobEnv } : {}),
      steps: stepsParsed.steps,
    },
  };
}

/**
 * Parse a v2 ci.yaml root object (already YAML-parsed).
 */
/**
 * Detect a cycle in the job `needs` graph via DFS. Returns the cycle path
 * (e.g. `['a', 'b', 'a']`) for the error message, or null when acyclic.
 */
function findNeedsCycle(jobs: Record<string, CiJobV2>): string[] | null {
  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  const stack: string[] = [];

  const visit = (jobId: string): string[] | null => {
    state.set(jobId, VISITING);
    stack.push(jobId);
    for (const dep of jobs[jobId]?.needs ?? []) {
      if (!(dep in jobs)) continue; // reference errors handled separately
      const s = state.get(dep);
      if (s === VISITING) {
        return [...stack.slice(stack.indexOf(dep)), dep];
      }
      if (s !== DONE) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(jobId, DONE);
    return null;
  };

  for (const jobId of Object.keys(jobs)) {
    if (state.get(jobId) !== DONE) {
      const found = visit(jobId);
      if (found) return found;
    }
  }
  return null;
}

export function parseCiConfigV2Root(
  root: Record<string, unknown>,
  on: CiTrigger[],
  timeoutMinutes: number,
): CiConfigParseResult {
  for (const key of Object.keys(root)) {
    if (!V2_TOP_KEYS.has(key)) {
      return err('unknown_top_level_key', `Unknown top-level key in ci.yaml v2: '${key}'.`, key);
    }
  }
  if (!('jobs' in root)) {
    return err('missing_jobs', "ci.yaml v2 is missing required 'jobs'.", 'jobs');
  }
  const jobsRaw = root.jobs;
  if (jobsRaw === null || typeof jobsRaw !== 'object' || Array.isArray(jobsRaw)) {
    return err('invalid_jobs_shape', "ci.yaml v2 'jobs' must be a mapping.", 'jobs');
  }
  const jobEntries = Object.entries(jobsRaw as Record<string, unknown>);
  if (jobEntries.length === 0) {
    return err('empty_jobs', "ci.yaml v2 'jobs' must declare at least one job.", 'jobs');
  }
  let topEnv: Record<string, string> | undefined;
  if ('env' in root) {
    const parsed = parseEnvMap(root.env, 'env');
    if (!parsed.ok) return parsed;
    if (Object.keys(parsed.env).length > 0) topEnv = parsed.env;
  }
  const jobs: Record<string, CiJobV2> = {};
  for (const [jobId, jobRaw] of jobEntries) {
    const parsed = parseJob(jobId, jobRaw);
    if (!parsed.ok) return parsed;
    jobs[jobId] = parsed.job;
  }
  // Validate `needs` references now that every job id is known, then check for
  // dependency cycles (which would deadlock the scheduler).
  for (const [jobId, job] of Object.entries(jobs)) {
    for (const dep of job.needs) {
      if (!(dep in jobs)) {
        return err(
          'unknown_needs_job',
          `'jobs.${jobId}.needs' references unknown job '${dep}'.`,
          `jobs.${jobId}.needs`,
        );
      }
      if (dep === jobId) {
        return err(
          'cyclic_needs',
          `'jobs.${jobId}.needs' cannot depend on itself.`,
          `jobs.${jobId}.needs`,
        );
      }
      // A warmup job is an implicit prerequisite of every non-warmup job, so a
      // warmup job that explicitly `needs` a non-warmup job forms a cycle.
      if (job.warmup && !jobs[dep].warmup) {
        return err(
          'cyclic_needs',
          `warmup job '${jobId}' cannot 'needs' non-warmup job '${dep}' ` +
            `(every non-warmup job already waits for warmup jobs).`,
          `jobs.${jobId}.needs`,
        );
      }
    }
  }
  const cyclePath = findNeedsCycle(jobs);
  if (cyclePath) {
    return err(
      'cyclic_needs',
      `ci.yaml v2 'needs' has a dependency cycle: ${cyclePath.join(' → ')}.`,
      'jobs',
    );
  }
  return {
    ok: true,
    config: {
      version: 2,
      on,
      timeoutMinutes,
      ...(topEnv ? { env: topEnv } : {}),
      jobs,
    },
  };
}

/** Build matrix key string for persistence (stable, URL-safe). */
export function matrixKeyFromRow(matrix: Record<string, string>): string {
  const group = matrix.group ?? matrix.name ?? '';
  if (group) return group.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
  return Object.entries(matrix)
    .map(([k, v]) => `${k}=${v}`)
    .join(',')
    .slice(0, 120);
}

/** Expand all jobs × matrix shards into runnable instances. */
export function expandJobInstances(
  config: CiConfigV2,
  builtins: Record<string, string>,
): JobInstance[] {
  const instances: JobInstance[] = [];
  for (const [jobId, job] of Object.entries(config.jobs)) {
    for (const matrixRow of job.matrixInclude) {
      const matrixKey = matrixKeyFromRow(matrixRow);
      const matrixEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(matrixRow)) {
        matrixEnv[`FINALIZE_MATRIX_${k.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`] = v;
      }
      const env: Record<string, string> = {
        ...builtins,
        ...(config.env ?? {}),
        ...(job.env ?? {}),
        ...matrixEnv,
        FINALIZE_JOB_KEY: jobId,
        FINALIZE_MATRIX_KEY: matrixKey,
      };
      instances.push({
        jobId,
        matrixKey,
        matrix: matrixRow,
        runsOn: job.runsOn,
        failFast: job.failFast,
        warmup: job.warmup,
        needs: job.needs,
        steps: job.steps,
        env,
      });
    }
  }
  return instances;
}

/** Substitute ${VAR} and $VAR in shell strings from env map. */
export function substituteEnvString(template: string, env: Record<string, string>): string {
  return template.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced, bare) => {
      const key = braced ?? bare;
      if (key in env) return env[key];
      return match;
    },
  );
}

/** Matches a still-unresolved `${VAR}` placeholder left by substituteEnvString. */
const UNRESOLVED_PLACEHOLDER_RE = /\$\{[^}]+\}/;

export function applyEnvToStep(step: CiStepV2, env: Record<string, string>): CiStepV2 {
  const stepEnv = step.env ?? {};
  const merged = { ...env };
  const resolvedStepEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(stepEnv)) {
    const resolved = substituteEnvString(v, merged);
    merged[k] = resolved;
    // Only export values that fully resolved. A leftover `${VAR}` means the
    // referenced var wasn't in scope here (e.g. a project secret injected only
    // into the runner container's env, not the substitution map). Exporting the
    // literal would clobber the real value the container already carries — so
    // drop it and let the container env win, matching pre-export behavior.
    if (!UNRESOLVED_PLACEHOLDER_RE.test(resolved)) {
      resolvedStepEnv[k] = resolved;
    }
  }
  return {
    name: substituteEnvString(step.name, merged),
    run: substituteEnvString(step.run, merged),
    ...(Object.keys(resolvedStepEnv).length > 0 ? { env: resolvedStepEnv } : {}),
  };
}

export function buildFinalizeBuiltinEnv(opts: {
  branch: string;
  headSha: string;
}): Record<string, string> {
  return {
    FINALIZE_BRANCH: opts.branch,
    FINALIZE_HEAD_SHA: opts.headSha,
    GIT_BRANCH: opts.branch,
    GIT_COMMIT_SHA: opts.headSha,
  };
}

export {
  FINALIZE_TIMEOUT_DEFAULT_MINUTES,
  FINALIZE_TIMEOUT_MAX_MINUTES,
  FINALIZE_TIMEOUT_MIN_MINUTES,
};
