/**
 * Build wizard persistence payloads for `POST .../preview/setup-apply`.
 */
import { validatePrEnvProjectConfig } from './routes/projects.js';
import type { Project } from './types.js';
import type { ValidatedPrEnvConfig } from './routes/projects.js';

export interface PreviewSetupApplySecrets {
  env: string;
  mode?: 'merge' | 'replace';
  defaultKind?: 'plain' | 'secret';
}

export interface PreviewSetupApplyBody {
  enabled?: boolean;
  preview?: Record<string, unknown>;
  healthPath?: string;
  secrets?: PreviewSetupApplySecrets;
}

export function buildPrEnvPatchFromWizardApply(
  project: Project,
  body: PreviewSetupApplyBody,
): { ok: true; prEnv: ValidatedPrEnvConfig } | { ok: false; error: string } {
  const enabled = body.enabled !== false;
  if (!enabled) {
    const result = validatePrEnvProjectConfig({
      enabled: false,
      preview: { enabled: false },
    });
    if (!result.ok) return result;
    return { ok: true, prEnv: result.value };
  }

  const previewRaw = body.preview;
  if (!previewRaw || typeof previewRaw !== 'object' || Array.isArray(previewRaw)) {
    return { ok: false, error: 'preview must be an object when enabled is true' };
  }

  const preview: Record<string, unknown> = { ...previewRaw, enabled: true };

  // Agents often nest captureRoutes / idleTTL under compose — hoist to preview.
  const composeRaw = preview.compose;
  if (composeRaw && typeof composeRaw === 'object' && !Array.isArray(composeRaw)) {
    const composeObj = composeRaw as Record<string, unknown>;
    if (preview.captureRoutes === undefined && Array.isArray(composeObj.captureRoutes)) {
      preview.captureRoutes = composeObj.captureRoutes;
    }
    if (preview.idleTTL === undefined && composeObj.idleTTL !== undefined) {
      preview.idleTTL = composeObj.idleTTL;
    }
    const { captureRoutes: _cr, idleTTL: _idle, ...composeRest } = composeObj;
    preview.compose = composeRest;
  }

  const healthPath =
    typeof body.healthPath === 'string' && body.healthPath.trim()
      ? body.healthPath.trim()
      : undefined;

  const compose = preview.compose as Record<string, unknown> | undefined;
  const isCompose =
    compose &&
    typeof compose === 'object' &&
    typeof compose.entryService === 'string' &&
    compose.entryService.trim().length > 0;

  if (isCompose && healthPath) {
    preview.compose = { ...compose, healthPath };
  }

  const prevPrEnv = (project.prEnv ?? {}) as Record<string, unknown>;
  const prEnvRaw: Record<string, unknown> = {
    ...prevPrEnv,
    enabled: (prevPrEnv.enabled as boolean | undefined) ?? false,
    preview,
  };
  if (!isCompose && healthPath) {
    prEnvRaw.healthPath = healthPath;
  }

  const result = validatePrEnvProjectConfig(prEnvRaw);
  if (!result.ok) return result;
  return { ok: true, prEnv: result.value };
}
