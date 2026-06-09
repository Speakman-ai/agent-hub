/**
 * runner-resource-profile.ts — CPU/memory caps for Finalize DinD runners.
 *
 * Why this exists: the Finalize gate must NOT be more powerful than the
 * GitHub-hosted runner it stands in for. PR surveytracker#1001 was Finalize-green
 * / GitHub-red because a beefy ECS box hid a timing-sensitive failure (a Cypress
 * `input:visible` 10s timeout that blew on a 2-vCPU GitHub runner but passed on
 * the faster Finalize runner). A correctness gate that is faster than production
 * launders real failures, so we constrain every job container's CPU/memory to
 * approximate the GitHub-hosted runner profile.
 *
 * Everything here is PURE (env -> profile -> docker flag argv). The runtime that
 * spawns the container lives in job-container.ts; the flags are spliced into the
 * shared `docker run` argv built in runner-exec-args.ts so the Hub-local and
 * remote runner-agent paths cap identically.
 *
 * GitHub-hosted standard Ubuntu runner specs (verified June 2026 against
 * https://docs.github.com/en/actions/reference/runners/github-hosted-runners):
 *   - public  repos: 4 vCPU, 16 GB RAM, 14 GB SSD  (ubuntu-latest / ubuntu-24.04)
 *   - private repos: 2 vCPU,  8 GB RAM, 14 GB SSD
 *   - ubuntu-slim  : 1 vCPU,  5 GB RAM, 14 GB SSD
 */

export type RunnerResourceProfileName =
  | 'ubuntu-public'
  | 'ubuntu-private'
  | 'ubuntu-slim'
  | 'unconstrained';

export interface RunnerResourceProfile {
  name: RunnerResourceProfileName;
  /** CPU quota in cores (maps to `docker run --cpus`). null = uncapped. */
  cpus: number | null;
  /** Memory cap in bytes (maps to `docker run --memory`). null = uncapped. */
  memoryBytes: number | null;
}

const GiB = 1024 * 1024 * 1024;

/**
 * Named profiles keyed to the GitHub-hosted runner tiers. We match the *gate*
 * runner to GitHub, not the pre-prod runner (which is intentionally prod-like).
 * See the wiki page "Finalize Runner GitHub Parity Resource Caps".
 */
export const RUNNER_RESOURCE_PROFILES: Record<RunnerResourceProfileName, RunnerResourceProfile> = {
  // Standard Ubuntu runner for public repos (ubuntu-latest / ubuntu-24.04).
  'ubuntu-public': { name: 'ubuntu-public', cpus: 4, memoryBytes: 16 * GiB },
  // Standard Ubuntu runner for private repos.
  'ubuntu-private': { name: 'ubuntu-private', cpus: 2, memoryBytes: 8 * GiB },
  // Single-CPU lightweight runner (ubuntu-slim).
  'ubuntu-slim': { name: 'ubuntu-slim', cpus: 1, memoryBytes: 5 * GiB },
  // Escape hatch: no caps (legacy behaviour — the runner gets the full host).
  unconstrained: { name: 'unconstrained', cpus: null, memoryBytes: null },
};

/**
 * Default profile. We default to the STRICTER `ubuntu-private` tier (2 vCPU /
 * 8 GB) on purpose: the gate must never be faster than the GitHub runner it
 * stands in for, and that has to hold without knowing each repo's visibility.
 *
 * - For a private repo this is exact GitHub parity.
 * - For a public repo (GitHub gives 4 vCPU / 16 GB) the gate is SLOWER than
 *   GitHub. That's the safe direction for a correctness gate — a slower runner
 *   never launders a timing-sensitive failure into a false-green; at worst it
 *   produces a conservative false-red, which an operator fixes by opting up to
 *   `FINALIZE_RUNNER_RESOURCE_PROFILE=ubuntu-public`.
 *
 * Defaulting to `ubuntu-public` would have the opposite, unsafe failure mode:
 * any gated *private* repo would run on a beefier-than-GitHub runner and could
 * reproduce the exact Finalize-green / GitHub-red class this module prevents.
 *
 * A future refinement could derive the default from the repo's actual GitHub
 * visibility; until then, stricter-by-default is the correctness-preserving
 * choice. Override per-deploy with FINALIZE_RUNNER_RESOURCE_PROFILE.
 */
export const DEFAULT_RESOURCE_PROFILE_NAME: RunnerResourceProfileName = 'ubuntu-private';

function isProfileName(value: string): value is RunnerResourceProfileName {
  return value in RUNNER_RESOURCE_PROFILES;
}

/** Parse a positive number from an env string, or null if absent/invalid. */
function parsePositive(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Parse a memory string into bytes. Accepts a bare number (bytes) or a
 * Docker-style suffix: `b`, `k`/`kb`, `m`/`mb`, `g`/`gb` (case-insensitive,
 * binary multiples to match `docker run --memory`). Returns null if absent or
 * unparseable.
 */
export function parseMemoryToBytes(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb)?$/u.exec(trimmed);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = m[2] ?? 'b';
  const mult: Record<string, number> = {
    b: 1,
    k: 1024,
    kb: 1024,
    m: 1024 * 1024,
    mb: 1024 * 1024,
    g: GiB,
    gb: GiB,
  };
  return Math.round(value * mult[unit]);
}

/**
 * Resolve the effective resource profile from env.
 *
 * Precedence:
 *   1. Granular overrides FINALIZE_RUNNER_CPUS / FINALIZE_RUNNER_MEMORY layer on
 *      top of the base profile (either may be set independently).
 *   2. FINALIZE_RUNNER_RESOURCE_PROFILE selects a named base profile.
 *   3. Otherwise the default (ubuntu-private — the stricter tier; see
 *      DEFAULT_RESOURCE_PROFILE_NAME).
 *
 * An unknown profile name falls back to the default (a typo must not silently
 * remove the cap and re-open the faster-than-GitHub hole).
 */
export function resolveRunnerResourceProfile(
  env: NodeJS.ProcessEnv = process.env,
): RunnerResourceProfile {
  const rawName = env.FINALIZE_RUNNER_RESOURCE_PROFILE?.trim().toLowerCase();
  const base =
    rawName && isProfileName(rawName)
      ? RUNNER_RESOURCE_PROFILES[rawName]
      : RUNNER_RESOURCE_PROFILES[DEFAULT_RESOURCE_PROFILE_NAME];

  const cpuOverride = parsePositive(env.FINALIZE_RUNNER_CPUS);
  const memOverride = parseMemoryToBytes(env.FINALIZE_RUNNER_MEMORY);

  if (cpuOverride === null && memOverride === null) {
    return base;
  }
  return {
    name: base.name,
    cpus: cpuOverride ?? base.cpus,
    memoryBytes: memOverride ?? base.memoryBytes,
  };
}

/**
 * Build the `docker run` resource-cap argv fragment for a profile.
 *
 * `--memory` and `--memory-swap` are set equal so the RAM cap is HARD (no extra
 * swap headroom): a GitHub runner that OOMs must OOM here too, rather than the
 * gate silently surviving on swap the real runner doesn't have. CPU maps to
 * `--cpus` (CFS quota). An uncapped dimension contributes no flags.
 */
export function buildRunnerResourceArgs(profile: RunnerResourceProfile): string[] {
  const args: string[] = [];
  if (profile.cpus !== null) {
    args.push('--cpus', String(profile.cpus));
  }
  if (profile.memoryBytes !== null) {
    args.push('--memory', String(profile.memoryBytes));
    args.push('--memory-swap', String(profile.memoryBytes));
  }
  return args;
}

/** Convenience: resolve from env and build argv in one call. */
export function resolveRunnerResourceArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return buildRunnerResourceArgs(resolveRunnerResourceProfile(env));
}
