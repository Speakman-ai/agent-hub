// Engine resolver for one-shot prompt sites — picks the first available
// engine from a fallback chain so non-session features (project analyze,
// crons, heartbeats, memory reconciliation) keep working when the
// preferred engine is unavailable.
//
// Why this exists:
//   - These surfaces previously hardcoded `claude-code`, so a user who
//     had only Cursor/Codex/Gemini set up couldn't use them at all.
//   - Without a structured error type, "no engines configured" was
//     indistinguishable from "auth expired" or "binary missing" — they
//     all bubbled up as raw stderr from a failed spawn. The
//     `NoEnginesAvailableError` here gives callers a clear shape to
//     surface in UI banners or HTTP responses.
//
// The resolver is intentionally lightweight: it composes
// `probeEngineAvailability` and runs through a fixed-priority chain.
// Reordering is a future feature (per-project preference, per-org
// default, etc.) — keep this module flexible enough to extend without
// rewiring callers.

import type { AppConfig } from './types.js';
import {
  probeAllEngineAvailability,
  ALL_SUPPORTED_ENGINES,
  type EngineAvailability,
  type SupportedEngine,
} from './engine-availability.js';

export interface ResolveOneShotEngineInput {
  /**
   * Caller's preferred engine. Tried first when available. When absent,
   * the resolver walks the default fallback chain from the top.
   */
  preferred?: SupportedEngine | string | null;
  /**
   * Caller's preferred model for `preferred`. Only honored if the
   * resolver actually selects `preferred`; fallback engines pick their
   * own default via `defaultModelForEngine`.
   */
  preferredModel?: string | null;
  /**
   * Override the fallback chain. Useful for tests and for surfaces that
   * want a different priority (e.g. an analyze flow pinning a specific
   * engine order). Defaults to `DEFAULT_FALLBACK_CHAIN`. Do not add
   * `gemini-cli` here — Gemini is reserved for RAG/embeddings and is not an
   * agent engine.
   */
  fallbackChain?: readonly SupportedEngine[];
  /**
   * Pre-computed availability map. When omitted, the resolver runs
   * `probeAllEngineAvailability` itself. Tests pass this to avoid
   * hitting the filesystem / shelling out.
   */
  availability?: Record<SupportedEngine, EngineAvailability>;
  /**
   * Acting user whose per-account credentials decide Claude / Cursor / Codex /
   * Grok availability. There is no host fallback — when absent, only the
   * host-configured Gemini engine can resolve.
   */
  userId?: string | null;
}

export interface ResolvedOneShotEngine {
  engine: SupportedEngine;
  model: string;
  /**
   * True when the caller's `preferred` engine was unavailable and the
   * resolver picked a different one. Surfaces in cron/heartbeat logs so
   * the user can see why the run used a different engine than expected.
   */
  fallbackUsed: boolean;
  /**
   * Populated when `fallbackUsed` is true. The reason the preferred
   * engine was skipped (e.g. "expired", "no-binary").
   */
  fallbackFromReason?: string;
  /** The full availability map — handy for diagnostics + tests. */
  availability: Record<SupportedEngine, EngineAvailability>;
}

/**
 * Default priority order. Claude Code first because it's the most
 * common install and the historical default for these surfaces (this
 * minimizes behaviour drift for existing users); the rest follow in
 * rough order of UI prominence in the engine picker.
 *
 * Gemini is deliberately EXCLUDED — it is reserved for RAG/embeddings
 * (wiki + code search) and transcription, which call the Gemini API key
 * directly and never go through this engine path. It is not offered as a
 * selectable agent engine (the web/mobile pickers omit it) and must not be
 * auto-selected for userless background work. Google removed the Pro models
 * from the Gemini free tier on 2026-04-01, so a host free-tier key now 429s
 * (`limit: 0`) anyway — letting background features (support-ticket AI
 * investigation, memory reconcile, auto-review, userless heartbeats) silently
 * fall back to it left them dead. Grok is in the agent fallback chain but,
 * like Claude/Cursor/Codex, requires an acting user with per-account creds —
 * it is not a host-automation fallback. NOTE: a host that configures ONLY
 * Gemini (for RAG) and no per-user agent credentials will get a clear
 * `NoEnginesAvailableError` for userless background work instead of silently
 * running on a host key — that is the intended behaviour.
 */
export const DEFAULT_FALLBACK_CHAIN: readonly SupportedEngine[] = [
  'claude-code',
  'cursor-agent',
  'codex-cli',
  'grok-cli',
] as const;

/**
 * Thrown when no engine in the fallback chain is available. Carries
 * per-engine probe results so the caller can render a precise
 * "set up X or Y" message instead of a generic "no engines".
 */
export class NoEnginesAvailableError extends Error {
  readonly code = 'no_engines_configured';
  readonly availability: Record<SupportedEngine, EngineAvailability>;
  constructor(availability: Record<SupportedEngine, EngineAvailability>) {
    super(buildNoEnginesMessage(availability));
    this.name = 'NoEnginesAvailableError';
    this.availability = availability;
  }
}

function buildNoEnginesMessage(availability: Record<SupportedEngine, EngineAvailability>): string {
  const lines = ALL_SUPPORTED_ENGINES.map((engine) => {
    const a = availability[engine];
    return `  • ${engine}: ${a?.detail ?? 'unavailable'}`;
  });
  return [
    'No AI engines are configured. At least one of the following must be set up:',
    ...lines,
    '',
    'Open Settings → Engines to add credentials, then retry.',
  ].join('\n');
}

function isSupportedEngine(value: unknown): value is SupportedEngine {
  return typeof value === 'string' && (ALL_SUPPORTED_ENGINES as readonly string[]).includes(value);
}

/**
 * Resolve the engine to use for a one-shot prompt. Tries `preferred`
 * first when present and available, then walks the fallback chain.
 * Throws `NoEnginesAvailableError` when nothing is available.
 *
 * Note on the `model` choice: when the caller's `preferred` engine is
 * the one selected, we honor `preferredModel`; otherwise we fall back
 * to the engine's configured default. This matches the existing cron /
 * heartbeat per-row model override semantics — the override is meaningful
 * only when the spawn actually uses the engine the override targets.
 */
export async function resolveOneShotEngine(
  cfg: AppConfig,
  input: ResolveOneShotEngineInput = {},
): Promise<ResolvedOneShotEngine> {
  const availability =
    input.availability ?? (await probeAllEngineAvailability(cfg, { userId: input.userId ?? null }));

  const chain = input.fallbackChain ?? DEFAULT_FALLBACK_CHAIN;

  // Try the caller's preferred engine first when supplied + supported.
  let preferred: SupportedEngine | undefined;
  if (input.preferred && isSupportedEngine(input.preferred)) {
    preferred = input.preferred;
  }

  if (preferred) {
    const probe = availability[preferred];
    if (probe?.available) {
      return {
        engine: preferred,
        model: pickModel(cfg, preferred, input.preferredModel),
        fallbackUsed: false,
        availability,
      };
    }
    // Preferred wasn't available — walk the chain, skipping `preferred`
    // itself so we don't double-try it. The reason is captured for the
    // ResolvedOneShotEngine.fallbackFromReason field.
    const preferredReason = probe?.reason ?? 'unknown';
    for (const engine of chain) {
      if (engine === preferred) continue;
      const candidate = availability[engine];
      if (candidate?.available) {
        return {
          engine,
          model: pickModel(cfg, engine, null),
          fallbackUsed: true,
          fallbackFromReason: `${preferred}:${preferredReason}`,
          availability,
        };
      }
    }
    throw new NoEnginesAvailableError(availability);
  }

  // No preferred engine — walk the chain top to bottom.
  for (const engine of chain) {
    const candidate = availability[engine];
    if (candidate?.available) {
      return {
        engine,
        model: pickModel(cfg, engine, null),
        fallbackUsed: false,
        availability,
      };
    }
  }

  throw new NoEnginesAvailableError(availability);
}

function pickModel(
  cfg: AppConfig,
  engine: SupportedEngine,
  preferredModel: string | null | undefined,
): string {
  if (typeof preferredModel === 'string' && preferredModel.trim()) {
    return preferredModel.trim();
  }
  // Read defaults off the passed-in config so callers (and tests) can
  // resolve against an arbitrary AppConfig instead of the singleton.
  return cfg.engineDefaultModels[engine] || cfg.defaultModel;
}
