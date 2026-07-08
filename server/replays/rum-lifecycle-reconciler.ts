/**
 * rum-lifecycle-reconciler.ts — keeps the S3-native RUM lifecycle rules in sync
 * with the CURRENT per-tenant BASE-retention override set, and publishes the
 * confirmation state the retention sweepers gate S3 byte delegation on.
 *
 * Why this exists (the bug it closes): the sweepers read the override set fresh
 * every tick (`getRetentionOverrides`), so an operator adding/changing
 * `project.replay.retentionDays` after boot takes effect on the index rows
 * immediately. But the S3 lifecycle rules are provisioned out of band. If the
 * per-prefix `rum/<project>/` rule for that new override was never installed, a
 * sweeper that blindly trusted a single global "provisioned" flag would DELEGATE
 * the tenant's byte expiry to a lifecycle rule that doesn't exist — leaving the
 * bytes forever (global window off) or until the looser global window (violating
 * the tenant's tighter contract), while the index row is already gone.
 *
 * Two guarantees together close it:
 *   1. This reconciler re-provisions the lifecycle rules whenever the effective
 *      override set changes (run periodically; provisioning is idempotent so a
 *      no-change tick is a cheap GET + compare), so runtime overrides actually
 *      get their per-prefix rule installed.
 *   2. It publishes provisioning confirmation PER PROJECT (`provisionedProjects`),
 *      not just a global flag. A per-tenant sweep pass delegates S3 bytes ONLY
 *      when that tenant's own prefix rule is confirmed installed; until then the
 *      sweeper deletes the bytes itself (no orphans, honors the tighter window).
 *      So even while reconciliation lags a config edit, correctness holds.
 */

import { collectRetentionOverrides, type ProjectRetentionOverride } from './replay-config.js';
import { buildProjectStoragePrefix } from './segment-store.js';
import { rumProjectRuleId, type RumLifecycleProjectOverride } from './replay-lifecycle.js';
import { provisionRumLifecycle } from './replay-lifecycle-s3.js';
import type { AppConfig } from '../types.js';

/**
 * Mutable, shared confirmation state the retention sweepers read to decide
 * whether they may delegate S3 byte expiry to lifecycle. Updated in place by
 * {@link reconcileRumLifecycle} so the sweepers (which hold closures over it) see
 * the latest state each tick.
 */
export interface RumLifecycleState {
  /** Global `rum/` rule confirmed installed on the bucket. */
  provisioned: boolean;
  /** Project ids whose per-prefix `rum/<project>/` rule is confirmed installed. */
  provisionedProjects: Set<string>;
}

/** A fresh, nothing-confirmed state (the safe default until the first reconcile). */
export function createRumLifecycleState(): RumLifecycleState {
  return { provisioned: false, provisionedProjects: new Set<string>() };
}

/** Map effective per-tenant overrides to per-prefix lifecycle rule specs, keying
 *  each on the sanitized `rum/<project>/` object prefix + a deterministic managed
 *  rule id. Pure. */
export function toLifecycleProjectOverrides(
  overrides: ProjectRetentionOverride[],
): RumLifecycleProjectOverride[] {
  return overrides.map((o) => ({
    prefix: buildProjectStoragePrefix(o.projectId),
    retentionDays: o.retentionDays,
    ruleId: rumProjectRuleId(o.projectId),
  }));
}

export interface ReconcileRumLifecycleDeps {
  config: AppConfig;
  getProjects: () => ReadonlyArray<{ id: string; replay?: { retentionDays?: number } | null }>;
  /** Shared state to update in place (the sweepers read the same object). */
  state: RumLifecycleState;
  /** Injectable provisioner for tests; defaults to the real S3-backed one. */
  provision?: typeof provisionRumLifecycle;
  log?: (msg: string) => void;
}

/**
 * Recompute the effective override set from live project config and (re)provision
 * the S3 lifecycle rules to match, then update the shared confirmation state:
 *   - CONFIRMED (provisioned) ⇒ the installed managed rules are exactly the global
 *     `rum/` rule plus one `rum/<project>/` rule per current override, so
 *     `provisioned = true` and `provisionedProjects` = the override project ids.
 *   - NOT confirmed (local storage, or a best-effort S3 failure) ⇒ nothing is
 *     trusted: `provisioned = false` and `provisionedProjects` empty, so the
 *     sweepers keep deleting bytes themselves (no orphans).
 * Idempotent (`provisionRumLifecycle` → `applyRumLifecyclePolicy` only PUTs on a
 * real diff), so it is safe to run periodically to catch runtime config edits.
 */
export async function reconcileRumLifecycle(deps: ReconcileRumLifecycleDeps): Promise<void> {
  const overrides = collectRetentionOverrides(deps.getProjects(), deps.config.replayRetentionDays);
  const projectOverrides = toLifecycleProjectOverrides(overrides);
  const provision = deps.provision ?? provisionRumLifecycle;
  const out = await provision({ config: deps.config, projectOverrides, log: deps.log });
  deps.state.provisioned = out.provisioned;
  deps.state.provisionedProjects = out.provisioned
    ? new Set(overrides.map((o) => o.projectId))
    : new Set<string>();
}
