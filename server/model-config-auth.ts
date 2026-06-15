import type { AppConfig } from './types.js';
import { CURSOR_AGENT_HUB_MODEL_ALLOWLIST } from './cursor-agent-allowlist.js';

export { CURSOR_AGENT_HUB_MODEL_ALLOWLIST } from './cursor-agent-allowlist.js';

export interface EngineAuthState {
  'claude-code': boolean;
  'cursor-agent': boolean;
  'gemini-cli': boolean;
  'codex-cli': boolean;
  'grok-cli': boolean;
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

  const cursorHub = new Set<string>(CURSOR_AGENT_HUB_MODEL_ALLOWLIST);

  for (const [engine, models] of Object.entries(cfg.engineValidModels)) {
    const enabled = !!auth[engine as keyof EngineAuthState];
    let allowed = enabled ? models.slice() : [];

    if (engine === 'cursor-agent' && allowed.length > 0) {
      allowed = allowed.filter((m) => cursorHub.has(m));
      // Misconfigured or legacy config listed only non-CLI models — still ship
      // a usable single choice when Cursor auth is on.
      if (allowed.length === 0) {
        allowed = [...CURSOR_AGENT_HUB_MODEL_ALLOWLIST];
      }
    }

    engineValidModels[engine] = allowed;

    const configuredDefault = cfg.engineDefaultModels[engine];
    let def = allowed.includes(configuredDefault) ? configuredDefault : '';
    if (engine === 'cursor-agent' && !def && allowed.length > 0) {
      def = allowed[0];
    }
    engineDefaultModels[engine] = def;
  }

  return {
    defaultModel: cfg.defaultModel,
    engineDefaultModels,
    engineValidModels,
    engineAuth: auth,
  };
}
