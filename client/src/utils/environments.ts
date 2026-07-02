// Pure helpers for the environments management surface (web + shared logic).
// Kept framework-free so they can be unit-tested and reused by the mobile screen.

export interface ResolvedEnvironment {
  name: string;
  active: boolean;
  enabled: boolean;
  deployable: boolean;
  approval: boolean | null;
  runsOn: string | null;
  timeoutMinutes: number | null;
  steps?: Array<{ name: string; run: string }>;
  currentRef: string | null;
  currentDeploymentId: string | null;
  lastDeployment: { id: string; ref?: string; status?: string; updated_at?: string } | null;
  config: {
    id: string;
    enabled: boolean;
    meta: unknown;
    createdAt: string;
    updatedAt: string;
  } | null;
}

export type EnvironmentStatus = 'deployable' | 'paused' | 'orphaned';

/**
 * Collapse the three resolved booleans into a single status for badge display:
 *   - orphaned  : config row exists but the env is no longer declared in deploy.yaml
 *   - paused    : declared but the operator switched it off (not deployable)
 *   - deployable: declared AND enabled
 * `active` (declared) is checked before `enabled` so a paused-and-removed env
 * reads as orphaned (the actionable state — clean up the stale row), not paused.
 */
export function environmentStatus(env: { active: boolean; enabled: boolean }): EnvironmentStatus {
  if (!env.active) return 'orphaned';
  if (!env.enabled) return 'paused';
  return 'deployable';
}

export function environmentStatusLabel(status: EnvironmentStatus): string {
  if (status === 'orphaned') return 'orphaned';
  if (status === 'paused') return 'paused';
  return 'deployable';
}

/** Whether the env has a stored operator config row that can be removed/reset. */
export function hasRuntimeConfig(env: { config: unknown }): boolean {
  return env.config != null;
}

/**
 * Sort resolved environments for display: orphaned rows last (cleanup candidates),
 * then by name. Keeps the actionable set (declared) at the top.
 */
export function sortEnvironmentsForDisplay<T extends { name: string; active: boolean }>(
  environments: T[],
): T[] {
  return [...environments].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
