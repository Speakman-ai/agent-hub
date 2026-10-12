/**
 * Resolve the `preview.secrets` names from deploy.yaml against the project's
 * preview secrets store. Kept apart from the pure parser because it reads the
 * DB. Error messages name keys only; values never leave this module except in
 * the returned env map.
 */
import { DeployConfigError } from './deploy-config-error.js';
import type { PreviewConfig } from './deploy-preview-config.js';
import {
  listPreviewSecretKeys,
  loadProjectEnvKeysForSpawn,
} from '../preview/preview-secrets-store.js';

/** Names referenced by `preview.secrets` that the store does not hold. */
export function findMissingPreviewSecrets(preview: PreviewConfig, projectId: string): string[] {
  if (preview.secrets.length === 0) return [];
  const stored = new Set(listPreviewSecretKeys(projectId));
  return preview.secrets.filter((name) => !stored.has(name));
}

function unknownSecretsError(missing: readonly string[]): DeployConfigError {
  return new DeployConfigError(
    'unknown_preview_secret',
    `preview: secret${missing.length === 1 ? '' : 's'} ${missing
      .map((n) => `"${n}"`)
      .join(
        ', ',
      )} not found in the project's preview secrets. Add them to the project secrets or remove them from deploy.yaml.`,
  );
}

/** Throw `unknown_preview_secret` when any referenced name is not stored. */
export function validatePreviewSecretRefs(preview: PreviewConfig, projectId: string): void {
  const missing = findMissingPreviewSecrets(preview, projectId);
  if (missing.length > 0) throw unknownSecretsError(missing);
}

/**
 * Decrypt exactly the referenced secrets into an env map for the PR
 * environment. Throws `unknown_preview_secret` if any name is missing or
 * unreadable, so a PR environment never boots with a partial env.
 */
export function resolvePreviewSecretEnv(
  preview: PreviewConfig,
  projectId: string,
  context: { sessionId?: string | null } = {},
): Record<string, string> {
  validatePreviewSecretRefs(preview, projectId);
  const env = loadProjectEnvKeysForSpawn(projectId, preview.secrets, context);
  const unreadable = preview.secrets.filter((name) => !Object.hasOwn(env, name));
  if (unreadable.length > 0) throw unknownSecretsError(unreadable);
  return env;
}
