import type { AppConfig } from './types.js';

export interface EngineAuthState {
  'claude-code': boolean;
  'cursor-agent': boolean;
  'gemini-cli': boolean;
  'codex-cli': boolean;
}

export interface PublicModelConfig {
  defaultModel: string;
  engineDefaultModels: Record<string, string>;
  engineValidModels: Record<string, string[]>;
  engineAuth: EngineAuthState;
}

/**
 * Filter the selectable model map to only engines the current runtime is
 * authenticated for. Unauthenticated engines surface an empty model list so
 * every client can hide/disable selection consistently.
 */
export function buildAuthenticatedModelConfig(
  cfg: AppConfig,
  auth: EngineAuthState,
): PublicModelConfig {
  const engineValidModels: Record<string, string[]> = {};
  const engineDefaultModels: Record<string, string> = {};

  for (const [engine, models] of Object.entries(cfg.engineValidModels)) {
    const enabled = !!auth[engine as keyof EngineAuthState];
    const allowed = enabled ? models.slice() : [];
    engineValidModels[engine] = allowed;

    const configuredDefault = cfg.engineDefaultModels[engine];
    engineDefaultModels[engine] = allowed.includes(configuredDefault) ? configuredDefault : '';
  }

  return {
    defaultModel: cfg.defaultModel,
    engineDefaultModels,
    engineValidModels,
    engineAuth: auth,
  };
}
