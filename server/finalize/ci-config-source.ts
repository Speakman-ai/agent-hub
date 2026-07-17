/**
 * ci-config-source.ts — resolve WHICH Finalize CI config a run should use.
 *
 * Finalize no longer requires a committed `.agent-hub/ci.yaml`. The config can
 * come from one of two places, in strict precedence order:
 *
 *   1. `committed`        — `<worktree>/.agent-hub/ci.yaml`. If the file exists
 *                           it is authoritative, even when it fails to parse
 *                           (an explicit-but-broken committed config must FAIL
 *                           the gate, never silently fall through to a server
 *                           config the repo's authors can't see).
 *   2. `server-personal`  — a per-user server-stored config for the triggering
 *                           user (personal workflow checks).
 *   3. `server-project`   — the project's shared server-stored config.
 *   4. `none`             — nothing configured; the orchestrator surfaces a
 *                           friendly "set up Finalize" terminal rather than a
 *                           broken-YAML error.
 *
 * The committed file's ABSENCE is the only trigger for the server fallback, and
 * absence is signalled by the loader returning the `ci_config_absent` error
 * code (see `loadCiConfigFromFile`). We deliberately do not stat the filesystem
 * here: unit suites inject a fake committed loader with no file on disk, and a
 * present-but-invalid committed config reports a different error code — both
 * must be treated as "committed is authoritative", not "fall back".
 *
 * The IO-touching read of the server store is injected (`readServerConfig`) so
 * the resolver core stays pure and testable.
 */
import { parseCiConfig, type CiConfigParseResult } from './ci-config.js';
import type { ServerCiScope } from './ci-config-store.js';

export type CiConfigSource = 'committed' | 'server-personal' | 'server-project' | 'none';

export interface ResolvedCiConfig {
  /** Which source won. `none` when nothing is configured. */
  source: CiConfigSource;
  /**
   * Parse result for the chosen source. `null` only when `source === 'none'`.
   * For `committed` this passes through the loader's result verbatim (so a
   * broken committed file still surfaces its real error code/path).
   */
  parseResult: CiConfigParseResult | null;
  /**
   * True when a server-stored config exists but a committed file took
   * precedence. Advisory — the orchestrator emits it as a trace warning so the
   * operator knows the server config is being ignored.
   */
  shadowed: boolean;
}

export interface ResolveCiConfigDeps {
  /**
   * Load the committed `<worktree>/.agent-hub/ci.yaml`. Returns a
   * `CiConfigParseResult`; on a genuinely missing file it must resolve to
   * `{ ok: false, error: { code: 'ci_config_absent', ... } }`. This is exactly
   * `loadCiConfigFromFile`.
   */
  loadCommitted: (absPath: string) => Promise<CiConfigParseResult>;
  /** Read a server-stored config's YAML text, or null when absent. */
  readServerConfig: (scope: ServerCiScope) => string | null;
}

export interface ResolveCiConfigArgs {
  /** Absolute path to the committed `.agent-hub/ci.yaml`. */
  committedPath: string;
  /**
   * Whether the run has a triggering user, i.e. whether a `server-personal`
   * override is even eligible. When false, only project-scoped server config is
   * consulted.
   */
  hasUser: boolean;
}

/** The loader's error code that means "the committed file does not exist". */
export const CI_CONFIG_ABSENT_CODE = 'ci_config_absent';

/**
 * Resolve the effective CI config source for a Finalize run. See the module
 * docstring for the precedence contract.
 */
export async function resolveCiConfig(
  deps: ResolveCiConfigDeps,
  args: ResolveCiConfigArgs,
): Promise<ResolvedCiConfig> {
  const committed = await deps.loadCommitted(args.committedPath);
  const committedAbsent = !committed.ok && committed.error.code === CI_CONFIG_ABSENT_CODE;

  // A server config exists if either the personal (eligible) or project scope
  // has one. Computed for the shadow flag and for the fallback branch.
  const personalText = args.hasUser ? deps.readServerConfig('personal') : null;
  const projectText = deps.readServerConfig('project');
  const serverPresent = personalText != null || projectText != null;

  if (!committedAbsent) {
    // Committed file exists (valid or invalid) → authoritative.
    return { source: 'committed', parseResult: committed, shadowed: serverPresent };
  }

  // Committed file absent → fall back to server config, personal first.
  if (personalText != null) {
    return {
      source: 'server-personal',
      parseResult: parseCiConfig(personalText),
      shadowed: false,
    };
  }
  if (projectText != null) {
    return {
      source: 'server-project',
      parseResult: parseCiConfig(projectText),
      shadowed: false,
    };
  }
  return { source: 'none', parseResult: null, shadowed: false };
}
