/**
 * Stable engine order for migrating a session off an engine that is no longer
 * authenticated (empty `engineValidModels[engine]` from GET /api/config/models).
 * Matches the primary engine picker in TopBar.jsx (no gemini-cli row).
 */
export const AUTH_MODEL_ENGINE_ORDER = ['claude-code', 'cursor-agent', 'codex-cli'];

export function firstEngineWithAuthenticatedModels(modelConfig) {
  if (!modelConfig?.engineValidModels) return null;
  for (const id of AUTH_MODEL_ENGINE_ORDER) {
    const list = modelConfig.engineValidModels[id];
    if (Array.isArray(list) && list.length > 0) return id;
  }
  return null;
}

export function defaultModelForAuthenticatedEngine(modelConfig, engine) {
  if (!engine) return null;
  const fromDefaults = modelConfig?.engineDefaultModels?.[engine];
  if (fromDefaults) return fromDefaults;
  const list = modelConfig?.engineValidModels?.[engine];
  if (Array.isArray(list) && list.length > 0) return list[0];
  return null;
}
