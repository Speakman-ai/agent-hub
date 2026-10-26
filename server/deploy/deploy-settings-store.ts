/**
 * Deploy configuration saved from the Deployments settings UI.
 *
 * Once a project saves settings here they REPLACE `.agent-hub/deploy.yaml`
 * entirely: the environments (steps, approval gate, runner, timeout, origin,
 * readiness) and the `preview:` block that PR environments boot from. The
 * file is not read at all while settings exist. A project with no saved
 * settings keeps reading deploy.yaml unchanged.
 *
 * Settings are stored in the deploy.yaml wire shape (`runs-on`,
 * `timeout_minutes`, `github_workflow`, …) and validated with the same parsers,
 * so anything the file would reject is rejected here too.
 */
import { getDb } from '../db.js';
import {
  DeployConfigError,
  parseDeployEnvironments,
  type DeployConfig,
  type DeployEnvironmentConfig,
} from './deploy-config.js';
import { parsePreviewConfig, type PreviewConfig } from './deploy-preview-config.js';

/** Wire-shape environments map, as saved and as edited by the UI. */
export type DeployEnvironmentsDocument = Record<string, Record<string, unknown>>;

export interface StoredDeploySettings {
  projectId: string;
  /** Raw wire-shape map, for the editor. */
  document: DeployEnvironmentsDocument;
  /** Parsed, validated environments, for the deploy paths. */
  environments: Map<string, DeployEnvironmentConfig>;
  /** Raw wire-shape `preview:` block, or null for no PR environments. */
  previewDocument: Record<string, unknown> | null;
  /** Parsed `preview:` block, or null. */
  preview: PreviewConfig | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SettingsRow {
  project_id: string;
  environments: string;
  preview: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

function readRow(projectId: string): SettingsRow | null {
  return (
    (getDb()
      .prepare('SELECT * FROM deployment_project_settings WHERE project_id = ?')
      .get(projectId) as SettingsRow | undefined) ?? null
  );
}

/**
 * The project's saved deploy environments, or null when it has never saved any.
 * Throws {@link DeployConfigError} (`invalid_settings`) when the stored value no
 * longer validates, so a deploy fails loudly instead of quietly falling back to
 * deploy.yaml.
 */
export function getDeploySettings(projectId: string): StoredDeploySettings | null {
  const row = readRow(projectId);
  if (!row) return null;
  let document: DeployEnvironmentsDocument;
  let previewDocument: Record<string, unknown> | null;
  try {
    document = JSON.parse(row.environments) as DeployEnvironmentsDocument;
    previewDocument = row.preview ? (JSON.parse(row.preview) as Record<string, unknown>) : null;
  } catch {
    throw new DeployConfigError(
      'invalid_settings',
      'Saved deployment settings are corrupt. Re-save them from the Deployments settings.',
    );
  }
  let environments: Map<string, DeployEnvironmentConfig>;
  let preview: PreviewConfig | null;
  try {
    environments = parseDeployEnvironments(document);
    preview = previewDocument ? parsePreviewConfig(previewDocument) : null;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new DeployConfigError('invalid_settings', `Saved deployment settings: ${detail}`);
  }
  return {
    projectId: row.project_id,
    document,
    environments,
    previewDocument,
    preview,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function hasDeploySettings(projectId: string): boolean {
  return readRow(projectId) !== null;
}

/**
 * Validate and save a project's deploy environments and `preview:` block
 * (null = no PR environments). Throws {@link DeployConfigError} with the
 * parser's reason on invalid input; nothing is written in that case.
 */
export function saveDeploySettings(
  projectId: string,
  document: unknown,
  preview: unknown,
  updatedBy: string | null,
): StoredDeploySettings {
  parseDeployEnvironments(document);
  if (preview !== null && preview !== undefined) parsePreviewConfig(preview);
  getDb()
    .prepare(
      `INSERT INTO deployment_project_settings (project_id, environments, preview, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         environments = excluded.environments,
         preview = excluded.preview,
         updated_by = excluded.updated_by,
         updated_at = datetime('now')`,
    )
    .run(
      projectId,
      JSON.stringify(document),
      preview === null || preview === undefined ? null : JSON.stringify(preview),
      updatedBy,
    );
  return getDeploySettings(projectId) as StoredDeploySettings;
}

/** Drop the saved settings so the project reads environments from deploy.yaml again. */
export function deleteDeploySettings(projectId: string): boolean {
  return (
    getDb().prepare('DELETE FROM deployment_project_settings WHERE project_id = ?').run(projectId)
      .changes > 0
  );
}

/** Saved settings as a deploy config, or null when the project has none. */
export function storedDeployConfig(projectId: string): DeployConfig | null {
  const settings = getDeploySettings(projectId);
  if (!settings) return null;
  return { version: 1, environments: settings.environments, preview: settings.preview };
}

/**
 * Load a project's effective deploy config: saved settings when present
 * (deploy.yaml is then not read at all), else `loadRepo()` with its errors
 * propagated unchanged.
 */
export async function loadEffectiveDeployConfig(
  projectId: string,
  loadRepo: () => Promise<DeployConfig>,
): Promise<DeployConfig> {
  return storedDeployConfig(projectId) ?? loadRepo();
}

/** Inverse of the parser: a parsed environment back to the editable wire shape. */
export function environmentToDocument(env: DeployEnvironmentConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {
    approval: env.approval,
    'runs-on': env.runsOn,
    timeout_minutes: env.timeoutMinutes,
  };
  if (env.origin) out.origin = env.origin;
  if (env.readiness) out.readiness = env.readiness;
  out.steps = env.steps.map((step) => {
    if (!step.githubWorkflow) return { name: step.name, run: step.run };
    const gw = step.githubWorkflow;
    const spec: Record<string, unknown> = { workflow: gw.workflow, ref: gw.ref };
    if (gw.inputs && Object.keys(gw.inputs).length > 0) spec.inputs = gw.inputs;
    if (gw.pollIntervalSeconds !== undefined) spec.poll_interval_seconds = gw.pollIntervalSeconds;
    return { name: step.name, github_workflow: spec };
  });
  return out;
}

export function environmentsToDocument(
  environments: Map<string, DeployEnvironmentConfig>,
): DeployEnvironmentsDocument {
  // Null prototype: environment names are user-supplied, and a name such as
  // `__proto__` must become an own key rather than replace the prototype.
  const doc = Object.create(null) as DeployEnvironmentsDocument;
  for (const [name, env] of environments) doc[name] = environmentToDocument(env);
  return doc;
}

/** Inverse of the preview parser: a parsed `preview:` block back to the wire shape. */
export function previewToDocument(preview: PreviewConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {
    compose: preview.compose,
    service: preview.service,
    port: preview.port,
    health: preview.health,
    health_timeout_minutes: preview.healthTimeoutMinutes,
  };
  if (preview.steps.length > 0) {
    out.steps = preview.steps.map((step) => ({ name: step.name, run: step.run }));
  }
  if (preview.secrets.length > 0) out.secrets = [...preview.secrets];
  return out;
}
