/**
 * Form model for the Deployments settings editor (web + mobile).
 *
 * The server stores environments in the deploy.yaml wire shape (`runs-on`,
 * `timeout_minutes`, `github_workflow`, …). These helpers convert that document
 * to flat, string-valued form state and back, and catch the mistakes a form can
 * make before the request goes out. The server re-validates with the same rules
 * as deploy.yaml, so this is a convenience check, not the source of truth.
 */

export type DeploySettingsSource = 'settings' | 'repo' | 'none';

export interface DeploySettingsResponse {
  projectId: string;
  source: DeploySettingsSource;
  environments: Record<string, Record<string, unknown>>;
  /** deploy.yaml `preview:` wire shape (PR environments), or null when there is none. */
  preview: Record<string, unknown> | null;
  updatedAt: string | null;
  updatedBy: string | null;
  repoError: string | null;
}

export type DeployStepKind = 'run' | 'github_workflow';

export interface DeployWorkflowInputForm {
  key: string;
  value: string;
}

export interface DeployStepForm {
  kind: DeployStepKind;
  name: string;
  run: string;
  workflow: string;
  ref: string;
  /** One row per `workflow_dispatch` input. Values are kept verbatim (no trimming). */
  inputs: DeployWorkflowInputForm[];
  pollIntervalSeconds: string;
}

export interface DeployEnvironmentForm {
  name: string;
  approval: boolean;
  runsOn: string;
  timeoutMinutes: string;
  origin: string;
  readiness: string;
  steps: DeployStepForm[];
}

export const DEPLOY_DEFAULT_RUNS_ON = 'ubuntu-24.04';
export const DEPLOY_DEFAULT_TIMEOUT_MINUTES = 60;
export const DEPLOY_TIMEOUT_MAX_MINUTES = 240;

export function emptyDeployStep(kind: DeployStepKind = 'run'): DeployStepForm {
  return {
    kind,
    name: '',
    run: '',
    workflow: '',
    ref: 'main',
    inputs: [],
    pollIntervalSeconds: '',
  };
}

export function emptyDeployEnvironment(name = ''): DeployEnvironmentForm {
  return {
    name,
    approval: false,
    runsOn: DEPLOY_DEFAULT_RUNS_ON,
    timeoutMinutes: String(DEPLOY_DEFAULT_TIMEOUT_MINUTES),
    origin: '',
    readiness: '',
    steps: [emptyDeployStep()],
  };
}

/**
 * Dictionary keyed by user-supplied names (environments, workflow inputs).
 * Null prototype so `__proto__` is stored as an own key and names such as
 * `constructor` never match inherited properties.
 */
function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function str(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value);
}

function stepToForm(raw: unknown): DeployStepForm {
  const step = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const gw = step.github_workflow as Record<string, unknown> | undefined;
  if (gw && typeof gw === 'object') {
    const inputs = (gw.inputs && typeof gw.inputs === 'object' ? gw.inputs : {}) as Record<
      string,
      unknown
    >;
    return {
      kind: 'github_workflow',
      name: str(step.name),
      run: '',
      workflow: str(gw.workflow),
      ref: str(gw.ref),
      inputs: Object.entries(inputs).map(([key, value]) => ({ key, value: str(value) })),
      pollIntervalSeconds: str(gw.poll_interval_seconds),
    };
  }
  return { ...emptyDeployStep('run'), name: str(step.name), run: str(step.run), ref: '' };
}

export function deployDocumentToForm(
  doc: Record<string, Record<string, unknown>> | null | undefined,
): DeployEnvironmentForm[] {
  return Object.entries(doc ?? {}).map(([name, env]) => ({
    name,
    approval: env.approval === true,
    runsOn: str(env['runs-on']) || DEPLOY_DEFAULT_RUNS_ON,
    timeoutMinutes: str(env.timeout_minutes) || String(DEPLOY_DEFAULT_TIMEOUT_MINUTES),
    origin: str(env.origin),
    readiness: str(env.readiness),
    steps: Array.isArray(env.steps) ? env.steps.map(stepToForm) : [],
  }));
}

function inputsToDocument(
  rows: DeployWorkflowInputForm[],
  where: string,
  errors: string[],
): Record<string, string> {
  const out = dict<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) {
      if (row.value !== '') errors.push(`${where}: a workflow input has a value but no name.`);
      continue;
    }
    if (hasOwn(out, key)) errors.push(`${where}: workflow input "${key}" is listed twice.`);
    out[key] = row.value;
  }
  return out;
}

export interface DeployFormResult {
  document: Record<string, Record<string, unknown>>;
  errors: string[];
}

/** Form state → wire document, plus every problem found. Send only when `errors` is empty. */
export function deployFormToDocument(envs: DeployEnvironmentForm[]): DeployFormResult {
  const errors: string[] = [];
  const document = dict<Record<string, unknown>>();
  envs.forEach((env, envIndex) => {
    const name = env.name.trim();
    const label = name ? `"${name}"` : `Environment ${envIndex + 1}`;
    if (!name) errors.push(`${label}: name is required.`);
    else if (hasOwn(document, name)) errors.push(`${label}: duplicate environment name.`);

    const out: Record<string, unknown> = { approval: env.approval };
    out['runs-on'] = env.runsOn.trim() || DEPLOY_DEFAULT_RUNS_ON;

    const timeoutText = env.timeoutMinutes.trim();
    if (timeoutText) {
      const timeout = Number(timeoutText);
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > DEPLOY_TIMEOUT_MAX_MINUTES) {
        errors.push(
          `${label}: timeout must be a whole number of minutes from 1 to ${DEPLOY_TIMEOUT_MAX_MINUTES}.`,
        );
      } else {
        out.timeout_minutes = timeout;
      }
    }
    if (env.origin.trim()) out.origin = env.origin.trim();
    if (env.readiness.trim()) out.readiness = env.readiness.trim();

    if (env.steps.length === 0) errors.push(`${label}: add at least one step.`);
    out.steps = env.steps.map((step, stepIndex) => {
      const where = `${label} step ${stepIndex + 1}`;
      const stepOut: Record<string, unknown> = {};
      if (step.name.trim()) stepOut.name = step.name.trim();
      if (step.kind === 'github_workflow') {
        if (!step.workflow.trim()) errors.push(`${where}: workflow is required.`);
        if (!step.ref.trim()) errors.push(`${where}: branch or tag is required.`);
        const spec: Record<string, unknown> = {
          workflow: step.workflow.trim(),
          ref: step.ref.trim(),
        };
        const inputs = inputsToDocument(step.inputs, where, errors);
        if (Object.keys(inputs).length > 0) spec.inputs = inputs;
        const poll = step.pollIntervalSeconds.trim();
        if (poll) {
          const n = Number(poll);
          if (!Number.isInteger(n)) errors.push(`${where}: poll interval must be a whole number.`);
          else spec.poll_interval_seconds = n;
        }
        stepOut.github_workflow = spec;
      } else {
        if (!step.run.trim()) errors.push(`${where}: command is required.`);
        stepOut.run = step.run;
      }
      return stepOut;
    });

    if (name && !hasOwn(document, name)) document[name] = out;
  });
  return { document, errors };
}

export function deploySettingsSourceLabel(source: DeploySettingsSource): string {
  if (source === 'settings') return 'Saved in settings';
  if (source === 'repo') return 'Read from .agent-hub/deploy.yaml';
  return 'Not configured';
}

export interface DeployPreviewStepForm {
  name: string;
  run: string;
}

/** PR environment (`preview:` block) form. `enabled: false` saves no preview block. */
export interface DeployPreviewForm {
  enabled: boolean;
  compose: string;
  service: string;
  port: string;
  health: string;
  healthTimeoutMinutes: string;
  steps: DeployPreviewStepForm[];
  /** Preview-secret names, one per row. */
  secrets: string[];
}

export const PREVIEW_DEFAULT_HEALTH_TIMEOUT_MINUTES = 5;
export const PREVIEW_MAX_HEALTH_TIMEOUT_MINUTES = 60;

export function emptyDeployPreview(): DeployPreviewForm {
  return {
    enabled: false,
    compose: '',
    service: '',
    port: '',
    health: '/',
    healthTimeoutMinutes: String(PREVIEW_DEFAULT_HEALTH_TIMEOUT_MINUTES),
    steps: [],
    secrets: [],
  };
}

export function previewDocumentToForm(
  doc: Record<string, unknown> | null | undefined,
): DeployPreviewForm {
  if (!doc) return emptyDeployPreview();
  const steps = Array.isArray(doc.steps) ? doc.steps : [];
  const secrets = Array.isArray(doc.secrets) ? doc.secrets : [];
  return {
    enabled: true,
    compose: str(doc.compose),
    service: str(doc.service),
    port: str(doc.port),
    health: str(doc.health) || '/',
    healthTimeoutMinutes:
      str(doc.health_timeout_minutes) || String(PREVIEW_DEFAULT_HEALTH_TIMEOUT_MINUTES),
    steps: steps.map((raw) => {
      const step = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      return { name: str(step.name), run: str(step.run) };
    }),
    secrets: secrets.map(str),
  };
}

export interface DeployPreviewFormResult {
  preview: Record<string, unknown> | null;
  errors: string[];
}

/** Preview form → `preview:` wire shape (null when disabled), plus every problem found. */
export function previewFormToDocument(form: DeployPreviewForm): DeployPreviewFormResult {
  const errors: string[] = [];
  if (!form.enabled) return { preview: null, errors };
  const label = 'PR environments';
  const out: Record<string, unknown> = {};
  if (!form.compose.trim()) errors.push(`${label}: compose file is required.`);
  out.compose = form.compose.trim();
  if (!form.service.trim()) errors.push(`${label}: service is required.`);
  out.service = form.service.trim();
  const port = Number(form.port.trim());
  if (!form.port.trim() || !Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push(`${label}: port must be a whole number from 1 to 65535.`);
  } else {
    out.port = port;
  }
  if (form.health.trim()) out.health = form.health.trim();
  const timeoutText = form.healthTimeoutMinutes.trim();
  if (timeoutText) {
    const timeout = Number(timeoutText);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > PREVIEW_MAX_HEALTH_TIMEOUT_MINUTES) {
      errors.push(
        `${label}: health timeout must be a whole number of minutes from 1 to ${PREVIEW_MAX_HEALTH_TIMEOUT_MINUTES}.`,
      );
    } else {
      out.health_timeout_minutes = timeout;
    }
  }
  if (form.steps.length > 0) {
    out.steps = form.steps.map((step, i) => {
      if (!step.run.trim()) errors.push(`${label} step ${i + 1}: command is required.`);
      return step.name.trim() ? { name: step.name.trim(), run: step.run } : { run: step.run };
    });
  }
  const secrets = form.secrets.map((name) => name.trim()).filter(Boolean);
  if (secrets.length > 0) out.secrets = secrets;
  return { preview: out, errors };
}
