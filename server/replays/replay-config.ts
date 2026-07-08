// Per-project session-replay policy: the server-delivered source of truth for
// the continuous-capture sample rate and opt-in flag.
//
// Historically the replay sample rate (and on/off) lived in per-browser
// localStorage, so the policy only applied to whoever flipped their own toggle.
// This module moves it to per-project server config: an operator sets it once
// and it applies to every user on the project. The resolved policy is delivered
// to recorders via `GET /api/replays/config` and to the admin UI via the
// project list.
//
// Pure (no DB, no Express) so the clamp / validation / resolution rules are
// unit-testable in isolation and shared by the PATCH validator and the config
// endpoint.

/** Raw per-project config as persisted on the project row (`project.replay`). */
export interface ProjectReplayConfig {
  /**
   * Continuous-tier session sample rate in [0, 1]. Unset (absent) means the
   * project has not configured a server-side rate, so the recorder keeps its
   * built-in default (the legacy on-error capture stays on). A set value is
   * authoritative for ALL users on the project.
   */
  sampleRate?: number;
  /**
   * Whether the continuous-capture tier is enabled for this project. Default
   * off — recording every screen of every session is an explicit per-project
   * opt-in, not a sampling default.
   */
  continuous?: boolean;
  /**
   * Whether mask-all is enforced while continuous capture is on. mask-all is a
   * STRONG DEFAULT (enforced when continuous is on) that an Admin may explicitly
   * override by persisting `false` — recording un-masked whole sessions is then
   * the operator's deliberate, acknowledged choice. Semantics:
   *   - **absent** → strong default: enforced whenever `continuous` is on.
   *   - **`false`** → Admin opt-out: NOT enforced even with continuous on.
   *   - **`true`** → same as the default (enforced); normalized away as redundant.
   * Only meaningful with `continuous: true`; ignored (and dropped) otherwise.
   */
  maskAllEnforced?: boolean;
  /**
   * Cadence (ms) at which the continuous recorder flushes appended chunks to the
   * chunked-ingest endpoint. Server-delivered per-project so the policy applies
   * to every user. Unset → the recorder uses {@link DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS}
   * (5 min). Clamped to [{@link MIN_CONTINUOUS_FLUSH_INTERVAL_MS},
   * {@link MAX_CONTINUOUS_FLUSH_INTERVAL_MS}] — the floor enforces the MVP
   * decision that there is NO sub-minute cadence (sub-minute streaming is the
   * deferred segmented-storage upgrade path).
   */
  flushIntervalMs?: number;
  /**
   * Datadog-style two-level sampling, level 1: fraction of SESSIONS the tenant
   * tracks, in [0, 1]. Unset (absent) means the recorder keeps its built-in
   * default. This gates whether a session is sampled at all; the replay decision
   * ({@link sessionReplaySampleRate}) is nested underneath it.
   */
  sessionSampleRate?: number;
  /**
   * Datadog-style two-level sampling, level 2: fraction OF the sampled sessions
   * that also record a replay, in [0, 1]. This is a percentage OF the sessions
   * that already passed {@link sessionSampleRate}, NOT an independent gate — so
   * the effective replay probability is the PRODUCT of the two (see
   * {@link resolveEffectiveReplayRate}). Unset means the recorder keeps its
   * built-in default.
   */
  sessionReplaySampleRate?: number;
  /**
   * Per-tenant hourly quota for one-shot (`POST /api/replays`) ingest, keyed on
   * the RUM token's project. Overrides the global default budget so a heavy
   * tenant can be granted more (or a noisy one capped tighter). Unset → the
   * global default. A positive integer; floored on persist.
   */
  ingestQuota?: number;
  /**
   * Per-tenant hourly quota for streaming ingest (chunked `POST
   * /api/replays/:id/events` and view-scoped segment appends share this budget),
   * keyed on the RUM token's project. Overrides the global default. Unset → the
   * global default. A positive integer; floored on persist.
   */
  eventsIngestQuota?: number;
}

/** The resolved policy delivered to a recorder / the admin UI. */
export interface ResolvedReplayPolicy {
  /**
   * Effective sample rate in [0, 1], or `null` when the project has not set
   * one. `null` tells the client to fall back to its built-in default rather
   * than treating "unset" as "off" (which would silently disable the
   * always-on bug-report capture).
   */
  sampleRate: number | null;
  /** Whether continuous capture is enabled for the project. */
  continuous: boolean;
  /**
   * When true the recorder MUST mask all text + inputs and the UI must not
   * offer a relaxed masking mode. mask-all is a STRONG DEFAULT whenever
   * continuous capture is on — it is enforced unless an Admin has explicitly
   * opted the project out (`replay.maskAllEnforced === false`). With continuous
   * off this is always false (the per-browser masking choice governs).
   */
  maskAllEnforced: boolean;
  /**
   * Cadence (ms) the continuous recorder flushes chunks at. Always present so
   * the client never has to guess; defaults to
   * {@link DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS} and is clamped to the
   * [{@link MIN_CONTINUOUS_FLUSH_INTERVAL_MS}, {@link MAX_CONTINUOUS_FLUSH_INTERVAL_MS}]
   * range (the floor bars sub-minute cadence per the MVP storage decision).
   */
  flushIntervalMs: number;
  /**
   * Two-level sampling level 1: fraction of sessions tracked, or `null` when the
   * project has not set one (client keeps its built-in default). See
   * {@link ProjectReplayConfig.sessionSampleRate}.
   */
  sessionSampleRate: number | null;
  /**
   * Two-level sampling level 2: fraction OF sampled sessions that record a
   * replay, or `null` when unset. Nested under {@link sessionSampleRate}, not
   * independent. See {@link ProjectReplayConfig.sessionReplaySampleRate}.
   */
  sessionReplaySampleRate: number | null;
  /**
   * The effective replay probability: the PRODUCT of the two nested rates
   * (`sessionSampleRate * sessionReplaySampleRate`), treating an unset level as
   * 1. `null` only when BOTH nested rates are unset — the recorder then keeps its
   * built-in default rather than reading `null` as off. Precomputed here so a
   * recorder can gate on one number without re-deriving the nested math.
   */
  effectiveReplaySampleRate: number | null;
}

/** Default continuous-flush cadence (5 min) — the MVP interval. */
export const DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Floor on the continuous-flush cadence. The MVP reuses the monolithic
 * gunzip-concat-regzip-overwrite append, which is acceptable at ~5-min cadence
 * (~6 flushes / 30-min session) but NOT at sub-minute cadence. Sub-minute
 * streaming is the deferred segmented-storage upgrade, so the policy refuses to
 * deliver a cadence faster than this.
 */
export const MIN_CONTINUOUS_FLUSH_INTERVAL_MS = 60 * 1000;
/** Ceiling on the cadence so a tab's tail loss window stays bounded (1 hour). */
export const MAX_CONTINUOUS_FLUSH_INTERVAL_MS = 60 * 60 * 1000;

/** The policy returned when a project has no replay config (or no project). */
export const DEFAULT_REPLAY_POLICY: ResolvedReplayPolicy = Object.freeze({
  sampleRate: null,
  continuous: false,
  maskAllEnforced: false,
  flushIntervalMs: DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS,
  sessionSampleRate: null,
  sessionReplaySampleRate: null,
  effectiveReplaySampleRate: null,
});

/**
 * Nested two-level sampling math (Datadog parity). The effective probability
 * that a session records a replay is the PRODUCT of the session sample rate and
 * the replay sample rate — the replay rate is a percentage OF the already-sampled
 * sessions, not an independent draw. Both inputs are clamped to [0, 1], so the
 * result is always a valid probability. Pure — unit-testable in isolation.
 */
export function resolveEffectiveReplayRate(
  sessionSampleRate: number,
  sessionReplaySampleRate: number,
): number {
  return clampReplaySampleRate(sessionSampleRate) * clampReplaySampleRate(sessionReplaySampleRate);
}

/**
 * Resolve the per-tenant hourly ingest quota. A configured positive value wins
 * (floored to an integer); anything unset / non-finite / non-positive falls back
 * to the global default budget. Pure — unit-testable in isolation.
 */
export function resolveIngestQuota(
  configured: number | undefined | null,
  fallback: number,
): number {
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return fallback;
}

/** Clamp an arbitrary finite number to a valid sample rate in [0, 1]. */
export function clampReplaySampleRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/**
 * Clamp a continuous-flush cadence to the deliverable range. A non-finite /
 * unset value resolves to the 5-min default; anything below the sub-minute floor
 * is raised to it (the MVP storage cannot support faster), and anything above
 * the ceiling is capped.
 */
export function clampFlushIntervalMs(value: number | undefined | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS;
  }
  if (value < MIN_CONTINUOUS_FLUSH_INTERVAL_MS) return MIN_CONTINUOUS_FLUSH_INTERVAL_MS;
  if (value > MAX_CONTINUOUS_FLUSH_INTERVAL_MS) return MAX_CONTINUOUS_FLUSH_INTERVAL_MS;
  return value;
}

export type NormalizeResult =
  | { ok: true; value: ProjectReplayConfig | null }
  | { ok: false; error: string };

/**
 * Validate + normalize a `replay` PATCH payload. `null` clears the config
 * (returns `{ value: null }`); an object validates `sampleRate` (finite number
 * in [0, 1], clamped) and `continuous` (boolean). Unknown keys are dropped.
 * Returns a discriminated result so the route can map `ok: false` to a 400.
 *
 * Safety invariant: a `continuous: true` config is normalized to carry an
 * explicit `sampleRate` (defaulting to `0` when none is given), because an
 * absent rate means "unconfigured → recorder uses its built-in default" — which
 * for the continuous tier would silently mean 100% whole-session capture. The
 * sample rate must always gate the continuous tier, so a bare
 * `{ continuous: true }` resolves to OFF (rate 0) until a rate is set.
 */
export function normalizeReplayConfig(raw: unknown): NormalizeResult {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'replay must be an object or null' };
  }
  const obj = raw as Record<string, unknown>;
  const out: ProjectReplayConfig = {};

  if (obj.sampleRate !== undefined) {
    const n = obj.sampleRate;
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      return { ok: false, error: 'replay.sampleRate must be a finite number in [0, 1]' };
    }
    if (n < 0 || n > 1) {
      return { ok: false, error: 'replay.sampleRate must be between 0 and 1' };
    }
    out.sampleRate = clampReplaySampleRate(n);
  }

  if (obj.continuous !== undefined) {
    if (typeof obj.continuous !== 'boolean') {
      return { ok: false, error: 'replay.continuous must be a boolean' };
    }
    out.continuous = obj.continuous;
  }

  if (obj.maskAllEnforced !== undefined) {
    if (typeof obj.maskAllEnforced !== 'boolean') {
      return { ok: false, error: 'replay.maskAllEnforced must be a boolean' };
    }
    out.maskAllEnforced = obj.maskAllEnforced;
  }

  if (obj.flushIntervalMs !== undefined) {
    const n = obj.flushIntervalMs;
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      return { ok: false, error: 'replay.flushIntervalMs must be a finite number (ms)' };
    }
    if (n < MIN_CONTINUOUS_FLUSH_INTERVAL_MS || n > MAX_CONTINUOUS_FLUSH_INTERVAL_MS) {
      return {
        ok: false,
        error: `replay.flushIntervalMs must be between ${MIN_CONTINUOUS_FLUSH_INTERVAL_MS} and ${MAX_CONTINUOUS_FLUSH_INTERVAL_MS} ms (no sub-minute cadence on monolithic storage)`,
      };
    }
    out.flushIntervalMs = clampFlushIntervalMs(n);
  }

  for (const key of ['sessionSampleRate', 'sessionReplaySampleRate'] as const) {
    if (obj[key] !== undefined) {
      const n = obj[key];
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        return { ok: false, error: `replay.${key} must be a finite number in [0, 1]` };
      }
      if (n < 0 || n > 1) {
        return { ok: false, error: `replay.${key} must be between 0 and 1` };
      }
      out[key] = clampReplaySampleRate(n);
    }
  }

  for (const key of ['ingestQuota', 'eventsIngestQuota'] as const) {
    if (obj[key] !== undefined) {
      const n = obj[key];
      if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
        return { ok: false, error: `replay.${key} must be a positive number (requests/hour)` };
      }
      out[key] = Math.floor(n);
    }
  }

  // An empty object (no recognized config keys) clears the config rather than
  // persisting `{}`, so the project row stays lean. `maskAllEnforced` is not a
  // standalone config — without `continuous`/`sampleRate`/`flushIntervalMs` it is
  // meaningless, so a lone `maskAllEnforced` also clears (handled by the strip below).
  if (
    out.sampleRate === undefined &&
    out.continuous === undefined &&
    out.flushIntervalMs === undefined &&
    out.sessionSampleRate === undefined &&
    out.sessionReplaySampleRate === undefined &&
    out.ingestQuota === undefined &&
    out.eventsIngestQuota === undefined
  ) {
    return { ok: true, value: null };
  }
  // Never persist continuous-on with an unset rate: pin it to an explicit 0
  // (off) so the stored config can't later resolve to the recorder's default
  // 100% sampling. A rate set elsewhere in the same payload is respected.
  if (out.continuous === true && out.sampleRate === undefined) {
    out.sampleRate = 0;
  }
  // `maskAllEnforced` only needs persisting as the non-default opt-out: keep it
  // only when it is `false` AND continuous is on. The strong default (enforced)
  // is "absent", so an explicit `true`, or a `false` with continuous off, is
  // dropped — keeping the stored config lean and unambiguous.
  if (out.maskAllEnforced !== false || out.continuous !== true) {
    delete out.maskAllEnforced;
  }
  return { ok: true, value: out };
}

/**
 * Resolve a project's raw replay config into the policy delivered to recorders
 * and the admin UI. Missing config resolves to {@link DEFAULT_REPLAY_POLICY}.
 * mask-all is a strong default whenever continuous capture is on — enforced
 * unless an Admin has explicitly opted out (`maskAllEnforced === false`).
 */
export function resolveReplayPolicy(
  cfg: ProjectReplayConfig | null | undefined,
): ResolvedReplayPolicy {
  if (!cfg || typeof cfg !== 'object') return DEFAULT_REPLAY_POLICY;
  const continuous = cfg.continuous === true;
  let sampleRate =
    typeof cfg.sampleRate === 'number' && Number.isFinite(cfg.sampleRate)
      ? clampReplaySampleRate(cfg.sampleRate)
      : null;
  // The sample rate gates the continuous tier, so a continuous-enabled policy
  // must NEVER resolve to an unset rate — the client treats `null` as "use the
  // built-in default" (1), which would make continuous capture effectively
  // 100%. Pin the missing rate to a safe explicit 0 (off) instead. (Defense in
  // depth: `normalizeReplayConfig` already pins it at persist time, but a config
  // loaded from any other source resolves safely here too.)
  if (continuous && sampleRate === null) sampleRate = 0;
  const sessionSampleRate =
    typeof cfg.sessionSampleRate === 'number' && Number.isFinite(cfg.sessionSampleRate)
      ? clampReplaySampleRate(cfg.sessionSampleRate)
      : null;
  const sessionReplaySampleRate =
    typeof cfg.sessionReplaySampleRate === 'number' && Number.isFinite(cfg.sessionReplaySampleRate)
      ? clampReplaySampleRate(cfg.sessionReplaySampleRate)
      : null;
  // Nested product, treating an unset level as 1 (Datadog's default). Null only
  // when BOTH levels are unset, so the client keeps its built-in default rather
  // than reading a bare `null` as "off".
  const effectiveReplaySampleRate =
    sessionSampleRate === null && sessionReplaySampleRate === null
      ? null
      : resolveEffectiveReplayRate(sessionSampleRate ?? 1, sessionReplaySampleRate ?? 1);
  return {
    sampleRate,
    continuous,
    // Strong default: enforced whenever continuous capture is on, UNLESS an
    // Admin has explicitly opted the project out (`maskAllEnforced === false`).
    // With continuous off, mask-all is never enforced (per-browser choice wins).
    maskAllEnforced: continuous && cfg.maskAllEnforced !== false,
    flushIntervalMs: clampFlushIntervalMs(cfg.flushIntervalMs),
    sessionSampleRate,
    sessionReplaySampleRate,
    effectiveReplaySampleRate,
  };
}
