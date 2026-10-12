/**
 * `preview:` block of `.agent-hub/deploy.yaml`: what a PR environment boots.
 *
 * Session previews run `prEnv.devServer` (a dev server with HMR) for the agent
 * and the operator. A PR environment is what an end user clicks, so it boots
 * the project's own compose stack instead:
 *
 *   preview:
 *     compose: docker-compose.preview.yml   # repo-relative compose file
 *     service: app                          # service whose port is exposed
 *     port: 3000                            # container port on that service
 *     health: /healthz                      # optional, default "/"
 *     steps:                                # optional, run after `compose up`
 *       - name: migrate
 *         run: docker compose exec -T app npm run db:migrate
 *     secrets:                              # optional, by name from the
 *       - DATABASE_PASSWORD                 # project preview secrets store
 *
 * Parsing is pure. Secret names are checked for shape here; whether they
 * exist in the store is checked by `deploy-preview-secrets.ts`, which needs
 * the DB.
 */
import path from 'node:path';
import { DeployConfigError } from './deploy-config-error.js';
import { isReservedEnvKey } from '../preview/reserved-env-keys.js';

export const PREVIEW_DEFAULT_HEALTH_PATH = '/';

const SUPPORTED_PREVIEW_KEYS = new Set([
  'compose',
  'service',
  'port',
  'health',
  'steps',
  'secrets',
]);
const SUPPORTED_PREVIEW_STEP_KEYS = new Set(['name', 'run']);
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface PreviewStep {
  /** Display name; defaults to `step <index>` (1-indexed). */
  name: string;
  /** Shell command run in the checkout after `docker compose up` succeeds. */
  run: string;
}

export interface PreviewConfig {
  /** Compose file path, relative to the repo root, normalized with `/`. */
  compose: string;
  /** Compose service whose container port is exposed to the user. */
  service: string;
  /** Container port on {@link PreviewConfig.service}. */
  port: number;
  /** Health probe path on the exposed port. */
  health: string;
  /** Build/seed steps run in order after `compose up`. */
  steps: PreviewStep[];
  /** Preview-secret names injected as env. Values are resolved at boot. */
  secrets: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: Set<string>, where: string) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new DeployConfigError(
        'unknown_key',
        `${where}: unknown key "${key}". Allowed: ${[...allowed].join(', ')}.`,
      );
    }
  }
}

function parseComposePath(raw: unknown): string {
  if (raw === undefined || raw === null) {
    throw new DeployConfigError(
      'missing_preview_compose',
      'preview: "compose" is required and must name the compose file to boot.',
    );
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new DeployConfigError(
      'invalid_preview_compose',
      'preview: "compose" must be a non-empty repo-relative path.',
    );
  }
  const trimmed = raw.trim();
  if (path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) {
    throw new DeployConfigError(
      'invalid_preview_compose',
      'preview: "compose" must be relative to the repo root, not absolute.',
    );
  }
  const normalized = path.posix.normalize(trimmed.replace(/\\/g, '/'));
  if (normalized === '..' || normalized.startsWith('../') || normalized === '.') {
    throw new DeployConfigError(
      'invalid_preview_compose',
      'preview: "compose" must point at a file inside the repo.',
    );
  }
  return normalized;
}

function parseService(raw: unknown): string {
  if (raw === undefined || raw === null) {
    throw new DeployConfigError(
      'missing_preview_service',
      'preview: "service" is required and must name the compose service to expose.',
    );
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new DeployConfigError(
      'invalid_preview_service',
      'preview: "service" must be a non-empty string.',
    );
  }
  return raw.trim();
}

function parsePort(raw: unknown): number {
  if (raw === undefined || raw === null) {
    throw new DeployConfigError(
      'missing_preview_port',
      'preview: "port" is required and must be the container port of "service".',
    );
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 65535) {
    throw new DeployConfigError(
      'invalid_preview_port',
      'preview: "port" must be an integer between 1 and 65535.',
    );
  }
  return raw;
}

function parseHealth(raw: unknown): string {
  if (raw === undefined || raw === null) return PREVIEW_DEFAULT_HEALTH_PATH;
  if (typeof raw !== 'string' || !raw.trim().startsWith('/')) {
    throw new DeployConfigError(
      'invalid_preview_health',
      'preview: "health" must be a path starting with "/".',
    );
  }
  return raw.trim();
}

function parseStep(raw: unknown, index: number): PreviewStep {
  const where = `preview step ${index}`;
  if (!isPlainObject(raw)) {
    throw new DeployConfigError('invalid_step', `${where}: each step must be a mapping.`);
  }
  rejectUnknownKeys(raw, SUPPORTED_PREVIEW_STEP_KEYS, where);
  const { name, run } = raw;
  if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
    throw new DeployConfigError(
      'invalid_name',
      `${where}: "name", when present, must be a non-empty string.`,
    );
  }
  if (typeof run !== 'string' || run.trim() === '') {
    throw new DeployConfigError(
      'missing_run',
      `${where}: "run" is required and must be a non-empty string.`,
    );
  }
  return { name: typeof name === 'string' ? name : `step ${index}`, run };
}

function parseSteps(raw: unknown): PreviewStep[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new DeployConfigError('invalid_preview_steps', 'preview: "steps" must be a list.');
  }
  return raw.map((step, i) => parseStep(step, i + 1));
}

function parseSecrets(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new DeployConfigError(
      'invalid_preview_secrets',
      'preview: "secrets" must be a list of preview secret names.',
    );
  }
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string' || !SECRET_NAME_RE.test(entry)) {
      throw new DeployConfigError(
        'invalid_preview_secrets',
        `preview: secret name ${JSON.stringify(entry)} must be an env var name ([A-Za-z_][A-Za-z0-9_]*).`,
      );
    }
    if (isReservedEnvKey(entry)) {
      throw new DeployConfigError(
        'invalid_preview_secrets',
        `preview: secret "${entry}" is in the reserved namespace (AGENT_HUB_*, NODE_*, PATH, HOME).`,
      );
    }
    if (seen.has(entry)) {
      throw new DeployConfigError(
        'invalid_preview_secrets',
        `preview: secret "${entry}" is listed more than once.`,
      );
    }
    seen.add(entry);
  }
  return [...seen];
}

/** Parse the `preview:` mapping. Throws {@link DeployConfigError} on bad input. */
export function parsePreviewConfig(raw: unknown): PreviewConfig {
  if (!isPlainObject(raw)) {
    throw new DeployConfigError('invalid_preview', 'preview: must be a mapping.');
  }
  rejectUnknownKeys(raw, SUPPORTED_PREVIEW_KEYS, 'preview');
  return {
    compose: parseComposePath(raw.compose),
    service: parseService(raw.service),
    port: parsePort(raw.port),
    health: parseHealth(raw.health),
    steps: parseSteps(raw.steps),
    secrets: parseSecrets(raw.secrets),
  };
}
