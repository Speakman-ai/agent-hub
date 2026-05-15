/**
 * Canonical model resolution for CLI spawns keyed by session ownership.
 *
 * Order: explicit (request / session picker) → per-user engine default from
 * `preferences_json` → shared `agent.model` (only if allowed for `engine`)
 * → `cfg.engineDefaultModels[engine]`
 * (else `cfg.defaultModel`; if `cfg` is partial in tests or legacy mocks, falls
 * back to process `defaultModelForEngine(engine)` — same singleton as startup).
 */
import { defaultModelForEngine } from './config.js';
import { getUserPreferencesRow } from './user-preferences-store.js';
import type { AppConfig } from './types.js';

export interface ResolveEffectiveModelOpts {
  /** Session / caller override (validated elsewhere when applicable). */
  explicitModel?: string | null;
  /** Shared agent row (`projects.json`). */
  agentModel?: string | null;
  /** `sessions.owner_user_id` — when null/absent the user-preferences tier is skipped. */
  ownerUserId?: string | null;
}

export function resolveEffectiveModel(
  cfg: AppConfig,
  engine: string,
  opts: ResolveEffectiveModelOpts,
): string {
  const explicit = opts.explicitModel?.trim();
  if (explicit) return explicit;

  const uid = opts.ownerUserId;
  if (uid) {
    let enginePrefs: Record<string, string> | undefined;
    try {
      enginePrefs = getUserPreferencesRow(uid).engineDefaultModels;
    } catch {
      enginePrefs = undefined;
    }
    const pick = enginePrefs?.[engine]?.trim();
    if (pick) {
      const allowed = cfg.engineValidModels?.[engine];
      if (Array.isArray(allowed) && allowed.includes(pick)) return pick;
    }
  }

  const agentM = opts.agentModel?.trim();
  if (agentM) {
    const allowedAgent = cfg.engineValidModels?.[engine];
    if (Array.isArray(allowedAgent) && allowedAgent.includes(agentM)) return agentM;
  }

  return cfg.engineDefaultModels?.[engine] ?? cfg.defaultModel ?? defaultModelForEngine(engine);
}
