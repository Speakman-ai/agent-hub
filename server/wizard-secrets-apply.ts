/**
 * Shared secrets persistence for setup wizards (preview + finalize).
 */
import {
  listRawPreviewSecretRows,
  parseDotEnv,
  replacePreviewSecrets,
  replacePreviewSecretsMixed,
  PreviewSecretValidationError,
  type PreviewSecretInput,
} from './preview/preview-secrets-store.js';

export interface WizardApplySecrets {
  env: string;
  mode?: 'merge' | 'replace';
  defaultKind?: 'plain' | 'secret';
}

export type WizardSecretsApplyResult =
  | { ok: true; secretsImported: number }
  | { ok: false; statusCode: number; error: string };

export function applyWizardSecrets(
  projectId: string,
  secrets: WizardApplySecrets | undefined,
  actorUserId: string | null,
): WizardSecretsApplyResult {
  if (!secrets || typeof secrets.env !== 'string') {
    return { ok: true, secretsImported: 0 };
  }
  const rawMode = secrets.mode;
  if (rawMode !== undefined && rawMode !== 'merge' && rawMode !== 'replace') {
    return { ok: false, statusCode: 400, error: 'secrets.mode must be "merge" or "replace"' };
  }
  const mode = rawMode === 'replace' ? 'replace' : 'merge';
  const defaultKind = secrets.defaultKind === 'plain' ? 'plain' : 'secret';
  try {
    const parsed = parseDotEnv(secrets.env);
    const inputs: PreviewSecretInput[] = parsed.map((p) => ({
      ...p,
      kind: p.kind ?? defaultKind,
    }));
    if (mode === 'merge') {
      const existingRaw = listRawPreviewSecretRows(projectId);
      replacePreviewSecretsMixed(projectId, inputs, existingRaw, actorUserId);
    } else {
      replacePreviewSecrets(projectId, inputs, actorUserId);
    }
    return { ok: true, secretsImported: inputs.length };
  } catch (err) {
    if (err instanceof PreviewSecretValidationError) {
      return { ok: false, statusCode: err.statusCode, error: err.message };
    }
    throw err;
  }
}
