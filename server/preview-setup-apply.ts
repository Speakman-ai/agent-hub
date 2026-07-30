/**
 * Build wizard persistence payloads for `POST .../dev-server/setup-apply`.
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
  /** Managed dev-server config validated by `parseDevServerConfig`. */
  devServer?: Record<string, unknown>;
  healthPath?: string;
  secrets?: PreviewSetupApplySecrets;
}

export function buildPrEnvPatchFromWizardApply(
  project: Project,
  body: PreviewSetupApplyBody,
): { ok: true; prEnv: ValidatedPrEnvConfig } | { ok: false; error: string } {
  if (!body.devServer) {
    const result = validatePrEnvProjectConfig({ enabled: false });
    if (!result.ok) return result;
    return { ok: true, prEnv: result.value };
  }

  const devServerRaw = body.devServer;
  const hasDevServer =
    !!devServerRaw && typeof devServerRaw === 'object' && !Array.isArray(devServerRaw);
  if (!hasDevServer) {
    return { ok: false, error: 'devServer must be an object' };
  }

  const healthPath =
    typeof body.healthPath === 'string' && body.healthPath.trim()
      ? body.healthPath.trim()
      : undefined;

  const prevPrEnv = (project.prEnv ?? {}) as Record<string, unknown>;
  const prEnvRaw: Record<string, unknown> = {
    ...prevPrEnv,
    enabled: (prevPrEnv.enabled as boolean | undefined) ?? false,
    devServer: devServerRaw,
  };

  // `prEnv.healthPath` is the PR-env runner's probe path, not the dev
  // server's — the dev server carries its own `devServer.healthPath`. Only
  // persist it when the caller sent one explicitly.
  if (healthPath) {
    prEnvRaw.healthPath = healthPath;
  }

  const result = validatePrEnvProjectConfig(prEnvRaw);
  if (!result.ok) return result;
  return { ok: true, prEnv: result.value };
}
