/**
 * Engine → binary path resolution. The control plane never sends
 * filesystem paths in `spawn` frames; it sends an opaque engine
 * identifier (`claude-code` / `cursor-agent`) and the runner picks the
 * binary on its own machine. This keeps machine-local config (CLI
 * install path, version pins) where it belongs.
 *
 * Resolution order (first hit wins):
 *   1. Per-engine env override: `AGENT_HUB_RUNNER_BIN_<ENGINE>` where
 *      `<ENGINE>` is the upper-snake-cased engine name (e.g.
 *      `AGENT_HUB_RUNNER_BIN_CLAUDE_CODE`). Lets operators run the
 *      runner against a non-default install without rebuilding.
 *   2. Built-in default for the engine (`/usr/local/bin/claude` etc.).
 *
 * Unknown engines reject with `unknown_engine` so the control plane can
 * surface the error verbatim.
 */
import type { RunnerEngine } from '../../shared/runner-protocol.js';

/** Fixed default binary paths. `RunnerEngine` is widened to `string` in
 * the protocol type, so this map is the source of truth for which engine
 * names the runner actually accepts — anything missing returns `null`
 * from `resolveEngineBin` and surfaces as `unknown_engine`. */
const DEFAULT_BINS: Record<string, string> = {
  'claude-code': '/usr/local/bin/claude',
  'cursor-agent': '/usr/local/bin/cursor-agent',
};

/** Convert an engine name into the env var key the operator can use to
 * override its bin path. Exported for tests. */
export function envKeyForEngine(engine: RunnerEngine): string {
  return 'AGENT_HUB_RUNNER_BIN_' + engine.toUpperCase().replace(/-/g, '_');
}

export interface ResolveOptions {
  /** Test seam for the env source. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Resolve an engine identifier to an absolute binary path. Returns null
 * for unknown engines — the spawner should reject with `unknown_engine`
 * in that case rather than fall through to a string-empty exec. */
export function resolveEngineBin(engine: RunnerEngine, opts: ResolveOptions = {}): string | null {
  const env = opts.env ?? process.env;
  const overrideKey = envKeyForEngine(engine);
  const override = env[overrideKey];
  if (typeof override === 'string' && override.length > 0) {
    return override;
  }
  return DEFAULT_BINS[engine] ?? null;
}

/** All engine identifiers the resolver knows by default. Used in
 * production to populate the runner's advertised `engines` capability
 * at handshake, and in tests to iterate every known engine. */
export const KNOWN_ENGINES: RunnerEngine[] = Object.keys(DEFAULT_BINS);

/** @deprecated Use {@link KNOWN_ENGINES}. Re-exported for backwards
 * compatibility with the original Phase-2 commit; will be removed in a
 * follow-up once external callers (none today) have migrated. */
export const ENGINES_FOR_TESTING = KNOWN_ENGINES;
