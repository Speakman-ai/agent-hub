/**
 * Canonical model resolution for CLI spawns keyed by session ownership.
 *
 * Order: explicit (request / session picker) → per-user **per-agent** model
 * override (`agentModelOverrides` on `preferences_json`, only when `agentId` +
 * `ownerUserId` are supplied and the picked model is valid for `engine`) →
 * `cfg.engineDefaultModels[engine]` (or the first model advertised for that
 * engine). The legacy top-level `cfg.defaultModel` is deliberately not part
 * of agent resolution: it is a host-wide setting and can make one user's
 * agent unexpectedly run under another user's model choice.
 *
 * The per-user model tier is what backs the agent / reviewer "default model"
 * dropdown: selecting a model writes the caller's own `agentModelOverrides`
 * entry and only changes the model their sessions spawn with — never the
 * shared `agents` row or any other user. The engine is unchanged by this tier;
 * if the model isn't valid for the resolved engine it's skipped.
 *
 * `resolveEffectiveEngineAndModel` extends this with a per-user **per-agent**
 * engine override sourced from `agentEngineOverrides` on `preferences_json`. When
 * the override applies it picks the engine first, then walks model resolution
 * through the override engine — never the agent's shared engine.
 */
import {
  readCodexModelsCacheForUser,
  resolveSelectableCodexModels,
} from './codex-model-capability.js';
import { getUserPreferencesRow } from './user-preferences-store.js';
import type { AppConfig } from './types.js';

export interface ResolveEffectiveModelOpts {
  /** Session / caller override (validated elsewhere when applicable). */
  explicitModel?: string | null;
  /** Shared agent row (`projects.json`). */
  agentModel?: string | null;
  /** `sessions.owner_user_id`; required (with `agentId`) to apply the per-user model override. */
  ownerUserId?: string | null;
  /** Agent id used to key the per-user `agentModelOverrides` map. */
  agentId?: string | null;
}

export interface ResolveEffectiveEngineAndModelOpts {
  /** Required so the per-user `agentEngineOverrides` map can be keyed. */
  agentId: string;
  /** Shared agent engine from `projects.json`. */
  agentEngine: string;
  /** Shared agent model from `projects.json` (for the shared engine). */
  agentModel?: string | null;
  /** `sessions.owner_user_id`; when null/absent agentEngineOverrides are skipped. */
  ownerUserId?: string | null;
  /**
   * Caller-provided engine override (e.g. from a session-creation body).
   * Wins over both the per-user override and the agent's shared engine.
   */
  explicitEngine?: string | null;
  /** Caller-provided model override. Wins over every other tier. */
  explicitModel?: string | null;
}

export interface ResolvedEffectiveEngineAndModel {
  engine: string;
  model: string;
  /** True when a per-user override (or explicit caller engine) replaced the shared `agentEngine`. */
  overrideApplied: boolean;
}

/**
 * Pick the engine + model a session should spawn with, honoring per-user
 * per-agent overrides. Use this in place of the older "engine =
 * agent.engine; model = resolveEffectiveModel(...)" pair so a user who set
 * Agent X to codex-cli gets codex-cli even when the shared row says
 * claude-code. Falls all the way back to the agent's shared engine / model
 * when nothing else applies.
 */
export function resolveEffectiveEngineAndModel(
  cfg: AppConfig,
  opts: ResolveEffectiveEngineAndModelOpts,
): ResolvedEffectiveEngineAndModel {
  const explicitEngine = opts.explicitEngine?.trim();
  if (explicitEngine) {
    const model = resolveEffectiveModel(cfg, explicitEngine, {
      explicitModel: opts.explicitModel,
      // The shared `agentModel` is keyed to the shared engine, not the
      // explicit one — skip it so a stale agent-row model doesn't bleed
      // into a different engine.
      agentModel: explicitEngine === opts.agentEngine ? opts.agentModel : null,
      ownerUserId: opts.ownerUserId,
      agentId: opts.agentId,
    });
    return {
      engine: explicitEngine,
      model,
      overrideApplied: explicitEngine !== opts.agentEngine,
    };
  }

  const uid = opts.ownerUserId;
  if (uid && opts.agentId) {
    let override: { engine: string; model?: string } | undefined;
    try {
      override = getUserPreferencesRow(uid).agentEngineOverrides?.[opts.agentId];
    } catch {
      override = undefined;
    }
    if (override?.engine) {
      const model = resolveEffectiveModel(cfg, override.engine, {
        // Per-agent override's `model` is treated as an explicit pick —
        // it wins over the shared `agentModel` and the per-user model tier.
        explicitModel: opts.explicitModel ?? override.model ?? null,
        // Same reasoning as above — drop the shared model when the engine
        // diverges.
        agentModel: override.engine === opts.agentEngine ? opts.agentModel : null,
        ownerUserId: uid,
        agentId: opts.agentId,
      });
      return {
        engine: override.engine,
        model,
        overrideApplied: override.engine !== opts.agentEngine,
      };
    }
  }

  const model = resolveEffectiveModel(cfg, opts.agentEngine, {
    explicitModel: opts.explicitModel,
    agentModel: opts.agentModel,
    ownerUserId: opts.ownerUserId,
    agentId: opts.agentId,
  });
  return { engine: opts.agentEngine, model, overrideApplied: false };
}

export function resolveEffectiveModel(
  cfg: AppConfig,
  engine: string,
  opts: ResolveEffectiveModelOpts,
): string {
  const explicit = opts.explicitModel?.trim();
  if (explicit) return explicit;

  const staticAllowed = cfg.engineValidModels?.[engine];
  const allowed =
    engine === 'codex-cli' && Array.isArray(staticAllowed)
      ? resolveSelectableCodexModels(
          staticAllowed,
          readCodexModelsCacheForUser(opts.ownerUserId ?? null, cfg.dataDir),
        )
      : staticAllowed;

  // Per-user model pick (from the agent / reviewer model dropdown).
  // Only honored when it's still a valid model for the resolved engine, so a
  // stale pick after an engine change falls through to the shared / default
  // engine fallback instead of spawning an invalid model id.
  const uid = opts.ownerUserId;
  if (uid && opts.agentId) {
    let userModel: string | undefined;
    try {
      userModel = getUserPreferencesRow(uid).agentModelOverrides?.[opts.agentId];
    } catch {
      userModel = undefined;
    }
    const trimmed = userModel?.trim();
    if (trimmed && Array.isArray(allowed) && allowed.includes(trimmed)) return trimmed;
  }

  // Shared agent rows are retained for backwards-compatible project data and
  // for system-owned work, but never override a user's selected model. An
  // owned agent with no personal pick falls through to the engine catalogue.
  const agentM = opts.agentModel?.trim();
  if (
    (!opts.ownerUserId || !opts.agentId) &&
    agentM &&
    Array.isArray(allowed) &&
    allowed.includes(agentM)
  ) {
    return agentM;
  }

  const configuredDefault =
    cfg.engineDefaultModels?.[engine]?.trim() || (Array.isArray(allowed) ? allowed[0] : '');
  if (
    engine === 'codex-cli' &&
    Array.isArray(allowed) &&
    allowed.length > 0 &&
    !allowed.includes(configuredDefault)
  ) {
    return allowed[0];
  }
  return configuredDefault;
}
