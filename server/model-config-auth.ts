import type { AppConfig } from './types.js';
import { CURSOR_AGENT_HUB_MODEL_ALLOWLIST } from './cursor-agent-allowlist.js';
import { RAG_ONLY_ENGINES, type SupportedEngine } from './engine-availability.js';

export { CURSOR_AGENT_HUB_MODEL_ALLOWLIST } from './cursor-agent-allowlist.js';

export interface EngineAuthState {
  'claude-code': boolean;
  'cursor-agent': boolean;
  'gemini-cli': boolean;
  'codex-cli': boolean;
  'grok-cli': boolean;
}

export interface PublicModelConfig {
  /** Legacy host-wide field kept for clients that still read this response. */
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
export interface BuildModelConfigOpts {
  /**
   * Capability-resolved selectable model list for `codex-cli`, overriding the
   * static `cfg.engineValidModels['codex-cli']`. Lets the route surface newer
   * models (e.g. gpt-5.6-sol) only when the installed CLI advertises them, and
   * hide them otherwise. When omitted, the static config list is used as-is.
   */
  codexSelectableModels?: readonly string[];
}

export function buildAuthenticatedModelConfig(
  cfg: AppConfig,
  auth: EngineAuthState,
  opts?: BuildModelConfigOpts,
): PublicModelConfig {
  const engineValidModels: Record<string, string[]> = {};
  const engineDefaultModels: Record<string, string> = {};

  const cursorHub = new Set<string>(CURSOR_AGENT_HUB_MODEL_ALLOWLIST);

  for (const [engine, models] of Object.entries(cfg.engineValidModels)) {
    // RAG-only engines (gemini-cli) are reserved for host embeddings and must
    // never be advertised as a selectable picker engine, even when a Gemini
    // RAG key makes them "authenticated". Skip them regardless of config source
    // so `/api/config/models` can't leak gemini-cli into the web/mobile/Design
    // pickers. See RAG_ONLY_ENGINES in engine-availability.ts.
    if (RAG_ONLY_ENGINES.has(engine as SupportedEngine)) continue;

    const enabled = !!auth[engine as keyof EngineAuthState];
    const source =
      engine === 'codex-cli' && opts?.codexSelectableModels ? opts.codexSelectableModels : models;
    let allowed = enabled ? source.slice() : [];

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
    // Compatibility only. New model resolution is per-user/per-agent and
    // deliberately ignores this host-wide legacy value.
    defaultModel: cfg.defaultModel,
    engineDefaultModels,
    engineValidModels,
    engineAuth: auth,
  };
}
