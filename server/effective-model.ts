/**
 * Canonical model resolution for CLI spawns keyed by session ownership.
 *
 * Order: explicit (request / session picker) → shared `agent.model` (only if
 * allowed for `engine`) → `cfg.engineDefaultModels[engine]` (else
 * `cfg.defaultModel`; if `cfg` is partial in tests or legacy mocks, falls
 * back to process `defaultModelForEngine(engine)` — same singleton as
 * startup).
 *
 * `resolveEffectiveEngineAndModel` extends this with a per-user **per-agent**
 * engine override sourced from `agentEngineOverrides` on `preferences_json`. When
 * the override applies it picks the engine first, then walks model resolution
 * through the override engine — never the agent's shared engine.
 */
import { defaultModelForEngine } from './config.js';
import { getUserPreferencesRow } from './user-preferences-store.js';
import type { AppConfig } from './types.js';

export interface ResolveEffectiveModelOpts {
  /** Session / caller override (validated elsewhere when applicable). */
  explicitModel?: string | null;
  /** Shared agent row (`projects.json`). */
  agentModel?: string | null;
  /** `sessions.owner_user_id` — accepted for signature parity; no per-user model tier remains. */
  ownerUserId?: string | null;
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
        // it wins over the shared `agentModel`.
        explicitModel: opts.explicitModel ?? override.model ?? null,
        // Same reasoning as above — drop the shared model when the engine
        // diverges.
        agentModel: override.engine === opts.agentEngine ? opts.agentModel : null,
        ownerUserId: uid,
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

  const agentM = opts.agentModel?.trim();
  if (agentM) {
    const allowedAgent = cfg.engineValidModels?.[engine];
    if (Array.isArray(allowedAgent) && allowedAgent.includes(agentM)) return agentM;
  }

  return cfg.engineDefaultModels?.[engine] ?? cfg.defaultModel ?? defaultModelForEngine(engine);
}
