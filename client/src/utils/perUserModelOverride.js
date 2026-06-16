/**
 * Shared per-user model-override reconciliation helpers for the web client.
 *
 * Per-user model picks live in `/api/auth/me/agent-model-overrides` and are
 * resolved against the *effective* engine (the user's per-user engine
 * override when set, otherwise the shared engine). When the effective engine
 * changes, an override pinned for the previous engine can become invalid; the
 * picker UI then falls back to "Default" while the stale value stays
 * persisted. These helpers let each surface (Settings agents, Design Studio)
 * detect that case and clear the override so persisted state matches the UI.
 *
 * Mirrors the mobile helpers in `mobile/src/utils/settingsAgents.js`
 * (`settingsEffectiveEngine` / `settingsModelOverrideIsStale`).
 */

/**
 * The engine actually in effect for the current user's sessions with an
 * agent: their per-user engine override when set, otherwise the shared
 * engine, otherwise the built-in default.
 */
export function effectiveEngine(engineOverride, sharedEngine) {
  return (engineOverride || '').trim() || (sharedEngine || '').trim() || 'claude-code';
}

/**
 * Valid models for an engine, per `GET /api/config/models`.
 */
export function modelsForEngine(modelConfig, engine) {
  return modelConfig?.engineValidModels?.[engine] || [];
}

/**
 * True when a stored per-user model override is no longer valid for the
 * effective engine (e.g. the engine just changed, so a model from the
 * previous engine is now incompatible). Callers clear the override in that
 * case so the runtime never receives a mismatched engine/model pair and the
 * "Default" fallback reflects real state. An empty override is never stale.
 */
export function modelOverrideIsStale(modelOverride, modelConfig, engine) {
  const m = typeof modelOverride === 'string' ? modelOverride.trim() : '';
  if (!m) return false;
  return !modelsForEngine(modelConfig, engine).includes(m);
}
