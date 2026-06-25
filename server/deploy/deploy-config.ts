/**
 * deploy-config.ts — `.agent-hub/deploy.yaml` parser for the Deployment Module.
 *
 * A project declares one or more deploy ENVIRONMENTS (dev / staging /
 * production / …); each environment is an ordered list of shell `steps:` that
 * the Phase 3 orchestrator runs inside a RunnerBackend lease (one
 * `bash -euo pipefail -c <run>` per step, fail-fast on the first non-zero exit).
 *
 * Wire format (v1):
 *
 *   version: 1
 *   environments:
 *     dev:
 *       steps:
 *         - name: build
 *           run: ./scripts/build.sh
 *         - run: ./scripts/deploy-dev.sh        # name defaults to "step 2"
 *     production:
 *       approval: true                           # gated (Admin/Owner must approve)
 *       runs-on: ubuntu-24.04                     # optional; default ubuntu-24.04
 *       timeout_minutes: 60                       # optional per-env step budget
 *       steps:
 *         - run: ./scripts/deploy-prod.sh
 *
 * Hard constraints (mirroring the `ci-config.ts` v1 contract so the two
 * pipelines stay legible to the same authors):
 *
 *   - `version` must be `1`. Any other value is `invalid_version`.
 *   - `environments` is a required, non-empty map. Each key is an environment
 *     name; the value is the environment block.
 *   - `steps[].run` is required and executed verbatim under
 *     {@link DEPLOY_STEP_SHELL}. There is no `shell:` override at v1.
 *   - `steps[].name` is optional and defaults to `step <index>` (1-indexed).
 *   - `approval` is an optional boolean (default false). When true the
 *     environment is GATED — an Admin/Owner approval is required before the
 *     orchestrator runs the steps (epic decision `approval-auth`; the gate
 *     itself is wired in a later phase, the parser only surfaces the flag).
 *   - `runs-on` is an optional runner label (default `ubuntu-24.04`).
 *   - `timeout_minutes` is optional (floor 1, ceiling 4h). The config may LOWER
 *     the runtime cap but never raise it.
 *   - Unknown top-level / environment / step keys are HARD ERRORS — we never
 *     silently drop a directive an author believed they enabled.
 *
 * Everything here is PURE (string in → validated object out); IO (reading the
 * file off disk) is the thin {@link loadDeployConfig} wrapper so the parser is
 * trivially unit-testable.
 */
import { promises as fs } from 'fs';
import { parse as parseYaml, YAMLParseError } from 'yaml';

/** Shell prefix the orchestrator uses to execute every `run` step. Matches Finalize. */
export const DEPLOY_STEP_SHELL = 'bash -euo pipefail -c';

/** Default runner label when an environment omits `runs-on`. */
export const DEPLOY_DEFAULT_RUNS_ON = 'ubuntu-24.04';

/** Hard ceiling on `timeout_minutes` (4 hours), matching the Finalize budget ceiling. */
export const DEPLOY_TIMEOUT_MAX_MINUTES = 4 * 60;

/** Floor on `timeout_minutes`. A zero/negative budget is meaningless. */
export const DEPLOY_TIMEOUT_MIN_MINUTES = 1;

/** Default per-environment step budget when `timeout_minutes` is omitted. */
export const DEPLOY_TIMEOUT_DEFAULT_MINUTES = 60;

const SUPPORTED_TOP_LEVEL_KEYS = new Set(['version', 'environments']);
const SUPPORTED_ENV_KEYS = new Set(['approval', 'runs-on', 'timeout_minutes', 'steps']);
const SUPPORTED_STEP_KEYS = new Set(['name', 'run']);

export interface DeployStep {
  /** Step display name; defaults to `step <index>` (1-indexed) when omitted. */
  name: string;
  /** Shell command, executed verbatim under `bash -euo pipefail -c <run>`. */
  run: string;
}

export interface DeployEnvironmentConfig {
  /** Environment name (the map key). */
  name: string;
  /** Gated environment — requires Admin/Owner approval before steps run. */
  approval: boolean;
  /** Runner label for the RunnerBackend lease (default `ubuntu-24.04`). */
  runsOn: string;
  /** Resolved per-environment step budget in minutes (default 60). */
  timeoutMinutes: number;
  /** Ordered steps (at least one). */
  steps: DeployStep[];
}

export interface DeployConfig {
  version: 1;
  /** Environment name → config. Insertion order preserved from the YAML map. */
  environments: Map<string, DeployEnvironmentConfig>;
}

/**
 * Thrown on any validation failure. `reason` is a stable machine code so the
 * REST layer (Phase 5) can map specific failures to specific HTTP responses
 * and the UI can render a deterministic message.
 */
export class DeployConfigError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'DeployConfigError';
    this.reason = reason;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  where: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new DeployConfigError(
        'unknown_key',
        `${where}: unknown key "${key}". Allowed: ${[...allowed].join(', ')}.`,
      );
    }
  }
}

function parseStep(raw: unknown, index: number, envName: string): DeployStep {
  const where = `environment "${envName}" step ${index}`;
  if (!isPlainObject(raw)) {
    throw new DeployConfigError('invalid_step', `${where}: each step must be a mapping.`);
  }
  rejectUnknownKeys(raw, SUPPORTED_STEP_KEYS, where);

  const { run, name } = raw;
  if (typeof run !== 'string' || run.trim() === '') {
    throw new DeployConfigError(
      'missing_run',
      `${where}: "run" is required and must be a non-empty string.`,
    );
  }
  if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
    throw new DeployConfigError(
      'invalid_name',
      `${where}: "name", when present, must be a non-empty string.`,
    );
  }
  return { name: typeof name === 'string' ? name : `step ${index}`, run };
}

function parseTimeoutMinutes(raw: unknown, envName: string): number {
  if (raw === undefined) return DEPLOY_TIMEOUT_DEFAULT_MINUTES;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new DeployConfigError(
      'invalid_timeout',
      `environment "${envName}": "timeout_minutes" must be an integer.`,
    );
  }
  if (raw < DEPLOY_TIMEOUT_MIN_MINUTES || raw > DEPLOY_TIMEOUT_MAX_MINUTES) {
    throw new DeployConfigError(
      'invalid_timeout',
      `environment "${envName}": "timeout_minutes" must be between ${DEPLOY_TIMEOUT_MIN_MINUTES} and ${DEPLOY_TIMEOUT_MAX_MINUTES}.`,
    );
  }
  return raw;
}

function parseEnvironment(name: string, raw: unknown): DeployEnvironmentConfig {
  if (!isPlainObject(raw)) {
    throw new DeployConfigError('invalid_environment', `environment "${name}": must be a mapping.`);
  }
  rejectUnknownKeys(raw, SUPPORTED_ENV_KEYS, `environment "${name}"`);

  const { approval, steps } = raw;
  const runsOnRaw = raw['runs-on'];

  if (approval !== undefined && typeof approval !== 'boolean') {
    throw new DeployConfigError(
      'invalid_approval',
      `environment "${name}": "approval" must be a boolean.`,
    );
  }
  if (runsOnRaw !== undefined && (typeof runsOnRaw !== 'string' || runsOnRaw.trim() === '')) {
    throw new DeployConfigError(
      'invalid_runs_on',
      `environment "${name}": "runs-on" must be a non-empty string.`,
    );
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new DeployConfigError(
      'missing_steps',
      `environment "${name}": "steps" is required and must be a non-empty list.`,
    );
  }

  return {
    name,
    approval: approval === true,
    runsOn: typeof runsOnRaw === 'string' ? runsOnRaw.trim() : DEPLOY_DEFAULT_RUNS_ON,
    timeoutMinutes: parseTimeoutMinutes(raw['timeout_minutes'], name),
    steps: steps.map((step, i) => parseStep(step, i + 1, name)),
  };
}

/**
 * Parse + validate a deploy.yaml document. Throws {@link DeployConfigError} with
 * a stable `reason` on any malformed input.
 */
export function parseDeployConfig(rawYaml: string): DeployConfig {
  let doc: unknown;
  try {
    doc = parseYaml(rawYaml);
  } catch (err) {
    const detail = err instanceof YAMLParseError ? err.message : String(err);
    throw new DeployConfigError('invalid_yaml', `deploy.yaml is not valid YAML: ${detail}`);
  }

  if (!isPlainObject(doc)) {
    throw new DeployConfigError('invalid_root', 'deploy.yaml must be a top-level mapping.');
  }
  rejectUnknownKeys(doc, SUPPORTED_TOP_LEVEL_KEYS, 'deploy.yaml');

  if (doc.version !== 1) {
    throw new DeployConfigError(
      'invalid_version',
      `deploy.yaml: unsupported version ${JSON.stringify(doc.version)} — only version 1 is supported.`,
    );
  }

  const envsRaw = doc.environments;
  if (!isPlainObject(envsRaw) || Object.keys(envsRaw).length === 0) {
    throw new DeployConfigError(
      'missing_environments',
      'deploy.yaml: "environments" is required and must be a non-empty mapping.',
    );
  }

  const environments = new Map<string, DeployEnvironmentConfig>();
  for (const [envName, envRaw] of Object.entries(envsRaw)) {
    if (envName.trim() === '') {
      throw new DeployConfigError(
        'invalid_environment',
        'deploy.yaml: environment names must be non-empty.',
      );
    }
    environments.set(envName, parseEnvironment(envName, envRaw));
  }

  return { version: 1, environments };
}

/**
 * Resolve a single environment block from a parsed config. Throws
 * {@link DeployConfigError} (`unknown_environment`) when the name is absent so
 * the orchestrator/REST layer can map it to a 404.
 */
export function resolveDeployEnvironment(
  config: DeployConfig,
  environment: string,
): DeployEnvironmentConfig {
  const env = config.environments.get(environment);
  if (!env) {
    const known = [...config.environments.keys()].join(', ') || '(none)';
    throw new DeployConfigError(
      'unknown_environment',
      `deploy.yaml: no environment "${environment}". Declared: ${known}.`,
    );
  }
  return env;
}

/** Read + parse `.agent-hub/deploy.yaml` from a worktree root. */
export async function loadDeployConfig(deployYamlPath: string): Promise<DeployConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(deployYamlPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new DeployConfigError('not_found', `deploy.yaml not found at ${deployYamlPath}.`);
    }
    throw new DeployConfigError('read_error', `failed to read ${deployYamlPath}: ${String(err)}`);
  }
  return parseDeployConfig(raw);
}
