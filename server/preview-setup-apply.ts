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

export type { WizardApplySecrets } from './wizard-secrets-apply.js';
export { applyWizardSecrets } from './wizard-secrets-apply.js';

export interface PreviewSetupApplyBody {
  session_id?: string;
  enabled?: boolean;
  preview?: Record<string, unknown>;
  /**
   * Dev-server config (managed host process; compose for backing services
   * only). Validated by `parseDevServerConfig` inside
   * `validatePrEnvProjectConfig`. Authored by the setup wizard/skill and by
   * the compose→devServer migration flow. May be persisted with or without a
   * compose `preview` block — at least one of the two is required when
   * enabled.
   */
  devServer?: Record<string, unknown>;
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
  const hasPreview = !!previewRaw && typeof previewRaw === 'object' && !Array.isArray(previewRaw);
  const devServerRaw = body.devServer;
  const hasDevServer =
    !!devServerRaw && typeof devServerRaw === 'object' && !Array.isArray(devServerRaw);

  // The dev-server pivot lets a project author `devServer` with or without a
  // compose `preview` block. Require at least one so an enabled apply is never
  // a no-op.
  if (!hasPreview && !hasDevServer) {
    return {
      ok: false,
      error: 'preview or devServer must be an object when enabled is true',
    };
  }

  const healthPath =
    typeof body.healthPath === 'string' && body.healthPath.trim()
      ? body.healthPath.trim()
      : undefined;

  const prevPrEnv = (project.prEnv ?? {}) as Record<string, unknown>;
  const prEnvRaw: Record<string, unknown> = {
    ...prevPrEnv,
    enabled: (prevPrEnv.enabled as boolean | undefined) ?? false,
  };

  let isCompose = false;
  let previewDeclaresAppRuntime = false;
  if (hasPreview) {
    const preview: Record<string, unknown> = {
      ...(previewRaw as Record<string, unknown>),
      enabled: true,
    };

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

    const compose = preview.compose as Record<string, unknown> | undefined;
    isCompose =
      !!compose &&
      typeof compose === 'object' &&
      typeof compose.entryService === 'string' &&
      compose.entryService.trim().length > 0;

    if (isCompose && healthPath) {
      preview.compose = { ...(compose as Record<string, unknown>), healthPath };
    }

    // Any preview that declares its OWN app runtime — compose app-wrapping
    // (`compose.entryService`), a `startScript`, or a `processes[]` graph —
    // conflicts with the managed dev server: `startSessionPreview` would select
    // the preview runtime (compose first) and ignore or double-start the app.
    const previewStartScript =
      typeof preview.startScript === 'string' && preview.startScript.trim().length > 0;
    const previewProcesses = Array.isArray(preview.processes) && preview.processes.length > 0;
    previewDeclaresAppRuntime = isCompose || previewStartScript || previewProcesses;

    prEnvRaw.preview = preview;
  }

  if (hasDevServer) {
    // Reject the contradictory combination rather than silently letting the
    // compose/spawn runtime win. Backing services belong in
    // `devServer.startCommand` (e.g. `docker compose up -d`), not in
    // `prEnv.preview.compose` — that field is the retired app-wrapping mode.
    if (previewDeclaresAppRuntime) {
      return {
        ok: false,
        error:
          'preview app runtime (compose.entryService / startScript / processes) cannot be combined with devServer. ' +
          'Run backing services from devServer.startCommand (e.g. `docker compose up -d`); prEnv.preview.compose is the retired app-wrapping mode.',
      };
    }

    prEnvRaw.devServer = devServerRaw;

    // Adopting devServer while a legacy app-wrapping compose preview
    // (`prEnv.preview.compose.entryService`) is still on disk would leave BOTH
    // runtimes eligible: `startSessionPreview` selects the compose runtime
    // whenever `preview.compose.entryService` is set, so the app would
    // double-start (compose-wrapped AND as the managed dev-server host
    // process). The documented migration POSTs only `devServer`, so unless the
    // caller re-sends a `preview` we strip the carried-over app-wrapping
    // compose block. Non-app-wrapping preview fields (captureRoutes, idleTTL,
    // …) are preserved; if stripping compose leaves no runtime config the
    // preview is disabled so the legacy spawn runtime isn't selected either.
    if (!hasPreview) {
      const carried = prEnvRaw.preview;
      if (carried && typeof carried === 'object' && !Array.isArray(carried)) {
        const { compose: legacyCompose, ...rest } = carried as Record<string, unknown>;
        const wasAppWrapping =
          !!legacyCompose &&
          typeof legacyCompose === 'object' &&
          !Array.isArray(legacyCompose) &&
          typeof (legacyCompose as Record<string, unknown>).entryService === 'string' &&
          ((legacyCompose as Record<string, unknown>).entryService as string).trim().length > 0;
        if (wasAppWrapping) {
          const hasOtherRuntime =
            typeof rest.startScript === 'string' ||
            (Array.isArray(rest.processes) && rest.processes.length > 0);
          prEnvRaw.preview = hasOtherRuntime ? rest : { ...rest, enabled: false };
        }
      }
    }
  }

  // The shared `prEnv.healthPath` only applies to the non-compose spawn
  // runtime; skip it when the apply is compose- or devServer-only.
  if (!isCompose && !hasDevServer && healthPath) {
    prEnvRaw.healthPath = healthPath;
  }

  const result = validatePrEnvProjectConfig(prEnvRaw);
  if (!result.ok) return result;
  return { ok: true, prEnv: result.value };
}
