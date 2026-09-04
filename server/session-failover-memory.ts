/**
 * Cross-turn engine-exhaustion memory for in-session failover.
 *
 * `engine-failover.ts` decides *whether* to switch and *to which* engine, but
 * its `triedEngines` input only bounds a SINGLE message chain (the
 * `_engineFailoverTried` flag that travels on one auto-continuation/failover
 * dispatch). It has no memory across separate user turns.
 *
 * That gap produced the reported bug: a session that was moved onto Codex by an
 * earlier `claude-code → codex-cli` failover, and then maxes out Codex on a
 * *fresh* user turn, re-walks the Codex chain
 * (`codex-cli → claude-code → grok-cli → cursor-agent`) from scratch and fails
 * over to **claude-code first** — an engine that is itself already exhausted —
 * before it can ever reach grok. The user sees "Codex did not switch to grok".
 *
 * This module is the pure, persistence-agnostic seam that closes the gap. The
 * chat close-handler serializes the returned map into
 * `sessions.failover_exhausted_engines` (JSON `{ "<engine>": <epochMs> }`) and:
 *
 *   1. seeds the failover walk's tried-set with engines exhausted within the
 *      cooldown window, so the walk skips straight past a dead engine, and
 *   2. records an engine when a `usage-exhausted` / `engine-auth` failover
 *      moves off it, and
 *   3. clears an engine the moment a turn completes cleanly on it (it recovered).
 *
 * Only durable, per-account death (usage exhaustion, auth failure) is recorded.
 * A `transient-exhausted` failover is NOT — the engine's quota and credentials
 * are fine, the provider was merely flaky, so re-selecting it next turn is
 * correct.
 */

/**
 * How long an engine stays on the skip-list after a usage/auth failover moved
 * off it, absent a clean turn to clear it sooner. A safety cap so a stale mark
 * can never *permanently* blacklist an engine whose quota window reset or whose
 * credentials were fixed but which never happened to run a clean turn. Sized to
 * the longest common rolling quota window we retry across (Anthropic's is ~5h);
 * after this, the walk will probe the engine again. Recovery is normally
 * detected precisely by {@link clearExhaustedEngine} on the next clean turn, so
 * this only matters when that never happens.
 */
export const FAILOVER_EXHAUSTED_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export type ExhaustedEngineMap = Record<string, number>;

/**
 * Parse the stored JSON blob into a `{ engine: epochMs }` map. Never throws:
 * malformed / non-object / non-numeric-value input collapses to `{}`, so a
 * corrupt column can never break a turn.
 */
export function parseExhaustedEngines(json: string | null | undefined): ExhaustedEngineMap {
  if (typeof json !== 'string' || !json.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: ExhaustedEngineMap = {};
  for (const [engine, ts] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof engine === 'string' && engine && typeof ts === 'number' && Number.isFinite(ts)) {
      out[engine] = ts;
    }
  }
  return out;
}

/**
 * Serialize a map back to a JSON string, or `null` when empty so the column
 * stays `NULL` rather than holding a useless `"{}"`.
 */
export function serializeExhaustedEngines(map: ExhaustedEngineMap): string | null {
  const keys = Object.keys(map);
  if (keys.length === 0) return null;
  return JSON.stringify(map);
}

/**
 * Engines whose exhaustion mark is still within the cooldown window as of
 * `nowMs`. These are the ones the failover walk should treat as already tried.
 */
export function activeExhaustedEngines(
  map: ExhaustedEngineMap,
  nowMs: number,
  cooldownMs: number = FAILOVER_EXHAUSTED_COOLDOWN_MS,
): string[] {
  return Object.entries(map)
    .filter(([, ts]) => nowMs - ts < cooldownMs)
    .map(([engine]) => engine);
}

/**
 * Return a new map with `engine` marked exhausted at `nowMs`. Also drops any
 * entries already past the cooldown so the blob does not grow without bound.
 */
export function recordExhaustedEngine(
  map: ExhaustedEngineMap,
  engine: string,
  nowMs: number,
  cooldownMs: number = FAILOVER_EXHAUSTED_COOLDOWN_MS,
): ExhaustedEngineMap {
  const next: ExhaustedEngineMap = {};
  for (const [e, ts] of Object.entries(map)) {
    if (nowMs - ts < cooldownMs) next[e] = ts;
  }
  next[engine] = nowMs;
  return next;
}

/**
 * Return a new map with `engine` removed — call when a turn completes cleanly
 * on `engine`, proving its quota/credentials recovered.
 */
export function clearExhaustedEngine(map: ExhaustedEngineMap, engine: string): ExhaustedEngineMap {
  if (!(engine in map)) return map;
  const next = { ...map };
  delete next[engine];
  return next;
}
